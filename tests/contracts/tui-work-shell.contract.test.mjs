import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  Composer,
  WorkShellPane,
  applyComposerEdit,
  buildAttachmentPreviewLines,
  buildContextPanel,
  buildInlineCommandPanel,
  buildSlashSuggestionPanel,
  buildTerminalInlineImageSequence,
  buildWorkShellHelpPanel,
  buildWorkShellStatusPanel,
  clampWorkShellSlashSelection,
  createEmbeddedWorkShellPaneDashboardProps,
  createEmptyWorkShellComposerPreview,
  createFastWorkShellComposerPreview,
  createWorkShellDashboardHomePatch,
  createWorkShellDashboardHomeSyncState,
  cycleWorkShellSlashSelection,
  formatAgentTraceLine,
  formatAttachmentBadgeLine,
  formatAuthLabelForDisplay,
  formatInlineImageSupportLine,
  formatRuntimeLabel,
  formatToolTraceLine,
  formatWorkShellBusyStatusLine,
  formatWorkShellError,
  formatWorkShellProviderTitle,
  formatWorkShellStatusLine,
  formatWorkShellThinkingLine,
  formatWorkShellUsageLine,
  getDisplayWidth,
  getWorkShellAttachmentMinHeight,
  getWorkShellAttachmentPlacement,
  getWorkShellBottomDrawerMinHeight,
  getWorkShellComposerHint,
  getWorkShellComposerHintMinHeight,
  getWorkShellEmptyConversationHint,
  getWorkShellEntryBorderStyle,
  getWorkShellEntryPresentation,
  getWorkShellPanelAnchor,
  getWorkShellPanelDisplayMode,
  getWorkShellPanelPlacement,
  isWorkShellWarningLine,
  normalizeMarkdownDisplayText,
  parseWorkShellPanelFactLine,
  refineInlineCommandPanelLines,
  renderEmbeddedWorkShellPaneDashboard,
  resolveWorkShellActivePanel,
  resolveWorkShellInputAction,
  resolveWorkShellSubmitAction,
  shouldUseSlowComposerPreview,
  sliceByDisplayWidth,
  truncateForDisplayWidth,
  useWorkShellDashboardHomeSync,
  useWorkShellInputController,
  useWorkShellPaneState,
  useWorkShellSlashState,
} from "../../packages/tui/src/index.tsx";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

test("work-shell hotspot re-exports extracted helper owner seams instead of regrowing local copies", () => {
  const tuiSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/index.tsx"),
    "utf8",
  );
  const hooksSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-hooks.ts"),
    "utf8",
  );
  const panelsSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-panels.ts"),
    "utf8",
  );
  const viewSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-view.tsx"),
    "utf8",
  );
  const inputSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-input.ts"),
    "utf8",
  );

  assert.match(tuiSource, /export \* from "\.\/work-shell-hooks\.js"/);
  assert.match(tuiSource, /export \* from "\.\/work-shell-panels\.js"/);
  assert.match(tuiSource, /export \* from "\.\/work-shell-input\.js"/);
  assert.match(tuiSource, /export \* from "\.\/work-shell-view\.js"/);
  assert.match(hooksSource, /export function useWorkShellDashboardHomeSync\(/);
  assert.match(hooksSource, /export function useWorkShellInputController\(/);
  assert.match(hooksSource, /export function useWorkShellPaneState</);
  assert.match(hooksSource, /export function useWorkShellSlashState\(/);
  assert.match(panelsSource, /export function buildContextPanel\(/);
  assert.match(panelsSource, /export function buildInlineCommandPanel\(/);
  assert.match(viewSource, /export function formatWorkShellProviderTitle\(/);
  assert.match(viewSource, /export function getWorkShellEntryPresentation\(/);
  assert.match(viewSource, /function WorkShellSectionDivider\(/);
  assert.doesNotMatch(
    viewSource,
    /<Text bold color="white">Conversation<\/Text>/,
  );
  assert.doesNotMatch(
    viewSource,
    /<Box borderStyle="round" borderColor=\{props\.panelBorderColor\} paddingX=\{1\}>/,
  );
  assert.doesNotMatch(
    viewSource,
    /<Box marginTop=\{1\} borderStyle="round" borderColor=\{W\.border\} paddingX=\{1\} flexDirection="column">/,
  );
  assert.match(inputSource, /export function resolveWorkShellInputAction\(/);
  assert.match(inputSource, /export function resolveWorkShellSubmitAction\(/);
  assert.doesNotMatch(
    tuiSource,
    /export function useWorkShellDashboardHomeSync\(/,
  );
  assert.doesNotMatch(
    tuiSource,
    /export function useWorkShellInputController\(/,
  );
  assert.doesNotMatch(
    tuiSource,
    /export function resolveWorkShellInputAction\(/,
  );
  assert.doesNotMatch(
    tuiSource,
    /export function resolveWorkShellSubmitAction\(/,
  );
  assert.doesNotMatch(tuiSource, /export function buildContextPanel\(/);
  assert.doesNotMatch(tuiSource, /export function buildInlineCommandPanel\(/);
});

test("formatWorkShellProviderTitle humanizes known providers for the unified work tab", () => {
  assert.equal(formatWorkShellProviderTitle("openai"), "UncleCode · OpenAI");
  assert.equal(formatWorkShellProviderTitle("gemini"), "UncleCode · Gemini");
  assert.equal(
    formatWorkShellProviderTitle("anthropic"),
    "UncleCode · Anthropic",
  );
});

test("getWorkShellEntryPresentation keeps user, assistant, tool, and system roles visually distinct", () => {
  assert.deepEqual(getWorkShellEntryPresentation("user"), {
    label: "You",
    badge: "›",
    labelColor: "#7dd3fc",
    borderColor: "#7dd3fc",
    bodyColor: "#e7e5e4",
  });
  assert.deepEqual(getWorkShellEntryPresentation("assistant"), {
    label: "Assistant",
    badge: "✦",
    labelColor: "#86efac",
    borderColor: "#86efac",
    bodyColor: "#e7e5e4",
  });
  assert.deepEqual(getWorkShellEntryPresentation("tool"), {
    label: "Step",
    badge: "→",
    labelColor: "#fbbf24",
    borderColor: "#57534e",
    bodyColor: "#e7e5e4",
  });
  assert.deepEqual(getWorkShellEntryPresentation("system"), {
    label: "Status",
    badge: "·",
    labelColor: "#a8a29e",
    borderColor: "#44403c",
    bodyColor: "#a8a29e",
  });
  assert.equal(getWorkShellEntryBorderStyle("user"), "round");
  assert.equal(getWorkShellEntryBorderStyle("assistant"), "round");
  assert.equal(getWorkShellEntryBorderStyle("tool"), "single");
  assert.equal(getWorkShellEntryBorderStyle("system"), "single");
  assert.equal(
    getWorkShellEmptyConversationHint(),
    "Type a task to start. Use / for commands, @file for context.",
  );
});

test("getWorkShellComposerHint keeps slash discovery guidance inside the shared work presenter seam", () => {
  assert.equal(
    getWorkShellComposerHint("/auth", 2),
    "↑↓ select · Enter run · Esc cancel",
  );
  assert.equal(getWorkShellComposerHint("/unknown", 0), "No matches");
  assert.equal(
    getWorkShellComposerHint("", 0),
    "Enter send · Shift+Enter newline · / commands",
  );
  assert.equal(
    getWorkShellComposerHint("plain text", 3),
    "Enter send · Shift+Enter newline",
  );
  assert.equal(getWorkShellComposerHintMinHeight(), 1);
});

test("getWorkShellPanelPlacement keeps long-session panels near the composer by default", () => {
  assert.equal(getWorkShellPanelAnchor("bottom"), "after-composer");
  assert.equal(getWorkShellPanelAnchor("hidden"), "after-composer");
  assert.equal(getWorkShellPanelAnchor("overlay"), "after-composer");
  assert.equal(getWorkShellPanelAnchor("side"), "with-conversation");
  assert.equal(
    getWorkShellPanelDisplayMode({
      panelTitle: "Context",
      inputValue: "plain text",
      terminalColumns: 180,
    }),
    "hidden",
  );
  assert.equal(
    getWorkShellPanelDisplayMode({
      panelTitle: "Context expanded",
      inputValue: "plain text",
      terminalColumns: 180,
    }),
    "overlay",
  );
  assert.equal(
    getWorkShellPanelPlacement({
      panelTitle: "Auth",
      inputValue: "/auth",
      terminalColumns: 180,
    }),
    "bottom",
  );
  assert.equal(
    getWorkShellPanelPlacement({
      panelTitle: "Models",
      inputValue: "/model",
      terminalColumns: 180,
    }),
    "bottom",
  );
  assert.equal(
    getWorkShellPanelPlacement({
      panelTitle: "Auth",
      inputValue: "/auth",
      terminalColumns: 120,
    }),
    "bottom",
  );
  assert.equal(
    getWorkShellBottomDrawerMinHeight("bottom", "Commands", "/auth"),
    6,
  );
  assert.equal(
    getWorkShellBottomDrawerMinHeight("bottom", "Models", "/model"),
    6,
  );
  assert.equal(
    getWorkShellBottomDrawerMinHeight("bottom", "Session status", "plain text"),
    6,
  );
  assert.equal(
    getWorkShellBottomDrawerMinHeight("bottom", "Doctor", "plain text"),
    6,
  );
  assert.equal(getWorkShellAttachmentPlacement(), "after-composer");
  assert.equal(getWorkShellAttachmentMinHeight(), 4);
});

test("work-shell slash selection helpers are exported from the shared tui package seam", () => {
  assert.equal(clampWorkShellSlashSelection(4, 0), 0);
  assert.equal(clampWorkShellSlashSelection(4, 2), 1);
  assert.equal(cycleWorkShellSlashSelection(0, 2, "previous"), 1);
  assert.equal(cycleWorkShellSlashSelection(1, 2, "next"), 0);
  assert.equal(
    resolveWorkShellActivePanel({
      input: "/auth",
      suggestions: [
        { command: "/auth status", description: "Show auth source." },
      ],
      selectedIndex: 0,
      authLabel: "oauth-file",
      fallbackPanel: {
        title: "Context",
        lines: ["Loaded guidance: AGENTS.md"],
      },
    }).title,
    "Auth",
  );
  assert.equal(
    resolveWorkShellActivePanel({
      input: "plain text",
      suggestions: [
        { command: "/auth status", description: "Show auth source." },
      ],
      selectedIndex: 0,
      fallbackPanel: {
        title: "Context",
        lines: ["Loaded guidance: AGENTS.md"],
      },
    }).title,
    "Context",
  );
  const noMatchPanel = resolveWorkShellActivePanel({
    input: "/zz",
    suggestions: [],
    selectedIndex: 0,
    fallbackPanel: {
      title: "Context",
      lines: ["Loaded guidance: AGENTS.md"],
    },
  });
  assert.equal(noMatchPanel.title, "Commands");
  assert.match(noMatchPanel.lines.join("\n"), /No slash yet\./);
});

test("work-shell dashboard sync helpers are exported from the shared tui package seam", () => {
  assert.deepEqual(
    createWorkShellDashboardHomePatch({
      authLabel: "api-key-env",
      bridgeLines: ["Bridge updated"],
      memoryLines: ["Memory updated"],
    }),
    {
      authLabel: "api-key-env",
      bridgeLines: ["Bridge updated"],
      memoryLines: ["Memory updated"],
    },
  );
  assert.deepEqual(
    createWorkShellDashboardHomeSyncState({
      isBusy: false,
      authLabel: "api-key-env",
      bridgeLines: ["Bridge updated"],
      memoryLines: ["Memory updated"],
    }),
    {
      isBusy: false,
      authLabel: "api-key-env",
      bridgeLines: ["Bridge updated"],
      memoryLines: ["Memory updated"],
    },
  );
});

test("work-shell input decision helpers are exported from the shared tui package seam", () => {
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { tab: true },
      input: "/auth",
      slashSuggestionCount: 1,
      selectedSlashCommand: "/auth status",
      isBusy: false,
      hasRequestSessionsView: false,
    }),
    { type: "complete-slash", value: "/auth status " },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: true,
    }),
    { type: "open-sessions-view" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: true,
      hasOverlayOpen: true,
    }),
    { type: "close-overlay" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "sk-secret-123",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: true,
      hasSensitiveInput: true,
    }),
    { type: "cancel-sensitive-input" },
  );
  assert.deepEqual(
    resolveWorkShellSubmitAction({
      value: "/auth",
      isBusy: false,
      shouldBlockSlashSubmit: true,
      selectedSlashCommand: "/auth status",
    }),
    { type: "submit-suggestion", line: "/auth status", clearInput: true },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "***",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: true,
      hasSensitiveInput: true,
    }),
    { type: "cancel-sensitive-input" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { tab: true, shift: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: false,
      currentMode: "default",
    }),
    { type: "cycle-mode", nextMode: "yolo" },
  );
  assert.deepEqual(
    resolveWorkShellSubmitAction({
      value: "/auth",
      isBusy: false,
      shouldBlockSlashSubmit: true,
      selectedSlashCommand: "/auth status",
    }),
    { type: "submit-suggestion", line: "/auth status", clearInput: true },
  );
  assert.deepEqual(
    resolveWorkShellSubmitAction({
      value: "ship it",
      isBusy: false,
      shouldBlockSlashSubmit: false,
    }),
    { type: "submit", line: "ship it", clearInput: true },
  );
  assert.deepEqual(
    applyComposerEdit({
      value: "hello",
      cursorOffset: 5,
      input: "",
      key: { return: true, shift: true },
      allowLineBreaks: true,
    }),
    { nextValue: "hello\n", nextCursorOffset: 6, submitted: false },
  );
});

test("work-shell lifecycle/composer helpers are exported from the shared tui package seam", () => {
  assert.equal(typeof Composer, "function");
  assert.equal(typeof WorkShellPane, "function");
  assert.equal(typeof createEmbeddedWorkShellPaneDashboardProps, "function");
  assert.equal(typeof renderEmbeddedWorkShellPaneDashboard, "function");
  assert.deepEqual(createEmptyWorkShellComposerPreview(), {
    prompt: "",
    attachments: [],
    transcriptText: "",
  });
  assert.equal(typeof useWorkShellDashboardHomeSync, "function");
  assert.equal(typeof useWorkShellInputController, "function");
  assert.equal(typeof useWorkShellPaneState, "function");
  assert.equal(typeof useWorkShellSlashState, "function");
  assert.equal(shouldUseSlowComposerPreview("plain text"), false);
  assert.equal(shouldUseSlowComposerPreview("@README.md 요약"), true);
  assert.deepEqual(createFastWorkShellComposerPreview("plain text"), {
    prompt: "plain text",
    attachments: [],
    transcriptText: "plain text",
  });
});

test("embedded work-shell dashboard helper maps dashboard props through the shared tui seam", () => {
  const props = createEmbeddedWorkShellPaneDashboardProps({
    workspaceRoot: "/repo",
    homeState: {
      modeLabel: "default",
      authLabel: "api-key-env",
      sessionCount: 1,
      mcpServerCount: 0,
      mcpServers: [],
      latestResearchSessionId: null,
      latestResearchSummary: null,
      latestResearchTimestamp: null,
      researchRunCount: 0,
      sessions: [],
      bridgeLines: ["Bridge initial"],
      memoryLines: ["Memory initial"],
    },
    contextLines: ["Loaded guidance: AGENTS.md"],
    buildPane: () => ({
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      engine: {
        getState: () => ({
          entries: [],
          authLabel: "api-key-env",
          reasoning: { support: { status: "supported" } },
          isBusy: false,
          currentPanel: { title: "Context", lines: [] },
        }),
        initialize() {},
        dispose() {},
        subscribe: () => () => {},
        submit: async () => {},
      },
      cwd: "/repo",
      resolveComposerInput: async () => ({
        prompt: "",
        attachments: [],
        transcriptText: "",
      }),
      getSuggestions: () => [],
      shouldBlockSlashSubmit: () => false,
      getReasoningLabel: () => "medium (mode-default)",
      isReasoningSupported: () => true,
    }),
  });

  assert.equal(props.workspaceRoot, "/repo");
  assert.equal(props.initialView, "work");
  assert.equal(props.authLabel, "api-key-env");
  assert.equal(typeof props.renderWorkPane, "function");
});

test("work-shell panel helpers are exported from the shared tui package seam", () => {
  assert.equal(formatAuthLabelForDisplay("oauth-file"), "Browser OAuth · file");
  assert.deepEqual(parseWorkShellPanelFactLine("Model · gpt-5.4"), {
    label: "Model",
    value: "gpt-5.4",
  });
  assert.equal(parseWorkShellPanelFactLine("/model gpt-5.4"), undefined);
  assert.equal(isWorkShellWarningLine("Warning · reasoning unsupported"), true);
  assert.equal(isWorkShellWarningLine("Provider · openai"), false);
  assert.equal(buildInlineCommandPanel(["doctor"], ["ok"]).title, "Doctor");
  assert.equal(
    buildContextPanel(["Loaded guidance: AGENTS.md"], [], [], []).title,
    "Context",
  );
  assert.equal(
    buildSlashSuggestionPanel(
      "/auth",
      [{ command: "/auth login", description: "Login" }],
      0,
      "none",
    ).title,
    "Auth",
  );
  assert.equal(buildWorkShellHelpPanel().title, "Work-first shell");
  assert.match(buildWorkShellHelpPanel().lines.join("\n"), /\/model/);
  assert.deepEqual(
    buildWorkShellStatusPanel({
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      cwd: "/repo",
      reasoningLabel: "medium (mode-default)",
      authLabel: "api-key-env",
    }).lines,
    [
      "Current",
      "Provider · openai",
      "Model · gpt-5.4",
      "Reasoning · medium (mode-default)",
      "Mode · default",
      "Auth · API key · env",
      "",
      "Workspace",
      "Cwd · /repo",
    ],
  );
  assert.match(
    formatAgentTraceLine({
      type: "tool.started",
      level: "default",
      provider: "openai",
      toolName: "read_file",
      toolCallId: "call-1",
      input: { path: "apps/unclecode-cli/src/work-entry.ts" },
      startedAt: 0,
    }),
    /read apps\/unclecode-cli\/src\/work-entry\.ts/,
  );
  assert.match(
    formatToolTraceLine({
      type: "tool.completed",
      level: "default",
      provider: "openai",
      toolName: "read_file",
      toolCallId: "call-1",
      isError: false,
      output: "done",
      startedAt: 0,
      completedAt: 5,
      durationMs: 5,
    }),
    /✓ read 5ms/,
  );
  assert.equal(
    formatRuntimeLabel({ node: "v22", platform: "darwin", arch: "arm64" }),
    "Node v22 · darwin/arm64",
  );
  assert.equal(
    formatWorkShellThinkingLine("medium (mode-default)"),
    "Thinking · Balanced thinking",
  );
  assert.equal(
    formatWorkShellStatusLine({
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
    }),
    "gpt-5.4 · Work mode · Saved OAuth",
  );
  assert.equal(
    formatWorkShellBusyStatusLine("· thinking inspect repo", 0),
    "⠋ thinking inspect repo",
  );
  assert.equal(
    formatWorkShellUsageLine({
      isBusy: false,
      lastTurnDurationMs: 1480,
    }),
    "Ready · last reply 1.5s",
  );
  assert.equal(
    formatWorkShellUsageLine({
      isBusy: true,
      busyStatus: "thinking inspect repo",
      currentTurnStartedAt: 1000,
      nowMs: 2480,
      lastTurnDurationMs: 1480,
    }),
    "Working now · elapsed 1.5s · thinking inspect repo",
  );
  assert.equal(
    normalizeMarkdownDisplayText("## Heading\n- `npm run check`\n- **Done**"),
    "Heading\n• npm run check\n• Done",
  );
  assert.equal(
    formatWorkShellError("OpenAI request failed with status 401"),
    "OpenAI rejected current auth (401/403). Saved auth may be stale. Run /auth status, /auth login, or /auth logout.",
  );
  assert.equal(
    formatAttachmentBadgeLine([
      {
        type: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AA==",
        path: "/repo/shot.png",
        displayName: "shot.png",
      },
    ]),
    "Attachments 1 · shot.png",
  );
  assert.deepEqual(
    buildAttachmentPreviewLines([
      {
        type: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AA==",
        path: "/repo/shot.png",
        displayName: "shot.png",
      },
    ]),
    ["Attachments 1 · shot.png", "1. shot.png · image/png"],
  );
  assert.match(
    buildTerminalInlineImageSequence(
      {
        type: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AA==",
        path: "/repo/shot.png",
        displayName: "shot.png",
      },
      { TERM_PROGRAM: "iTerm.app" },
    ) ?? "",
    /1337;File=/,
  );
  assert.equal(
    formatInlineImageSupportLine({ TERM_PROGRAM: "iTerm.app" }),
    "iTerm inline preview paused while typing to prevent ghosting.",
  );
  assert.deepEqual(
    refineInlineCommandPanelLines({
      args: ["auth", "status"],
      lines: ["source: none", "auth: none"],
      failed: false,
      authLabel: "none",
    }).slice(0, 2),
    ["Current", "Auth · Not signed in"],
  );
});

// ── Composer CJK/Hangul/emoji display-width behavior ──────────────────

test("applyComposerEdit handles Hangul input and cursor positioning correctly", () => {
  const result1 = applyComposerEdit({
    value: "한글",
    cursorOffset: 2,
    input: "",
    key: { leftArrow: true },
    allowLineBreaks: false,
  });
  assert.equal(
    result1.nextCursorOffset,
    1,
    "left arrow moves cursor back by one grapheme",
  );
  assert.equal(result1.nextValue, "한글");

  const result2 = applyComposerEdit({
    value: "한글",
    cursorOffset: 1,
    input: "",
    key: { rightArrow: true },
    allowLineBreaks: false,
  });
  assert.equal(
    result2.nextCursorOffset,
    2,
    "right arrow moves cursor forward by one grapheme",
  );

  const result3 = applyComposerEdit({
    value: "한글 테스트",
    cursorOffset: 3,
    input: "",
    key: { backspace: true },
    allowLineBreaks: false,
  });
  assert.equal(
    result3.nextValue,
    "한글테스트",
    "backspace deletes one character at cursor",
  );
  assert.equal(result3.nextCursorOffset, 2);
});

test("applyComposerEdit inserts mixed-width characters at cursor", () => {
  const result = applyComposerEdit({
    value: "한a",
    cursorOffset: 1,
    input: "글",
    key: {},
    allowLineBreaks: false,
  });
  assert.equal(result.nextValue, "한글a");
  assert.equal(result.nextCursorOffset, 2);
});

test("applyComposerEdit handles emoji input", () => {
  const result = applyComposerEdit({
    value: "hello",
    cursorOffset: 5,
    input: "🙂",
    key: {},
    allowLineBreaks: false,
  });
  assert.equal(result.nextValue, "hello🙂");
  assert.equal(result.nextCursorOffset, 7, "emoji is 2 UTF-16 code units");
});

// ── Display width seam contract ────────────────────────────────────

test("getDisplayWidth counts CJK characters as 2 columns", () => {
  assert.equal(getDisplayWidth("한글"), 4);
  assert.equal(getDisplayWidth("abc"), 3);
  assert.equal(getDisplayWidth("한a글"), 5);
  assert.equal(getDisplayWidth("🙂"), 2);
  assert.equal(getDisplayWidth("a🙂b"), 4);
  assert.equal(getDisplayWidth(""), 0);
});

test("sliceByDisplayWidth slices mixed-width strings correctly", () => {
  assert.equal(sliceByDisplayWidth("한글abc", 4), "한글");
  assert.equal(sliceByDisplayWidth("한글abc", 5), "한글a");
  assert.equal(sliceByDisplayWidth("한글abc", 3), "한");
  assert.equal(sliceByDisplayWidth("abc한글", 5), "abc한");
  assert.equal(sliceByDisplayWidth("🙂abc", 2), "🙂");
  assert.equal(sliceByDisplayWidth("🙂abc", 3), "🙂a");
});

test("truncateForDisplayWidth adds ellipsis at the right display column", () => {
  assert.equal(truncateForDisplayWidth("한글 테스트", 8), "한글 테…");
  assert.equal(truncateForDisplayWidth("abc", 10), "abc");
  assert.equal(truncateForDisplayWidth("abcdef", 5), "abcd…");
});

// ── Auth panels owner seam ────────────────────────────────────────

test("work-shell-auth-panels.ts owns auth panel helpers as a dedicated module", () => {
  const authPanelsSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-auth-panels.ts"),
    "utf8",
  );
  assert.match(authPanelsSource, /export function formatAuthLabelForDisplay\(/);
  assert.match(
    authPanelsSource,
    /export function refineAuthStatusPanelLines\(/,
  );
  assert.match(
    authPanelsSource,
    /export function buildDefaultAuthLauncherLines\(/,
  );
});
