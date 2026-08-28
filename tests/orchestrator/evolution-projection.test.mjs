import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentConsoleSnapshot,
  EXECUTION_TRACE_EVENT_TYPES,
  parseAgentConsoleSnapshot,
} from "@unclecode/contracts";
import { applyTraceEventToAgentConsole } from "@unclecode/orchestrator";

const HASH = `sha256:${"a".repeat(64)}`;

function snapshot() {
  return createAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents: [],
    jobs: [],
  });
}

function proposal(id = "evolution-1", overrides = {}) {
  return {
    id,
    runId: `run-${id}`,
    candidateId: `candidate-${id}`,
    creatorId: "creator-openai",
    evaluatorId: "held-out-evaluator",
    attestorId: "unclecode-git-attestor",
    state: "pr-ready",
    isolation: "worktree",
    isolatedBranch: `unclecode/evolve/${id}`,
    isolatedWorktree: `/private/worktrees/${id}`,
    heldOutBenchmark: true,
    heldOutBenchmarkId: "held-out-suite-v1",
    humanApproval: "pending",
    mergeRequiresHumanApproval: true,
    stale: false,
    changedAssets: [{ path: "skills/example/SKILL.md", sha256: HASH }],
    hashes: {
      baseCommit: "1".repeat(40),
      candidateCommit: "2".repeat(40),
      patch: HASH,
      candidateArtifact: HASH,
      evaluator: HASH,
      evaluatorEnvironment: HASH,
      policy: HASH,
      suite: HASH,
      baselineResult: HASH,
      candidateResult: HASH,
    },
    comparison: {
      baselineScore: 0.7,
      candidateScore: 0.9,
      delta: 0.2,
      passed: true,
      thresholdsHash: HASH,
    },
    attestation: {
      timestamp: "2026-08-28T12:00:00.000Z",
      maxAgeMs: 60_000,
      branchExists: true,
      worktreeExists: true,
    },
    cleanup: {
      status: "retained",
      resources: [
        { kind: "branch", identity: `unclecode/evolve/${id}`, status: "retained" },
        { kind: "worktree", identity: `/private/worktrees/${id}`, status: "retained" },
        { kind: "baseline-worktree", identity: `/private/baselines/${id}`, status: "removed" },
      ],
    },
    failures: [],
    summary: "Held-out comparison passed. Human approval remains pending.",
    artifactRefs: [`.unclecode/artifacts/run-${id}/evolution-proposal.json`],
    createdAt: "2026-08-28T12:00:00.000Z",
    rawCandidateOutput: "must never cross the projection boundary",
    ...overrides,
  };
}

test("a recorded evolution trace is bounded, resume-safe, and idempotent", () => {
  assert.ok(EXECUTION_TRACE_EVENT_TYPES.includes("evolution.proposed"));
  const initial = snapshot();
  const first = applyTraceEventToAgentConsole(initial, {
    type: "evolution.proposed",
    level: "high-signal",
    runId: "run-evolution-1",
    recorded: true,
    proposal: proposal(),
    startedAt: 1,
  });

  assert.equal(first.evolutionProposals?.length, 1);
  assert.equal(first.evolutionProposals?.[0]?.state, "pr-ready");
  assert.equal(first.evolutionProposals?.[0]?.humanApproval, "pending");
  assert.equal(first.evolutionProposals?.[0]?.cleanup.status, "retained");
  assert.equal("rawCandidateOutput" in first.evolutionProposals[0], false);

  const repeated = applyTraceEventToAgentConsole(first, {
    type: "evolution.proposed",
    level: "high-signal",
    runId: "run-evolution-1",
    recorded: true,
    proposal: proposal("evolution-1", { summary: "same proposal replayed" }),
    startedAt: 2,
  });
  assert.equal(repeated.evolutionProposals?.length, 1);
  assert.equal(repeated.evolutionProposals?.[0]?.summary, "same proposal replayed");

  const resumed = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(repeated)));
  assert.deepEqual(resumed?.evolutionProposals, repeated.evolutionProposals);
});

test("unrecorded worktrees and creator quality success cannot manufacture a proposal", () => {
  const initial = snapshot();
  const unrecorded = applyTraceEventToAgentConsole(initial, {
    type: "evolution.proposed",
    level: "high-signal",
    runId: "run-evolution-1",
    recorded: false,
    proposal: proposal(),
    startedAt: 1,
  });
  assert.equal(unrecorded.evolutionProposals, undefined);

  const qualityOnly = applyTraceEventToAgentConsole(initial, {
    type: "quality.completed",
    level: "high-signal",
    runId: "quality-creator",
    graphId: "goal-quality-creator",
    profile: "creator",
    stage: "promote",
    iteration: 0,
    decision: "proceed",
    completedStages: ["explore", "plan", "work", "critic", "promote"],
    evidenceRefs: [],
    failures: [],
    independentVerification: true,
    startedAt: 1,
    completedAt: 2,
  });
  assert.equal(qualityOnly.evolutionProposals, undefined);
});

test("recorded evolution history is bounded without leaking arbitrary candidate content", () => {
  let current = snapshot();
  for (let index = 0; index < 40; index += 1) {
    current = applyTraceEventToAgentConsole(current, {
      type: "evolution.proposed",
      level: "high-signal",
      runId: `run-evolution-${index}`,
      recorded: true,
      proposal: proposal(`evolution-${index}`),
      startedAt: index,
    });
  }
  assert.equal(current.evolutionProposals?.length, 32);
  assert.equal(current.evolutionProposals?.[0]?.id, "evolution-8");
  assert.equal(current.evolutionProposals?.at(-1)?.id, "evolution-39");
});
