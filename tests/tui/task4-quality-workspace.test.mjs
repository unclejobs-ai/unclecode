import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkShellTranscriptEntryCapacity,
  measureWorkShellEntryRows,
  resolveWorkShellTranscriptWindow,
  selectQualityReviewLines,
  selectWorkGraphHudRows,
  SEMANTIC_TUI_TOKENS,
  getDisplayWidth,
  resolveQueuePanelVisibleLines,
  projectWorkShellTranscript,
  createWorkShellTranscriptAnchor,
  resolveWorkShellTranscriptOffsetFromAnchor,
  projectWorkShellEntryRows,
  selectAgentConsoleInspector,
} from "@unclecode/tui";
import { applyTraceEventToAgentConsole } from "@unclecode/orchestrator";
import { parseAgentConsoleSnapshot } from "@unclecode/contracts";

function node(id, status, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    prompt: `do ${id}`,
    status,
    dependsOn: [],
    fileOwnership: [],
    acceptanceCriteria: [`accept ${id}`],
    evidenceRefs: [],
    stage: "work",
    role: "worker",
    attempt: 1,
    artifactRefs: [],
    reviewRequired: true,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    profileId: "build",
    activity: [],
    agents: [],
    jobs: [],
    workGraph: {
      id: "graph-1",
      goal: "Ship quality runtime",
      qualityProfile: "deep",
      currentStage: "critic",
      gateStatus: "unproven",
      iteration: 2,
      approval: "approved",
      nodes: [
        node("1", "completed"),
        node("2", "completed"),
        node("3", "completed"),
        node("4", "running"),
        node("5", "ready"),
        node("6", "ready"),
        node("7", "ready"),
      ],
    },
    ...overrides,
  };
}

test("quiet quality HUD shows at most three nodes and an exact quality summary", () => {
  const rows = selectWorkGraphHudRows(snapshot(), 100);
  assert.equal(rows.filter((line) => /^  [✓●○×◆]/u.test(line)).length, 3);
  assert.match(rows[0], /Quality Engine · deep · critic · PDCA check · Gate unproven · iteration 2/);
  assert.match(rows.at(-1), /3\/7 complete · 4 remaining · Ctrl\+T full plan/);
  assert.ok(!rows.some((line) => /passed/i.test(line)), "unproven must never be presented as passed");
});

test("expanded quality HUD exposes the complete graph without mixing agents or jobs", () => {
  const rows = selectWorkGraphHudRows(snapshot({
    agents: [{ id: "agent-1", displayName: "Worker", status: "running" }],
    jobs: [{ id: "job-1", label: "Background", status: "running" }],
  }), 80, { expanded: true });
  assert.equal(rows.filter((line) => /Task [1-7]/.test(line)).length, 7);
  assert.ok(!rows.some((line) => /Worker|Background/.test(line)));
});

test("quality review lines name stale/unproven evidence and synthesis-only promote", () => {
  const lines = selectQualityReviewLines(snapshot(), 100);
  assert.match(lines.join("\n"), /Gate · unproven/);
  assert.match(lines.join("\n"), /independent review evidence is missing or stale/i);
  assert.match(lines.join("\n"), /Promote · handoff\/synthesis only/i);
  assert.doesNotMatch(lines.join("\n"), /deploy|publish|merge|release/i);
});

test("quality review renders explicit hash freshness, route, reviewer run, and bounded attempt", () => {
  const lines = selectQualityReviewLines(snapshot({
    qualityReview: {
      runId: "run-quality",
      graphId: "graph-1",
      refineCount: 2,
      pivotCount: 1,
      latestDecision: "refine",
      history: [{
        event: "refine",
        stage: "critic",
        decision: "refine",
        iteration: 2,
        failures: ["QUEUE_HASH_MISMATCH"],
        evidenceRefs: ["evidence:queue"],
        artifactRefs: ["artifact:queue"],
        reviewedArtifactHash: "sha256:reviewed",
        currentArtifactHash: "sha256:current",
        reviewerId: "critic:anthropic:claude-review",
        reviewerRunId: "review-run-2",
        provider: "anthropic",
        model: "claude-review",
        route: "frontier",
        count: 2,
        limit: 3,
        independentVerification: true,
        stale: true,
        startedAt: 20,
      }],
    },
  }), 100).join("\n");
  assert.match(lines, /Reviewer run · review-run-2/);
  assert.match(lines, /Route · frontier · anthropic · claude-review/);
  assert.match(lines, /Reviewed hash · sha256:reviewed/);
  assert.match(lines, /Current hash · sha256:current · stale/);
  assert.match(lines, /Refine attempt · 2\/3/);
});

test("quality detail progressively discloses only recorded evolution evidence", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const lines = selectQualityReviewLines(snapshot({
    qualityReview: {
      runId: "run-creator",
      graphId: "graph-1",
      profile: "creator",
      currentStage: "promote",
      iteration: 2,
      refineCount: 0,
      pivotCount: 0,
      latestDecision: "proceed",
      history: [],
    },
    evolutionProposals: [{
      id: "proposal-1",
      runId: "run-creator",
      candidateId: "candidate-1",
      creatorId: "creator-openai",
      evaluatorId: "held-out-evaluator-v1",
      attestorId: "unclecode-git-attestor-v1",
      state: "pr-ready",
      isolation: "worktree",
      isolatedBranch: "unclecode/evolve/run-creator",
      isolatedWorktree: "/private/worktrees/run-creator",
      heldOutBenchmark: true,
      heldOutBenchmarkId: "held-out-guardian-v1",
      humanApproval: "pending",
      mergeRequiresHumanApproval: true,
      stale: false,
      changedAssets: [{ path: "skills/example/SKILL.md", sha256: hash }],
      hashes: {
        baseCommit: "1".repeat(40),
        candidateCommit: "2".repeat(40),
        patch: hash,
        evaluator: hash,
        evaluatorEnvironment: hash,
        policy: hash,
        suite: hash,
        baselineResult: hash,
        candidateResult: hash,
      },
      comparison: {
        baselineScore: 0.7,
        candidateScore: 0.9,
        delta: 0.2,
        passed: true,
        thresholdsHash: hash,
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
          { kind: "branch", identity: "unclecode/evolve/run-creator", status: "retained" },
          { kind: "worktree", identity: "/private/worktrees/run-creator", status: "retained" },
          { kind: "baseline-worktree", identity: "/private/baselines/run-creator", status: "removed" },
        ],
      },
      failures: [],
      summary: "Held-out comparison passed.",
      artifactRefs: [".unclecode/artifacts/run-creator/evolution-proposal.json"],
      createdAt: "2026-08-28T12:00:00.000Z",
    }],
  }), 140).join("\n");

  assert.match(lines, /Evolution · pr-ready · recorded/);
  assert.match(lines, /Isolation · worktree · unclecode\/evolve\/run-creator · attested/);
  assert.match(lines, /Held-out · held-out-guardian-v1 · baseline 0\.7 → candidate 0\.9 · delta \+0\.2 · passed/);
  assert.match(lines, /Candidate hash · sha256:a+ · current/);
  assert.match(lines, /Attestor · unclecode-git-attestor-v1 · 2026-08-28T12:00:00\.000Z · current branch\+worktree present/);
  assert.match(lines, /Approval · pending · merge requires human approval/);
  assert.match(lines, /Cleanup · retained · 2 retained · 1 removed/);
});

test("creator quality success without a recorded proposal does not imply evolution evidence", () => {
  const lines = selectQualityReviewLines(snapshot({
    workGraph: { ...snapshot().workGraph, qualityProfile: "creator", currentStage: "promote", gateStatus: "proceed" },
    qualityReview: {
      runId: "run-no-proposal",
      graphId: "graph-1",
      profile: "creator",
      currentStage: "promote",
      iteration: 2,
      refineCount: 0,
      pivotCount: 0,
      latestDecision: "proceed",
      history: [],
    },
  }), 120).join("\n");
  assert.doesNotMatch(lines, /Evolution|Isolation|Held-out|Approval|Cleanup/);
});

test("quality completed resume keeps completion status and the last evidence-bearing gate in review and detail", () => {
  const base = snapshot({
    workGraph: {
      ...snapshot().workGraph,
      id: "graph-completed-review",
      nodes: [node("critic-node", "completed", {
        stage: "critic",
        role: "critic",
        artifactRefs: ["artifact:critic-output"],
      })],
    },
  });
  const gated = applyTraceEventToAgentConsole(base, {
    type: "quality.gate_evaluated",
    runId: "run-completed-review",
    graphId: "graph-completed-review",
    profile: "deep",
    stage: "critic",
    iteration: 2,
    decision: "proceed",
    nodeId: "critic-node",
    artifactRefs: ["artifact:critic-output"],
    failures: ["critic finding retained"],
    reason: "Independent critic verified the final artifact.",
    evidenceRefs: ["evidence:held-out-tests"],
    reviewedArtifactHash: "sha256:reviewed-final",
    currentArtifactHash: "sha256:reviewed-final",
    reviewerRunId: "reviewer-run-final",
    provider: "anthropic",
    model: "claude-review",
    route: "frontier",
    independentVerification: true,
    stale: false,
    startedAt: 20,
  });
  const completed = applyTraceEventToAgentConsole(gated, {
    type: "quality.completed",
    runId: "run-completed-review",
    graphId: "graph-completed-review",
    profile: "deep",
    stage: "promote",
    iteration: 2,
    decision: "proceed",
    startedAt: 30,
    completedAt: 31,
  });
  const resumed = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(completed)));
  assert.ok(resumed);

  const review = selectQualityReviewLines(resumed, 120).join("\n");
  assert.match(review, /Completion · promote · proceed/);
  assert.match(review, /Reason · Independent critic verified the final artifact/);
  assert.match(review, /Failure · critic finding retained/);
  assert.match(review, /Evidence · evidence:held-out-tests/);
  assert.match(review, /Reviewed hash · sha256:reviewed-final/);
  assert.match(review, /Route · frontier · anthropic · claude-review/);
  assert.match(review, /Reviewer · critic:anthropic:claude-review · independent/);

  const criticNode = resumed.workGraph.nodes[0];
  const detail = selectAgentConsoleInspector(
    resumed,
    { tab: "plan", node: criticNode },
    100,
    120,
  );
  assert.ok(detail);
  const detailText = [
    ...detail.facts.map((fact) => `${fact.label} · ${fact.value}`),
    ...detail.timeline,
  ].join("\n");
  assert.match(detailText, /Completion · promote · proceed/);
  assert.match(detailText, /Reviewer · critic:anthropic:claude-review · independent/);
  assert.match(detailText, /Reviewed hash · sha256:reviewed-final/);
  assert.match(detailText, /Evidence · evidence:held-out-tests/);
});

test("graph-less minimal quality traces remain visible and truthful through resume", () => {
  const empty = { profileId: "build", activity: [], agents: [], jobs: [] };
  const started = applyTraceEventToAgentConsole(empty, {
    type: "quality.stage_started",
    runId: "run-simple",
    graphId: "quality:run-simple",
    profile: "minimal",
    stage: "work",
    iteration: 0,
    artifactRefs: [],
    startedAt: 1,
  });
  const gated = applyTraceEventToAgentConsole(started, {
    type: "quality.gate_evaluated",
    runId: "run-simple",
    graphId: "quality:run-simple",
    profile: "minimal",
    stage: "work",
    iteration: 0,
    decision: "proceed",
    refineCount: 0,
    pivotCount: 0,
    evidenceRefs: ["artifact:turn-output"],
    failures: [],
    reason: "Bounded turn artifact captured.",
    artifactHash: "sha256:turn-output",
    independentVerification: false,
    startedAt: 2,
  });
  const completed = applyTraceEventToAgentConsole(gated, {
    type: "quality.completed",
    runId: "run-simple",
    graphId: "quality:run-simple",
    profile: "minimal",
    stage: "promote",
    iteration: 0,
    decision: "proceed",
    completedStages: ["work", "promote"],
    evidenceRefs: ["artifact:turn-output"],
    failures: [],
    independentVerification: false,
    artifactRefs: ["artifact:turn-output"],
    startedAt: 3,
    completedAt: 4,
  });
  const resumed = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(completed)));
  assert.ok(resumed);
  assert.equal(resumed.workGraph, undefined, "minimal turns do not invent a planner DAG");

  const hud = selectWorkGraphHudRows(resumed, 100).join("\n");
  assert.equal(hud, "Quality Engine · minimal · Gate proceed · /scc details");
  const review = selectQualityReviewLines(resumed, 100).join("\n");
  assert.match(review, /Quality Engine \(SCC\) · minimal · promote/);
  assert.match(review, /Artifact hash · sha256:turn-output/);
  assert.match(review, /not independent/);
  assert.doesNotMatch(review, /independent · proven|Critic findings · none open/);
});

test("transcript window measures wrapped Korean and reports earlier/newer rendered rows", () => {
  const entries = [
    { role: "assistant", text: "가나다라마바사아자차카타파하" },
    { role: "tool", text: "one\ntwo\nthree" },
    { role: "assistant", text: "👨‍👩‍👧‍👦 e\u0301 한글English" },
  ];
  assert.equal(measureWorkShellEntryRows(entries[0], 8), 4);
  assert.equal(getWorkShellTranscriptEntryCapacity(entries, 15, 8), 3);
  const result = resolveWorkShellTranscriptWindow({
    entries,
    terminalRows: 15,
    terminalColumns: 12,
    scrollOffset: 4,
  });
  assert.equal(result.scrolled, true);
  assert.ok(result.earlierRows >= 0);
  assert.ok(result.newerRows >= 4);
});

test("tool history reprojects retained completed/error/approval rows between compact and expanded", () => {
  const entries = [
    { id: "tool-ok", role: "tool", text: "bash npm test\n12 lines · 34ms\nall tests passed" },
    { id: "tool-error", role: "tool", text: "read missing.txt\nENOENT · 2ms\nmissing" },
    { id: "approval", role: "tool", text: "Security approval · write_file\nAllowed once" },
  ];
  const compact = entries.map((entry) => projectWorkShellEntryRows(entry, 80, "minimal"));
  const expanded = entries.map((entry) => projectWorkShellEntryRows(entry, 80, "verbose"));
  assert.deepEqual(compact.map((rows) => rows.length), [1, 1, 1]);
  assert.deepEqual(expanded.map((rows) => rows.length), [3, 3, 2]);
  assert.deepEqual(entries.map((entry) => entry.id), ["tool-ok", "tool-error", "approval"]);
});

test("TUI exposes the shared semantic token contract", () => {
  assert.deepEqual(Object.keys(SEMANTIC_TUI_TOKENS), [
    "accent",
    "success",
    "warning",
    "danger",
    "muted",
    "surface",
  ]);
});

test("Queue viewport keeps the stable selected row visible with long Korean follow-ups", () => {
  const lines = [
    "Paused · 12 follow-ups",
    "",
    ...Array.from({ length: 12 }, (_, index) =>
      `${index === 0 ? "Next" : `#${index + 1}`} · id ${index + 1} · pending · wait ${index}s · 아주 긴 한글 후속 요청 ${index + 1}`),
    "",
    "t retry · x discard · Esc close",
  ];
  const visible = resolveQueuePanelVisibleLines(lines, 11, 5);
  assert.ok(visible.some((line) => /id 11 ·/.test(line)));
  assert.ok(!visible.some((line) => /id 1 ·/.test(line)));
  assert.ok(visible.some((line) => /t retry · x discard/.test(line)));
  assert.equal(visible.filter((line) => /^(?:Next|#\d+) · id/u.test(line)).length, 5);
});

test("shared transcript projection keeps a stable virtual assistant id through streaming growth", () => {
  const durable = [
    { id: "entry-user", role: "user", text: "이전 질문" },
    { id: "entry-answer", role: "assistant", text: "이전 답변" },
  ];
  const first = projectWorkShellTranscript(durable, "한글");
  assert.equal(first.at(-1)?.id, "streaming-assistant");
  const width = 20;
  const anchor = createWorkShellTranscriptAnchor(first, width, 6);
  assert.ok(anchor);

  const grown = projectWorkShellTranscript(durable, "한글 스트리밍 답변이 여러 줄로 계속 자랍니다 👨‍👩‍👧‍👦");
  assert.equal(grown.at(-1)?.id, "streaming-assistant");
  assert.ok(
    resolveWorkShellTranscriptOffsetFromAnchor(grown, width, anchor)
      >= resolveWorkShellTranscriptOffsetFromAnchor(first, width, anchor),
  );
  const resized = resolveWorkShellTranscriptOffsetFromAnchor(grown, 12, anchor);
  assert.ok(Number.isSafeInteger(resized) && resized > 0);
});

test("quality HUD keeps information priority and display-cell bounds at target widths", () => {
  for (const width of [60, 80, 100, 140]) {
    const rows = selectWorkGraphHudRows(snapshot(), width);
    assert.ok(rows.some((line) => /3\/7 complete/.test(line)), `summary missing at ${width}`);
    assert.ok(rows.every((line) => getDisplayWidth(line) <= width), `row exceeds ${width} cells`);
  }
});
