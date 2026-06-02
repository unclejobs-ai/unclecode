import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendActivityEntry,
  buildActivityInspectorModel,
  buildHistoryContextSummaryLines,
  buildInspectorContextLines,
  buildInspectorContextSnapshotLines,
  buildMcpInspectorLines,
  buildResearchInspectorLines,
  buildSessionCenterStatusLine,
  createApprovalRequestForAction,
  createSessionCenterFocusForView,
  createSessionCenterModel,
  formatSessionCenterDraftValue,
  formatSessionHeadline,
  getImmediateActionShortcut,
  getSessionCenterActionShortcut,
  getSessionCenterEscapeHint,
  getSessionCenterViewShortcut,
  getVisibleSessionCenterActionsForView,
  handleApprovalInput,
  handleResearchDraftInput,
  handleSessionCenterInput,
  isSessionCenterImplicitSubmitInput,
  shouldCaptureDashboardInput,
  shouldOpenResearchPromptLane,
  shouldReturnToWorkOnEscape,
  truncateForPane,
} from "../../packages/tui/src/index.tsx";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("createSessionCenterModel prioritizes recent sessions over generic actions", () => {
  const model = createSessionCenterModel({
    workspaceRoot: "/Users/parkeungje/project/unclecode",
    modeLabel: "analyze",
    authLabel: "api-key-env",
    sessions: [
      {
        sessionId: "research-123",
        state: "idle",
        updatedAt: "2026-04-02T10:00:00.000Z",
        model: "research-local",
        taskSummary: "Summarize current workspace",
      },
      {
        sessionId: "session-alpha",
        state: "requires_action",
        updatedAt: "2026-04-02T09:00:00.000Z",
        model: "gpt-5.4",
        taskSummary: "Review MCP host status",
      },
    ],
  });

  assert.equal(model.title, "unclecode");
  assert.match(model.subtitle, /session center/i);
  assert.equal(model.primarySessions.length, 2);
  assert.equal(model.primarySessions[0].sessionId, "research-123");
  assert.ok(
    model.utilityActions.some((action) => action.id === "new-research"),
  );
  assert.ok(
    model.utilityActions.some((action) => action.id === "browser-login"),
  );
  assert.ok(
    model.utilityActions.some((action) => action.id === "api-key-login"),
  );
  assert.ok(model.utilityActions.some((action) => action.id === "auth-logout"));
  assert.equal(
    model.utilityActions.some((action) => action.id === "device-login"),
    false,
  );
  assert.ok(
    model.utilityActions.some((action) => action.id === "work-session"),
  );
  assert.ok(model.utilityActions.some((action) => action.id === "doctor"));
  assert.equal(
    model.utilityActions.some((action) => action.id === "auth-status"),
    false,
  );
  assert.equal(
    model.utilityActions.some((action) => action.id === "mcp-list"),
    true,
  );
  assert.equal(
    model.utilityActions.some((action) => action.id === "mcp-inspect"),
    true,
  );
  assert.equal(
    model.utilityActions.some((action) => action.id === "mcp-add"),
    true,
  );
  assert.equal(
    model.utilityActions.some((action) => action.id === "mcp-remove"),
    true,
  );
  assert.equal(
    model.utilityActions.some((action) => action.id === "research-status"),
    true,
  );
  assert.equal(
    model.utilityActions.some((action) => action.id === "mode-cycle"),
    false,
  );
  assert.equal(model.utilityActions.length, 11);
});

test("getVisibleSessionCenterActionsForView hides global auth repair actions from contextual pages", () => {
  const model = createSessionCenterModel({
    workspaceRoot: "/Users/parkeungje/project/unclecode",
    modeLabel: "default",
    authLabel: "oauth-file",
    sessions: [],
  });

  assert.deepEqual(
    getVisibleSessionCenterActionsForView("sessions", model.utilityActions).map(
      (action) => action.id,
    ),
    ["work-session", "new-research", "doctor"],
  );
  assert.deepEqual(
    getVisibleSessionCenterActionsForView("mcp", model.utilityActions).map(
      (action) => action.id,
    ),
    ["mcp-add", "mcp-remove", "mcp-list", "mcp-inspect"],
  );
  assert.deepEqual(
    getVisibleSessionCenterActionsForView("research", model.utilityActions).map(
      (action) => action.id,
    ),
    ["new-research", "research-status"],
  );
});

test("formatSessionCenterDraftValue masks api-key drafts but leaves other drafts visible", () => {
  assert.equal(
    formatSessionCenterDraftValue(
      "api-key-login",
      "sk-secret-123 --org org_demo --project proj_demo",
    ),
    "[REDACTED] --org org_demo --project proj_demo",
  );
  assert.equal(
    formatSessionCenterDraftValue(
      "new-research",
      "Summarize current workspace",
    ),
    "Summarize current workspace",
  );
});

test("formatSessionHeadline prefers task summaries over raw ids and recognizes session kind", () => {
  assert.equal(
    formatSessionHeadline({
      sessionId: "work-123",
      state: "requires_action",
      updatedAt: "2026-04-02T10:00:00.000Z",
      model: "gpt-5.4",
      taskSummary: "Fix auth flow",
    }),
    "Fix auth flow",
  );

  assert.equal(
    formatSessionHeadline({
      sessionId: "research-123",
      state: "idle",
      updatedAt: "2026-04-02T10:00:00.000Z",
      model: "research-local",
      taskSummary: null,
    }),
    "Research session",
  );

  assert.equal(
    formatSessionHeadline({
      sessionId: "work-with-control",
      state: "idle",
      updatedAt: "2026-04-02T10:00:00.000Z",
      model: "gpt-5.4",
      taskSummary: "Chat failed: 고잇냐 \u007f\u007f 고 잇느냐 지?",
    }),
    "Chat failed: 고잇냐 고 잇느냐 지?",
  );
});

test("buildActivityInspectorModel prioritizes current approval/worker/result over history", () => {
  const model = buildActivityInspectorModel({
    approvals: [
      {
        id: "approval-1",
        title: "Open Browser Login",
        detail: "Wait for OAuth callback",
        severity: "info",
      },
    ],
    workers: [
      {
        id: "worker-1",
        label: "browser-login",
        status: "running",
        detail: "waiting for callback",
      },
    ],
    outputLines: ["OAuth login complete.", "Auth: oauth-file"],
    traceEntries: [
      {
        id: "trace-1",
        kind: "approval",
        level: "high-signal",
        message: "Open Browser Login",
        timestamp: "2026-04-05T12:00:00.000Z",
      },
      {
        id: "trace-2",
        kind: "tool",
        level: "default",
        message: "browser-login: waiting for callback",
        timestamp: "2026-04-05T12:00:01.000Z",
      },
    ],
    activityEntries: [
      {
        id: "activity-1",
        source: "browser-login",
        title: "Browser Login",
        timestamp: "2026-04-05T12:00:02.000Z",
        lines: ["OAuth login complete."],
        tone: "success",
      },
    ],
  });

  assert.deepEqual(model.currentLines, [
    "Workflow: waiting approval · Open Browser Login",
    "Approval: Open Browser Login",
    "Worker: browser-login · Waiting for callback",
    "Result: OAuth login complete.",
  ]);
  assert.equal(model.traceLines.length, 2);
  assert.equal(model.historyLines[0], "Browser Login");
});

test("buildInspectorContextLines groups workspace context, bridge, and memory", () => {
  const lines = buildInspectorContextLines({
    contextLines: ["AGENTS: stay in workspace"],
    bridgeLines: ["Bridge summary"],
    memoryLines: ["Project memory"],
  });

  assert.deepEqual(lines, [
    "Workspace",
    "AGENTS: stay in workspace",
    "",
    "Bridge",
    "Bridge summary",
    "",
    "Memory",
    "Project memory",
  ]);
});

test("buildInspectorContextSnapshotLines bounds noisy workspace context", () => {
  const lines = buildInspectorContextSnapshotLines({
    contextLines: [
      "AGENTS: stay in workspace",
      "CLAUDE: loaded",
      "rules: modular",
      "extra: hidden",
    ],
    bridgeLines: ["Bridge summary", "Bridge duplicate"],
    memoryLines: ["Project memory"],
  });

  assert.deepEqual(lines, [
    "Workspace context · 4 lines",
    "AGENTS: stay in workspace",
    "CLAUDE: loaded",
    "rules: modular",
    "Bridge summaries · 2",
    "Memory notes · 1",
  ]);
});

test("buildHistoryContextSummaryLines separates resumable history from workspace context", () => {
  const lines = buildHistoryContextSummaryLines({
    session: {
      sessionId: "work-123",
      state: "idle",
      updatedAt: "2026-04-02T10:00:00.000Z",
      model: "gpt-5.4",
      taskSummary: "Fix TUI",
    },
    contextLines: ["Loaded guidance: AGENTS.md"],
    bridgeLines: ["bridge summary"],
    memoryLines: [],
  });

  assert.deepEqual(lines, [
    "History = saved conversations",
    "History · idle",
    "Enter opens Work with this saved context",
    "Context · 2 sources",
  ]);
});

test("createSessionCenterModel exposes an empty-state CTA when no sessions exist", () => {
  const model = createSessionCenterModel({
    workspaceRoot: "/Users/parkeungje/project/unclecode",
    modeLabel: "default",
    authLabel: "none",
    sessions: [],
  });

  assert.equal(model.primarySessions.length, 0);
  assert.match(model.emptyState, /Press W to start work/i);
});

test("handleSessionCenterInput navigates sessions and utility actions", () => {
  const result = handleSessionCenterInput(
    "",
    { downArrow: true },
    { column: "sessions", sessionIndex: 0, actionIndex: 0, detailOpen: false },
    { sessionCount: 2, actionCount: 3 },
  );

  assert.deepEqual(result, {
    column: "sessions",
    sessionIndex: 1,
    actionIndex: 0,
    detailOpen: false,
    shouldExit: false,
    selectedCommand: undefined,
  });
});

test("handleSessionCenterInput can switch to actions and emit a selected command", () => {
  const switched = handleSessionCenterInput(
    "",
    { rightArrow: true },
    { column: "sessions", sessionIndex: 0, actionIndex: 0, detailOpen: false },
    { sessionCount: 1, actionCount: 3 },
  );

  assert.equal(switched.column, "actions");

  const selected = handleSessionCenterInput(
    "",
    { return: true },
    switched,
    { sessionCount: 1, actionCount: 3 },
    ["unclecode research run", "unclecode doctor", "unclecode mode status"],
  );

  assert.equal(selected.shouldExit, true);
  assert.equal(selected.selectedCommand, "unclecode research run");

  const selectedWithCarriageReturn = handleSessionCenterInput(
    "\r",
    {},
    switched,
    { sessionCount: 1, actionCount: 3 },
    ["unclecode research run", "unclecode doctor", "unclecode mode status"],
  );

  assert.equal(selectedWithCarriageReturn.shouldExit, true);
  assert.equal(
    selectedWithCarriageReturn.selectedCommand,
    "unclecode research run",
  );
});

test("handleSessionCenterInput keeps History as a two-column resume surface", () => {
  const stayOnHistory = handleSessionCenterInput(
    "",
    { rightArrow: true },
    { column: "sessions", sessionIndex: 0, actionIndex: 0, detailOpen: false },
    { sessionCount: 2, actionCount: 3 },
    ["unclecode work", "unclecode research run", "unclecode doctor"],
    ["unclecode resume work-1", "unclecode resume work-2"],
    { allowActionColumn: false },
  );

  assert.equal(stayOnHistory.column, "sessions");
  assert.equal(stayOnHistory.shouldExit, false);

  const tabStaysOnHistory = handleSessionCenterInput(
    "\t",
    {},
    stayOnHistory,
    { sessionCount: 2, actionCount: 3 },
    ["unclecode work", "unclecode research run", "unclecode doctor"],
    ["unclecode resume work-1", "unclecode resume work-2"],
    { allowActionColumn: false },
  );

  assert.equal(tabStaysOnHistory.column, "sessions");

  const resumed = handleSessionCenterInput(
    "",
    { return: true },
    tabStaysOnHistory,
    { sessionCount: 2, actionCount: 3 },
    ["unclecode work", "unclecode research run", "unclecode doctor"],
    ["unclecode resume work-1", "unclecode resume work-2"],
    { allowActionColumn: false },
  );

  assert.equal(resumed.shouldExit, true);
  assert.equal(resumed.selectedCommand, "unclecode resume work-1");
});

test("dashboard shell renders History without duplicate action buttons", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-shell.tsx"),
    "utf8",
  );
  const sessionsBranch = source.match(
    /shellState\.view === "sessions" \? \([\s\S]*?\) : \(/,
  )?.[0];

  assert.ok(sessionsBranch);
  assert.match(source, /allowActionColumn: shellState\.view !== "sessions"/);
  assert.match(sessionsBranch, />History detail</);
  assert.doesNotMatch(
    sessionsBranch,
    /ActionShortcutStrip|<ActionList|>Actions</,
  );
});

test("handleSessionCenterInput navigates visible action indexes without losing global commands", () => {
  const selected = handleSessionCenterInput(
    "",
    { downArrow: true },
    { column: "actions", sessionIndex: 0, actionIndex: 0, detailOpen: false },
    { sessionCount: 1, actionCount: 11 },
    [
      "unclecode work",
      "unclecode auth login --browser",
      "unclecode auth login --api-key-stdin",
      "unclecode auth logout",
      "unclecode research run",
      "unclecode research status",
      "unclecode mcp list",
      "unclecode mcp add <name> <command> [args...]",
      "unclecode mcp remove <server>",
      "unclecode mcp inspect <server>",
      "unclecode doctor",
    ],
    undefined,
    { visibleActionIndexes: [0, 4, 10] },
  );

  assert.equal(selected.actionIndex, 4);

  const submitted = handleSessionCenterInput(
    "",
    { return: true },
    selected,
    { sessionCount: 1, actionCount: 11 },
    [
      "unclecode work",
      "unclecode auth login --browser",
      "unclecode auth login --api-key-stdin",
      "unclecode auth logout",
      "unclecode research run",
      "unclecode research status",
      "unclecode mcp list",
      "unclecode mcp add <name> <command> [args...]",
      "unclecode mcp remove <server>",
      "unclecode mcp inspect <server>",
      "unclecode doctor",
    ],
    undefined,
    { visibleActionIndexes: [0, 4, 10] },
  );

  assert.equal(submitted.selectedCommand, "unclecode research run");
});

test("handleSessionCenterInput resumes the selected history item on one Enter", () => {
  const selected = handleSessionCenterInput(
    "",
    { return: true },
    { column: "sessions", sessionIndex: 1, actionIndex: 0, detailOpen: false },
    { sessionCount: 2, actionCount: 3 },
    ["unclecode research run", "unclecode doctor", "unclecode mode status"],
    ["unclecode resume work-1", "unclecode resume work-2"],
  );

  assert.equal(selected.shouldExit, true);
  assert.equal(selected.selectedCommand, "unclecode resume work-2");
  assert.equal(selected.detailOpen, false);
});

test("createSessionCenterFocusForView resets hidden detail state on tab switches", () => {
  assert.deepEqual(
    createSessionCenterFocusForView("sessions", {
      column: "actions",
      sessionIndex: 2,
      actionIndex: 3,
      detailOpen: true,
    }),
    {
      column: "sessions",
      sessionIndex: 2,
      actionIndex: 3,
      detailOpen: false,
      shouldExit: false,
      selectedCommand: undefined,
    },
  );

  assert.deepEqual(
    createSessionCenterFocusForView("mcp", {
      column: "sessions",
      sessionIndex: 1,
      actionIndex: 0,
      detailOpen: true,
    }),
    {
      column: "actions",
      sessionIndex: 1,
      actionIndex: 7,
      detailOpen: false,
      shouldExit: false,
      selectedCommand: undefined,
    },
    "MCP tab focuses the MCP add action instead of inheriting stale action focus",
  );

  assert.deepEqual(
    createSessionCenterFocusForView("research", {
      column: "sessions",
      sessionIndex: 1,
      actionIndex: 0,
      detailOpen: true,
    }),
    {
      column: "actions",
      sessionIndex: 1,
      actionIndex: 4,
      detailOpen: false,
      shouldExit: false,
      selectedCommand: undefined,
    },
    "Research tab focuses the research action instead of inheriting stale action focus",
  );

  assert.deepEqual(
    createSessionCenterFocusForView("work", {
      column: "sessions",
      sessionIndex: 1,
      actionIndex: 5,
      detailOpen: true,
    }),
    {
      column: "actions",
      sessionIndex: 1,
      actionIndex: 0,
      detailOpen: false,
      shouldExit: false,
      selectedCommand: undefined,
    },
    "Work tab focuses the work action instead of inheriting stale action focus",
  );
});

test("handleSessionCenterInput supports hjkl-style navigation aliases", () => {
  const toActions = handleSessionCenterInput(
    "l",
    {},
    { column: "sessions", sessionIndex: 0, actionIndex: 0, detailOpen: false },
    { sessionCount: 1, actionCount: 3 },
  );
  assert.equal(toActions.column, "actions");

  const down = handleSessionCenterInput("j", {}, toActions, {
    sessionCount: 1,
    actionCount: 3,
  });
  assert.equal(down.actionIndex, 1);

  const up = handleSessionCenterInput("k", {}, down, {
    sessionCount: 1,
    actionCount: 3,
  });
  assert.equal(up.actionIndex, 0);

  const back = handleSessionCenterInput("h", {}, up, {
    sessionCount: 1,
    actionCount: 3,
  });
  assert.equal(back.column, "sessions");
});

test("handleSessionCenterInput lets arrow movement escape detail-open traps", () => {
  const moved = handleSessionCenterInput(
    "",
    { downArrow: true },
    { column: "actions", sessionIndex: 0, actionIndex: 0, detailOpen: true },
    { sessionCount: 1, actionCount: 3 },
  );

  assert.equal(moved.detailOpen, false);
  assert.equal(moved.column, "actions");
  assert.equal(moved.actionIndex, 1);
  assert.equal(moved.shouldExit, false);
});

test("handleSessionCenterInput does not exit detail mode without a contextual command", () => {
  const result = handleSessionCenterInput(
    "",
    { return: true },
    { column: "sessions", sessionIndex: 0, actionIndex: 5, detailOpen: true },
    { sessionCount: 1, actionCount: 11 },
    [
      "unclecode work",
      "unclecode auth login --browser",
      "unclecode auth login --api-key-stdin",
      "unclecode auth logout",
      "unclecode research run",
      "unclecode research status",
      "unclecode mcp list",
      "unclecode mcp add <name> <command> [args...]",
      "unclecode mcp remove <server>",
      "unclecode mcp inspect <server>",
      "unclecode doctor",
    ],
    undefined,
    { visibleActionIndexes: [7, 8, 6, 9] },
  );

  assert.equal(result.shouldExit, false);
  assert.equal(result.selectedCommand, undefined);
  assert.equal(result.detailOpen, true);
});

test("handleResearchDraftInput appends characters and backspaces safely", () => {
  const typed = handleResearchDraftInput("repo", "s", {});
  assert.equal(typed.value, "repos");
  assert.equal(typed.submitted, false);

  const backspaced = handleResearchDraftInput(typed.value, "", {
    backspace: true,
  });
  assert.equal(backspaced.value, "repo");
  assert.equal(backspaced.submitted, false);
});

test("handleResearchDraftInput submits only when prompt is non-empty", () => {
  const emptySubmit = handleResearchDraftInput("   ", "", { return: true });
  assert.equal(emptySubmit.submitted, false);

  const submit = handleResearchDraftInput("summarize current workspace", "", {
    return: true,
  });
  assert.equal(submit.submitted, true);
  assert.equal(submit.value, "summarize current workspace");

  const submitWithCarriageReturn = handleResearchDraftInput(
    "summarize current workspace",
    "\r",
    {},
  );
  assert.equal(submitWithCarriageReturn.submitted, true);
});

test("isSessionCenterImplicitSubmitInput recognizes Ink empty Enter events", () => {
  assert.equal(isSessionCenterImplicitSubmitInput("", {}), true);
  assert.equal(isSessionCenterImplicitSubmitInput("", { escape: true }), false);
  assert.equal(
    isSessionCenterImplicitSubmitInput("", { upArrow: true }),
    false,
  );
  assert.equal(isSessionCenterImplicitSubmitInput("x", {}), false);
});

test("buildResearchInspectorLines shows the page-native research draft state", () => {
  const closed = buildResearchInspectorLines({
    latestResearchSessionId: null,
    latestResearchSummary: null,
    latestResearchTimestamp: null,
    researchRunCount: 0,
    recentResearchRuns: [],
    researchDraft: "",
    isDraftOpen: false,
  });
  assert.ok(closed.some((line) => line.text === "Press R to write a prompt"));
  assert.ok(closed.some((line) => line.text === "Research = workspace brief"));
  assert.ok(
    closed.some(
      (line) =>
        line.text ===
        "Use before Work to gather repo context without changing code.",
    ),
  );

  const open = buildResearchInspectorLines({
    latestResearchSessionId: "research-123",
    latestResearchSummary: "Summarize current workspace",
    latestResearchTimestamp: "2026-06-01T00:00:00.000Z",
    researchRunCount: 2,
    recentResearchRuns: [
      {
        sessionId: "research-123",
        prompt: "audit MCP workflow",
        status: "completed",
        summary: "Prepared a local research bundle",
        timestamp: "2026-06-01T00:00:00.000Z",
      },
    ],
    selectedRunIndex: 0,
    researchDraft: "audit MCP workflow",
    isDraftOpen: true,
  });
  assert.ok(open.some((line) => line.text === "Research = workspace brief"));
  assert.ok(open.some((line) => line.text === "Prompt draft"));
  assert.ok(open.some((line) => line.text === "audit MCP workflow"));
  assert.ok(
    open.some((line) => line.text === "Enter or Ctrl+R runs · Esc cancels"),
  );
  assert.ok(open.some((line) => line.text === "Selected research"));
  assert.ok(open.some((line) => line.text === "Recent research"));
  assert.ok(open.some((line) => line.text === "done · audit MCP workflow"));
  assert.ok(open.some((line) => line.text === "unclecode resume research-123"));
});

test("buildMcpInspectorLines separates configured servers from unchecked health", () => {
  const empty = buildMcpInspectorLines({
    mcpServerCount: 0,
    mcpServers: [],
  });
  assert.ok(
    empty.some(
      (line) =>
        line.text === "M lists merged config · I inspects selected server",
    ),
  );
  assert.ok(
    empty.some((line) => line.text === "MCP = external tools and data servers"),
  );
  assert.ok(
    empty.some(
      (line) =>
        line.text ===
        "Add, remove, list, and inspect servers for this workspace.",
    ),
  );
  assert.ok(empty.some((line) => line.text === "No MCP servers configured."));
  assert.ok(empty.some((line) => line.text === "Press M to run list"));

  const configured = buildMcpInspectorLines({
    mcpServerCount: 5,
    selectedServerIndex: 1,
    mcpServers: [
      {
        name: "memory",
        transport: "stdio",
        scope: "project",
        trustTier: "trusted",
        originLabel: ".mcp.json",
      },
      {
        name: "docs",
        transport: "http",
        scope: "user",
        trustTier: "review",
        originLabel: "~/.unclecode/mcp.json",
      },
      {
        name: "one",
        transport: "stdio",
        scope: "project",
        trustTier: "trusted",
        originLabel: ".mcp.json",
      },
      {
        name: "two",
        transport: "stdio",
        scope: "project",
        trustTier: "trusted",
        originLabel: ".mcp.json",
      },
      {
        name: "three",
        transport: "stdio",
        scope: "project",
        trustTier: "trusted",
        originLabel: ".mcp.json",
      },
    ],
  });

  assert.ok(
    configured.some(
      (line) => line.text === "5 configured server(s) from user/project config",
    ),
  );
  assert.ok(configured.some((line) => line.text === "Selected server"));
  assert.ok(configured.some((line) => line.text === "docs · http"));
  assert.ok(configured.some((line) => line.text === "memory · stdio"));
  assert.ok(
    configured.some((line) => line.text === "project · trusted · .mcp.json"),
  );
  assert.ok(configured.some((line) => line.text === "+2 more server(s)"));
  assert.ok(configured.some((line) => line.text === "unclecode mcp list"));
  assert.ok(
    configured.some((line) => line.text === "Press I to inspect selected"),
  );
  assert.ok(
    configured.some((line) => line.text === "unclecode mcp inspect docs"),
  );
});

test("appendActivityEntry prepends new transcript entries and caps history", () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    id: `entry-${index}`,
    title: `Entry ${index}`,
    lines: [`line-${index}`],
    tone: "info",
  }));

  const next = appendActivityEntry(entries, {
    id: "latest",
    title: "Latest",
    lines: ["new line"],
    tone: "success",
  });

  assert.equal(next.length, 20);
  assert.equal(next[0].id, "latest");
  assert.equal(next[0].tone, "success");
  assert.equal(next.at(-1)?.id, "entry-18");
});

test("createApprovalRequestForAction returns approval metadata for external auth actions", () => {
  const browserApproval = createApprovalRequestForAction("browser-login");
  assert.equal(browserApproval?.id, "approval-browser-login");
  assert.match(browserApproval?.title ?? "", /Browser Login/);

  const deviceApproval = createApprovalRequestForAction("device-login");
  assert.equal(deviceApproval?.id, "approval-device-login");

  assert.equal(createApprovalRequestForAction("doctor"), undefined);
});

test("handleApprovalInput maps approve and reject keys deterministically", () => {
  assert.deepEqual(handleApprovalInput("a", {}), { decision: "approve" });
  assert.deepEqual(handleApprovalInput("\r", {}), { decision: "approve" });
  assert.deepEqual(handleApprovalInput("x", {}), { decision: "reject" });
  assert.deepEqual(handleApprovalInput("", { escape: true }), {
    decision: "reject",
  });
  assert.deepEqual(handleApprovalInput("", { return: true }), {
    decision: "approve",
  });
  assert.deepEqual(handleApprovalInput("z", {}), { decision: "noop" });
});

test("truncateForPane keeps short text and truncates long text with ellipsis", () => {
  assert.equal(truncateForPane("short text", 20), "short text");
  assert.equal(truncateForPane("1234567890abcdef", 10), "123456789…");
  assert.equal(truncateForPane("abc", 2), "ab");
  assert.equal(truncateForPane("반갑습니다", 9), "반갑습니…");
});

test("getSessionCenterActionShortcut maps direct utility keys", () => {
  assert.equal(getSessionCenterActionShortcut("b"), "browser-login");
  assert.equal(getSessionCenterActionShortcut("v"), undefined);
  assert.equal(getSessionCenterActionShortcut("w"), "work-session");
  assert.equal(getSessionCenterActionShortcut("s"), "research-status");
  assert.equal(getSessionCenterActionShortcut("r"), "new-research");
  assert.equal(getSessionCenterActionShortcut("d"), "doctor");
  assert.equal(getSessionCenterActionShortcut("m"), "mcp-list");
  assert.equal(getSessionCenterActionShortcut("i"), "mcp-inspect");
  assert.equal(getSessionCenterActionShortcut("a"), "mcp-add");
  assert.equal(getSessionCenterActionShortcut("x"), "mcp-remove");
  assert.equal(getSessionCenterActionShortcut("n"), undefined);
  assert.equal(getSessionCenterActionShortcut("z"), undefined);
});

test("getSessionCenterViewShortcut maps numeric tab keys to unified shell tabs", () => {
  assert.equal(getSessionCenterViewShortcut("1"), "work");
  assert.equal(getSessionCenterViewShortcut("2"), "sessions");
  assert.equal(getSessionCenterViewShortcut("3"), "mcp");
  assert.equal(getSessionCenterViewShortcut("4"), "research");
  assert.equal(getSessionCenterViewShortcut("9"), undefined);
});

test("getImmediateActionShortcut maps uppercase run-now hotkeys", () => {
  assert.equal(getImmediateActionShortcut("W"), "work-session");
  assert.equal(getImmediateActionShortcut("B"), "browser-login");
  assert.equal(getImmediateActionShortcut("S"), "research-status");
  assert.equal(getImmediateActionShortcut("D"), "doctor");
  assert.equal(getImmediateActionShortcut("M"), "mcp-list");
  assert.equal(getImmediateActionShortcut("I"), "mcp-inspect");
  assert.equal(getImmediateActionShortcut("A"), "mcp-add");
  assert.equal(getImmediateActionShortcut("X"), "mcp-remove");
  assert.equal(getImmediateActionShortcut("N"), undefined);
  assert.equal(getImmediateActionShortcut("R"), "new-research");
});

test("shouldCaptureDashboardInput yields to embedded work pane input while the Work tab is active", () => {
  assert.equal(shouldCaptureDashboardInput("work", true), false);
  assert.equal(shouldCaptureDashboardInput("sessions", true), true);
  assert.equal(shouldCaptureDashboardInput("research", true), true);
  assert.equal(shouldCaptureDashboardInput("work", false), true);
});

test("shouldReturnToWorkOnEscape applies to every non-work top-level tab only", () => {
  const topLevel = {
    column: "actions",
    sessionIndex: 0,
    actionIndex: 0,
    detailOpen: false,
  };
  const detailOpen = { ...topLevel, detailOpen: true };

  assert.equal(
    shouldReturnToWorkOnEscape("sessions", { escape: true }, topLevel, false),
    true,
  );
  assert.equal(
    shouldReturnToWorkOnEscape("mcp", { escape: true }, topLevel, false),
    true,
  );
  assert.equal(
    shouldReturnToWorkOnEscape("research", { escape: true }, topLevel, false),
    true,
  );
  assert.equal(
    shouldReturnToWorkOnEscape("work", { escape: true }, topLevel, false),
    false,
  );
  assert.equal(
    shouldReturnToWorkOnEscape("research", { escape: false }, topLevel, false),
    false,
  );
  assert.equal(
    shouldReturnToWorkOnEscape("research", { escape: true }, detailOpen, false),
    false,
  );
  assert.equal(
    shouldReturnToWorkOnEscape("research", { escape: true }, topLevel, true),
    false,
  );
});

test("getSessionCenterEscapeHint describes the next visible Escape action", () => {
  assert.equal(
    getSessionCenterEscapeHint({
      view: "work",
      detailOpen: false,
      hasSelectedApproval: false,
      hasEmbeddedWorkPane: true,
    }),
    "Ctrl+O sessions",
  );
  assert.equal(
    getSessionCenterEscapeHint({
      view: "sessions",
      detailOpen: false,
      hasSelectedApproval: false,
      hasEmbeddedWorkPane: true,
    }),
    "Esc work",
  );
  assert.equal(
    getSessionCenterEscapeHint({
      view: "sessions",
      detailOpen: true,
      hasSelectedApproval: false,
      hasEmbeddedWorkPane: true,
    }),
    "Esc close",
  );
  assert.equal(
    getSessionCenterEscapeHint({
      view: "research",
      detailOpen: true,
      hasSelectedApproval: false,
      hasEmbeddedWorkPane: true,
    }),
    "Esc cancel",
  );
  assert.equal(
    getSessionCenterEscapeHint({
      view: "mcp",
      detailOpen: false,
      hasSelectedApproval: true,
      hasEmbeddedWorkPane: true,
    }),
    "Esc cancel",
  );
});

test("buildSessionCenterStatusLine gives each Escape screen tab an honest page status", () => {
  assert.equal(
    buildSessionCenterStatusLine({
      view: "sessions",
      savedSessionCount: 3,
      mcpServerCount: 2,
      researchRunCount: 1,
      detailOpen: false,
      hasSelectedApproval: false,
      hasEmbeddedWorkPane: true,
    }),
    "History · 3 saved · ↑↓ select · Enter resume · Esc work",
  );
  assert.equal(
    buildSessionCenterStatusLine({
      view: "mcp",
      savedSessionCount: 3,
      mcpServerCount: 2,
      researchRunCount: 1,
      detailOpen: false,
      hasSelectedApproval: false,
      hasEmbeddedWorkPane: true,
    }),
    "MCP · 2 server(s) · A add · X remove · Esc work",
  );
  assert.equal(
    buildSessionCenterStatusLine({
      view: "research",
      savedSessionCount: 3,
      mcpServerCount: 2,
      researchRunCount: 1,
      detailOpen: true,
      hasSelectedApproval: false,
      hasEmbeddedWorkPane: true,
    }),
    "Research · 1 run(s) · Enter/Ctrl+R run · Esc cancel",
  );
});

test("shouldOpenResearchPromptLane makes Research prompt page-native", () => {
  const topLevel = {
    column: "sessions",
    sessionIndex: 0,
    actionIndex: 4,
    detailOpen: false,
  };
  const detailOpen = { ...topLevel, detailOpen: true };
  const actionColumn = { ...topLevel, column: "actions" };

  assert.equal(
    shouldOpenResearchPromptLane("research", "r", {}, topLevel, false),
    true,
  );
  assert.equal(
    shouldOpenResearchPromptLane("research", "R", {}, topLevel, false),
    true,
  );
  assert.equal(
    shouldOpenResearchPromptLane(
      "research",
      "",
      { return: true },
      topLevel,
      false,
    ),
    true,
  );
  assert.equal(
    shouldOpenResearchPromptLane("sessions", "r", {}, topLevel, false),
    false,
  );
  assert.equal(
    shouldOpenResearchPromptLane("research", "r", {}, detailOpen, false),
    false,
  );
  assert.equal(
    shouldOpenResearchPromptLane("research", "r", {}, topLevel, true),
    false,
  );
  assert.equal(
    shouldOpenResearchPromptLane(
      "research",
      "",
      { return: true },
      actionColumn,
      false,
    ),
    false,
  );
});

test("dashboard shell does not let the Research page prompt hijack action Enter", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-shell.tsx"),
    "utf8",
  );
  const promptBranch = source.match(
    /if \(\s*[\s\S]{0,120}shouldOpenResearchPromptLane\([\s\S]*?\)\s*\) \{/,
  )?.[0];

  assert.ok(promptBranch);
  assert.match(promptBranch, /centerState\.column === "sessions"/);
  assert.doesNotMatch(promptBranch, /selectedAction\?\.id === "new-research"/);
});

test("dashboard shell keeps normal action runs out of prompt detail mode", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-shell.tsx"),
    "utf8",
  );
  const actionRunBranch = source.match(
    /prettifyWorkerDetail\("loading action output"\)[\s\S]{0,2400}dispatch\(\{ type: "focus\.changed"[\s\S]*?\}\);/,
  )?.[0];

  assert.ok(actionRunBranch);
  assert.match(actionRunBranch, /detailOpen: false/);
});
