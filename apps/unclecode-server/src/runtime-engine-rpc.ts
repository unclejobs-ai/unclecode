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
export type RuntimeEngineSource = {
  getState(): unknown;
  subscribe(listener: () => void): () => void;
};
export type RuntimeSessionRevisionClock = { value: number };

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
  readonly engine: RuntimeEngineSource;
  readonly projectPath?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoning?: string | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
  readonly unsubscribe: () => void;
  readonly receipts: Map<string, { readonly fingerprint: string; readonly response: RuntimeEngineRpcResponse }>;
};

export type RuntimeEngineRpcResponse =
  | { readonly ok: true; readonly revision: number; readonly state: unknown; readonly result: unknown }
  | { readonly ok: false; readonly code: "not_attached" | "revision_conflict" | "invalid_method" | "invalid_action"; readonly message: string; readonly revision?: number };

export class LiveRuntimeEngineRegistry {
  readonly #engines = new Map<string, Attached>();
  readonly #createReceipts = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeSessionCreateResponse> }>();
  readonly #factory: RuntimeSessionFactory | undefined;

  constructor(input: { readonly createSession?: RuntimeSessionFactory | undefined } = {}) {
    this.#factory = input.createSession;
  }

  attach(sessionId: string, engine: RuntimeEngineSource, metadata: {
    readonly projectPath?: string | undefined;
    readonly provider?: string | undefined;
    readonly dispose?: (() => void | Promise<void>) | undefined;
    readonly revisionClock?: RuntimeSessionRevisionClock | undefined;
  } = {}): () => void {
    const previous = this.#engines.get(sessionId);
    previous?.unsubscribe();
    let unsubscribe = () => {};
    const attached = {
      clock: metadata.revisionClock ?? { value: 0 },
      engine,
      receipts: new Map(),
      ...metadata,
      unsubscribe: () => unsubscribe(),
    } satisfies Attached;
    unsubscribe = engine.subscribe(() => {
      if (!metadata.revisionClock) attached.clock.value += 1;
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

  create(input: RuntimeSessionCreateInput): Promise<RuntimeSessionCreateResponse> {
    const fingerprint = JSON.stringify({ sessionId: input.sessionId, projectPath: input.projectPath, provider: input.provider, model: input.model, reasoning: input.reasoning, resume: input.resume });
    const prior = this.#createReceipts.get(input.idempotencyKey);
    if (prior) return prior.fingerprint === fingerprint
      ? prior.promise
      : Promise.resolve({ ok: false, code: "invalid_action", message: "Idempotency-Key was reused for another session creation." });
    const promise = this.#createOnce(input);
    this.#createReceipts.set(input.idempotencyKey, { fingerprint, promise });
    if (this.#createReceipts.size > 2_048) this.#createReceipts.delete(this.#createReceipts.keys().next().value as string);
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
    for (const item of attached) {
      item.unsubscribe();
      await item.dispose?.();
    }
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
    const prior = attached.receipts.get(input.idempotencyKey);
    if (prior) return prior.fingerprint === fingerprint
      ? prior.response
      : { ok: false, code: "invalid_action", message: "Idempotency-Key was reused for another engine mutation.", revision: attached.clock.value };
    if (attached.clock.value !== input.expectedRevision) {
      return { ok: false, code: "revision_conflict", message: "Engine revision changed.", revision: attached.clock.value };
    }
    if (!(RUNTIME_ENGINE_METHODS as readonly string[]).includes(input.method)) {
      return { ok: false, code: "invalid_method", message: "Engine method is not exposed.", revision: attached.clock.value };
    }
    const method = (attached.engine as unknown as Record<string, unknown>)[input.method];
    if (typeof method !== "function") {
      return { ok: false, code: "invalid_method", message: "Engine does not implement this method.", revision: attached.clock.value };
    }
    try {
      const before = attached.clock.value;
      const result = await Reflect.apply(method, attached.engine, input.args);
      if (attached.clock.value === before) attached.clock.value += 1;
      const response = { ok: true, revision: attached.clock.value, state: attached.engine.getState(), result } as const;
      attached.receipts.set(input.idempotencyKey, { fingerprint, response });
      if (attached.receipts.size > 2_048) attached.receipts.delete(attached.receipts.keys().next().value as string);
      return response;
    } catch (error) {
      return { ok: false, code: "invalid_action", message: error instanceof Error ? error.message : String(error), revision: attached.clock.value };
    }
  }
}
