import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { persistWorkShellSessionSnapshot } from "@unclecode/orchestrator";
import { createControlRoomStore } from "../../apps/godness-web/src/control-room-store.js";

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

async function startStandaloneServer(root, sessionStoreRoot) {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--conditions=source",
      "--import",
      "tsx",
      "apps/unclecode-server/src/cli.ts",
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        HOME: root,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        UNCLECODE_SERVER_HOST: "127.0.0.1",
        UNCLECODE_SERVER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { output += chunk; });
  const url = await waitFor(() => {
    const match = output.match(/unclecode-server listening on (http:\/\/127\.0\.0\.1:\d+)/u);
    assert.ok(match?.[1], output);
    return match[1];
  }, 5_000);
  const token = (await readFile(path.join(root, ".unclecode", "server.token"), "utf8")).trim();
  return {
    child,
    token,
    url,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("standalone server did not stop")), 2_000)),
      ]);
    },
  };
}

async function readReplayIds(url, token, sessionId, count) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("SSE replay timed out")), 2_000);
  try {
    const response = await fetch(`${url}/sessions/${sessionId}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const ids = [];
    while (ids.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const id = Number.parseInt(frame.match(/^id:\s*(\d+)$/mu)?.[1] ?? "", 10);
        if (Number.isSafeInteger(id)) ids.push(id);
      }
    }
    await reader.cancel();
    return ids;
  } finally {
    clearTimeout(timeout);
  }
}

test("actual Work Shell persistence refreshes the real web store through standalone bearer SSE", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "unclecode-evolution-transport-"),
  );
  const sessionStoreRoot = path.join(root, "sessions");
  const sessionId = "session-evolution-1";
  const persistenceEnv = {
    ...process.env,
    UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
  };
  const server = await startStandaloneServer(root, sessionStoreRoot);
  const persist = (state) => persistWorkShellSessionSnapshot({
    cwd: root,
    env: persistenceEnv,
    sessionId,
    model: "gpt-5.6-sol",
    mode: "build",
    state: "idle",
    summary: `Recorded evolution proposal: ${state}`,
    entries: [],
    agentConsole: {
      profileId: "build",
      activity: [],
      evolutionProposals: [proposal(state)],
    },
  });
  await persist("stale");
  const eventRequests = [];
  const store = createControlRoomStore({
    baseUrl: server.url,
    token: server.token,
    async fetchImpl(url, options) {
      if (String(url).endsWith(`/sessions/${sessionId}/events`)) {
        eventRequests.push(options?.headers?.authorization);
      }
      return fetch(url, options);
    },
  });
  try {
    await store.start();
    await waitFor(() => assert.equal(store.getSnapshot().connection, "live"));
    const historical = store.getSnapshot().data.runs[0].evolve[0];
    assert.equal(historical.state, "stale");
    assert.equal(historical.cleanup.status, "completed");
    assert.equal(historical.hashes.evaluatorEnvironment, `sha256:${"e".repeat(64)}`);
    assert.doesNotMatch(
      JSON.stringify(store.getSnapshot().data),
      /secret candidate content/,
    );
    assert.equal(JSON.stringify(store.getSnapshot().data).includes(root), false);

    await persist("pr-ready");
    await waitFor(() =>
      assert.equal(store.getSnapshot().data.runs[0].evolve[0].state, "pr-ready"),
    );
    assert.equal(
      store.getSnapshot().data.runs[0].evolve[0].cleanup.status,
      "retained",
    );
    assert.deepEqual(eventRequests, [`Bearer ${server.token}`]);
    assert.deepEqual(await readReplayIds(server.url, server.token, sessionId, 2), [1, 2]);
  } finally {
    store.stop();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
