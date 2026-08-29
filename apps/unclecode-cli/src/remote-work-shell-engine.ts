import type { RuntimeOwnerClient } from "@unclecode/server";
import { randomUUID } from "node:crypto";

type State = Readonly<Record<string, unknown>>;

const STABLE_CONFLICT_RETRY_METHODS = new Set([
  "setMode",
  "updateTerminalColumns",
  "updateTerminalRows",
  "closeOverlay",
]);

/**
 * Thin TUI projection over the owner process. Dispose detaches only this
 * polling subscriber; it never disposes the owner-held engine or active turn.
 */
export async function createRemoteWorkShellEngine(
  client: RuntimeOwnerClient,
  sessionId: string,
): Promise<object> {
  const initial = await client.readEngineState(sessionId);
  if (!initial.ok) throw new Error(initial.message);
  let state = initial.state as State;
  let revision = initial.revision;
  const listeners = new Set<(state: State) => void>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let disposed = false;
  let pollAbort: AbortController | undefined;
  let invocationAbort: AbortController | undefined;
  let invocationTail: Promise<void> = Promise.resolve();

  const publish = (next: unknown, nextRevision: number): boolean => {
    if (nextRevision <= revision) return false;
    revision = nextRevision;
    state = next as State;
    for (const listener of listeners) listener(state);
    return true;
  };
  const readLatest = async (signal?: AbortSignal) => {
    const response = await client.readEngineState(sessionId, signal ? { signal } : undefined);
    if (response.ok) publish(response.state, response.revision);
    return response;
  };
  const refresh = async () => {
    if (polling || disposed) return;
    polling = true;
    const controller = new AbortController();
    pollAbort = controller;
    try {
      await readLatest(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (pollAbort === controller) pollAbort = undefined;
      polling = false;
    }
  };
  const invoke = async (method: string, args: readonly unknown[]) => {
    if (disposed) throw new Error("Remote runtime attachment is closed.");
    const idempotencyKey = randomUUID();
    const controller = new AbortController();
    invocationAbort = controller;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await client.invokeEngineMethod({
          sessionId, method, args, expectedRevision: revision, idempotencyKey,
          signal: controller.signal,
        });
        if (response.ok) {
          publish(response.state, response.revision);
          return response.result;
        }
        if (
          response.code !== "revision_conflict"
          || attempt > 0
          || !STABLE_CONFLICT_RETRY_METHODS.has(method)
        ) throw new Error(response.message);
        await readLatest(controller.signal);
      }
      throw new Error("Engine revision remained unstable after refresh.");
    } finally {
      if (invocationAbort === controller) invocationAbort = undefined;
    }
  };
  const scheduleInvoke = (method: string, args: readonly unknown[]) => {
    const scheduled = invocationTail.then(() => invoke(method, args));
    invocationTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };
  const target = {
    getSessionId: () => sessionId,
    getState: () => state,
    getTurnLifecycle: () => state.turnLifecycle ?? { state: "idle" },
    subscribe(listener: (state: State) => void) {
      listeners.add(listener);
      if (!timer) {
        timer = setInterval(() => { void refresh(); }, 100);
        timer.unref?.();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) { clearInterval(timer); timer = undefined; }
      };
    },
    async initialize() { await refresh(); },
    dispose() {
      disposed = true;
      pollAbort?.abort();
      pollAbort = undefined;
      invocationAbort?.abort(new Error("Remote runtime attachment closed."));
      invocationAbort = undefined;
      listeners.clear();
      if (timer) clearInterval(timer);
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
