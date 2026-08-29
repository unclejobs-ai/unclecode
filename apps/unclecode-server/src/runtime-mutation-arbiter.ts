export type RuntimeSessionRevisionClock = { value: number };

type MutationReceipt<Result> = {
  readonly fingerprint: string;
  readonly promise: Promise<Result>;
  settled: boolean;
};

export type RuntimeMutationLane = "normal" | "control" | "cancel";

export class RuntimeSessionMutationArbiter {
  readonly clock: RuntimeSessionRevisionClock;
  readonly #receipts = new Map<string, MutationReceipt<unknown>>();
  #normalTail: Promise<void> = Promise.resolve();
  readonly #active = new Set<Promise<unknown>>();
  #activeMutations = 0;

  constructor(clock: RuntimeSessionRevisionClock = { value: 0 }) {
    this.clock = clock;
  }

  isMutationActive(): boolean {
    return this.#activeMutations > 0;
  }

  publishAutonomous(): number {
    if (this.#activeMutations === 0) this.clock.value += 1;
    return this.clock.value;
  }

  publishDurable(revision: number): number {
    if (Number.isSafeInteger(revision) && revision > this.clock.value) {
      this.clock.value = revision;
    }
    return this.clock.value;
  }

  async settle(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const active = [...this.#active];
      if (active.length === 0) return true;
      const remaining = Math.max(0, deadline - Date.now());
      const activeSettled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining);
        Promise.allSettled(active).then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!activeSettled) return false;
      if (this.#active.size === 0 && this.#activeMutations === 0) return true;
    }
    return false;
  }

  mutate<Output, Result>(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly expectedRevision: number;
    readonly lane?: RuntimeMutationLane | undefined;
    readonly conflict: (revision: number) => Result;
    readonly invalidReuse: (revision: number) => Result;
    readonly execute: () => Promise<Output> | Output;
    readonly didMutate?: ((output: Output) => boolean) | undefined;
    readonly complete: (output: Output, revision: number) => Result;
    readonly fail: (error: unknown, revision: number) => Result;
  }): Promise<Result> {
    const prior = this.#receipts.get(input.idempotencyKey) as MutationReceipt<Result> | undefined;
    if (prior) {
      return prior.fingerprint === input.fingerprint
        ? prior.promise
        : Promise.resolve(input.invalidReuse(this.clock.value));
    }

    const stalePreemptiveCancel = input.lane === "cancel"
      && this.#activeMutations > 0
      && input.expectedRevision === this.clock.value - 1;
    if (this.clock.value !== input.expectedRevision && !stalePreemptiveCancel) {
      return Promise.resolve(input.conflict(this.clock.value));
    }

    // Admission is the only atomic section. Reserve the accepted revision
    // synchronously, install the pending receipt, then run the potentially
    // long operation outside that section. Normal mutations retain execution
    // ordering; lifecycle controls and cancellation can reach an active turn.
    const acceptedRevision = this.clock.value + 1;
    this.clock.value = acceptedRevision;
    this.#activeMutations += 1;

    let receipt!: MutationReceipt<Result>;
    const execute = async (): Promise<Result> => {
      let output: Output | undefined;
      let failure: unknown;
      try {
        output = await input.execute();
      } catch (error) {
        failure = error;
      } finally {
        this.#activeMutations -= 1;
      }
      const mutated = failure !== undefined || input.didMutate?.(output as Output) !== false;
      if (!mutated && this.clock.value === acceptedRevision) {
        this.clock.value = acceptedRevision - 1;
      }
      return failure === undefined
        ? input.complete(output as Output, mutated ? acceptedRevision : this.clock.value)
        : input.fail(failure, acceptedRevision);
    };

    const admitted = input.lane === "normal" || input.lane === undefined
      ? this.#normalTail.then(execute)
      : Promise.resolve().then(execute);
    if (input.lane === "normal" || input.lane === undefined) {
      this.#normalTail = admitted.then(() => undefined, () => undefined);
    }
    receipt = { fingerprint: input.fingerprint, promise: admitted, settled: false };
    this.#receipts.set(input.idempotencyKey, receipt as MutationReceipt<unknown>);
    this.#active.add(admitted);
    void admitted.finally(() => {
      receipt.settled = true;
      this.#active.delete(admitted);
      if (this.#receipts.size > 2_048) {
        for (const [key, candidate] of this.#receipts) {
          if (candidate.settled && key !== input.idempotencyKey) {
            this.#receipts.delete(key);
            break;
          }
        }
      }
    });
    return admitted;
  }
}
