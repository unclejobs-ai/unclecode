import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BoundedEventJournal,
  createPersistentRuntimeAdapter,
  makeControlRoomHandlers,
  startServer,
} from "@unclecode/server";
import { createControlRoomStore } from "../../apps/godness-web/src/control-room-store.js";

const TOKEN = "evolution-transport-token".padEnd(64, "x");

function proposal(state = "pr-ready") {
  const fresh = state === "pr-ready";
  return {
    id: "proposal-transport-1",
    runId: "session-evolution-1",
    candidateId: "candidate-transport-1",
    creatorId: "creator-broker",
    evaluatorId: "held-out-evaluator",
    attestorId: "unclecode-git-attestor",
    state,
    isolation: "worktree",
    isolatedBranch: "unclecode/evolve/candidate-transport-1",
    isolatedWorktree: "/private/not-for-client-content/candidate",
    heldOutBenchmark: true,
    heldOutBenchmarkId: "held-out-suite",
    humanApproval: "pending",
    mergeRequiresHumanApproval: true,
    stale: !fresh,
    changedAssets: [
      { path: "skills/creator.md", sha256: `sha256:${"a".repeat(64)}` },
    ],
    hashes: {
      baseCommit: "1".repeat(40),
      candidateCommit: "2".repeat(40),
      patch: `sha256:${"b".repeat(64)}`,
      candidateArtifact: `sha256:${"c".repeat(64)}`,
      evaluator: `sha256:${"d".repeat(64)}`,
      evaluatorEnvironment: `sha256:${"e".repeat(64)}`,
      policy: `sha256:${"f".repeat(64)}`,
      suite: `sha256:${"0".repeat(64)}`,
    },
    comparison: {
      baselineScore: 0.7,
      candidateScore: 0.9,
      delta: 0.2,
      passed: fresh,
      thresholdsHash: `sha256:${"3".repeat(64)}`,
    },
    attestation: {
      timestamp: "2026-08-28T12:00:00.000Z",
      maxAgeMs: 300_000,
      branchExists: fresh,
      worktreeExists: fresh,
    },
    cleanup: {
      status: fresh ? "retained" : "completed",
      resources: [
        {
          kind: "branch",
          identity: "unclecode/evolve/candidate-transport-1",
          status: fresh ? "retained" : "removed",
        },
        {
          kind: "worktree",
          identity: "/private/not-for-client-content/candidate",
          status: fresh ? "retained" : "removed",
        },
      ],
    },
    failures: fresh ? [] : ["EVOLUTION_CANDIDATE_STALE"],
    summary: fresh
      ? "Recorded PR-ready candidate."
      : "Recorded candidate is historical.",
    artifactRefs: [
      ".unclecode/artifacts/session-evolution-1/evolution-proposal.json",
    ],
    createdAt: "2026-08-28T12:00:00.000Z",
    rawCandidateOutput: "secret candidate content must not cross HTTP",
  };
}

async function waitFor(assertion, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return assertion();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("recorded evolution checkpoint reaches the actual web store over bounded HTTP and SSE", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "unclecode-evolution-transport-"),
  );
  const sessions = path.join(root, "projects", "project-1", "sessions");
  const checkpoint = path.join(sessions, "opaque-trace.checkpoint.json");
  await mkdir(sessions, { recursive: true });
  const writeCheckpoint = async (state, eventCount) =>
    writeFile(
      checkpoint,
      JSON.stringify({
        sessionId: "session-evolution-1",
        projectPath: "/private/project/path",
        state: "completed",
        eventCount,
        uiLocale: "en",
        agentConsole: { evolutionProposals: [proposal(state)] },
      }),
    );
  await writeCheckpoint("pr-ready", 9);

  const journal = new BoundedEventJournal({ capacity: 16 });
  const { adapter } = createPersistentRuntimeAdapter({ rootDir: root });
  const server = await startServer({
    port: 0,
    authToken: TOKEN,
    handlers: makeControlRoomHandlers({ adapter, journal }),
    heartbeatMs: 10_000,
  });
  const store = createControlRoomStore({ baseUrl: server.url, token: TOKEN });
  try {
    await store.start();
    await waitFor(() => assert.equal(store.getSnapshot().connection, "live"));
    const fresh = store.getSnapshot().data.runs[0].evolve[0];
    assert.equal(fresh.state, "pr-ready");
    assert.equal(fresh.cleanup.status, "retained");
    assert.equal(fresh.hashes.evaluatorEnvironment, `sha256:${"e".repeat(64)}`);
    assert.doesNotMatch(
      JSON.stringify(store.getSnapshot().data),
      /secret candidate content|\/private\/project\/path/,
    );

    await writeCheckpoint("stale", 10);
    journal.publish("session-evolution-1", "run.updated", { revision: 10 });
    await waitFor(() =>
      assert.equal(store.getSnapshot().data.runs[0].evolve[0].state, "stale"),
    );
    assert.equal(
      store.getSnapshot().data.runs[0].evolve[0].cleanup.status,
      "completed",
    );
  } finally {
    store.stop();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
