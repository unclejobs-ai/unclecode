import assert from "node:assert/strict";
import test from "node:test";

import { runWorkCli } from "../../apps/unclecode-cli/src/work-runtime.ts";

const idleState = {
  entries: [],
  isBusy: false,
  turnLifecycle: { state: "idle" },
  agentConsole: { agents: [], jobs: [] },
};

function successfulSession(sessionId, revision = 1) {
  return {
    sessionId,
    projectPath: process.cwd(),
    provider: "openai",
    model: "owner-model",
    reasoning: "high",
    revision,
  };
}

test("one-shot Work prompt runs through the owner and prints its terminal transcript", async () => {
  const creates = [];
  const attaches = [];
  const invokes = [];
  const output = [];
  let localBootstraps = 0;
  const terminalState = {
    ...idleState,
    entries: [
      { role: "user", text: "summarize owner state" },
      { role: "assistant", text: "OWNER_TRANSCRIPT_RESULT" },
    ],
    turnLifecycle: { state: "completed", turnId: "turn-owner-1" },
  };
  const client = {
    async createRuntimeSession(input) {
      creates.push(input);
      return { ok: true, session: successfulSession(input.sessionId) };
    },
    async attachRuntimeSession(sessionId) {
      attaches.push(sessionId);
      return {
        ok: true,
        session: successfulSession(sessionId),
        engine: { ok: true, revision: 1, state: idleState, result: null },
      };
    },
    async readEngineState() {
      return { ok: true, revision: 1, state: idleState, result: null };
    },
    async invokeEngineMethod(input) {
      invokes.push(input);
      return { ok: true, revision: 2, state: terminalState, result: undefined };
    },
  };

  await runWorkCli(["--cwd", process.cwd(), "--provider", "openai", "summarize owner state"], {
    connectOwner: async () => client,
    loadInteractiveSession: async () => {
      localBootstraps += 1;
      throw new Error("one-shot prompt constructed a local runtime");
    },
    writeOutput: (text) => { output.push(text); },
  });

  assert.equal(localBootstraps, 0, "prompt mode must not bootstrap a local WorkAgent/plugin/store/recorder graph");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].projectPath, process.cwd());
  assert.equal(creates[0].provider, "openai");
  assert.equal(creates[0].resume, false);
  assert.equal(typeof creates[0].idempotencyKey, "string");
  assert.ok(creates[0].idempotencyKey.length > 0);
  assert.deepEqual(attaches, [creates[0].sessionId]);
  assert.equal(invokes.length, 1, "the owner must receive the prompt exactly once");
  assert.equal(invokes[0].sessionId, creates[0].sessionId);
  assert.equal(invokes[0].method, "handleSubmit");
  assert.deepEqual(invokes[0].args, ["summarize owner state"]);
  assert.equal(typeof invokes[0].idempotencyKey, "string");
  assert.ok(invokes[0].idempotencyKey.length > 0);
  assert.notEqual(invokes[0].idempotencyKey, creates[0].idempotencyKey);
  assert.deepEqual(output, ["OWNER_TRANSCRIPT_RESULT\n"]);
});

test("one-shot Work prompt returns at an owner decision and settles its client request", async () => {
  const output = [];
  const invokes = [];
  let reads = 0;
  let clientRequestAborted = 0;
  const decisionState = {
    ...idleState,
    entries: [{ role: "user", text: "deploy safely" }],
    isBusy: true,
    turnLifecycle: { state: "running", turnId: "turn-owner-decision" },
    panel: {
      title: "Decision",
      lines: ["Approve deployment?", "1. yes", "2. no"],
    },
    agentConsole: {
      agents: [],
      jobs: [],
      pendingDecision: { id: "approval-1", prompt: "Approve deployment?", options: ["yes", "no"] },
    },
  };
  const client = {
    async createRuntimeSession(input) {
      return { ok: true, session: successfulSession(input.sessionId) };
    },
    async attachRuntimeSession(sessionId) {
      return {
        ok: true,
        session: successfulSession(sessionId),
        engine: { ok: true, revision: 1, state: idleState, result: null },
      };
    },
    async readEngineState() {
      reads += 1;
      return reads === 1
        ? { ok: true, revision: 1, state: idleState, result: null }
        : { ok: true, revision: 2, state: decisionState, result: null };
    },
    async invokeEngineMethod(input) {
      invokes.push(input);
      return await new Promise((_, reject) => {
        input.signal.addEventListener("abort", () => {
          clientRequestAborted += 1;
          reject(input.signal.reason);
        }, { once: true });
      });
    },
  };

  await runWorkCli(["--cwd", process.cwd(), "deploy safely"], {
    connectOwner: async () => client,
    loadInteractiveSession: async () => { throw new Error("local bootstrap must stay unreachable"); },
    writeOutput: (text) => { output.push(text); },
  });

  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].method, "handleSubmit");
  assert.equal(clientRequestAborted, 1, "detaching at a decision must settle the local in-flight RPC");
  assert.deepEqual(output, ["Approve deployment?\n1. yes\n2. no\n"]);
  const readsAtReturn = reads;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(reads, readsAtReturn, "one-shot cleanup must leave no polling handle behind");
  assert.equal(invokes.some((input) => input.method === "interruptTurn"), false,
    "client detach must not cancel the owner-held decision");
});

test("one-shot Work prompt resumes an explicit owner session idempotently", async () => {
  const creates = [];
  const invokes = [];
  const client = {
    async createRuntimeSession(input) {
      creates.push(input);
      return { ok: true, session: successfulSession(input.sessionId, 7) };
    },
    async attachRuntimeSession(sessionId) {
      return {
        ok: true,
        session: successfulSession(sessionId, 7),
        engine: { ok: true, revision: 7, state: idleState, result: null },
      };
    },
    async readEngineState() {
      return { ok: true, revision: 7, state: idleState, result: null };
    },
    async invokeEngineMethod(input) {
      invokes.push(input);
      return {
        ok: true,
        revision: 8,
        state: {
          ...idleState,
          entries: [{ role: "assistant", text: "resumed owner reply" }],
          turnLifecycle: { state: "completed", turnId: "turn-resumed" },
        },
        result: undefined,
      };
    },
  };

  await runWorkCli(["--cwd", process.cwd(), "--session-id", "work-existing", "continue"], {
    connectOwner: async () => client,
    loadInteractiveSession: async () => { throw new Error("local bootstrap must stay unreachable"); },
    writeOutput() {},
  });

  assert.equal(creates.length, 1);
  assert.equal(creates[0].sessionId, "work-existing");
  assert.equal(creates[0].resume, true);
  assert.equal(invokes.length, 1, "resume must not duplicate the submitted owner turn");
  assert.equal(invokes[0].expectedRevision, 7);
});

test("one-shot Work prompt recovers a committed owner turn after its response is lost", async () => {
  const output = [];
  const invokes = [];
  let state = idleState;
  let revision = 1;
  const client = {
    async createRuntimeSession(input) {
      return { ok: true, session: successfulSession(input.sessionId) };
    },
    async attachRuntimeSession(sessionId) {
      return {
        ok: true,
        session: successfulSession(sessionId),
        engine: { ok: true, revision, state, result: null },
      };
    },
    async readEngineState() {
      return { ok: true, revision, state, result: null };
    },
    async invokeEngineMethod(input) {
      invokes.push(input);
      revision = 2;
      state = {
        ...idleState,
        entries: [
          { role: "user", text: "finish exactly once" },
          { role: "assistant", text: "committed owner transcript" },
        ],
        turnLifecycle: { state: "completed", turnId: "turn-committed" },
      };
      const error = new Error("socket closed after owner committed the receipt");
      error.code = "ECONNRESET";
      throw error;
    },
  };

  await runWorkCli(["--cwd", process.cwd(), "finish exactly once"], {
    connectOwner: async () => client,
    loadInteractiveSession: async () => { throw new Error("local bootstrap must stay unreachable"); },
    writeOutput: (text) => { output.push(text); },
  });

  assert.equal(invokes.length, 1, "a lost response must never replay an admitted owner turn");
  assert.deepEqual(output, ["committed owner transcript\n"]);
});
