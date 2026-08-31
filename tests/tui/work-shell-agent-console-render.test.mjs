import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

const RAW_PROMPT_SENTINEL = "RAW_EXECUTOR_PROMPT_SENTINEL_DO_NOT_SHOW";
const RAW_OUTPUT_SENTINEL = "RAW_TOOL_OUTPUT_SENTINEL_DO_NOT_SHOW";

const PATCH = [
  "@@ -8,7 +8,9 @@",
  "   resetProbedTerminalBackground,",
  "+// Restores env and the probe cache after `run` finishes.",
  "-  try {",
].join("\n");

function runningSnapshot() {
  return {
    profileId: "build",
    workGraph: {
      id: "goal-1",
      goal: "Ship authentication",
      approval: "approved",
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `n${index + 1}`,
        title: `Task ${index + 1}`,
        prompt: `${RAW_PROMPT_SENTINEL} ${index + 1}`,
        status: index === 0 ? "completed" : index === 1 ? "running" : "ready",
        dependsOn: index === 0 ? [] : [`n${index}`],
        fileOwnership: [],
        acceptanceCriteria: ["observable proof"],
        evidenceRefs: [],
      })),
    },
    activity: [
      {
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read_file",
        kind: "read",
        intent: "Read session state",
        target: "session.json",
        status: "completed",
        summary: "completed · 12ms · 48 lines",
        startedAt: 1_010,
        completedAt: 1_022,
        agentRunId: "r1",
        preview: PATCH,
        output: RAW_OUTPUT_SENTINEL,
      },
    ],
    agents: [
      {
        id: "r1",
        displayName: "RuntimeMap",
        agentType: "scout",
        status: "running",
        parentRunId: "r0",
        currentActivity: "Reading runtime",
        startedAt: 1_000,
        usage: { eventIds: ["u1"], costUsd: 0.5, inputTokens: 1_200 },
      },
      {
        id: "r2",
        displayName: "DocsMap",
        agentType: "scout",
        status: "completed",
        startedAt: 1_000,
        completedAt: 4_000,
        summary: "Mapped docs.",
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "work-node",
        label: "Map runtime",
        status: "running",
        agentRunId: "r1",
        queuedAt: 900,
        startedAt: 1_000,
      },
    ],
    mainUsage: { eventIds: ["usage-main-1"], costUsd: 0.25 },
  };
}

function baseProps(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-5.4",
    reasoningLabel: "medium",
    reasoningSupported: true,
    mode: "Default",
    authLabel: "Saved OAuth",
    entries: [],
    isBusy: false,
    activePanel: { title: "", lines: [] },
    composer: React.createElement("span", null, ""),
    inputValue: "",
    slashSuggestionCount: 0,
    cwd: "/tmp/unclecode-test-workspace",
    agentConsole: runningSnapshot(),
    ...overrides,
  };
}

async function renderFrame(overrides, columns) {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, { ...baseProps(overrides), terminalColumns: columns }),
    { columns, rows: 44 },
  );
  await waitForSettledFrame(getOutput);
  const output = stripVTControlCharacters(getOutput());
  instance.unmount();
  instance.cleanup();
  return output;
}

function consoleView(overrides = {}) {
  return {
    open: true,
    tab: "agents",
    cursor: 0,
    inspectorVisible: true,
    control: { kind: "browse" },
    ...overrides,
  };
}

test("the Agent Console shows roster and inspector side by side at 100 columns", async () => {
  const frame = await renderFrame({ agentConsoleView: consoleView() }, 100);

  assert.match(frame, /\[Agents\]/, "the active tab must be marked with text, not colour alone");
  assert.match(frame, /Jobs/);
  assert.match(frame, /Plan/);
  assert.match(frame, /Quality/);
  // `DocsMap` is a roster-only row (the cursor selects `RuntimeMap`), and
  // `Elapsed` is an inspector-only fact label. Both present means two panes.
  assert.match(frame, /DocsMap/, "the roster pane must stay visible beside the inspector");
  assert.match(frame, /Elapsed/, "the inspector pane must render beside the roster");
  assert.match(frame, /Esc close/, "key hints are always visible");
  assert.doesNotMatch(frame, new RegExp(RAW_PROMPT_SENTINEL));
  assert.doesNotMatch(frame, new RegExp(RAW_OUTPUT_SENTINEL));
});

test("the Agent Console renders only the inspector pane below 100 columns", async () => {
  const frame = await renderFrame({ agentConsoleView: consoleView() }, 84);

  assert.match(frame, /Elapsed/, "the selected pane is the inspector while it is visible");
  assert.doesNotMatch(frame, /DocsMap/, "the roster pane must not share a narrow terminal");
  assert.match(frame, /\[Agents\]/);
  assert.match(frame, /Esc close/);
  assert.doesNotMatch(frame, new RegExp(RAW_PROMPT_SENTINEL));
  assert.doesNotMatch(frame, new RegExp(RAW_OUTPUT_SENTINEL));
});

test("the Agent Console falls back to the roster pane at 80 columns with the inspector hidden", async () => {
  const frame = await renderFrame(
    { agentConsoleView: consoleView({ inspectorVisible: false }) },
    80,
  );

  assert.match(frame, /DocsMap/, "the roster is the selected pane once the inspector is hidden");
  assert.doesNotMatch(frame, /Elapsed/, "a hidden inspector must not share a narrow terminal");
  assert.match(frame, /Esc close/);
});

test("the default shell keeps Plan separate from Agents and Jobs", async () => {
  const frame = await renderFrame({}, 100);

  assert.match(frame, /Ship authentication · 1\/6/, "goal progress stays in the default HUD");
  assert.doesNotMatch(frame, /RuntimeMap · running/, "agent rows belong to the explicit Agents surface");
  assert.doesNotMatch(frame, /Agents · \d+ active/, "the Plan HUD must not grow an Agents section");
  assert.doesNotMatch(frame, /… \+3 more/, "the quiet HUD is exactly three nearby progress rows plus its status line");

  // The removed detailed ledger: per-call kind column, its metric tail, and
  // the diff preview it hung under each write.
  assert.doesNotMatch(frame, /Read session state/, "detailed tool-ledger rows are gone");
  assert.doesNotMatch(frame, /48 lines/, "the tool metric column is gone");
  assert.doesNotMatch(frame, /⎿ Added/, "the default shell no longer previews diffs");
  assert.doesNotMatch(frame, new RegExp(RAW_PROMPT_SENTINEL));
  assert.doesNotMatch(frame, new RegExp(RAW_OUTPUT_SENTINEL));
});

test("the Korean quiet HUD keeps agent payloads in the explicit roster", async () => {
  const base = runningSnapshot();
  const manyAgents = Array.from({ length: 12 }, (_, index) => ({
    ...base.agents[0],
    id: `ko-run-${index}`,
    displayName: index === 0 ? "RuntimeMap" : `PayloadAgent${index}`,
  }));
  const snapshot = { ...base, agents: manyAgents };

  const hud = await renderFrame({ uiLocale: "ko", agentConsole: snapshot }, 100);
  assert.doesNotMatch(hud, /에이전트 · 12개 활성/);
  assert.doesNotMatch(hud, /RuntimeMap · 실행 중/);
  assert.doesNotMatch(hud, /… \+3개 더 있음/);
  assert.doesNotMatch(hud, /Agents ·| active| · running| more/);

  const roster = await renderFrame({
    uiLocale: "ko",
    agentConsole: snapshot,
    agentConsoleView: consoleView({ inspectorVisible: false }),
  }, 84);
  assert.match(roster, /RuntimeMap · 실행 중/);
  assert.match(roster, /화면 밖 2개 더 있음/);
  assert.doesNotMatch(roster, /running|more off screen/);
  assert.match(roster, /PayloadAgent1/, "agent names are operator payload and remain byte-for-byte");
});

test("the Korean visible inspector localizes agent and job enum chrome while preserving payload fields", async () => {
  const agentFrame = await renderFrame({
    uiLocale: "ko",
    agentConsoleView: consoleView({ inspectorVisible: true }),
  }, 100);
  assert.match(agentFrame, /RuntimeMap/);
  assert.match(agentFrame, /탐색 · 실행 중/);
  assert.match(agentFrame, /경과/);
  assert.match(agentFrame, /계보\s+상위 실행 r0/);
  assert.match(agentFrame, /활동\s+Reading runtime/, "activity payload is not translated");
  assert.doesNotMatch(agentFrame, /scout · running|child of|Elapsed|Lineage/);

  const jobFrame = await renderFrame({
    uiLocale: "ko",
    agentConsoleView: consoleView({ tab: "jobs", inspectorVisible: true }),
  }, 100);
  assert.match(jobFrame, /작업 노드 · 실행 중/);
  assert.match(jobFrame, /소유자\s+RuntimeMap/);
  assert.doesNotMatch(jobFrame, /work-node · running|Owner/);
});

test("the Korean plan inspector localizes counts, review state, hashes and evidence labels", async () => {
  const base = runningSnapshot();
  const reviewedNode = {
    ...base.workGraph.nodes[1],
    stage: "critic",
    role: "critic",
    attempt: 2,
    reviewRequired: true,
    acceptanceCriteria: ["criterion payload", "두 번째 기준 payload"],
    evidenceRefs: ["evidence:user-value"],
    artifactRefs: ["artifact:user-value"],
  };
  const snapshot = {
    ...base,
    workGraph: {
      ...base.workGraph,
      qualityProfile: "deep",
      currentStage: "critic",
      gateStatus: "refine",
      iteration: 2,
      nodes: base.workGraph.nodes.map((node, index) => index === 1 ? reviewedNode : node),
    },
    qualityReview: {
      profile: "deep",
      currentStage: "critic",
      latestDecision: "refine",
      iteration: 2,
      refineCount: 1,
      pivotCount: 0,
      failures: ["failure:user-value"],
      history: [{
        event: "gate",
        stage: "critic",
        decision: "refine",
        iteration: 2,
        failures: ["failure:user-value"],
        evidenceRefs: ["evidence:user-value"],
        artifactRefs: ["artifact:user-value"],
        reviewedArtifactHash: "sha256:reviewed-user-value",
        currentArtifactHash: "sha256:current-user-value",
        stale: true,
        reviewerId: "reviewer:user-value",
        reviewerRunId: "review-run:user-value",
        independentVerification: false,
        reason: "reason:user-value",
      }],
    },
  };
  const frame = await renderFrame({
    uiLocale: "ko",
    agentConsole: snapshot,
    agentConsoleView: consoleView({ tab: "plan", cursor: 1, inspectorVisible: true }),
  }, 100);

  assert.match(frame, /승인 기준\s+기준 2개/);
  assert.match(frame, /증거\s+참조 1개/);
  assert.match(frame, /검토\s+필수/);
  assert.match(frame, /검토자\s+reviewer:user-value · 독립 아님/);
  assert.match(frame, /현재 해시\s+sha256:current-user-value · 만료/);
  assert.match(frame, /이유 · reason:user-value/);
  assert.match(frame, /실패 · failure:user-value/);
  assert.match(frame, /증거 · evidence:user-value/);
  assert.doesNotMatch(frame, /criteria|refs|required|not independent|stale|Reason ·|Failure ·|Evidence ·/);
  for (const payload of [
    "artifact:user-value",
    "reviewer:user-value",
    "sha256:reviewed-user-value",
    "sha256:current-user-value",
    "reason:user-value",
    "failure:user-value",
    "evidence:user-value",
  ]) {
    assert.match(frame, new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the Quality tab presents the projected SCC gate, critic evidence, and iteration history", async () => {
  const base = runningSnapshot();
  const snapshot = {
    ...base,
    workGraph: {
      ...base.workGraph,
      qualityProfile: "deep",
      currentStage: "critic",
      gateStatus: "unproven",
      iteration: 4,
      nodes: base.workGraph.nodes.map((node, index) => ({
        ...node,
        stage: index === 0 ? "critic" : "work",
        role: index === 0 ? "critic" : "worker",
        status: index === 0 ? "failed" : node.status,
        attempt: 1,
        artifactRefs: index === 0 ? ["artifacts/auth.patch"] : [],
        reviewRequired: true,
      })),
    },
    qualityReview: {
      runId: "quality-run-1",
      graphId: "goal-1",
      profile: "deep",
      currentStage: "critic",
      iteration: 4,
      refineCount: 1,
      pivotCount: 1,
      latestDecision: "unproven",
      history: [
        {
          event: "gate",
          stage: "critic",
          decision: "unproven",
          iteration: 1,
          reason: "Independent proof expired",
          failures: ["Session expiry remains untested"],
          evidenceRefs: ["evidence/auth-review.json"],
          artifactRefs: ["artifacts/auth.patch"],
          reviewedArtifactHash: "sha256:reviewed-auth",
          currentArtifactHash: "sha256:current-auth",
          reviewerId: "critic-auth",
          independentVerification: true,
          stale: true,
          startedAt: 10,
        },
        {
          event: "refine", stage: "work", decision: "refine", iteration: 2,
          failures: [], evidenceRefs: [], artifactRefs: [], independentVerification: false, stale: false, startedAt: 20,
        },
        {
          event: "pivot", stage: "plan", decision: "pivot", iteration: 3,
          failures: [], evidenceRefs: [], artifactRefs: [], independentVerification: false, stale: false, startedAt: 30,
        },
        {
          event: "completed", stage: "promote", decision: "proceed", iteration: 4,
          failures: [], evidenceRefs: [], artifactRefs: [], independentVerification: true, stale: false, startedAt: 40,
        },
      ],
    },
  };

  const frame = await renderFrame({
    agentConsole: snapshot,
    agentConsoleView: consoleView({ tab: "quality", cursor: 0 }),
  }, 120);

  assert.match(frame, /\[Quality\]/);
  assert.match(frame, /Quality Engine \(SCC\)/);
  assert.match(frame, /Gate · unproven/);
  assert.match(frame, /Unproven · independent review evidence is missing or stale/);
  assert.match(frame, /Finding · Task 1 · failed/);
  assert.match(frame, /Critic finding · Session expiry remains untested/);
  assert.match(frame, /Evidence · evidence\/auth-review\.json/);
  assert.match(frame, /Reviewed hash · sha256:reviewed-auth/);
  assert.match(frame, /Current hash · sha256:current-auth · stale/);
  assert.match(frame, /iteration 2 · work · refine/);
  assert.match(frame, /iteration 3 · plan · pivot/);
  assert.match(frame, /iteration 4 · promote · completed/);
  assert.match(frame, /History · 1 refine · 1 pivot/);
  assert.match(frame, /Promote · handoff\/synthesis only/);
  assert.match(frame, /Enter detail · Esc close · read-only/);
  assert.doesNotMatch(frame, /s steer · x cancel · r continue/);

  const korean = await renderFrame({
    uiLocale: "ko",
    agentConsole: snapshot,
    agentConsoleView: consoleView({ tab: "quality", cursor: 0 }),
  }, 120);
  assert.match(korean, /반복 1 · 비평 · 게이트/);
  assert.match(korean, /반복 2 · 작업 · 개선/);
  assert.match(korean, /반복 3 · 계획 · 전환/);
  assert.match(korean, /반복 4 · 정리 · 완료/);
  assert.doesNotMatch(korean, /· (gate|refine|pivot|completed)/);
  assert.match(korean, /읽기 전용/);
});

test("an empty SCC cockpit is actionable without a dead roster or inspector", async () => {
  const frame = await renderFrame({
    agentConsole: {
      profileId: "build",
      activity: [],
      agents: [],
      jobs: [],
    },
    agentConsoleView: consoleView({ tab: "quality", cursor: 0 }),
  }, 100);

  assert.match(frame, /SCC Quality Engine · ready/);
  assert.match(frame, /No quality run recorded for this session\./);
  assert.match(frame, /Start a task, or \/scc review <target> for an explicit review\./);
  assert.doesNotMatch(frame, /No Quality Engine review history yet\./);
  assert.doesNotMatch(frame, /Select a row to inspect\./);
  assert.doesNotMatch(frame, /Enter detail/);
});

test("an active SCC run without history stays actionable and bounds thirty-two findings", async () => {
  const base = runningSnapshot();
  const failedCritics = Array.from({ length: 32 }, (_, index) => ({
    ...base.workGraph.nodes[0],
    id: `critic-${index + 1}`,
    title: `Critic finding ${index + 1}`,
    status: "failed",
    stage: "critic",
    role: "critic",
  }));
  const frame = await renderFrame({
    agentConsole: {
      profileId: "build",
      activity: [],
      agents: [],
      jobs: [],
      workGraph: {
        ...base.workGraph,
        qualityProfile: "deep",
        currentStage: "critic",
        gateStatus: "refine",
        iteration: 2,
        nodes: failedCritics,
      },
      qualityReview: {
        runId: "quality-active-no-history",
        graphId: "goal-1",
        profile: "deep",
        currentStage: "critic",
        iteration: 2,
        refineCount: 0,
        pivotCount: 0,
        latestDecision: "refine",
        history: [],
      },
    },
    agentConsoleView: consoleView({ tab: "quality", cursor: 0 }),
  }, 100);

  assert.match(frame, /Quality Engine \(SCC\) · deep · critic · PDCA check · iteration 2/);
  assert.match(frame, /No review history recorded yet\./);
  assert.match(frame, /Critic findings · 32 total/);
  assert.match(frame, /… \+29 more findings/);
  assert.match(frame, /Next · /);
  assert.doesNotMatch(frame, /No Quality Engine review history yet\./);
  assert.doesNotMatch(frame, /Select a row to inspect\./);
  assert.doesNotMatch(frame, /Enter detail/);
  assert.ok(
    frame.split("\n").filter((line) => /Finding · Critic finding/.test(line)).length <= 3,
    "the quality summary must not turn thirty-two findings into thirty-two layout rows",
  );
});

test("the SCC cockpit selects the latest history event by default", async () => {
  const base = runningSnapshot();
  const history = [
    {
      event: "gate",
      stage: "critic",
      decision: "refine",
      iteration: 1,
      failures: ["old finding"],
      evidenceRefs: [],
      artifactRefs: [],
      independentVerification: false,
      stale: false,
      startedAt: 10,
    },
    {
      event: "completed",
      stage: "promote",
      decision: "proceed",
      iteration: 2,
      failures: [],
      evidenceRefs: ["evidence:latest"],
      artifactRefs: [],
      independentVerification: true,
      stale: false,
      startedAt: 20,
    },
  ];
  const frame = await renderFrame({
    agentConsole: {
      ...base,
      qualityReview: {
        runId: "quality-latest",
        graphId: "goal-1",
        profile: "deep",
        currentStage: "promote",
        iteration: 2,
        refineCount: 1,
        pivotCount: 0,
        latestDecision: "proceed",
        history,
      },
    },
    agentConsoleView: consoleView({ tab: "quality", cursor: 0 }),
  }, 100);

  assert.match(frame, /› .*iteration 2 · promote · comp/);
  assert.doesNotMatch(frame, /› .*iteration 1 · critic · gate/);
  assert.match(frame, /Iteration 2 · completed/);
  assert.match(frame, /evidence:latest/);
});

/**
 * Ink writes one whole frame per render in debug mode and the harness
 * accumulates them, so physical-height assertions must read the newest frame.
 * Every frame opens on the work-shell header.
 */
function lastFrame(output) {
  const marker = output.lastIndexOf("UncleCode ·");
  return (marker < 0 ? output : output.slice(marker)).trimEnd();
}

function physicalRows(output) {
  return lastFrame(output).split("\n").length;
}

const HOSTILE_TAIL = "\n두 번째 줄\u0007 그리고 아주 긴 한국어 문자열이 계속 이어집니다 계속 계속 계속";

/**
 * Same shape as the benign fixture, hostile values. `parseAgentConsoleSnapshot`
 * accepts every one of these strings, so the renderer is the only thing that
 * can keep them on one row.
 */
function hostileSnapshot() {
  const base = runningSnapshot();
  const nastier = (value) => `${value}${HOSTILE_TAIL}`;
  return {
    ...base,
    workGraph: {
      ...base.workGraph,
      goal: nastier(base.workGraph.goal),
      nodes: base.workGraph.nodes.map((node) => ({ ...node, title: nastier(node.title) })),
    },
    activity: base.activity.map((entry) => ({
      ...entry,
      intent: nastier(entry.intent),
      summary: nastier(entry.summary),
    })),
    agents: base.agents.map((run) => ({
      ...run,
      displayName: nastier(run.displayName),
      ...(run.currentActivity ? { currentActivity: nastier(run.currentActivity) } : {}),
      ...(run.summary ? { summary: nastier(run.summary) } : {}),
    })),
    jobs: base.jobs.map((job) => ({ ...job, label: nastier(job.label) })),
  };
}

test("the Agent Console breakpoint follows the terminal, not the inner layout width", async () => {
  const narrow = await renderFrame({ agentConsoleView: consoleView() }, 99);
  assert.match(narrow, /Elapsed/, "99 columns is one pane: the visible inspector");
  assert.doesNotMatch(narrow, /DocsMap/, "99 columns must not open a second pane");

  // The console breakpoint is a terminal-width contract. Charging the chrome's
  // own four columns against it must not move the real breakpoint above 100.
  for (const columns of [100, 120]) {
    const wide = await renderFrame({ agentConsoleView: consoleView() }, columns);
    assert.match(wide, /DocsMap/, `${columns} columns must show the roster pane`);
    assert.match(wide, /Elapsed/, `${columns} columns must show the inspector pane`);
  }
});

test("hostile agent, job and task strings never change the console's physical height", async () => {
  // Every tab: the agents tab carries lineage and activity, the jobs tab adds
  // the owner name, and the plan tab adds dependency and ownership lists.
  for (const tab of ["agents", "jobs", "plan"]) {
    const benign = await renderFrame({ agentConsoleView: consoleView({ tab }) }, 84);
    const hostile = await renderFrame(
      { agentConsole: hostileSnapshot(), agentConsoleView: consoleView({ tab }) },
      84,
    );

    assert.equal(
      physicalRows(hostile),
      physicalRows(benign),
      `${tab}: a newline or over-long field must be flattened and budgeted, not wrapped by ink`,
    );
    assert.match(hostile, /Esc close/, `${tab}: key hints survive hostile content`);
    assert.match(hostile, /Jobs/, `${tab}: tabs survive hostile content`);
  }
});

test("hostile goal, task and agent strings never change the default HUD's physical height", async () => {
  const benign = await renderFrame({}, 84);
  const hostile = await renderFrame({ agentConsole: hostileSnapshot() }, 84);

  assert.equal(physicalRows(hostile), physicalRows(benign));
});

test("emoji task titles are measured as ink renders them, so the HUD row never wraps", async () => {
  const withTitle = (title) => {
    const base = runningSnapshot();
    return {
      ...base,
      workGraph: {
        ...base.workGraph,
        nodes: base.workGraph.nodes.map((node, index) => (index === 1 ? { ...node, title } : node)),
      },
    };
  };

  const ascii = await renderFrame({ agentConsole: withTitle("R".repeat(40)) }, 60);
  const emoji = await renderFrame({ agentConsole: withTitle("\u{1F680}".repeat(40)) }, 60);

  // Counting a rocket as one cell keeps twice the glyphs the row can hold, so
  // ink wraps the "truncated" row onto a second line.
  assert.equal(physicalRows(emoji), physicalRows(ascii));
});

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test("the explicit agent inspector advances elapsed labels while the main turn is idle", async () => {
  const base = runningSnapshot();
  const startedAt = Date.now() - 2_000;
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      ...baseProps({
        agentConsoleView: consoleView(),
        agentConsole: {
          ...base,
          agents: [{ ...base.agents[0], startedAt }],
          jobs: [],
        },
      }),
      terminalColumns: 100,
    }),
    { columns: 100, rows: 44 },
  );
  try {
    await waitForSettledFrame(getOutput);
    assert.match(stripVTControlCharacters(getOutput()), /Elapsed\s+2s/);
    // No keypress, no engine event — only the shell's own clock.
    await delay(1_400);
    const elapsed = [...stripVTControlCharacters(getOutput()).matchAll(/Elapsed\s+(\d+)s/g)]
      .map((match) => Number(match[1]));
    assert.ok(Math.max(...elapsed) > 2, `elapsed label did not advance: ${elapsed.join(", ")}`);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("the shell clock stops once no console record is still active", async () => {
  const base = runningSnapshot();
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      ...baseProps({
        agentConsole: {
          ...base,
          agents: base.agents.map((run) => ({ ...run, status: "completed", completedAt: run.startedAt + 10 })),
          jobs: base.jobs.map((job) => ({ ...job, status: "completed", completedAt: job.queuedAt + 10 })),
        },
      }),
      terminalColumns: 100,
    }),
    { columns: 100, rows: 44 },
  );
  try {
    await waitForSettledFrame(getOutput);
    const settled = getOutput();
    await delay(1_400);
    assert.equal(getOutput(), settled, "a settled console must not repaint the shell on a timer");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

/**
 * A CRLF patch carrying a tab, a BEL, and a real ANSI colour sequence — all of
 * it contract-valid preview content.
 */
const CONTROL_PATCH = [
  "@@ -8,7 +8,9 @@",
  "   resetProbedTerminalBackground,\r",
  "+\tconst label = \u001b[31mred\u001b[0m;\r",
  "+\u0007alert();\r",
  "-  try {\r",
].join("\n");

/** C0 except newline, plus C1 and the Unicode line/paragraph separators. */
const LAYOUT_BREAKING = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

test("a diff preview cannot smuggle control bytes into the rendered console", async () => {
  const base = runningSnapshot();
  const columns = 100;
  const frame = await renderFrame(
    {
      agentConsole: {
        ...base,
        activity: base.activity.map((entry) => ({ ...entry, preview: CONTROL_PATCH })),
      },
      agentConsoleView: consoleView(),
    },
    columns,
  );

  // `stripVTControlCharacters` removes ink's own colour sequences but leaves a
  // stray tab, CR, or BEL behind — exactly the bytes a preview must not carry.
  const offending = frame
    .split("\n")
    .filter((line) => LAYOUT_BREAKING.test(line))
    .map((line) => JSON.stringify(line));
  assert.deepEqual(offending, [], "a preview row reached the terminal with a control byte");

  for (const line of frame.split("\n")) {
    assert.ok(
      getDisplayWidth(line) <= columns,
      `frame line measured ${getDisplayWidth(line)} cells: ${line}`,
    );
  }
  assert.match(frame, /⎿ Added \d+ lines?, removed \d+ lines?/, "the diff summary row survives");
  assert.match(frame, /const label/, "the changed content survives");
  assert.match(frame, /Esc close/, "key hints stay visible");
});

// Task 8 left the console's two control states invisible: `x` armed a modal
// confirmation with nothing on screen saying so, and every rejected or
// undeliverable operation produced silence. Both are rendered from view state
// alone, so a settled console cannot strand a question or a stale outcome.

test("an armed cancel confirmation asks an explicit question naming the selected run", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        control: { kind: "confirm-cancel", agentRunId: "r1" },
      }),
    },
    100,
  );

  assert.match(frame, /Cancel RuntimeMap\?/, "the question must name the run it will cancel");
  assert.match(frame, /y confirm/, "y is the accepted confirmation key");
  assert.match(frame, /n keep running/, "n is the accepted decline key");
  assert.match(frame, /Esc dismiss/, "Esc is the accepted dismissal key");
});

test("Korean agent controls localize chrome while preserving the selected run name", async () => {
  const confirm = await renderFrame(
    {
      uiLocale: "ko",
      agentConsoleView: consoleView({
        control: { kind: "confirm-cancel", agentRunId: "r1" },
      }),
    },
    100,
  );
  assert.match(confirm, /⚠ RuntimeMap 취소\? y 확인 · n 계속 실행 · Esc 닫기/u);
  assert.doesNotMatch(confirm, /Cancel RuntimeMap|y confirm|keep running|Esc dismiss/);

  for (const [status, expected] of [
    ["accepted", "제어 승인됨"],
    ["not_delivered", "제어 전달 안 됨"],
    ["rejected", "제어 거부됨"],
  ]) {
    const receipt = await renderFrame({
      uiLocale: "ko",
      agentConsoleView: consoleView({ receipt: { status, message: "RAW_ENGINE_MESSAGE" } }),
    }, 100);
    assert.match(receipt, new RegExp(expected, "u"));
    assert.doesNotMatch(receipt, /Control accepted|Control not delivered|Control rejected|RAW_ENGINE_MESSAGE/);
  }
});

test("a browsing console carries no cancel question and no outcome row", async () => {
  const frame = await renderFrame({ agentConsoleView: consoleView() }, 100);

  assert.doesNotMatch(frame, /Cancel RuntimeMap\?/, "an unarmed console must not ask");
  assert.doesNotMatch(frame, /y confirm/);
  assert.match(frame, /Esc close/, "the ordinary key hints are still there");
});

test("a declined confirmation leaves no stale question behind", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        control: { kind: "browse" },
        receipt: { status: "rejected", message: "Select a running agent to cancel." },
      }),
    },
    100,
  );

  assert.doesNotMatch(frame, /Cancel RuntimeMap\?/);
  assert.match(frame, /Control rejected/);
});

test("an accepted control outcome is visible to the operator", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        receipt: { status: "accepted", message: "Cancellation requested for RuntimeMap." },
      }),
    },
    100,
  );

  assert.match(frame, /Control accepted/);
});

test("an undeliverable control outcome is visible to the operator", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        receipt: { status: "not_delivered", message: "Agent controls are unavailable." },
      }),
    },
    100,
  );

  assert.match(frame, /Control not delivered/);
});

test("a hostile control receipt cannot break the console frame or leak its raw text", async () => {
  const columns = 100;
  const hostile = `steer failed\r\n\u0007\tat Object.<anonymous> (/Users/dev/.config/token=${"S".repeat(400)})`;
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        receipt: { status: "rejected", message: hostile },
      }),
    },
    columns,
  );

  const offending = frame
    .split("\n")
    .filter((line) => LAYOUT_BREAKING.test(line))
    .map((line) => JSON.stringify(line));
  assert.deepEqual(offending, [], "a receipt reached the terminal with a control byte");
  for (const line of frame.split("\n")) {
    assert.ok(
      getDisplayWidth(line) <= columns,
      `frame line measured ${getDisplayWidth(line)} cells: ${line}`,
    );
  }
  assert.doesNotMatch(frame, /steer failed|token=|\/Users\/|S{10}/, "engine receipt prose must not reach the frame");
  assert.match(frame, /Control rejected/, "the operator still learns the control status");
});
