import { lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { ControlRoomProjection } from "./control-room.js";
import type { ControlAction, RuntimeControlResult } from "./runtime-adapter.js";
import type { RuntimeEngineRpcResponse, RuntimeSessionAttachResponse, RuntimeSessionCreateResponse, RuntimeSessionDescriptor } from "./runtime-engine-rpc.js";
import {
  RUNTIME_OWNER_PROTOCOL,
  type RuntimeOwnerLease,
} from "./runtime-owner-discovery.js";

type RuntimeOwnerHealth = {
  readonly ok?: unknown;
  readonly pid?: unknown;
  readonly runtimeOwner?: {
    readonly protocol?: unknown;
    readonly ownerId?: unknown;
    readonly bootId?: unknown;
  } | undefined;
};

async function readToken(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new Error("Runtime owner token reference is not a regular bounded file.");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Runtime owner token file permissions must be 0600.");
  }
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32) throw new Error("Runtime owner token is invalid.");
  return token;
}

export async function probeRuntimeOwner(lease: RuntimeOwnerLease): Promise<boolean> {
  try {
    const response = await fetch(`${lease.endpoint}/health`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = await response.json() as RuntimeOwnerHealth;
    return body.ok === true
      && body.pid === lease.pid
      && body.runtimeOwner?.protocol === RUNTIME_OWNER_PROTOCOL
      && body.runtimeOwner.ownerId === lease.ownerId
      && body.runtimeOwner.bootId === lease.bootId;
  } catch {
    return false;
  }
}

export class RuntimeOwnerClient {
  readonly #lease: RuntimeOwnerLease;
  readonly #token: string;

  private constructor(lease: RuntimeOwnerLease, token: string) {
    this.#lease = lease;
    this.#token = token;
  }

  static async connect(lease: RuntimeOwnerLease): Promise<RuntimeOwnerClient> {
    if (!await probeRuntimeOwner(lease)) {
      throw new Error("Runtime owner identity health check failed.");
    }
    return new RuntimeOwnerClient(lease, await readToken(lease.tokenPath));
  }

  get lease(): RuntimeOwnerLease {
    return this.#lease;
  }

  async readProjection(): Promise<ControlRoomProjection> {
    const response = await this.#fetch("/control-room");
    if (!response.ok) throw new Error(`Runtime owner projection failed (${response.status}).`);
    return await response.json() as ControlRoomProjection;
  }

  async control(input: {
    readonly sessionId: string;
    readonly action: ControlAction;
    readonly expectedRevision: number;
    readonly idempotencyKey?: string | undefined;
    readonly payload?: Readonly<Record<string, unknown>> | undefined;
  }): Promise<RuntimeControlResult> {
    const response = await this.#fetch(
      `/sessions/${encodeURIComponent(input.sessionId)}/actions/${input.action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey ?? randomUUID(),
        },
        body: JSON.stringify({
          expectedRevision: input.expectedRevision,
          ...(input.payload ? { payload: input.payload } : {}),
        }),
      },
    );
    return await response.json() as RuntimeControlResult;
  }

  async readEngineState(sessionId: string, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<RuntimeEngineRpcResponse> {
    const response = await this.#fetch(`/runtime/sessions/${encodeURIComponent(sessionId)}/state`, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return await response.json() as RuntimeEngineRpcResponse;
  }

  async listRuntimeSessions(): Promise<readonly RuntimeSessionDescriptor[]> {
    const response = await this.#fetch("/runtime/sessions");
    if (!response.ok) throw new Error(`Runtime session listing failed (${response.status}).`);
    const body = await response.json() as { readonly sessions?: readonly RuntimeSessionDescriptor[] };
    return body.sessions ?? [];
  }

  async createRuntimeSession(input: {
    readonly sessionId: string;
    readonly projectPath: string;
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
    readonly reasoning?: string | undefined;
    readonly resume?: boolean | undefined;
    readonly idempotencyKey?: string | undefined;
  }): Promise<RuntimeSessionCreateResponse> {
    const response = await this.#fetch("/runtime/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey ?? randomUUID() },
      body: JSON.stringify({ sessionId: input.sessionId, projectPath: input.projectPath, ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}), ...(input.reasoning ? { reasoning: input.reasoning } : {}), ...(input.resume !== undefined ? { resume: input.resume } : {}) }),
    });
    return await response.json() as RuntimeSessionCreateResponse;
  }

  async attachRuntimeSession(sessionId: string): Promise<RuntimeSessionAttachResponse> {
    const response = await this.#fetch(`/runtime/sessions/${encodeURIComponent(sessionId)}/attach`, { method: "POST" });
    return await response.json() as RuntimeSessionAttachResponse;
  }

  async invokeEngineMethod(input: {
    readonly sessionId: string;
    readonly method: string;
    readonly args?: readonly unknown[] | undefined;
    readonly expectedRevision: number;
    readonly idempotencyKey?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<RuntimeEngineRpcResponse> {
    const response = await this.#fetch(
      `/runtime/sessions/${encodeURIComponent(input.sessionId)}/methods/${encodeURIComponent(input.method)}`,
      {
        method: "POST",
        ...(input.signal ? { signal: input.signal } : {}),
        headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey ?? randomUUID() },
        body: JSON.stringify({ expectedRevision: input.expectedRevision, args: input.args ?? [] }),
      },
    );
    return await response.json() as RuntimeEngineRpcResponse;
  }

  #fetch(path: string, init: RequestInit = {}): Promise<Response> {
    // Engine RPCs can include provider/tool work. Keep every transport
    // bounded, while leaving enough time for a real turn to settle. Callers
    // that represent a detachable view pass their own shorter-lived signal.
    const timeout = AbortSignal.timeout(10 * 60_000);
    return fetch(`${this.#lease.endpoint}${path}`, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        authorization: `Bearer ${this.#token}`,
      },
    });
  }
}
