const EMPTY = Object.freeze({
  status: "idle",
  connection: "offline",
  data: null,
  error: null,
  actions: Object.freeze({}),
});

function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

export function parseSseFrames(buffer) {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = [];
  for (const block of blocks) {
    if (block.startsWith(":")) continue;
    let id;
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = Number.parseInt(line.slice(3).trim(), 10);
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!Number.isSafeInteger(id) || data.length === 0) continue;
    try {
      events.push({ id, event, data: JSON.parse(data.join("\n")) });
    } catch {
      // A malformed external event is ignored; the next projection refresh is authoritative.
    }
  }
  return { events, rest };
}

export function createControlRoomStore(options) {
  const baseUrl = String(options.baseUrl ?? "").replace(/\/$/, "");
  const token = String(options.token ?? "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const connectEvents = options.connectEvents !== false;
  const listeners = new Set();
  let snapshot = EMPTY;
  let startPromise = null;
  let stopped = false;
  let eventAbort = null;
  let reconnectTimer = null;
  let refreshQueued = false;
  let activeSessionId = null;
  const lastEventIds = new Map();
  const retryKeys = new Map();

  const emit = next => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };

  const authHeaders = extra => ({ authorization: `Bearer ${token}`, ...extra });

  const load = async () => {
    if (!token) {
      emit({ ...snapshot, status: "error", connection: "offline", error: "Server token is not configured." });
      return snapshot;
    }
    emit({ ...snapshot, status: snapshot.data ? "ready" : "loading", error: null });
    try {
      const response = await fetchImpl(`${baseUrl}/control-room`, { headers: authHeaders({ accept: "application/json" }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? `Control room returned ${response.status}.`);
      const activeRunIds = new Set((body?.runs ?? []).map(run => run.id));
      const actions = Object.fromEntries(Object.entries(snapshot.actions).filter(([sessionId]) => activeRunIds.has(sessionId)));
      for (const sessionId of retryKeys.keys()) if (!activeRunIds.has(sessionId)) retryKeys.delete(sessionId);
      emit({ ...snapshot, status: "ready", connection: snapshot.connection === "live" ? "live" : "connecting", data: body, actions, error: null });
      return snapshot;
    } catch (error) {
      emit({ ...snapshot, status: snapshot.data ? "ready" : "error", connection: "offline", error: error instanceof Error ? error.message : String(error) });
      return snapshot;
    }
  };

  const queueRefresh = () => {
    if (refreshQueued || stopped) return;
    refreshQueued = true;
    queueMicrotask(async () => {
      refreshQueued = false;
      await load();
    });
  };

  const connect = async () => {
    const runs = snapshot.data?.runs ?? [];
    const sessionId = runs.some(run => run.id === activeSessionId)
      ? activeSessionId
      : runs[0]?.id;
    if (!connectEvents || !sessionId || stopped) return;
    activeSessionId = sessionId;
    eventAbort?.abort();
    const controller = new AbortController();
    eventAbort = controller;
    const lastEventId = lastEventIds.get(sessionId) ?? 0;
    emit({ ...snapshot, connection: "connecting" });
    try {
      const response = await fetchImpl(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`, {
        headers: authHeaders({ accept: "text/event-stream", ...(lastEventId > 0 ? { "last-event-id": String(lastEventId) } : {}) }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        lastEventIds.delete(sessionId);
        await load();
        if (!stopped && eventAbort === controller) reconnectTimer = setTimeout(() => void connect(), 0);
        return;
      }
      if (!response.ok || !response.body) throw new Error(`Event stream returned ${response.status}.`);
      emit({ ...snapshot, connection: "live", error: null });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_CHARS) throw new Error("Event stream frame exceeded the client buffer limit.");
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          const cursor = lastEventIds.get(sessionId) ?? 0;
          if (event.id <= cursor) continue;
          lastEventIds.set(sessionId, event.id);
          queueRefresh();
        }
      }
      if (!stopped) throw new Error("Event stream disconnected.");
    } catch (error) {
      if (stopped || controller.signal.aborted || eventAbort !== controller) return;
      emit({ ...snapshot, connection: "offline", error: error instanceof Error ? error.message : String(error) });
      reconnectTimer = setTimeout(() => void connect(), 1_000);
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    async start() {
      if (startPromise) return startPromise;
      stopped = false;
      startPromise = (async () => {
        await load();
        if (snapshot.status === "ready") void connect();
        return snapshot;
      })();
      return startPromise;
    },
    stop() {
      stopped = true;
      eventAbort?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      startPromise = null;
      emit({ ...snapshot, connection: "offline" });
    },
    refresh: load,
    selectSession(sessionId) {
      const next = String(sessionId ?? "");
      if (!next || next === activeSessionId) return;
      activeSessionId = next;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      eventAbort?.abort();
      if (!stopped) void connect();
    },
    async action(sessionId, action, expectedRevision, payload) {
      const current = snapshot.actions[sessionId];
      if (current?.status === "pending") return { ok: false, code: "pending", message: "An action is already pending." };
      const actions = { ...snapshot.actions, [sessionId]: { status: "pending", action } };
      emit({ ...snapshot, actions });
      const fingerprint = JSON.stringify({ action, expectedRevision, payload: payload ?? null });
      const retry = retryKeys.get(sessionId);
      const requestKey = retry?.fingerprint === fingerprint ? retry.key : idempotencyKey();
      try {
        const response = await fetchImpl(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/actions/${action}`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json", "idempotency-key": requestKey }),
          body: JSON.stringify({ expectedRevision, ...(payload ? { payload } : {}) }),
        });
        const result = await response.json();
        retryKeys.delete(sessionId);
        const status = response.ok ? "success" : response.status === 409 ? "conflict" : response.status === 403 ? "denied" : "error";
        emit({ ...snapshot, actions: { ...snapshot.actions, [sessionId]: { status, action, message: result.message ?? result.error?.message } } });
        if (response.ok) await load();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The server may have applied a request whose response was lost. An
        // exact retry must reuse the same key instead of executing it twice.
        retryKeys.set(sessionId, { fingerprint, key: requestKey });
        emit({ ...snapshot, actions: { ...snapshot.actions, [sessionId]: { status: "error", action, message } } });
        return { ok: false, code: "network_error", message };
      }
    },
  };
}
