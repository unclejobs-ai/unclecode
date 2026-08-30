import { DEFAULT_CONTROL_ROOM_URL } from './runtime-bootstrap.js'

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'cancel', 'approve', 'decision', 'steer', 'follow-up'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * @typedef {object} ControlRoomSnapshot
 * @property {'idle' | 'auth_required' | 'loading' | 'ready' | 'error'} status
 * @property {'ready' | 'required'} auth
 * @property {string} serverUrl
 * @property {'offline' | 'connecting' | 'live'} connection
 * @property {any} data
 * @property {string | null} error
 * @property {Readonly<Record<string, { status: string, action?: string, message?: string }>>} actions
 */

function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
const CONTROL_ROOM_DISCOVERY_INTERVAL_MS = 1_000;
const CONTROL_ROOM_READ_TIMEOUT_MS = 5_000;

export function normalizeLoopbackServerUrl(value) {
  let url
  try {
    url = new URL(String(value || DEFAULT_CONTROL_ROOM_URL))
  } catch {
    throw new Error('Control Room server URL is not valid.')
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash) {
    throw new Error('Control Room credentials can only be sent to a loopback HTTP(S) origin.')
  }
  return url.origin
}

export function parseSseFrames(buffer) {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = [];
  for (const block of blocks) {
    if (block.startsWith(":")) continue;
    let id;
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) {
        const rawId = line.slice(3).trim();
        if (/^(?:0|[1-9]\d*)$/.test(rawId)) id = Number(rawId);
      }
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

export function createControlRoomStore(options = {}) {
  let baseUrl
  let configurationError = null
  try {
    baseUrl = normalizeLoopbackServerUrl(options.baseUrl)
  } catch (error) {
    baseUrl = DEFAULT_CONTROL_ROOM_URL
    configurationError = error instanceof Error ? error.message : String(error)
  }
  let token = String(options.token ?? "").trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const connectEvents = options.connectEvents !== false;
  const listeners = new Set();
  /** @type {ControlRoomSnapshot} */
  let snapshot = Object.freeze({
    status: token && !configurationError ? "idle" : "auth_required",
    auth: token && !configurationError ? "ready" : "required",
    serverUrl: baseUrl,
    connection: "offline",
    data: null,
    error: configurationError,
    actions: Object.freeze({}),
  });
  let startPromise = null;
  let stopped = false;
  let eventAbort = null;
  let eventReader = null;
  let eventSessionId = null;
  let eventStreamLive = false;
  let blockedEventSessionId = null;
  let blockedEventError = null;
  let reconnectTimer = null;
  let discoveryTimer = null;
  let refreshQueued = false;
  let activeSessionId = null;
  let credentialGeneration = 0;
  let lifecycleGeneration = 0;
  let projectionRequest = null;
  const actionControllers = new Set();
  const lastEventIds = new Map();
  const retryKeys = new Map();

  /** @param {ControlRoomSnapshot} next */
  const emit = next => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };

  const authHeaders = extra => ({ authorization: `Bearer ${token}`, ...extra });

  const readBody = async response => {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  const abortProjectionRead = () => {
    const request = projectionRequest;
    projectionRequest = null;
    if (request?.timeout) clearTimeout(request.timeout);
    request?.controller.abort(new Error("Control room projection read cancelled."));
  };

  const abortActionRequests = () => {
    for (const controller of actionControllers) {
      controller.abort(new Error("Control room action cancelled."));
    }
    actionControllers.clear();
  };

  const advanceLifecycle = () => {
    lifecycleGeneration += 1;
    abortProjectionRead();
    abortActionRequests();
  };

  const requireAuthentication = message => {
    credentialGeneration += 1
    token = ""
    advanceLifecycle()
    disconnectEventStream()
    clearConnectionTimers()
    emit({
      ...snapshot,
      status: "auth_required",
      auth: "required",
      connection: "offline",
      data: null,
      error: message,
      actions: Object.freeze({}),
    })
  }

  const load = async () => {
    if (stopped) return snapshot;
    if (!token) {
      emit({ ...snapshot, status: "auth_required", auth: "required", connection: "offline", error: snapshot.error });
      return snapshot;
    }
    const activeRequest = projectionRequest;
    if (activeRequest
      && activeRequest.lifecycleGeneration === lifecycleGeneration
      && activeRequest.credentialGeneration === credentialGeneration) {
      return activeRequest.promise;
    }

    const controller = new AbortController();
    const request = {
      lifecycleGeneration,
      credentialGeneration,
      controller,
      timedOut: false,
      timeout: null,
      promise: null,
    };
    const isCurrent = () => projectionRequest === request
      && request.lifecycleGeneration === lifecycleGeneration
      && request.credentialGeneration === credentialGeneration;
    let rejectAbort;
    request.promise = (async () => {
      await Promise.resolve();
      try {
        if (!isCurrent() || stopped) return snapshot;
        const abortPromise = new Promise((_, reject) => {
          rejectAbort = () => reject(controller.signal.reason);
          if (controller.signal.aborted) rejectAbort();
          else controller.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        request.timeout = setTimeout(() => {
          request.timedOut = true;
          controller.abort(new Error("Control room projection read timed out."));
        }, CONTROL_ROOM_READ_TIMEOUT_MS);
        const operation = Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          const response = await fetchImpl(`${baseUrl}/control-room`, {
            headers: authHeaders({ accept: "application/json" }),
            signal: controller.signal,
            redirect: "error",
          });
          return { response, body: await readBody(response) };
        });
        const responsePromise = Promise.race([operation, abortPromise]);
        emit({ ...snapshot, status: snapshot.data ? "ready" : "loading", auth: "ready", error: null });
        const { response, body } = await responsePromise;
        if (!isCurrent() || stopped) return snapshot;
        if (response.status === 401) {
          requireAuthentication(body?.error?.message ?? "The server token was rejected.")
          return snapshot
        }
        if (!response.ok) throw new Error(body?.error?.message ?? `Control room returned ${response.status}.`);
        const activeRunIds = new Set((body?.runs ?? []).map(run => run.id));
        const actions = Object.fromEntries(Object.entries(snapshot.actions).filter(([sessionId]) => activeRunIds.has(sessionId)));
        for (const sessionId of retryKeys.keys()) if (!activeRunIds.has(sessionId)) retryKeys.delete(sessionId);
        for (const sessionId of lastEventIds.keys()) if (!activeRunIds.has(sessionId)) lastEventIds.delete(sessionId);
        if (blockedEventSessionId && !activeRunIds.has(blockedEventSessionId)) {
          blockedEventSessionId = null;
          blockedEventError = null;
        }
        emit({
          ...snapshot,
          status: "ready",
          auth: "ready",
          connection: connectEvents
            ? eventStreamLive
              ? "live"
              : blockedEventSessionId
                ? "offline"
                : "connecting"
            : "offline",
          data: body,
          actions,
          error: blockedEventSessionId ? blockedEventError : null,
        });
        return snapshot;
      } catch (error) {
        if (!isCurrent() || stopped) return snapshot;
        const message = request.timedOut
          ? "Control room projection read timed out."
          : error instanceof Error ? error.message : String(error);
        emit({ ...snapshot, status: snapshot.data ? "ready" : "error", connection: eventStreamLive ? "live" : "offline", error: message });
        return snapshot;
      } finally {
        if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
        if (request.timeout) clearTimeout(request.timeout);
        request.timeout = null;
        if (projectionRequest === request) projectionRequest = null;
      }
    })();
    projectionRequest = request;
    return request.promise;
  };

  const queueRefresh = () => {
    if (refreshQueued || stopped) return;
    refreshQueued = true;
    queueMicrotask(async () => {
      refreshQueued = false;
      if (stopped) return;
      const result = await load();
      if (result.status === "ready") void connect();
    });
  };

  const clearConnectionTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (discoveryTimer) clearTimeout(discoveryTimer);
    reconnectTimer = null;
    discoveryTimer = null;
  };

  const disconnectEventStream = () => {
    eventAbort?.abort();
    eventAbort = null;
    eventSessionId = null;
    eventStreamLive = false;
    const reader = eventReader;
    eventReader = null;
    if (reader) void reader.cancel().catch(() => {});
  };

  const connect = async (allowExpiredRecovery = true) => {
    const runs = snapshot.data?.runs ?? [];
    const sessionId = runs.some(run => run.id === activeSessionId)
      ? activeSessionId
      : runs[0]?.id;
    if (!connectEvents || stopped) return;
    if (!sessionId) {
      disconnectEventStream();
      return;
    }
    if (blockedEventSessionId === sessionId) return;
    if (eventAbort && eventSessionId === sessionId) return;
    activeSessionId = sessionId;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    disconnectEventStream();
    const controller = new AbortController();
    eventAbort = controller;
    eventSessionId = sessionId;
    const lastEventId = lastEventIds.get(sessionId) ?? 0;
    emit({ ...snapshot, connection: "connecting" });
    let reader = null;
    let retryable = true;
    try {
      const response = await fetchImpl(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`, {
        headers: authHeaders({ accept: "text/event-stream", ...(lastEventId > 0 ? { "last-event-id": String(lastEventId) } : {}) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401) {
        requireAuthentication("The server token expired or was rotated.")
        return
      }
      if (response.status === 409) {
        const body = await response.json().catch(() => null);
        if (body?.error?.code !== "event_cursor_expired") {
          retryable = false;
          throw new Error(body?.error?.message ?? "Event stream returned 409.");
        }
        if (!allowExpiredRecovery) {
          retryable = false;
          throw new Error("Event replay cursor remained expired after authoritative recovery.");
        }
        lastEventIds.delete(sessionId);
        await load();
        if (stopped || eventAbort !== controller) return;
        disconnectEventStream();
        return connect(false);
      }
      if (!response.ok || !response.body) throw new Error(`Event stream returned ${response.status}.`);
      if (stopped || controller.signal.aborted || eventAbort !== controller) {
        await response.body.cancel();
        return;
      }
      blockedEventSessionId = null;
      blockedEventError = null;
      eventStreamLive = true;
      emit({ ...snapshot, connection: "live", error: null });
      reader = response.body.getReader();
      eventReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped && !controller.signal.aborted && eventAbort === controller) {
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
      if (reader) await reader.cancel().catch(() => {});
      eventAbort = null;
      eventSessionId = null;
      eventStreamLive = false;
      const message = error instanceof Error ? error.message : String(error);
      if (!retryable) {
        blockedEventSessionId = sessionId;
        blockedEventError = message;
      }
      emit({ ...snapshot, connection: "offline", error: message });
      if (!retryable) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, 1_000);
    } finally {
      if (reader) {
        if (eventReader === reader) eventReader = null;
        reader.releaseLock();
      }
    }
  };

  const scheduleDiscovery = () => {
    if (!connectEvents || stopped || !token || discoveryTimer) return;
    discoveryTimer = setTimeout(() => {
      discoveryTimer = null;
      void (async () => {
        try {
          if (stopped || !token) return;
          const result = await load();
          if (!stopped && result.status === "ready") void connect();
        } finally {
          scheduleDiscovery();
        }
      })();
    }, CONTROL_ROOM_DISCOVERY_INTERVAL_MS);
  };

  const start = async () => {
    if (startPromise) return startPromise;
    stopped = false;
    const generation = lifecycleGeneration;
    startPromise = (async () => {
      await load();
      if (stopped || generation !== lifecycleGeneration) return snapshot;
      if (snapshot.status === "ready") void connect();
      scheduleDiscovery();
      return snapshot;
    })();
    return startPromise;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    start,
    stop() {
      stopped = true;
      advanceLifecycle();
      disconnectEventStream();
      clearConnectionTimers();
      blockedEventSessionId = null;
      blockedEventError = null;
      startPromise = null;
      emit({ ...snapshot, connection: "offline" });
    },
    async refresh() {
      const result = await load()
      if (result.status === "ready" && result.connection !== "live") void connect()
      scheduleDiscovery()
      return result
    },
    async authenticate(credentials) {
      let nextBaseUrl
      try {
        nextBaseUrl = normalizeLoopbackServerUrl(credentials?.baseUrl)
      } catch (error) {
        emit({ ...snapshot, status: "auth_required", auth: "required", error: error instanceof Error ? error.message : String(error) })
        return snapshot
      }
      const nextToken = String(credentials?.token ?? "").trim()
      if (!nextToken) {
        emit({ ...snapshot, status: "auth_required", auth: "required", error: "Enter the server token." })
        return snapshot
      }
      stopped = true
      advanceLifecycle()
      disconnectEventStream()
      clearConnectionTimers()
      blockedEventSessionId = null
      blockedEventError = null
      baseUrl = nextBaseUrl
      token = nextToken
      credentialGeneration += 1
      startPromise = null
      emit({
        ...snapshot,
        status: "idle",
        auth: "ready",
        serverUrl: baseUrl,
        connection: "offline",
        data: null,
        error: null,
        actions: Object.freeze({}),
      })
      return start()
    },
    clearCredentials() {
      credentialGeneration += 1
      token = ""
      stopped = true
      advanceLifecycle()
      disconnectEventStream()
      clearConnectionTimers()
      blockedEventSessionId = null
      blockedEventError = null
      startPromise = null
      emit({
        ...snapshot,
        status: "auth_required",
        auth: "required",
        connection: "offline",
        data: null,
        error: null,
        actions: Object.freeze({}),
      })
    },
    selectSession(sessionId) {
      const next = String(sessionId ?? "");
      if (!next || next === activeSessionId) return;
      activeSessionId = next;
      blockedEventSessionId = null;
      blockedEventError = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      disconnectEventStream();
      if (!stopped) void connect();
    },
    async action(sessionId, action, expectedRevision, payload) {
      if (!CONTROL_ACTIONS.has(action)) return { ok: false, code: "invalid_action", message: "Unknown control action." };
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { ok: false, code: "invalid_revision", message: "A valid session revision is required." };
      if (stopped) return { ok: false, code: "store_stopped", message: "The control room store is stopped." };
      const current = snapshot.actions[sessionId];
      if (current?.status === "pending") return { ok: false, code: "pending", message: "An action is already pending." };
      const lifecycle = lifecycleGeneration;
      const generation = credentialGeneration;
      const controller = new AbortController();
      actionControllers.add(controller);
      const actions = { ...snapshot.actions, [sessionId]: { status: "pending", action } };
      emit({ ...snapshot, actions });
      if (stopped || lifecycle !== lifecycleGeneration) {
        actionControllers.delete(controller);
        return { ok: false, code: "store_stopped", message: "The control room store is stopped." };
      }
      const fingerprint = JSON.stringify({ action, expectedRevision, payload: payload ?? null });
      const retry = retryKeys.get(sessionId);
      const requestKey = retry?.fingerprint === fingerprint ? retry.key : idempotencyKey();
      let rejectAbort;
      const abortPromise = new Promise((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      try {
        const operation = (async () => {
          const response = await fetchImpl(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/actions/${action}`, {
            method: "POST",
            headers: authHeaders({ "content-type": "application/json", "idempotency-key": requestKey }),
            body: JSON.stringify({ expectedRevision, ...(payload ? { payload } : {}) }),
            signal: controller.signal,
            redirect: "error",
          });
          return { response, result: await readBody(response) };
        })();
        const { response, result: responseResult } = await Promise.race([operation, abortPromise]);
        const result = responseResult ?? { ok: false, code: "invalid_response", message: `Control action returned ${response.status}.` };
        if (generation !== credentialGeneration) return { ok: false, code: "credentials_changed", message: "Credentials changed while the action was pending." };
        if (stopped || lifecycle !== lifecycleGeneration) return { ok: false, code: "store_stopped", message: "The control room store is stopped." };
        if (response.status === 401) {
          retryKeys.delete(sessionId)
          requireAuthentication(result.error?.message ?? "The server token expired or was rotated.")
          return result
        }
        retryKeys.delete(sessionId);
        const status = response.ok ? "success" : response.status === 409 ? "conflict" : response.status === 403 ? "denied" : "error";
        emit({ ...snapshot, actions: { ...snapshot.actions, [sessionId]: { status, action, message: result.message ?? result.error?.message } } });
        if (response.ok) await load();
        return result;
      } catch (error) {
        if (generation !== credentialGeneration) return { ok: false, code: "credentials_changed", message: "Credentials changed while the action was pending." };
        if (stopped || lifecycle !== lifecycleGeneration || controller.signal.aborted) {
          return { ok: false, code: "store_stopped", message: "The control room store is stopped." };
        }
        const message = error instanceof Error ? error.message : String(error);
        // The server may have applied a request whose response was lost. An
        // exact retry must reuse the same key instead of executing it twice.
        retryKeys.set(sessionId, { fingerprint, key: requestKey });
        emit({ ...snapshot, actions: { ...snapshot.actions, [sessionId]: { status: "error", action, message } } });
        return { ok: false, code: "network_error", message };
      } finally {
        if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
        actionControllers.delete(controller);
      }
    },
  };
}
