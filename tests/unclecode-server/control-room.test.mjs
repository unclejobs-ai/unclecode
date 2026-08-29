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
  assert.deepEqual(projection.runs[2].artifacts[0], { ref: "candidate.patch", hash: "sha256:old", stale: true, verified: false });
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

test("persistent runtime discovers opaque session checkpoint filenames", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unclecode-control-room-"));
  try {
    const sessions = path.join(root, "projects", "project-opaque", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "session-opaque.checkpoint.json"), JSON.stringify({
      sessionId: "session-real",
      projectPath: "/tmp/project",
      state: "completed",
      eventCount: 12,
      uiLocale: "en",
    }));
    const source = await readPersistentRuntime(root, new LiveRuntimeControlRegistry());
    assert.equal(source.sessions.length, 1);
    assert.equal(source.sessions[0].sessionId, "session-real");
    assert.equal(source.sessions[0].revision, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
