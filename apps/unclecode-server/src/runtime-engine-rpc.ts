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
};

export type RuntimeEngineRpcResponse =
  | { readonly ok: true; readonly revision: number; readonly state: unknown; readonly result: unknown }
  | { readonly ok: false; readonly code: "not_attached" | "revision_conflict" | "invalid_method" | "invalid_action"; readonly message: string; readonly revision?: number };

export class LiveRuntimeEngineRegistry {
  readonly #engines = new Map<string, Attached>();
  readonly #createReceipts = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeSessionCreateResponse> }>();
  readonly #sessionCreations = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeSessionCreateResponse> }>();
  readonly #factory: RuntimeSessionFactory | undefined;

  constructor(input: { readonly createSession?: RuntimeSessionFactory | undefined } = {}) {
    this.#factory = input.createSession;
  }

  attach(sessionId: string, engine: RuntimeEngineSource, metadata: {
    readonly projectPath?: string | undefined;
    readonly provider?: string | undefined;
    readonly dispose?: (() => void | Promise<void>) | undefined;
    readonly revisionClock?: RuntimeSessionRevisionClock | undefined;
    readonly mutationArbiter?: RuntimeSessionMutationArbiter | undefined;
  } = {}): () => void {
    const previous = this.#engines.get(sessionId);
    previous?.unsubscribe();
    let unsubscribe = () => {};
    const clock = metadata.revisionClock ?? metadata.mutationArbiter?.clock ?? { value: 0 };
    const arbiter = metadata.mutationArbiter ?? new RuntimeSessionMutationArbiter(clock);
    const attached = {
      clock,
      arbiter,
      engine,
      ...metadata,
      unsubscribe: () => unsubscribe(),
    } satisfies Attached;
    unsubscribe = engine.subscribe(() => {
      attached.arbiter.publishAutonomous();
    });
    this.#engines.set(sessionId, attached);
    return () => {
      attached.unsubscribe();
      if (this.#engines.get(sessionId) === attached) this.#engines.delete(sessionId);
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
    return { ok: true, session: this.#descriptor(sessionId, attached), engine: this.read(sessionId) };
  }

  async disposeAll(): Promise<void> {
    const attached = [...this.#engines.values()];
    this.#engines.clear();
    const failures: string[] = [];
    for (const item of attached) {
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
    }
    if (failures.length > 0) throw new Error(`Runtime owner shutdown did not settle cleanly: ${failures.join("; ")}`);
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
    const fingerprint = JSON.stringify({ method: input.method, args: input.args, expectedRevision: input.expectedRevision });
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
      conflict: (revision) => ({ ok: false, code: "revision_conflict", message: "Engine revision changed.", revision }),
      invalidReuse: (revision) => ({ ok: false, code: "invalid_action", message: "Idempotency-Key was reused for another engine mutation.", revision }),
      ...(input.method === "handleSubmit" && typeof (attached.engine as { admitRuntimeTurn?: unknown }).admitRuntimeTurn === "function"
        ? { onAdmitted: () => Reflect.apply((attached.engine as unknown as { admitRuntimeTurn: () => void }).admitRuntimeTurn, attached.engine, []) }
        : {}),
      execute: () => Reflect.apply(method, attached.engine, input.args),
      complete: (result, revision) => input.method === "interruptTurn" && result === false
        ? { ok: false, code: "invalid_action", message: "No admitted or active turn could be cancelled.", revision }
        : { ok: true, revision, state: attached.engine.getState(), result },
      fail: (error, revision) => ({
        ok: false,
        code: "invalid_action",
        message: error instanceof Error ? error.message : String(error),
        revision,
      }),
    });
  }
}
