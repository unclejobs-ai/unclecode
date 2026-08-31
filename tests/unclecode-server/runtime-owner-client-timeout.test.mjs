import assert from "node:assert/strict";
import test from "node:test";

import { probeRuntimeOwner } from "../../apps/unclecode-server/src/runtime-owner-client.ts";

test("runtime owner health probe times out a stalled fetch", async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_url, init = {}) => await new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(init.signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
  try {
    const healthy = await probeRuntimeOwner({
      protocol: "unclecode-runtime-owner-v1",
      ownerId: "owner-timeout",
      bootId: "boot-timeout",
      pid: process.pid,
      endpoint: "http://127.0.0.1:9",
      tokenPath: "/not-used",
      projectPath: process.cwd(),
      startedAt: new Date().toISOString(),
    });
    assert.equal(healthy, false);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
