import { test } from "node:test";
import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

import { createControlRoomStore, normalizeLoopbackServerUrl, parseSseFrames } from "../../apps/godness-web/src/control-room-store.js";
import { canApproveOnce, normalizePendingDecision } from "../../apps/godness-web/src/pending-decision.js";
import { readRuntimeBootstrap } from "../../apps/godness-web/src/runtime-bootstrap.js";
import { deriveWorkFocus } from "../../apps/godness-web/src/work-focus.js";

test("web runtime bootstrap never needs a build-time token", async () => {
  assert.deepEqual(
    readRuntimeBootstrap({ baseUrl: "http://localhost:19000", token: " runtime-secret " }, "http://127.0.0.1:17677"),
    { baseUrl: "http://localhost:19000", token: "runtime-secret" },
  );
  assert.deepEqual(
    readRuntimeBootstrap(undefined, "http://127.0.0.1:18000"),
    { baseUrl: "http://127.0.0.1:18000", token: "" },
  );
  const mainSource = await readFile(new URL("../../apps/godness-web/src/main.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(mainSource, /VITE_UNCLECODE_SERVER_TOKEN|localStorage|sessionStorage|location\.(?:hash|search)/);
});

test("web store accepts only loopback credential targets", async () => {
  assert.equal(normalizeLoopbackServerUrl("http://localhost:17677/"), "http://localhost:17677");
  assert.equal(normalizeLoopbackServerUrl("https://[::1]:17677"), "https://[::1]:17677");
  assert.throws(() => normalizeLoopbackServerUrl("https://control.example.com"), /loopback/i);
  assert.throws(() => normalizeLoopbackServerUrl("http://127.0.0.1:17677/control-room?token=secret"), /loopback/i);

  let fetches = 0;
  const store = createControlRoomStore({
    baseUrl: "http://127.0.0.1:17677",
    fetchImpl: async () => { fetches += 1; return new Response("{}", { status: 200 }); },
    connectEvents: false,
  });
  assert.equal(store.getSnapshot().status, "auth_required");
  await store.start();
  assert.equal(fetches, 0);
  await store.authenticate({ baseUrl: "https://control.example.com", token: "do-not-send" });
  assert.equal(fetches, 0);
  assert.equal(store.getSnapshot().status, "auth_required");
});

test("locking the web store cannot be undone by a stale authenticated response", async () => {
  let release;
  const pendingResponse = new Promise(resolve => { release = resolve; });
  const store = createControlRoomStore({
    baseUrl: "http://127.0.0.1:17677",
    token: "secret",
    fetchImpl: async () => pendingResponse,
    connectEvents: false,
  });
  const starting = store.start();
  store.clearCredentials();
  release(new Response(JSON.stringify({ version: 1, runs: [{ id: "s1" }] }), { status: 200 }));
  await starting;

  assert.equal(store.getSnapshot().status, "auth_required");
  assert.equal(store.getSnapshot().data, null);
});

test("web store retains global System evidence when there are zero runs", async () => {
  const projection = {
    version: 1,
    generatedAt: 1,
    runs: [],
    system: {
      evidenceSources: { owner: "available", cacheTelemetry: "available" },
      pluginHosts: [{ sessionId: "session-1", status: "active", registrationCount: 1, pendingCleanupCount: 0, registrations: [], truncated: false }],
      providers: [],
      mcpServers: [],
      cleanup: [],
      caches: [],
    },
  };
  const store = createControlRoomStore({
    baseUrl: "http://127.0.0.1:17677",
    token: "secret",
    fetchImpl: async () => new Response(JSON.stringify(projection), { status: 200 }),
    connectEvents: false,
  });
  await store.start();

  assert.equal(store.getSnapshot().status, "ready");
  assert.deepEqual(store.getSnapshot().data.runs, []);
  assert.equal(store.getSnapshot().data.system.pluginHosts[0].registrationCount, 1);
  assert.equal("plugins" in store.getSnapshot().data.system, false);
});

test("web work focus preserves task, remaining-stage, blocker, then detail inputs", () => {
  const focus = deriveWorkFocus({
    project: "unclecode",
    state: "running",
    attentionReason: "Waiting for tests",
    graph: { nodes: [
      { id: "plan", title: "Plan the work", status: "completed" },
      { id: "implement", title: "Implement Control Room", status: "running" },
    ] },
    quality: { stage: "work", gate: "refine", findings: ["A lower-priority finding"] },
  });
  assert.equal(focus.currentTask, "Implement Control Room");
  assert.deepEqual(focus.remainingStages, ["critic", "promote"]);
  assert.equal(focus.blocker, "Waiting for tests");
  assert.equal(focus.blockerKind, "attention");
});

test("web decisions keep security approval separate from typed user questions", async () => {
  const userDecision = normalizePendingDecision({
    kind: "user-decision",
    id: "release-choice",
    title: "Choose a release lane",
    questions: [{
      id: "lane",
      question: "Which lane should continue?",
      options: [{ label: "Canary", description: "Small cohort" }, { label: "Stable" }],
      recommended: 0,
    }],
  });
  assert.equal(userDecision.kind, "user-decision");
  assert.equal(userDecision.questions[0].options[0].description, "Small cohort");
  assert.equal(canApproveOnce(userDecision), false);
  assert.equal(canApproveOnce(normalizePendingDecision({
    kind: "security-approval",
    id: "tool-policy",
    questions: [{ id: "allow", question: "Allow this tool?", options: [{ label: "Approve" }, { label: "Reject" }] }],
  })), true);
  assert.equal(normalizePendingDecision({
    kind: "user-decision",
    id: "oversized",
    questions: Array.from({ length: 9 }, (_, index) => ({ id: `q-${index}`, question: "Choose", options: [{ label: "One" }] })),
  }), null);

  const appSource = await readFile(new URL("../../apps/godness-web/src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(appSource, /run\.state\s*===\s*['"]requires_action['"][^\n]*doAction\(['"]approve['"]/);
});

test("work focus names an explicit user decision before a generic attention reason", () => {
  const focus = deriveWorkFocus({
    project: "unclecode",
    state: "requires_action",
    attentionReason: "Security approval or user decision required",
    pendingDecision: { kind: "user-decision" },
    graph: { nodes: [] },
    quality: { stage: "plan", gate: "unproven", findings: [] },
  });
  assert.equal(focus.blocker, "user_decision");
  assert.equal(focus.blockerKind, "decision");
});

test("work focus does not infer security approval from an untyped action state", () => {
  const focus = deriveWorkFocus({
    project: "unclecode",
    state: "requires_action",
    graph: { nodes: [] },
    quality: { stage: "plan", gate: "unproven", findings: [] },
  });
  assert.equal(focus.blocker, "action_required");
  assert.equal(focus.blockerKind, "attention");
});

test("web store loads one bounded snapshot and applies SSE refresh without duplicate connections", async () => {
  let fetches = 0;
  const requests = [];
  const projection = { version: 1, generatedAt: 1, runs: [{ id: "s1", revision: 1, locale: "en", state: "running" }] };
  const fetchImpl = async (url, init = {}) => {
    fetches += 1;
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/control-room")) {
      return new Response(JSON.stringify(projection), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl, connectEvents: false });
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot().status));
  await store.start();
  await store.start();
  unsubscribe();

  assert.equal(store.getSnapshot().status, "ready");
  assert.equal(store.getSnapshot().data.runs[0].id, "s1");
  assert.equal(fetches, 1);
  assert.deepEqual(seen, ["loading", "ready"]);
  assert.equal(requests[0].init.headers.authorization, "Bearer secret");
});

test("web store actions expose pending, denied, and conflict states without mutating run data", async () => {
  const projection = { version: 1, generatedAt: 1, runs: [{ id: "s1", revision: 4, locale: "ko", state: "running" }] };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/control-room")) return new Response(JSON.stringify(projection), { status: 200 });
    assert.equal(init.headers["idempotency-key"].length > 0, true);
    return new Response(JSON.stringify({ ok: false, code: "revision_conflict", message: "changed", revision: 5 }), { status: 409 });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl, connectEvents: false });
  await store.start();
  const result = await store.action("s1", "pause", 4);

  assert.equal(result.ok, false);
  assert.equal(store.getSnapshot().actions.s1.status, "conflict");
  assert.equal(store.getSnapshot().data.runs[0].revision, 4);
});

test("SSE parser preserves event ids and ignores incomplete frames", () => {
  const parsed = parseSseFrames("id: 7\nevent: quality.updated\ndata: {\"gate\":\"refine\"}\n\nid: 8\nevent: run.updated\n");
  assert.deepEqual(parsed.events, [{ id: 7, event: "quality.updated", data: { gate: "refine" } }]);
  assert.match(parsed.rest, /id: 8/);
});

test("SSE parser accepts CRLF frames and rejects partial numeric event ids", () => {
  const parsed = parseSseFrames("id: 9\r\nevent: run.updated\r\ndata: {}\r\n\r\nid: 10x\ndata: {}\n\n");
  assert.deepEqual(parsed.events, [{ id: 9, event: "run.updated", data: {} }]);
});

test("web store sends steer, follow-up, and typed decisions through authenticated action routes", async () => {
  let revision = 7;
  const actions = [];
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/control-room") {
      return new Response(JSON.stringify({ version: 1, generatedAt: 1, runs: [{ id: "s1", revision }] }), { status: 200 });
    }
    actions.push({ pathname, init, body: JSON.parse(init.body) });
    revision += 1;
    return new Response(JSON.stringify({ ok: true, revision, state: "running" }), { status: 200 });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl, connectEvents: false });
  await store.start();
  await store.action("s1", "steer", 7, { agentRunId: "agent-1", message: "Check the failing test" });
  await store.action("s1", "follow-up", 8, { message: "Run the focused verification" });
  await store.action("s1", "decision", 9, {
    decisionId: "release-choice",
    answers: [{ id: "lane", selectedOptions: ["Canary"] }],
  });

  assert.deepEqual(actions.map(item => item.pathname), [
    "/sessions/s1/actions/steer",
    "/sessions/s1/actions/follow-up",
    "/sessions/s1/actions/decision",
  ]);
  assert.deepEqual(actions[0].body.payload, { agentRunId: "agent-1", message: "Check the failing test" });
  assert.deepEqual(actions[2].body.payload, {
    decisionId: "release-choice",
    answers: [{ id: "lane", selectedOptions: ["Canary"] }],
  });
  assert.equal(actions.every(item => item.init.headers.authorization === "Bearer secret"), true);
});

test("web store reuses the idempotency key after an ambiguous network failure", async () => {
  const projection = { version: 1, generatedAt: 1, runs: [{ id: "s1", revision: 4, locale: "en", state: "running" }] };
  const keys = [];
  let actionCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/control-room")) return new Response(JSON.stringify(projection), { status: 200 });
    keys.push(init.headers["idempotency-key"]);
    actionCalls += 1;
    if (actionCalls === 1) throw new TypeError("connection reset after write");
    return new Response(JSON.stringify({ ok: true, revision: 5, state: "paused" }), { status: 200 });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl, connectEvents: false });
  await store.start();
  assert.equal((await store.action("s1", "pause", 4)).code, "network_error");
  assert.equal((await store.action("s1", "pause", 4)).ok, true);
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0]);
});

test("web store reconnects the event stream for the selected run", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    requests.push({ pathname, headers: init.headers ?? {} });
    if (pathname === "/control-room") {
      return new Response(JSON.stringify({ version: 1, generatedAt: 1, runs: [
        { id: "s1", revision: 1 },
        { id: "s2", revision: 1 },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl });
  await store.start();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.some(request => request.pathname === "/sessions/s1/events"), true);

  store.selectSession("s2");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.some(request => request.pathname === "/sessions/s2/events"), true);
  store.stop();
});

test("web store keeps an independent replay cursor for each selected run", async () => {
  const eventHeaders = { s1: [], s2: [] };
  const eventCalls = { s1: 0, s2: 0 };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/control-room") {
      return new Response(JSON.stringify({ version: 1, generatedAt: 1, runs: [{ id: "s1" }, { id: "s2" }] }), { status: 200 });
    }
    const sessionId = pathname.includes("/s1/") ? "s1" : "s2";
    eventHeaders[sessionId].push(init.headers ?? {});
    eventCalls[sessionId] += 1;
    if (eventCalls[sessionId] === 1) {
      const id = sessionId === "s1" ? 7 : 12;
      return new Response(`id: ${id}\nevent: run.updated\ndata: {}\n\n`, { status: 200 });
    }
    return new Response(new ReadableStream({ start() {} }), { status: 200 });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl });
  await store.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  store.selectSession("s2");
  await new Promise(resolve => setTimeout(resolve, 20));
  store.selectSession("s1");
  await new Promise(resolve => setTimeout(resolve, 20));
  store.selectSession("s2");
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(eventHeaders.s1[1]?.["last-event-id"], "7");
  assert.equal(eventHeaders.s2[1]?.["last-event-id"], "12");
  store.stop();
});

test("web store performs one authoritative recovery for an expired cursor without looping", async () => {
  const eventHeaders = [];
  let eventCalls = 0;
  let controlRoomCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/control-room") {
      controlRoomCalls += 1;
      return new Response(JSON.stringify({ version: 1, generatedAt: 1, runs: [{ id: "s1", revision: 1 }] }), { status: 200 });
    }
    eventHeaders.push(init.headers ?? {});
    eventCalls += 1;
    if (eventCalls === 1) {
      return new Response("id: 7\nevent: run.updated\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (eventCalls <= 3) return new Response(JSON.stringify({ error: { code: "event_cursor_expired" } }), { status: 409 });
    return new Response(new ReadableStream({ start() {} }), { status: 200 });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl });
  await store.start();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(eventHeaders[1]?.["last-event-id"], "7");
  assert.equal(eventHeaders[2]?.["last-event-id"], undefined);
  assert.equal(eventCalls, 3);
  assert.equal(controlRoomCalls, 3);
  assert.equal(store.getSnapshot().connection, "offline");
  assert.match(store.getSnapshot().error, /expired/i);
  store.stop();
});

test("web store cancels the previous reader across 100 selected-session reconnects", async () => {
  let activeStreams = 0;
  let maxActiveStreams = 0;
  const runs = Array.from({ length: 100 }, (_, index) => ({ id: `s${index}`, revision: 1 }));
  const fetchImpl = async url => {
    if (String(url).endsWith("/control-room")) {
      return new Response(JSON.stringify({ version: 1, generatedAt: 1, runs }), { status: 200 });
    }
    activeStreams += 1;
    maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
    return new Response(new ReadableStream({
      start() {},
      cancel() { activeStreams -= 1; },
    }), { status: 200 });
  };
  const store = createControlRoomStore({ baseUrl: "http://127.0.0.1:17677", token: "secret", fetchImpl });
  await store.start();
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 1; index < 100; index += 1) {
    store.selectSession(`s${index}`);
    await new Promise(resolve => setImmediate(resolve));
  }
  store.stop();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(maxActiveStreams, 1);
  assert.equal(activeStreams, 0);
});
