import { test } from "node:test";
import assert from "node:assert/strict";

import { BoundedEventJournal, createRuntimeAdapter, makeControlRoomHandlers, startServer } from "@unclecode/server";

const TOKEN = "server-v2-token".padEnd(64, "x");

function headers(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, origin: "http://127.0.0.1:5173", ...extra };
}

function fixture() {
  const journal = new BoundedEventJournal({ capacity: 8 });
  const calls = [];
  const adapter = createRuntimeAdapter({
    async read() {
      return {
        generatedAt: 10,
        sessions: [{ sessionId: "s1", projectPath: "/tmp/project", locale: "en", state: "running", revision: 2 }],
      };
    },
    controls: {
      async control(input) {
        calls.push(input);
        return { ok: true, revision: 3, state: input.action === "cancel" ? "cancelled" : "running" };
      },
    },
  });
  return { journal, calls, handlers: makeControlRoomHandlers({ adapter, journal }) };
}

test("control-room endpoints require bearer auth and reject non-loopback origins", async () => {
  const { handlers } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN });
  try {
    assert.equal((await fetch(`${server.url}/control-room`)).status, 401);
    const forbidden = await fetch(`${server.url}/control-room`, { headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example:5173" } });
    assert.equal(forbidden.status, 403);
    assert.equal((await fetch(`${server.url}/control-room`, { headers: headers() })).status, 200);
  } finally {
    await server.stop();
  }
});

test("loopback browser preflight exposes only typed control headers", async () => {
  const { handlers } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN });
  try {
    const response = await fetch(`${server.url}/control-room`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5173", "access-control-request-method": "GET" } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    assert.match(response.headers.get("access-control-allow-headers"), /Idempotency-Key/);
  } finally {
    await server.stop();
  }
});

test("typed controls validate body, revision, and idempotency", async () => {
  const { handlers, calls } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN });
  try {
    const malformed = await fetch(`${server.url}/sessions/s1/actions/pause`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ expectedRevision: "2" }),
    });
    assert.equal(malformed.status, 400);

    const ok = await fetch(`${server.url}/sessions/s1/actions/pause`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": "pause-1" }),
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "pause");
  } finally {
    await server.stop();
  }
});

test("typed decision endpoint rejects malformed answers before runtime admission", async () => {
  const { handlers, calls } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN });
  try {
    const malformed = await fetch(`${server.url}/sessions/s1/actions/decision`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": "decision-bad" }),
      body: JSON.stringify({
        expectedRevision: 2,
        payload: { decisionId: "decision-1", answers: [{ id: "lane", selectedOptions: [] }] },
      }),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "invalid_payload");
    assert.equal(calls.length, 0);

    const payload = {
      decisionId: "decision-1",
      answers: [{ id: "lane", selectedOptions: ["Canary"] }],
    };
    const accepted = await fetch(`${server.url}/sessions/s1/actions/decision`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": "decision-good" }),
      body: JSON.stringify({ expectedRevision: 2, payload }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "decision");
    assert.deepEqual(calls[0].payload, payload);
  } finally {
    await server.stop();
  }
});

test("typed approval endpoint requires and preserves one exact decision identity", async () => {
  const { handlers, calls } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN });
  try {
    const missingIdentity = await fetch(`${server.url}/sessions/s1/actions/approve`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": "approve-bad" }),
      body: JSON.stringify({ expectedRevision: 2, payload: { decision: "approve_once" } }),
    });
    assert.equal(missingIdentity.status, 400);
    assert.equal((await missingIdentity.json()).error.code, "invalid_payload");
    assert.equal(calls.length, 0);

    const payload = { decision: "approve_once", decisionId: "approval-call-17" };
    const accepted = await fetch(`${server.url}/sessions/s1/actions/approve`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": "approve-good" }),
      body: JSON.stringify({ expectedRevision: 2, payload }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload, payload);
  } finally {
    await server.stop();
  }
});

test("SSE uses ids and Last-Event-ID replay", async () => {
  const { handlers, journal } = fixture();
  const first = journal.publish("s1", "run.updated", { revision: 1 });
  const second = journal.publish("s1", "quality.updated", { gate: "unproven" });
  const server = await startServer({ port: 0, handlers, authToken: TOKEN, heartbeatMs: 50 });
  try {
    const controller = new AbortController();
    const response = await fetch(`${server.url}/sessions/s1/events`, {
      headers: headers({ "last-event-id": String(first.id) }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const chunk = await reader.read();
    controller.abort();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, new RegExp(`id: ${second.id}`));
    assert.match(text, /event: quality.updated/);
  } finally {
    await server.stop();
  }
});

test("SSE streams events published after the connection is established", async () => {
  const { handlers, journal } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN, heartbeatMs: 10_000 });
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.url}/sessions/s1/events`, {
      headers: headers(),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const published = journal.publish("s1", "quality.updated", { gate: "proceed" });
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, new RegExp(`id: ${published.id}`));
    assert.match(text, /event: quality.updated/);
  } finally {
    controller.abort();
    await server.stop();
  }
});

test("SSE rejects a partially numeric Last-Event-ID", async () => {
  const { handlers } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN });
  try {
    const response = await fetch(`${server.url}/sessions/s1/events`, {
      headers: headers({ "last-event-id": "7junk" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_event_cursor");
  } finally {
    await server.stop();
  }
});

test("SSE abort cleanup releases every subscription across 100 reconnects", async () => {
  const { handlers, journal } = fixture();
  const server = await startServer({ port: 0, handlers, authToken: TOKEN, heartbeatMs: 10_000 });
  try {
    for (let reconnect = 0; reconnect < 100; reconnect += 1) {
      const controller = new AbortController();
      const response = await fetch(`${server.url}/sessions/s1/events`, { headers: headers(), signal: controller.signal });
      assert.equal(response.status, 200);
      controller.abort();
    }
    for (let attempt = 0; attempt < 100 && journal.stats.activeSubscriptions > 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(journal.stats.activeSubscriptions, 0);
    assert.equal(journal.stats.subscriberSessions, 0);
  } finally {
    await server.stop();
  }
});

test("expired SSE cursors, invalid methods, unknown actions, and oversized bodies fail explicitly", async () => {
  const { handlers, journal } = fixture();
  for (let index = 0; index < 10; index += 1) journal.publish("s1", "run.updated", { revision: index });
  const server = await startServer({ port: 0, handlers, authToken: TOKEN });
  try {
    const expired = await fetch(`${server.url}/sessions/s1/events`, { headers: headers({ "last-event-id": "1" }) });
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error.code, "event_cursor_expired");

    const wrongMethod = await fetch(`${server.url}/control-room`, { method: "POST", headers: headers() });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const unknown = await fetch(`${server.url}/sessions/s1/actions/deploy`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": "unknown-1" }),
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "unknown_action");

    const oversized = await fetch(`${server.url}/sessions/s1/actions/follow-up`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": "large-1" }),
      body: JSON.stringify({ expectedRevision: 2, payload: { message: "x".repeat(70_000) } }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "payload_too_large");
  } finally {
    await server.stop();
  }
});
