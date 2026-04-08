import assert from "node:assert/strict";
import test from "node:test";

import {
  Composer,
  WorkShellPane,
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
  createWorkShellDashboardHomePatch,
  createWorkShellDashboardHomeSyncState,
  cycleWorkShellSlashSelection,
  formatAgentTraceLine,
  formatAttachmentBadgeLine,
  formatAuthLabelForDisplay,
  formatInlineImageSupportLine,
  formatRuntimeLabel,
  formatToolTraceLine,
  formatWorkShellError,
  formatWorkShellProviderTitle,
  formatWorkShellStatusLine,
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
  parseWorkShellPanelFactLine,
  refineInlineCommandPanelLines,
  renderEmbeddedWorkShellPaneDashboard,
  resolveWorkShellActivePanel,
  resolveWorkShellInputAction,
  resolveWorkShellSubmitAction,
  useWorkShellDashboardHomeSync,
  useWorkShellInputController,
  useWorkShellPaneState,
  useWorkShellSlashState,
} from "../../packages/tui/src/index.tsx";

test("formatWorkShellProviderTitle humanizes known providers for the unified work tab", () => {
  assert.equal(
    formatWorkShellProviderTitle("openai-api"),
    "UncleCode · OpenAI API",
  );
  assert.equal(
    formatWorkShellProviderTitle("openai-codex"),
    "UncleCode · OpenAI Codex",
  );
  assert.equal(
    formatWorkShellProviderTitle("openai"),
    "UncleCode · OpenAI API",
  );
  assert.equal(formatWorkShellProviderTitle("gemini"), "UncleCode · Gemini");
  assert.equal(
    formatWorkShellProviderTitle("anthropic"),
    "UncleCode · Anthropic",
  );
});

test("getWorkShellEntryPresentation keeps user, assistant, tool, and system roles visually distinct", () => {
  assert.deepEqual(getWorkShellEntryPresentation("user"), {
    label: "Request",
    badge: "◉",
    labelColor: "cyan",
    borderColor: "cyan",
    bodyColor: "white",
  });
  assert.deepEqual(getWorkShellEntryPresentation("assistant"), {
    label: "Answer",
    badge: "✦",
    labelColor: "green",
    borderColor: "green",
    bodyColor: "white",
  });
  assert.deepEqual(getWorkShellEntryPresentation("tool"), {
    label: "Step",
    badge: "→",
    labelColor: "magenta",
    borderColor: "magenta",
    bodyColor: "white",
  });
  assert.deepEqual(getWorkShellEntryPresentation("system"), {
    label: "Status",
    badge: "·",
    labelColor: "gray",
    borderColor: "gray",
    bodyColor: "gray",
  });
  assert.equal(getWorkShellEntryBorderStyle("user"), "round");
  assert.equal(getWorkShellEntryBorderStyle("assistant"), "round");
  assert.equal(getWorkShellEntryBorderStyle("tool"), "single");
  assert.equal(getWorkShellEntryBorderStyle("system"), "single");
  assert.equal(
    getWorkShellEmptyConversationHint(),
    "Start typing. /auth shows sign-in routes.",
  );
});

test("getWorkShellComposerHint keeps slash discovery guidance inside the shared work presenter seam", () => {
  assert.equal(getWorkShellComposerHint("/auth", 2), "↑↓ · Tab · Enter");
  assert.equal(getWorkShellComposerHint("/unknown", 0), "No slash yet.");
  assert.equal(getWorkShellComposerHint("plain text", 3), undefined);
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
    "side",
  );
  assert.equal(
    getWorkShellPanelPlacement({
      panelTitle: "Models",
      inputValue: "/model",
      terminalColumns: 180,
    }),
    "side",
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
    8,
  );
  assert.equal(
    getWorkShellBottomDrawerMinHeight("bottom", "Models", "/model"),
    8,
  );
  assert.equal(
    getWorkShellBottomDrawerMinHeight("bottom", "Session status", "plain text"),
    8,
  );
  assert.equal(
    getWorkShellBottomDrawerMinHeight("bottom", "Doctor", "plain text"),
    8,
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
    resolveWorkShellSubmitAction({
      value: "ship it",
      isBusy: false,
      shouldBlockSlashSubmit: false,
    }),
    { type: "submit", line: "ship it", clearInput: true },
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
    formatWorkShellStatusLine({
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
    }),
    "gpt-5.4 · medium · default · OAuth file",
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
