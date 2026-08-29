/** Loopback-first UncleCode control-room HTTP + SSE server. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { BoundedEventJournal, type JournalEvent, type JournalReplay } from "./event-journal.js";
import { CONTROL_ACTIONS, type ControlAction, type RuntimeAdapter, type RuntimeControlRequest, type RuntimeControlResult } from "./runtime-adapter.js";
import type { ControlRoomProjection } from "./control-room.js";

export { BoundedEventJournal } from "./event-journal.js";
export { createControlRoomProjection } from "./control-room.js";
export type { ControlRoomProjection, ControlRoomRun, RuntimeReadSource, RuntimeSessionSource } from "./control-room.js";
export { CONTROL_ACTIONS, createRuntimeAdapter } from "./runtime-adapter.js";
export type { ControlAction, RuntimeAdapter, RuntimeControlPort, RuntimeControlRequest, RuntimeControlResult } from "./runtime-adapter.js";
export { createPersistentRuntimeAdapter, LiveRuntimeControlRegistry, readPersistentRuntime } from "./persistent-runtime.js";
export type { AttachedRuntimeControl } from "./persistent-runtime.js";
export { attachWorkShellRuntime } from "./work-shell-control.js";
export type { WorkShellControlEngine, WorkShellRuntimeChange } from "./work-shell-control.js";
export * from "./runtime-owner-discovery.js";
export * from "./runtime-owner-client.js";
export * from "./runtime-owner.js";
export * from "./runtime-engine-rpc.js";

const MAX_BODY_BYTES = 64 * 1024;

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
    // Best effort on platforms without chmod semantics.
  }
  return token;
}

type AuthResult = { readonly ok: true } | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    const isHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
    const isOriginOnly = parsed.username === "" && parsed.password === "" && (parsed.pathname === "/" || parsed.pathname === "") && parsed.search === "" && parsed.hash === "";
    return isHttp && isHost && isOriginOnly;
  } catch {
    return false;
  }
}

function checkAuth(req: IncomingMessage, expectedToken: string): AuthResult {
  const origin = req.headers.origin;
  if (typeof origin === "string" && !isLoopbackOrigin(origin)) {
    return { ok: false, status: 403, reason: "origin_not_allowed" };
  }
  const auth = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return { ok: false, status: 401, reason: "missing_bearer_token" };
  const supplied = Buffer.from(match[1] ?? "");
  const expected = Buffer.from(expectedToken);
  if (supplied.length !== expected.length) return { ok: false, status: 401, reason: "invalid_bearer_token" };
  return timingSafeEqual(supplied, expected)
    ? { ok: true }
    : { ok: false, status: 401, reason: "invalid_bearer_token" };
}

export type ServerHealth = {
  readonly ok: true;
  readonly pid: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
  readonly runtimeOwner?: {
    readonly protocol: string;
    readonly ownerId: string;
    readonly bootId: string;
  } | undefined;
};

export type ServerSessionSummary = {
  readonly sessionId: string;
  readonly persona?: string;
  readonly state: "idle" | "running" | "requires_action";
  readonly revision?: number;
};

export type ServerEvent =
  | { readonly type: "session.state_changed"; readonly sessionId: string; readonly state: ServerSessionSummary["state"] }
  | { readonly type: "tool.completed"; readonly sessionId: string; readonly toolName: string; readonly output: string }
  | { readonly type: "ping"; readonly t: number };

export type ToolInvokeRequest = { readonly sessionId: string; readonly toolName: string; readonly input: Record<string, unknown> };
export type ToolInvokeResponse = { readonly toolCallId: string; readonly output: string; readonly isError: boolean };

export type EventSubscription = { readonly replay: JournalReplay; readonly unsubscribe: () => void };

export type ServerHandlers = {
  listSessions(): Promise<ReadonlyArray<ServerSessionSummary>>;
  invokeTool?(req: ToolInvokeRequest): Promise<ToolInvokeResponse>;
  subscribe?(sessionId: string, write: (event: ServerEvent) => void): () => void;
  readControlRoom?(): Promise<ControlRoomProjection>;
  readRun?(sessionId: string): Promise<ControlRoomProjection["runs"][number] | null>;
  control?(request: RuntimeControlRequest): Promise<RuntimeControlResult>;
  subscribeEvents?(sessionId: string, afterId: number, write: (event: JournalEvent) => void): EventSubscription;
  readEngineState?(sessionId: string): unknown;
  invokeEngineMethod?(input: { readonly sessionId: string; readonly method: string; readonly args: readonly unknown[]; readonly expectedRevision: number; readonly idempotencyKey: string }): Promise<unknown>;
  listRuntimeSessions?(): unknown;
  createRuntimeSession?(input: { readonly sessionId: string; readonly projectPath: string; readonly provider?: string | undefined; readonly model?: string | undefined; readonly reasoning?: string | undefined; readonly resume?: boolean | undefined; readonly idempotencyKey: string }): Promise<unknown>;
  attachRuntimeSession?(sessionId: string): unknown;
};

export type ServerOptions = {
  readonly port?: number;
  readonly host?: string;
  readonly handlers: ServerHandlers;
  readonly authToken?: string;
  readonly insecure?: boolean;
  readonly heartbeatMs?: number;
  readonly runtimeOwner?: ServerHealth["runtimeOwner"];
};

export function makeControlRoomHandlers(input: { readonly adapter: RuntimeAdapter; readonly journal?: BoundedEventJournal }): ServerHandlers {
  const journal = input.journal ?? new BoundedEventJournal();
  return {
    async listSessions() {
      const projection = await input.adapter.readProjection();
      return projection.runs.map(run => ({
        sessionId: run.id,
        state: run.state === "requires_action" ? "requires_action" : run.state === "running" ? "running" : "idle",
        revision: run.revision,
      }));
    },
    async readControlRoom() { return input.adapter.readProjection(); },
    async readRun(sessionId) { return (await input.adapter.readProjection()).runs.find(run => run.id === sessionId) ?? null; },
    async control(request) {
      const result = await input.adapter.control(request);
      if (result.ok) journal.publish(request.sessionId, "run.updated", { revision: result.revision, state: result.state, action: request.action });
      return result;
    },
    subscribeEvents(sessionId, afterId, write) { return journal.subscribeAfter(sessionId, afterId, write); },
  };
}

export async function startServer(options: ServerOptions): Promise<{ readonly url: string; readonly token: string; readonly stop: () => Promise<void> }> {
  const port = options.port ?? 17677;
  const host = options.host ?? "127.0.0.1";
  const startedAt = Date.now();
  if (options.insecure !== true && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Refusing to bind ${host}: pass insecure: true to bind a non-loopback host.`);
  }
  const authToken = options.authToken ?? ensureServerToken();
  const server = createServer(async (req, res) => {
    try {
      await routeRequest({ req, res, options, startedAt, authToken });
    } catch {
      if (!res.headersSent) writeError(res, 500, "internal_error", "The server could not complete the request.");
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    token: authToken,
    async stop() {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

async function routeRequest(input: { readonly req: IncomingMessage; readonly res: ServerResponse; readonly options: ServerOptions; readonly startedAt: number; readonly authToken: string }): Promise<void> {
  const { req, res, options, startedAt, authToken } = input;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;

  if (typeof origin === "string" && isLoopbackOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (method === "OPTIONS") {
    if (typeof origin !== "string" || !isLoopbackOrigin(origin)) return writeError(res, 403, "origin_not_allowed", "Origin is not allowed.");
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, Last-Event-ID",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    const body: ServerHealth = {
      ok: true,
      pid: process.pid,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      ...(options.runtimeOwner ? { runtimeOwner: options.runtimeOwner } : {}),
    };
    return writeJson(res, 200, body);
  }

  const auth = checkAuth(req, authToken);
  if (!auth.ok) return writeError(res, auth.status, auth.reason, auth.status === 403 ? "Origin is not allowed." : "Authentication is required.");

  if (url.pathname === "/sessions") {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    return writeJson(res, 200, { sessions: await options.handlers.listSessions() });
  }
  if (url.pathname === "/control-room") {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!options.handlers.readControlRoom) return writeError(res, 404, "not_available", "Control-room projection is unavailable.");
    return writeJson(res, 200, await options.handlers.readControlRoom());
  }

  if (url.pathname === "/runtime/sessions") {
    if (method === "GET") {
      if (!options.handlers.listRuntimeSessions) return writeError(res, 404, "not_available", "Runtime session registry is unavailable.");
      return writeJson(res, 200, { sessions: options.handlers.listRuntimeSessions() });
    }
    if (method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    if (!options.handlers.createRuntimeSession) return writeError(res, 404, "not_available", "Runtime session factory is unavailable.");
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 160) {
      return writeError(res, 400, "missing_idempotency_key", "Idempotency-Key is required.");
    }
    const body = await readJson(req);
    if (!isRecord(body) || typeof body.sessionId !== "string" || !/^[A-Za-z0-9._-]+$/.test(body.sessionId)
      || typeof body.projectPath !== "string" || !isAbsolute(body.projectPath)
      || (body.provider !== undefined && typeof body.provider !== "string")
      || (body.model !== undefined && typeof body.model !== "string")
      || (body.reasoning !== undefined && typeof body.reasoning !== "string")
      || (body.resume !== undefined && typeof body.resume !== "boolean")) {
      return writeError(res, 400, "invalid_body", "A safe sessionId and absolute projectPath are required.");
    }
    return writeJson(res, 200, await options.handlers.createRuntimeSession({
      sessionId: body.sessionId,
      projectPath: body.projectPath,
      ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.reasoning === "string" ? { reasoning: body.reasoning } : {}),
      ...(typeof body.resume === "boolean" ? { resume: body.resume } : {}),
      idempotencyKey,
    }));
  }

  const runtimeAttachMatch = /^\/runtime\/sessions\/([A-Za-z0-9._-]+)\/attach$/.exec(url.pathname);
  if (runtimeAttachMatch) {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!options.handlers.attachRuntimeSession) return writeError(res, 404, "not_available", "Runtime session attachment is unavailable.");
    return writeJson(res, 200, options.handlers.attachRuntimeSession(runtimeAttachMatch[1] ?? ""));
  }

  const engineStateMatch = /^\/runtime\/sessions\/([A-Za-z0-9._-]+)\/state$/.exec(url.pathname);
  if (engineStateMatch) {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!options.handlers.readEngineState) return writeError(res, 404, "not_available", "Runtime engine RPC is unavailable.");
    return writeJson(res, 200, options.handlers.readEngineState(engineStateMatch[1] ?? ""));
  }
  const engineMethodMatch = /^\/runtime\/sessions\/([A-Za-z0-9._-]+)\/methods\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
  if (engineMethodMatch) {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!options.handlers.invokeEngineMethod) return writeError(res, 404, "not_available", "Runtime engine RPC is unavailable.");
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 160) {
      return writeError(res, 400, "missing_idempotency_key", "Idempotency-Key is required.");
    }
    const body = await readJson(req);
    if (!isRecord(body) || !Number.isSafeInteger(body.expectedRevision) || !Array.isArray(body.args)) {
      return writeError(res, 400, "invalid_body", "expectedRevision and args are required.");
    }
    return writeJson(res, 200, await options.handlers.invokeEngineMethod({
      sessionId: engineMethodMatch[1] ?? "",
      method: engineMethodMatch[2] ?? "",
      args: body.args,
      expectedRevision: Number(body.expectedRevision),
      idempotencyKey,
    }));
  }

  const runMatch = /^\/sessions\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
  if (runMatch) {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!options.handlers.readRun) return writeError(res, 404, "not_available", "Run projection is unavailable.");
    const run = await options.handlers.readRun(runMatch[1] ?? "");
    return run ? writeJson(res, 200, run) : writeError(res, 404, "session_not_found", "Unknown session.");
  }

  const eventMatch = /^\/sessions\/([A-Za-z0-9._-]+)\/events$/.exec(url.pathname);
  if (eventMatch) {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    return openEventStream(req, res, options, eventMatch[1] ?? "");
  }

  const actionMatch = /^\/sessions\/([A-Za-z0-9._-]+)\/actions\/([A-Za-z-]+)$/.exec(url.pathname);
  if (actionMatch) {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!options.handlers.control) return writeError(res, 404, "not_available", "Runtime controls are unavailable.");
    const action = actionMatch[2] as ControlAction;
    if (!(CONTROL_ACTIONS as readonly string[]).includes(action)) return writeError(res, 404, "unknown_action", "Unknown control action.");
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      const code = error instanceof Error && error.message === "payload_too_large" ? "payload_too_large" : "invalid_json";
      return writeError(res, code === "payload_too_large" ? 413 : 400, code, code === "payload_too_large" ? "Request body is too large." : "Request body is not valid JSON.");
    }
    if (!isRecord(body) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
      return writeError(res, 400, "invalid_body", "expectedRevision must be a non-negative integer.");
    }
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 160) {
      return writeError(res, 400, "missing_idempotency_key", "Idempotency-Key is required.");
    }
    const payload = isRecord(body.payload) ? body.payload : undefined;
    if ((action === "steer" || action === "follow-up") && (typeof payload?.message !== "string" || payload.message.trim().length === 0)) {
      return writeError(res, 400, "invalid_payload", `${action} requires payload.message.`);
    }
    const result = await options.handlers.control({
      sessionId: actionMatch[1] ?? "",
      action,
      expectedRevision: Number(body.expectedRevision),
      idempotencyKey,
      ...(payload ? { payload } : {}),
    });
    if (result.ok) return writeJson(res, 200, result);
    const status = result.code === "not_found" ? 404 : result.code === "revision_conflict" ? 409 : result.code === "denied" ? 403 : 409;
    return writeJson(res, status, result);
  }

  if (url.pathname === "/tools/invoke") {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!options.handlers.invokeTool) return writeError(res, 404, "not_available", "Direct tool invocation is unavailable.");
    const body = await readJson(req);
    return writeJson(res, 200, await options.handlers.invokeTool(body as ToolInvokeRequest));
  }
  return writeError(res, 404, "not_found", `No route for ${method} ${url.pathname}.`);
}

function openEventStream(req: IncomingMessage, res: ServerResponse, options: ServerOptions, sessionId: string): void {
  const rawCursor = req.headers["last-event-id"];
  const afterId = rawCursor === undefined ? 0 : Number.parseInt(String(rawCursor), 10);
  if (!Number.isSafeInteger(afterId) || afterId < 0) return writeError(res, 400, "invalid_event_cursor", "Last-Event-ID must be a non-negative integer.");

  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };
  const closeSlowClient = () => {
    cleanup();
    res.destroy();
  };
  if (options.handlers.subscribeEvents) {
    const pending: JournalEvent[] = [];
    let streaming = false;
    const subscription = options.handlers.subscribeEvents(sessionId, afterId, event => {
      if (!streaming) {
        pending.push(event);
        return;
      }
      // Do not let a stalled browser grow Node's socket write buffer forever.
      if (!writeSse(res, event.id, event.event, event.data)) closeSlowClient();
    });
    if (subscription.replay.status === "expired") {
      subscription.unsubscribe();
      return writeJson(res, 409, { error: { code: "event_cursor_expired", message: "Replay cursor expired.", oldestAvailableId: subscription.replay.oldestAvailableId, newestId: subscription.replay.newestId } });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders?.();
    unsubscribe = subscription.unsubscribe;
    streaming = true;
    for (const event of pending) {
      if (!writeSse(res, event.id, event.event, event.data)) {
        closeSlowClient();
        return;
      }
    }
  } else if (options.handlers.subscribe) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    unsubscribe = options.handlers.subscribe(sessionId, event => {
      if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) closeSlowClient();
    });
  } else {
    return writeError(res, 404, "not_available", "Event stream is unavailable.");
  }
  heartbeat = setInterval(() => {
    if (!res.write(`: heartbeat ${Date.now()}\n\n`)) closeSlowClient();
  }, Math.max(50, options.heartbeatMs ?? 15_000));
  heartbeat.unref?.();
  req.once("close", cleanup);
  res.once("close", cleanup);
}

function writeSse(res: ServerResponse, id: number, event: string, data: unknown): boolean {
  return res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { code, message } });
}

function methodNotAllowed(res: ServerResponse, allowed: readonly string[]): void {
  res.setHeader("Allow", allowed.join(", "));
  writeError(res, 405, "method_not_allowed", `Use ${allowed.join(" or ")}.`);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", chunkValue => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new Error("payload_too_large"));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

export function makeStubHandlers(): ServerHandlers {
  const subscribers = new Map<string, Set<(event: ServerEvent) => void>>();
  return {
    async listSessions() { return []; },
    async invokeTool(req) { return { toolCallId: randomUUID(), output: `(test fixture) tool=${req.toolName}`, isError: false }; },
    subscribe(sessionId, write) {
      let set = subscribers.get(sessionId);
      if (!set) {
        set = new Set();
        subscribers.set(sessionId, set);
      }
      set.add(write);
      return () => {
        set?.delete(write);
        if (set?.size === 0) subscribers.delete(sessionId);
      };
    },
  };
}
