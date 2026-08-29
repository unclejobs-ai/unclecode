import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { waitForOwnedProcessGroupExit } from "./process-group-settlement.js";

export type LspServerConfig = {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly languageId: string;
};

export type LspServerResolver = (
  filePath: string,
  extension: string,
  cwd: string,
) => LspServerConfig | undefined;

type JsonObject = Record<string, unknown>;

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timer: NodeJS.Timeout;
};

type DiagnosticWaiter = {
  readonly resolve: (value: { received: boolean; items: unknown[] }) => void;
  readonly timer: NodeJS.Timeout;
};
const FORCE_KILL_DELAY_MS = 2_000;


function abortError(): Error {
  const error = new Error("The LSP request was aborted.");
  error.name = "AbortError";
  return error;
}

export function resolveDefaultLspServer(
  _filePath: string,
  extension: string,
  _cwd: string,
): LspServerConfig | undefined {
  const ext = extension.toLowerCase();
  const languageByExtension: Readonly<Record<string, string>> = {
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
  };
  const languageId = languageByExtension[ext];
  if (languageId) {
    return {
      id: "typescript-language-server",
      command: process.env.UNCLECODE_TYPESCRIPT_LANGUAGE_SERVER?.trim() || "typescript-language-server",
      args: ["--stdio"],
      languageId,
    };
  }
  if (ext === ".rs") {
    return {
      id: "rust-analyzer",
      command: process.env.UNCLECODE_RUST_ANALYZER?.trim() || "rust-analyzer",
      args: [],
      languageId: "rust",
    };
  }
  if (ext === ".py" || ext === ".pyi") {
    return {
      id: "pyright",
      command: process.env.UNCLECODE_PYRIGHT_LANGUAGE_SERVER?.trim() || "pyright-langserver",
      args: ["--stdio"],
      languageId: "python",
    };
  }
  if (ext === ".go") {
    return {
      id: "gopls",
      command: process.env.UNCLECODE_GOPLS?.trim() || "gopls",
      args: ["serve"],
      languageId: "go",
    };
  }
  return undefined;
}

export class LspJsonRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly publishedDiagnostics = new Map<string, unknown[]>();
  private readonly diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>();
  private stderr = "";
  private closed = false;
  private abortListener: (() => void) | undefined;
  private childClosePromise: Promise<void> | undefined;
  private terminationPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  capabilities: Record<string, unknown> = {};

  constructor(
    readonly config: LspServerConfig,
    private readonly cwd: string,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
    private readonly forceKillDelayMs = FORCE_KILL_DELAY_MS,
  ) {}

  async start(): Promise<void> {
    if (this.signal?.aborted) throw abortError();
    this.child = spawn(this.config.command, [...this.config.args], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.childClosePromise = new Promise((resolve) => this.child?.once("close", () => resolve()));
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8192);
    });
    this.child.stdin.on("error", () => undefined);
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, exitSignal) => {
      if (!this.closed) {
        this.fail(new Error(`${this.config.id} exited before completing the request (${exitSignal ?? code ?? "unknown"})`));
      }
    });
    if (this.signal) {
      this.abortListener = () => this.fail(abortError());
      this.signal.addEventListener("abort", this.abortListener, { once: true });
    }

    const rootUri = pathToFileURL(this.cwd).href;
    const initialized = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "UncleCode", version: "0.1.0" },
      rootUri,
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true },
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          diagnostic: {},
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: false },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.cwd) }],
      trace: "off",
    }) as { capabilities?: unknown } | null;
    const capabilities = initialized?.capabilities;
    if (typeof capabilities === "object" && capabilities !== null && !Array.isArray(capabilities)) {
      this.capabilities = capabilities as Record<string, unknown>;
    }
    this.notify("initialized", {});
  }

  openDocument(uri: string, languageId: string, text: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`${this.config.id} is not running`));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`${this.config.id} ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    this.pending.set(id, { resolve, reject, timer });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (!this.child || this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  waitForPublishedDiagnostics(uri: string, timeoutMs = this.timeoutMs): Promise<{ received: boolean; items: unknown[] }> {
    const current = this.publishedDiagnostics.get(uri);
    if (current) return Promise.resolve({ received: true, items: current });
    const { promise, resolve } = Promise.withResolvers<{ received: boolean; items: unknown[] }>();
    let waiter: DiagnosticWaiter;
    const timer = setTimeout(() => {
      const waiters = this.diagnosticWaiters.get(uri);
      waiters?.delete(waiter);
      if (waiters?.size === 0) this.diagnosticWaiters.delete(uri);
      resolve({ received: false, items: [] });
    }, timeoutMs);
    timer.unref();
    waiter = { resolve, timer };
    const waiters = this.diagnosticWaiters.get(uri) ?? new Set<DiagnosticWaiter>();
    waiters.add(waiter);
    this.diagnosticWaiters.set(uri, waiters);
    return promise;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (!this.closed) {
      try {
        await this.request("shutdown", null, Math.min(500, this.timeoutMs));
        this.notify("exit", null);
      } catch {
        // The process is terminated below when graceful shutdown is unavailable.
      }
      this.closed = true;
      if (this.signal && this.abortListener) {
        this.signal.removeEventListener("abort", this.abortListener);
      }
      this.rejectPending(new Error(`${this.config.id} session closed`));
      this.settleDiagnosticWaiters();
      this.publishedDiagnostics.clear();
      this.buffer = Buffer.alloc(0);
    }
    await this.terminateChild();
  }

  private send(message: JsonObject): void {
    const body = Buffer.from(JSON.stringify(message));
    this.child?.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child?.stdin.write(body);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.fail(new Error(`${this.config.id} sent an LSP frame without Content-Length`));
        return;
      }
      const bodyLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + bodyLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
      try {
        this.handleMessage(JSON.parse(body) as JsonObject);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private handleMessage(message: JsonObject): void {
    if (typeof message.id === "number" && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const responseError = message.error as { message?: unknown } | undefined;
      if (responseError && typeof responseError === "object") {
        pending.reject(new Error(
          typeof responseError.message === "string" ? responseError.message : `${this.config.id} request failed`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const params = message.params as JsonObject | undefined;
    if (message.method === "textDocument/publishDiagnostics" && params) {
      const uri = params.uri;
      if (typeof uri !== "string") return;
      const items = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      this.publishedDiagnostics.set(uri, items);
      const waiters = this.diagnosticWaiters.get(uri);
      for (const waiter of waiters ?? []) {
        clearTimeout(waiter.timer);
        waiter.resolve({ received: true, items });
      }
      this.diagnosticWaiters.delete(uri);
      return;
    }
    if (message.method && (typeof message.id === "number" || typeof message.id === "string")) {
      this.respondToServerRequest(message.id, String(message.method), params);
    }
  }

  private respondToServerRequest(id: number | string, method: string, params: JsonObject | undefined): void {
    let result: unknown = null;
    if (method === "workspace/configuration" && Array.isArray(params?.items)) {
      result = params.items.map(() => null);
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.cwd).href, name: path.basename(this.cwd) }];
    }
    this.send({ jsonrpc: "2.0", id, result });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const detail = this.stderr.trim();
    const failure = detail ? new Error(`${error.message}: ${detail}`) : error;
    if (this.signal && this.abortListener) {
      this.signal.removeEventListener("abort", this.abortListener);
    }
    this.terminationPromise = this.terminateChild();
    void this.terminationPromise.catch(() => undefined);
    this.rejectPending(failure);
    this.settleDiagnosticWaiters();
    this.publishedDiagnostics.clear();
    this.buffer = Buffer.alloc(0);
  }

  private settleDiagnosticWaiters(): void {
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve({ received: false, items: [] });
      }
    }
    this.diagnosticWaiters.clear();
  }

  private terminateChild(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    const child = this.child;
    if (!child) return Promise.resolve();
    const closePromise = this.childClosePromise ?? Promise.resolve();
    this.terminationPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        this.signalChild(child.pid, "SIGTERM");
      }
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.signalChild(child.pid, "SIGKILL");
        }
      }, Math.max(0, this.forceKillDelayMs));
      forceTimer.unref();
      const groupSettlement = closePromise.then(() => waitForOwnedProcessGroupExit({
        processGroupId: child.pid,
        timeoutMs: Math.max(1_000, this.forceKillDelayMs + 2_000),
        label: this.config.id,
      }));
      try {
        await Promise.race([
          groupSettlement,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`${this.config.id} did not exit after SIGKILL`)),
              Math.max(1_000, this.forceKillDelayMs + 2_000),
            );
            timer.unref();
            groupSettlement.finally(() => clearTimeout(timer)).catch(() => undefined);
          }),
        ]);
      } finally {
        clearTimeout(forceTimer);
      }
    })();
    return this.terminationPromise;
  }

  private signalChild(pid: number | undefined, signal: NodeJS.Signals): boolean {
    if (!pid) return false;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
