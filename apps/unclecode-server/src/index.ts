/**
 * UncleCode persistent server — HTTP+SSE daemon that survives SSH drops
 * and lets multiple clients (TUI, web, IDE) attach to the same session.
 *
 * Phase 1 (this commit): wire types + a minimal HTTP+SSE server with
 * /health, /sessions, /sessions/:id/events SSE, /tools/invoke. Real
 * orchestrator delegation lives in a follow-up — today the server stubs
 * the action handlers so a client can talk to it end-to-end without
 * needing the full work-shell-engine wired in.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const ALLOWED_ORIGINS = new Set([
  "http://localhost",
  "http://127.0.0.1",
]);

function defaultTokenPath(): string {
  return join(homedir(), ".unclecode", "server.token");
}

export function ensureServerToken(tokenPath: string = defaultTokenPath()): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token);
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  return token;
}

function checkAuth(req: IncomingMessage, expectedToken: string): { ok: boolean; reason?: string } {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    try {
      const parsed = new URL(origin);
      const baseOrigin = `${parsed.protocol}//${parsed.hostname}`;
      if (!ALLOWED_ORIGINS.has(baseOrigin)) {
        return { ok: false, reason: `origin_not_allowed: ${origin}` };
      }
    } catch {
      return { ok: false, reason: "invalid_origin_header" };
    }
  }
  const auth = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) {
    return { ok: false, reason: "missing_bearer_token" };
  }
  const supplied = Buffer.from(match[1] ?? "");
  const expected = Buffer.from(expectedToken);
  if (supplied.length !== expected.length) {
    return { ok: false, reason: "bad_token_length" };
  }
  return timingSafeEqual(supplied, expected) ? { ok: true } : { ok: false, reason: "bad_token" };
}

export type ServerHealth = {
  readonly ok: true;
  readonly pid: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
};

export type ServerSessionSummary = {
  readonly sessionId: string;
  readonly persona?: string;
  readonly state: "idle" | "running" | "requires_action";
};

export type ServerEvent =
  | { readonly type: "session.state_changed"; readonly sessionId: string; readonly state: ServerSessionSummary["state"] }
  | { readonly type: "tool.completed"; readonly sessionId: string; readonly toolName: string; readonly output: string }
  | { readonly type: "ping"; readonly t: number };

export type ToolInvokeRequest = {
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
};

export type ToolInvokeResponse = {
  readonly toolCallId: string;
  readonly output: string;
  readonly isError: boolean;
};

export type ServerHandlers = {
  listSessions(): Promise<ReadonlyArray<ServerSessionSummary>>;
  invokeTool(req: ToolInvokeRequest): Promise<ToolInvokeResponse>;
  subscribe(sessionId: string, write: (event: ServerEvent) => void): () => void;
};

export type ServerOptions = {
  readonly port?: number;
  readonly host?: string;
  readonly handlers: ServerHandlers;
  readonly authToken?: string;
  readonly insecure?: boolean;
};

export async function startServer(options: ServerOptions): Promise<{
  readonly url: string;
  readonly token: string;
  readonly stop: () => Promise<void>;
}> {
  const port = options.port ?? 17677;
  const host = options.host ?? "127.0.0.1";
  const startedAt = Date.now();
  const insecure = options.insecure === true;
  if (!insecure && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `Refusing to bind ${host}: pass insecure: true to bind a non-loopback host.`,
    );
  }
  const authToken = options.authToken ?? ensureServerToken();

  const server = createServer(async (req, res) => {
    try {
      await routeRequest({ req, res, options, startedAt, authToken });
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    token: authToken,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function routeRequest(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly options: ServerOptions;
  readonly startedAt: number;
  readonly authToken: string;
}): Promise<void> {
  const { req, res, options, startedAt, authToken } = input;
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (url === "/health" && method === "GET") {
    const body: ServerHealth = {
      ok: true,
      pid: process.pid,
      startedAt,
      uptimeMs: Date.now() - startedAt,
    };
    writeJson(res, 200, body);
    return;
  }

  const auth = checkAuth(req, authToken);
  if (!auth.ok) {
    writeJson(res, 401, { error: auth.reason ?? "unauthorized" });
    return;
  }

  if (url === "/sessions" && method === "GET") {
    const sessions = await options.handlers.listSessions();
    writeJson(res, 200, { sessions });
    return;
  }

  const sseMatch = url.match(/^\/sessions\/([\w-]+)\/events$/);
  if (sseMatch && method === "GET") {
    const sessionId = sseMatch[1] ?? "";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const write = (event: ServerEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = options.handlers.subscribe(sessionId, write);
    const ping = setInterval(() => write({ type: "ping", t: Date.now() }), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
    return;
  }

  if (url === "/tools/invoke" && method === "POST") {
    const body = await readJson(req);
    const response = await options.handlers.invokeTool(body as ToolInvokeRequest);
    writeJson(res, 200, response);
    return;
  }

  writeJson(res, 404, { error: `not_found: ${method} ${url}` });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 8 * 1024 * 1024) {
        req.destroy(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(buf.length === 0 ? {} : JSON.parse(buf));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function makeStubHandlers(): ServerHandlers {
  const subscribers = new Map<string, Set<(event: ServerEvent) => void>>();
  return {
    async listSessions() {
      return [];
    },
    async invokeTool(req) {
      return {
        toolCallId: randomUUID(),
        output: `(stub) tool=${req.toolName} not yet wired`,
        isError: false,
      };
    },
    subscribe(sessionId, write) {
      let set = subscribers.get(sessionId);
      if (!set) {
        set = new Set();
        subscribers.set(sessionId, set);
      }
      set.add(write);
      return () => {
        set?.delete(write);
        if (set && set.size === 0) {
          subscribers.delete(sessionId);
        }
      };
    },
  };
}
