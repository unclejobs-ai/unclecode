import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  Composer,
  WORK_SHELL_SPINNER_INTERVAL_MS,
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
  extractAuthLabel,
  formatAgentTraceLine,
  formatAttachmentBadgeLine,
  formatAttachmentErrorLine,
  formatAuthLabelForDisplay,
  formatContextTurnReceiptLine,
  formatInlineImageSupportLine,
  formatRuntimeLabel,
  formatToolTraceLine,
  formatWorkShellAssistantDisplayText,
  formatWorkShellBusyStatusLine,
  formatWorkShellConversationEntryLines,
  formatWorkShellError,
  formatWorkShellFooterLine,
  formatWorkShellHeaderLine,
  formatWorkShellOverlayPanelLines,
  formatWorkShellProviderTitle,
  formatWorkShellStatusLine,
  formatWorkShellThinkingLine,
  formatWorkShellToolEntryLines,
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
  getWorkShellThinkingDetailLines,
  isWorkShellToolErrorEntry,
  isWorkShellWarningLine,
  normalizeMarkdownDisplayText,
  parseWorkShellPanelFactLine,
  refineInlineCommandPanelLines,
  renderEmbeddedWorkShellPaneDashboard,
  resolveComposerCursorOffsetAfterValueChange,
  resolveWorkShellActivePanel,
  resolveWorkShellActiveSlashInput,
  resolveWorkShellComposerHint,
  resolveWorkShellInputAction,
  resolveWorkShellSubmitAction,
  shouldHideWorkShellOverlayForInput,
  shouldReportWorkShellOverlayOpen,
  shouldShowWorkShellConversationEntry,
  shouldUseSlowComposerPreview,
  sliceByDisplayWidth,
  splitWorkShellToolEntry,
  truncateForDisplayWidth,
  useWorkShellDashboardHomeSync,
  useWorkShellInputController,
  useWorkShellPaneState,
  useWorkShellSlashState,
} from "../../packages/tui/src/index.tsx";

import { formatWorkShellToolDetailEntry } from "../../packages/orchestrator/src/work-shell-engine-trace.ts";

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
  assert.doesNotMatch(viewSource, /Ctrl\+O context/);
  assert.doesNotMatch(viewSource, /Ctrl\+O sessions/);
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
  assert.match(hooksSource, /setMode\(mode: string\): void \| Promise<void>/);
  assert.doesNotMatch(
    hooksSource,
    /handleSubmit\(`\/mode set \$\{nextMode\}`\)/,
  );
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

test("TUI exports the read-only context turn receipt formatter", () => {
  const line = formatContextTurnReceiptLine({
    id: "receipt-1",
    projectId: "project-1",
    sessionId: "session-1",
    turnId: "turn-1",
    packetId: "crp-b203",
    state: "submitted",
    profile: "build",
    tokenEstimate: undefined,
    tokenEstimateState: "unknown",
    sourceCount: 1,
    sourceRefs: [
      {
        sourceId: "rules",
        category: "workspace-guidance",
        salience: 1,
        includedInModel: true,
      },
    ],
    createdAt: "2026-07-13T00:00:00.000Z",
  });

  // Compact proof (Task 14): the label is gone, a zero `held` and an unknown
  // token estimate are omitted — the values themselves still travel for the
  // same inputs the long form used to pin.
  assert.equal(line, "▤ 1 sent");

  // Segment omission rules: `held` survives when sources are held back, and a
  // known estimate keeps its `~Xk tok` segment.
  const held = formatContextTurnReceiptLine({
    id: "receipt-held",
    projectId: "project-1",
    sessionId: "session-1",
    turnId: "turn-2",
    packetId: "crp-held",
    state: "submitted",
    profile: "build",
    tokenEstimate: 24_000,
    tokenEstimateState: "estimated",
    sourceCount: 3,
    sourceRefs: [
      {
        sourceId: "rules",
        category: "workspace-guidance",
        salience: 1,
        includedInModel: true,
      },
      {
        sourceId: "memory-1",
        category: "memory",
        salience: 0.8,
        includedInModel: true,
      },
      {
        sourceId: "held-1",
        category: "loop-trail",
        salience: 0.4,
        includedInModel: false,
      },
    ],
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  assert.equal(held, "▤ 2 sent · 1 held · ~24k tok");
});

test("formatWorkShellProviderTitle humanizes known providers for the unified work tab", () => {
  assert.equal(formatWorkShellProviderTitle("openai"), "UncleCode · OpenAI");
  assert.equal(formatWorkShellProviderTitle("gemini"), "UncleCode · Gemini");
  assert.equal(
    formatWorkShellProviderTitle("anthropic"),
    "UncleCode · Anthropic",
  );
});

test("formatWorkShellHeaderLine renders one width-bounded row", () => {
  const wide = formatWorkShellHeaderLine({
    providerTitle: "UncleCode · OpenAI",
    headerHint: "work context · Ctrl+O tools · / commands",
    terminalColumns: 120,
  });
  assert.equal(getDisplayWidth(wide), 116);
  assert.match(wide, /^UncleCode · OpenAI/);
  assert.match(wide, /work context/);
  assert.match(wide, /Ctrl\+O tools/);
  assert.doesNotMatch(wide, /\n/);

  const narrow = formatWorkShellHeaderLine({
    providerTitle: "UncleCode · OpenAI",
    headerHint: "work context · Ctrl+O tools · / commands",
    terminalColumns: 36,
  });
  assert.equal(getDisplayWidth(narrow), 32);
  assert.doesNotMatch(narrow, /\n/);
});

test("formatWorkShellHeaderLine keeps header hints within the row width", () => {
  const line = formatWorkShellHeaderLine({
    providerTitle: "UncleCode · Gemini",
    headerHint: "work context · Ctrl+O tools · / commands",
    terminalColumns: 72,
  });
  assert.equal(getDisplayWidth(line), 68);
  assert.match(line, /UncleCode · Gemini/);
  assert.doesNotMatch(line, /\n/);
});

test("getWorkShellEntryPresentation keeps user, assistant, tool, and system roles visually distinct", () => {
  assert.deepEqual(getWorkShellEntryPresentation("user"), {
    label: "You",
    badge: "◇",
    labelColor: "#0a3069",
    labelTextColor: "#0d1117",
    labelBackgroundColor: "#ddf4ff",
    railColor: "#0d1117",
    borderColor: "#30363d",
    bodyColor: "#0d1117",
  });
  assert.deepEqual(getWorkShellEntryPresentation("assistant"), {
    label: "UncleCode",
    badge: "◈",
    labelColor: "#0d1117",
    labelTextColor: "#0d1117",
    labelBackgroundColor: "#dafbe1",
    railColor: "#0a3069",
    borderColor: "#30363d",
    bodyColor: "#0d1117",
  });
  assert.deepEqual(getWorkShellEntryPresentation("tool"), {
    label: "Trace · execution",
    badge: "▸",
    labelColor: "#033a16",
    railColor: "#475569",
    borderColor: "#30363d",
    bodyColor: "#0d1117",
  });
  // Tool detail presentation (additive, tool role only — the presentation
  // object above is unchanged): multi-row tool entries assemble glyph-less and
  // the renderer owns the glyphs and the outcome color. Pinned here so the
  // tool role's presentation policy cannot drift away from its contract.
  const toolDetailSuccess = formatWorkShellToolDetailEntry({
    type: "tool.completed",
    toolName: "read_file",
    input: { path: "src/index.ts" },
    isError: false,
    output: "export function main() {\n  return 42;\n}\n",
    durationMs: 12,
  });
  const toolDetailError = formatWorkShellToolDetailEntry({
    type: "tool.completed",
    toolName: "run_shell",
    input: { command: "npm test" },
    isError: true,
    output: "Error: ENOENT no such file or directory\n    at run (node:1)\n",
    durationMs: 8,
  });
  assert.ok(
    !toolDetailSuccess.includes("●") && !toolDetailSuccess.includes("⎿"),
    "stored tool detail text must stay glyph-less; the renderer owns ● and ⎿",
  );
  assert.ok(!toolDetailError.includes("●") && !toolDetailError.includes("⎿"));
  assert.equal(
    isWorkShellToolErrorEntry(toolDetailSuccess),
    false,
    "a successful call reads green: its first metric row is a success shape",
  );
  assert.equal(
    isWorkShellToolErrorEntry(toolDetailError),
    true,
    "a failed call reads red: its first metric row is the raw first error line",
  );
  assert.deepEqual(splitWorkShellToolEntry(toolDetailSuccess, 100), {
    call: "read src/index.ts",
    resultLines: [
      "3 lines · 12ms",
      "export function main() {",
      "  return 42;",
      "}",
    ],
  });
  assert.deepEqual(getWorkShellEntryPresentation("system"), {
    label: "System · state",
    badge: "·",
    labelColor: "#475569",
    railColor: "#475569",
    borderColor: "#30363d",
    bodyColor: "#0d1117",
  });
  assert.equal(getWorkShellEntryBorderStyle("user"), "single");
  assert.equal(getWorkShellEntryBorderStyle("assistant"), "single");
  assert.equal(getWorkShellEntryBorderStyle("tool"), "single");
  assert.equal(getWorkShellEntryBorderStyle("system"), "single");
  assert.equal(
    getWorkShellEmptyConversationHint(),
    "Type a task, /context to see what gets sent, @file to attach.",
  );
});

test("formatWorkShellToolDetailEntry assembles capped glyph-less rows that survive the transcript filter", () => {
  // Verb row: TS verb constant + the display input's key argument
  // (path > command > query), no glyph — the renderer owns those.
  const detail = formatWorkShellToolDetailEntry({
    type: "tool.completed",
    toolName: "run_shell",
    toolCallId: "call-pin",
    input: { command: "cargo test -p unclecode-core", query: "ignored" },
    isError: false,
    output: "running 3 tests\ntest a ... ok\ntest b ... ok\ntest c ... ok",
    startedAt: 1,
    completedAt: 1201,
    durationMs: 1200,
  });
  assert.equal(detail.split("\n")[0], "bash cargo test -p unclecode-core");
  assert.equal(detail.split("\n")[1], "4 lines · 1200ms");

  // Hard cap: 8 rows including exactly one overflow ellipsis row.
  const overflowing = formatWorkShellToolDetailEntry({
    type: "tool.completed",
    toolName: "read_file",
    toolCallId: "call-pin-long",
    input: { path: "big.txt" },
    isError: false,
    output: `@@ -1 +1 @@\n-a\n${Array.from({ length: 20 }, (_, index) => `+line-${index}`).join("\n")}\n`,
    durationMs: 5,
  });
  const overflowingRows = overflowing.split("\n");
  assert.equal(overflowingRows.length, 8);
  assert.equal(
    overflowingRows.filter((row) => row.startsWith("… +")).length,
    1,
  );
  assert.equal(overflowingRows.at(-1), "… +2 more lines");

  // The stored rows pass the transcript kill filter — the hidden-trace pins
  // elsewhere in this contract still hold for the old one-liners.
  assert.equal(
    shouldShowWorkShellConversationEntry({ role: "tool", text: detail }),
    true,
  );
  assert.equal(
    shouldShowWorkShellConversationEntry({
      role: "tool",
      text: "→ read package.json",
    }),
    false,
  );

  // The render-side splitter never stacks a second ellipsis on the assembly's.
  const split = splitWorkShellToolEntry(overflowing, 100);
  assert.equal(
    split.resultLines.filter((row) => row.startsWith("… +")).length,
    1,
  );
});

test("refined non-orange work context avoids loud orange chrome", () => {
  const roles = ["user", "assistant", "tool", "system"];
  const paletteValues = roles.flatMap((role) =>
    Object.values(getWorkShellEntryPresentation(role)).filter(
      (value) => typeof value === "string" && value.startsWith("#"),
    ),
  );

  assert.doesNotMatch(paletteValues.join(" "), /#fb923c|#fdba74|#fed7aa/i);
  assert.match(paletteValues.join(" "), /#0a3069|#0d1117|#033a16/i);

  const renderedUser = formatWorkShellConversationEntryLines({
    role: "user",
    text: "/model gpt-5.5",
    width: 80,
  }).join("\n");
  assert.match(renderedUser, /You/);
  assert.doesNotMatch(renderedUser, /packet|next-call/i);
});

test("work shell palette stays readable on light terminal backgrounds", () => {
  const roles = ["user", "assistant", "tool", "system"];
  const foregroundFields = [
    "labelColor",
    "labelTextColor",
    "railColor",
    "borderColor",
    "bodyColor",
  ];

  for (const role of roles) {
    const presentation = getWorkShellEntryPresentation(role);
    for (const field of foregroundFields) {
      const color = presentation[field];
      if (typeof color === "string") {
        assert.ok(
          contrastRatio(color, "#ffffff") >= 7,
          `${role}.${field} ${color} should be strongly readable on a white terminal background`,
        );
      }
    }
    if (presentation.labelBackgroundColor && presentation.labelTextColor) {
      assert.ok(
        contrastRatio(
          presentation.labelTextColor,
          presentation.labelBackgroundColor,
        ) >= 4.5,
        `${role} badge text should be readable on its badge background`,
      );
    }
  }
});

test("assistant transcript hides internal action plans and collapses duplicate greeting streams", () => {
  const leakedPlanAndDuplicateGreeting = `[
    {
      "id": "greet-user",
      "summary": "Respond to the user's greeting.",
      "prompt": "Reply warmly and briefly to the user's message: \\"hi\\"."
    },
    {
      "id": "offer-help",
      "summary": "Invite the user to provide a task or question.",
      "prompt": "Ask the user what they would like help with next, keeping the response concise."
    }
  ]Hi! What would you like help withHi! What can next? I help you with today?`;

  const displayText = formatWorkShellAssistantDisplayText(
    leakedPlanAndDuplicateGreeting,
  );

  assert.equal(displayText, "Hi! What would you like help with?");
  assert.doesNotMatch(displayText, /"id"|"summary"|"prompt"|^\[/);

  const rendered = formatWorkShellConversationEntryLines({
    role: "assistant",
    text: leakedPlanAndDuplicateGreeting,
    width: 80,
  }).join("\n");
  assert.match(rendered, /UncleCode/);
  assert.doesNotMatch(rendered, /context steward|context-aware reply/i);
  assert.match(rendered, /Hi! What would you like help with\?/);
  assert.doesNotMatch(rendered, /greet-user|offer-help|"prompt"|^\s*\[/m);
});

test("assistant display keeps code and removes obvious duplicate multilingual tails", () => {
  const mixedDuplicate = `핵심은 handoff_contexts로 좁히는 겁니다. ಈಗ 구체적으로 보면:

\`\`\`sql
create table handoff_contexts (
  id text primary key
);
\`\`\`

결론

Runbook은 일반 메모리가 아니라 작업 인계 컨텍스트만 가져야 합니다.

Yes — add a dedicated context table, but I’d name it handoff_contexts, not generic contexts.

That keeps Runbook aligned with its boundary: a local-first AgentOps operational DB, not a general memory backend.`;

  const displayText = formatWorkShellAssistantDisplayText(mixedDuplicate);
  const normalized = normalizeMarkdownDisplayText(displayText);

  assert.match(displayText, /핵심은 handoff_contexts/);
  assert.doesNotMatch(displayText, /ಈಗ/);
  assert.doesNotMatch(displayText, /Yes — add a dedicated context table/);
  assert.match(normalized, /create table handoff_contexts/);
  assert.match(normalized, /id text primary key/);
});

test("getWorkShellComposerHint keeps slash discovery guidance inside the shared work presenter seam", () => {
  assert.equal(
    getWorkShellComposerHint("/auth", 2),
    "↑↓ select · Enter run · Esc cancel",
  );
  assert.equal(
    getWorkShellComposerHint("/model", 3, "/model"),
    "↑↓ choose · Enter switch · type to filter · Esc cancel · args: <model-id>",
  );
  assert.equal(
    getWorkShellComposerHint("/unknown", 0),
    "No matches · try /model, /auth, /context, /queue",
  );
  // The empty composer is the only surface that advertises slash discovery.
  // Pre-redesign it carried `/ commands` alongside the paste affordance; the
  // redesign dropped the discovery half and kept only `Ctrl+V image`. A typed
  // draft keeps the shorter help below.
  assert.equal(
    getWorkShellComposerHint("", 0),
    "Enter send · Shift+Enter newline · / commands · Ctrl+V image",
  );
  assert.equal(
    getWorkShellComposerHint("plain text", 3),
    "Enter send · Shift+Enter newline · Ctrl+V image",
  );
  assert.equal(getWorkShellComposerHintMinHeight(), 1);
});

test("resolveWorkShellComposerHint and spinner interval stay aligned with the quiet-workspace workflow states", () => {
  assert.equal(WORK_SHELL_SPINNER_INTERVAL_MS, 100);
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: true,
      inputValue: "plain text",
      slashSuggestionCount: 0,
    }),
    "Queue a follow-up... · Enter queue · Esc interrupt · /queue",
  );
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: false,
      queuePaused: true,
      queuedCount: 1,
      inputValue: "",
      slashSuggestionCount: 0,
    }),
    "Queue paused after interrupt · check /queue · /queue clear drops",
  );
  assert.equal(
    resolveWorkShellComposerHint({
      composerHintOverride: "Enter saves · Esc cancels",
      isBusy: true,
      inputValue: "",
      slashSuggestionCount: 0,
    }),
    "Enter saves · Esc cancels",
  );
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
  // Context Inspector redesign: the overlay cohabits with the composer.
  // Typing does NOT hide the overlay — only Esc or /context toggle does.
  assert.equal(
    shouldHideWorkShellOverlayForInput({
      panelTitle: "Context expanded",
      inputValue: "plain text",
    }),
    false,
  );
  assert.equal(
    shouldHideWorkShellOverlayForInput({
      panelTitle: "Context expanded",
      inputValue: "",
    }),
    false,
  );
  assert.equal(
    shouldReportWorkShellOverlayOpen({
      panelTitle: "Context expanded",
      inputValue: "plain text",
    }),
    false,
    "hidden context overlays must not steal Esc from composer input",
  );
  assert.equal(
    shouldReportWorkShellOverlayOpen({
      panelTitle: "Context expanded",
      inputValue: "",
    }),
    true,
  );
  assert.equal(
    shouldReportWorkShellOverlayOpen({
      panelTitle: "Model picker",
      inputValue: "/model",
    }),
    false,
  );
  // Context Inspector redesign: the overlay no longer truncates at 12 lines.
  // All 14 lines pass through unchanged. Scrolling (Sprint 1C) handles tall lists.
  assert.deepEqual(
    formatWorkShellOverlayPanelLines({
      panelTitle: "Context expanded",
      lines: Array.from(
        { length: 14 },
        (_, index) => `context line ${index + 1}`,
      ),
    }),
    Array.from({ length: 14 }, (_, index) => `context line ${index + 1}`),
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
      input: "/context",
      suggestions: [
        { command: "/context", description: "Show next-answer context." },
      ],
      selectedIndex: 0,
      fallbackPanel: {
        title: "Context expanded",
        lines: ["Sources · 2 included · 1 held back · 0 warnings"],
      },
    }).title,
    "Context expanded",
  );
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
  assert.match(noMatchPanel.lines.join("\n"), /No matches for \/zz\./);
  const noModelMatchPanel = resolveWorkShellActivePanel({
    input: "/model gkdl",
    suggestions: [
      {
        command: "/model list",
        description: "List available models and reasoning support.",
      },
    ],
    selectedIndex: 0,
    currentModel: "gpt-5.4",
    fallbackPanel: {
      title: "Context",
      lines: ["Loaded guidance: AGENTS.md"],
    },
  });
  assert.equal(noModelMatchPanel.title, "Model picker");
  assert.match(noModelMatchPanel.lines.join("\n"), /Model · gpt-5\.4/);
  assert.match(noModelMatchPanel.lines.join("\n"), /Current model unchanged/);
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

test("work-shell slash selection navigation stays local for responsive picker movement", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-panels.ts"),
    "utf8",
  );

  assert.equal(clampWorkShellSlashSelection(8, 3), 2);
  assert.equal(cycleWorkShellSlashSelection(0, 3, "previous"), 2);
  assert.equal(cycleWorkShellSlashSelection(2, 3, "next"), 0);
  assert.doesNotMatch(source, /"rust",\s*"ux",\s*"slash-selection"/);
});

test("work-shell clipboard attachment cap decisions are delegated to Rust", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-hooks.ts"),
    "utf8",
  );

  assert.match(source, /"rust",\s*"ux",\s*"clipboard-cap"/);
  assert.doesNotMatch(source, /clipboard attachment cap reached/);
  assert.doesNotMatch(source, /image too large/);
});

test("work-shell attachment dedup decisions are delegated to Rust", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-hooks.ts"),
    "utf8",
  );

  assert.match(source, /"rust",\s*"ux",\s*"attachment-dedup"/);
  assert.doesNotMatch(source, /new Set<string>/);
  assert.doesNotMatch(source, /seen\.has/);
});

test("work-shell composer preview mode decisions stay local for keystroke latency", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-hooks.ts"),
    "utf8",
  );

  assert.equal(shouldUseSlowComposerPreview("plain text"), false);
  assert.equal(shouldUseSlowComposerPreview("@README.md 요약"), true);
  assert.equal(shouldUseSlowComposerPreview("attach screenshot.PNG"), true);
  assert.doesNotMatch(source, /"rust",\s*"ux",\s*"composer-preview-mode"/);
});

test("work-shell composer dock chrome decisions stay local for keystroke latency", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-view.tsx"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /"rust",\s*"ux",\s*"text",\s*"composer-dock-layout"/,
  );
  assert.match(source, /input\.inputValue\.trimStart\(\)\.startsWith\("\/"\)/);
  assert.match(
    source,
    /input\.attachmentCount !== undefined && input\.attachmentCount >= 5/,
  );
});

test("work-shell composer row budget wraps without a sync Rust spawn on keystrokes", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-view.tsx"),
    "utf8",
  );

  // Scope to the function body: the view keeps the Rust wrap for settled
  // transcript rows, but the composer row budget runs on every keystroke and
  // must use the pure-TS wrap only.
  const functionStart = source.indexOf(
    "export function resolveWorkShellComposerAdditionalRows",
  );
  assert.ok(
    functionStart >= 0,
    "resolveWorkShellComposerAdditionalRows must stay exported from the view",
  );
  // Skip past the parameter object literal so brace counting starts at the
  // function body, not the closing `}` of the `input: { ... }` type.
  const signatureEnd = source.indexOf("):", functionStart);
  assert.ok(
    signatureEnd > functionStart,
    "could not find the composer row budget signature end",
  );
  const bodyStart = source.indexOf("{", signatureEnd);
  let depth = 0;
  let functionEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        functionEnd = index;
        break;
      }
    }
  }
  assert.ok(
    functionEnd > bodyStart,
    "could not isolate the composer row budget function body",
  );
  const functionBody = source.slice(functionStart, functionEnd);

  assert.match(
    functionBody,
    /wrapDisplayTextFast\(/,
    "the composer row budget must wrap with the pure-TS fast wrap",
  );
  assert.doesNotMatch(
    functionBody,
    /wrapDisplayText\(/,
    "the composer row budget must not call the sync Rust wrap (wrapDisplayText spawns per call)",
  );
  assert.doesNotMatch(
    functionBody,
    /runRustCommandSync|wrap-display/,
    "no sync Rust process spawn may live on the keystroke path",
  );
});

test("work-shell slash render chrome avoids sync Rust helpers on first picker paint", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-view.tsx"),
    "utf8",
  );

  assert.doesNotMatch(source, /"panel-line-class"/);
  assert.doesNotMatch(source, /"panel-layout"/);
  assert.doesNotMatch(source, /"footer-line"/);
});

test("work-shell pane runtime prewarms slash suggestions before the first slash keypress", () => {
  const source = readFileSync(
    path.join(
      workspaceRoot,
      "packages/orchestrator/src/work-shell-pane-runtime.ts",
    ),
    "utf8",
  );

  assert.match(source, /getWorkShellSlashSuggestions\("\/"/);
});

test("work-shell auth label display is delegated to Rust", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-auth-panels.ts"),
    "utf8",
  );

  assert.match(source, /"rust",\s*"ux",\s*"auth-label"/);
  assert.equal(source.includes('authLabel === "oauth-file"'), false);
  assert.equal(source.includes('"Browser OAuth · file"'), false);
  assert.equal(source.includes('"API key · env"'), false);
});

test("work-shell auth label extraction is delegated to Rust", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-auth-panels.ts"),
    "utf8",
  );

  assert.equal(extractAuthLabel(["Auth source: oauth-file"]), "oauth-file");
  assert.match(source, /"rust",\s*"ux",\s*"auth-extract-label"/);
  assert.equal(source.includes("?:Auth|Source"), false);
  assert.equal(source.includes(".exec(line.trim())"), false);
});

test("work-shell auth launcher copy is delegated to Rust", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-auth-panels.ts"),
    "utf8",
  );

  assert.match(source, /"rust",\s*"ux",\s*"auth-launcher-lines"/);
  assert.equal(source.includes("formatAuthRouteLabel"), false);
  assert.equal(source.includes("getPreferredAuthRoute"), false);
  assert.equal(source.includes("formatAuthStatusBlurb"), false);
  assert.equal(source.includes("buildAuthLauncherNextLines"), false);
});

test("work-shell auth status panel copy is delegated to Rust", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-auth-panels.ts"),
    "utf8",
  );

  assert.match(source, /"rust",\s*"ux",\s*"auth-status-panel-lines"/);
  assert.equal(source.includes("parseAuthStatusLine"), false);
  assert.equal(
    source.includes("OAuth token lacks model.request scope."),
    false,
  );
  assert.equal(source.includes("Browser OAuth needs refresh."), false);
  assert.equal(source.includes("API key active."), false);
});

test("work-shell browser auth failure copy is delegated to Rust", () => {
  const authSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-auth-panels.ts"),
    "utf8",
  );
  const panelSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-panels.ts"),
    "utf8",
  );

  assert.match(authSource, /"rust",\s*"ux",\s*"auth-browser-failure-lines"/);
  assert.equal(panelSource.includes("isMissingOAuthClientId"), false);
  assert.equal(panelSource.includes("authLabel.startsWith"), false);
  assert.equal(
    panelSource.includes("Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID."),
    false,
  );
  assert.equal(
    panelSource.includes("Set OPENAI_OAUTH_CLIENT_ID for browser login."),
    false,
  );
});

test("work-shell no-match slash copy is local because it renders on each slash keypress", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-panels.ts"),
    "utf8",
  );

  assert.equal(source.includes("No slash yet."), false);
  assert.equal(source.includes("Try /model, /auth, /doctor, /context."), false);
  assert.equal(source.includes("No matches for"), true);
  assert.deepEqual(buildSlashSuggestionPanel("/zz", [], 0).lines, [
    "No matches for /zz.",
    "",
    "Try /model <id>, /auth status, /queue, or /context.",
  ]);
});

test("work-shell runtime labels are delegated to Rust", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-formatters.ts"),
    "utf8",
  );

  assert.match(source, /"rust",\s*"ux",\s*"text",\s*"runtime-label"/);
  assert.equal(source.includes("`Node ${runtime.node}"), false);
});

test("work-shell input decision helpers are exported from the shared tui package seam", () => {
  assert.equal(
    resolveWorkShellActiveSlashInput({
      value: "",
      fallbackPanelTitle: "Model picker",
      fallbackPanelDismissed: true,
    }),
    undefined,
  );
  assert.equal(
    resolveWorkShellActiveSlashInput({
      value: "/model",
      fallbackPanelTitle: "Model picker",
      fallbackPanelDismissed: true,
    }),
    "/model",
  );
  assert.equal(
    resolveWorkShellActiveSlashInput({
      value: "",
      fallbackPanelTitle: "Model picker",
    }),
    "/model",
  );
  assert.equal(
    resolveWorkShellActiveSlashInput({
      value: "gpt-5",
      fallbackPanelTitle: "Model picker",
    }),
    "/model gpt-5",
  );
  assert.equal(
    resolveWorkShellActiveSlashInput({
      value: "/auth",
      fallbackPanelTitle: "Context",
    }),
    "/auth",
  );
  assert.equal(
    resolveWorkShellActiveSlashInput({
      value: "plain",
      fallbackPanelTitle: "Context",
    }),
    undefined,
  );
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
      key: { downArrow: true },
      input: "/model",
      slashSuggestionCount: 8,
      isBusy: false,
      hasRequestSessionsView: true,
      hasSlashPicker: true,
    }),
    { type: "move-slash-selection", direction: "next" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "/model",
      slashSuggestionCount: 8,
      isBusy: false,
      hasRequestSessionsView: true,
      hasSlashPicker: true,
    }),
    { type: "close-slash-picker" },
  );
  assert.deepEqual(
    resolveWorkShellSubmitAction({
      value: "/model g",
      isBusy: false,
      shouldBlockSlashSubmit: true,
      selectedSlashCommand: "/model gpt-5.5",
      activePanelTitle: "Model picker",
    }),
    { type: "submit-suggestion", line: "/model gpt-5.5", clearInput: true },
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
    { type: "none" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: true,
      escapeResetArmed: true,
    }),
    { type: "clear-input" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: true,
      hasRequestSessionsView: true,
    }),
    { type: "interrupt-turn" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "c",
      key: { ctrl: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: true,
      hasRequestSessionsView: true,
    }),
    { type: "interrupt-turn" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "o",
      key: { ctrl: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: true,
    }),
    { type: "none" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "\u000f",
      key: { ctrl: true },
      input: "IME 초안",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: true,
    }),
    { type: "none" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "o",
      key: { ctrl: true },
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: false,
    }),
    { type: "none" },
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
      input: "plain text",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: false,
    }),
    { type: "none" },
  );
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { escape: true },
      input: "",
      slashSuggestionCount: 0,
      isBusy: false,
      hasRequestSessionsView: false,
    }),
    { type: "open-engine-sessions" },
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
    { type: "submit", line: "/auth", clearInput: true },
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
    { type: "submit", line: "/auth", clearInput: true },
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
    resolveWorkShellSubmitAction({
      value: "gkdl",
      isBusy: false,
      shouldBlockSlashSubmit: false,
      activePanelTitle: "Model picker",
    }),
    { type: "submit", line: "/model gkdl", clearInput: true },
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

  let sessionsOpened = false;
  let syncedHomeState = undefined;
  const element = props.renderWorkPane({
    openSessions() {
      sessionsOpened = true;
    },
    syncHomeState(homeState) {
      syncedHomeState = homeState;
    },
  });
  element.props.onRequestSessionsView();
  element.props.onSyncHomeState({ authLabel: "oauth-file" });

  assert.equal(sessionsOpened, true);
  assert.deepEqual(syncedHomeState, { authLabel: "oauth-file" });
});

test("work-shell panel helpers are exported from the shared tui package seam", () => {
  assert.equal(formatAuthLabelForDisplay("oauth-file"), "Browser OAuth · file");
  assert.equal(
    formatAuthLabelForDisplay("oauth-file-api-blocked"),
    "OAuth file · API blocked",
  );
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
  assert.match(buildWorkShellHelpPanel().lines.join("\n"), /\/harness/);
  const statusPanel = buildWorkShellStatusPanel({
    provider: "openai",
    model: "gpt-5.4",
    mode: "default",
    cwd: "/repo",
    reasoningLabel: "medium (mode-default)",
    authLabel: "api-key-env",
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    bridgeLines: ["project-context bridge ready"],
    memoryLines: ["project memory ready"],
  });
  assert.deepEqual(statusPanel.lines.slice(0, 6), [
    "Current",
    "Provider · openai",
    "Model · gpt-5.4",
    "Reasoning · medium (mode-default)",
    "Mode · default",
    "Auth · API key · env",
  ]);
  assert.ok(statusPanel.lines.includes("Route"));
  assert.ok(
    statusPanel.lines.some((line) =>
      /^Runtime · OpenAI \(openai\) · native$/.test(line),
    ),
  );
  assert.ok(
    statusPanel.lines.includes(
      "Endpoint · https://api.openai.com/v1/responses",
    ),
  );
  assert.ok(statusPanel.lines.some((line) => line.startsWith("Proxy · ")));
  assert.ok(statusPanel.lines.includes("Context"));
  assert.ok(statusPanel.lines.includes("Sources · guidance · bridge · memory"));
  assert.ok(statusPanel.lines.includes("Health · ready"));
  assert.ok(statusPanel.lines.includes("Guide · AGENTS.md"));
  assert.ok(statusPanel.lines.includes("Workspace"));
  assert.ok(statusPanel.lines.includes("Cwd · /repo"));
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
    /✓ read · 5ms/,
  );
  assert.doesNotThrow(
    () =>
      formatToolTraceLine({
        type: "tool.completed",
        level: "default",
        provider: "openai",
        toolName: "search_text",
        toolCallId: "call-2",
        isError: false,
        output: '{"result":"found"}',
        startedAt: 0,
        completedAt: 10,
        durationMs: 10,
      }),
    "tool.completed with JSON-like output does not crash",
  );
  assert.equal(
    formatAgentTraceLine({
      type: "reasoning.delta",
      level: "default",
      provider: "openai",
      model: "gpt-5.4",
      kind: "summary",
      itemId: "rsn_1",
      delta: "thinking",
    }),
    "",
    "generic provider thinking deltas are not useful reasoning content",
  );
  assert.equal(
    formatAgentTraceLine({
      type: "reasoning.delta",
      level: "default",
      provider: "openai",
      model: "gpt-5.4",
      kind: "summary",
      itemId: "rsn_2",
      delta: "inspect repo before editing",
    }),
    "✦ thinking· inspect repo before editing",
  );
  assert.deepEqual(
    formatWorkShellToolEntryLines(
      '✓ read 55ms {\n  "name": "web-app",\n  "private": true\n}',
      72,
    ),
    ["✓ read 55ms {", '  "name": "web-app",', '  "private": true', "}"],
    "tool entries render as compact text lines, not padded surface rows",
  );
  assert.deepEqual(
    formatWorkShellConversationEntryLines({
      role: "user",
      text: "hi",
      width: 72,
    }),
    ["◇ You · hi"],
    "user entries render as compact transcript lines, not full-width input bars",
  );
  assert.deepEqual(
    formatWorkShellConversationEntryLines({
      role: "assistant",
      text: "Hello. What do you need help with?",
      width: 72,
    }),
    ["◈ UncleCode", "   Hello. What do you need help with?"],
    "assistant entries keep a distinct label and readable body with a quiet continuation indent",
  );
  assert.equal(
    shouldShowWorkShellConversationEntry({
      role: "tool",
      text: "→ read package.json",
    }),
    false,
    "tool traces stay out of the default conversation transcript",
  );
  assert.equal(
    shouldShowWorkShellConversationEntry({
      role: "assistant",
      text: "✦ thinking· inspect repo before editing",
    }),
    false,
    "reasoning trace lines stay out of the default conversation transcript",
  );
  assert.equal(
    shouldShowWorkShellConversationEntry({ role: "assistant", text: "Done" }),
    true,
  );
  assert.equal(
    formatRuntimeLabel({ node: "v22", platform: "darwin", arch: "arm64" }),
    "Node v22 · darwin/arm64",
  );
  assert.equal(
    formatWorkShellThinkingLine("medium (mode-default)"),
    "Reasoning · Balanced",
  );
  assert.equal(
    formatWorkShellStatusLine({
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
    }),
    "gpt-5.4 · Work mode · Saved OAuth · work context",
  );
  assert.equal(
    formatWorkShellFooterLine({
      cwd: `${process.env.HOME ?? "/Users/me"}/project/unclecode`,
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
      contextIndicator: "context 2 ready · 1 held back",
      width: 120,
    }),
    "~/project/unclecode  ·  context 2 ready",
  );
  assert.equal(
    formatWorkShellFooterLine({
      cwd: `${process.env.HOME ?? "/Users/me"}/project/unclecode`,
      model: "gpt-5.4",
      reasoningLabel: "high (override)",
      mode: "yolo",
      authLabel: "Browser OAuth · file",
      width: 72,
    }),
    "~/project/unclecode",
  );
  // Footer keeps cwd anchored and one compact context chip; session facts live in the status strip.
  assert.equal(
    formatWorkShellFooterLine({
      cwd: `${process.env.HOME ?? "/Users/me"}/project/unclecode`,
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
      contextIndicator: "context 2 ready · 1 held back",
      width: 96,
    }),
    "~/project/unclecode  ·  context 2 ready",
  );
  assert.equal(
    formatWorkShellFooterLine({
      cwd: `${process.env.HOME ?? "/Users/me"}/project/unclecode`,
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
      contextIndicator: "context 2 ready · 1 held back",
      width: 72,
    }),
    "~/project/unclecode  ·  context 2 ready",
  );
  assert.equal(
    formatWorkShellBusyStatusLine("· thinking inspect repo", 0),
    "⠋ thinking inspect repo",
  );
  assert.deepEqual(
    getWorkShellThinkingDetailLines({
      busyStatus: "thinking",
      spinnerFrame: 0,
    }),
    [],
    "generic thinking status is already represented by the session header",
  );
  assert.deepEqual(
    getWorkShellThinkingDetailLines({
      busyStatus: "thinking inspect repo",
      spinnerFrame: 0,
    }),
    [],
    "specific progress is represented by the single busy status line, not duplicated inside the conversation pane",
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
    "⠋ 1.5s · thinking inspect repo · Ctrl+C/Esc · Enter queues",
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
  assert.equal(
    formatAttachmentErrorLine("Clipboard capture failed"),
    "Warning · Clipboard capture failed",
  );
  assert.equal(
    formatAttachmentErrorLine("   "),
    "Warning · Attachment could not be added.",
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

test("applyComposerEdit appends committed Hangul syllables without replacing previous input", () => {
  const first = applyComposerEdit({
    value: "",
    cursorOffset: 0,
    input: "한",
    key: {},
    allowLineBreaks: false,
  });
  assert.deepEqual(first, {
    nextValue: "한",
    nextCursorOffset: "한".length,
    submitted: false,
  });

  assert.deepEqual(
    applyComposerEdit({
      value: first.nextValue,
      cursorOffset: first.nextCursorOffset,
      input: "글 ",
      key: {},
      allowLineBreaks: false,
    }),
    {
      nextValue: "한글 ",
      nextCursorOffset: "한글 ".length,
      submitted: false,
    },
  );
});

test("applyComposerEdit keeps decomposed Hangul composition on grapheme boundaries", () => {
  const decomposedHangul = "한";

  assert.deepEqual(
    applyComposerEdit({
      value: decomposedHangul,
      cursorOffset: decomposedHangul.length,
      input: "",
      key: { backspace: true },
      allowLineBreaks: false,
    }),
    { nextValue: "", nextCursorOffset: 0, submitted: false },
  );

  assert.deepEqual(
    applyComposerEdit({
      value: `${decomposedHangul}글`,
      cursorOffset: decomposedHangul.length,
      input: "",
      key: { leftArrow: true },
      allowLineBreaks: false,
    }),
    {
      nextValue: `${decomposedHangul}글`,
      nextCursorOffset: 0,
      submitted: false,
    },
  );
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

test("applyComposerEdit keeps emoji cursor movement and deletion on character boundaries", () => {
  assert.deepEqual(
    applyComposerEdit({
      value: "🙂한",
      cursorOffset: 2,
      input: "",
      key: { leftArrow: true },
      allowLineBreaks: false,
    }),
    { nextValue: "🙂한", nextCursorOffset: 0, submitted: false },
  );
  assert.deepEqual(
    applyComposerEdit({
      value: "🙂한",
      cursorOffset: 0,
      input: "",
      key: { rightArrow: true },
      allowLineBreaks: false,
    }),
    { nextValue: "🙂한", nextCursorOffset: 2, submitted: false },
  );
  assert.deepEqual(
    applyComposerEdit({
      value: "🙂한",
      cursorOffset: 2,
      input: "",
      key: { backspace: true },
      allowLineBreaks: false,
    }),
    { nextValue: "한", nextCursorOffset: 0, submitted: false },
  );
  assert.deepEqual(
    applyComposerEdit({
      value: "🙂한",
      cursorOffset: 3,
      input: "",
      key: { delete: true },
      allowLineBreaks: false,
    }),
    { nextValue: "🙂", nextCursorOffset: 2, submitted: false },
  );
});

test("applyComposerEdit treats Ink delete events as terminal Backspace", () => {
  assert.deepEqual(
    applyComposerEdit({
      value: "/u dd ddd",
      cursorOffset: "/u dd ddd".length,
      input: "",
      key: { delete: true },
      allowLineBreaks: true,
    }),
    {
      nextValue: "/u dd dd",
      nextCursorOffset: "/u dd dd".length,
      submitted: false,
    },
  );
});

test("resolveComposerCursorOffsetAfterValueChange moves external replacements to a safe end cursor", () => {
  assert.equal(
    resolveComposerCursorOffsetAfterValueChange({
      nextValue: "/model gpt-5.5 ",
      currentCursorOffset: 3,
    }),
    "/model gpt-5.5 ".length,
  );
  assert.equal(
    resolveComposerCursorOffsetAfterValueChange({
      nextValue: "🙂",
      currentCursorOffset: 1,
    }),
    "🙂".length,
  );
  assert.equal(
    resolveComposerCursorOffsetAfterValueChange({
      nextValue: "a🙂",
      currentCursorOffset: 2,
      pendingLocalValue: "a🙂",
    }),
    1,
  );
});

// ── Display width seam contract ────────────────────────────────────

test("getDisplayWidth counts CJK characters as 2 columns", () => {
  assert.equal(getDisplayWidth("한글"), 4);
  assert.equal(getDisplayWidth("한"), 2);
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

test("WorkShellSectionDivider uses getDisplayWidth for CJK-safe centering (not .length)", () => {
  const viewSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-view.tsx"),
    "utf8",
  );
  // The divider centering must use getDisplayWidth(labelContent), not labelContent.length,
  // so that Korean/CJK double-width labels are centered correctly.
  assert.match(
    viewSource,
    /Math\.floor\(\(width - getDisplayWidth\(labelContent\)\) \/ 2\)/,
  );
  assert.match(
    viewSource,
    /width - getDisplayWidth\(labelContent\) - leftLength/,
  );
  // Must NOT use raw .length for the centering computation
  assert.doesNotMatch(viewSource, /width - labelContent\.length/);
});

test("WorkShell fact separators use readable foreground props", () => {
  const viewSource = readFileSync(
    path.join(workspaceRoot, "packages/tui/src/work-shell-view.tsx"),
    "utf8",
  );
  // The ' · ' separator between label and value in fact rows must pass through
  // the explicit readable foreground resolver, not the dim role, so light Codex terminals
  // do not wash out the text.
  assert.match(
    viewSource,
    /<Text \{\.\.\.readableTextColorProps\(W\.textMuted\)\}> · <\/Text>/,
  );
  assert.doesNotMatch(viewSource, /<Text color=\{W\.textDim\}> · <\/Text>/);
});

function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hexColor) {
  const [red, green, blue] = parseHexColor(hexColor).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function parseHexColor(hexColor) {
  const match = /^#([0-9a-f]{6})$/i.exec(hexColor);
  assert.ok(match, `${hexColor} should be a 6-digit hex color`);
  const value = match[1];
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}
