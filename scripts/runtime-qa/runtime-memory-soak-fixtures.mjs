import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { request } from "node:http";

function activeHandleCount() {
  const getActiveHandles = process._getActiveHandles;
  return typeof getActiveHandles === "function" ? getActiveHandles.call(process).length : null;
}

function fileDescriptorCount() {
  for (const directory of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return readdirSync(directory).length;
    } catch {
      // File-descriptor enumeration is platform dependent.
    }
  }
  return null;
}

async function settleEventLoop(iterations = 8) {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

export async function collectRuntimeMetrics() {
  await settleEventLoop();
  if (typeof globalThis.gc === "function") {
    for (let index = 0; index < 3; index += 1) {
      globalThis.gc();
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return {
    heapUsedBytes: process.memoryUsage().heapUsed,
    activeHandles: activeHandleCount(),
    fileDescriptors: fileDescriptorCount(),
  };
}

export function metricDelta(after, before) {
  return after === null || before === null ? null : after - before;
}

export function createFakeEngine(sessionId, counters) {
  let state = {
    sessionId,
    mode: "standard",
    isBusy: false,
    queuePaused: false,
    model: "soak-model",
    uiLocale: "en",
    agentConsole: {},
  };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      counters.activeEngineSubscribers += 1;
      counters.peakEngineSubscribers = Math.max(
        counters.peakEngineSubscribers,
        counters.activeEngineSubscribers,
      );
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        if (listeners.delete(listener)) counters.activeEngineSubscribers -= 1;
      };
    },
    setMode(mode) {
      state = { ...state, mode };
      for (const listener of listeners) listener();
    },
    interruptTurn: () => false,
    getTurnLifecycle: () => ({ state: "idle" }),
    async requestTurnPause() {
      throw new Error("The soak engine has no active turn.");
    },
    resumeTurn: () => false,
    async resumeQueueItems() {},
    async handleSubmit() {},
    answerPendingDecisionByIndex: () => false,
    getAgentControlPort: () => ({
      async steer() {
        return { status: "rejected" };
      },
    }),
    bindRuntimeRevisionClock() {},
    bindRuntimeUsageRecorder() {},
  };
}

export async function openAndCloseSse(endpoint, token, sessionId) {
  const response = await new Promise((resolve, reject) => {
    const client = request(`${endpoint}/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "GET",
      agent: false,
      headers: { authorization: `Bearer ${token}` },
    });
    client.once("response", incoming => {
      incoming.on("error", () => {});
      resolve({ client, incoming });
    });
    client.once("error", reject);
    client.end();
  });
  assert.equal(response.incoming.statusCode, 200, "SSE connection must authenticate and open");
  const closed = new Promise(resolve => response.incoming.once("close", resolve));
  response.incoming.destroy();
  response.client.destroy();
  await closed;
}

export async function readAuthenticatedJson(endpoint, token, pathname) {
  return await new Promise((resolve, reject) => {
    const client = request(`${endpoint}${pathname}`, {
      method: "GET",
      agent: false,
      headers: { authorization: `Bearer ${token}` },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${pathname} returned ${String(response.statusCode)}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    client.once("error", reject);
    client.end();
  });
}
