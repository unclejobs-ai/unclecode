import type { RuntimeOwnerClient } from "@unclecode/server";
import { randomUUID } from "node:crypto";

type State = Readonly<Record<string, unknown>>;

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
  let invocationTail: Promise<void> = Promise.resolve();

  const publish = (next: unknown, nextRevision: number) => {
    revision = nextRevision;
    state = next as State;
    for (const listener of listeners) listener(state);
  };
  const readLatest = async () => {
    const response = await client.readEngineState(sessionId);
    if (response.ok && response.revision !== revision) publish(response.state, response.revision);
    return response;
  };
  const refresh = async () => {
    if (polling) return;
    polling = true;
    try { await readLatest(); } finally { polling = false; }
  };
  const invoke = async (method: string, args: readonly unknown[]) => {
    const idempotencyKey = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await client.invokeEngineMethod({
        sessionId, method, args, expectedRevision: revision, idempotencyKey,
      });
      if (response.ok) {
        publish(response.state, response.revision);
        return response.result;
      }
      if (response.code !== "revision_conflict" || attempt > 0) throw new Error(response.message);
      await readLatest();
    }
    throw new Error("Engine revision remained unstable after refresh.");
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
