import {
  RuntimeSessionMutationArbiter,
  type RuntimeSessionRevisionClock,
} from "./runtime-mutation-arbiter.js";

export type { RuntimeSessionRevisionClock } from "./runtime-mutation-arbiter.js";

export const RUNTIME_ENGINE_METHODS = [
  "handleSubmit", "toggleToolHistoryDisplay", "setMode", "openSessionsPanel", "interruptTurn",
  "cancelSensitiveInput", "closeOverlay", "updateTerminalColumns", "updateTerminalRows",
  "moveContextInspectorCursor", "moveContextInspectorPane", "moveContextInspectorPage",
  "moveContextInspectorDetailOffset", "toggleContextInspectorPin", "forgetContextSourceAtCursor",
  "includeContextSourceAtCursor", "toggleContextInspectorExpanded", "undoLastContextSourceAction",
  "acceptContextSuggestion", "rejectContextSuggestion", "openAgentConsole", "closeAgentConsole",
  "selectAgentConsoleTab", "moveAgentConsoleCursor", "toggleAgentConsoleInspector", "beginAgentSteer",
  "requestAgentCancel", "confirmAgentCancel", "continueSelectedAgent", "answerPendingDecisionByIndex",
  "cancelPendingDecision", "removeQueueItem", "moveQueueItem", "clearQueueItems", "resumeQueueItems",
  "retryQueueItem", "discardQueueItem", "recordTraceEvent", "requestTurnPause", "resumeTurn",
] as const;

export type RuntimeEngineMethod = (typeof RUNTIME_ENGINE_METHODS)[number];

const CONTROL_ENGINE_METHODS = new Set<RuntimeEngineMethod>([
  "requestTurnPause", "resumeTurn", "answerPendingDecisionByIndex", "cancelPendingDecision",
  "beginAgentSteer", "requestAgentCancel", "confirmAgentCancel", "continueSelectedAgent",
]);
export type RuntimeEngineSource = {
  getState(): unknown;
  subscribe(listener: () => void): () => void;
};
export type RuntimeSessionDescriptor = {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoning?: string | undefined;
  readonly revision: number;
};

export type RuntimeSessionCreateInput = {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoning?: string | undefined;
  readonly resume?: boolean | undefined;
  readonly idempotencyKey: string;
};

export type RuntimeSessionFactory = (input: Omit<RuntimeSessionCreateInput, "idempotencyKey">) => Promise<{
  readonly engine: RuntimeEngineSource;
  readonly projectPath: string;
  readonly provider?: string | undefined;
  readonly revisionClock?: RuntimeSessionRevisionClock | undefined;
  readonly mutationArbiter?: RuntimeSessionMutationArbiter | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}>;

export type RuntimeSessionCreateResponse =
  | { readonly ok: true; readonly session: RuntimeSessionDescriptor }
  | { readonly ok: false; readonly code: "factory_unavailable" | "session_conflict" | "invalid_action"; readonly message: string };

export type RuntimeSessionAttachResponse =
  | { readonly ok: true; readonly session: RuntimeSessionDescriptor; readonly engine: RuntimeEngineRpcResponse }
  | { readonly ok: false; readonly code: "not_attached"; readonly message: string };

type Attached = {
  readonly clock: RuntimeSessionRevisionClock;
  readonly arbiter: RuntimeSessionMutationArbiter;
  readonly engine: RuntimeEngineSource;
  readonly projectPath?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoning?: string | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
  readonly unsubscribe: () => void;
  lastAccessAt: number;
  clientLeaseUntil: number;
};

function hasInterruptibleTurn(attached: Attached): boolean {
  if (attached.arbiter.hasCancellableMutation()) return true;
  const engine = attached.engine as unknown as {
    getTurnLifecycle?: (() => { readonly state?: string | undefined }) | undefined;
  };
  const lifecycle = typeof engine.getTurnLifecycle === "function"
    ? Reflect.apply(engine.getTurnLifecycle, attached.engine, [])
    : undefined;
  if (lifecycle?.state && !["idle", "completed", "cancelled"].includes(lifecycle.state)) return true;
  const state = attached.engine.getState() as { readonly isBusy?: unknown } | null;
  return state?.isBusy === true;
}

export type RuntimeEngineRpcResponse =
  | { readonly ok: true; readonly revision: number; readonly state?: unknown; readonly result?: unknown }
  | { readonly ok: false; readonly code: "not_attached" | "revision_conflict" | "invalid_method" | "invalid_action"; readonly message: string; readonly revision?: number };

export class LiveRuntimeEngineRegistry {
  readonly #engines = new Map<string, Attached>();
  readonly #createReceipts = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeSessionCreateResponse> }>();
  readonly #sessionCreations = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeSessionCreateResponse> }>();
  readonly #factory: RuntimeSessionFactory | undefined;
  readonly #maxIdleSessions: number;
  readonly #idleSessionTtlMs: number;
  readonly #teardowns = new Set<Promise<void>>();
  readonly #teardownFailures: string[] = [];
  readonly #retired = new WeakSet<Attached>();
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(input: {
    readonly createSession?: RuntimeSessionFactory | undefined;
    readonly maxIdleSessions?: number | undefined;
    readonly idleSessionTtlMs?: number | undefined;
  } = {}) {
    this.#factory = input.createSession;
    this.#maxIdleSessions = Number.isSafeInteger(input.maxIdleSessions)
      ? Math.max(1, input.maxIdleSessions!)
      : 256;
    this.#idleSessionTtlMs = Number.isFinite(input.idleSessionTtlMs)
      ? Math.max(1_000, Math.floor(input.idleSessionTtlMs!))
      : 5 * 60_000;
  }

  attach(sessionId: string, engine: RuntimeEngineSource, metadata: {
    readonly projectPath?: string | undefined;
    readonly provider?: string | undefined;
    readonly dispose?: (() => void | Promise<void>) | undefined;
    readonly revisionClock?: RuntimeSessionRevisionClock | undefined;
    readonly mutationArbiter?: RuntimeSessionMutationArbiter | undefined;
  } = {}): () => void {
    const previous = this.#engines.get(sessionId);
    if (previous) this.#scheduleTeardown(sessionId, previous, true);
    let unsubscribe = () => {};
    const clock = metadata.revisionClock ?? metadata.mutationArbiter?.clock ?? { value: 0 };
    const arbiter = metadata.mutationArbiter ?? new RuntimeSessionMutationArbiter(clock);
    const attached = {
      clock,
      arbiter,
      engine,
      ...metadata,
      unsubscribe: () => unsubscribe(),
      lastAccessAt: Date.now(),
      clientLeaseUntil: 0,
    } satisfies Attached;
    unsubscribe = engine.subscribe(() => {
      attached.arbiter.publishAutonomous();
    });
    this.#engines.set(sessionId, attached);
    this.#enforceIdleBound(sessionId);
    this.#scheduleIdleSweep();
    return () => {
      this.#scheduleTeardown(sessionId, attached, true);
    };
  }

  list(): readonly RuntimeSessionDescriptor[] {
    return [...this.#engines.entries()]
      .filter((entry): entry is [string, Attached & { projectPath: string }] => typeof entry[1].projectPath === "string")
      .map(([sessionId, attached]) => ({
        sessionId,
        projectPath: attached.projectPath,
        ...(attached.provider ? { provider: attached.provider } : {}),
        revision: attached.clock.value,
      }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  publishDurableRevision(sessionId: string, revision: number): number | undefined {
    return this.#engines.get(sessionId)?.arbiter.publishDurable(revision);
  }

  create(input: RuntimeSessionCreateInput): Promise<RuntimeSessionCreateResponse> {
    const fingerprint = JSON.stringify({ sessionId: input.sessionId, projectPath: input.projectPath, provider: input.provider, model: input.model, reasoning: input.reasoning, resume: input.resume });
    const prior = this.#createReceipts.get(input.idempotencyKey);
    if (prior) return prior.fingerprint === fingerprint
      ? prior.promise
      : Promise.resolve({ ok: false, code: "invalid_action", message: "Idempotency-Key was reused for another session creation." });
    const promise = this.#createCoalesced(input, fingerprint);
    this.#createReceipts.set(input.idempotencyKey, { fingerprint, promise });
    if (this.#createReceipts.size > 2_048) this.#createReceipts.delete(this.#createReceipts.keys().next().value as string);
    return promise;
  }

  #createCoalesced(input: RuntimeSessionCreateInput, fingerprint: string): Promise<RuntimeSessionCreateResponse> {
    const pending = this.#sessionCreations.get(input.sessionId);
    if (pending) {
      return pending.fingerprint === fingerprint
        ? pending.promise
        : Promise.resolve({ ok: false, code: "session_conflict", message: "Session creation is already in progress with different owner configuration." });
    }
    const promise = this.#createOnce(input).finally(() => {
      if (this.#sessionCreations.get(input.sessionId)?.promise === promise) {
        this.#sessionCreations.delete(input.sessionId);
      }
    });
    this.#sessionCreations.set(input.sessionId, { fingerprint, promise });
    return promise;
  }

  async #createOnce(input: RuntimeSessionCreateInput): Promise<RuntimeSessionCreateResponse> {
    const existing = this.#engines.get(input.sessionId);
    if (existing) {
      if (existing.projectPath !== input.projectPath) {
        return { ok: false, code: "session_conflict", message: "Session id is already owned by another workspace." };
      }
      return { ok: true, session: this.#descriptor(input.sessionId, existing) };
    }
    if (!this.#factory) return { ok: false, code: "factory_unavailable", message: "Runtime owner cannot create work sessions." };
    try {
      const created = await this.#factory({
        sessionId: input.sessionId,
        projectPath: input.projectPath,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        ...(input.resume !== undefined ? { resume: input.resume } : {}),
      });
      const raced = this.#engines.get(input.sessionId);
      if (raced) {
        await created.dispose?.();
        if (raced.projectPath !== input.projectPath) {
          return { ok: false, code: "session_conflict", message: "Session id is already owned by another workspace." };
        }
        return { ok: true, session: this.#descriptor(input.sessionId, raced) };
      }
      this.attach(input.sessionId, created.engine, {
        projectPath: created.projectPath,
        ...(created.provider ? { provider: created.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        ...(created.revisionClock ? { revisionClock: created.revisionClock } : {}),
        ...(created.mutationArbiter ? { mutationArbiter: created.mutationArbiter } : {}),
        ...(created.dispose ? { dispose: created.dispose } : {}),
      });
      return { ok: true, session: this.#descriptor(input.sessionId, this.#engines.get(input.sessionId)!) };
    } catch (error) {
      return { ok: false, code: "invalid_action", message: error instanceof Error ? error.message : String(error) };
    }
  }

  attachSession(sessionId: string): RuntimeSessionAttachResponse {
    const attached = this.#engines.get(sessionId);
    if (!attached || !attached.projectPath) return { ok: false, code: "not_attached", message: "Session is not attached to the runtime owner." };
    this.#touch(sessionId, attached, true);
    return { ok: true, session: this.#descriptor(sessionId, attached), engine: this.read(sessionId) };
  }

  async releaseSession(sessionId: string): Promise<boolean> {
    const attached = this.#engines.get(sessionId);
    if (!attached) return false;
    attached.clientLeaseUntil = 0;
    if (attached.arbiter.isMutationActive()) return false;
    this.#scheduleTeardown(sessionId, attached, false);
    await this.settleTeardowns();
    return true;
  }

  async settleTeardowns(): Promise<void> {
    while (this.#teardowns.size > 0) await Promise.allSettled([...this.#teardowns]);
    if (this.#teardownFailures.length > 0) {
      const failures = this.#teardownFailures.splice(0);
      throw new Error(`Runtime session teardown did not settle cleanly: ${failures.join("; ")}`);
    }
  }

  async disposeAll(): Promise<void> {
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = undefined;
    for (const [sessionId, item] of [...this.#engines]) this.#scheduleTeardown(sessionId, item, true);
    await this.settleTeardowns();
    this.#createReceipts.clear();
    this.#sessionCreations.clear();
  }

  async #disposeAttached(item: Attached): Promise<void> {
    const failures: string[] = [];
    item.unsubscribe();
    const lifecycle = item.engine as unknown as {
      shutdown?: ((input?: { readonly timeoutMs?: number }) => Promise<boolean> | boolean) | undefined;
      interruptTurn?: (() => void) | undefined;
    };
    try {
      if (typeof lifecycle.shutdown === "function") {
        const settled = await Reflect.apply(lifecycle.shutdown, item.engine, []);
        if (settled === false) failures.push("Runtime engine shutdown did not settle provider/tool children.");
      } else if (typeof lifecycle.interruptTurn === "function") {
        Reflect.apply(lifecycle.interruptTurn, item.engine, []);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (!await item.arbiter.settle()) {
      failures.push("Runtime mutation arbiter did not settle active provider/tool work.");
    }
    try {
      await item.dispose?.();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (failures.length > 0) throw new Error(`Runtime owner shutdown did not settle cleanly: ${failures.join("; ")}`);
  }

  #scheduleTeardown(sessionId: string, attached: Attached, force: boolean): void {
    if (this.#retired.has(attached)) return;
    if (!force && attached.arbiter.isMutationActive()) return;
    this.#retired.add(attached);
    if (this.#engines.get(sessionId) === attached) this.#engines.delete(sessionId);
    const teardown = this.#disposeAttached(attached).catch((error: unknown) => {
      this.#teardownFailures.push(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      this.#teardowns.delete(teardown);
    });
    this.#teardowns.add(teardown);
  }

  #touch(sessionId: string, attached: Attached, protectClient: boolean): void {
    const now = Date.now();
    attached.lastAccessAt = now;
    if (protectClient) attached.clientLeaseUntil = now + this.#idleSessionTtlMs;
    if (this.#engines.get(sessionId) === attached) {
      this.#engines.delete(sessionId);
      this.#engines.set(sessionId, attached);
    }
    this.#scheduleIdleSweep();
  }

  #enforceIdleBound(excludeSessionId: string): void {
    if (this.#engines.size <= this.#maxIdleSessions) return;
    const now = Date.now();
    for (const [sessionId, attached] of this.#engines) {
      if (this.#engines.size <= this.#maxIdleSessions) break;
      if (sessionId === excludeSessionId || attached.clientLeaseUntil > now || attached.arbiter.isMutationActive()) continue;
      this.#scheduleTeardown(sessionId, attached, false);
    }
  }

  #scheduleIdleSweep(): void {
    if (this.#sweepTimer || this.#engines.size === 0) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = undefined;
      const now = Date.now();
      for (const [sessionId, attached] of this.#engines) {
        if (
          now - attached.lastAccessAt >= this.#idleSessionTtlMs
          && attached.clientLeaseUntil <= now
          && !attached.arbiter.isMutationActive()
        ) {
          this.#scheduleTeardown(sessionId, attached, false);
        }
      }
      this.#scheduleIdleSweep();
    }, this.#idleSessionTtlMs);
    this.#sweepTimer.unref?.();
  }

  #descriptor(sessionId: string, attached: Attached): RuntimeSessionDescriptor {
    return {
      sessionId,
      projectPath: attached.projectPath ?? "",
      ...(attached.provider ? { provider: attached.provider } : {}),
      ...(attached.model ? { model: attached.model } : {}),
      ...(attached.reasoning ? { reasoning: attached.reasoning } : {}),
      revision: attached.clock.value,
    };
  }

  read(sessionId: string): RuntimeEngineRpcResponse {
    const attached = this.#engines.get(sessionId);
    if (attached) this.#touch(sessionId, attached, true);
    return attached
      ? { ok: true, revision: attached.clock.value, state: attached.engine.getState(), result: null }
      : { ok: false, code: "not_attached", message: "Session is not attached to the runtime owner." };
  }

  async invoke(input: {
    readonly sessionId: string;
    readonly method: string;
    readonly args: readonly unknown[];
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
  }): Promise<RuntimeEngineRpcResponse> {
    const attached = this.#engines.get(input.sessionId);
    if (!attached) return { ok: false, code: "not_attached", message: "Session is not attached to the runtime owner." };
    this.#touch(input.sessionId, attached, true);
    const fingerprint = { method: input.method, args: input.args, expectedRevision: input.expectedRevision };
    if (!(RUNTIME_ENGINE_METHODS as readonly string[]).includes(input.method)) {
      return { ok: false, code: "invalid_method", message: "Engine method is not exposed.", revision: attached.clock.value };
    }
    const method = (attached.engine as unknown as Record<string, unknown>)[input.method];
    if (typeof method !== "function") {
      return { ok: false, code: "invalid_method", message: "Engine does not implement this method.", revision: attached.clock.value };
    }
    return attached.arbiter.mutate<unknown, RuntimeEngineRpcResponse>({
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      expectedRevision: input.expectedRevision,
      ...(input.method === "interruptTurn"
        ? { lane: "cancel" as const }
        : CONTROL_ENGINE_METHODS.has(input.method as RuntimeEngineMethod)
          ? { lane: "control" as const }
          : {}),
      ...(input.method === "requestTurnPause" ? { bindsCancelGeneration: true } : {}),
      conflict: (revision) => ({ ok: false, code: "revision_conflict", message: "Engine revision changed.", revision }),
      invalidReuse: (revision) => ({ ok: false, code: "invalid_action", message: "Idempotency-Key was reused for another engine mutation.", revision }),
      ...(input.method === "handleSubmit" && typeof (attached.engine as { admitRuntimeTurn?: unknown }).admitRuntimeTurn === "function"
        ? { onAdmitted: () => Reflect.apply((attached.engine as unknown as { admitRuntimeTurn: () => void }).admitRuntimeTurn, attached.engine, []) }
        : {}),
      ...(input.method === "interruptTurn"
        ? {
            precondition: () => hasInterruptibleTurn(attached) ? undefined : false,
            didMutate: (result: unknown) => result !== false,
          }
        : {}),
      execute: () => Reflect.apply(method, attached.engine, input.args),
      complete: (result, revision) => input.method === "interruptTurn" && result === false
        ? { ok: false, code: "invalid_action", message: "No admitted or active turn could be cancelled.", revision }
        : {
            ok: true,
            revision,
            ...(result === undefined ? {} : { result }),
          },
      fail: (error, revision) => ({
        ok: false,
        code: "invalid_action",
        message: error instanceof Error ? error.message : String(error),
        revision,
      }),
    });
  }
}
