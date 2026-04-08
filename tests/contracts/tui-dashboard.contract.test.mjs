import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_ACTIONS,
  createWorkspaceShellSections,
  getWorkspaceDisplayName,
  handleDashboardInput,
  shouldRenderEmbeddedWorkPaneFullscreen,
} from "../../packages/tui/src/index.tsx";

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
