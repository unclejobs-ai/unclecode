import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHostHeldOutWorktreeEvaluator,
  createWorkCreatorEvolutionService,
  runBoundedCreatorOperation,
} from "../../apps/unclecode-cli/src/creator-evolution-runtime.ts";
import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";
import {
  HELD_OUT_V1_PROTECTED_ASSETS,
  runHeldOutComparison,
} from "../../scripts/held-out-benchmark.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const HELD_OUT_CASE_IDS = JSON.parse(readFileSync(
  path.join(REPO_ROOT, "benchmarks", "held-out", "v1", "cases.json"),
  "utf8",
)).cases.map((entry) => entry.id);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  for (const asset of [
    ...HELD_OUT_V1_PROTECTED_ASSETS,
    "benchmarks/held-out/v1/candidate.fixture.json",
  ]) {
    const target = path.join(root, asset);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(REPO_ROOT, asset), target);
  }
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

function tracedFakeAgent(provider, model, runTurn, clear = () => {}) {
  let listener;
  return {
    clear,
    setTraceListener(next) { listener = next; },
    updateRuntimeSettings() {},
    async runTurn(prompt, attachments, options) {
      listener?.({ type: "provider.route", provider, model });
      return await runTurn(prompt, attachments, options);
    },
  };
}

function workloadResponse(prefix) {
  return JSON.stringify({
    cases: HELD_OUT_CASE_IDS.map((id) => ({ id, response: `${prefix}:${id}` })),
  });
}

function comparisonScores(baselineScore = 0.7, candidateScore = 0.8) {
  return JSON.stringify({
    baselineCases: HELD_OUT_CASE_IDS.map((id) => ({ id, score: baselineScore })),
    candidateCases: HELD_OUT_CASE_IDS.map((id) => ({ id, score: candidateScore })),
  });
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
  let firstRun;
  let duplicateRun;
  try {
    firstRun = makeService().run(evolutionInput(root, "creator-never-settles", owner.signal));
    await didEnterCreator;
    duplicateRun = makeService().run(evolutionInput(root, "creator-never-settles", duplicate.signal));

    const results = await Promise.race([
      Promise.all([firstRun, duplicateRun]),
      new Promise((resolve) => setTimeout(() => resolve("still-locked"), 10_000)),
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
    await Promise.allSettled([firstRun, duplicateRun].filter(Boolean));
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

test("production creator uses the trusted held-out closure and rejects offline self-attestation", async () => {
  const root = createRepository();
  const records = [];
  try {
    const candidateFixture = "benchmarks/held-out/v1/candidate.fixture.json";
    const candidateTarget = path.join(root, candidateFixture);
    const candidate = JSON.parse(readFileSync(candidateTarget, "utf8"));
    candidate.liveProof = {
      providerRunId: "candidate-self-attested",
      fullVerificationMatrix: { status: "passed", artifactHash: `sha256:${"a".repeat(64)}` },
      independentFinalReview: {
        status: "passed",
        reviewerId: "candidate-reviewer",
        artifactHash: `sha256:${"b".repeat(64)}`,
      },
    };
    writeFileSync(candidateTarget, `${JSON.stringify(candidate, null, 2)}\n`);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "trusted held-out assets"]);

    const service = createWorkCreatorEvolutionService({
      cwd: root,
      env: { ...process.env },
      reasoning: {},
      recorder: fakeRecorder(records),
      createCreatorAgent: () => fakeAgent(async () => ({
        text: '{"files":[{"path":"skills/creator.md","content":"creator v2\\n"}]}',
      })),
    });
    const result = await service.run(evolutionInput(
      root,
      "creator-trusted-held-out",
      new AbortController().signal,
    ));

    assert.equal(result.projection.evaluatorId, "unclecode-held-out-evaluator-v1");
    assert.equal(result.projection.heldOutBenchmarkId, "unclecode-held-out-v1");
    assert.equal(result.projection.comparison?.passed, true);
    assert.equal(result.projection.comparison?.baselineScore, 0);
    assert.equal(result.projection.comparison?.candidateScore, 0);
    assert.equal(result.status, "rejected");
    assert.ok(result.projection.failures.includes("EVOLUTION_INTEGRATED_PROOF_UNPROVEN"));
    assert.equal(records.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host evaluation reads each isolated candidate and produces candidate-bound results", async () => {
  const root = createRepository();
  const records = [];
  const evaluatedCandidates = [];
  const evaluateHeldOutWorktrees = async ({ runId, baselineWorktree, candidateWorktree, signal }) => {
    signal.throwIfAborted();
    const creator = readFileSync(path.join(candidateWorktree, "skills", "creator.md"), "utf8");
    const candidateScore = creator === "creator v2\n" ? 0.8 : 0.9;
    evaluatedCandidates.push({ runId, baselineWorktree, candidateWorktree, creator });
    const baseline = JSON.parse(readFileSync(
      path.join(baselineWorktree, "benchmarks", "held-out", "v1", "baseline.json"),
      "utf8",
    ));
    const candidate = JSON.parse(readFileSync(
      path.join(candidateWorktree, "benchmarks", "held-out", "v1", "candidate.fixture.json"),
      "utf8",
    ));
    baseline.evidenceMode = "live-provider";
    baseline.measurementScope = "case";
    baseline.allocated = false;
    baseline.commit = git(baselineWorktree, ["rev-parse", "HEAD"]);
    candidate.evidenceMode = "live-provider";
    candidate.measurementScope = "case";
    candidate.allocated = false;
    candidate.commit = git(candidateWorktree, ["rev-parse", "HEAD"]);
    for (const entry of candidate.cases) entry.score = candidateScore;
    return {
      baselineResult: baseline,
      candidateResult: candidate,
      verification: {
        providerRunId: `host-provider-${runId}`,
        fullVerificationMatrix: {
          status: "passed",
          artifactHash: sha(`matrix:${runId}:${candidate.commit}`),
        },
        independentFinalReview: {
          status: "passed",
          reviewerId: `host-reviewer-${runId}`,
          artifactHash: sha(`review:${runId}:${candidate.commit}`),
        },
      },
    };
  };
  const runCandidate = async (runId, content) => createWorkCreatorEvolutionService({
    cwd: root,
    env: { ...process.env },
    reasoning: {},
    recorder: fakeRecorder(records),
    evaluateHeldOutWorktrees,
    createCreatorAgent: () => fakeAgent(async () => ({
      text: JSON.stringify({ files: [{ path: "skills/creator.md", content }] }),
    })),
  }).run(evolutionInput(root, runId, new AbortController().signal));

  try {
    const first = await runCandidate("creator-bound-v2", "creator v2\n");
    const second = await runCandidate("creator-bound-v3", "creator v3\n");

    assert.equal(first.status, "pr-ready");
    assert.equal(second.status, "pr-ready");
    assert.equal(first.projection.comparison?.candidateScore, 0.8);
    assert.equal(second.projection.comparison?.candidateScore, 0.9);
    assert.notEqual(first.projection.hashes.candidateArtifact, second.projection.hashes.candidateArtifact);
    assert.equal(first.projection.humanApproval, "pending");
    assert.equal(second.projection.humanApproval, "pending");
    assert.deepEqual(evaluatedCandidates.map((entry) => entry.creator), ["creator v2\n", "creator v3\n"]);
    assert.ok(evaluatedCandidates.every((entry) => entry.baselineWorktree !== entry.candidateWorktree));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the offline plus-8.8 fixture cannot authorize an unrelated isolated candidate", async () => {
  const root = createRepository();
  const records = [];
  try {
    const service = createWorkCreatorEvolutionService({
      cwd: root,
      env: { ...process.env },
      reasoning: {},
      recorder: fakeRecorder(records),
      createCreatorAgent: () => fakeAgent(async () => ({
        text: '{"files":[{"path":"skills/creator.md","content":"unrelated candidate\\n"}]}',
      })),
      async evaluateHeldOutWorktrees({ runId, baselineWorktree, candidateWorktree }) {
        const baseline = JSON.parse(readFileSync(
          path.join(baselineWorktree, "benchmarks", "held-out", "v1", "baseline.json"),
          "utf8",
        ));
        const fixture = JSON.parse(readFileSync(
          path.join(candidateWorktree, "benchmarks", "held-out", "v1", "candidate.fixture.json"),
          "utf8",
        ));
        baseline.evidenceMode = "live-provider";
        baseline.commit = git(baselineWorktree, ["rev-parse", "HEAD"]);
        fixture.evidenceMode = "live-provider";
        return {
          baselineResult: baseline,
          candidateResult: fixture,
          verification: {
            providerRunId: `host-provider-${runId}`,
            fullVerificationMatrix: { status: "passed", artifactHash: sha(`matrix:${runId}`) },
            independentFinalReview: {
              status: "passed",
              reviewerId: `host-reviewer-${runId}`,
              artifactHash: sha(`review:${runId}`),
            },
          },
        };
      },
    });
    const result = await service.run(evolutionInput(
      root,
      "creator-unrelated-fixture",
      new AbortController().signal,
    ));

    assert.equal(result.status, "failed");
    assert.ok(result.projection.failures.includes("EVOLUTION_EVALUATOR_FAILED"));
    assert.equal(result.projection.comparison, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production runtime owner reaches PR-ready only from sealed workload traces and three distinct providers", async () => {
  const root = createRepository();
  const home = path.join(root, ".unclecode", "test-home");
  mkdirSync(home, { recursive: true });
  const beforeHead = git(root, ["rev-parse", "HEAD"]);
  const beforeCreator = readFileSync(path.join(root, "skills", "creator.md"), "utf8");
  const workloadKinds = [];
  const cleared = [];
  let loaded;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "creator-key",
    DEEPSEEK_MODEL: "deepseek-creator",
    ANTHROPIC_API_KEY: "evaluator-key",
    ANTHROPIC_MODEL: "claude-evaluator",
    GEMINI_API_KEY: "reviewer-key",
    GEMINI_MODEL: "gemini-reviewer",
    UNCLECODE_REVIEW_PROVIDER: "anthropic",
    UNCLECODE_CREATOR_REVIEW_PROVIDER: "gemini",
    UNCLECODE_SESSION_STORE_ROOT: path.join(root, ".unclecode", "state"),
    UNCLECODE_OMP_BIN: path.join(root, "missing-omp"),
    UNCLECODE_OMP_BUN_BIN: path.join(root, "missing-bun"),
  };
  try {
    loaded = await loadWorkCliBootstrap({
      argv: ["--cwd", root, "--provider", "deepseek", "--engine", "native"],
      env,
      userHomeDir: home,
      creatorEvolutionRuntime: {
        createCreatorAgent: () => fakeAgent(async () => ({
          text: JSON.stringify({
            files: [{ path: "skills/creator.md", content: "creator v2 deterministic\n" }],
          }),
        })),
        createHeldOutWorkloadAgent({ kind, creatorSystemPrompt }) {
          workloadKinds.push({ kind, creatorSystemPrompt });
          return tracedFakeAgent("deepseek", "deepseek-creator", async () => ({
            text: workloadResponse(kind),
            usage: kind === "baseline"
              ? { inputTokens: 8_000, outputTokens: 4_000, cacheReadTokens: 100, cacheWriteTokens: 0 }
              : { inputTokens: 3_000, outputTokens: 1_000, cacheReadTokens: 600, cacheWriteTokens: 0 },
          }), () => cleared.push(`workload:${kind}`));
        },
        createHeldOutEvaluatorAgent: () => tracedFakeAgent(
          "anthropic",
          "claude-evaluator",
          async () => ({
            text: comparisonScores(),
            usage: { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
          }),
          () => cleared.push("evaluator"),
        ),
        createHeldOutReviewerAgent: () => tracedFakeAgent(
          "gemini",
          "gemini-reviewer",
          async (prompt) => ({
            text: JSON.stringify({ caseId: JSON.parse(prompt).case.id, verdict: "pass" }),
            usage: { inputTokens: 2_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          }),
          () => cleared.push("reviewer"),
        ),
      },
    });
    const service = loaded.agent.creatorEvolutionService;
    assert.ok(service, "the production owner must construct its creator evolution service");
    const result = await service.run(evolutionInput(
      root,
      "production-bootstrap-three-provider",
      new AbortController().signal,
    ));
    const proposal = result.projection;

    assert.equal(result.status, "pr-ready", JSON.stringify({ proposal, result }));
    assert.equal(proposal.state, "pr-ready");
    assert.equal(proposal.humanApproval, "pending");
    assert.equal(proposal.mergeRequiresHumanApproval, true);
    assert.equal(proposal.comparison.passed, true);
    assert.equal(proposal.comparison.baselineScore, 0.7);
    assert.equal(proposal.comparison.candidateScore, 0.8);
    assert.deepEqual(workloadKinds.map((entry) => entry.kind), ["baseline", "candidate"]);
    assert.match(workloadKinds[0].creatorSystemPrompt, /creator v1/);
    assert.match(workloadKinds[1].creatorSystemPrompt, /creator v2 deterministic/);
    assert.equal(cleared.filter((entry) => entry === "reviewer").length, 40);
    assert.deepEqual(
      cleared.filter((entry) => entry !== "reviewer").sort(),
      ["evaluator", "workload:baseline", "workload:candidate"],
    );
    assert.equal(git(root, ["rev-parse", "HEAD"]), beforeHead);
    assert.equal(git(root, ["branch", "--show-current"]), "main");
    assert.equal(readFileSync(path.join(root, "skills", "creator.md"), "utf8"), beforeCreator);
    assert.equal(git(root, ["status", "--short"]), "", "the primary worktree must remain untouched");
    assert.match(proposal.summary, /Human approval remains pending/);
  } finally {
    await loaded?.dispose?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production runtime owner keeps creator evolution unproven without provider-independent evaluator and reviewer", async () => {
  const root = createRepository();
  const home = path.join(root, ".unclecode", "test-home");
  mkdirSync(home, { recursive: true });
  let workloadCalls = 0;
  let loaded;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "only-provider-key",
    DEEPSEEK_MODEL: "deepseek-creator",
    UNCLECODE_REVIEW_PROVIDER: "deepseek",
    UNCLECODE_REVIEW_MODEL: "deepseek-review-model",
    UNCLECODE_SESSION_STORE_ROOT: path.join(root, ".unclecode", "state"),
    UNCLECODE_OMP_BIN: path.join(root, "missing-omp"),
    UNCLECODE_OMP_BUN_BIN: path.join(root, "missing-bun"),
  };
  try {
    loaded = await loadWorkCliBootstrap({
      argv: ["--cwd", root, "--provider", "deepseek", "--engine", "native"],
      env,
      userHomeDir: home,
      creatorEvolutionRuntime: {
        createCreatorAgent: () => fakeAgent(async () => ({
          text: '{"files":[{"path":"skills/creator.md","content":"creator v2\\n"}]}',
        })),
        createHeldOutWorkloadAgent() {
          workloadCalls += 1;
          throw new Error("same-provider fallback must not execute a fake live workload");
        },
      },
    });
    const service = loaded.agent.creatorEvolutionService;
    assert.ok(service, "the production owner must construct its fail-closed creator service");
    const result = await service.run(evolutionInput(
      root,
      "production-bootstrap-same-provider",
      new AbortController().signal,
    ));
    const proposal = result.projection;

    assert.equal(result.status, "rejected");
    assert.equal(proposal.state, "rejected");
    assert.ok(proposal.failures.includes("EVOLUTION_INTEGRATED_PROOF_UNPROVEN"));
    assert.equal(workloadCalls, 0);
    assert.equal(readFileSync(path.join(root, "skills", "creator.md"), "utf8"), "creator v1\n");
  } finally {
    await loaded?.dispose?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out host workload detaches its provider and cleans isolated resources", async () => {
  const root = createRepository();
  const records = [];
  let workloadClears = 0;
  const evaluator = createHostHeldOutWorktreeEvaluator({
    cwd: root,
    creator: { provider: "deepseek", model: "creator" },
    evaluator: { provider: "anthropic", model: "evaluator" },
    reviewer: { provider: "gemini", model: "reviewer" },
    evaluatorTurnTimeoutMs: 5,
    evaluatorAbortSettlementGraceMs: 10,
    createWorkloadAgent: () => tracedFakeAgent(
      "deepseek",
      "creator",
      () => new Promise(() => {}),
      () => { workloadClears += 1; },
    ),
    createEvaluatorAgent: () => {
      throw new Error("must not reach evaluator");
    },
    createReviewerAgent: () => {
      throw new Error("must not reach reviewer");
    },
  });
  const service = createWorkCreatorEvolutionService({
    cwd: root,
    env: { ...process.env },
    reasoning: {},
    recorder: fakeRecorder(records),
    evaluateHeldOutWorktrees: evaluator,
    createCreatorAgent: () => fakeAgent(async () => ({
      text: '{"files":[{"path":"skills/creator.md","content":"creator v2\\n"}]}',
    })),
  });
  try {
    const result = await Promise.race([
      service.run(evolutionInput(root, "creator-workload-timeout", new AbortController().signal)),
      // The provider boundary itself is 15ms; allow the surrounding Git
      // isolation cleanup enough time on a loaded CI host.
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 5_000)),
    ]);
    assert.notEqual(result, "still-pending");
    assert.equal(result.status, "failed");
    assert.ok(result.projection.failures.includes("EVOLUTION_EVALUATOR_FAILED"));
    assert.equal(workloadClears, 1);
    assert.equal(git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/unclecode/evolve/"]), "");
    assert.equal(readFileSync(path.join(root, "skills", "creator.md"), "utf8"), "creator v1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the host evaluator reads sealed Git blobs and rejects synthetic provider independence", async () => {
  const root = createRepository();
  const candidateWorktree = path.join(root, ".unclecode", "sealed-candidate");
  let candidatePrompt = "";
  try {
    assert.equal(createHostHeldOutWorktreeEvaluator({
      cwd: root,
      creator: { provider: "deepseek", model: "creator" },
      evaluator: { provider: "anthropic", model: "judge" },
      reviewer: { provider: "anthropic", model: "different-review-model" },
      createWorkloadAgent: () => fakeAgent(async () => ({ text: "unused" })),
      createEvaluatorAgent: () => fakeAgent(async () => ({ text: "unused" })),
      createReviewerAgent: () => fakeAgent(async () => ({ text: "unused" })),
    }), undefined, "same-provider/different-model identities must remain unproven");

    git(root, ["worktree", "add", "-b", "sealed-candidate", candidateWorktree]);
    writeFileSync(path.join(candidateWorktree, "skills", "creator.md"), "sealed candidate guidance\n");
    git(candidateWorktree, ["add", "skills/creator.md"]);
    git(candidateWorktree, ["commit", "-m", "sealed candidate"]);
    const candidateCommit = git(candidateWorktree, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(candidateWorktree, "skills", "creator.md"), "DIRTY PROMPT INJECTION\n");

    const makeEvaluator = (reviewCase) => createHostHeldOutWorktreeEvaluator({
      cwd: root,
      creator: { provider: "deepseek", model: "creator" },
      evaluator: { provider: "anthropic", model: "judge" },
      reviewer: { provider: "gemini", model: "reviewer" },
      createWorkloadAgent({ kind, creatorSystemPrompt }) {
        if (kind === "candidate") candidatePrompt = creatorSystemPrompt;
        return tracedFakeAgent("deepseek", "creator", async () => ({
          text: workloadResponse(kind),
          usage: kind === "baseline"
            ? { inputTokens: 8_000, outputTokens: 4_000 }
            : { inputTokens: 3_000, outputTokens: 1_000 },
        }));
      },
      createEvaluatorAgent: () => tracedFakeAgent("anthropic", "judge", async () => ({
        text: comparisonScores(),
        usage: { inputTokens: 2_000, outputTokens: 500 },
      })),
      createReviewerAgent: () => tracedFakeAgent("gemini", "reviewer", async (prompt) => ({
        text: JSON.stringify(reviewCase(JSON.parse(prompt).case.id)),
        usage: { inputTokens: 2_000, outputTokens: 20 },
      })),
    });
    const evaluator = makeEvaluator((caseId) => ({ caseId, verdict: "pass" }));
    const result = await evaluator({
      runId: "sealed-git-blob",
      baselineWorktree: root,
      candidateWorktree,
      signal: new AbortController().signal,
    });

    assert.equal(result.candidateResult.commit, candidateCommit);
    assert.equal(result.candidateResult.measurementScope, "suite");
    assert.equal(result.candidateResult.allocated, true);
    assert.equal(
      result.candidateResult.aggregateMetrics.frontierTokens,
      result.candidateResult.cases.reduce(
        (total, entry) => total + entry.metrics.frontierTokens,
        0,
      ),
    );
    assert.match(candidatePrompt, /sealed candidate guidance/);
    assert.doesNotMatch(candidatePrompt, /DIRTY PROMPT INJECTION/);
    assert.equal(readFileSync(path.join(candidateWorktree, "skills", "creator.md"), "utf8"), "DIRTY PROMPT INJECTION\n");

    const failedReview = await makeEvaluator((caseId) => ({
      caseId,
      verdict: caseId === "code-01" ? "fail" : "pass",
    }))({
      runId: "one-case-review-failed",
      baselineWorktree: root,
      candidateWorktree,
      signal: new AbortController().signal,
    });
    const failedReport = runHeldOutComparison({
      suiteRoot: path.join(root, "benchmarks", "held-out", "v1"),
      baselineResult: failedReview.baselineResult,
      candidateResult: failedReview.candidateResult,
      trustedProof: failedReview.verification,
    });
    assert.equal(failedReview.verification.independentFinalReview.status, "failed");
    assert.equal(failedReport.candidate.measurementScope, "suite");
    assert.equal(failedReport.candidate.allocated, true);
    assert.equal(Object.hasOwn(failedReport.candidate, "latencyMs"), false);
    assert.equal(Object.hasOwn(failedReport.candidate, "cacheHitRatePercent"), false);
    assert.equal(
      failedReport.candidate.suiteMetrics.latencyMs,
      failedReview.candidateResult.aggregateMetrics.latencyMs,
    );
    assert.equal(failedReport.integratedProof.status, "unproven");
    assert.ok(failedReport.integratedProof.reasons.includes("COMPARISON_GATES_FAILED"));
    assert.ok(failedReport.integratedProof.reasons.includes("INDEPENDENT_FINAL_REVIEW_NOT_PROVEN"));

    await assert.rejects(() => makeEvaluator((caseId) => ({
      caseId: caseId === "code-02" ? "wrong-case" : caseId,
      verdict: "pass",
    }))({
      runId: "malformed-case-review",
      baselineWorktree: root,
      candidateWorktree,
      signal: new AbortController().signal,
    }), /case-bound pass or fail verdict/);
  } finally {
    try { git(root, ["worktree", "remove", "--force", candidateWorktree]); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
