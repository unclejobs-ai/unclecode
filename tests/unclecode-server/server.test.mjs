import { test } from "node:test";
import assert from "node:assert/strict";

import { startServer, makeStubHandlers } from "@unclecode/server";

const TEST_TOKEN = "test-token-".padEnd(64, "0");

test("/health is public, no token required", async () => {
  const { url, stop } = await startServer({ port: 0, handlers: makeStubHandlers(), authToken: TEST_TOKEN });
  try {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  } finally {
    await stop();
  }
});

test("authed endpoints reject missing bearer token", async () => {
  const { url, stop } = await startServer({ port: 0, handlers: makeStubHandlers(), authToken: TEST_TOKEN });
  try {
    const response = await fetch(`${url}/sessions`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.error, /missing_bearer_token/);
  } finally {
    await stop();
  }
});

test("authed endpoints reject disallowed Origin", async () => {
  const { url, stop } = await startServer({ port: 0, handlers: makeStubHandlers(), authToken: TEST_TOKEN });
  try {
    const response = await fetch(`${url}/sessions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, Origin: "http://evil.example" },
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.error, /origin_not_allowed/);
  } finally {
    await stop();
  }
});

test("authed endpoints accept Bearer + localhost Origin", async () => {
  const { url, stop } = await startServer({ port: 0, handlers: makeStubHandlers(), authToken: TEST_TOKEN });
  try {
    const sessions = await fetch(`${url}/sessions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, Origin: "http://127.0.0.1:9999" },
    });
    assert.equal(sessions.status, 200);
    const invoke = await fetch(`${url}/tools/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ sessionId: "s1", toolName: "list_files", input: {} }),
    });
    assert.equal(invoke.status, 200);
    const body = await invoke.json();
    assert.equal(body.isError, false);
  } finally {
    await stop();
  }
});

test("startServer rejects non-loopback host without insecure flag", async () => {
  await assert.rejects(
    () => startServer({ port: 0, host: "0.0.0.0", handlers: makeStubHandlers(), authToken: TEST_TOKEN }),
    /insecure/,
  );
});
