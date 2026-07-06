/**
 * LSP bridge — opt-in language-server-in-loop diagnostics.
 *
 * The orchestrator emits a fileEdited event after a write_file or
 * apply_patch tool returns; the bridge forwards a textDocument/didChange
 * to the matching LSP, waits up to a configurable timeout for diagnostics,
 * and returns a flat list the loop can append to the next observation.
 *
 * Implementation here is the wire shape + an injectable LspClient
 * interface. The actual JSON-RPC speaker for typescript-language-server /
 * gopls / pyright / etc. is wired in apps/unclecode-cli where the spawn +
 * MCP host coordination already lives, so this package stays
 * dependency-light.
 */

import { spawn } from "node:child_process";
import { extname } from "node:path";

export type LspDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type LspDiagnostic = {
  readonly path: string;
  readonly range: { readonly start: { line: number; character: number }; readonly end: { line: number; character: number } };
  readonly severity: LspDiagnosticSeverity;
  readonly source?: string;
  readonly code?: string | number;
  readonly message: string;
};

export type LspBridgeOptions = {
  readonly timeoutMs?: number;
  readonly maxDiagnostics?: number;
};

export type LspCheckStatus = "pass" | "fail" | "skipped" | "unavailable";

export type LspClientCheckResult = {
  readonly clientId: string;
  readonly status: LspCheckStatus;
  readonly diagnostics: ReadonlyArray<LspDiagnostic>;
  readonly summary: string;
};

export type LspCheckResult = {
  readonly path: string;
  readonly extension: string;
  readonly status: LspCheckStatus;
  readonly matchedClientIds: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<LspDiagnostic>;
  readonly clientResults: ReadonlyArray<LspClientCheckResult>;
  readonly summary: string;
};

export interface LspClient {
  readonly id: string;
  readonly handlesExtension: (ext: string) => boolean;
  notifyDidChange(input: { path: string; content: string }): Promise<void>;
  pollDiagnostics(input: { path: string; timeoutMs: number }): Promise<ReadonlyArray<LspDiagnostic>>;
  shutdown(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_MAX_DIAGNOSTICS = 20;

export class LspBridge {
  private readonly clients: LspClient[] = [];

  register(client: LspClient): void {
    this.clients.push(client);
  }

  list(): ReadonlyArray<LspClient> {
    return this.clients.slice();
  }

  async pollAfterEdit(input: {
    readonly path: string;
    readonly content: string;
    readonly options?: LspBridgeOptions;
  }): Promise<ReadonlyArray<LspDiagnostic>> {
    const result = await this.checkAfterEdit(input);
    return result.diagnostics;
  }

  async checkAfterEdit(input: {
    readonly path: string;
    readonly content: string;
    readonly options?: LspBridgeOptions;
  }): Promise<LspCheckResult> {
    const ext = extname(input.path).toLowerCase();
    if (this.clients.length === 0) {
      return {
        path: input.path,
        extension: ext,
        status: "unavailable",
        matchedClientIds: [],
        diagnostics: [],
        clientResults: [],
        summary: "no LSP clients registered",
      };
    }

    const matched = this.clients.filter((client) => client.handlesExtension(ext));
    if (matched.length === 0) {
      return {
        path: input.path,
        extension: ext,
        status: "skipped",
        matchedClientIds: [],
        diagnostics: [],
        clientResults: [],
        summary: `no registered LSP client handles "${ext || "<none>"}"`,
      };
    }
    const timeoutMs = input.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxDiagnostics = input.options?.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS;
    const collected: LspDiagnostic[] = [];
    const clientResults: LspClientCheckResult[] = [];

    for (const client of matched) {
      try {
        await withTimeout(
          client.notifyDidChange({ path: input.path, content: input.content }),
          timeoutMs,
          `${client.id} didChange`,
        );
        const diagnostics = await withTimeout(
          client.pollDiagnostics({ path: input.path, timeoutMs }),
          timeoutMs,
          `${client.id} diagnostics`,
        );
        const remaining = Math.max(0, maxDiagnostics - collected.length);
        const limited = diagnostics.slice(0, remaining);
        collected.push(...limited);
        clientResults.push({
          clientId: client.id,
          status: diagnostics.length > 0 ? "fail" : "pass",
          diagnostics: limited,
          summary: diagnostics.length > 0
            ? `${client.id} reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`
            : `${client.id} reported no diagnostics`,
        });
      } catch (error) {
        clientResults.push({
          clientId: client.id,
          status: "unavailable",
          diagnostics: [],
          summary: `${client.id} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (collected.length >= maxDiagnostics) break;
    }

    const status = resolveCheckStatus(clientResults);
    return {
      path: input.path,
      extension: ext,
      status,
      matchedClientIds: matched.map((client) => client.id),
      diagnostics: collected.slice(0, maxDiagnostics),
      clientResults,
      summary: summarizeCheckStatus(status, collected.length, clientResults),
    };
  }

  async shutdownAll(): Promise<void> {
    for (const client of this.clients) {
      await client.shutdown().catch(() => {
        /* swallow shutdown errors so one bad LSP doesn't pin the loop */
      });
    }
    this.clients.length = 0;
  }
}

export function formatLspCheckEvidence(result: LspCheckResult): string {
  const clientSuffix = result.matchedClientIds.length > 0
    ? ` · clients: ${result.matchedClientIds.join(", ")}`
    : "";
  return `lsp ${result.status}: ${result.summary}${clientSuffix}`;
}

function resolveCheckStatus(clientResults: readonly LspClientCheckResult[]): LspCheckStatus {
  if (clientResults.some((result) => result.status === "fail")) {
    return "fail";
  }
  if (clientResults.some((result) => result.status === "unavailable")) {
    return "unavailable";
  }
  return "pass";
}

function summarizeCheckStatus(
  status: LspCheckStatus,
  diagnosticCount: number,
  clientResults: readonly LspClientCheckResult[],
): string {
  if (status === "fail") {
    return `${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}`;
  }
  if (status === "unavailable") {
    return clientResults.map((result) => result.summary).join("; ") || "no LSP clients registered";
  }
  return "no diagnostics";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export type LspSpawnConfig = {
  readonly id: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
};

/**
 * Spawn helper — light wrapper for Phase 2 wiring; today it returns a
 * client that proxies all calls to a stub. The real JSON-RPC speaker
 * arrives when apps/unclecode-cli grows the LspBridge consumer.
 */
export function spawnLspClientStub(config: LspSpawnConfig): LspClient {
  const exts = new Set(config.extensions.map((ext) => ext.toLowerCase()));
  let alive = true;
  let child: ReturnType<typeof spawn> | undefined;
  return {
    id: config.id,
    handlesExtension(ext: string) {
      return exts.has(ext.toLowerCase());
    },
    async notifyDidChange() {
      if (!alive) return;
      if (!child) {
        child = spawn(config.command, [...(config.args ?? [])], { stdio: ["pipe", "pipe", "pipe"] });
      }
    },
    async pollDiagnostics() {
      // Phase 2 will wire real JSON-RPC; stub returns empty so the loop
      // does not block on a not-yet-connected language server.
      return [];
    },
    async shutdown() {
      alive = false;
      child?.kill();
    },
  };
}
