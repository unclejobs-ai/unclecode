import {
  canonicalMutationFingerprint,
  type LookupMutationResult,
  type RuntimeLedger,
} from "./runtime-ledger.js";

export type RuntimeSessionRevisionClock = { value: number };

type MutationReceipt<Result> = {
  readonly fingerprint: string;
  readonly promise: Promise<Result>;
  settled: boolean;
  accepted: boolean;
};

export type RuntimeMutationLane = "normal" | "control" | "cancel";

type PersistAcceptedRevision = (revision: number, signal: AbortSignal) => Promise<void>;

export type RuntimeMutationLedgerBinding = {
  readonly ledger: RuntimeLedger;
  readonly sessionId: string;
  readonly domain: string;
};

async function persistWithTimeout(
  persist: PersistAcceptedRevision,
  revision: number,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const abortController = new AbortController();
  try {
    await Promise.race([
      Promise.resolve().then(() => persist(revision, abortController.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            abortController.abort();
            reject(new Error(`Runtime admission persistence timed out after ${timeoutMs}ms.`));
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class RuntimeSessionMutationArbiter {
  readonly clock: RuntimeSessionRevisionClock;
  readonly #receipts = new Map<string, MutationReceipt<unknown>>();
  #admissionTail: Promise<void> = Promise.resolve();
  #cancelAdmissionTail: Promise<void> = Promise.resolve();
  #normalTail: Promise<void> = Promise.resolve();
  readonly #active = new Set<Promise<unknown>>();
  readonly #activeNormalGenerations = new Set<number>();
  #activeMutations = 0;
  readonly #persistAcceptedRevision: PersistAcceptedRevision | undefined;
  readonly #persistAcceptedRevisionTimeoutMs: number;
  readonly #ledgerBinding: RuntimeMutationLedgerBinding | undefined;

  constructor(clock: RuntimeSessionRevisionClock = { value: 0 }, input: {
    readonly persistAcceptedRevision?: PersistAcceptedRevision | undefined;
    readonly persistAcceptedRevisionTimeoutMs?: number | undefined;
    readonly ledger?: RuntimeLedger | undefined;
    readonly sessionId?: string | undefined;
    readonly domain?: string | undefined;
  } = {}) {
    this.clock = clock;
    this.#persistAcceptedRevision = input.persistAcceptedRevision;
    this.#persistAcceptedRevisionTimeoutMs = Number.isFinite(input.persistAcceptedRevisionTimeoutMs)
      ? Math.max(1, Math.floor(input.persistAcceptedRevisionTimeoutMs!))
      : 5_000;
    if (input.ledger) {
      if (!input.sessionId || !input.domain) {
        throw new TypeError("Runtime mutation ledger bindings require sessionId and domain.");
      }
      this.#ledgerBinding = { ledger: input.ledger, sessionId: input.sessionId, domain: input.domain };
      this.clock.value = input.ledger.seedSessionRevision(input.sessionId, this.clock.value);
    }
  }

  isMutationActive(): boolean {
    return this.#activeMutations > 0;
  }

  hasCancellableMutation(): boolean {
    return this.#activeNormalGenerations.size > 0;
  }

  publishAutonomous(): number {
    if (this.#activeMutations === 0) {
      const next = this.clock.value + 1;
      this.clock.value = this.#ledgerBinding
        ? this.#ledgerBinding.ledger.seedSessionRevision(this.#ledgerBinding.sessionId, next)
        : next;
    }
    return this.clock.value;
  }

  publishDurable(revision: number): number {
    if (Number.isSafeInteger(revision) && revision > this.clock.value) {
      this.clock.value = this.#ledgerBinding
        ? this.#ledgerBinding.ledger.seedSessionRevision(this.#ledgerBinding.sessionId, revision)
        : revision;
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
    readonly fingerprint: unknown;
    readonly expectedRevision: number;
    /**
     * Apply a view-only mutation to the latest projection even if autonomous
     * state advanced after the client rendered it. Never use for decisions,
     * execution, queue, policy, or other semantic mutations.
     */
    readonly acceptLatestRevision?: boolean | undefined;
    /**
     * Permit a stale semantic request only when its caller-owned identity is
     * still exact in the authoritative projection. Unlike the view-only flag,
     * this predicate must bind the target independently of the revision.
     */
    readonly acceptLatestRevisionWhen?: (() => boolean) | undefined;
    readonly lane?: RuntimeMutationLane | undefined;
    readonly bindsCancelGeneration?: boolean | undefined;
    readonly conflict: (revision: number) => Result;
    readonly invalidReuse: (revision: number) => Result;
    readonly onAdmitted?: ((revision: number) => void) | undefined;
    readonly precondition?: (() => Promise<Output | undefined> | Output | undefined) | undefined;
    readonly execute: () => Promise<Output> | Output;
    readonly didMutate?: ((output: Output) => boolean) | undefined;
    readonly complete: (output: Output, revision: number) => Result;
    readonly fail: (error: unknown, revision: number) => Result;
  }): Promise<Result> {
    let canonicalFingerprint: string;
    try {
      canonicalFingerprint = canonicalMutationFingerprint(input.fingerprint);
    } catch (error) {
      return Promise.resolve(input.fail(error, this.clock.value));
    }
    const prior = this.#receipts.get(input.idempotencyKey) as MutationReceipt<Result> | undefined;
    if (prior) {
      return prior.fingerprint === canonicalFingerprint
        ? prior.promise
        : Promise.resolve(input.invalidReuse(this.clock.value));
    }

    let receipt!: MutationReceipt<Result>;
    type Admission =
      | { readonly accepted: true; readonly revision: number }
      | { readonly accepted: false; readonly result: Result };

    const durableResult = (lookup: Exclude<LookupMutationResult, { kind: "miss" }>): Admission => {
      const ledgerRevision = this.#ledgerBinding?.ledger.getSessionState(this.#ledgerBinding.sessionId)?.revision
        ?? lookup.acceptedRevision;
      if (ledgerRevision > this.clock.value) this.clock.value = ledgerRevision;
      if (lookup.kind === "mismatch") {
        return { accepted: false, result: input.invalidReuse(this.clock.value) };
      }
      if ((lookup.status === "completed" || lookup.status === "failed") && "result" in lookup) {
        return { accepted: false, result: lookup.result as Result };
      }
      return {
        accepted: false,
        result: input.fail(
          new Error(`Runtime mutation receipt is ${lookup.status === "admitted" ? "in doubt" : lookup.status}; automatic re-execution is fenced.`),
          lookup.acceptedRevision,
        ),
      };
    };

    // Serialize only revision validation and durable publication. The lane is
    // released before engine execution, so a long provider/tool turn cannot
    // block pause, approval, steer, or cancel. Keeping clock publication after
    // persistence also prevents a later mutation from depending on a revision
    // that can still fail to become durable.
    const admission = this.#admissionTail.then(async (): Promise<Admission> => {
      if (this.#ledgerBinding) {
        try {
          const lookup = this.#ledgerBinding.ledger.lookupMutation({
            sessionId: this.#ledgerBinding.sessionId,
            domain: this.#ledgerBinding.domain,
            idempotencyKey: input.idempotencyKey,
            fingerprint: input.fingerprint,
          });
          if (lookup.kind !== "miss") return durableResult(lookup);
        } catch (error) {
          return { accepted: false, result: input.fail(error, this.clock.value) };
        }
      }
      const oldestActiveNormalGeneration = this.#activeNormalGenerations.size === 0
        ? undefined
        : Math.min(...this.#activeNormalGenerations);
      const stalePreemptiveCancel = input.lane === "cancel"
        && oldestActiveNormalGeneration !== undefined
        && Number.isSafeInteger(input.expectedRevision)
        && input.expectedRevision >= 0
        && input.expectedRevision < this.clock.value
        && input.expectedRevision + 1 >= oldestActiveNormalGeneration;
      let acceptsLatestIdentity = false;
      if (
        this.clock.value !== input.expectedRevision
        && input.acceptLatestRevision !== true
        && input.acceptLatestRevisionWhen
      ) {
        try {
          acceptsLatestIdentity = input.acceptLatestRevisionWhen();
        } catch (error) {
          return { accepted: false, result: input.fail(error, this.clock.value) };
        }
      }
      if (
        this.clock.value !== input.expectedRevision
        && !stalePreemptiveCancel
        && input.acceptLatestRevision !== true
        && !acceptsLatestIdentity
      ) {
        return { accepted: false, result: input.conflict(this.clock.value) };
      }

      if (input.precondition) {
        try {
          const preconditionOutput = await input.precondition();
          if (preconditionOutput !== undefined && input.didMutate?.(preconditionOutput) === false) {
            return {
              accepted: false,
              result: input.complete(preconditionOutput, this.clock.value),
            };
          }
        } catch (error) {
          return { accepted: false, result: input.fail(error, this.clock.value) };
        }
      }

      let acceptedRevision = this.clock.value + 1;
      try {
        if (this.#ledgerBinding) {
          const admitted = this.#ledgerBinding.ledger.admitMutation({
            sessionId: this.#ledgerBinding.sessionId,
            domain: this.#ledgerBinding.domain,
            idempotencyKey: input.idempotencyKey,
            fingerprint: input.fingerprint,
          });
          if (admitted.kind !== "admitted") return durableResult(admitted);
          acceptedRevision = admitted.acceptedRevision;
        } else if (this.#persistAcceptedRevision) {
          await persistWithTimeout(
            this.#persistAcceptedRevision,
            acceptedRevision,
            this.#persistAcceptedRevisionTimeoutMs,
          );
        }
      } catch (error) {
        return { accepted: false, result: input.fail(error, this.clock.value) };
      }
      this.clock.value = acceptedRevision;
      this.#activeMutations += 1;
      if (input.lane === "normal" || input.lane === undefined || input.bindsCancelGeneration === true) {
        this.#activeNormalGenerations.add(acceptedRevision);
      }
      receipt.accepted = true;
      input.onAdmitted?.(acceptedRevision);
      return { accepted: true, revision: acceptedRevision };
    });
    this.#admissionTail = admission.then(() => undefined, () => undefined);
    if (input.lane === "cancel") {
      this.#cancelAdmissionTail = admission.then(() => undefined, () => undefined);
    }

    const execute = async (acceptedRevision: number): Promise<Result> => {
      let output: Output | undefined;
      let failure: unknown;
      try {
        output = await input.execute();
      } catch (error) {
        failure = error;
      } finally {
        this.#activeMutations -= 1;
        if (input.lane === "normal" || input.lane === undefined || input.bindsCancelGeneration === true) {
          this.#activeNormalGenerations.delete(acceptedRevision);
        }
      }
      let result: Result;
      let status: "completed" | "failed";
      try {
        if (failure === undefined) {
          result = input.complete(output as Output, acceptedRevision);
          status = "completed";
        } else {
          result = input.fail(failure, acceptedRevision);
          status = "failed";
        }
      } catch (error) {
        result = input.fail(error, acceptedRevision);
        status = "failed";
      }
      if (this.#ledgerBinding) {
        try {
          this.#ledgerBinding.ledger.completeMutation({
            sessionId: this.#ledgerBinding.sessionId,
            domain: this.#ledgerBinding.domain,
            idempotencyKey: input.idempotencyKey,
            status,
            result,
          });
        } catch (error) {
          return input.fail(error, acceptedRevision);
        }
      }
      return result;
    };

    const runAdmitted = async (): Promise<Result> => {
      const outcome = await admission;
      if (!outcome.accepted) return outcome.result;
      if (input.lane === "normal" || input.lane === undefined) {
        // A cancel already queued while this mutation was becoming durable
        // must consume the admitted turn before provider/tool work begins.
        // Snapshot only the cancel tail: pause/steer remain safe-boundary
        // controls and do not delay normal execution unnecessarily.
        await this.#cancelAdmissionTail;
      }
      return execute(outcome.revision);
    };
    const admitted = input.lane === "normal" || input.lane === undefined
      ? this.#normalTail.then(runAdmitted)
      : Promise.resolve().then(runAdmitted);
    if (input.lane === "normal" || input.lane === undefined) {
      this.#normalTail = admitted.then(() => undefined, () => undefined);
    }
    receipt = { fingerprint: canonicalFingerprint, promise: admitted, settled: false, accepted: false };
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
