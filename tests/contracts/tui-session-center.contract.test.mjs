import assert from "node:assert/strict";
import test from "node:test";

import {
  appendActivityEntry,
  buildActivityInspectorModel,
  buildInspectorContextLines,
  createApprovalRequestForAction,
  createSessionCenterModel,
  formatSessionCenterDraftValue,
  formatSessionHeadline,
  getImmediateActionShortcut,
  getSessionCenterActionShortcut,
  getSessionCenterViewShortcut,
  handleApprovalInput,
  handleResearchDraftInput,
  handleSessionCenterInput,
  shouldCaptureDashboardInput,
  truncateForPane,
} from "../../packages/tui/src/index.tsx";

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
  assert.match(model.subtitle, /resume recent work/i);
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
    false,
  );
  assert.equal(
    model.utilityActions.some((action) => action.id === "mode-cycle"),
    false,
  );
  assert.equal(model.utilityActions.length, 6);
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
    "Approval: Open Browser Login",
    "Worker: browser-login · waiting for callback",
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

test("createSessionCenterModel exposes an empty-state CTA when no sessions exist", () => {
  const model = createSessionCenterModel({
    workspaceRoot: "/Users/parkeungje/project/unclecode",
    modeLabel: "default",
    authLabel: "none",
    sessions: [],
  });

  assert.equal(model.primarySessions.length, 0);
  assert.match(model.emptyState, /Press W to open work/i);
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
});

test("getSessionCenterActionShortcut maps direct utility keys", () => {
  assert.equal(getSessionCenterActionShortcut("b"), "browser-login");
  assert.equal(getSessionCenterActionShortcut("v"), undefined);
  assert.equal(getSessionCenterActionShortcut("w"), "work-session");
  assert.equal(getSessionCenterActionShortcut("s"), undefined);
  assert.equal(getSessionCenterActionShortcut("r"), "new-research");
  assert.equal(getSessionCenterActionShortcut("d"), "doctor");
  assert.equal(getSessionCenterActionShortcut("m"), undefined);
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
  assert.equal(getImmediateActionShortcut("S"), undefined);
  assert.equal(getImmediateActionShortcut("D"), "doctor");
  assert.equal(getImmediateActionShortcut("M"), undefined);
  assert.equal(getImmediateActionShortcut("N"), undefined);
  assert.equal(getImmediateActionShortcut("R"), "new-research");
});

test("shouldCaptureDashboardInput yields to embedded work pane input while the Work tab is active", () => {
  assert.equal(shouldCaptureDashboardInput("work", true), false);
  assert.equal(shouldCaptureDashboardInput("sessions", true), true);
  assert.equal(shouldCaptureDashboardInput("research", true), true);
  assert.equal(shouldCaptureDashboardInput("work", false), true);
});
