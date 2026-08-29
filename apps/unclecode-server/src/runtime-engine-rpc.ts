import {
  RuntimeSessionMutationArbiter,
  type RuntimeSessionRevisionClock,
} from "./runtime-mutation-arbiter.js";
import {
  SYSTEM_OBSERVABILITY_BOUNDS,
  type RuntimeCleanupEvidence,
  type RuntimeMcpServerEvidence,
  type RuntimePluginHostEvidence,
  type RuntimeProviderEvidence,
  type RuntimeSessionObservabilitySource,
  type RuntimeSystemObservabilitySource,
} from "./system-observability.js";
import { boundedRuntimeRpcError } from "./runtime-error-redaction.js";

export type { RuntimeSessionRevisionClock } from "./runtime-mutation-arbiter.js";

const MAX_PENDING_SESSION_CREATIONS = 256;
const MAX_RUNTIME_DECISION_ID_LENGTH = 160;

export const RUNTIME_ENGINE_METHODS = [
  "handleSubmit", "toggleToolHistoryDisplay", "setMode", "openSessionsPanel", "interruptTurn",
  "cancelSensitiveInput", "closeOverlay", "updateTerminalColumns", "updateTerminalRows",
  "moveContextInspectorCursor", "moveContextInspectorPane", "moveContextInspectorPage",
  "moveContextInspectorDetailOffset", "toggleContextInspectorPin", "forgetContextSourceAtCursor",
  "includeContextSourceAtCursor", "toggleContextInspectorExpanded", "undoLastContextSourceAction",
  "acceptContextSuggestion", "rejectContextSuggestion", "openAgentConsole", "closeAgentConsole",
  "selectAgentConsoleTab", "moveAgentConsoleCursor", "toggleAgentConsoleInspector", "beginAgentSteer",
  "submitAgentSteer", "requestAgentCancel", "confirmAgentCancel", "continueSelectedAgent", "answerPendingDecisionByIndex",
  "cancelPendingDecision", "removeQueueItem", "moveQueueItem", "clearQueueItems", "resumeQueueItems",
  "retryQueueItem", "discardQueueItem", "recordTraceEvent", "requestTurnPause", "resumeTurn",
] as const;

export type RuntimeEngineMethod = (typeof RUNTIME_ENGINE_METHODS)[number];

const CONTROL_ENGINE_METHODS = new Set<RuntimeEngineMethod>([
  "requestTurnPause", "resumeTurn", "answerPendingDecisionByIndex", "cancelPendingDecision",
  "beginAgentSteer", "requestAgentCancel", "confirmAgentCancel", "continueSelectedAgent",
  "submitAgentSteer",
  "openAgentConsole", "closeAgentConsole", "selectAgentConsoleTab", "moveAgentConsoleCursor",
  "toggleAgentConsoleInspector",
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
  readonly readObservability?: (() => RuntimeSessionObservabilitySource) | undefined;
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
  readonly readObservability?: (() => RuntimeSessionObservabilitySource) | undefined;
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

type ExactDecisionInvocation =
  | {
      readonly method: "answerPendingDecisionByIndex";
      readonly args: readonly [index: number, decisionId: string];
      readonly decisionId: string;
    }
  | {
      readonly method: "cancelPendingDecision";
      readonly args: readonly [decisionId: string];
      readonly decisionId: string;
    };

type DecisionInvocationValidation =
  | { readonly kind: "unrelated" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "valid"; readonly invocation: ExactDecisionInvocation };

function validRuntimeDecisionId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_RUNTIME_DECISION_ID_LENGTH;
}

function validateDecisionInvocation(
  method: string,
  args: readonly unknown[],
): DecisionInvocationValidation {
  if (method === "answerPendingDecisionByIndex") {
    const [index, decisionId] = args;
    if (
      args.length !== 2
      || !Number.isSafeInteger(index)
      || (index as number) < 1
      || !validRuntimeDecisionId(decisionId)
    ) {
      return {
        kind: "invalid",
        message: "answerPendingDecisionByIndex requires [positiveIntegerIndex, decisionId].",
      };
    }
    return {
      kind: "valid",
      invocation: {
        method,
        args: [index as number, decisionId],
        decisionId,
      },
    };
  }
  if (method === "cancelPendingDecision") {
    const [decisionId] = args;
    if (args.length !== 1 || !validRuntimeDecisionId(decisionId)) {
      return {
        kind: "invalid",
        message: "cancelPendingDecision requires [decisionId].",
      };
    }
    return {
      kind: "valid",
      invocation: {
        method,
        args: [decisionId],
        decisionId,
      },
    };
  }
  return { kind: "unrelated" };
}

function canSettleExactPendingDecision(
  attached: Attached,
  invocation: ExactDecisionInvocation,
): boolean {
  const state = attached.engine.getState() as {
    readonly agentConsole?: {
      readonly pendingDecision?: {
        readonly id?: unknown;
        readonly questions?: unknown;
      } | undefined;
    } | undefined;
  } | null;
  const pending = state?.agentConsole?.pendingDecision;
  if (pending?.id !== invocation.decisionId) return false;
  if (invocation.method === "cancelPendingDecision") return true;
  if (!Array.isArray(pending.questions) || pending.questions.length !== 1) return false;
  const question = pending.questions[0] as { readonly options?: unknown } | undefined;
  return Array.isArray(question?.options) && invocation.args[0] <= question.options.length;
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
  readonly #teardownTimeoutMs: number;
  readonly #teardowns = new Set<Promise<void>>();
  readonly #teardownFailures: string[] = [];
  readonly #cleanupInventory: Array<{
    readonly kind: "runtime-session";
    readonly identity: string;
    status: RuntimeCleanupEvidence["status"];
    recordedAt: number;
  }> = [];
  #cleanupEntriesDropped = 0;
  readonly #retired = new WeakSet<Attached>();
  #sweepTimer: NodeJS.Timeout | undefined;
  #disposed = false;

  constructor(input: {
    readonly createSession?: RuntimeSessionFactory | undefined;
    readonly maxIdleSessions?: number | undefined;
    readonly idleSessionTtlMs?: number | undefined;
    readonly teardownTimeoutMs?: number | undefined;
  } = {}) {
    this.#factory = input.createSession;
    this.#maxIdleSessions = Number.isSafeInteger(input.maxIdleSessions)
      ? Math.max(1, input.maxIdleSessions!)
      : 256;
    this.#idleSessionTtlMs = Number.isFinite(input.idleSessionTtlMs)
      ? Math.max(1_000, Math.floor(input.idleSessionTtlMs!))
      : 5 * 60_000;
    this.#teardownTimeoutMs = Number.isFinite(input.teardownTimeoutMs)
      ? Math.max(10, Math.floor(input.teardownTimeoutMs!))
      : 10_000;
  }

  attach(sessionId: string, engine: RuntimeEngineSource, metadata: {
    readonly projectPath?: string | undefined;
    readonly provider?: string | undefined;
    readonly dispose?: (() => void | Promise<void>) | undefined;
    readonly readObservability?: (() => RuntimeSessionObservabilitySource) | undefined;
    readonly revisionClock?: RuntimeSessionRevisionClock | undefined;
    readonly mutationArbiter?: RuntimeSessionMutationArbiter | undefined;
  } = {}): () => void {
    if (this.#disposed) throw new Error("Runtime engine registry has been disposed.");
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

  systemSnapshot(): Pick<
    RuntimeSystemObservabilitySource,
    "engines" | "providers" | "mcpServers" | "pluginHosts" | "cleanup"
  > {
    const now = Date.now();
    const providers = new Map<string, RuntimeProviderEvidence>();
    const mcpServers = new Map<string, RuntimeMcpServerEvidence>();
    const pluginHosts: RuntimePluginHostEvidence[] = [];
    let activeMutations = 0;
    let clientLeaseProtectedSessions = 0;
    let observedSessions = 0;
    let observabilityCallbackFailures = 0;
    let mcpConfigurationUnavailableObserved = 0;
    for (const [sessionId, attached] of this.#engines) {
      if (observedSessions >= SYSTEM_OBSERVABILITY_BOUNDS.engineSessions) break;
      observedSessions += 1;
      if (attached.arbiter.isMutationActive()) activeMutations += 1;
      if (attached.clientLeaseUntil > now) clientLeaseProtectedSessions += 1;
      let observed: RuntimeSessionObservabilitySource | undefined;
      try {
        observed = attached.readObservability?.();
      } catch {
        observabilityCallbackFailures += 1;
        continue;
      }
      if (observed?.mcpConfigurationStatus === "unavailable") {
        mcpConfigurationUnavailableObserved += 1;
      }
      if (observed?.provider && providers.size < SYSTEM_OBSERVABILITY_BOUNDS.providers) {
        const key = `${observed.provider.provider}\u0000${observed.provider.model}`;
        if (!providers.has(key)) providers.set(key, observed.provider);
      }
      for (const server of observed?.mcpServers ?? []) {
        if (mcpServers.size >= SYSTEM_OBSERVABILITY_BOUNDS.mcpServers) break;
        const key = `${server.name}\u0000${server.transport}`;
        if (!mcpServers.has(key)) mcpServers.set(key, server);
      }
      if (observed?.plugins && pluginHosts.length < SYSTEM_OBSERVABILITY_BOUNDS.pluginHosts) {
        pluginHosts.push({
          sessionId,
          status: observed.plugins.status,
          registrationCount: observed.plugins.registrationCount,
          pendingCleanupCount: observed.plugins.pendingCleanupCount,
          registrations: observed.plugins.registrations.slice(0, SYSTEM_OBSERVABILITY_BOUNDS.pluginsPerHost),
          truncated: observed.plugins.truncated
            || observed.plugins.registrations.length > SYSTEM_OBSERVABILITY_BOUNDS.pluginsPerHost,
        });
      }
    }
    return {
      engines: {
        attachedSessions: this.#engines.size,
        activeMutationsObserved: activeMutations,
        pendingCreations: this.#sessionCreations.size,
        pendingTeardowns: this.#teardowns.size,
        clientLeaseProtectedSessionsObserved: clientLeaseProtectedSessions,
        teardownFailuresRetained: this.#teardownFailures.length,
        observedSessions,
        scanTruncated: this.#engines.size > observedSessions,
        cleanupEntriesDropped: this.#cleanupEntriesDropped,
        unlistedPendingTeardowns: Math.max(
          0,
          this.#teardowns.size - this.#cleanupInventory.filter(item => item.status === "pending").length,
        ),
        observabilityCallbackFailures,
        mcpConfigurationUnavailableObserved,
      },
      providers: [...providers.values()],
      mcpServers: [...mcpServers.values()],
      pluginHosts,
      cleanup: this.#cleanupInventory.slice(-SYSTEM_OBSERVABILITY_BOUNDS.cleanup).map(item => ({ ...item })),
    };
  }

  publishDurableRevision(sessionId: string, revision: number): number | undefined {
    return this.#engines.get(sessionId)?.arbiter.publishDurable(revision);
  }

  create(input: RuntimeSessionCreateInput): Promise<RuntimeSessionCreateResponse> {
    if (this.#disposed) {
      return Promise.resolve({
        ok: false,
        code: "invalid_action",
        message: "Runtime engine registry has been disposed.",
      });
    }
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
    if (this.#sessionCreations.size >= MAX_PENDING_SESSION_CREATIONS) {
      return Promise.resolve({
        ok: false,
        code: "invalid_action",
        message: "Runtime owner has too many session creations in progress.",
      });
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
      if (this.#disposed) {
        try {
          await withTimeout(
            Promise.resolve(created.dispose?.()),
            this.#teardownTimeoutMs,
            "Late runtime session cleanup timed out.",
          );
        } catch (error) {
          this.#recordTeardownFailure(error);
          throw error;
        }
        return { ok: false, code: "invalid_action", message: "Runtime engine registry has been disposed." };
      }
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
        ...(created.readObservability ? { readObservability: created.readObservability } : {}),
      });
      return { ok: true, session: this.#descriptor(input.sessionId, this.#engines.get(input.sessionId)!) };
    } catch (error) {
      return { ok: false, code: "invalid_action", message: boundedRuntimeRpcError(error) };
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
    this.#disposed = true;
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = undefined;
    for (const [sessionId, item] of [...this.#engines]) this.#scheduleTeardown(sessionId, item, true);
    const failures: string[] = [];
    const settle = async (): Promise<void> => {
      try {
        await this.settleTeardowns();
      } catch (error) {
        failures.push(boundedRuntimeRpcError(error));
      }
    };
    try {
      await settle();
      if (this.#sessionCreations.size > 0) {
        try {
          await withTimeout(
            Promise.allSettled([...this.#sessionCreations.values()].map(item => item.promise)),
            this.#teardownTimeoutMs,
            "Runtime session creation shutdown timed out.",
          );
        } catch (error) {
          failures.push(boundedRuntimeRpcError(error));
        }
        await settle();
      }
    } finally {
      this.#createReceipts.clear();
      this.#sessionCreations.clear();
    }
    if (failures.length > 0) {
      throw new Error(`Runtime owner cleanup did not settle cleanly: ${failures.join("; ")}`);
    }
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
      failures.push(boundedRuntimeRpcError(error));
    }
    if (!await item.arbiter.settle()) {
      failures.push("Runtime mutation arbiter did not settle active provider/tool work.");
    }
    try {
      await item.dispose?.();
    } catch (error) {
      failures.push(boundedRuntimeRpcError(error));
    }
    if (failures.length > 0) throw new Error(`Runtime owner shutdown did not settle cleanly: ${failures.join("; ")}`);
  }

  #scheduleTeardown(sessionId: string, attached: Attached, force: boolean): void {
    if (this.#retired.has(attached)) return;
    if (!force && attached.arbiter.isMutationActive()) return;
    this.#retired.add(attached);
    if (this.#engines.get(sessionId) === attached) this.#engines.delete(sessionId);
    const cleanup = {
      kind: "runtime-session" as const,
      identity: sessionId,
      status: "pending" as RuntimeCleanupEvidence["status"],
      recordedAt: Date.now(),
    };
    this.#cleanupInventory.push(cleanup);
    this.#boundCleanupInventory();
    const teardown = withTimeout(
      this.#disposeAttached(attached),
      this.#teardownTimeoutMs,
      `Runtime session ${sessionId} teardown timed out.`,
    ).catch((error: unknown) => {
      cleanup.status = "failed";
      cleanup.recordedAt = Date.now();
      this.#recordTeardownFailure(error);
    }).finally(() => {
      if (cleanup.status === "pending") cleanup.status = "completed";
      cleanup.recordedAt = Date.now();
      this.#teardowns.delete(teardown);
    });
    this.#teardowns.add(teardown);
  }

  #recordTeardownFailure(error: unknown): void {
    this.#teardownFailures.push(boundedRuntimeRpcError(error));
    if (this.#teardownFailures.length > SYSTEM_OBSERVABILITY_BOUNDS.cleanup) {
      this.#teardownFailures.splice(0, this.#teardownFailures.length - SYSTEM_OBSERVABILITY_BOUNDS.cleanup);
    }
  }

  #boundCleanupInventory(): void {
    while (this.#cleanupInventory.length > SYSTEM_OBSERVABILITY_BOUNDS.cleanup) {
      const completed = this.#cleanupInventory.findIndex(item => item.status === "completed");
      const failed = completed < 0
        ? this.#cleanupInventory.findIndex(item => item.status === "failed")
        : -1;
      const removeAt = completed >= 0 ? completed : failed >= 0 ? failed : 0;
      this.#cleanupInventory.splice(removeAt, 1);
      this.#cleanupEntriesDropped += 1;
    }
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
    const decisionValidation = validateDecisionInvocation(input.method, input.args);
    if (decisionValidation.kind === "invalid") {
      return {
        ok: false,
        code: "invalid_action",
        message: decisionValidation.message,
        revision: attached.clock.value,
      };
    }
    const exactDecision = decisionValidation.kind === "valid"
      ? decisionValidation.invocation
      : undefined;
    const invocationArgs = exactDecision?.args ?? input.args;
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
        : exactDecision
          ? {
              precondition: () => canSettleExactPendingDecision(attached, exactDecision) ? undefined : false,
              didMutate: (result: unknown) => result !== false,
            }
        : {}),
      execute: () => Reflect.apply(method, attached.engine, invocationArgs),
      complete: (result, revision) => input.method === "interruptTurn" && result === false
        ? { ok: false, code: "invalid_action", message: "No admitted or active turn could be cancelled.", revision }
        : exactDecision && result === false
          ? { ok: false, code: "invalid_action", message: "The pending decision changed or is no longer actionable.", revision }
        : {
            ok: true,
            revision,
            ...(result === undefined ? {} : { result }),
          },
      fail: (error, revision) => ({
        ok: false,
        code: "invalid_action",
        message: boundedRuntimeRpcError(error),
        revision,
      }),
    });
  }
}

function withTimeout<Result>(promise: Promise<Result>, timeoutMs: number, message: string): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
