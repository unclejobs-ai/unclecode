import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { selectRecordedEvolutionProposalLines } from "../../packages/tui/src/evolution-proposal-lines.ts";
import { WorkShellAgentConsoleOverlay } from "../../packages/tui/src/work-shell-agent-console-view.tsx";
import {
  renderDebugFrame,
  waitForSettledFrame,
} from "./work-shell-render-harness.mjs";

function proposal(overrides = {}) {
  return {
    id: "proposal-1",
    runId: "run-1",
    candidateId: "candidate-1",
    creatorId: "creator",
    evaluatorId: "evaluator",
    attestorId: "attestor",
    state: "pr-ready",
    isolation: "worktree",
    isolatedBranch: "unclecode/evolve/candidate-1",
    isolatedWorktree: "/private/worktree",
    heldOutBenchmark: true,
    heldOutBenchmarkId: "suite",
    humanApproval: "pending",
    mergeRequiresHumanApproval: true,
    stale: false,
    changedAssets: [],
    hashes: {
      candidateArtifact: "sha256:candidate",
      evaluator: "sha256:evaluator",
      evaluatorEnvironment: "sha256:environment",
      policy: "sha256:policy",
      suite: "sha256:suite",
    },
    comparison: {
      baselineScore: 0.7,
      candidateScore: 0.9,
      delta: 0.2,
      passed: true,
      thresholdsHash: "sha256:thresholds",
    },
    attestation: {
      timestamp: "2026-08-28T12:00:00.000Z",
      maxAgeMs: 300_000,
      branchExists: true,
      worktreeExists: true,
    },
    cleanup: {
      status: "retained",
      resources: [
        {
          kind: "branch",
          identity: "unclecode/evolve/candidate-1",
          status: "retained",
        },
        { kind: "worktree", identity: "/private/worktree", status: "retained" },
        {
          kind: "baseline-worktree",
          identity: "/private/baseline",
          status: "removed",
        },
      ],
    },
    failures: [],
    summary: "recorded",
    artifactRefs: [],
    createdAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

test("current and present labels are reserved for a fresh PR-ready candidate with retained resources", () => {
  const fresh = selectRecordedEvolutionProposalLines(proposal(), 160).join(
    "\n",
  );
  assert.match(fresh, /Candidate hash · sha256:candidate · current/);
  assert.match(fresh, /current branch\+worktree present/);

  const historical = selectRecordedEvolutionProposalLines(
    proposal({
      state: "stale",
      stale: true,
      cleanup: {
        status: "completed",
        resources: [
          {
            kind: "branch",
            identity: "unclecode/evolve/candidate-1",
            status: "removed",
          },
          {
            kind: "worktree",
            identity: "/private/worktree",
            status: "removed",
          },
        ],
      },
    }),
    160,
  ).join("\n");
  assert.match(
    historical,
    /Candidate hash · sha256:candidate · recorded\/historical/,
  );
  assert.match(historical, /historical attestation · resources removed/);
  assert.doesNotMatch(historical, / · current|present|isolation missing/);
});

test("the actual Agent Console overlay calls the historical evolution projection", async () => {
  const snapshot = {
    profileId: "build",
    evolutionProposals: [
      proposal({
        state: "rejected",
        cleanup: {
          status: "completed",
          resources: [
            {
              kind: "branch",
              identity: "unclecode/evolve/candidate-1",
              status: "removed",
            },
            {
              kind: "worktree",
              identity: "/private/worktree",
              status: "removed",
            },
          ],
        },
      }),
    ],
    activity: [],
    agents: [],
    jobs: [],
  };
  const palette = {
    assistant: "cyan",
    user: "blue",
    text: "white",
    textMuted: "gray",
    textDim: "gray",
    success: "green",
    warning: "yellow",
    danger: "red",
    borderSoft: "gray",
  };
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellAgentConsoleOverlay, {
      snapshot,
      view: { open: true, tab: "agents", cursor: 0, inspectorVisible: false },
      terminalColumns: 100,
      width: 96,
      borderColor: "gray",
      palette,
    }),
    { columns: 100, rows: 36 },
  );
  try {
    await waitForSettledFrame(getOutput);
    const frame = stripVTControlCharacters(getOutput());
    assert.match(
      frame,
      /Candidate hash · sha256:candidate · recorded\/historical/,
    );
    assert.doesNotMatch(
      frame,
      /Candidate hash .* · current|branch\+worktree present/,
    );
  } finally {
    instance.unmount();
  }
});
