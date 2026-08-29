export type RuntimeSessionRevisionClock = { value: number };

type MutationReceipt<Result> = {
  readonly fingerprint: string;
  readonly promise: Promise<Result>;
  settled: boolean;
  accepted: boolean;
};

export type RuntimeMutationLane = "normal" | "control" | "cancel";

export class RuntimeSessionMutationArbiter {
  readonly clock: RuntimeSessionRevisionClock;
  readonly #receipts = new Map<string, MutationReceipt<unknown>>();
  #admissionTail: Promise<void> = Promise.resolve();
  #normalTail: Promise<void> = Promise.resolve();
  readonly #active = new Set<Promise<unknown>>();
  #activeMutations = 0;
  readonly #persistAcceptedRevision: ((revision: number) => Promise<void>) | undefined;

  constructor(clock: RuntimeSessionRevisionClock = { value: 0 }, input: {
    readonly persistAcceptedRevision?: ((revision: number) => Promise<void>) | undefined;
  } = {}) {
    this.clock = clock;
    this.#persistAcceptedRevision = input.persistAcceptedRevision;
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
    readonly onAdmitted?: ((revision: number) => void) | undefined;
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
    type Admission =
      | { readonly accepted: true; readonly revision: number }
      | { readonly accepted: false; readonly result: Result };

    // Serialize only revision validation and durable publication. The lane is
    // released before engine execution, so a long provider/tool turn cannot
    // block pause, approval, steer, or cancel. Keeping clock publication after
    // persistence also prevents a later mutation from depending on a revision
    // that can still fail to become durable.
    const admission = this.#admissionTail.then(async (): Promise<Admission> => {
      const stalePreemptiveCancel = input.lane === "cancel"
        && this.#activeMutations > 0
        && Number.isSafeInteger(input.expectedRevision)
        && input.expectedRevision >= 0
        && input.expectedRevision < this.clock.value;
      if (this.clock.value !== input.expectedRevision && !stalePreemptiveCancel) {
        return { accepted: false, result: input.conflict(this.clock.value) };
      }

      const acceptedRevision = this.clock.value + 1;
      try {
        await this.#persistAcceptedRevision?.(acceptedRevision);
      } catch (error) {
        return { accepted: false, result: input.fail(error, this.clock.value) };
      }
      this.clock.value = acceptedRevision;
      this.#activeMutations += 1;
      receipt.accepted = true;
      input.onAdmitted?.(acceptedRevision);
      return { accepted: true, revision: acceptedRevision };
    });
    this.#admissionTail = admission.then(() => undefined, () => undefined);

    const execute = async (acceptedRevision: number): Promise<Result> => {
      let output: Output | undefined;
      let failure: unknown;
      try {
        output = await input.execute();
      } catch (error) {
        failure = error;
      } finally {
        this.#activeMutations -= 1;
      }
      return failure === undefined
        ? input.complete(output as Output, acceptedRevision)
        : input.fail(failure, acceptedRevision);
    };

    const runAdmitted = async (): Promise<Result> => {
      const outcome = await admission;
      return outcome.accepted ? execute(outcome.revision) : outcome.result;
    };
    const admitted = input.lane === "normal" || input.lane === undefined
      ? this.#normalTail.then(runAdmitted)
      : Promise.resolve().then(runAdmitted);
    if (input.lane === "normal" || input.lane === undefined) {
      this.#normalTail = admitted.then(() => undefined, () => undefined);
    }
    receipt = { fingerprint: input.fingerprint, promise: admitted, settled: false, accepted: false };
    this.#receipts.set(input.idempotencyKey, receipt as MutationReceipt<unknown>);
    this.#active.add(admitted);
    void admitted.finally(() => {
      receipt.settled = true;
      this.#active.delete(admitted);
      if (!receipt.accepted && this.#receipts.get(input.idempotencyKey) === receipt) {
        this.#receipts.delete(input.idempotencyKey);
      }
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
