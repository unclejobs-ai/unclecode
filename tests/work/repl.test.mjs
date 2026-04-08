import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionStore } from "@unclecode/session-store";
import {
  listAvailableSkills,
  loadNamedSkill,
} from "@unclecode/context-broker";
import {
  describeReasoning,
  getWorkShellSlashSuggestions,
  listSessionLines,
  persistWorkShellSessionSnapshot,
  resolveComposerInput,
  resolveModelCommand,
  resolveReasoningCommand,
  resolveWorkShellSlashCommand,
  shouldBlockSlashSubmit,
} from "@unclecode/orchestrator";
import {
  buildAttachmentPreviewLines,
  buildContextPanel,
  buildInlineCommandPanel,
  buildSlashSuggestionPanel,
  buildTerminalInlineImageSequence,
  clampWorkShellSlashSelection,
  createWorkShellDashboardHomePatch,
  createWorkShellDashboardHomeSyncState,
  cycleWorkShellSlashSelection,
  formatAgentTraceLine,
  formatAttachmentBadgeLine,
  formatAuthLabelForDisplay,
  formatInlineImageSupportLine,
  formatInlineCommandResultSummary,
  formatRuntimeLabel,
  formatToolTraceLine,
  formatWorkShellError,
  getWorkShellConversationLayout as getConversationLayout,
  refineInlineCommandPanelLines,
  resolveWorkShellActivePanel,
  resolveWorkShellInputAction,
  resolveWorkShellSubmitAction,
  shouldRefreshDashboardHomeState,
} from "@unclecode/tui";
import {
  createWorkShellDashboardProps,
  resolveWorkShellInlineCommand,
} from "../../apps/unclecode-cli/src/work-runtime.ts";

const supported = {
  effort: "high",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

const unsupported = {
  effort: "unsupported",
  source: "model-capability",
  support: {
    status: "unsupported",
    supportedEfforts: [],
  },
};

test("describeReasoning reports unsupported models honestly", () => {
  assert.equal(describeReasoning(unsupported), "unsupported");
  assert.equal(describeReasoning(supported), "high (mode-default)");
});

test("resolveReasoningCommand applies overrides and mode resets", () => {
  const low = resolveReasoningCommand("/reasoning low", supported, supported);
  assert.equal(low.nextReasoning.effort, "low");
  assert.equal(low.nextReasoning.source, "override");

  const reset = resolveReasoningCommand("/reasoning default", low.nextReasoning, supported);
  assert.equal(reset.nextReasoning.effort, "high");
  assert.equal(reset.nextReasoning.source, "mode-default");
});

test("resolveReasoningCommand keeps unsupported models visible but immutable", () => {
  const result = resolveReasoningCommand("/reasoning high", unsupported, unsupported);

  assert.equal(result.nextReasoning.effort, "unsupported");
  assert.match(result.message, /does not support/i);
});

test("resolveModelCommand lists models and updates reasoning support on switch", () => {
  const listed = resolveModelCommand("/model", {
    provider: "openai",
    currentModel: "gpt-5.4",
    currentReasoning: supported,
    modeDefaultReasoning: supported,
  });

  assert.equal(listed.nextModel, "gpt-5.4");
  assert.equal(listed.panel.title, "Models");
  assert.match(listed.panel.lines.join("\n"), /^Current/m);
  assert.match(listed.panel.lines.join("\n"), /^Available/m);
  assert.match(listed.panel.lines.join("\n"), /^Routes/m);
  assert.match(listed.panel.lines.join("\n"), /\/model gpt-5\.4/);
  assert.match(listed.panel.lines.join("\n"), /\/model gpt-4\.1-mini/);
  assert.match(listed.panel.lines.join("\n"), /Selected · \/model gpt-5\.4/);
  assert.match(listed.panel.lines.join("\n"), /Support · low, medium, high/);
  assert.match(listed.panel.lines.join("\n"), /Warning · reasoning unsupported/);
  assert.match(listed.panel.lines.join("\n"), /Reasoning · high \(mode-default\)/);

  const switched = resolveModelCommand("/model gpt-4.1-mini", {
    provider: "openai",
    currentModel: "gpt-5.4",
    currentReasoning: supported,
    modeDefaultReasoning: supported,
  });

  assert.equal(switched.nextModel, "gpt-4.1-mini");
  assert.equal(switched.nextReasoning.effort, "unsupported");
  assert.match(switched.message, /reasoning unsupported/i);
});

test("formatRuntimeLabel distinguishes Node runtime from platform facts", () => {
  const label = formatRuntimeLabel({
    node: "v22.22.0",
    platform: "darwin",
    arch: "arm64",
  });

  assert.match(label, /Node v22\.22\.0/);
  assert.match(label, /darwin\/arm64/);
});

test("formatAgentTraceLine keeps work traces tool/action first", () => {
  assert.equal(
    formatAgentTraceLine({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: "step-1",
      role: "coordinator",
      status: "running",
      summary: "Running doctor surface",
    }),
    "",
  );
  assert.equal(
    formatAgentTraceLine({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: "step-2",
      role: "planner",
      status: "completed",
      summary: "Prepared prompt for inspect repo",
      durationMs: 0,
    }),
    "",
  );
  assert.equal(
    formatAgentTraceLine({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: "step-2b",
      role: "reviewer",
      status: "completed",
      summary: "Reviewed response",
      durationMs: 42,
    }),
    "",
  );
  assert.match(
    formatAgentTraceLine({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: "step-3",
      role: "executor",
      status: "running",
      summary: "Calling openai gpt-5.4",
    }),
    /→ model openai gpt-5\.4/,
  );
  assert.match(
    formatAgentTraceLine({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: "step-4",
      role: "executor",
      status: "failed",
      summary: "Provider failed",
      durationMs: 11,
    }),
    /✖ action 11ms .*Provider failed/,
  );
});

test("formatAgentTraceLine keeps thinking low-signal and visible", () => {
  assert.match(
    formatAgentTraceLine({
      type: "turn.started",
      provider: "openai",
      model: "gpt-5.4",
      prompt: "summarize current repo status",
      startedAt: 0,
    }),
    /thinking/,
  );
  assert.match(
    formatAgentTraceLine({
      type: "turn.completed",
      provider: "openai",
      model: "gpt-5.4",
      text: "done",
      startedAt: 0,
      completedAt: 12,
      durationMs: 12,
    }),
    /response 12ms/,
  );
});

test("formatToolTraceLine makes tool execution visible in the work shell", () => {
  assert.match(
    formatToolTraceLine({
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
      output: "import x from 'y';",
      startedAt: 0,
      completedAt: 7,
      durationMs: 7,
    }),
    /✓ read 7ms/,
  );
});

test("resolveWorkShellSlashCommand maps supported operational and prompt surfaces", () => {
  assert.deepEqual(resolveWorkShellSlashCommand("/doctor"), ["doctor"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/auth status"), ["auth", "status"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/auth login"), ["auth", "login"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/auth login --api-key sk-file-123"), ["auth", "login", "--api-key", "sk-file-123"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/auth logout"), ["auth", "logout"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/browser"), ["auth", "login", "--browser"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/reload"), ["reload"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/model"), ["model"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/model list"), ["model", "list"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/mcp list"), ["mcp", "list"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/mode status"), ["mode", "status"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/review"), ["prompt", "review"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/review auth flow"), ["prompt", "review", "auth", "flow"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/rev"), ["prompt", "review"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/commit"), ["prompt", "commit"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/commit auth flow"), ["prompt", "commit", "auth", "flow"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/com"), ["prompt", "commit"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/research current workspace"), ["research", "run", "current", "workspace"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/research status"), ["research", "status"]);
  assert.equal(resolveWorkShellSlashCommand("/unknown"), undefined);
});

test("resolveWorkShellSlashCommand loads plugin manifest commands from project extensions", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-plugin-"));
  mkdirSync(path.join(cwd, ".unclecode", "extensions"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".unclecode", "extensions", "focus.json"),
    JSON.stringify({
      name: "focus-tools",
      commands: [
        {
          command: "/focus",
          routeTo: ["doctor"],
          description: "Run doctor from a plugin command.",
        },
      ],
    }),
    "utf8",
  );

  assert.deepEqual(resolveWorkShellSlashCommand("/focus", { workspaceRoot: cwd }), ["doctor"]);
});

test("buildInlineCommandPanel labels operational surfaces with focused titles", () => {
  const doctorPanel = buildInlineCommandPanel(["doctor"], ["Doctor summary", "config PASS", "auth PASS"]);
  assert.equal(doctorPanel.title, "Doctor");
  assert.deepEqual(doctorPanel.lines, ["Doctor summary", "config PASS", "auth PASS"]);

  const authPanel = buildInlineCommandPanel(["auth", "status"], ["Provider: openai", "Source: oauth-file"]);
  assert.equal(authPanel.title, "Auth");
  assert.deepEqual(authPanel.lines, ["Provider: openai", "Source: oauth-file"]);

  const mcpPanel = buildInlineCommandPanel(["mcp", "list"], []);
  assert.equal(mcpPanel.title, "MCP");
  assert.deepEqual(mcpPanel.lines, ["No output."]);

  const fallbackPanel = buildInlineCommandPanel(["custom", "command"], ["line one"]);
  assert.equal(fallbackPanel.title, "custom command");
  assert.deepEqual(fallbackPanel.lines, ["line one"]);
});

test("formatInlineCommandResultSummary keeps operational results visible in transcript", () => {
  assert.equal(
    formatInlineCommandResultSummary(["doctor"], ["Doctor summary", "config PASS", "auth PASS"]),
    "Doctor · Doctor summary · config PASS",
  );
  assert.equal(
    formatInlineCommandResultSummary(["mcp", "list"], []),
    "MCP · No output.",
  );
});

test("formatWorkShellError collapses raw provider failures into operator guidance", () => {
  assert.equal(
    formatWorkShellError("OpenAI request failed with status 401"),
    "OpenAI rejected current auth (401/403). Saved auth may be stale. Run /auth status, /auth login, or /auth logout.",
  );
  assert.equal(
    formatWorkShellError("OpenAI request failed with status 401: {\"error\":{\"code\":\"missing_scope\",\"message\":\"Missing scopes: model.request\"}}"),
    "OpenAI OAuth lacks model.request scope. Use API key login or proper browser OAuth.",
  );
  assert.equal(formatWorkShellError("provider exploded"), "provider exploded");
});

test("formatAgentTraceLine compresses executor auth failures", () => {
  assert.match(
    formatAgentTraceLine({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: "step-auth",
      role: "executor",
      status: "failed",
      summary: "Provider failed: OpenAI request failed with status 401",
      durationMs: 261,
    }),
    /✖ action 261ms OpenAI rejected current auth \(401\/403\)/,
  );
  assert.equal(
    formatAgentTraceLine({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: "step-auth-coordinator",
      role: "coordinator",
      status: "failed",
      summary: "Turn failed for inspect the repo",
      durationMs: 261,
    }),
    "",
  );
});

test("buildContextPanel stays compact by default and expands on demand", () => {
  const compact = buildContextPanel(
    [
      "Auth issue: saved OAuth lacks model.request scope. Use /auth key.",
      "Loaded guidance: AGENTS.md, CLAUDE.md, AGENTS.md",
      "AGENTS.md: Prefer read before edit.",
    ],
    ["Project summary line"],
    ["Remembered preference"],
    ["→ model openai gpt-5.4"],
  );
  assert.equal(compact.title, "Context");
  assert.equal(compact.lines[0], "Focus");
  assert.match(compact.lines[1] ?? "", /^! Issue\s+saved OAuth lacks model\.request/);
  assert.equal(compact.lines[2], "□ Guide   AGENTS.md, CLAUDE.md");
  assert.equal(compact.lines[3], "□ Bridge  Project summary line");
  assert.equal(compact.lines[4], "□ Memory  Remembered preference");
  assert.equal(compact.lines[5], "→ Live    → model openai gpt-5.4");

  const expanded = buildContextPanel(
    [
      "Auth issue: saved OAuth lacks model.request scope. Use /auth key.",
      "Loaded guidance: AGENTS.md, CLAUDE.md, AGENTS.md",
      "AGENTS.md: Prefer read before edit.",
    ],
    ["Project summary line"],
    ["Remembered preference"],
    ["→ model openai gpt-5.4"],
    true,
  );
  assert.ok(expanded.lines.includes("Guidance"));
  assert.ok(expanded.lines.includes("Auth issue: saved OAuth lacks model.request scope. Use /auth key."));
  assert.ok(expanded.lines.includes("AGENTS.md: Prefer read before edit."));
  assert.ok(expanded.lines.includes("Bridge"));
  assert.ok(expanded.lines.includes("Memory"));
  assert.ok(expanded.lines.includes("Live steps"));
});

test("buildContextPanel truncates long compact values aggressively", () => {
  const compact = buildContextPanel(
    ["Loaded extension: extremely-long-extension-name-that-keeps-going · /focus opens a very detailed command surface"],
    [],
    [],
    [],
  );

  assert.equal(compact.title, "Context");
  assert.equal(compact.lines[1]?.startsWith("□ Guide   ext extremely-long-extension"), true);
  assert.equal(compact.lines[1]?.endsWith("..."), true);
});

test("resolveComposerInput turns pasted image paths into image attachments", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-compose-"));
  const imagePath = path.join(cwd, "clipboard.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "binary");

  const input = await resolveComposerInput(imagePath, cwd);

  assert.equal(input.prompt, "Please inspect the attached image.");
  assert.equal(input.attachments.length, 1);
  assert.equal(input.attachments[0]?.mimeType, "image/png");
  assert.match(input.attachments[0]?.dataUrl ?? "", /^data:image\/png;base64,/);
  assert.match(input.transcriptText, /Attached image: clipboard\.png/);
});

test("resolveComposerInput keeps natural text while extracting pasted image paths", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-compose-"));
  const imagePath = path.join(cwd, "clipboard.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "binary");

  const input = await resolveComposerInput(`what is in this? ${imagePath}`, cwd);

  assert.equal(input.prompt, "what is in this?");
  assert.equal(input.attachments.length, 1);
  assert.match(input.transcriptText, /what is in this\?/);
  assert.match(input.transcriptText, /Attached image: clipboard\.png/);
});

test("resolveComposerInput supports @file references by inlining readable context", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-compose-"));
  const filePath = path.join(cwd, "notes.txt");
  writeFileSync(filePath, "hello from file\nsecond line\n", "utf8");

  const input = await resolveComposerInput(`summarize @${filePath}`, cwd);

  assert.equal(input.attachments.length, 0);
  assert.match(input.prompt, /^summarize\n\nReferenced file: notes\.txt/m);
  assert.match(input.prompt, /hello from file/);
  assert.match(input.transcriptText, /Referenced file: notes\.txt/);
});

test("resolveComposerInput supports @directory references with a directory listing summary", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-compose-"));
  const dirPath = path.join(cwd, "docs");
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(path.join(dirPath, "a.md"), "A", "utf8");
  writeFileSync(path.join(dirPath, "b.md"), "B", "utf8");

  const input = await resolveComposerInput(`check @${dirPath}`, cwd);

  assert.equal(input.attachments.length, 0);
  assert.match(input.prompt, /^check\n\nReferenced directory: docs/m);
  assert.match(input.prompt, /- a\.md/);
  assert.match(input.prompt, /- b\.md/);
  assert.match(input.transcriptText, /Referenced directory: docs/);
});

test("resolveComposerInput supports @image references as first-class attachments", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-compose-"));
  const imagePath = path.join(cwd, "shot.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "binary");

  const input = await resolveComposerInput(`inspect @${imagePath}`, cwd);

  assert.equal(input.attachments.length, 1);
  assert.equal(input.prompt, "inspect");
  assert.match(input.transcriptText, /Attached image: shot\.png/);
});

test("formatAttachmentBadgeLine shows attachment count and filenames", () => {
  assert.equal(
    formatAttachmentBadgeLine([
      { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", path: "/tmp/a.png", displayName: "a.png" },
    ]),
    "Attachments 1 · a.png",
  );
  assert.equal(
    formatAttachmentBadgeLine([
      { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", path: "/tmp/a.png", displayName: "a.png" },
      { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,BBBB", path: "/tmp/b.png", displayName: "b.png" },
    ]),
    "Attachments 2 · a.png, b.png",
  );
});

test("buildAttachmentPreviewLines summarizes attached images safely", () => {
  assert.deepEqual(
    buildAttachmentPreviewLines([
      { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", path: "/tmp/a.png", displayName: "a.png" },
      { type: "image", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,BBBB", path: "/tmp/b.jpg", displayName: "b.jpg" },
    ]),
    [
      "Attachments 2 · a.png, b.jpg",
      "1. a.png · image/png",
      "2. b.jpg · image/jpeg",
    ],
  );
});

test("buildTerminalInlineImageSequence emits iTerm inline image escapes", () => {
  const sequence = buildTerminalInlineImageSequence(
    { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", path: "/tmp/a.png", displayName: "a.png" },
    { TERM_PROGRAM: "iTerm.app" },
  );

  assert.match(sequence ?? "", /1337;File=/);
  assert.match(sequence ?? "", /AAAA/);
});

test("buildTerminalInlineImageSequence emits kitty graphics protocol escapes", () => {
  const sequence = buildTerminalInlineImageSequence(
    { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", path: "/tmp/a.png", displayName: "a.png" },
    { TERM: "xterm-kitty" },
  );

  assert.match(sequence ?? "", /_G/);
  assert.match(sequence ?? "", /AAAA/);
});

test("buildTerminalInlineImageSequence treats ghostty and wezterm as kitty-like terminals", () => {
  const ghosttySequence = buildTerminalInlineImageSequence(
    { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", path: "/tmp/a.png", displayName: "a.png" },
    { TERM_PROGRAM: "ghostty" },
  );
  const weztermSequence = buildTerminalInlineImageSequence(
    { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", path: "/tmp/a.png", displayName: "a.png" },
    { TERM_PROGRAM: "WezTerm" },
  );

  assert.match(ghosttySequence ?? "", /_G/);
  assert.match(weztermSequence ?? "", /_G/);
});

test("formatInlineImageSupportLine describes terminal preview capability", () => {
  assert.match(formatInlineImageSupportLine({ TERM_PROGRAM: "iTerm.app" }) ?? "", /preview paused.*ghosting/i);
  assert.match(formatInlineImageSupportLine({ TERM_PROGRAM: "ghostty" }) ?? "", /preview paused.*ghosting/i);
  assert.match(formatInlineImageSupportLine({ TERM: "xterm-256color" }) ?? "", /Preview unavailable/i);
});

test("getWorkShellSlashSuggestions surfaces command matches for slash-first input", () => {
  const suggestions = getWorkShellSlashSuggestions("/auth l");

  assert.ok(suggestions.some((item) => item.command === "/auth login"));
  assert.ok(suggestions.some((item) => item.command === "/auth key"));
  assert.ok(suggestions.some((item) => item.command === "/auth logout"));
});

test("getWorkShellSlashSuggestions keeps /auth launcher status-first", () => {
  const suggestions = getWorkShellSlashSuggestions("/auth");

  assert.equal(suggestions[0]?.command, "/auth status");
  assert.equal(suggestions[1]?.command, "/auth login");
  assert.equal(suggestions[2]?.command, "/auth key");
});

test("getWorkShellSlashSuggestions expands /model into concrete model picks", () => {
  const suggestions = getWorkShellSlashSuggestions("/model", {
    provider: "openai",
    currentModel: "gpt-5.4",
  });

  assert.deepEqual(
    suggestions.slice(0, 4).map((item) => item.command),
    ["/model", "/model list", "/model gpt-5.4", "/model gpt-4.1-mini"],
  );
  assert.match(suggestions[2]?.description ?? "", /Current · default medium · supports low, medium, high/i);
  assert.match(suggestions[3]?.description ?? "", /Warning · reasoning unsupported/i);
});

test("shouldBlockSlashSubmit guards partial slash commands from leaking to the model", () => {
  assert.equal(shouldBlockSlashSubmit("/auth"), true);
  assert.equal(shouldBlockSlashSubmit("/auth status"), false);
  assert.equal(shouldBlockSlashSubmit("explain /auth"), false);
});

test("shared dashboard home-sync helpers stay available through src/cli.tsx", () => {
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
      isBusy: true,
      authLabel: "api-key-env",
      bridgeLines: ["Bridge updated"],
      memoryLines: ["Memory updated"],
    }),
    {
      isBusy: true,
      authLabel: "api-key-env",
      bridgeLines: ["Bridge updated"],
      memoryLines: ["Memory updated"],
    },
  );
});

test("shouldRefreshDashboardHomeState reacts to completed work turns and home-state mutations", () => {
  assert.equal(
    shouldRefreshDashboardHomeState(
      {
        isBusy: true,
        authLabel: "api-key-env",
        bridgeLines: [],
        memoryLines: [],
      },
      {
        isBusy: false,
        authLabel: "api-key-env",
        bridgeLines: ["Bridge updated"],
        memoryLines: ["Memory updated"],
      },
    ),
    true,
  );
  assert.equal(
    shouldRefreshDashboardHomeState(
      {
        isBusy: false,
        authLabel: "none",
        bridgeLines: [],
        memoryLines: [],
      },
      {
        isBusy: false,
        authLabel: "api-key-file",
        bridgeLines: [],
        memoryLines: [],
      },
    ),
    true,
  );
  assert.equal(
    shouldRefreshDashboardHomeState(
      {
        isBusy: false,
        authLabel: "api-key-env",
        bridgeLines: ["Bridge updated"],
        memoryLines: ["Memory updated"],
      },
      {
        isBusy: false,
        authLabel: "api-key-env",
        bridgeLines: ["Bridge updated"],
        memoryLines: ["Memory updated"],
      },
    ),
    false,
  );
});

test("shared slash selection helpers stay available through src/cli.tsx", () => {
  assert.equal(clampWorkShellSlashSelection(8, 0), 0);
  assert.equal(clampWorkShellSlashSelection(8, 3), 2);
  assert.equal(cycleWorkShellSlashSelection(0, 3, "previous"), 2);
  assert.equal(cycleWorkShellSlashSelection(2, 3, "next"), 0);
  assert.equal(
    resolveWorkShellActivePanel({
      input: "/auth",
      suggestions: [{ command: "/auth status", description: "Show auth source." }],
      selectedIndex: 0,
      authLabel: "oauth-file",
      fallbackPanel: { title: "Context", lines: ["Loaded guidance: AGENTS.md"] },
    }).title,
    "Auth",
  );
});

test("shared input decision helpers stay available through src/cli.tsx", () => {
  assert.deepEqual(
    resolveWorkShellInputAction({
      value: "",
      key: { upArrow: true },
      input: "/auth",
      slashSuggestionCount: 3,
      isBusy: false,
      hasRequestSessionsView: false,
    }),
    { type: "move-slash-selection", direction: "previous" },
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
      isBusy: true,
      shouldBlockSlashSubmit: false,
    }),
    { type: "noop" },
  );
});

test("buildSlashSuggestionPanel shows an auth-focused card for /auth intent", () => {
  const panel = buildSlashSuggestionPanel(
    "/auth",
    [
      { command: "/auth status", description: "Show auth source." },
      { command: "/auth login", description: "Sign in with browser OAuth." },
    ],
    1,
    "oauth-file",
  );

  assert.equal(panel.title, "Auth");
  assert.deepEqual(panel.lines.slice(0, 12), [
    "Current",
    "Auth · Browser OAuth · file",
    "Route · Browser OAuth",
    "Saved browser OAuth found.",
    "",
    "Next",
    "/auth status inspects auth.",
    "/auth logout switches auth.",
    "",
    "Routes",
    "  /auth status  Show auth source.",
    "› /auth login  Sign in with browser OAuth.",
  ]);
});

test("buildSlashSuggestionPanel shows a model-focused picker for /model intent", () => {
  const panel = buildSlashSuggestionPanel(
    "/model",
    [
      { command: "/model", description: "Show the current model and available model picks." },
      { command: "/model list", description: "List available models and reasoning support." },
      { command: "/model gpt-5.4", description: "Current · default medium · supports low, medium, high" },
      { command: "/model gpt-4.1-mini", description: "Reasoning unsupported" },
    ],
    2,
  );

  assert.equal(panel.title, "Models");
  assert.deepEqual(panel.lines.slice(0, 14), [
    "Current",
    "Model · gpt-5.4",
    "Selected · /model gpt-5.4",
    "Reasoning · default medium",
    "Support · low, medium, high",
    "",
    "Available",
    "› /model gpt-5.4  Current · default medium · supports low, medium, high",
    "  /model gpt-4.1-mini  Warning · reasoning unsupported",
    "",
    "Routes",
    "/model shows this picker.",
    "/model <id> switches now.",
    "/model list shows all model picks.",
  ]);
});

test("buildSlashSuggestionPanel describes api-key auth distinctly", () => {
  const panel = buildSlashSuggestionPanel(
    "/auth",
    [{ command: "/auth status", description: "Show auth source." }],
    0,
    "api-key-env",
    false,
  );

  assert.deepEqual(panel.lines.slice(0, 9), [
    "Current",
    "Auth · API key · env",
    "Route · Device OAuth",
    "API key ready. /auth login may use device OAuth.",
    "Browser OAuth unavailable in this shell.",
    "",
    "Next",
    "/auth status inspects auth.",
    "/auth login may use device OAuth.",
  ]);
});

test("buildSlashSuggestionPanel shows browser oauth route when browser auth is available", () => {
  const panel = buildSlashSuggestionPanel(
    "/auth",
    [{ command: "/auth login", description: "Sign in with browser OAuth." }],
    0,
    "none",
    true,
  );

  assert.deepEqual(panel.lines.slice(0, 8), [
    "Current",
    "Auth · Not signed in",
    "Route · Browser OAuth",
    "Use /auth login or /auth key.",
    "",
    "Next",
    "/auth login starts OAuth.",
    "/auth key opens secure API key entry.",
  ]);
});

test("buildSlashSuggestionPanel reuses remembered auth status guidance for refresh-needed oauth", () => {
  const panel = buildSlashSuggestionPanel(
    "/auth",
    [
      { command: "/auth status", description: "Show auth source." },
      { command: "/auth login", description: "Sign in with browser OAuth." },
    ],
    1,
    "oauth-file",
    true,
    [
      "Current",
      "Auth · Browser OAuth · file",
      "Browser OAuth needs refresh.",
      "",
      "Next",
      "/auth login refreshes this shell.",
      "/auth logout clears stale auth if needed.",
    ],
  );

  assert.deepEqual(panel.lines.slice(0, 12), [
    "Current",
    "Auth · Browser OAuth · file",
    "Route · Browser OAuth",
    "Browser OAuth needs refresh.",
    "",
    "Next",
    "/auth login refreshes this shell.",
    "/auth logout clears stale auth if needed.",
    "",
    "Routes",
    "  /auth status  Show auth source.",
    "› /auth login  Sign in with browser OAuth.",
  ]);
});

test("buildSlashSuggestionPanel normalizes remembered browser login success into current auth guidance", () => {
  const panel = buildSlashSuggestionPanel(
    "/auth",
    [
      { command: "/auth status", description: "Show auth source." },
      { command: "/auth logout", description: "Clear stored auth." },
    ],
    0,
    "oauth-file",
    true,
    ["OAuth login complete.", "Auth: oauth-file", "Route: device-oauth"],
  );

  assert.deepEqual(panel.lines.slice(0, 11), [
    "Current",
    "Auth · Browser OAuth · file",
    "Route · Device OAuth",
    "Saved browser OAuth found.",
    "",
    "Next",
    "/auth status inspects auth.",
    "/auth logout switches auth.",
    "",
    "Routes",
    "› /auth status  Show auth source.",
  ]);
});

test("buildSlashSuggestionPanel normalizes remembered already-signed-in auth guidance", () => {
  const panel = buildSlashSuggestionPanel(
    "/auth",
    [
      { command: "/auth status", description: "Show auth source." },
      { command: "/auth logout", description: "Clear stored auth." },
    ],
    0,
    "oauth-file",
    false,
    [
      "Saved auth found.",
      "Auth: oauth-file",
      "Use `unclecode auth status` to inspect it. The next model request will verify provider access.",
    ],
  );

  assert.deepEqual(panel.lines.slice(0, 11), [
    "Current",
    "Auth · Browser OAuth · file",
    "Route · Device OAuth",
    "Saved browser OAuth found. New browser login needs OPENAI_OAUTH_CLIENT_ID.",
    "Browser OAuth unavailable in this shell.",
    "",
    "Next",
    "/auth status inspects auth.",
    "/auth logout switches auth.",
    "",
    "Routes",
  ]);
});

test("refineInlineCommandPanelLines explains browser oauth failure relative to current auth", () => {
  assert.deepEqual(
    refineInlineCommandPanelLines({
      args: ["auth", "login", "--browser"],
      lines: ["Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID."],
      failed: true,
      authLabel: "api-key-env",
      browserOAuthAvailable: false,
    }),
    [
      "Current",
      "Auth · API key · env",
      "Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID.",
      "",
      "Next",
      "/auth status inspects auth or /auth logout switches.",
      "/auth key opens secure API key entry.",
    ],
  );
});

test("refineInlineCommandPanelLines turns auth status into product guidance", () => {
  assert.deepEqual(
    refineInlineCommandPanelLines({
      args: ["auth", "status"],
      lines: [
        "provider: openai",
        "source: oauth-file",
        "auth: oauth",
        "organization: none",
        "project: none",
        "expiresAt: refresh-required",
        "expired: yes",
      ],
      failed: false,
      authLabel: "oauth-file",
      browserOAuthAvailable: false,
    }),
    [
      "Current",
      "Auth · Browser OAuth · file",
      "Route · Device OAuth",
      "Browser OAuth needs refresh.",
      "",
      "Next",
      "OAuth refresh needs OPENAI_OAUTH_CLIENT_ID here.",
      "/auth logout clears stale auth if needed.",
    ],
  );
  assert.deepEqual(
    refineInlineCommandPanelLines({
      args: ["auth", "status"],
      lines: [
        "provider: openai",
        "source: oauth-file",
        "auth: oauth",
        "organization: none",
        "project: none",
        "expiresAt: insufficient-scope",
        "expired: yes",
      ],
      failed: false,
      authLabel: "oauth-file",
      browserOAuthAvailable: false,
    }),
    [
      "Current",
      "Auth · Browser OAuth · file",
      "Route · Device OAuth",
      "OAuth token lacks model.request scope.",
      "",
      "Next",
      "Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID.",
      "/auth key opens secure API key entry.",
    ],
  );
});

test("refineInlineCommandPanelLines makes unsigned auth status actionable", () => {
  assert.deepEqual(
    refineInlineCommandPanelLines({
      args: ["auth", "status"],
      lines: [
        "provider: openai",
        "source: none",
        "auth: none",
        "organization: none",
        "project: none",
        "expiresAt: none",
        "expired: no",
      ],
      failed: false,
      authLabel: "none",
      browserOAuthAvailable: false,
    }),
    [
      "Current",
      "Auth · Not signed in",
      "Route · Device OAuth",
      "Use /auth login (device when available) or /auth key.",
      "",
      "Next",
      "/auth login may use device OAuth.",
      "/auth key opens secure API key entry.",
    ],
  );
  assert.deepEqual(
    refineInlineCommandPanelLines({
      args: ["auth", "status"],
      lines: [
        "provider: openai",
        "source: none",
        "auth: none",
        "organization: none",
        "project: none",
        "expiresAt: none",
        "expired: no",
      ],
      failed: false,
      authLabel: "none",
      browserOAuthAvailable: true,
    }),
    [
      "Current",
      "Auth · Not signed in",
      "Route · Browser OAuth",
      "Use /auth login or /auth key.",
      "",
      "Next",
      "/auth login starts OAuth.",
      "/auth key opens secure API key entry.",
    ],
  );
});

test("buildSlashSuggestionPanel shows reload guidance in the general command palette", () => {
  const panel = buildSlashSuggestionPanel(
    "/re",
    [{ command: "/reload", description: "Reload workspace guidance, skills, and extension context." }],
    0,
  );

  assert.equal(panel.title, "Commands");
  assert.ok(panel.lines.includes("› /reload"));
  assert.ok(panel.lines.includes("  Reload workspace guidance, skills, and extension context."));
});

test("getWorkShellSlashSuggestions surfaces prompt helpers for review, commit, and research", () => {
  const reviewSuggestions = getWorkShellSlashSuggestions("/rev");
  const commitSuggestions = getWorkShellSlashSuggestions("/com");
  const researchSuggestions = getWorkShellSlashSuggestions("/research");

  assert.ok(reviewSuggestions.some((item) => item.command === "/review"));
  assert.ok(commitSuggestions.some((item) => item.command === "/commit"));
  assert.ok(researchSuggestions.some((item) => item.command === "/research"));
  assert.ok(researchSuggestions.some((item) => item.command === "/research status"));
});

test("formatAuthLabelForDisplay humanizes auth labels", () => {
  assert.equal(formatAuthLabelForDisplay("oauth-file"), "Browser OAuth · file");
  assert.equal(formatAuthLabelForDisplay("api-key-env"), "API key · env");
  assert.equal(formatAuthLabelForDisplay("none"), "Not signed in");
});

test("getConversationLayout gives answer blocks more room than notes", () => {
  assert.deepEqual(getConversationLayout("assistant"), { marginBottom: 1, paddingLeft: 2, hasBorder: true });
  assert.deepEqual(getConversationLayout("tool"), { marginBottom: 1, paddingLeft: 1, hasBorder: true });
  assert.deepEqual(getConversationLayout("system"), { marginBottom: 1, paddingLeft: 1, hasBorder: true });
});

test("createWorkShellDashboardProps maps work runtime state into unified Dashboard props", () => {
  const refreshHomeState = async () => ({
    modeLabel: "ultrawork",
    authLabel: "api-key-file",
    sessionCount: 2,
    mcpServerCount: 1,
    mcpServers: [{ name: "memory", transport: "stdio", scope: "user", trustTier: "user", originLabel: "user config" }],
    latestResearchSessionId: "research-1",
    latestResearchSummary: "Prepared a local research bundle",
    latestResearchTimestamp: "2026-04-05T12:00:00.000Z",
    researchRunCount: 1,
    sessions: [{ sessionId: "work-1", state: "idle", updatedAt: "2026-04-05T12:00:00.000Z", model: "gpt-5.4", taskSummary: "Review repo" }],
    bridgeLines: ["Bridge updated"],
    memoryLines: ["Memory updated"],
  });
  const props = createWorkShellDashboardProps(
    {
      runTurn: async () => ({ text: "ok" }),
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
    },
    {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supported,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
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
        sessions: [{ sessionId: "work-0", state: "idle", updatedAt: "2026-04-05T11:00:00.000Z", model: "gpt-5.4", taskSummary: "Initial" }],
        bridgeLines: ["Bridge initial"],
        memoryLines: ["Memory initial"],
      },
      refreshHomeState,
      browserOAuthAvailable: true,
    },
  );

  assert.equal(props.workspaceRoot, "/repo");
  assert.equal(props.modeLabel, "default");
  assert.equal(props.authLabel, "api-key-env");
  assert.equal(props.sessionCount, 1);
  assert.deepEqual(props.contextLines, ["Loaded guidance: AGENTS.md"]);
  assert.equal(props.refreshHomeState, refreshHomeState);
  assert.equal(typeof props.renderWorkPane, "function");
  const element = props.renderWorkPane({
    openSessions() {},
    syncHomeState() {},
  });
  const pane = element.props.buildPane({ onExit() {} });
  assert.equal(pane.browserOAuthAvailable, true);
});

test("listAvailableSkills includes project and global skills", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-skills-"));
  const home = path.join(cwd, "home");
  mkdirSync(path.join(cwd, ".codex", "skills", "analyze"), { recursive: true });
  mkdirSync(path.join(home, ".agents", "skills", "superpowers", "brainstorming"), { recursive: true });
  writeFileSync(path.join(cwd, ".codex", "skills", "analyze", "SKILL.md"), "# Analyze\nProject skill\n", { encoding: "utf8", flag: "w" });
  writeFileSync(path.join(home, ".agents", "skills", "superpowers", "brainstorming", "SKILL.md"), "# Brainstorming\nGlobal skill\n", { encoding: "utf8", flag: "w" });

  const skills = await listAvailableSkills(cwd, home);

  assert.ok(skills.some((skill) => skill.name === "analyze" && /Project skill/.test(skill.summary)));
  assert.ok(skills.some((skill) => skill.name === "brainstorming" && /Global skill/.test(skill.summary)));
});

test("loadNamedSkill falls back from local codex skill path to global agents skills", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-skills-"));
  const home = path.join(cwd, "home");
  mkdirSync(path.join(home, ".agents", "skills", "superpowers", "brainstorming"), { recursive: true });
  writeFileSync(path.join(home, ".agents", "skills", "superpowers", "brainstorming", "SKILL.md"), "---\nname: brainstorming\n---\nGlobal skill\n", { encoding: "utf8", flag: "w" });

  const result = await loadNamedSkill("brainstorming", cwd, home);

  assert.equal(result.name, "brainstorming");
  assert.match(result.content, /Global skill/);
  assert.ok(result.attempts.some((attempt) => /\.codex\/skills\/brainstorming\/SKILL\.md/.test(attempt.path)));
  assert.ok(result.attempts.some((attempt) => /\.agents\/skills\/superpowers\/brainstorming\/SKILL\.md/.test(attempt.path) && attempt.ok));
});

test("resolveWorkShellInlineCommand returns stderr lines instead of throwing", async () => {
  const result = await resolveWorkShellInlineCommand(["auth", "login", "--browser"], async () => {
    const error = new Error("Command failed");
    error.stdout = "";
    error.stderr = "OPENAI_OAUTH_CLIENT_ID is required for OAuth login.\n";
    throw error;
  });

  assert.equal(result.failed, true);
  assert.deepEqual(result.lines, ["Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID."]);
});

test("persistWorkShellSessionSnapshot makes chat sessions visible in recent sessions", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-shell-"));
  const sessionStoreRoot = path.join(cwd, ".state");
  const env = {
    ...process.env,
    UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
  };

  await persistWorkShellSessionSnapshot({
    cwd,
    env,
    sessionId: "work-session-1",
    model: "gpt-5.4",
    mode: "analyze",
    state: "idle",
    summary: "Chat: inspect the repo status",
    traceMode: "verbose",
  });

  const lines = await listSessionLines(cwd, env);
  const store = createSessionStore({ rootDir: sessionStoreRoot });
  const resumed = await store.resumeSession({ projectPath: cwd, sessionId: "work-session-1" });

  assert.ok(lines.some((line) => /work-session-1/.test(line)));
  assert.ok(lines.some((line) => /Chat: inspect the repo status/.test(line)));
  assert.equal(resumed.metadata.traceMode, "verbose");
});
