import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAgentConsoleTotalCost,
  hasActiveAgentConsoleWork,
  selectActiveAgentHudRows,
  selectAgentConsoleInspector,
  selectAgentConsoleRows,
  selectActiveAgentConsoleCounts,
  selectWorkGraphHudRows,
} from "../../packages/tui/src/work-shell-agent-console-model.ts";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";

const RAW_PROMPT_SENTINEL = "RAW_EXECUTOR_PROMPT_SENTINEL_DO_NOT_SHOW";

function snapshot(overrides = {}) {
  return {
    profileId: "build",
    activity: [],
    agents: [],
    jobs: [],
    ...overrides,
  };
}

function node(overrides) {
  return {
    prompt: RAW_PROMPT_SENTINEL,
    dependsOn: [],
    fileOwnership: [],
    evidenceRefs: [],
    ...overrides,
  };
}

function agent(overrides) {
  return {
    agentType: "executor",
    startedAt: 1_000,
    ...overrides,
  };
}

test("the WorkGraph HUD shows current work, the next stage, and one blocker without overflow noise", () => {
  const rows = selectWorkGraphHudRows(
    snapshot({
      workGraph: {
        id: "goal-1",
        goal: "Ship authentication",
        approval: "approved",
        nodes: [
          node({ id: "n1", title: "Draft schema", status: "completed" }),
          node({ id: "n2", title: "Wire session store", status: "ready" }),
          node({ id: "n3", title: "Land refresh flow", status: "running" }),
          node({ id: "n4", title: "Await review", status: "requires_action" }),
          node({ id: "n5", title: "Backfill tokens", status: "ready" }),
          node({ id: "n6", title: "Rotate secrets", status: "failed" }),
        ],
      },
    }),
    120,
  );

  // Snapshot order would put "Draft schema" first; the quiet hierarchy must
  // instead show current → remaining → blocker and stop at three nearby rows.
  assert.deepEqual(rows, [
    "Ship authentication · 1/6",
    "  ◐ Land refresh flow · running",
    "  ○ Wire session store · ready",
    "  ▲ Await review · requires action",
  ]);
});

test("the WorkGraph HUD keeps a Korean task title inside the row's display width", () => {
  const width = 44;
  const rows = selectWorkGraphHudRows(
    snapshot({
      workGraph: {
        id: "goal-1",
        goal: "인증",
        approval: "approved",
        nodes: [node({
          id: "n1",
          title: "인증 토큰 갱신 파이프라인 재설계 작업",
          status: "running",
        })],
      },
    }),
    width,
  );

  const taskRow = rows[1] ?? "";
  // A `.length`-based clip would leave a 60-cell row inside a 44-column pane.
  assert.ok(
    getDisplayWidth(taskRow) <= width,
    `task row measured ${getDisplayWidth(taskRow)} cells: ${taskRow}`,
  );
  assert.ok(taskRow.includes("…"), `expected an elided title, got: ${taskRow}`);
  assert.ok(taskRow.endsWith("· running"), `status must survive truncation: ${taskRow}`);
});

test("the active agent HUD admits only running and waiting runs", () => {
  const rows = selectActiveAgentHudRows(
    snapshot({
      agents: [
        agent({ id: "r1", displayName: "QueuedMap", status: "queued" }),
        agent({ id: "r2", displayName: "RuntimeMap", status: "running" }),
        agent({ id: "r3", displayName: "DoneMap", status: "completed" }),
        agent({ id: "r4", displayName: "WaitMap", status: "waiting" }),
        agent({ id: "r5", displayName: "FailMap", status: "failed" }),
        agent({ id: "r6", displayName: "StopMap", status: "cancelled" }),
        agent({ id: "r7", displayName: "LostMap", status: "interrupted" }),
      ],
    }),
    2_000,
    120,
  );

  const text = rows.join("\n");
  assert.match(text, /Agents · 2 active/);
  assert.match(text, /RuntimeMap · running/);
  assert.match(text, /WaitMap · waiting/);
  for (const settled of ["QueuedMap", "DoneMap", "FailMap", "StopMap", "LostMap"]) {
    assert.doesNotMatch(text, new RegExp(settled), `${settled} is not active work`);
  }
});

test("the active agent HUD renders four rows and an overflow count", () => {
  const rows = selectActiveAgentHudRows(
    snapshot({
      agents: Array.from({ length: 6 }, (_, index) => agent({
        id: `r${index + 1}`,
        displayName: `Worker${index + 1}`,
        status: "running",
      })),
    }),
    2_000,
    120,
  );

  // heading + four bounded rows + one overflow line.
  assert.equal(rows.length, 6);
  assert.match(rows[0] ?? "", /Agents · 6 active/);
  assert.match(rows[4] ?? "", /Worker4/);
  assert.equal(rows[5], "  … +2 more");
});

test("the active agent HUD keeps a Korean name and activity inside the row's display width", () => {
  const width = 60;
  const rows = selectActiveAgentHudRows(
    snapshot({
      agents: [agent({
        id: "r1",
        displayName: "한국어에이전트이름아주긴것",
        status: "running",
        currentActivity: "매우 긴 한국어 활동 설명 문자열입니다 계속 이어집니다",
      })],
    }),
    14_000,
    width,
  );

  const row = rows[1] ?? "";
  assert.ok(
    getDisplayWidth(row) <= width,
    `agent row measured ${getDisplayWidth(row)} cells: ${row}`,
  );
  assert.match(row, /· running 13s ·/);
});

test("total console cost counts main usage and each agent's usage exactly once", () => {
  const total = formatAgentConsoleTotalCost(snapshot({
    mainUsage: { eventIds: ["usage-main-1"], costUsd: 0.25 },
    agents: [
      agent({
        id: "r1",
        displayName: "RuntimeMap",
        status: "running",
        // Routes are a breakdown of the same spend, not extra spend.
        usage: {
          eventIds: ["usage-1", "usage-2"],
          costUsd: 0.5,
          routes: [
            { provider: "openai", model: "gpt-5.4", eventIds: ["usage-1"], costUsd: 0.2 },
            { provider: "openai", model: "gpt-5.4", eventIds: ["usage-2"], costUsd: 0.3 },
          ],
        },
      }),
      agent({
        id: "r2",
        displayName: "DocsMap",
        status: "completed",
        usage: { eventIds: ["usage-3"], costUsd: 0.25 },
      }),
    ],
  }));

  assert.equal(total, "$1.00");
});

test("total console cost deduplicates overlapping usage event ids", () => {
  const total = formatAgentConsoleTotalCost(snapshot({
    mainUsage: { eventIds: ["u1", "u2"], costUsd: 2 },
    agents: [
      agent({
        id: "r1",
        displayName: "RuntimeMap",
        status: "completed",
        usage: { eventIds: ["u2", "u3"], costUsd: 4 },
      }),
      agent({
        id: "r2",
        displayName: "ReplayMap",
        status: "completed",
        usage: { eventIds: ["u1"], costUsd: 1 },
      }),
    ],
  }));

  assert.equal(total, "$4.00");
});

test("total console cost is undefined when every usage record is unknown or zero", () => {
  assert.equal(formatAgentConsoleTotalCost(snapshot()), undefined);
  assert.equal(
    formatAgentConsoleTotalCost(snapshot({
      mainUsage: { eventIds: ["usage-main-1"], inputTokens: 900 },
      agents: [
        agent({ id: "r1", displayName: "RuntimeMap", status: "running", usage: { eventIds: ["u1"], costUsd: 0 } }),
        agent({ id: "r2", displayName: "DocsMap", status: "completed", usage: { eventIds: ["u2"] } }),
      ],
    })),
    undefined,
  );
});

test("console lists retain settled agents and jobs in snapshot order", () => {
  const state = snapshot({
    agents: [
      agent({ id: "r1", displayName: "RuntimeMap", status: "running", currentActivity: "Reading runtime" }),
      agent({ id: "r2", displayName: "DocsMap", status: "completed", summary: "Mapped docs." }),
      agent({ id: "r3", displayName: "StopMap", status: "cancelled", summary: "Cancelled by operator." }),
    ],
    jobs: [
      { id: "job-1", type: "work-node", label: "Map runtime", status: "running", agentRunId: "r1", queuedAt: 9, startedAt: 10 },
      { id: "job-2", type: "work-node", label: "Map docs", status: "completed", agentRunId: "r2", queuedAt: 9, startedAt: 10, completedAt: 40 },
    ],
    workGraph: {
      id: "goal-1",
      goal: "Ship authentication",
      approval: "approved",
      nodes: [
        node({ id: "n1", title: "Map runtime", status: "running" }),
        node({ id: "n2", title: "Map docs", status: "completed" }),
      ],
    },
  });

  // The cursor indexes the raw snapshot arrays, so filtering settled records
  // here would address the wrong run.
  assert.deepEqual(
    selectAgentConsoleRows(state, "agents").map((row) => [row.id, row.statusLabel]),
    [["r1", "running"], ["r2", "completed"], ["r3", "cancelled"]],
  );
  assert.deepEqual(
    selectAgentConsoleRows(state, "jobs").map((row) => [row.id, row.statusLabel]),
    [["job-1", "running"], ["job-2", "completed"]],
  );
  assert.deepEqual(
    selectAgentConsoleRows(state, "plan").map((row) => [row.id, row.statusLabel]),
    [["n1", "running"], ["n2", "completed"]],
  );
});

test("the agent inspector projects safe lifecycle facts and a filtered tool timeline", () => {
  const state = snapshot({
    agents: [
      agent({
        id: "r1",
        displayName: "RuntimeMap",
        agentType: "scout",
        status: "running",
        parentRunId: "r0",
        currentActivity: "Reading runtime",
        startedAt: 1_000,
        usage: { eventIds: ["u1"], costUsd: 0.5, inputTokens: 1_200 },
      }),
    ],
    activity: [
      {
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read_file",
        kind: "read",
        intent: "Read runtime entry",
        status: "completed",
        summary: "completed · 12ms",
        startedAt: 1_010,
        completedAt: 1_022,
        agentRunId: "r1",
      },
      {
        id: "tool-2",
        toolCallId: "call-2",
        toolName: "read_file",
        kind: "read",
        intent: "Main agent read",
        status: "completed",
        startedAt: 1_030,
      },
    ],
  });

  const inspector = selectAgentConsoleInspector(
    state,
    { tab: "agents", run: state.agents[0] },
    14_000,
    72,
  );

  assert.equal(inspector?.title, "RuntimeMap");
  assert.equal(inspector?.subtitle, "scout · running");
  const facts = Object.fromEntries((inspector?.facts ?? []).map((fact) => [fact.label, fact.value]));
  assert.equal(facts.Elapsed, "13s");
  assert.equal(facts.Lineage, "child of r0");
  assert.equal(facts.Activity, "Reading runtime");
  assert.equal(facts.Cost, "$0.50");
  // Only the run's own tool calls; the main agent's call is a different scope.
  assert.deepEqual(inspector?.timeline, ["  ● Read runtime entry · completed · 12ms"]);
});

test("the plan inspector never exposes a work node's executor prompt", () => {
  const state = snapshot({
    workGraph: {
      id: "goal-1",
      goal: "Ship authentication",
      approval: "approved",
      nodes: [node({
        id: "n1",
        title: "Land refresh flow",
        status: "blocked",
        dependsOn: ["n0"],
        fileOwnership: ["src/auth.ts"],
        acceptanceCriteria: ["observable proof"],
      })],
    },
  });

  const inspector = selectAgentConsoleInspector(
    state,
    { tab: "plan", node: state.workGraph.nodes[0] },
    14_000,
    72,
  );

  assert.equal(inspector?.title, "Land refresh flow");
  assert.equal(inspector?.subtitle, "task · blocked");
  assert.doesNotMatch(JSON.stringify(inspector), new RegExp(RAW_PROMPT_SENTINEL));
  const facts = Object.fromEntries((inspector?.facts ?? []).map((fact) => [fact.label, fact.value]));
  assert.equal(facts["Depends on"], "n0");
  assert.equal(facts.Owns, "src/auth.ts");
});

// A contract-valid string is not a layout-safe string: nothing in
// `parseAgentConsoleSnapshot` strips newlines or control bytes, so a worker
// that names itself with one would otherwise break a bounded row in two.
const HOSTILE_NAME = "런타임\n맵\u0007에이전트\r\n이름이 아주 아주 길어서 잘려야 하는 경우";
const HOSTILE_ACTIVITY = "읽는 중\n\n두 번째 줄\u001b[31m 그리고 아주 긴 한국어 활동 설명이 계속 이어집니다";

test("HUD projections stay on one physical line for control-bearing contract strings", () => {
  const width = 64;
  const graphRows = selectWorkGraphHudRows(
    snapshot({
      workGraph: {
        id: "goal-1",
        goal: "인증\n토큰\u0007갱신 목표가 아주 길어서 반드시 잘려야만 하는 문자열",
        approval: "approved",
        nodes: [node({ id: "n1", title: HOSTILE_NAME, status: "running" })],
      },
    }),
    width,
  );
  const agentRows = selectActiveAgentHudRows(
    snapshot({
      agents: [agent({
        id: "r1",
        displayName: HOSTILE_NAME,
        status: "running",
        currentActivity: HOSTILE_ACTIVITY,
      })],
    }),
    14_000,
    width,
  );

  // Two rows each: heading plus one record. A newline inside either field
  // would silently double that.
  assert.equal(graphRows.length, 2);
  assert.equal(agentRows.length, 2);
  for (const row of [...graphRows, ...agentRows]) {
    assert.doesNotMatch(row, /[\n\r\u0007\u001b]/, `row carries a control character: ${JSON.stringify(row)}`);
    assert.ok(getDisplayWidth(row) <= width, `row measured ${getDisplayWidth(row)} cells: ${row}`);
  }
});

test("every inspector row is budgeted against the pane it renders into", () => {
  const width = 40;
  const state = snapshot({
    agents: [agent({
      id: "r1",
      displayName: HOSTILE_NAME,
      agentType: "team-implementer\nwith a newline",
      status: "running",
      parentRunId: "parent-run-id-that-is-far-too-long-to-fit-in-a-narrow-pane",
      currentActivity: HOSTILE_ACTIVITY,
      startedAt: 1_000,
      summary: `설명\n${"아주 긴 결과 요약 문장입니다. ".repeat(20)}`,
    })],
    activity: [{
      id: "tool-1",
      toolCallId: "call-1",
      toolName: "read_file",
      kind: "read",
      intent: HOSTILE_ACTIVITY,
      target: "packages/tui/src/work-shell-agent-console-view.tsx",
      status: "completed",
      summary: "completed\u0007 · 12ms",
      startedAt: 1_010,
      completedAt: 1_022,
      agentRunId: "r1",
    }],
  });

  const inspector = selectAgentConsoleInspector(
    state,
    { tab: "agents", run: state.agents[0] },
    14_000,
    width,
  );

  // The title carries a two-cell status glyph prefix in the renderer.
  assert.ok(getDisplayWidth(inspector.title) <= width - 2, `title: ${inspector.title}`);
  assert.ok(getDisplayWidth(inspector.subtitle) <= width, `subtitle: ${inspector.subtitle}`);
  for (const fact of inspector.facts) {
    assert.ok(
      inspector.factLabelWidth + getDisplayWidth(fact.value) <= width,
      `fact "${fact.label}" overflows its pane: ${fact.value}`,
    );
  }
  // A 400-char lifecycle summary is bounded to a fixed row budget rather than
  // handed to ink as an unbounded block.
  assert.ok(inspector.outcome.length > 0 && inspector.outcome.length <= 3);
  for (const line of [
    inspector.title,
    inspector.subtitle,
    ...inspector.facts.map((fact) => fact.value),
    ...inspector.timeline,
    ...inspector.outcome,
  ]) {
    assert.doesNotMatch(line, /[\n\r\u0007\u001b]/, `inspector line carries a control character: ${JSON.stringify(line)}`);
    assert.ok(getDisplayWidth(line) <= width, `inspector line measured ${getDisplayWidth(line)} cells: ${line}`);
  }
});

test("a job settled before dispatch reports a stable duration, not a running clock", () => {
  const state = snapshot({
    jobs: [{
      id: "job-1",
      type: "work-node",
      label: "Map runtime",
      status: "cancelled",
      queuedAt: 1_000,
      completedAt: 4_000,
      summary: "Cancelled before dispatch.",
    }],
  });

  const atFirstPaint = selectAgentConsoleInspector(state, { tab: "jobs", job: state.jobs[0] }, 10_000, 72);
  const aMinuteLater = selectAgentConsoleInspector(state, { tab: "jobs", job: state.jobs[0] }, 70_000, 72);

  assert.deepEqual(atFirstPaint.facts[0], { label: "Duration", value: "3s" });
  assert.deepEqual(aMinuteLater.facts[0], { label: "Duration", value: "3s" });
});

test("an aggregate cost that overflows to a non-finite sum is reported as unknown", () => {
  assert.equal(
    formatAgentConsoleTotalCost(snapshot({
      mainUsage: { eventIds: ["m1"], costUsd: Number.MAX_VALUE },
      agents: [agent({
        id: "r1",
        displayName: "RuntimeMap",
        status: "running",
        usage: { eventIds: ["u1"], costUsd: Number.MAX_VALUE },
      })],
    })),
    undefined,
  );
});

test("a job and its owning agent count as one delegated operation", () => {
  assert.deepEqual(
    selectActiveAgentConsoleCounts(snapshot({
      agents: [agent({ id: "r1", displayName: "RuntimeMap", status: "running" })],
      jobs: [{
        id: "job-1",
        type: "work-node",
        label: "Map runtime",
        status: "running",
        agentRunId: "r1",
        queuedAt: 900,
        startedAt: 1_000,
      }],
    })),
    { agents: 0, jobs: 1 },
  );
});

test("background work is active while any agent or job is unsettled", () => {
  assert.equal(hasActiveAgentConsoleWork(snapshot()), false);
  assert.equal(
    hasActiveAgentConsoleWork(snapshot({
      agents: [agent({ id: "r1", displayName: "DoneMap", status: "completed" })],
      jobs: [{ id: "job-1", type: "work-node", label: "Map", status: "cancelled", queuedAt: 1, completedAt: 2 }],
    })),
    false,
  );
  assert.equal(
    hasActiveAgentConsoleWork(snapshot({
      agents: [agent({ id: "r1", displayName: "WaitMap", status: "waiting" })],
    })),
    true,
  );
  // A job can be queued before its run exists, so the job list is its own signal.
  assert.equal(
    hasActiveAgentConsoleWork(snapshot({
      jobs: [{ id: "job-1", type: "work-node", label: "Map", status: "queued", queuedAt: 1 }],
    })),
    true,
  );
});

/**
 * A CRLF patch whose content carries a tab, a BEL, and a real ANSI colour
 * sequence. `boundToolActivityPreview` accepts all of it, and `parseUnifiedDiff`
 * hands the bytes straight through to the row text.
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

test("a diff preview cannot smuggle control bytes into the inspector timeline", () => {
  const width = 72;
  const state = snapshot({
    agents: [agent({ id: "r1", displayName: "RuntimeMap", status: "running" })],
    activity: [{
      id: "tool-1",
      toolCallId: "call-1",
      toolName: "apply_patch",
      kind: "write",
      intent: "Colour the label",
      status: "completed",
      summary: "completed · 12ms",
      startedAt: 1_010,
      completedAt: 1_022,
      agentRunId: "r1",
      preview: CONTROL_PATCH,
    }],
  });

  const inspector = selectAgentConsoleInspector(
    state,
    { tab: "agents", run: state.agents[0] },
    14_000,
    width,
  );

  for (const line of inspector.timeline) {
    assert.doesNotMatch(
      line,
      LAYOUT_BREAKING,
      `preview row can still move the cursor: ${JSON.stringify(line)}`,
    );
    assert.ok(getDisplayWidth(line) <= width, `preview row measured ${getDisplayWidth(line)}: ${line}`);
  }

  // Sanitizing must not cost the diff its meaning: the summary and the changed
  // content both have to survive.
  const timeline = inspector.timeline.join("\n");
  assert.match(timeline, /⎿ Added \d+ lines?, removed \d+ lines?/);
  assert.match(timeline, /const label/);
  assert.match(timeline, /alert\(\);/);
  // The generated gutter and hanging indent are layout, not content.
  assert.ok(
    inspector.timeline.some((line) => /^ {2}\s*\d+ \+ /.test(line)),
    `expected a numbered added row, got: ${JSON.stringify(inspector.timeline)}`,
  );
});
