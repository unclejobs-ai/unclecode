import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BoundedEventJournal,
  createControlRoomProjection,
  createRuntimeAdapter,
  LiveRuntimeControlRegistry,
  readPersistentRuntime,
} from "@unclecode/server";

const quality = {
  runId: "run-1",
  graphId: "graph-1",
  profile: "deep",
  currentStage: "critic",
  iteration: 2,
  refineCount: 1,
  pivotCount: 0,
  latestDecision: "unproven",
  history: [{
    event: "gate",
    stage: "critic",
    decision: "unproven",
    iteration: 2,
    failures: ["Reviewer unavailable"],
    evidenceRefs: ["artifact:sha256:abc"],
    artifactRefs: [".unclecode/artifacts/run-1/result.md"],
    artifactHash: "sha256:abc",
    independentVerification: false,
    stale: false,
    startedAt: 40,
  }],
};

test("control-room projection is bounded, redacted, and honest about unproven quality", () => {
  const projection = createControlRoomProjection({
    generatedAt: 100,
    sessions: [{
      sessionId: "session-1",
      projectPath: "/workspace/private",
      locale: "ko",
      state: "running",
      revision: 7,
      metadata: { model: "gpt-5.6", traceMode: "verbose", permissionMode: "default" },
      agentConsole: {
        workGraph: undefined,
        qualityReview: quality,
        agents: [],
        jobs: [],
        toolActivities: [],
        pluginDiagnostics: [{
          runId: "run-1",
          source: "workspace",
          trust: "workspace-trusted",
          pluginId: "external-scc",
          hook: "runClassified",
          status: "error",
          error: "token=super-secret Stop hook failed: zod/v3",
          dedupeKey: "sha256:diag",
        }],
      },
      context: {
        included: Array.from({ length: 80 }, (_, index) => ({ id: `source-${index}`, label: `Source ${index}`, reason: "selected", tokenEstimate: 12 })),
        excluded: [{ id: "secret", label: "API token=super-secret", reason: "policy", tokenEstimate: 9 }],
      },
    }],
  });

  assert.equal(projection.runs.length, 1);
  assert.equal(projection.runs[0].quality.gate, "unproven");
  assert.equal(projection.runs[0].quality.independentVerification, false);
  assert.equal(projection.runs[0].quality.provenance, "Quality Engine (SCC)");
  assert.equal(projection.runs[0].context.included.length, 64);
  assert.doesNotMatch(JSON.stringify(projection), /super-secret|\/workspace\/private/);
  assert.match(projection.runs[0].system.diagnostics[0].error, /\[REDACTED\]/);
});

test("control-room projects bounded user decisions without changing answer identities", () => {
  const decision = {
    kind: "user-decision",
    id: "release-choice",
    title: "Choose token=private lane",
    questions: [{
      id: "lane",
      question: "Which lane uses token=private?",
      options: [
        { label: "Canary", description: "Use api_key=private for a small cohort" },
        { label: "Stable", description: "Use the established path" },
      ],
      recommended: 0,
    }, {
      id: "checks",
      question: "Which checks?",
      options: [{ label: "Unit" }, { label: "Integration" }],
      multi: true,
    }],
  };
  const projection = createControlRoomProjection({
    generatedAt: 103,
    sessions: [{
      sessionId: "decision-session",
      projectPath: "/workspace/project",
      locale: "en",
      state: "requires_action",
      revision: 5,
      agentConsole: { pendingDecision: decision },
    }],
  });

  assert.equal(projection.runs[0].pendingDecision.id, "release-choice");
  assert.equal(projection.runs[0].pendingDecision.kind, "user-decision");
  assert.deepEqual(projection.runs[0].pendingDecision.questions[0].options.map(option => option.label), ["Canary", "Stable"]);
  assert.equal(projection.runs[0].pendingDecision.questions[1].multi, true);
  assert.equal(projection.runs[0].attentionReason, "User decision required");
  assert.doesNotMatch(JSON.stringify(projection.runs[0].pendingDecision), /private/);

  const unsafe = createControlRoomProjection({
    generatedAt: 104,
    sessions: [{
      sessionId: "unsafe-decision",
      projectPath: "/workspace/project",
      locale: "en",
      state: "requires_action",
      revision: 1,
      agentConsole: {
        pendingDecision: {
          ...decision,
          questions: [{ id: "lane", question: "Which lane?", options: [{ label: "token=private" }] }],
        },
      },
    }, {
      sessionId: "oversized-decision",
      projectPath: "/workspace/project",
      locale: "en",
      state: "requires_action",
      revision: 1,
      agentConsole: {
        pendingDecision: {
          ...decision,
          questions: Array.from({ length: 9 }, (_, index) => ({
            id: `question-${index}`,
            question: "Choose",
            options: [{ label: "Continue" }],
          })),
        },
      },
    }],
  });
  assert.equal(unsafe.runs[0].pendingDecision, undefined, "answer labels that require redaction must fail closed");
  assert.equal(unsafe.runs[1].pendingDecision, undefined, "oversized decisions must not be truncated into an unanswerable mutation");
  assert.equal(unsafe.runs[0].attentionReason, "Operator action required");
});

test("control-room preserves authoritative critic provenance through terminal promotion", () => {
  const projection = createControlRoomProjection({
    generatedAt: 101,
    sessions: [{
      sessionId: "session-completed", projectPath: "/workspace/project", locale: "en",
      state: "completed", revision: 8,
      agentConsole: { qualityReview: {
        runId: "run-completed", graphId: "graph-completed", profile: "deep",
        currentStage: "promote", iteration: 0, refineCount: 0, pivotCount: 0,
        latestDecision: "proceed", history: [{
          event: "gate", stage: "critic", decision: "proceed", iteration: 0,
          failures: [], evidenceRefs: ["run.json", "critic.json"], artifactRefs: [],
          artifactHash: "sha256:run-artifact",
          reviewedArtifactHash: "sha256:workspace-manifest",
          currentArtifactHash: "sha256:workspace-manifest",
          reviewerRunId: "run-completed:critic:0",
          independentVerification: true, stale: false, startedAt: 50,
        }, {
          event: "completed", stage: "promote", decision: "proceed", iteration: 0,
          failures: [], evidenceRefs: ["run.json"], artifactRefs: [],
          independentVerification: false, stale: false, startedAt: 60,
        }],
      } },
    }],
  });
  const [run] = projection.runs;
  assert.equal(run.quality.independentVerification, true);
  assert.deepEqual(run.artifacts, [
    { ref: "run.json", stale: false, verified: true },
    { ref: "critic.json", stale: false, verified: true },
  ]);
  assert.notEqual(run.artifacts[1]?.hash, "sha256:run-artifact");
});

test("control-room rejects critic provenance from an earlier quality iteration", () => {
  const projection = createControlRoomProjection({
    generatedAt: 102,
    sessions: [{
      sessionId: "session-stale-critic", projectPath: "/workspace/project", locale: "en",
      state: "completed", revision: 9,
      agentConsole: { qualityReview: {
        runId: "run-stale-critic", graphId: "graph-stale-critic", profile: "deep",
        currentStage: "promote", iteration: 2, refineCount: 1, pivotCount: 0,
        latestDecision: "proceed", history: [{
          event: "gate", stage: "critic", decision: "proceed", iteration: 1,
          failures: [], evidenceRefs: ["critic-iteration-1.json"], artifactRefs: [],
          artifactHash: "sha256:iteration-1", reviewedArtifactHash: "sha256:manifest-1",
          currentArtifactHash: "sha256:manifest-1", reviewerRunId: "critic:1",
          independentVerification: true, stale: false, startedAt: 40,
        }, {
          event: "refine", stage: "critic", decision: "refine", iteration: 2,
          failures: [], evidenceRefs: [], artifactRefs: [], independentVerification: false,
          stale: false, startedAt: 50,
        }, {
          event: "completed", stage: "promote", decision: "proceed", iteration: 2,
          failures: [], evidenceRefs: ["run-iteration-2.json"],
          artifactRefs: ["run-iteration-2.json"], independentVerification: false,
          stale: false, startedAt: 60,
        }],
      } },
    }],
  });
  const [run] = projection.runs;
  assert.equal(run.quality.independentVerification, false);
  assert.deepEqual(run.artifacts, [
    { ref: "run-iteration-2.json", stale: false, verified: false },
  ]);
});

test("bounded event journal replays strictly after cursor and detects expiry", () => {
  const journal = new BoundedEventJournal({ capacity: 3 });
  const one = journal.publish("session-1", "run.updated", { revision: 1 });
  const two = journal.publish("session-1", "run.updated", { revision: 2 });
  const three = journal.publish("session-1", "run.updated", { revision: 3 });
  const four = journal.publish("session-1", "run.updated", { revision: 4 });

  assert.equal(one.id, 1);
  assert.deepEqual(journal.replay("session-1", two.id).events.map(event => event.id), [three.id, four.id]);
  const five = journal.publish("session-1", "run.updated", { revision: 5 });
  assert.equal(journal.replay("session-1", one.id).status, "expired");

  const received = [];
  const subscription = journal.subscribeAfter("session-1", three.id, event => received.push(event.id));
  journal.publish("session-1", "quality.updated", { gate: "proceed" });
  subscription.unsubscribe();
  assert.deepEqual(received, [four.id, five.id, 6]);
});

test("event journal expiry is scoped to the selected session", () => {
  const journal = new BoundedEventJournal({ capacity: 3 });
  const selected = journal.publish("selected", "run.updated", { revision: 1 });
  for (let revision = 1; revision <= 4; revision += 1) {
    journal.publish("other", "run.updated", { revision });
  }

  assert.deepEqual(journal.replay("selected", selected.id), { status: "ok", events: [] });
});

test("event journal expires a cursor ahead of its current lifetime", () => {
  const journal = new BoundedEventJournal({ capacity: 3 });
  journal.publish("selected", "run.updated", { revision: 1 });

  assert.equal(journal.replay("selected", 20).status, "expired");
});

test("event journal bounds retained events and releases 100 reconnect subscriptions", () => {
  const journal = new BoundedEventJournal({ capacity: 3 });
  let deliveries = 0;
  for (let reconnect = 0; reconnect < 100; reconnect += 1) {
    const subscription = journal.subscribeAfter(`session-${reconnect}`, 0, () => { deliveries += 1; });
    subscription.unsubscribe();
    journal.publish(`session-${reconnect}`, "run.updated", { reconnect });
  }

  assert.deepEqual(journal.stats, {
    retainedEvents: 3,
    activeSubscriptions: 0,
    subscriberSessions: 0,
    replayWatermarks: 3,
  });
  journal.publish("session-99", "run.updated", { reconnect: 100 });
  assert.equal(deliveries, 0);
});

test("runtime adapter enforces revision and idempotency at the live control boundary", async () => {
  let calls = 0;
  const adapter = createRuntimeAdapter({
    async read() {
      return { generatedAt: 1, sessions: [{ sessionId: "s1", projectPath: "/tmp/p", locale: "en", state: "running", revision: 4 }] };
    },
    controls: {
      async control(input) {
        calls += 1;
        return { ok: true, revision: input.expectedRevision + 1, state: "paused" };
      },
    },
  });

  const first = await adapter.control({ sessionId: "s1", action: "pause", expectedRevision: 4, idempotencyKey: "key-1" });
  const duplicate = await adapter.control({ sessionId: "s1", action: "pause", expectedRevision: 4, idempotencyKey: "key-1" });
  const stale = await adapter.control({ sessionId: "s1", action: "resume", expectedRevision: 3, idempotencyKey: "key-2" });

  assert.equal(first.ok, true);
  assert.deepEqual(duplicate, first);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "revision_conflict");
  assert.equal(calls, 1);
});

test("runtime adapter coalesces concurrent duplicates and serializes session revisions", async () => {
  let revision = 4;
  let calls = 0;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const adapter = createRuntimeAdapter({
    async read() {
      return { generatedAt: 1, sessions: [{ sessionId: "s1", projectPath: "/tmp/p", locale: "en", state: "running", revision }] };
    },
    controls: {
      async control(input) {
        calls += 1;
        if (calls === 1) await firstGate;
        revision += 1;
        return { ok: true, revision, state: input.action === "pause" ? "paused" : "running" };
      },
    },
  });

  const request = { sessionId: "s1", action: "pause", expectedRevision: 4, idempotencyKey: "same-key" };
  const first = adapter.control(request);
  const duplicate = adapter.control(request);
  const conflicting = adapter.control({ sessionId: "s1", action: "resume", expectedRevision: 4, idempotencyKey: "other-key" });
  const reusedForDifferentRequest = await adapter.control({ ...request, action: "resume" });
  assert.equal(reusedForDifferentRequest.code, "invalid_action");

  releaseFirst();
  const [firstResult, duplicateResult, conflictResult] = await Promise.all([first, duplicate, conflicting]);
  assert.deepEqual(duplicateResult, firstResult);
  assert.equal(conflictResult.code, "revision_conflict");
  assert.equal(conflictResult.revision, 5);
  assert.equal(calls, 1, "only one physical control may run for one revision");
});

test("projection preserves failed, cancelled, recorded creator, stale-artifact, and cleanup states", () => {
  const evolutionProposal = {
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
    changedAssets: [{ path: "skills/example/SKILL.md", sha256: `sha256:${"a".repeat(64)}` }],
    hashes: {
      baseCommit: "1".repeat(40),
      candidateCommit: "2".repeat(40),
      patch: `sha256:${"b".repeat(64)}`,
      evaluator: `sha256:${"c".repeat(64)}`,
      evaluatorEnvironment: `sha256:${"8".repeat(64)}`,
      policy: `sha256:${"d".repeat(64)}`,
      suite: `sha256:${"e".repeat(64)}`,
      baselineResult: `sha256:${"f".repeat(64)}`,
      candidateResult: `sha256:${"0".repeat(64)}`,
    },
    comparison: {
      baselineScore: 0.75,
      candidateScore: 0.9,
      delta: 0.15,
      passed: true,
      thresholdsHash: `sha256:${"9".repeat(64)}`,
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
    summary: "Held-out comparison passed; human approval remains pending.",
    artifactRefs: [".unclecode/artifacts/run-creator/evolution-proposal.json"],
    createdAt: "2026-08-28T12:00:00.000Z",
    rawCandidateOutput: "token=must-not-cross-control-room",
    unknownCandidateMetadata: { privateContent: "must-not-cross-control-room" },
  };
  const projection = createControlRoomProjection({
    generatedAt: 200,
    sessions: [
      { sessionId: "failed", projectPath: "/tmp/a", locale: "en", state: "failed", revision: 2, agentConsole: { qualityReview: { profile: "standard", currentStage: "critic", latestDecision: "block", history: [{ stage: "critic", decision: "block", failures: ["Tests failed"] }] } } },
      { sessionId: "cancelled", projectPath: "/tmp/b", locale: "ko", state: "cancelled", revision: 3, agentConsole: { qualityReview: { profile: "minimal", currentStage: "work", latestDecision: "unproven", history: [] } } },
      { sessionId: "creator", projectPath: "/tmp/c", locale: "en", state: "completed", revision: 4, agentConsole: { evolutionProposals: [evolutionProposal], qualityReview: { profile: "creator", currentStage: "promote", latestDecision: "proceed", history: [{ stage: "promote", decision: "proceed", artifactRefs: ["candidate.patch"], artifactHash: "sha256:old", stale: true, independentVerification: true }] } } },
    ],
    system: { cleanup: [{ kind: "worktree", status: "pending" }] },
  });

  assert.deepEqual(projection.runs.map(run => run.state), ["failed", "cancelled", "completed"]);
  assert.equal(projection.runs[0].attentionReason, "Tests failed");
  assert.equal(projection.runs[2].evolve[0].mergeRequiresHumanApproval, true);
  assert.equal(projection.runs[2].evolve[0].comparison.candidateScore, 0.9);
  assert.equal(projection.runs[2].evolve[0].attestation.worktreeExists, true);
  assert.equal(projection.runs[2].evolve[0].cleanup.status, "retained");
  assert.equal(projection.runs[2].evolve[0].hashes.patch, `sha256:${"b".repeat(64)}`);
  assert.equal(projection.runs[2].evolve[0].hashes.evaluatorEnvironment, `sha256:${"8".repeat(64)}`);
  assert.equal("rawCandidateOutput" in projection.runs[2].evolve[0], false);
  assert.equal("unknownCandidateMetadata" in projection.runs[2].evolve[0], false);
  assert.doesNotMatch(JSON.stringify(projection.runs[2].evolve), /must-not-cross-control-room/);
  assert.deepEqual(projection.runs[2].artifacts[0], { ref: "candidate.patch", stale: true, verified: false });
  assert.equal(projection.system.cleanup[0].status, "pending");
});

test("creator profile alone never fabricates isolation or benchmark attestations", () => {
  const projection = createControlRoomProjection({
    generatedAt: 201,
    sessions: [{
      sessionId: "creator-without-proposal",
      projectPath: "/tmp/c",
      locale: "en",
      state: "completed",
      revision: 1,
      agentConsole: { qualityReview: { profile: "creator", currentStage: "promote", latestDecision: "proceed", history: [] } },
    }],
  });
  assert.deepEqual(projection.runs[0].evolve, []);
});

test("control-room publishes only bounded cache telemetry fields with a measurable hit rate", () => {
  const projection = createControlRoomProjection({
    generatedAt: 201,
    sessions: [],
    system: {
      caches: [{
        name: "provider-system-prompt token=super-secret",
        hits: 3,
        misses: 1,
        evictions: 2,
        byteEvictions: 1,
        invalidations: 4,
        currentSize: 5,
        maxEntries: 64,
        maxRetainedBytes: 2_097_152,
        retainedBytesEstimate: 12_345,
        prompt: "must-not-cross-control-room",
      }],
    },
  });

  assert.deepEqual(projection.system.caches, [{
    name: "provider-system-prompt token=[REDACTED]",
    hits: 3,
    misses: 1,
    hitRate: 0.75,
    evictions: 2,
    byteEvictions: 1,
    invalidations: 4,
    currentSize: 5,
    maxEntries: 64,
    maxRetainedBytes: 2_097_152,
    retainedBytesEstimate: 12_345,
  }]);
  assert.doesNotMatch(JSON.stringify(projection.system), /must-not-cross-control-room/);
  assert.doesNotMatch(JSON.stringify(projection.system), /super-secret/);
});

test("legacy sessions do not fabricate SCC promotion provenance", () => {
  const projection = createControlRoomProjection({
    generatedAt: 202,
    sessions: [{ sessionId: "legacy", projectPath: "/tmp/legacy", locale: "en", state: "idle", revision: 0 }],
  });
  assert.equal(projection.runs[0].quality.recorded, false);
  assert.equal(projection.runs[0].quality.provenance, "not-recorded");
  assert.equal(projection.runs[0].quality.stage, "unknown");
  assert.equal(projection.runs[0].quality.phase, "unknown");
});

test("persistent runtime discovers opaque checkpoints and restores only explicit owner revisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unclecode-control-room-"));
  try {
    const sessions = path.join(root, "projects", "project-opaque", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "session-without-revision.checkpoint.json"), JSON.stringify({
      sessionId: "session-without-revision",
      projectPath: "/tmp/project",
      state: "completed",
      eventCount: 12,
      uiLocale: "en",
    }));
    await writeFile(path.join(sessions, "session-explicit-revision.checkpoint.json"), JSON.stringify({
      sessionId: "session-explicit-revision",
      projectPath: "/tmp/project",
      state: "completed",
      eventCount: 99,
      uiLocale: "en",
      metadata: { ownerMutationRevision: 37 },
    }));
    const source = await readPersistentRuntime(root, new LiveRuntimeControlRegistry());
    assert.equal(source.sessions.length, 2);
    const revisions = new Map(source.sessions.map(session => [session.sessionId, session.revision]));
    assert.equal(revisions.get("session-without-revision"), 0, "event count must never impersonate an owner revision");
    assert.equal(revisions.get("session-explicit-revision"), 37, "the explicit owner revision must restore exactly");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent runtime projects only matching replay-safe approval pauses and preserves revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unclecode-control-room-paused-"));
  try {
    const sessions = path.join(root, "projects", "project-paused", "sessions");
    await mkdir(sessions, { recursive: true });
    const base = {
      projectPath: "/tmp/project",
      state: "paused",
      uiLocale: "en",
      metadata: { ownerMutationRevision: 41 },
      agentConsole: {
        pendingDecision: {
          kind: "user-decision",
          id: "decision-safe",
          questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
        },
      },
    };
    await writeFile(path.join(sessions, "safe.checkpoint.json"), JSON.stringify({
      ...base,
      sessionId: "safe-paused",
      pauseCheckpoint: {
        turnId: "turn-safe",
        boundary: "before_approval",
        decisionId: "decision-safe",
        attachmentRefs: [],
        artifactRefs: [],
      },
    }));
    await writeFile(path.join(sessions, "unsafe.checkpoint.json"), JSON.stringify({
      ...base,
      sessionId: "unsafe-paused",
      pauseCheckpoint: {
        turnId: "turn-unsafe",
        boundary: "after_provider",
        decisionId: "decision-safe",
        attachmentRefs: [],
        artifactRefs: [],
      },
    }));

    const source = await readPersistentRuntime(root, new LiveRuntimeControlRegistry());
    const byId = new Map(source.sessions.map(session => [session.sessionId, session]));
    assert.equal(byId.get("safe-paused")?.state, "paused");
    assert.equal(byId.get("safe-paused")?.revision, 41);
    assert.equal(byId.get("safe-paused")?.metadata?.recoveryStatus, "replay_safe_pause_restored");
    assert.equal(byId.get("safe-paused")?.metadata?.decisionId, "decision-safe");
    assert.equal(byId.get("unsafe-paused")?.state, "failed");
    assert.equal(byId.get("unsafe-paused")?.revision, 41);
    assert.equal(byId.get("unsafe-paused")?.metadata?.recoveryStatus, "non_resumable_owner_restart");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent runtime includes injected serializable cache telemetry", async () => {
  const source = await readPersistentRuntime(
    "/path/that/does/not/exist",
    new LiveRuntimeControlRegistry(),
    () => [{
      name: "repo-map",
      hits: 8,
      misses: 2,
      evictions: 1,
      byteEvictions: 1,
      invalidations: 3,
      currentSize: 2,
      maxEntries: 8,
      maxRetainedBytes: 67_108_864,
      retainedBytesEstimate: 1_024,
    }],
  );

  assert.equal(source.system.caches[0].name, "repo-map");
  assert.equal(source.system.caches[0].retainedBytesEstimate, 1_024);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(source.system.caches)));
});

test("runtime adapter does not queue cancel behind a pending pause", async () => {
  let revision = 4;
  let releasePause;
  let cancelCalls = 0;
  const adapter = createRuntimeAdapter({
    async read() {
      return { generatedAt: Date.now(), sessions: [{ sessionId: "s1", projectPath: "/tmp", locale: "en", state: "running", revision }], system: { providers: [], plugins: [], cleanup: [] } };
    },
    controls: {
      async control(request) {
        if (request.action === "pause") {
          await new Promise(resolve => { releasePause = resolve; });
          revision += 1;
          return { ok: true, revision, state: "paused" };
        }
        cancelCalls += 1;
        revision += 1;
        return { ok: true, revision, state: "cancelled" };
      },
    },
  });
  const pause = adapter.control({ sessionId: "s1", action: "pause", expectedRevision: 4, idempotencyKey: "pause" });
  await new Promise(resolve => setImmediate(resolve));
  const cancel = adapter.control({ sessionId: "s1", action: "cancel", expectedRevision: 4, idempotencyKey: "cancel" });
  const cancelled = await Promise.race([
    cancel,
    new Promise(resolve => setTimeout(() => resolve({ ok: false, code: "blocked" }), 100)),
  ]);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelCalls, 1);
  releasePause();
  await pause;
});

test("runtime adapter delegates stale targeted cancel admission to the owner arbiter", async () => {
  let calls = 0;
  const adapter = createRuntimeAdapter({
    async read() {
      return {
        generatedAt: Date.now(),
        sessions: [{ sessionId: "targeted", projectPath: "/tmp", locale: "en", state: "running", revision: 13 }],
        system: { providers: [], plugins: [], cleanup: [] },
      };
    },
    controls: {
      async control(request) {
        calls += 1;
        assert.equal(request.expectedRevision, 11);
        return { ok: true, revision: 14, state: "cancelled" };
      },
    },
  });

  const result = await adapter.control({
    sessionId: "targeted",
    action: "cancel",
    expectedRevision: 11,
    idempotencyKey: "cancel-turn-11",
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1, "only the owner arbiter may decide whether stale cancel targets the active generation");
});
