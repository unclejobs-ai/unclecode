import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWorkCreatorEvolutionService,
  runBoundedCreatorOperation,
} from "../../apps/unclecode-cli/src/creator-evolution-runtime.ts";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "uc-creator-runtime-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "creator@example.test"]);
  git(root, ["config", "user.name", "Creator Runtime Test"]);
  mkdirSync(path.join(root, "skills"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), ".unclecode/\n");
  writeFileSync(path.join(root, "AGENTS.md"), "policy\n");
  writeFileSync(path.join(root, "package.json"), '{"scripts":{}}\n');
  writeFileSync(path.join(root, "skills", "creator.md"), "creator v1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

function fakeRecorder(records) {
  return {
    healthy: true,
    dbPath: undefined,
    recordTurn() {},
    recordEvolutionProposal(record) { records.push(record); },
    finish() {},
  };
}

function fakeAgent(runTurn, clear = () => {}) {
  return {
    clear,
    setTraceListener() {},
    updateRuntimeSettings() {},
    runTurn,
  };
}

function evolutionInput(root, runId, signal) {
  return {
    runId,
    workspaceRoot: root,
    prompt: "Create a stronger creator skill.",
    creatorId: "no-tools-creator",
    mutableTargets: ["skills/creator.md"],
    dispatchEvolutionProposed: async () => ({ action: "proceed", failures: [] }),
    signal,
  };
}

test("a never-settling creator cannot hold cancellation past the post-abort grace", async () => {
  const caller = new AbortController();
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  let operationSignal;
  let terminationCalls = 0;

  const running = runBoundedCreatorOperation({
    signal: caller.signal,
    timeoutMs: 60_000,
    abortSettlementGraceMs: 10,
    run(signal) {
      operationSignal = signal;
      started();
      return new Promise(() => {});
    },
    onTerminate() {
      terminationCalls += 1;
    },
  });
  await didStart;
  caller.abort(new Error("cancel never-settling creator"));

  const outcome = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 250)),
  ]);
  assert.notEqual(outcome, "still-pending", "the lifecycle remained locked behind the creator promise");
  assert.deepEqual(outcome, {
    status: "cancelled",
    summary: "Evolution execution was cancelled.",
  });
  assert.equal(operationSignal.aborted, true);
  assert.equal(terminationCalls, 1);
});

test("an already-cancelled creator clears its provider without starting a turn", async () => {
  const caller = new AbortController();
  caller.abort(new Error("cancel before creator turn"));
  let started = false;
  let terminationCalls = 0;
  const outcome = await runBoundedCreatorOperation({
    signal: caller.signal,
    timeoutMs: 60_000,
    abortSettlementGraceMs: 10,
    run: async () => {
      started = true;
      return { text: "must not run" };
    },
    onTerminate() { terminationCalls += 1; },
  });
  assert.equal(outcome.status, "cancelled");
  assert.equal(started, false);
  assert.equal(terminationCalls, 1);
});

test("cancellation remains authoritative when the provider settles from its abort handler", async () => {
  const caller = new AbortController();
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const running = runBoundedCreatorOperation({
    signal: caller.signal,
    timeoutMs: 60_000,
    abortSettlementGraceMs: 10,
    run: (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ text: "late abort envelope" }), { once: true });
      started();
    }),
  });
  await didStart;
  caller.abort(new Error("abort wins"));
  assert.equal((await running).status, "cancelled");
});

test("a creator that ignores its timeout settles the host bound and accepts no late result", async () => {
  let resolveCreator;
  const creator = new Promise((resolve) => { resolveCreator = resolve; });
  const running = runBoundedCreatorOperation({
    signal: new AbortController().signal,
    timeoutMs: 5,
    abortSettlementGraceMs: 10,
    run: () => creator,
  });

  const outcome = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 250)),
  ]);
  assert.notEqual(outcome, "still-pending", "the timeout remained coupled to late provider settlement");
  assert.deepEqual(outcome, {
    status: "timeout",
    summary: "Evolution execution exceeded 5ms.",
  });
  resolveCreator({ text: '{"files":[{"path":"skills/creator.md","content":"late"}]}' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(outcome.status, "timeout", "late creator output must not replace the authoritative timeout");
});

test("a never-settling creator timeout releases the lifecycle lock and duplicate replays exactly once", async () => {
  const root = createRepository();
  const records = [];
  let creatorCalls = 0;
  let creatorEntered;
  const didEnterCreator = new Promise((resolve) => { creatorEntered = resolve; });
  const makeService = () => createWorkCreatorEvolutionService({
    cwd: root,
    env: { ...process.env },
    reasoning: {},
    recorder: fakeRecorder(records),
    creatorTimeoutMs: 40,
    creatorAbortSettlementGraceMs: 10,
    createCreatorAgent() {
      creatorCalls += 1;
      return fakeAgent(() => {
        creatorEntered();
        return new Promise(() => {});
      });
    },
  });
  const owner = new AbortController();
  const duplicate = new AbortController();
  try {
    const firstRun = makeService().run(evolutionInput(root, "creator-never-settles", owner.signal));
    await didEnterCreator;
    const duplicateRun = makeService().run(evolutionInput(root, "creator-never-settles", duplicate.signal));

    const results = await Promise.race([
      Promise.all([firstRun, duplicateRun]),
      new Promise((resolve) => setTimeout(() => resolve("still-locked"), 1_000)),
    ]);
    assert.notEqual(results, "still-locked", "the detached provider kept the durable lifecycle lock");
    assert.equal(results[0].status, "failed");
    assert.equal(results[1].status, "failed");
    assert.ok(results[0].projection.failures.includes("EVOLUTION_CREATOR_TIMEOUT"));
    assert.equal(results[0].projection.id, results[1].projection.id);
    assert.equal(creatorCalls, 1, "the duplicate must replay the authoritative cancellation");
    assert.equal(records.length, 1, "only the lock owner may record the lifecycle");
    assert.equal(readFileSync(path.join(root, "skills", "creator.md"), "utf8"), "creator v1\n");
  } finally {
    owner.abort();
    duplicate.abort();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a creator envelope resolved after detachment cannot mutate or record", async () => {
  const root = createRepository();
  const records = [];
  let resolveCreator;
  const lateCreator = new Promise((resolve) => { resolveCreator = resolve; });
  let creatorEntered;
  const didEnterCreator = new Promise((resolve) => { creatorEntered = resolve; });
  const controller = new AbortController();
  const service = createWorkCreatorEvolutionService({
    cwd: root,
    env: { ...process.env },
    reasoning: {},
    recorder: fakeRecorder(records),
    creatorAbortSettlementGraceMs: 10,
    createCreatorAgent: () => fakeAgent(() => {
      creatorEntered();
      return lateCreator;
    }),
  });
  try {
    const running = service.run(evolutionInput(root, "creator-late-envelope", controller.signal));
    await didEnterCreator;
    controller.abort(new Error("detach late creator"));
    const result = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve("still-locked"), 1_000)),
    ]);
    assert.notEqual(result, "still-locked");
    assert.equal(result.status, "cancelled");
    assert.equal(records.length, 1);

    resolveCreator({
      text: '{"files":[{"path":"skills/creator.md","content":"late mutation\\n"}]}',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(readFileSync(path.join(root, "skills", "creator.md"), "utf8"), "creator v1\n");
    assert.equal(records.length, 1, "late provider settlement must not create a second record");
    assert.equal(
      git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/unclecode/evolve/"]),
      "",
      "late output must not recreate cleaned candidate resources",
    );
  } finally {
    controller.abort();
    resolveCreator({ text: '{"files":[]}' });
    rmSync(root, { recursive: true, force: true });
  }
});
