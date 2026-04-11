import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildEmbeddedWorkSessionUpdate,
  parseSelectedSessionIdFromArgs,
} from "@unclecode/contracts";
import {
  DASHBOARD_ACTIONS,
  createEmbeddedWorkPaneController,
  createSessionCenterDashboardRenderOptions,
  createWorkspaceShellSections,
  getWorkspaceDisplayName,
  handleDashboardInput,
  resolveWorkPaneNavigationMode,
  shouldRenderEmbeddedWorkPaneFullscreen,
} from "../../packages/tui/src/index.tsx";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

// ── Legacy backward compatibility ───────────────────────────────────

test("createWorkspaceShellSections still exposes legacy contract fields", () => {
  const sections = createWorkspaceShellSections({
    workspaceRoot: "/Users/parkeungje/project/unclecode",
  });

  assert.equal(sections.title, "unclecode");
  assert.match(sections.subtitle, /local coding shell/i);
  assert.match(
    sections.workspaceLine,
    /\/Users\/parkeungje\/project\/unclecode/,
  );
  assert.ok(
    sections.actions.some((a) => a.command === "unclecode auth status"),
  );
  assert.ok(
    sections.actions.some(
      (a) => a.command === "unclecode auth login --browser",
    ),
  );
  assert.ok(
    sections.actions.some((a) => a.command === "unclecode config explain"),
  );
});

// ── Dashboard actions contract ───────────────────────────────────────

test("DASHBOARD_ACTIONS includes all required CLI commands", () => {
  const commands = DASHBOARD_ACTIONS.map((a) => a.command);

  assert.ok(commands.includes("unclecode auth status"), "auth status present");
  assert.ok(
    commands.includes("unclecode auth login --browser"),
    "auth login present",
  );
  assert.ok(
    commands.includes("unclecode config explain"),
    "config explain present",
  );
  assert.ok(commands.includes("unclecode --help"), "help present");
});

test("shouldRenderEmbeddedWorkPaneFullscreen gives the work pane the full screen when embedded", () => {
  assert.equal(shouldRenderEmbeddedWorkPaneFullscreen("work", true), true);
  assert.equal(shouldRenderEmbeddedWorkPaneFullscreen("sessions", true), false);
  assert.equal(shouldRenderEmbeddedWorkPaneFullscreen("work", false), false);
});

test("resolveWorkPaneNavigationMode prefers embedded updates over launch handoff when available", () => {
  assert.equal(
    resolveWorkPaneNavigationMode({
      forwardedArgs: ["--session-id", "work-session-9"],
      hasEmbeddedWorkPane: true,
      hasEmbeddedWorkController: true,
      hasLaunchWorkSession: true,
    }),
    "embedded-update",
  );
  assert.equal(
    resolveWorkPaneNavigationMode({
      forwardedArgs: [],
      hasEmbeddedWorkPane: true,
      hasEmbeddedWorkController: false,
      hasLaunchWorkSession: true,
    }),
    "embedded-view",
  );
  assert.equal(
    resolveWorkPaneNavigationMode({
      forwardedArgs: ["--session-id", "work-session-9"],
      hasEmbeddedWorkPane: true,
      hasEmbeddedWorkController: false,
      hasLaunchWorkSession: true,
    }),
    "launch-handoff",
  );
});

test("embedded work controller helpers share selected-session parsing and patch assembly", () => {
  assert.equal(
    parseSelectedSessionIdFromArgs([
      "--cwd",
      "/tmp/x",
      "--session-id",
      "work-session-11",
    ]),
    "work-session-11",
  );
  assert.equal(parseSelectedSessionIdFromArgs(["--cwd", "/tmp/x"]), undefined);

  assert.deepEqual(
    buildEmbeddedWorkSessionUpdate({
      forwardedArgs: ["--session-id", "work-session-11"],
      contextLines: ["Resumed session: work-session-11"],
      homeState: { authLabel: "oauth-file", sessionCount: 2 },
    }),
    {
      selectedSessionId: "work-session-11",
      contextLines: ["Resumed session: work-session-11"],
      homeState: { authLabel: "oauth-file", sessionCount: 2 },
    },
  );
});

test("embedded work dashboard helpers return the shared TuiRenderOptions seam", () => {
  const dashboardRenderSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-render.tsx"),
    "utf8",
  );

  assert.match(
    dashboardRenderSource,
    /export function createEmbeddedWorkShellDashboardProps\([\s\S]*\): TuiRenderOptions<TuiShellHomeState>/,
  );
  assert.match(
    dashboardRenderSource,
    /export function createEmbeddedWorkShellPaneDashboardProps<[\s\S]*\): TuiRenderOptions<TuiShellHomeState>/,
  );
  assert.doesNotMatch(
    dashboardRenderSource,
    /createEmbeddedWorkShellDashboardProps[\s\S]*React\.ComponentProps<typeof Dashboard>/,
  );
});

test("dashboard component and render entry live in dedicated owner seams", () => {
  const dashboardShellPath = path.join(
    workspaceRoot,
    "packages/tui/src/dashboard-shell.tsx",
  );
  const dashboardShellSource = readFileSync(dashboardShellPath, "utf8");
  const tuiEntryPath = path.join(
    workspaceRoot,
    "packages/tui/src/tui-entry.tsx",
  );
  const tuiEntrySource = readFileSync(tuiEntryPath, "utf8");

  assert.ok(
    existsSync(dashboardShellPath),
    "dashboard-shell.tsx exists as dedicated component owner",
  );
  assert.match(
    dashboardShellSource,
    /export function Dashboard\(props: DashboardProps\)/,
    "dashboard-shell exports Dashboard component",
  );

  assert.ok(existsSync(tuiEntryPath), "tui-entry.tsx exists as render owner");
  assert.match(
    tuiEntrySource,
    /export\s+function\s+createDashboardElement\(/,
    "tui-entry exports createDashboardElement",
  );
  assert.match(
    tuiEntrySource,
    /export\s+(?:async\s+)?function\s+renderEmbeddedWorkShellPaneDashboard\(/,
    "tui-entry exports embedded dashboard renderer",
  );
  assert.match(
    tuiEntrySource,
    /export\s+(?:async\s+)?function\s+renderManagedWorkShellDashboard</,
    "tui-entry exports managed dashboard renderer",
  );
  assert.match(
    tuiEntrySource,
    /export\s+async\s+function\s+renderTui\(/,
    "tui-entry exports renderTui",
  );
});

test("TUI render entrypoints share one Dashboard element builder", () => {
  const tuiEntrySource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/tui-entry.tsx"),
    "utf8",
  );

  assert.match(
    tuiEntrySource,
    /function\s+createDashboardElement\([\s\S]*?props:\s*TuiRenderOptions<TuiShellHomeState>[\s\S]*?\)/,
  );
  assert.match(
    tuiEntrySource,
    /renderEmbeddedWorkShellPaneDashboard\([\s\S]*render\(\s*createDashboardElement\(props\)\s*\)/,
  );
  assert.match(
    tuiEntrySource,
    /renderTui\([\s\S]*createDashboardElement\(options\s*\?\?\s*\{\}\)/,
  );
});

test("Dashboard props derive from the shared TuiRenderOptions seam", () => {
  const dashboardShellSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-shell.tsx"),
    "utf8",
  );

  assert.match(
    dashboardShellSource,
    /export type DashboardProps = TuiRenderOptions<TuiShellHomeState> & \{[\s\S]*readonly workspaceRoot: string;[\s\S]*\};/,
  );
  assert.match(
    dashboardShellSource,
    /export function Dashboard\(props: DashboardProps\)/,
  );
  assert.doesNotMatch(
    dashboardShellSource,
    /export function Dashboard\(props: \{[\s\S]*readonly workspaceRoot: string;/,
  );
});

test("dashboard hotspot re-exports extracted dashboard owner seams instead of regrowing local wrappers", () => {
  const tuiSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/index.tsx"),
    "utf8",
  );
  const dashboardSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-dashboard.tsx"),
    "utf8",
  );
  const dashboardSyncSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-dashboard-sync.ts"),
    "utf8",
  );
  const dashboardActionsSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-actions.ts"),
    "utf8",
  );
  const dashboardNavigationSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-navigation.ts"),
    "utf8",
  );
  const dashboardRenderSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-render.tsx"),
    "utf8",
  );
  const dashboardShellSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-shell.tsx"),
    "utf8",
  );
  const tuiEntrySource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/tui-entry.tsx"),
    "utf8",
  );

  assert.match(tuiSource, /export \* from "\.\/dashboard-actions\.js"/);
  assert.match(tuiSource, /export \* from "\.\/dashboard-navigation\.js"/);
  assert.match(tuiSource, /export \* from "\.\/dashboard-render\.js"/);
  assert.match(tuiSource, /export \* from "\.\/work-shell-dashboard\.js"/);
  assert.match(tuiSource, /export \* from "\.\/work-shell-dashboard-sync\.js"/);
  assert.match(tuiSource, /export \* from "\.\/tui-entry\.js"/);
  assert.doesNotMatch(
    tuiSource,
    /export \{ Dashboard \} from "\.\/dashboard-shell\.js"/,
  );
  assert.doesNotMatch(
    tuiSource,
    /export \{ renderTui \} from "\.\/dashboard-shell\.js"/,
  );
  assert.match(dashboardShellSource, /export function Dashboard\(/);
  assert.match(
    tuiEntrySource,
    /export\s+function\s+createDashboardElement\([\s\S]*?:\s*TuiRenderOptions<TuiShellHomeState>\s*,/,
  );
  assert.match(
    tuiEntrySource,
    /export\s+(?:async\s+)?function\s+renderEmbeddedWorkShellPaneDashboard\([\s\S]*?await\s+instance\.waitUntilExit\(/,
  );
  assert.match(
    tuiEntrySource,
    /export\s+(?:async\s+)?function\s+renderManagedWorkShellDashboard<[\s\S]*?createManagedWorkShellDashboardProps\(input\)/,
  );
  assert.match(tuiEntrySource, /export\s+async\s+function\s+renderTui\(/);
  assert.match(dashboardActionsSource, /export const DASHBOARD_ACTIONS/);
  assert.match(
    dashboardActionsSource,
    /export function createSessionCenterModel\(/,
  );
  assert.match(
    dashboardNavigationSource,
    /export function handleDashboardInput\(/,
  );
  assert.match(
    dashboardNavigationSource,
    /export function handleSessionCenterInput\(/,
  );
  assert.match(
    dashboardRenderSource,
    /export function createEmbeddedWorkShellDashboardProps\(/,
  );
  assert.match(
    dashboardRenderSource,
    /export function createManagedWorkShellDashboardProps</,
  );
  assert.match(dashboardSource, /export function EmbeddedWorkShellPane</);
  assert.match(
    dashboardSyncSource,
    /export function createWorkShellDashboardHomePatch/,
  );
  assert.match(
    dashboardSyncSource,
    /export function createWorkShellDashboardHomeSyncState/,
  );
  assert.doesNotMatch(tuiSource, /export const DASHBOARD_ACTIONS/);
  assert.doesNotMatch(tuiSource, /export function createSessionCenterModel\(/);
  assert.doesNotMatch(tuiSource, /export function handleDashboardInput\(/);
  assert.doesNotMatch(tuiSource, /export function handleSessionCenterInput\(/);
  assert.doesNotMatch(
    tuiSource,
    /export function createEmbeddedWorkShellDashboardProps\(/,
  );
  assert.doesNotMatch(
    tuiSource,
    /export function createManagedWorkShellDashboardProps</,
  );
  assert.doesNotMatch(
    tuiSource,
    /export function createWorkShellDashboardHomePatch\(/,
  );
  assert.doesNotMatch(
    tuiSource,
    /export function createWorkShellDashboardHomeSyncState\(/,
  );
  assert.doesNotMatch(tuiSource, /export function EmbeddedWorkShellPane</);
});

test("embedded work dashboard snapshot and render-option helpers are formalized as shared TUI seams", () => {
  // Ownership moved to dashboard-model.ts; dashboard-shell.tsx re-exports these.
  const dashboardModelSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-model.ts"),
    "utf8",
  );
  const dashboardShellSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/dashboard-shell.tsx"),
    "utf8",
  );

  assert.match(
    dashboardModelSource,
    /export type EmbeddedWorkDashboardSnapshot<[\s\S]*> = Pick<[\s\S]*TuiRenderOptions<HomeState>/,
  );
  assert.match(
    dashboardModelSource,
    /export type EmbeddedWorkPaneRenderOptions<[\s\S]*> = EmbeddedWorkDashboardSnapshot<HomeState> & Pick<[\s\S]*openEmbeddedWorkSession/,
  );
  assert.match(
    dashboardModelSource,
    /export function extractEmbeddedHomeStatePatch</,
  );
  assert.match(
    dashboardModelSource,
    /export function buildEmbeddedWorkPaneRenderOptions</,
  );
  assert.match(
    dashboardModelSource,
    /export async function createEmbeddedWorkPaneController</,
  );
  assert.match(
    dashboardModelSource,
    /export function createSessionCenterDashboardRenderOptions</,
  );
  // dashboard-shell.tsx must re-export these for backward compatibility
  assert.match(
    dashboardShellSource,
    /from "\.\/dashboard-model\.js"/,
    "dashboard-shell re-exports from dashboard-model",
  );
});

test("createSessionCenterDashboardRenderOptions merges embedded pane state into shell props", () => {
  const options = createSessionCenterDashboardRenderOptions({
    workspaceRoot: "/tmp/project-shell",
    homeState: {
      modeLabel: "default",
      authLabel: "none",
      sessionCount: 1,
      mcpServerCount: 0,
      mcpServers: [],
      latestResearchSessionId: null,
      latestResearchSummary: null,
      latestResearchTimestamp: null,
      researchRunCount: 0,
      sessions: [],
      bridgeLines: ["bridge:a"],
      memoryLines: ["memory:a"],
    },
    initialSelectedSessionId: "work-session-9",
    contextLines: ["inline context"],
    embeddedWorkPane: {
      modeLabel: "planner",
      authLabel: "oauth-file",
      sessionCount: 2,
      mcpServerCount: 1,
      mcpServers: [],
      latestResearchSessionId: null,
      latestResearchSummary: null,
      latestResearchTimestamp: null,
      researchRunCount: 0,
      sessions: [],
      bridgeLines: ["bridge:b"],
      memoryLines: ["memory:b"],
      contextLines: ["embedded context"],
      renderWorkPane: () => "pane",
      openEmbeddedWorkSession: async () => undefined,
    },
    runAction: async () => [],
    runSession: async () => [],
    launchWorkSession: async () => undefined,
    refreshHomeState: async () => ({
      modeLabel: "default",
      authLabel: "none",
      sessionCount: 1,
      mcpServerCount: 0,
      mcpServers: [],
      latestResearchSessionId: null,
      latestResearchSummary: null,
      latestResearchTimestamp: null,
      researchRunCount: 0,
      sessions: [],
      bridgeLines: [],
      memoryLines: [],
    }),
  });

  assert.equal(options.workspaceRoot, "/tmp/project-shell");
  assert.equal(options.modeLabel, "planner");
  assert.equal(options.authLabel, "oauth-file");
  assert.equal(options.initialView, "work");
  assert.deepEqual(options.contextLines, ["inline context"]);
  assert.deepEqual(options.bridgeLines, ["bridge:b"]);
  assert.deepEqual(options.memoryLines, ["memory:b"]);
  assert.equal(typeof options.renderWorkPane, "function");
  assert.equal(typeof options.openEmbeddedWorkSession, "function");
});

test("createEmbeddedWorkPaneController keeps embedded pane state in sync across session switches", async () => {
  let snapshotIndex = 0;
  const controller = await createEmbeddedWorkPaneController({
    initialSelectedSessionId: "work-session-1",
    loadSnapshot: async (forwardedArgs = []) => {
      const nextIndex = snapshotIndex;
      snapshotIndex += 1;
      return nextIndex === 0
        ? {
            authLabel: "none",
            sessionCount: 1,
            modeLabel: "default",
            mcpServerCount: 0,
            mcpServers: [],
            latestResearchSessionId: null,
            latestResearchSummary: null,
            latestResearchTimestamp: null,
            researchRunCount: 0,
            sessions: [],
            contextLines: ["Resumed session: work-session-1"],
            renderWorkPane: () =>
              `pane:${forwardedArgs.join(" ") || "initial"}`,
          }
        : {
            authLabel: "oauth-file",
            sessionCount: 2,
            modeLabel: "planner",
            mcpServerCount: 1,
            mcpServers: [],
            latestResearchSessionId: null,
            latestResearchSummary: null,
            latestResearchTimestamp: null,
            researchRunCount: 0,
            sessions: [],
            contextLines: ["Resumed session: work-session-2"],
            renderWorkPane: () =>
              `pane:${forwardedArgs.join(" ") || "updated"}`,
          };
    },
  });

  assert.equal(typeof controller?.renderWorkPane, "function");
  assert.equal(
    controller?.renderWorkPane?.({
      openSessions() {},
      syncHomeState() {},
    }),
    "pane:--session-id work-session-1",
  );

  const update = await controller?.openEmbeddedWorkSession?.([
    "--session-id",
    "work-session-2",
  ]);

  assert.deepEqual(update, {
    selectedSessionId: "work-session-2",
    contextLines: ["Resumed session: work-session-2"],
    homeState: {
      authLabel: "oauth-file",
      sessionCount: 2,
      modeLabel: "planner",
      mcpServerCount: 1,
      mcpServers: [],
      latestResearchSessionId: null,
      latestResearchSummary: null,
      latestResearchTimestamp: null,
      researchRunCount: 0,
      sessions: [],
    },
  });
  assert.equal(
    controller?.renderWorkPane?.({
      openSessions() {},
      syncHomeState() {},
    }),
    "pane:--session-id work-session-2",
  );
});

test("DASHBOARD_ACTIONS has six primary actions", () => {
  assert.equal(DASHBOARD_ACTIONS.length, 6);
});

test("each dashboard action has well-formed fields", () => {
  const validCategories = ["auth", "config", "workspace", "session"];

  for (const action of DASHBOARD_ACTIONS) {
    assert.ok(action.label.length > 0, `label non-empty: ${action.command}`);
    assert.ok(
      action.command.startsWith("unclecode") ||
        action.command.startsWith("git"),
      `command is unclecode or git: ${action.command}`,
    );
    assert.ok(
      action.description.length > 0,
      `description non-empty: ${action.command}`,
    );
    assert.ok(
      validCategories.includes(action.category),
      `category is valid: ${action.category} for ${action.command}`,
    );
  }
});

test("dashboard actions cover all four categories", () => {
  const categories = new Set(DASHBOARD_ACTIONS.map((a) => a.category));
  assert.ok(categories.has("auth"), "has auth category");
  assert.ok(categories.has("config"), "has config category");
  assert.ok(categories.has("workspace"), "has workspace category");
  assert.ok(categories.has("session"), "has session category");
});

test("no duplicate commands in DASHBOARD_ACTIONS", () => {
  const commands = DASHBOARD_ACTIONS.map((a) => a.command);
  const unique = new Set(commands);
  assert.equal(commands.length, unique.size, "all commands are unique");
});

// ── Input handler state machine ──────────────────────────────────────

test("handleDashboardInput navigates down in browse mode", () => {
  const result = handleDashboardInput(
    "",
    { downArrow: true },
    "browse",
    0,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.view, "browse");
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.shouldExit, false);
  assert.equal(result.exitCommand, undefined);
});

test("handleDashboardInput navigates up in browse mode", () => {
  const result = handleDashboardInput(
    "",
    { upArrow: true },
    "browse",
    2,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.view, "browse");
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.shouldExit, false);
});

test("handleDashboardInput clamps navigation at top boundary", () => {
  const result = handleDashboardInput(
    "",
    { upArrow: true },
    "browse",
    0,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.selectedIndex, 0);
});

test("handleDashboardInput clamps navigation at bottom boundary", () => {
  const last = DASHBOARD_ACTIONS.length - 1;
  const result = handleDashboardInput(
    "",
    { downArrow: true },
    "browse",
    last,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.selectedIndex, last);
});

test("handleDashboardInput enters detail on Enter in browse mode", () => {
  const result = handleDashboardInput(
    "",
    { return: true },
    "browse",
    0,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.view, "detail");
  assert.equal(result.shouldExit, false);
  assert.equal(result.exitCommand, undefined);
});

test("handleDashboardInput returns to browse on Escape in detail mode", () => {
  const result = handleDashboardInput(
    "",
    { escape: true },
    "detail",
    2,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.view, "browse");
  assert.equal(result.shouldExit, false);
});

test("handleDashboardInput exits with command on Enter in detail mode", () => {
  const result = handleDashboardInput(
    "",
    { return: true },
    "detail",
    0,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitCommand, "unclecode auth status");
});

test("handleDashboardInput exits without command on Enter in detail for last action", () => {
  const last = DASHBOARD_ACTIONS.length - 1;
  const result = handleDashboardInput(
    "",
    { return: true },
    "detail",
    last,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitCommand, "unclecode center");
});

test("handleDashboardInput exits on q in browse mode", () => {
  const result = handleDashboardInput(
    "q",
    {},
    "browse",
    0,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitCommand, undefined);
});

test("handleDashboardInput exits on Ctrl+C in browse mode", () => {
  const result = handleDashboardInput(
    "c",
    { ctrl: true },
    "browse",
    0,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.shouldExit, true);
});

test("handleDashboardInput exits on Ctrl+C in detail mode", () => {
  const result = handleDashboardInput(
    "c",
    { ctrl: true },
    "detail",
    0,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitCommand, undefined);
});

test("handleDashboardInput ignores unknown keys in browse mode", () => {
  const result = handleDashboardInput(
    "x",
    {},
    "browse",
    2,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.view, "browse");
  assert.equal(result.selectedIndex, 2);
  assert.equal(result.shouldExit, false);
});

test("handleDashboardInput ignores unknown keys in detail mode", () => {
  const result = handleDashboardInput(
    "z",
    {},
    "detail",
    1,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(result.view, "detail");
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.shouldExit, false);
});

test("handleDashboardInput preserves selectedIndex on view transitions", () => {
  const intoDetail = handleDashboardInput(
    "",
    { return: true },
    "browse",
    3,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(intoDetail.view, "detail");
  assert.equal(intoDetail.selectedIndex, 3);

  const backToBrowse = handleDashboardInput(
    "",
    { escape: true },
    "detail",
    3,
    DASHBOARD_ACTIONS.length,
  );
  assert.equal(backToBrowse.view, "browse");
  assert.equal(backToBrowse.selectedIndex, 3);
});

test("getWorkspaceDisplayName handles both POSIX and Windows paths", () => {
  assert.equal(
    getWorkspaceDisplayName("/Users/parkeungje/project/unclecode"),
    "unclecode",
  );
  assert.equal(
    getWorkspaceDisplayName("C:\\Users\\parkeungje\\project\\unclecode"),
    "unclecode",
  );
  assert.equal(getWorkspaceDisplayName("unclecode"), "unclecode");
});
