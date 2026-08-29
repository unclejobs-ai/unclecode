import { createControlRoomProjection, type ControlRoomProjection, type RuntimeReadSource } from "./control-room.js";
import { canonicalMutationFingerprint } from "./runtime-ledger.js";

export const CONTROL_ACTIONS = ["pause", "resume", "cancel", "approve", "steer", "follow-up"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export type RuntimeControlRequest = {
  readonly sessionId: string;
  readonly action: ControlAction;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly payload?: Readonly<Record<string, unknown>>;
};

export type RuntimeControlResult =
  | { readonly ok: true; readonly revision: number; readonly state: string; readonly receiptId?: string }
  | { readonly ok: false; readonly code: "not_found" | "revision_conflict" | "not_attached" | "denied" | "invalid_action"; readonly message: string; readonly revision?: number };

export type RuntimeControlPort = {
  control(input: RuntimeControlRequest): Promise<RuntimeControlResult>;
};

export type RuntimeAdapter = {
  read(): Promise<RuntimeReadSource>;
  readProjection(): Promise<ControlRoomProjection>;
  control(input: RuntimeControlRequest): Promise<RuntimeControlResult>;
};

export function createRuntimeAdapter(input: {
  readonly read: () => Promise<RuntimeReadSource>;
  readonly controls: RuntimeControlPort;
  readonly maxIdempotencyEntries?: number;
}): RuntimeAdapter {
  const maxEntries = Math.max(16, Math.min(input.maxIdempotencyEntries ?? 2_048, 20_000));
  type Receipt = { readonly fingerprint: string; readonly result: RuntimeControlResult };
  type PendingReceipt = { readonly fingerprint: string; readonly result: Promise<RuntimeControlResult> };
  const receipts = new Map<string, Receipt>();
  const pendingReceipts = new Map<string, PendingReceipt>();
  const lifecycleTransitionTails = new Map<string, Promise<void>>();

  const fingerprint = (request: RuntimeControlRequest): string => canonicalMutationFingerprint({
    action: request.action,
    expectedRevision: request.expectedRevision,
    payload: request.payload ?? null,
  });

  const mismatch = (): RuntimeControlResult => ({
    ok: false,
    code: "invalid_action",
    message: "Idempotency-Key was already used for a different request.",
  });

  const remember = (key: string, value: Receipt): void => {
    receipts.set(key, value);
    if (receipts.size > maxEntries) receipts.delete(receipts.keys().next().value as string);
  };

  const execute = async (request: RuntimeControlRequest): Promise<RuntimeControlResult> => {
    const source = await input.read();
    const session = source.sessions.find(item => item.sessionId === request.sessionId);
    if (!session) return { ok: false, code: "not_found", message: "Unknown session." };
    // A targeted cancel is admitted against the immutable turn generation by
    // the owner arbiter, so a stale projection must not reject it here. Other
    // controls retain this cheap boundary check before reaching test doubles or
    // legacy control ports that do not own an arbiter.
    if (request.action !== "cancel" && session.revision !== request.expectedRevision) {
      return {
        ok: false,
        code: "revision_conflict",
        message: "Session revision changed.",
        revision: session.revision,
      };
    }
    return await input.controls.control(request);
  };

  return {
    read: input.read,
    async readProjection() {
      return createControlRoomProjection(await input.read());
    },
    async control(request) {
      const receiptKey = `${request.sessionId}\u0000${request.idempotencyKey}`;
      const requestFingerprint = fingerprint(request);
      const cached = receipts.get(receiptKey);
      if (cached) return cached.fingerprint === requestFingerprint ? cached.result : mismatch();
      const pending = pendingReceipts.get(receiptKey);
      if (pending) return pending.fingerprint === requestFingerprint ? pending.result : mismatch();

      // The owner-side RuntimeSessionMutationArbiter is the single revision
      // and execution authority. Only mutually dependent pause/resume
      // transitions retain local ordering. Cancel, approval, steer, follow-up,
      // and pause relative to an active turn never wait on an adapter-wide tail.
      const ordersLifecycleTransition = request.action === "pause" || request.action === "resume";
      const prior = lifecycleTransitionTails.get(request.sessionId) ?? Promise.resolve();
      const result = ordersLifecycleTransition
        ? prior.catch(() => undefined).then(() => execute(request))
        : execute(request);
      pendingReceipts.set(receiptKey, { fingerprint: requestFingerprint, result });
      if (ordersLifecycleTransition) {
        const tail = result.then(() => undefined, () => undefined);
        lifecycleTransitionTails.set(request.sessionId, tail);
        void tail.finally(() => {
          if (lifecycleTransitionTails.get(request.sessionId) === tail) {
            lifecycleTransitionTails.delete(request.sessionId);
          }
        });
      }
      try {
        const settled = await result;
        remember(receiptKey, { fingerprint: requestFingerprint, result: settled });
        return settled;
      } finally {
        if (pendingReceipts.get(receiptKey)?.result === result) pendingReceipts.delete(receiptKey);
      }
    },
  };
}
