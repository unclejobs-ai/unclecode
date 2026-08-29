export type WorkShellTurnLifecycleState =
  | "idle"
  | "running"
  | "pause_pending"
  | "paused"
  | "cancelled"
  | "completed";

export type WorkShellPauseBoundary =
  | "before_provider"
  | "after_provider"
  | "before_policy"
  | "after_policy"
  | "before_approval"
  | "after_approval"
  | "before_tool"
  | "after_tool"
  | "between_nodes"
  | "between_quality_iterations"
  | "before_completion";

export type WorkShellPauseSnapshot = {
  readonly state: WorkShellTurnLifecycleState;
  readonly turnId?: string | undefined;
  readonly boundary?: WorkShellPauseBoundary | undefined;
};

export type WorkShellPauseReceipt = {
  readonly turnId: string;
  readonly boundary: WorkShellPauseBoundary;
};

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
};

type PauseTransition = {
  readonly turnId: string;
  readonly boundary: WorkShellPauseBoundary;
  readonly resumeGate: Deferred<void>;
  readonly suspension: Promise<void>;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function operationBoundaries(operation: "provider.request" | "policy.evaluate" | "approval.wait" | "tool.dispatch"): {
  readonly before: WorkShellPauseBoundary;
  readonly after: WorkShellPauseBoundary;
} {
  switch (operation) {
    case "provider.request": return { before: "before_provider", after: "after_provider" };
    case "policy.evaluate": return { before: "before_policy", after: "after_policy" };
    case "approval.wait": return { before: "before_approval", after: "after_approval" };
    case "tool.dispatch": return { before: "before_tool", after: "after_tool" };
  }
}

/**
 * Turn-scoped cooperative suspension. Abort/cancel never shares this gate:
 * pause waits for an explicitly awaited safe boundary, durably flushes that
 * boundary, and only then acknowledges the request.
 */
export class CooperativePauseController {
  readonly #listeners = new Set<(snapshot: WorkShellPauseSnapshot) => void>();
  #snapshot: WorkShellPauseSnapshot = { state: "idle" };
  #pauseAcknowledgement: Deferred<WorkShellPauseReceipt> | undefined;
  #pauseTransition: PauseTransition | undefined;

  constructor(input: {
    readonly onStateChanged?: ((snapshot: WorkShellPauseSnapshot) => void) | undefined;
  } = {}) {
    if (input.onStateChanged) this.#listeners.add(input.onStateChanged);
  }

  snapshot(): WorkShellPauseSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: WorkShellPauseSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  beginTurn(turnId: string): void {
    if (!turnId.trim()) throw new Error("A cooperative turn requires an identity.");
    if (this.#snapshot.state === "running" || this.#snapshot.state === "pause_pending" || this.#snapshot.state === "paused") {
      throw new Error("A cooperative turn is already active.");
    }
    this.#pauseAcknowledgement = undefined;
    this.#pauseTransition = undefined;
    this.#publish({ state: "running", turnId });
  }

  requestPause(): Promise<WorkShellPauseReceipt> {
    const turnId = this.#snapshot.turnId;
    if (!turnId || (this.#snapshot.state !== "running" && this.#snapshot.state !== "pause_pending" && this.#snapshot.state !== "paused")) {
      return Promise.reject(new Error("Only an active turn can be paused."));
    }
    if (this.#snapshot.state === "paused" && this.#snapshot.boundary) {
      return Promise.resolve({ turnId, boundary: this.#snapshot.boundary });
    }
    if (!this.#pauseAcknowledgement) this.#pauseAcknowledgement = deferred<WorkShellPauseReceipt>();
    if (this.#snapshot.state === "running") this.#publish({ ...this.#snapshot, state: "pause_pending" });
    return this.#pauseAcknowledgement.promise;
  }

  async checkpoint(
    boundary: WorkShellPauseBoundary,
    persist: (snapshot: WorkShellPauseSnapshot) => Promise<void>,
  ): Promise<void> {
    if (this.#snapshot.state === "cancelled") throw abortError("Turn cancelled while suspended.");
    if (this.#pauseTransition) return this.#pauseTransition.suspension;
    if (this.#snapshot.state !== "pause_pending") return;
    const turnId = this.#snapshot.turnId;
    if (!turnId) throw new Error("Pause checkpoint lost the active turn identity.");

    const paused = { state: "paused", turnId, boundary } as const;
    const resumeGate = deferred<void>();
    let transition!: PauseTransition;
    const suspension = (async () => {
      try {
        await persist(paused);
        if (this.#isCancelled()) throw abortError("Turn cancelled while persisting its pause checkpoint.");
        this.#publish(paused);
        this.#pauseAcknowledgement?.resolve({ turnId, boundary });
        await resumeGate.promise;
        if (this.#isCancelled()) throw abortError("Turn cancelled while suspended.");
      } catch (error) {
        if (this.#pauseTransition === transition) this.#pauseTransition = undefined;
        if (!this.#isCancelled()) {
          this.#pauseAcknowledgement?.reject(error);
          this.#pauseAcknowledgement = undefined;
          this.#publish({ state: "running", turnId });
        }
        throw error;
      }
    })();
    transition = { turnId, boundary, resumeGate, suspension };
    this.#pauseTransition = transition;
    return suspension;
  }

  async runNonInterruptible<Value>(
    operation: "provider.request" | "policy.evaluate" | "approval.wait" | "tool.dispatch",
    run: () => Promise<Value>,
    persist: (snapshot: WorkShellPauseSnapshot) => Promise<void>,
  ): Promise<Value> {
    const boundaries = operationBoundaries(operation);
    await this.checkpoint(boundaries.before, persist);
    let result: Value;
    let failure: unknown;
    try {
      result = await run();
    } catch (error) {
      failure = error;
      result = undefined as Value;
    }
    await this.checkpoint(boundaries.after, persist);
    if (failure !== undefined) throw failure;
    return result;
  }

  resume(): boolean {
    if (this.#snapshot.state !== "paused" || !this.#pauseTransition) return false;
    const turnId = this.#snapshot.turnId;
    const transition = this.#pauseTransition;
    this.#pauseTransition = undefined;
    this.#pauseAcknowledgement = undefined;
    this.#publish({ state: "running", ...(turnId ? { turnId } : {}) });
    transition.resumeGate.resolve();
    return true;
  }

  cancel(): boolean {
    if (this.#snapshot.state === "idle" || this.#snapshot.state === "completed" || this.#snapshot.state === "cancelled") return false;
    const turnId = this.#snapshot.turnId;
    const error = abortError("Turn cancelled.");
    this.#pauseAcknowledgement?.reject(error);
    this.#pauseAcknowledgement = undefined;
    const transition = this.#pauseTransition;
    this.#pauseTransition = undefined;
    this.#publish({ state: "cancelled", ...(turnId ? { turnId } : {}) });
    transition?.resumeGate.resolve();
    return true;
  }

  complete(): void {
    const turnId = this.#snapshot.turnId;
    if (this.#snapshot.state === "pause_pending" || this.#snapshot.state === "paused") {
      throw new Error("A suspended turn cannot complete before it resumes.");
    }
    if (this.#snapshot.state === "running") {
      this.#publish({ state: "completed", ...(turnId ? { turnId } : {}) });
    }
  }

  #publish(snapshot: WorkShellPauseSnapshot): void {
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  #isCancelled(): boolean {
    return this.#snapshot.state === "cancelled";
  }
}
