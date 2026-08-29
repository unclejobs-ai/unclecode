import assert from "node:assert/strict";
import test from "node:test";

import {
  PluginHost,
  registerBuiltInSccQualityEngine,
} from "@unclecode/plugin-host";

const proposal = {
  candidateId: "candidate-1",
  creatorId: "creator-1",
  isolatedBranch: "unclecode/evolve/candidate-1",
  isolatedWorktree: "/repo/.candidates/candidate-1",
  changedAssets: ["skills/creator.md"],
  evaluatorId: "evaluator-1",
  heldOutBenchmarkId: "held-out-v1",
  baselineScore: 0.7,
  candidateScore: 0.85,
  validationEvidence: [
    {
      kind: "artifact",
      artifactHash: "sha256:candidate",
      producerId: "creator-1",
      result: "pass",
      timestamp: "2026-08-28T12:00:00.000Z",
    },
    {
      kind: "reviewer",
      artifactHash: "sha256:candidate",
      producerId: "creator-1",
      reviewerId: "evaluator-1",
      result: "pass",
      timestamp: "2026-08-28T12:00:00.000Z",
    },
  ],
  humanApproval: "pending",
};

const context = {
  currentArtifactHash: "sha256:candidate",
  evaluatorAssets: ["host/evaluator.json"],
  policyAssets: ["AGENTS.md"],
  benchmarkAssets: ["bench/held-out.json"],
  evaluationTimestamp: "2026-08-28T12:00:00.000Z",
  maxAttestationAgeMs: 300_000,
  isolation: {
    candidateId: "candidate-1",
    candidateBranch: "unclecode/evolve/candidate-1",
    candidateWorktree: "/repo/.candidates/candidate-1",
    branchExists: true,
    worktreeExists: true,
    baseBranch: "main",
    baseWorktree: "/repo/.baseline/candidate-1",
    hostCurrentBranch: "feature/current",
    hostCurrentWorktree: "/repo/current",
    attestorId: "host-attestor",
    timestamp: "2026-08-28T12:00:00.000Z",
  },
};

function graph() {
  return {
    id: "creator-graph",
    qualityProfile: "creator",
    currentStage: "promote",
    gateStatus: "proceed",
    iteration: 0,
    approval: "approved",
    nodes: [],
  };
}

function completion(evolution) {
  return {
    runId: "creator-run",
    graph: graph(),
    projection: {
      runId: "creator-run",
      profile: "creator",
      currentStage: "promote",
      currentPhase: "act",
      score: null,
      failures: [],
      iteration: 0,
      refineCount: 0,
      pivotCount: 0,
      gateDecision: "proceed",
      completedStages: ["explore", "plan", "work", "critic", "promote"],
    },
    evidence: [
      {
        kind: "artifact",
        artifactHash: "sha256:current",
        producerId: "worker-1",
        result: "pass",
        timestamp: "2026-08-28T12:00:00.000Z",
      },
      {
        kind: "reviewer",
        artifactHash: "sha256:current",
        producerId: "worker-1",
        reviewerId: "critic-1",
        result: "pass",
        timestamp: "2026-08-28T12:00:00.000Z",
      },
    ],
    currentArtifactHash: "sha256:current",
    producerId: "worker-1",
    independentReviewerAvailable: true,
    reviewRequired: true,
    ...(evolution === undefined ? {} : { evolution }),
  };
}

test("creator completion proceeds only with the recorded fresh PR-ready proposal validated by evolutionProposed", async () => {
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: process.cwd() });

  const proposed = await host.dispatchEvolutionProposed({ runId: "creator-run", proposal, context });
  assert.equal(proposed.action, "proceed");

  const completed = await host.dispatchBeforeRunComplete(completion({
    proposalId: "evolution-1",
    proposal,
    context,
    state: "pr-ready",
    recorded: true,
    stale: false,
  }));
  assert.equal(completed.action, "proceed");
  assert.deepEqual(completed.failures, []);
});

test("creator profile, normal quality pass, and unrecorded worktree never satisfy completion", async (t) => {
  const cases = [
    {
      name: "profile and quality pass only",
      evolution: undefined,
      failure: "CREATOR_EVOLUTION_LIFECYCLE_UNAVAILABLE",
    },
    {
      name: "unrecorded worktree",
      evolution: {
        proposalId: "evolution-1",
        proposal,
        context,
        state: "pr-ready",
        recorded: false,
        stale: false,
      },
      failure: "CREATOR_EVOLUTION_NOT_RECORDED",
    },
    {
      name: "rejected candidate",
      evolution: {
        proposalId: "evolution-1",
        proposal,
        context,
        state: "rejected",
        recorded: true,
        stale: false,
      },
      failure: "CREATOR_EVOLUTION_NOT_PR_READY",
    },
    {
      name: "stale candidate",
      evolution: {
        proposalId: "evolution-1",
        proposal,
        context,
        state: "pr-ready",
        recorded: true,
        stale: true,
      },
      failure: "CREATOR_EVOLUTION_STALE",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const host = new PluginHost();
      registerBuiltInSccQualityEngine(host, { workspaceRoot: process.cwd() });
      const decision = await host.dispatchBeforeRunComplete(completion(fixture.evolution));
      assert.equal(decision.action, "block");
      assert.ok(decision.failures.includes(fixture.failure));
    });
  }
});

test("invalid or stale attestation still blocks creator completion", async (t) => {
  for (const fixture of [
    {
      name: "mismatched candidate",
      context: {
        ...context,
        isolation: { ...context.isolation, candidateId: "another-candidate" },
      },
      failure: "ISOLATION_ATTESTATION_MISMATCH",
    },
    {
      name: "stale attestation",
      context: {
        ...context,
        evaluationTimestamp: "2026-08-28T12:05:00.001Z",
      },
      failure: "STALE_ISOLATION_ATTESTATION",
    },
  ]) {
    await t.test(fixture.name, async () => {
      const host = new PluginHost();
      registerBuiltInSccQualityEngine(host, { workspaceRoot: process.cwd() });
      const decision = await host.dispatchBeforeRunComplete(completion({
        proposalId: "evolution-1",
        proposal,
        context: fixture.context,
        state: "pr-ready",
        recorded: true,
        stale: false,
      }));
      assert.equal(decision.action, "block");
      assert.ok(decision.failures.includes(fixture.failure));
    });
  }
});
