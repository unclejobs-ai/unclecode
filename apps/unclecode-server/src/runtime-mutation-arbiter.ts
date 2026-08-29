export type RuntimeSessionRevisionClock = { value: number };

type MutationReceipt<Result> = {
  readonly fingerprint: string;
  readonly promise: Promise<Result>;
};

export class RuntimeSessionMutationArbiter {
  readonly clock: RuntimeSessionRevisionClock;
  readonly #receipts = new Map<string, MutationReceipt<unknown>>();
  #normalTail: Promise<void> = Promise.resolve();
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

  async settle(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const tail = this.#normalTail;
      const remaining = Math.max(0, deadline - Date.now());
      const tailSettled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining);
        tail.then(() => {
          clearTimeout(timer);
          resolve(true);
        }, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!tailSettled) return false;
      if (tail === this.#normalTail && this.#activeMutations === 0) return true;
    }
    return false;
  }

  mutate<Output, Result>(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly expectedRevision: number;
    readonly lane?: "normal" | "cancel" | undefined;
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

    let receipt!: MutationReceipt<Result>;
    const execute = async (): Promise<Result> => {
      if (this.clock.value !== input.expectedRevision) {
        if (this.#receipts.get(input.idempotencyKey) === receipt) {
          this.#receipts.delete(input.idempotencyKey);
        }
        return input.conflict(this.clock.value);
      }
      this.#activeMutations += 1;
      let output: Output | undefined;
      let failure: unknown;
      try {
        output = await input.execute();
      } catch (error) {
        failure = error;
      } finally {
        this.#activeMutations -= 1;
      }
      if (failure !== undefined || input.didMutate?.(output as Output) !== false) {
        this.clock.value += 1;
      }
      return failure === undefined
        ? input.complete(output as Output, this.clock.value)
        : input.fail(failure, this.clock.value);
    };

    const promise = input.lane === "cancel"
      ? execute()
      : this.#normalTail.then(execute);
    if (input.lane !== "cancel") {
      this.#normalTail = promise.then(() => undefined, () => undefined);
    }
    receipt = { fingerprint: input.fingerprint, promise };
    this.#receipts.set(input.idempotencyKey, receipt as MutationReceipt<unknown>);
    if (this.#receipts.size > 2_048) {
      const oldest = this.#receipts.keys().next().value as string | undefined;
      if (oldest && oldest !== input.idempotencyKey) this.#receipts.delete(oldest);
    }
    return promise;
  }
}
