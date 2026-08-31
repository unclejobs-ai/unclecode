import type { RuntimeOwnerClient } from "@unclecode/server";
import { randomUUID } from "node:crypto";

type State = Readonly<Record<string, unknown>>;

// Client-local attachment health only. This overlay is never sent to the
// owner, persisted, or allowed to advance the authoritative owner revision.
type RemoteConnectionProjection = {
  readonly state: "disconnected" | "reconnecting";
  readonly attempt: number;
  readonly retryInMs: number;
};

export type RemoteWorkShellEngineOptions = {
  readonly reconnect?: ((input: {
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }) => Promise<RuntimeOwnerClient>) | undefined;
};

const POLL_INTERVAL_MS = 100;
const MAX_RECONNECT_DELAY_MS = 2_000;

// These methods may be replayed only with the same owner receipt identity.
// A pre-admission conflict can then refresh once, while a lost response
// resolves from the authoritative receipt without executing the method twice.
const SAFE_TRANSPORT_RETRY_METHODS = new Set([
  "setMode",
  "updateTerminalColumns",
  "updateTerminalRows",
  "closeOverlay",
  "toggleToolHistoryDisplay",
  "openAgentConsole",
  "closeAgentConsole",
  "selectAgentConsoleTab",
  "moveAgentConsoleCursor",
  "toggleAgentConsoleInspector",
]);

// A revision conflict is returned before admission, so handleSubmit may
// refresh and retry once with the same receipt identity. It must not be
// replayed after a transport failure because the owner may already have
// admitted the turn.
const SAFE_CONFLICT_RETRY_METHODS = new Set([
  ...SAFE_TRANSPORT_RETRY_METHODS,
  "handleSubmit",
]);

const PREEMPTIVE_CONTROL_METHODS = new Set([
  "interruptTurn",
  "requestTurnPause",
  "resumeTurn",
  "submitPendingDecisionText",
  "answerPendingDecisionByIndex",
  "cancelPendingDecision",
  "beginAgentSteer",
  "submitAgentSteer",
  "requestAgentCancel",
  "confirmAgentCancel",
  "continueSelectedAgent",
  "openAgentConsole",
  "closeAgentConsole",
  "selectAgentConsoleTab",
  "moveAgentConsoleCursor",
  "toggleAgentConsoleInspector",
]);

/**
 * Thin TUI projection over the owner process. Dispose detaches only this
 * polling subscriber; it never disposes the owner-held engine or active turn.
 */
export async function createRemoteWorkShellEngine(
  client: RuntimeOwnerClient,
  sessionId: string,
  options: RemoteWorkShellEngineOptions = {},
): Promise<object> {
  const initial = await client.readEngineState(sessionId);
  if (!initial.ok) throw new Error(initial.message);
  let ownerClient = client;
  let ownerState = initial.state as State;
  let state = ownerState;
  let revision = initial.revision;
  let stateRequestSequence = 0;
  let acceptedStateRequestSequence = 0;
  let readableRequestSequenceFloor = 0;
  const listeners = new Set<(state: State) => void>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let disposed = false;
  let reconnectAttempt = 0;
  let pollAbort: AbortController | undefined;
  const invocationAborts = new Set<AbortController>();
  let invocationTail: Promise<void> = Promise.resolve();
  let activeSubmitInvocations = 0;
  let agentControlFailure = false;

  const projectOwnerState = (next: State): State => {
    if (!agentControlFailure) return next;
    const view = next.agentConsoleView;
    if (!view || typeof view !== "object") return next;
    return {
      ...next,
      composerMode: "default",
      agentConsoleView: {
        ...(view as Readonly<Record<string, unknown>>),
        control: { kind: "browse" },
        receipt: {
          status: "rejected",
          message: "Agent control state changed. Try again.",
        },
      },
    };
  };

  const notify = (next: State) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const publish = (
    next: unknown,
    nextRevision: number,
    requestSequence: number,
    source: "read" | "mutation",
  ): boolean => {
    if (nextRevision < revision) return false;
    if (
      nextRevision === revision
      && source === "read"
      && (
        requestSequence <= acceptedStateRequestSequence
        || requestSequence < readableRequestSequenceFloor
      )
    ) {
      return false;
    }
    if (nextRevision > revision) {
      revision = nextRevision;
    }
    if (source === "mutation") {
      // A completed owner mutation is newer than every read already in flight,
      // even when the owner's durable admission revision is unchanged.
      readableRequestSequenceFloor = stateRequestSequence + 1;
    }
    acceptedStateRequestSequence = Math.max(acceptedStateRequestSequence, requestSequence);
    ownerState = next as State;
    notify(projectOwnerState(ownerState));
    return true;
  };
  const projectConnection = (connection: RemoteConnectionProjection) => {
    notify({ ...projectOwnerState(ownerState), remoteConnection: connection });
  };
  const readLatest = async (signal?: AbortSignal) => {
    const requestSequence = ++stateRequestSequence;
    const response = await ownerClient.readEngineState(
      sessionId,
      signal ? { signal } : undefined,
    );
    if (response.ok) publish(response.state, response.revision, requestSequence, "read");
    return response;
  };
  const reconnectDelay = () => Math.min(
    POLL_INTERVAL_MS * (2 ** Math.min(Math.max(reconnectAttempt - 1, 0), 30)),
    MAX_RECONNECT_DELAY_MS,
  );
  const refresh = async (): Promise<number> => {
    if (polling || disposed) return POLL_INTERVAL_MS;
    polling = true;
    const controller = new AbortController();
    pollAbort = controller;
    try {
      if (reconnectAttempt > 0 && options.reconnect) {
        const replacement = await options.reconnect({ sessionId, signal: controller.signal });
        if (controller.signal.aborted || disposed) return POLL_INTERVAL_MS;
        ownerClient = replacement;
      }
      const response = await readLatest(controller.signal);
      if (!response.ok) throw new Error(response.message);
      reconnectAttempt = 0;
      if (state.remoteConnection !== undefined) notify(projectOwnerState(ownerState));
      return POLL_INTERVAL_MS;
    } catch (error) {
      if (controller.signal.aborted || disposed) return POLL_INTERVAL_MS;
      reconnectAttempt += 1;
      const retryInMs = reconnectDelay();
      projectConnection({ state: "disconnected", attempt: reconnectAttempt, retryInMs });
      return retryInMs;
    } finally {
      if (pollAbort === controller) pollAbort = undefined;
      polling = false;
    }
  };
  const schedulePoll = (delayMs: number) => {
    if (disposed || listeners.size === 0 || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || listeners.size === 0) return;
      if (reconnectAttempt > 0) {
        projectConnection({ state: "reconnecting", attempt: reconnectAttempt, retryInMs: 0 });
      }
      void refresh().then(
        (nextDelayMs) => { schedulePoll(nextDelayMs); },
        () => { schedulePoll(MAX_RECONNECT_DELAY_MS); },
      );
    }, delayMs);
    timer.unref?.();
  };
  const invoke = async (method: string, args: readonly unknown[]) => {
    if (disposed) throw new Error("Remote runtime attachment is closed.");
    const idempotencyKey = randomUUID();
    const controller = new AbortController();
    invocationAborts.add(controller);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const request = {
          sessionId, method, args, expectedRevision: revision, idempotencyKey,
          signal: controller.signal,
        };
        let response: Awaited<ReturnType<RuntimeOwnerClient["invokeEngineMethod"]>>;
        for (let replayAttempt = 0; ; replayAttempt += 1) {
          const requestSequence = ++stateRequestSequence;
          try {
            response = await ownerClient.invokeEngineMethod(request);
          } catch (error) {
            if (
              controller.signal.aborted
              || replayAttempt > 0
              || !SAFE_TRANSPORT_RETRY_METHODS.has(method)
            ) throw error;
            continue;
          }
          if (response.ok) {
            if ("state" in response) {
              publish(response.state, response.revision, requestSequence, "mutation");
            } else {
              // The receipt is already authoritative and durable. Fence its
              // revision before refreshing the potentially large projection;
              // a failed refresh must never turn an accepted submit into an
              // apparent rejection that invites the user to send it twice.
              if (response.revision > revision) revision = response.revision;
              readableRequestSequenceFloor = stateRequestSequence + 1;
              acceptedStateRequestSequence = Math.max(acceptedStateRequestSequence, requestSequence);
              await readLatest(controller.signal).catch(() => undefined);
            }
          }
          break;
        }
        if (response.ok) {
          return response.result;
        }
        if (
          response.code !== "revision_conflict"
          || attempt > 0
          || !SAFE_CONFLICT_RETRY_METHODS.has(method)
        ) throw new Error(response.message);
        await readLatest(controller.signal);
      }
      throw new Error("Engine revision remained unstable after refresh.");
    } finally {
      invocationAborts.delete(controller);
    }
  };
  const invokeWithSubmitLifecycle = async (method: string, args: readonly unknown[]) => {
    if (method === "handleSubmit") activeSubmitInvocations += 1;
    try {
      return await invoke(method, args);
    } finally {
      if (method === "handleSubmit") activeSubmitInvocations -= 1;
    }
  };
  const scheduleInvoke = (method: string, args: readonly unknown[]) => {
    if (method === "beginAgentSteer" && agentControlFailure) {
      agentControlFailure = false;
      notify(ownerState);
    }
    // Only a follow-up for an authoritatively busy owner may bypass the
    // client mutation tail. Making every submit preemptive lets the initial
    // prompt race startup column/row mutations and exhaust its single safe
    // pre-admission conflict retry, which looks like an ignored Enter when
    // the Composer restores the rejected draft.
    const busySubmit = method === "handleSubmit"
      && (activeSubmitInvocations > 0 || ownerState.isBusy === true);
    const invocationArgs = method === "submitAgentSteer"
      ? [
          args[0],
          (ownerState.agentSteerTarget as { readonly agentRunId?: unknown } | undefined)?.agentRunId,
        ]
      : args;
    const scheduled = busySubmit || PREEMPTIVE_CONTROL_METHODS.has(method)
      ? invokeWithSubmitLifecycle(method, invocationArgs)
      : invocationTail.then(() => invokeWithSubmitLifecycle(method, invocationArgs));
    if (!busySubmit && !PREEMPTIVE_CONTROL_METHODS.has(method)) {
      invocationTail = scheduled.then(() => undefined, () => undefined);
    }
    if (method !== "beginAgentSteer") return scheduled;
    return scheduled.catch((error) => {
      // A semantic console action can legitimately lose its exact target to
      // an autonomous lifecycle update. Keep that rejection client-local,
      // bounded, and visible; never leak the owner error or let a discarded
      // Promise become an unhandled rejection in Ink's key handler.
      agentControlFailure = true;
      notify(projectOwnerState(ownerState));
      throw error;
    });
  };
  const target = {
    getSessionId: () => sessionId,
    getState: () => state,
    getTurnLifecycle: () => state.turnLifecycle ?? { state: "idle" },
    subscribe(listener: (state: State) => void) {
      listeners.add(listener);
      schedulePoll(POLL_INTERVAL_MS);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) { clearTimeout(timer); timer = undefined; }
      };
    },
    async initialize() { await refresh(); },
    dispose() {
      disposed = true;
      pollAbort?.abort();
      pollAbort = undefined;
      for (const controller of invocationAborts) {
        controller.abort(new Error("Remote runtime attachment closed."));
      }
      invocationAborts.clear();
      listeners.clear();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
  return new Proxy(target, {
    get(object, property, receiver) {
      // An async factory resolves its return value through Promise resolution.
      // Never let the dynamic RPC fallback make the proxy look like a thenable.
      if (property === "then") return undefined;
      if (typeof property !== "string" || property in object) return Reflect.get(object, property, receiver);
      return (...args: readonly unknown[]) => scheduleInvoke(property, args);
    },
  });
}
