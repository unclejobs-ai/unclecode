import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CreatorEvolutionService,
  MAX_EVOLUTION_SUMMARY_CHARS,
} from "@unclecode/orchestrator";
import {
  PluginHost,
  registerBuiltInSccQualityEngine,
} from "@unclecode/plugin-host";

const NOW = "2026-08-28T12:00:00.000Z";
const BASE_COMMIT = "1111111111111111111111111111111111111111";
const CANDIDATE_COMMIT = "2222222222222222222222222222222222222222";

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function config(overrides = {}) {
  return {
    evaluator: {
      id: "host-evaluator-v1",
      definition: "UncleCode immutable executable-check evaluator",
      version: "1.0.0",
      assets: ["host/evaluator.json"],
    },
    policyAssets: ["AGENTS.md"],
    evaluatorEnvironmentHash: sha("locale=C;timezone=UTC;network=disabled"),
    suite: {
      id: "held-out-suite-v1",
      version: "1.0.0",
      assets: ["bench/held-out.json"],
      checks: [
        { id: "contract", weight: 0.6 },
        { id: "regression", weight: 0.4 },
      ],
      thresholds: {
        minimumCandidateScore: 0.8,
        minimumDelta: 0.05,
        maximumRegression: 0,
      },
      environment: { locale: "C", timezone: "UTC", network: "disabled" },
    },
    attestorId: "unclecode-host-attestor",
    maxAttestationAgeMs: 5 * 60_000,
    bounds: {
      creatorTimeoutMs: 60_000,
      evaluatorTimeoutMs: 60_000,
      maxOutputBytes: 16_384,
      maxChangedAssets: 32,
    },
    ...overrides,
  };
}

function candidateSnapshot(overrides = {}) {
  return {
    baseCommit: BASE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    patchHash: sha("candidate patch v1"),
    changedAssets: [
      { path: "skills/creator.md", sha256: sha("creator v2"), kind: "file", size: 10 },
    ],
    ...overrides,
  };
}

function protectedSnapshot(overrides = {}) {
  return {
    entries: [
      { path: "host/evaluator.json", sha256: sha("evaluator v1"), kind: "file", size: 12 },
      { path: "AGENTS.md", sha256: sha("policy v1"), kind: "file", size: 9 },
      { path: "bench/held-out.json", sha256: sha("suite v1"), kind: "file", size: 8 },
    ],
    ...overrides,
  };
}

function evaluation(overrides = {}) {
  return {
    status: "completed",
    environmentHash: sha("locale=C;timezone=UTC;network=disabled"),
    baseline: {
      score: 0.72,
      summary: "baseline completed",
      checks: [
        { id: "contract", status: "passed", score: 0.7, durationMs: 10 },
        { id: "regression", status: "passed", score: 0.75, durationMs: 11 },
      ],
    },
    candidate: {
      score: 0.84,
      summary: "candidate completed",
      checks: [
        { id: "contract", status: "passed", score: 0.82, durationMs: 12 },
        { id: "regression", status: "passed", score: 0.87, durationMs: 13 },
      ],
    },
    ...overrides,
  };
}

function makeHost(overrides = {}) {
  const calls = [];
  const records = [];
  const candidateSnapshots = [...(overrides.candidateSnapshots ?? [candidateSnapshot()])];
  const protectedSnapshots = [...(overrides.protectedSnapshots ?? [protectedSnapshot()])];
  const state = {
    calls,
    records,
    prepareCount: 0,
    creatorCount: 0,
    evaluatorCount: 0,
    cleanupCount: 0,
  };
  const host = {
    state,
    async loadRecord({ runId }) {
      calls.push(`load:${runId}`);
      return records.find((entry) => entry.result.projection.runId === runId);
    },
    async verifyRecordedCandidate() {
      calls.push("verify-recorded");
      return overrides.recordedVerificationFailures ?? [];
    },
    async resolveBase() {
      calls.push("resolve-base");
      return {
        baseCommit: BASE_COMMIT,
        baseBranch: "main",
        baseWorktree: "/repo/.baseline/run-1",
        hostCurrentBranch: "feature/current",
        hostCurrentWorktree: "/repo/current",
      };
    },
    async prepareCandidate(input) {
      calls.push("prepare");
      state.prepareCount += 1;
      return {
        candidateId: input.candidateId,
        branch: input.branch,
        worktree: `/repo/.candidates/${input.candidateId}`,
        baselineWorktree: "/repo/.baseline/run-1",
        resources: [
          { kind: "branch", identity: input.branch },
          { kind: "worktree", identity: `/repo/.candidates/${input.candidateId}` },
          { kind: "baseline-worktree", identity: "/repo/.baseline/run-1" },
        ],
      };
    },
    async snapshotProtectedAssets() {
      calls.push("snapshot-protected");
      return protectedSnapshots.length > 1
        ? protectedSnapshots.shift()
        : protectedSnapshots[0];
    },
    async runCreator(input) {
      calls.push("creator");
      state.creatorCount += 1;
      assert.deepEqual(input.mutableTargets, ["skills/creator.md"]);
      return overrides.creatorResult ?? { status: "completed", summary: "creator completed" };
    },
    async inspectCandidate() {
      calls.push("inspect-candidate");
      return candidateSnapshots.length > 1
        ? candidateSnapshots.shift()
        : candidateSnapshots[0];
    },
    async sealCandidate() {
      calls.push("seal-candidate");
    },
    async runEvaluator(input) {
      calls.push("evaluate");
      state.evaluatorCount += 1;
      assert.equal(input.baselineWorktree, "/repo/.baseline/run-1");
      assert.match(input.candidateWorktree, /\.candidates/);
      assert.equal(input.evaluator.id, "host-evaluator-v1");
      assert.equal(input.suite.id, "held-out-suite-v1");
      assert.equal(Object.isFrozen(input.evaluator), true);
      assert.equal(Object.isFrozen(input.suite), true);
      assert.deepEqual(input.suite.checks.map((entry) => entry.id), ["contract", "regression"]);
      return overrides.evaluationResult ?? evaluation();
    },
    async resolveIsolation(input) {
      calls.push("resolve-isolation");
      return overrides.isolation ?? {
        candidateId: input.candidate.candidateId,
        candidateBranch: input.candidate.branch,
        candidateWorktree: input.candidate.worktree,
        branchExists: true,
        worktreeExists: true,
        baseBranch: "main",
        baseWorktree: "/repo/.baseline/run-1",
        hostCurrentBranch: "feature/current",
        hostCurrentWorktree: "/repo/current",
        attestorId: "unclecode-host-attestor",
        timestamp: NOW,
      };
    },
    async cleanup(input) {
      calls.push(input.retainCandidate ? "cleanup-retain" : "cleanup-remove");
      state.cleanupCount += 1;
      if (overrides.cleanupError) throw overrides.cleanupError;
      return {
        status: input.retainCandidate ? "retained" : "completed",
        resources: input.resources.map((resource) => ({
          ...resource,
          status: input.retainCandidate && resource.kind !== "baseline-worktree"
            ? "retained"
            : "removed",
        })),
      };
    },
    async record(input) {
      calls.push("record");
      const existing = records.findIndex((entry) =>
        entry.result.projection.id === input.result.projection.id
      );
      if (existing === -1) records.push(input);
      else records[existing] = input;
    },
  };
  return host;
}

function makeDispatch() {
  const pluginHost = new PluginHost();
  registerBuiltInSccQualityEngine(pluginHost, { workspaceRoot: process.cwd() });
  let count = 0;
  pluginHost.register("evolution-observer", {
    evolutionProposed() {
      count += 1;
      return { action: "proceed" };
    },
  });
  return {
    get count() {
      return count;
    },
    dispatch: (event) => pluginHost.dispatchEvolutionProposed(event),
  };
}

function runInput(dispatch, overrides = {}) {
  return {
    runId: "quality-run-1",
    workspaceRoot: "/repo/current",
    prompt: "Create a stronger creator skill without changing its evaluator.",
    creatorId: "creator-agent-v1",
    mutableTargets: ["skills/creator.md"],
    dispatchEvolutionProposed: dispatch,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("a distinct creator, evaluator, and attestor records one isolated PR-ready proposal", async () => {
  const host = makeHost();
  const lifecycleDispatch = makeDispatch();
  const service = new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  });

  const result = await service.run(runInput(lifecycleDispatch.dispatch));

  assert.equal(result.status, "pr-ready");
  assert.equal(result.projection.state, "pr-ready");
  assert.equal(result.projection.isolation, "worktree");
  assert.equal(result.projection.heldOutBenchmark, true);
  assert.equal(result.projection.heldOutBenchmarkId, "held-out-suite-v1");
  assert.equal(result.projection.evaluatorId, "host-evaluator-v1");
  assert.equal(result.projection.attestorId, "unclecode-host-attestor");
  assert.equal(result.projection.humanApproval, "pending");
  assert.equal(result.projection.mergeRequiresHumanApproval, true);
  assert.equal(result.projection.stale, false);
  assert.equal(result.projection.comparison.passed, true);
  assert.deepEqual(
    [result.projection.comparison.baselineScore, result.projection.comparison.candidateScore],
    [0.72, 0.84],
  );
  assert.equal(result.proposal.creatorId, "creator-agent-v1");
  assert.equal(result.proposal.evaluatorId, "host-evaluator-v1");
  assert.equal(result.context.isolation.attestorId, "unclecode-host-attestor");
  assert.equal(result.context.isolation.timestamp, NOW);
  assert.equal(result.context.maxAttestationAgeMs, 300_000);
  assert.equal(result.projection.attestation.maxAgeMs, 300_000);
  assert.equal(result.projection.hashes.baseCommit, BASE_COMMIT);
  assert.equal(result.projection.hashes.candidateCommit, CANDIDATE_COMMIT);
  assert.equal(result.projection.hashes.patch, sha("candidate patch v1"));
  assert.match(result.projection.hashes.evaluator, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.projection.hashes.evaluatorEnvironment, config().evaluatorEnvironmentHash);
  assert.match(result.proposal.validationEvidence[0].artifactHash, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(result.proposal.validationEvidence[0].artifactHash, result.projection.hashes.candidateArtifact);
  assert.match(result.projection.hashes.policy, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.projection.hashes.suite, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.projection.hashes.baselineResult, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.projection.hashes.candidateResult, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.projection.changedAssets, [{
    path: "skills/creator.md",
    sha256: sha("creator v2"),
  }]);
  assert.equal(result.projection.cleanup.status, "retained");
  assert.deepEqual(
    result.projection.cleanup.resources.map(({ kind, status }) => ({ kind, status })),
    [
      { kind: "branch", status: "retained" },
      { kind: "worktree", status: "retained" },
      { kind: "baseline-worktree", status: "removed" },
    ],
  );
  assert.equal(lifecycleDispatch.count, 1);
  assert.equal(host.state.prepareCount, 1);
  assert.equal(host.state.creatorCount, 1);
  assert.equal(host.state.evaluatorCount, 1);
  assert.equal(host.state.cleanupCount, 1);
  assert.equal(host.state.records.length, 1);
  assert.ok(host.state.calls.indexOf("evaluate") < host.state.calls.indexOf("resolve-isolation"));
  assert.ok(host.state.calls.indexOf("resolve-isolation") < host.state.calls.indexOf("record"));
  assert.deepEqual(
    host.state.calls.filter((call) => /merge|publish|release|push/i.test(call)),
    [],
  );
});

test("creator/evaluator conflict and self-attestation fail before candidate creation", async (t) => {
  for (const fixture of [
    {
      name: "creator evaluates itself",
      config: config({ evaluator: { ...config().evaluator, id: "creator-agent-v1" } }),
      failure: "CREATOR_EVALUATOR_CONFLICT",
    },
    {
      name: "creator attests itself",
      config: config({ attestorId: "creator-agent-v1" }),
      failure: "ISOLATION_ATTESTOR_CONFLICT",
    },
    {
      name: "evaluator attests itself",
      config: config({ attestorId: "host-evaluator-v1" }),
      failure: "ISOLATION_ATTESTOR_CONFLICT",
    },
  ]) {
    await t.test(fixture.name, async () => {
      const host = makeHost();
      const lifecycleDispatch = makeDispatch();
      const service = new CreatorEvolutionService({
        config: fixture.config,
        host,
        now: () => new Date(NOW),
      });
      const result = await service.run(runInput(lifecycleDispatch.dispatch));
      assert.equal(result.status, "failed");
      assert.ok(result.projection.failures.includes(fixture.failure));
      assert.equal(host.state.prepareCount, 0);
      assert.equal(lifecycleDispatch.count, 0);
    });
  }
});

test("missing, nonexistent, base/current, stale, future, and noncanonical isolation fail closed", async (t) => {
  const valid = makeHost().resolveIsolation;
  const baseIsolation = {
    candidateId: "placeholder",
    candidateBranch: "placeholder",
    candidateWorktree: "placeholder",
    branchExists: true,
    worktreeExists: true,
    baseBranch: "main",
    baseWorktree: "/repo/.baseline/run-1",
    hostCurrentBranch: "feature/current",
    hostCurrentWorktree: "/repo/current",
    attestorId: "unclecode-host-attestor",
    timestamp: NOW,
  };
  const cases = [
    { name: "missing", isolation: undefined, failure: "MISSING_ISOLATION_ATTESTATION" },
    { name: "branch missing", patch: { branchExists: false }, failure: "ISOLATED_BRANCH_NOT_FOUND" },
    { name: "worktree missing", patch: { worktreeExists: false }, failure: "ISOLATED_WORKTREE_NOT_FOUND" },
    { name: "base branch", patch: { candidateBranch: "main" }, failure: "BRANCH_NOT_ISOLATED" },
    { name: "current branch", patch: { candidateBranch: "feature/current" }, failure: "BRANCH_NOT_ISOLATED" },
    { name: "base worktree", patch: { candidateWorktree: "/repo/.baseline/run-1" }, failure: "WORKTREE_NOT_ISOLATED" },
    { name: "current worktree", patch: { candidateWorktree: "/repo/current" }, failure: "WORKTREE_NOT_ISOLATED" },
    { name: "stale", patch: { timestamp: "2026-08-28T11:54:59.999Z" }, failure: "STALE_ISOLATION_ATTESTATION" },
    { name: "future", patch: { timestamp: "2026-08-28T12:00:00.001Z" }, failure: "INVALID_ISOLATION_ATTESTATION" },
    { name: "noncanonical", patch: { timestamp: "2026-08-28T12:00:00Z" }, failure: "INVALID_ISOLATION_ATTESTATION" },
  ];
  assert.equal(typeof valid, "function");
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const host = makeHost({
        isolation: fixture.isolation === undefined && fixture.name === "missing"
          ? undefined
          : { ...baseIsolation, ...(fixture.patch ?? {}) },
      });
      if (fixture.name === "missing") {
        host.resolveIsolation = async () => undefined;
      } else {
        const original = host.resolveIsolation;
        host.resolveIsolation = async (input) => {
          const resolved = await original(input);
          return {
            ...resolved,
            ...(fixture.patch?.candidateBranch === undefined
              ? { candidateBranch: input.candidate.branch }
              : {}),
            ...(fixture.patch?.candidateWorktree === undefined
              ? { candidateWorktree: input.candidate.worktree }
              : {}),
            candidateId: input.candidate.candidateId,
          };
        };
      }
      const lifecycleDispatch = makeDispatch();
      const result = await new CreatorEvolutionService({
        config: config(),
        host,
        now: () => new Date(NOW),
      }).run(runInput(lifecycleDispatch.dispatch));
      assert.notEqual(result.status, "pr-ready");
      assert.ok(result.projection.failures.includes(fixture.failure), JSON.stringify(result.projection.failures));
      assert.equal(host.state.cleanupCount, 1);
      assert.equal(result.projection.cleanup.status, "completed");
    });
  }
});

test("protected mutation, unsafe entries, path escape, and undeclared changes block before evaluation", async (t) => {
  const unsafe = [
    {
      name: "evaluator mutation",
      snapshots: [protectedSnapshot(), protectedSnapshot({ entries: [
        { path: "host/evaluator.json", sha256: sha("evaluator changed"), kind: "file", size: 12 },
        ...protectedSnapshot().entries.slice(1),
      ] })],
      failure: "EVOLUTION_EVALUATOR_ASSET_MUTATED",
    },
    {
      name: "policy mutation",
      snapshots: [protectedSnapshot(), protectedSnapshot({ entries: [
        protectedSnapshot().entries[0],
        { path: "AGENTS.md", sha256: sha("policy changed"), kind: "file", size: 9 },
        protectedSnapshot().entries[2],
      ] })],
      failure: "EVOLUTION_POLICY_ASSET_MUTATED",
    },
    {
      name: "benchmark mutation",
      snapshots: [protectedSnapshot(), protectedSnapshot({ entries: [
        ...protectedSnapshot().entries.slice(0, 2),
        { path: "bench/held-out.json", sha256: sha("suite changed"), kind: "file", size: 8 },
      ] })],
      failure: "EVOLUTION_BENCHMARK_ASSET_MUTATED",
    },
    {
      name: "symlink",
      candidate: candidateSnapshot({ changedAssets: [
        { path: "skills/creator.md", sha256: sha("link"), kind: "symlink", size: 1 },
      ] }),
      failure: "EVOLUTION_UNSUPPORTED_ASSET",
    },
    {
      name: "special entry",
      candidate: candidateSnapshot({ changedAssets: [
        { path: "skills/creator.md", sha256: sha("fifo"), kind: "special", size: 0 },
      ] }),
      failure: "EVOLUTION_UNSUPPORTED_ASSET",
    },
    {
      name: "unreadable entry",
      candidate: candidateSnapshot({ changedAssets: [
        { path: "skills/creator.md", sha256: "", kind: "unreadable", size: 0 },
      ] }),
      failure: "EVOLUTION_UNSUPPORTED_ASSET",
    },
    {
      name: "path escape",
      candidate: candidateSnapshot({ changedAssets: [
        { path: "../AGENTS.md", sha256: sha("escape"), kind: "file", size: 4 },
      ] }),
      failure: "EVOLUTION_PATH_ESCAPE",
    },
    {
      name: "nested repository control",
      candidate: candidateSnapshot({ changedAssets: [
        { path: "skills/.git/config", sha256: sha("control"), kind: "file", size: 4 },
      ] }),
      failure: "EVOLUTION_REPOSITORY_CONTROL_MODIFIED",
    },
    {
      name: "undeclared asset",
      candidate: candidateSnapshot({ changedAssets: [
        { path: "src/not-allowed.ts", sha256: sha("undeclared"), kind: "file", size: 4 },
      ] }),
      failure: "EVOLUTION_UNDECLARED_ASSET",
    },
  ];

  for (const fixture of unsafe) {
    await t.test(fixture.name, async () => {
      const host = makeHost({
        ...(fixture.snapshots ? { protectedSnapshots: fixture.snapshots } : {}),
        ...(fixture.candidate ? { candidateSnapshots: [fixture.candidate] } : {}),
      });
      const lifecycleDispatch = makeDispatch();
      const result = await new CreatorEvolutionService({
        config: config(),
        host,
        now: () => new Date(NOW),
      }).run(runInput(lifecycleDispatch.dispatch));
      assert.notEqual(result.status, "pr-ready");
      assert.ok(result.projection.failures.includes(fixture.failure), JSON.stringify(result.projection.failures));
      assert.equal(host.state.evaluatorCount, fixture.snapshots ? 1 : 0);
      assert.equal(lifecycleDispatch.count, 0);
      assert.equal(result.projection.cleanup.status, "completed");
    });
  }
});

test("the evaluator receives one immutable same-suite comparison and failures never become PR-ready", async (t) => {
  const cases = [
    {
      name: "threshold miss",
      evaluationResult: evaluation({
        candidate: { ...evaluation().candidate, score: 0.75 },
      }),
      status: "rejected",
      failure: "EVOLUTION_THRESHOLD_FAILED",
    },
    {
      name: "evaluator failure",
      evaluationResult: { status: "failed", summary: "evaluator exited 2" },
      status: "failed",
      failure: "EVOLUTION_EVALUATOR_FAILED",
    },
    {
      name: "evaluator timeout",
      evaluationResult: { status: "timeout", summary: "timed out" },
      status: "failed",
      failure: "EVOLUTION_EVALUATOR_TIMEOUT",
    },
    {
      name: "evaluator cancellation",
      evaluationResult: { status: "cancelled", summary: "cancelled" },
      status: "cancelled",
      failure: "EVOLUTION_CANCELLED",
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const host = makeHost({ evaluationResult: fixture.evaluationResult });
      const lifecycleDispatch = makeDispatch();
      const result = await new CreatorEvolutionService({
        config: config(),
        host,
        now: () => new Date(NOW),
      }).run(runInput(lifecycleDispatch.dispatch));
      assert.equal(result.status, fixture.status);
      assert.equal(result.projection.state, fixture.status);
      assert.ok(result.projection.failures.includes(fixture.failure));
      assert.equal(result.projection.comparison?.passed ?? false, false);
      assert.equal(result.projection.humanApproval, "pending");
      assert.equal(lifecycleDispatch.count, 0);
      assert.equal(result.projection.cleanup.status, "completed");
    });
  }
});

test("a syntactically valid but unexpected evaluator environment hash fails closed", async () => {
  const host = makeHost({
    evaluationResult: evaluation({ environmentHash: sha("network=enabled") }),
  });
  const lifecycleDispatch = makeDispatch();
  const result = await new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  }).run(runInput(lifecycleDispatch.dispatch));

  assert.equal(result.status, "failed");
  assert.ok(result.projection.failures.includes("EVOLUTION_EVALUATION_ENVIRONMENT_MISMATCH"));
  assert.equal(lifecycleDispatch.count, 0);
  assert.equal(result.projection.cleanup.status, "completed");
});

test("caller mutation cannot replace the evaluator, suite, environment, or thresholds after construction", async () => {
  const mutableConfig = config();
  const host = makeHost();
  const lifecycleDispatch = makeDispatch();
  const service = new CreatorEvolutionService({
    config: mutableConfig,
    host,
    now: () => new Date(NOW),
  });

  mutableConfig.evaluator.id = "creator-agent-v1";
  mutableConfig.evaluator.assets.push("creator-selected-evaluator.json");
  mutableConfig.policyAssets.push("creator-selected-policy.md");
  mutableConfig.suite.id = "creator-selected-suite";
  mutableConfig.suite.checks[0].id = "creator-selected-check";
  mutableConfig.suite.thresholds.minimumCandidateScore = 0.99;
  mutableConfig.suite.environment.network = "enabled";

  const result = await service.run(runInput(lifecycleDispatch.dispatch));
  assert.equal(result.status, "pr-ready");
  assert.equal(result.projection.evaluatorId, "host-evaluator-v1");
  assert.equal(result.projection.heldOutBenchmarkId, "held-out-suite-v1");
  assert.equal(result.projection.comparison.passed, true);
  assert.equal(lifecycleDispatch.count, 1);
});

test("post-evaluation candidate mutation invalidates evidence and evaluator output is bounded and redacted", async () => {
  const hugeSecret = `${"candidate output ".repeat(200)}sk-live-secret-value`;
  const host = makeHost({
    candidateSnapshots: [
      candidateSnapshot(),
      candidateSnapshot(),
      candidateSnapshot({ patchHash: sha("candidate patch mutated after evaluation") }),
    ],
    evaluationResult: evaluation({
      candidate: { ...evaluation().candidate, summary: hugeSecret },
    }),
  });
  const lifecycleDispatch = makeDispatch();
  const result = await new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  }).run(runInput(lifecycleDispatch.dispatch));

  assert.equal(result.status, "stale");
  assert.equal(result.projection.stale, true);
  assert.ok(result.projection.failures.includes("EVOLUTION_CANDIDATE_STALE"));
  assert.ok(result.projection.summary.length <= MAX_EVOLUTION_SUMMARY_CHARS);
  assert.doesNotMatch(result.projection.summary, /sk-live-secret-value/);
  assert.equal(lifecycleDispatch.count, 0);
  assert.equal(result.projection.cleanup.status, "completed");
});

test("post-completion verification invalidates and cleans a retained candidate that changes", async () => {
  const original = candidateSnapshot();
  const host = makeHost({
    candidateSnapshots: [
      original,
      original,
      original,
      original,
      candidateSnapshot({ patchHash: sha("changed after completion hooks") }),
    ],
    protectedSnapshots: [protectedSnapshot(), protectedSnapshot(), protectedSnapshot()],
  });
  const lifecycleDispatch = makeDispatch();
  const service = new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  });
  const result = await service.run(runInput(lifecycleDispatch.dispatch));
  assert.equal(result.status, "pr-ready");

  const verified = await service.verifyFresh(result);

  assert.equal(verified.status, "stale");
  assert.equal(verified.recorded, true);
  assert.equal(verified.projection.stale, true);
  assert.ok(verified.projection.failures.includes("EVOLUTION_CANDIDATE_STALE"));
  assert.equal(verified.projection.cleanup.status, "completed");
  assert.equal(host.state.cleanupCount, 2);
  assert.equal(host.state.records.length, 1);
  assert.equal(host.state.records[0].result.status, "stale");
});

test("duplicate and crash-resume invocation reuse one recorded candidate without duplicate work", async () => {
  const host = makeHost();
  const lifecycleDispatch = makeDispatch();
  const service = new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  });

  const [first, duplicate] = await Promise.all([
    service.run(runInput(lifecycleDispatch.dispatch)),
    service.run(runInput(lifecycleDispatch.dispatch)),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(host.state.prepareCount, 1);
  assert.equal(host.state.creatorCount, 1);
  assert.equal(host.state.evaluatorCount, 1);
  assert.equal(lifecycleDispatch.count, 1);
  assert.equal(host.state.records.length, 1);

  const resumedService = new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  });
  const resumed = await resumedService.run(runInput(lifecycleDispatch.dispatch));
  assert.deepEqual(resumed, first);
  assert.equal(host.state.prepareCount, 1, "recorded crash-resume state must not create another worktree");
  assert.equal(lifecycleDispatch.count, 1, "recorded crash-resume state must not redispatch validation");
});

test("a changed expected evaluator environment stales a recorded PR-ready proposal", async () => {
  const host = makeHost();
  const lifecycleDispatch = makeDispatch();
  const first = await new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  }).run(runInput(lifecycleDispatch.dispatch));
  assert.equal(first.status, "pr-ready");

  const resumed = await new CreatorEvolutionService({
    config: config({ evaluatorEnvironmentHash: sha("different-contained-runtime") }),
    host,
    now: () => new Date(NOW),
  }).run(runInput(lifecycleDispatch.dispatch));

  assert.equal(resumed.status, "stale");
  assert.ok(resumed.projection.failures.includes("EVOLUTION_EVALUATION_ENVIRONMENT_MISMATCH"));
  assert.equal(host.state.prepareCount, 1);
  assert.equal(host.state.cleanupCount, 2);
});

test("failure cleanup status is recorded honestly when resource cleanup itself fails", async () => {
  const host = makeHost({
    evaluationResult: { status: "failed", summary: "evaluator failed" },
    cleanupError: new Error("worktree busy"),
  });
  const lifecycleDispatch = makeDispatch();
  const result = await new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  }).run(runInput(lifecycleDispatch.dispatch));

  assert.equal(result.status, "failed");
  assert.equal(result.projection.cleanup.status, "failed");
  assert.match(result.projection.cleanup.summary, /worktree busy/);
  assert.ok(result.projection.failures.includes("EVOLUTION_CLEANUP_FAILED"));
  assert.equal(host.state.records.length, 1);
});
