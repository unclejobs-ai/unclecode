import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkShellEngine,
  createWorkShellEngine,
  createWorkShellPaneRuntime,
} from "@unclecode/orchestrator";
import {
  createAuthKeyBuiltinResult,
  createBuiltinStatusPanel,
  createContextBuiltinResult,
  createHelpBuiltinResult,
  createLoadedSkillBuiltinResult,
  createSkillLoadErrorEntries,
  createSkillsBuiltinResult,
  createSkillUsageErrorEntries,
  createStatusBuiltinResult,
  createToolsBuiltinResult,
  createTraceModeBuiltinResult,
  resolveModelBuiltinResult,
  resolveReasoningBuiltinResult,
} from "../../packages/orchestrator/src/work-shell-engine-builtins.ts";
import {
  buildAuthProgressPanelLines,
  buildPromptCommandPrompt,
  createAuthLoginPendingPanel,
  createLoadedSkillPanel,
  createMemoriesPanel,
  createSecureApiKeyEntryPanel,
  createSkillsPanel,
  redactSensitiveInlineCommandArgs,
  redactSensitiveInlineCommandLine,
  resolvePromptSlashCommand,
  resolveVisibleInlineCommand,
  resolveWorkShellBuiltinCommand,
  resolveWorkShellLocalCommand,
} from "../../packages/orchestrator/src/work-shell-engine-commands.ts";
import { resolveWorkShellSubmitRoute } from "../../packages/orchestrator/src/work-shell-engine-submit.ts";
import {
  createPromptTurnFailurePatch,
  createPromptTurnFinalizePatch,
  createPromptTurnStartPatch,
  createPromptTurnSuccessPatch,
  resolvePromptTurnFailureResult,
  runPromptTurnSuccessSequence,
} from "../../packages/orchestrator/src/work-shell-engine-execution.ts";
import {
  applyAuthIssueLinesToContextSummaryLines,
  loadInitialWorkShellContextState,
  reloadWorkShellContextState,
} from "../../packages/orchestrator/src/work-shell-engine-context.ts";
import {
  loadWorkShellMemoriesPanel,
  resolveInlineOperationalCommandResult,
  resolveSecureApiKeyEntrySubmission,
  writeWorkShellRememberCommand,
} from "../../packages/orchestrator/src/work-shell-engine-operations.ts";
import {
  createCollapsedContextPanel,
  createRecentSessionsLoadingPanel,
  createRecentSessionsPanel,
  createSensitiveInputCancelResult,
  createWorkShellStatusPanel,
  createWorkspaceReloadCompleteEntry,
  createWorkspaceReloadEntries,
  loadRecentSessionsPanel,
} from "../../packages/orchestrator/src/work-shell-engine-panels.ts";
import {
  createWorkShellSessionSnapshotInput,
  loadWorkShellContextState,
} from "../../packages/orchestrator/src/work-shell-engine-persistence.ts";
import {
  isWorkShellAuthFailure,
  resolveWorkShellFailureAuthLabel,
  runWorkShellPostTurnSuccessEffects,
} from "../../packages/orchestrator/src/work-shell-engine-post-turns.ts";
import {
  createTraceEventBusyPatch,
  extractCurrentTurnStartedAt,
  resolveBusyStatusFromTraceEvent,
  resolveTraceEntryRole,
  resolveVerboseTraceEntry,
} from "../../packages/orchestrator/src/work-shell-engine-trace.ts";
import {
  buildPermissionStallContinuePrompt,
  createChatPromptTurnInput,
  createConversationTurnSummary,
  createPromptCommandTurnInput,
  detectPermissionSeekingStall,
  finalizeWorkShellAssistantReply,
  stripPermissionSeekingStallOutro,
} from "../../packages/orchestrator/src/work-shell-engine-turns.ts";
import {
  appendWorkShellEntries,
  createInitialWorkShellEngineState,
  createWorkShellAuthStatePatch,
  createWorkShellBusyStatePatch,
  createWorkShellTraceLinePatch,
  createWorkShellTraceModePatch,
} from "../../packages/orchestrator/src/work-shell-engine-state.ts";

const supportedReasoning = {
  effort: "high",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

function buildContextPanel(contextSummaryLines, bridgeLines, memoryLines, traceLines, expanded = false) {
  return {
    title: expanded ? "Context expanded" : "Context",
    lines: [...contextSummaryLines, ...bridgeLines, ...memoryLines, ...traceLines],
  };
}

function createState(overrides = {}) {
  return {
    ...createInitialWorkShellEngineState({
      options: {
        provider: "openai",
        model: "gpt-5.4",
        mode: "default",
        authLabel: "api-key-env",
        reasoning: supportedReasoning,
        cwd: "/repo",
        contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      },
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      buildContextPanel,
    }),
    ...overrides,
  };
}

function createEngineInput(overrides = {}) {
  const calls = {
    clear: 0,
    runtimeSettings: [],
    snapshots: [],
    inline: [],
    secureAuth: [],
    refreshedAuth: 0,
    traceListener: undefined,
  };

  const agent = {
    clear() {
      calls.clear += 1;
    },
    updateRuntimeSettings(settings) {
      calls.runtimeSettings.push(settings);
    },
    setTraceListener(listener) {
      calls.traceListener = listener;
    },
    async runTurn(prompt) {
      return { text: `echo:${prompt}` };
    },
  };

  return {
    calls,
    input: {
      agent,
      options: {
        provider: "openai",
        model: "gpt-5.4",
        mode: "default",
        authLabel: "api-key-env",
        reasoning: supportedReasoning,
        cwd: "/repo",
        contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      },
      buildContextPanel,
      buildHelpPanel() {
        return { title: "Help", lines: ["help"] };
      },
      buildStatusPanel(options, reasoning, authLabel) {
        return { title: "Status", lines: [`model:${options.model}`, `reasoning:${reasoning.effort}`, `auth:${authLabel}`] };
      },
      buildInlineCommandPanel(args, lines) {
        return { title: args.join(" "), lines };
      },
      formatInlineCommandResultSummary(args, lines) {
        return `${args.join(" ")} :: ${lines[0] ?? "No output."}`;
      },
      formatAgentTraceLine(event) {
        if (event.type === "turn.started") return `thinking ${event.prompt}`;
        if (event.type === "provider.calling") return `calling ${event.provider} ${event.model}`;
        if (event.type === "turn.completed") return `done ${event.durationMs}`;
        if (event.type === "orchestrator.step") return `${event.role} ${event.summary}`;
        if (event.type === "bridge.published") return `bridge ${event.summary}`;
        if (event.type === "memory.written") return `memory ${event.summary}`;
        return "";
      },
      formatWorkShellError(message) {
        return `ERR:${message}`;
      },
      async listProjectBridgeLines() {
        return [];
      },
      async listScopedMemoryLines() {
        return [];
      },
      async listSessionLines() {
        return ["session-1"];
      },
      async persistWorkShellSessionSnapshot(input) {
        calls.snapshots.push(input);
      },
      resolveReasoningCommand(input, reasoning, modeDefault) {
        if (input === "/reasoning low") {
          return {
            nextReasoning: { ...reasoning, effort: "low", source: "override" },
            message: "Reasoning set to low.",
          };
        }
        return { nextReasoning: modeDefault, message: "reset" };
      },
      resolveModelCommand(input, currentModel, currentReasoning) {
        if (input === "/model" || input === "/model list") {
          return {
            nextModel: currentModel,
            nextReasoning: currentReasoning,
            message: "Model picker shown.",
            panel: {
              title: "Models",
              lines: ["Current", `› /model ${currentModel}  active`, " /model gpt-4.1-mini  Warning · reasoning unsupported"],
            },
          };
        }
        if (input === "/model gpt-4.1-mini") {
          return {
            nextModel: "gpt-4.1-mini",
            nextReasoning: {
              effort: "unsupported",
              source: "model-capability",
              support: { status: "unsupported", supportedEfforts: [] },
            },
            message: "Model set to gpt-4.1-mini. Reasoning unsupported.",
            panel: {
              title: "Models",
              lines: ["Current", "› /model gpt-4.1-mini  Warning · reasoning unsupported"],
            },
          };
        }
        return undefined;
      },
      resolveWorkShellSlashCommand(input) {
        return input === "/doctor" ? ["doctor"] : undefined;
      },
      async resolveWorkShellInlineCommand(args, runInlineCommand) {
        const lines = await runInlineCommand(args);
        return { lines, failed: false };
      },
      async runInlineCommand(args) {
        calls.inline.push(args);
        return ["Doctor report", "Auth: oauth-file"];
      },
      async saveApiKeyAuth(raw) {
        calls.secureAuth.push(raw);
        return ["API key login saved.", "Auth: api-key-file"];
      },
      async resolveComposerInput(value) {
        return { prompt: value.trim(), attachments: [], transcriptText: value.trim() };
      },
      async publishContextBridge({ summary }) {
        return { bridgeId: "bridge-1", line: summary };
      },
      async writeScopedMemory({ scope, summary }) {
        return { memoryId: `${scope}:${summary}` };
      },
      listAvailableSkills: async () => [],
      loadNamedSkill: async (name) => ({ name, path: `/skills/${name}`, content: `${name} content`, attempts: [] }),
      onExit() {},
      ...overrides,
    },
  };
}

function createEngine(overrides = {}) {
  const { calls, input } = createEngineInput(overrides);
  const engine = new WorkShellEngine(input);

  return {
    engine,
    calls,
    emitTrace(event) {
      return calls.traceListener?.(event);
    },
  };
}

test("work-shell command helpers classify builtins, local commands, and reusable panels/prompts", () => {
  assert.deepEqual(resolveWorkShellBuiltinCommand("/help"), { kind: "help" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/v"), { kind: "trace-mode", traceMode: "verbose" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/minimal"), { kind: "trace-mode", traceMode: "minimal" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/auth key"), { kind: "auth-key" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/skill analyze"), { kind: "skill", line: "/skill analyze", skillName: "analyze" });
  assert.equal(resolveWorkShellBuiltinCommand("hello"), undefined);

  assert.equal(createSecureApiKeyEntryPanel().title, "Auth");
  assert.deepEqual(createAuthLoginPendingPanel().lines, [
    "Starting OAuth…",
    "Check the browser window.",
  ]);
  assert.deepEqual(buildAuthProgressPanelLines([
    "Opening browser…",
    "Enter code: ABCD-1234",
    "Waiting for device approval…",
  ]), [
    "Enter code: ABCD-1234",
    "Waiting for device approval…",
    "Opening browser…",
  ]);
  assert.deepEqual(createSkillsPanel([{ name: "autopilot", path: "/skills/autopilot", scope: "project", summary: "Keep moving." }]).lines, [
    "autopilot · project",
    "  Keep moving.",
  ]);
  assert.equal(createLoadedSkillPanel({ name: "analyze", path: "/skills/analyze", content: "# Analyze\nLook deeper.", attempts: [] }).title, "Skill · analyze");
  assert.deepEqual(createMemoriesPanel(["session-1"], ["project-1"]).lines, [
    "Session",
    "session-1",
    "",
    "Project",
    "project-1",
  ]);
  assert.deepEqual(resolveWorkShellLocalCommand("/memories"), { kind: "memories" });
  assert.deepEqual(resolveWorkShellLocalCommand("/remember session keep this"), {
    kind: "remember",
    scope: "session",
    summary: "keep this",
  });
  assert.deepEqual(resolveWorkShellLocalCommand("/remember"), {
    kind: "remember",
    usageError: "Usage: /remember [session|project|user|agent] <text>",
  });
  assert.deepEqual(redactSensitiveInlineCommandArgs(["auth", "login", "--api-key", "sk-secret"]), [
    "auth",
    "login",
    "--api-key",
    "[REDACTED]",
  ]);
  assert.equal(
    redactSensitiveInlineCommandLine("/auth login --api-key sk-secret"),
    "/auth login --api-key [REDACTED]",
  );
  assert.deepEqual(resolveVisibleInlineCommand({
    line: "/auth login --api-key sk-secret",
    slashCommand: ["auth", "login", "--api-key", "sk-secret"],
  }), {
    visibleLine: "/auth login --api-key [REDACTED]",
    visibleArgs: ["auth", "login", "--api-key", "[REDACTED]"],
    isAuthCommand: true,
    isAuthLogin: true,
  });
  assert.deepEqual(resolvePromptSlashCommand(["prompt", "review", "auth", "flow"]), { kind: "review", focus: "auth flow" });
  assert.match(buildPromptCommandPrompt({ kind: "commit", focus: "auth flow" }), /Lore protocol/);
});

test("work-shell submit route helper classifies secure, builtin, prompt, inline, local, and chat turns", () => {
  assert.equal(resolveWorkShellSubmitRoute({
    value: "   ",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  }), undefined);
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "secret",
    isBusy: false,
    composerMode: "api-key-entry",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  }), {
    kind: "secure-api-key-entry",
    line: "secret",
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/help",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  }), {
    kind: "builtin",
    line: "/help",
    command: { kind: "help" },
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/review auth flow",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => ["prompt", "review", "auth", "flow"],
    hasInlineCommandRunner: true,
  }), {
    kind: "prompt-command",
    line: "/review auth flow",
    promptCommand: { kind: "review", focus: "auth flow" },
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/doctor",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => ["doctor"],
    hasInlineCommandRunner: true,
  }), {
    kind: "inline-command",
    line: "/doctor",
    slashCommand: ["doctor"],
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/remember session keep this",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: false,
  }), {
    kind: "local-command",
    line: "/remember session keep this",
    localCommand: { kind: "remember", scope: "session", summary: "keep this" },
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "finish cleanup",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: false,
  }), {
    kind: "chat",
    line: "finish cleanup",
  });
});

test("work-shell builtin helpers resolve panels, transcript entries, and runtime transitions", () => {
  const state = createState({
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    traceLines: ["trace-1"],
  });
  const help = createHelpBuiltinResult("/help", () => ({ title: "Help", lines: ["help"] }));
  const context = createContextBuiltinResult({
    line: "/context",
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    state,
    buildContextPanel,
  });
  const status = createStatusBuiltinResult({
    line: "/status",
    reasoning: supportedReasoning,
    authLabel: "api-key-env",
    buildStatusPanel: (reasoning, authLabel) => ({ title: "Status", lines: [reasoning.effort, authLabel] }),
  });
  const traceMode = createTraceModeBuiltinResult({
    line: "/minimal",
    traceMode: "minimal",
    state,
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    buildContextPanel,
  });
  const reasoning = resolveReasoningBuiltinResult({
    line: "/reasoning low",
    currentReasoning: supportedReasoning,
    modeDefaultReasoning: supportedReasoning,
    authLabel: "api-key-env",
    resolveReasoningCommand: () => ({
      nextReasoning: { ...supportedReasoning, effort: "low", source: "override" },
      message: "Reasoning set to low.",
    }),
    buildStatusPanel: (nextReasoning, authLabel) => ({ title: "Status", lines: [nextReasoning.effort, authLabel] }),
  });
  const model = resolveModelBuiltinResult({
    line: "/model gpt-4.1-mini",
    currentModel: "gpt-5.4",
    currentReasoning: supportedReasoning,
    modeDefaultReasoning: supportedReasoning,
    resolveModelCommand: () => ({
      nextModel: "gpt-4.1-mini",
      nextReasoning: {
        effort: "unsupported",
        source: "model-capability",
        support: { status: "unsupported", supportedEfforts: [] },
      },
      message: "Model set to gpt-4.1-mini. Reasoning unsupported.",
      panel: { title: "Models", lines: ["Current"] },
    }),
  });
  const authKey = createAuthKeyBuiltinResult("/auth key");
  const skills = createSkillsBuiltinResult("/skills", [{ name: "autopilot", path: "/skills/autopilot", scope: "project", summary: "Keep moving." }]);
  const loadedSkill = createLoadedSkillBuiltinResult("/skill analyze", {
    name: "analyze",
    path: "/skills/analyze",
    content: "# Analyze",
    attempts: [{ path: "/skills/analyze", ok: true }],
  });

  assert.deepEqual(help.entries, [
    { role: "user", text: "/help" },
    { role: "system", text: "Help shown." },
  ]);
  assert.equal(context.panel.title, "Context expanded");
  assert.deepEqual(status.panel.lines, ["high", "api-key-env"]);
  assert.equal(traceMode.patch.traceMode, "minimal");
  assert.deepEqual(reasoning.entries.at(-1), { role: "system", text: "Reasoning set to low." });
  assert.equal(reasoning.nextReasoning.effort, "low");
  assert.equal(model?.nextModel, "gpt-4.1-mini");
  assert.equal(model?.shouldUpdateRuntime, true);
  assert.equal(createToolsBuiltinResult("/tools", ["tool-a"]).at(-1)?.text, "tool-a");
  assert.equal(authKey.composerMode, "api-key-entry");
  assert.equal(skills.panel.title, "Skills");
  assert.equal(loadedSkill.panel.title, "Skill · analyze");
  assert.deepEqual(createSkillUsageErrorEntries("/skill").at(-1), {
    role: "system",
    text: "Usage: /skill <name>",
  });
  assert.deepEqual(createSkillLoadErrorEntries("/skill analyze", new Error("boom")).at(-1), {
    role: "system",
    text: "boom",
  });
  assert.deepEqual(
    createBuiltinStatusPanel({
      options: {
        provider: "openai",
        model: "gpt-5.4",
        mode: "default",
        authLabel: "api-key-env",
        reasoning: supportedReasoning,
        cwd: "/repo",
        contextSummaryLines: [],
      },
      stateModel: "gpt-4.1-mini",
      reasoning: supportedReasoning,
      authLabel: "oauth-file",
      buildStatusPanel: (options, reasoning, authLabel) => ({
        title: "Status",
        lines: [options.model, reasoning.effort, authLabel],
      }),
    }).lines,
    ["gpt-4.1-mini", "high", "oauth-file"],
  );
});

test("work-shell turn helpers build summaries and permission-stall continuations", async () => {
  assert.deepEqual(
    createChatPromptTurnInput({
      line: "review everything in this repo please",
      composer: {
        prompt: "review everything in this repo please",
        transcriptText: "review everything in this repo please",
        attachments: ["img-1"],
      },
    }),
    {
      transcriptText: "review everything in this repo please",
      prompt: "review everything in this repo please",
      attachments: ["img-1"],
      sessionSummary: "Chat: review everything in this repo please",
      failureSummary: "Chat failed: review everything in this repo please",
    },
  );
  assert.deepEqual(
    createPromptCommandTurnInput({
      transcriptText: "/review auth flow",
      prompt: "prompt-body",
      promptCommand: { kind: "review", focus: "auth flow" },
    }),
    {
      transcriptText: "/review auth flow",
      prompt: "prompt-body",
      sessionSummary: "Review: auth flow",
      failureSummary: "Review failed: auth flow",
    },
  );
  assert.match(
    createConversationTurnSummary({
      transcriptText: "question",
      assistantText: "answer",
    }),
    /^Q: question · A: answer/,
  );
  assert.equal(
    detectPermissionSeekingStall("Done.\n\nIf you want, I can continue."),
    true,
  );
  assert.equal(
    stripPermissionSeekingStallOutro("Done.\n\nIf you want, I can continue."),
    "Done.",
  );
  assert.match(
    buildPermissionStallContinuePrompt("finish cleanup", "Done."),
    /Continue automatically without asking for permission/,
  );
  assert.equal(
    await finalizeWorkShellAssistantReply({
      prompt: "finish cleanup",
      assistantText: "Done.\n\nIf you want, I can continue.",
      autoContinueOnPermissionStall: true,
      async runTurn() {
        return { text: "I continued automatically and completed the rest." };
      },
    }),
    "I continued automatically and completed the rest.",
  );
});

test("work-shell context helpers merge auth issues and assemble initial/reloaded context state", async () => {
  assert.deepEqual(
    applyAuthIssueLinesToContextSummaryLines(
      ["Auth issue: stale oauth", "Loaded guidance: AGENTS.md", "Other note"],
      ["Auth issue: saved OAuth needs refresh."],
    ),
    ["Auth issue: saved OAuth needs refresh.", "Loaded guidance: AGENTS.md", "Other note"],
  );
  assert.deepEqual(
    await loadInitialWorkShellContextState({
      cwd: "/repo",
      sessionId: "work-1",
      currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
      async listProjectBridgeLines() {
        return ["bridge-1"];
      },
      async listScopedMemoryLines() {
        return ["memory-1"];
      },
      buildContextPanel,
    }),
    {
      bridgeLines: ["bridge-1"],
      memoryLines: ["memory-1"],
      panel: {
        title: "Context",
        lines: ["Loaded guidance: AGENTS.md", "bridge-1", "memory-1"],
      },
    },
  );
  assert.deepEqual(
    await reloadWorkShellContextState({
      cwd: "/repo",
      sessionId: "work-1",
      currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
      reloadWorkspaceContext: async () => ["Loaded guidance: CLAUDE.md"],
      async listProjectBridgeLines() {
        return ["bridge-2"];
      },
      async listScopedMemoryLines() {
        return ["memory-2"];
      },
      traceLines: ["trace-1"],
      buildContextPanel,
    }),
    {
      contextSummaryLines: ["Loaded guidance: CLAUDE.md"],
      bridgeLines: ["bridge-2"],
      memoryLines: ["memory-2"],
      panel: {
        title: "Context",
        lines: ["Loaded guidance: CLAUDE.md", "bridge-2", "memory-2", "trace-1"],
      },
    },
  );
});

test("work-shell panel helpers assemble collapsed context, session panels, reload entries, and cancel/status views", async () => {
  const options = {
    provider: "openai",
    model: "gpt-5.4",
    mode: "default",
    authLabel: "oauth-file",
    reasoning: supportedReasoning,
    cwd: "/repo",
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
  };

  assert.deepEqual(createCollapsedContextPanel({
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    traceLines: ["trace-1"],
    buildContextPanel,
  }), {
    title: "Context",
    lines: ["Loaded guidance: AGENTS.md", "bridge-1", "memory-1", "trace-1"],
  });
  assert.deepEqual(createRecentSessionsLoadingPanel(), {
    title: "Recent sessions",
    lines: ["Loading sessions…"],
  });
  assert.deepEqual(createRecentSessionsPanel(["session-1"]), {
    title: "Recent sessions",
    lines: ["session-1"],
  });
  assert.deepEqual(
    await loadRecentSessionsPanel({
      cwd: "/repo",
      async listSessionLines() {
        return ["session-2"];
      },
    }),
    {
      title: "Recent sessions",
      lines: ["session-2"],
    },
  );
  assert.deepEqual(createWorkspaceReloadEntries("/reload"), [
    { role: "user", text: "/reload" },
    { role: "system", text: "Reloading workspace context…" },
  ]);
  assert.deepEqual(createWorkspaceReloadCompleteEntry(), {
    role: "system",
    text: "Workspace context reloaded.",
  });
  assert.deepEqual(createWorkShellStatusPanel({
    options,
    stateModel: "gpt-5.4-mini",
    reasoning: supportedReasoning,
    authLabel: "api-key-file",
    buildStatusPanel(nextOptions, reasoning, authLabel) {
      return { title: "Status", lines: [nextOptions.model, reasoning.effort, authLabel] };
    },
  }), {
    title: "Status",
    lines: ["gpt-5.4-mini", "high", "api-key-file"],
  });
  assert.deepEqual(createSensitiveInputCancelResult({
    options,
    stateModel: "gpt-5.4-mini",
    reasoning: supportedReasoning,
    authLabel: "api-key-file",
    buildStatusPanel(nextOptions, reasoning, authLabel) {
      return { title: "Status", lines: [nextOptions.model, reasoning.effort, authLabel] };
    },
  }), {
    entries: [{ role: "system", text: "API key entry canceled." }],
    composerMode: "default",
    panel: {
      title: "Status",
      lines: ["gpt-5.4-mini", "high", "api-key-file"],
    },
  });
});

test("work-shell execution helpers assemble start, success, failure, and finalize state patches", async () => {
  const success = await runPromptTurnSuccessSequence({
    prompt: "finish cleanup",
    transcriptText: "finish cleanup",
    attachments: ["img-1"],
    turnStartedAt: Date.now() - 5,
    autoContinueOnPermissionStall: true,
    async runAgentTurn(prompt, attachments) {
      assert.equal(prompt, "finish cleanup");
      assert.deepEqual(attachments, ["img-1"]);
      return { text: "Done." };
    },
    cwd: "/repo",
    sessionId: "work-1",
    currentBridgeLines: ["bridge-0"],
    async publishContextBridge({ summary }) {
      return { bridgeId: "bridge-1", line: `bridge ${summary}` };
    },
    async writeScopedMemory() {
      return { memoryId: "memory-1" };
    },
    async listScopedMemoryLines() {
      return ["memory-1 line"];
    },
  });
  const failure = await resolvePromptTurnFailureResult({
    error: new Error("request failed with status 401"),
    currentAuthLabel: "oauth-file",
    turnStartedAt: Date.now() - 5,
    refreshAuthState: async () => ({ authLabel: "api-key-file", authIssueLines: [] }),
    formatWorkShellError: (message) => `ERR:${message}`,
  });
  const state = createState({
    authLabel: "oauth-file",
    bridgeLines: ["bridge-0"],
    memoryLines: ["memory-0"],
    isBusy: true,
    currentTurnStartedAt: 10,
  });

  assert.equal(success.assistantText, "Done.");
  assert.equal(success.postTurnEffects.bridgeTraceEvent.type, "bridge.published");
  assert.equal(success.postTurnEffects.memoryTraceEvent.type, "memory.written");
  assert.equal(failure.formattedMessage, "ERR:request failed with status 401");
  assert.equal(failure.nextAuthLabel, "api-key-file");
  assert.equal(failure.isAuthFailure, true);

  assert.deepEqual(createPromptTurnStartPatch({ state, turnStartedAt: 42 }), {
    isBusy: true,
    busyStatus: "thinking",
    currentTurnStartedAt: 42,
  });
  assert.deepEqual(createPromptTurnSuccessPatch({
    state,
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    lastTurnDurationMs: 123,
  }), {
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    lastTurnDurationMs: 123,
  });
  assert.deepEqual(createPromptTurnFailurePatch({
    state,
    nextAuthLabel: "api-key-file",
    lastTurnDurationMs: 456,
    isAuthFailure: true,
    statusPanel: { title: "Status", lines: ["auth:api-key-file"] },
  }), {
    authLabel: "api-key-file",
    currentTurnStartedAt: undefined,
    lastTurnDurationMs: 456,
    panel: { title: "Status", lines: ["auth:api-key-file"] },
  });
  assert.deepEqual(createPromptTurnFinalizePatch({ state }), {
    isBusy: false,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
  });
});

test("work-shell operational helpers resolve secure auth entry, inline command results, and memory operations", async () => {
  const memoryPanel = await loadWorkShellMemoriesPanel({
    cwd: "/repo",
    sessionId: "work-1",
    async listScopedMemoryLines({ scope }) {
      return scope === "session" ? ["session-1"] : ["project-1"];
    },
  });
  const rememberResult = await writeWorkShellRememberCommand({
    command: { scope: "session", summary: "keep auth fix visible" },
    cwd: "/repo",
    sessionId: "work-1",
    async writeScopedMemory({ scope, summary }) {
      return { memoryId: `${scope}:${summary}` };
    },
    async listScopedMemoryLines() {
      return ["session-1", "session-2"];
    },
    formatAgentTraceLine(event) {
      return `memory ${event.summary}`;
    },
  });
  const appliedAuthIssues = [];
  const secureResult = await resolveSecureApiKeyEntrySubmission({
    line: "sk-secret-123 --org demo",
    currentAuthLabel: "api-key-env",
    saveApiKeyAuth: async () => ["API key login saved.", "Auth: api-key-file"],
    refreshAuthState: async () => ({ authLabel: "api-key-file", authIssueLines: [] }),
    extractAuthLabel: (lines) => lines[1]?.replace(/^Auth:\s*/, ""),
    applyAuthIssueLines: (lines) => appliedAuthIssues.push(...(lines ?? [])),
    formatWorkShellError: (message) => `ERR:${message}`,
  });
  const inlineProgress = [];
  const inlineResult = await resolveInlineOperationalCommandResult({
    line: "/auth login --api-key sk-secret-123",
    slashCommand: ["auth", "login", "--api-key", "sk-secret-123"],
    currentAuthLabel: "api-key-env",
    async resolveWorkShellInlineCommand(_args, _runInlineCommand, onProgress) {
      onProgress?.("Opening browser…");
      onProgress?.("Enter code: ABCD-1234");
      return { lines: ["OAuth login complete.", "Auth: oauth-file"], failed: false };
    },
    async runInlineCommand() {
      return [];
    },
    refreshAuthState: async () => ({ authLabel: "oauth-file", authIssueLines: ["Auth issue cleared."] }),
    extractAuthLabel: (lines) => lines[1]?.replace(/^Auth:\s*/, ""),
    applyAuthIssueLines: (lines) => appliedAuthIssues.push(...(lines ?? [])),
    onAuthProgressLines: (lines) => inlineProgress.push(lines),
  });

  assert.deepEqual(memoryPanel, {
    sessionMemory: ["session-1"],
    projectMemory: ["project-1"],
  });
  assert.deepEqual(rememberResult, {
    nextMemoryLines: ["session-1", "session-2"],
    memoryTrace: "memory keep auth fix visible",
  });
  assert.deepEqual(secureResult, {
    kind: "success",
    resultLines: ["API key login saved.", "Auth: api-key-file"],
    nextAuthLabel: "api-key-file",
  });
  assert.equal(inlineResult.visibleLine, "/auth login --api-key [REDACTED]");
  assert.deepEqual(inlineResult.visibleArgs, ["auth", "login", "--api-key", "[REDACTED]"]);
  assert.equal(inlineResult.completionLine, "✓ auth login --api-key [REDACTED]");
  assert.equal(inlineResult.nextAuthLabel, "oauth-file");
  assert.deepEqual(inlineProgress.at(-1), ["Enter code: ABCD-1234", "Opening browser…"]);
  assert.deepEqual(appliedAuthIssues, ["Auth issue cleared."]);
});

test("work-shell post-turn helpers persist summaries and auth recovery deterministically", async () => {
  const refreshedAuthIssues = [];
  const effects = await runWorkShellPostTurnSuccessEffects({
    cwd: "/repo",
    transcriptText: "hello",
    assistantText: "world",
    sessionId: "work-1",
    currentBridgeLines: ["bridge-0"],
    async publishContextBridge() {
      return { bridgeId: "bridge-1", line: "bridge-1 line" };
    },
    async writeScopedMemory() {
      return { memoryId: "memory-1" };
    },
    async listScopedMemoryLines() {
      return ["memory-1 line"];
    },
  });
  const authLabel = await resolveWorkShellFailureAuthLabel({
    message: "request failed with status 401",
    currentAuthLabel: "oauth-file",
    async refreshAuthState() {
      return { authLabel: "api-key-file", authIssueLines: ["Auth issue: saved OAuth needs refresh."] };
    },
    applyAuthIssueLines(lines) {
      refreshedAuthIssues.push(...(lines ?? []));
    },
  });

  assert.equal(isWorkShellAuthFailure("request failed with status 401"), true);
  assert.deepEqual(effects.bridgeLines, ["bridge-1 line", "bridge-0"]);
  assert.deepEqual(effects.memoryLines, ["memory-1 line"]);
  assert.equal(effects.bridgeTraceEvent.type, "bridge.published");
  assert.equal(effects.memoryTraceEvent.type, "memory.written");
  assert.equal(authLabel, "api-key-file");
  assert.deepEqual(refreshedAuthIssues, ["Auth issue: saved OAuth needs refresh."]);
});

test("work-shell trace helpers derive busy status, state patches, and transcript roles honestly", () => {
  assert.equal(
    resolveBusyStatusFromTraceEvent({ type: "turn.started" }, "thinking inspect repo"),
    "thinking inspect repo",
  );
  assert.equal(
    resolveBusyStatusFromTraceEvent({ type: "orchestrator.step", status: "running" }, "executor inspect login.ts"),
    "executor inspect login.ts",
  );
  assert.equal(
    resolveBusyStatusFromTraceEvent({ type: "turn.completed" }, "done 123"),
    undefined,
  );
  const state = createState({ isBusy: true, currentTurnStartedAt: 10 });
  assert.deepEqual(
    createTraceEventBusyPatch({
      state,
      event: { type: "turn.started", startedAt: 42 },
      line: "thinking inspect repo",
    }),
    {
      isBusy: true,
      busyStatus: "thinking inspect repo",
      currentTurnStartedAt: 42,
    },
  );
  assert.deepEqual(
    resolveVerboseTraceEntry({
      traceMode: "verbose",
      event: { type: "provider.calling" },
      line: "calling openai gpt-5.4",
    }),
    { role: "tool", text: "calling openai gpt-5.4" },
  );
  assert.equal(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "provider.calling" },
      line: "calling openai gpt-5.4",
    }),
    undefined,
  );
  assert.equal(resolveTraceEntryRole({ type: "turn.started" }), "system");
  assert.equal(resolveTraceEntryRole({ type: "provider.calling" }), "tool");
  assert.equal(extractCurrentTurnStartedAt({ type: "turn.started", startedAt: 123 }), 123);
  assert.equal(extractCurrentTurnStartedAt({ type: "tool.started", startedAt: 123 }), undefined);
});

test("work-shell persistence helpers build snapshot payloads and reload context state", async () => {
  const snapshot = createWorkShellSessionSnapshotInput({
    cwd: "/repo",
    sessionId: "work-1",
    model: "gpt-5.4",
    mode: "default",
    state: "idle",
    summary: "Chat: hello",
    traceMode: "minimal",
  });
  const context = await loadWorkShellContextState({
    cwd: "/repo",
    sessionId: "work-1",
    currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
    reloadWorkspaceContext: async () => ["Loaded guidance: CLAUDE.md"],
    listProjectBridgeLines: async () => ["bridge-1"],
    listScopedMemoryLines: async () => ["memory-1"],
  });

  assert.equal(snapshot.sessionId, "work-1");
  assert.deepEqual(context, {
    contextSummaryLines: ["Loaded guidance: CLAUDE.md"],
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
  });
});

test("createInitialWorkShellEngineState derives the shell defaults from options", () => {
  const state = createInitialWorkShellEngineState({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "ultrawork",
      authLabel: "oauth-file",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    buildContextPanel,
  });

  assert.equal(state.panel.title, "Context");
  assert.equal(state.traceMode, "verbose");
  assert.equal(state.authLabel, "oauth-file");
  assert.deepEqual(state.entries, []);
});

test("work-shell state helpers append entries and update auth/busy transitions deterministically", () => {
  const state = createState();
  const withEntries = { ...state, ...appendWorkShellEntries(state, { role: "system", text: "hello" }) };
  const withAuth = { ...withEntries, ...createWorkShellAuthStatePatch({ state: withEntries, authLabel: "oauth-file", authLauncherLines: ["Saved auth found."] }) };
  const withBusy = {
    ...withAuth,
    ...createWorkShellBusyStatePatch({
      state: withAuth,
      isBusy: true,
      busyStatus: "thinking",
      currentTurnStartedAt: 123,
    }),
  };

  assert.deepEqual(withEntries.entries, [{ role: "system", text: "hello" }]);
  assert.equal(withAuth.authLabel, "oauth-file");
  assert.deepEqual(withAuth.authLauncherLines, ["Saved auth found."]);
  assert.equal(withBusy.isBusy, true);
  assert.equal(withBusy.busyStatus, "thinking");
  assert.equal(withBusy.currentTurnStartedAt, 123);
});

test("work-shell state helpers update trace mode and trace lines without mutating pinned panels", () => {
  const state = createState({
    panel: { title: "Status", lines: ["model:gpt-5.4"] },
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    traceLines: ["old trace"],
  });

  const minimal = {
    ...state,
    ...createWorkShellTraceModePatch({
      state,
      traceMode: "minimal",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      buildContextPanel,
    }),
  };
  const traced = {
    ...state,
    ...createWorkShellTraceLinePatch({
      state,
      line: "new trace",
      preservePanel: false,
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      buildContextPanel,
    }),
  };

  assert.equal(minimal.traceMode, "minimal");
  assert.deepEqual(minimal.traceLines, []);
  assert.equal(minimal.panel.title, "Context");
  assert.deepEqual(traced.traceLines, ["new trace", "old trace"]);
  assert.equal(traced.panel.title, "Status");
});

test("createWorkShellPaneRuntime builds shared engine and slash runtime helpers", () => {
  const { input } = createEngineInput();
  const runtime = createWorkShellPaneRuntime({
    ...input,
    buildStatusPanel: ({ reasoning, authLabel }) =>
      input.buildStatusPanel(input.options, reasoning, authLabel),
    resolveWorkShellSlashCommand: (value, options) =>
      input.resolveWorkShellSlashCommand(value, options),
    ...(input.refineInlineCommandResultLines
      ? {
          refineInlineCommandResultLines: ({ args, lines, failed, authLabel }) =>
            input.refineInlineCommandResultLines?.({
              args,
              lines,
              failed,
              authLabel,
            }) ?? lines,
        }
      : {}),
    userHomeDir: "/tmp/home-a",
    browserOAuthAvailable: true,
  });

  assert.ok(runtime.engine instanceof WorkShellEngine);
  assert.equal(runtime.browserOAuthAvailable, true);
  assert.equal(runtime.engine.getState().authLabel, "api-key-env");
  assert.deepEqual(runtime.getSuggestions("/doctor").map((item) => item.command), ["/doctor"]);
  assert.equal(runtime.shouldBlockSlashSubmit("/auth"), true);
});

test("createWorkShellEngine builds a real shared engine instance", () => {
  const { input } = createEngineInput();
  const engine = createWorkShellEngine({
    ...input,
    buildStatusPanel: ({ reasoning, authLabel }) =>
      input.buildStatusPanel(input.options, reasoning, authLabel),
    resolveWorkShellSlashCommand: (value) => input.resolveWorkShellSlashCommand(value),
    ...(input.refineInlineCommandResultLines
      ? {
          refineInlineCommandResultLines: ({ args, lines, failed, authLabel }) =>
            input.refineInlineCommandResultLines?.({
              args,
              lines,
              failed,
              authLabel,
            }) ?? lines,
        }
      : {}),
  });

  assert.ok(engine instanceof WorkShellEngine);
  assert.equal(engine.getState().authLabel, "api-key-env");
  assert.equal(engine.getState().panel.title, "Context");
  assert.deepEqual(engine.getState().entries, []);
});

test("WorkShellEngine handles /clear without UI-owned business logic", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/clear");

  assert.equal(calls.clear, 1);
  assert.deepEqual(engine.getState().entries, [{ role: "system", text: "Conversation cleared." }]);
});

test("WorkShellEngine applies /reasoning updates and syncs agent runtime settings", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/reasoning low");

  assert.equal(engine.getState().reasoning.effort, "low");
  assert.equal(calls.runtimeSettings.length, 1);
  assert.equal(calls.runtimeSettings[0]?.reasoning?.effort, "low");
  assert.equal(engine.getState().panel.title, "Status");
});

test("WorkShellEngine applies /model updates and syncs model plus reasoning runtime settings", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/model gpt-4.1-mini");

  assert.equal(engine.getState().model, "gpt-4.1-mini");
  assert.equal(engine.getState().reasoning.effort, "unsupported");
  assert.equal(calls.runtimeSettings.length, 1);
  assert.equal(calls.runtimeSettings[0]?.model, "gpt-4.1-mini");
  assert.equal(calls.runtimeSettings[0]?.reasoning?.effort, "unsupported");
  assert.equal(engine.getState().panel.title, "Models");
});

test("WorkShellEngine opens /context as an overlay and can dismiss it", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/context");

  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.ok(engine.getState().entries.some((entry) => entry.text === "Context shown."));

  engine.closeOverlay();

  assert.equal(engine.getState().panel.title, "Context");
});

test("WorkShellEngine runs inline commands directly and updates auth label from results", async () => {
  const { engine, calls } = createEngine({
    extractAuthLabel(lines) {
      return lines[1]?.replace(/^Auth:\s*/, "") ?? undefined;
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/doctor");

  assert.deepEqual(calls.inline, [["doctor"]]);
  assert.equal(engine.getState().panel.title, "doctor");
  assert.equal(engine.getState().authLabel, "oauth-file");
  assert.ok(engine.getState().entries.some((entry) => entry.text.includes("doctor :: Doctor report")));
});

test("WorkShellEngine redacts api-key slash secrets from transcript and panels", async () => {
  const { engine } = createEngine({
    resolveWorkShellSlashCommand(input) {
      return input === "/auth login --api-key sk-secret-123 --org org_demo"
        ? ["auth", "login", "--api-key", "sk-secret-123", "--org", "org_demo"]
        : undefined;
    },
    async runInlineCommand() {
      return ["API key login saved.", "Auth: api-key-file"];
    },
    extractAuthLabel(lines) {
      return lines[1]?.replace(/^Auth:\s*/, "") ?? undefined;
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/auth login --api-key sk-secret-123 --org org_demo");

  const allVisibleText = [
    engine.getState().panel.title,
    ...engine.getState().panel.lines,
    ...engine.getState().entries.map((entry) => entry.text),
  ].join("\n");

  assert.doesNotMatch(allVisibleText, /sk-secret-123/);
  assert.match(allVisibleText, /\[REDACTED\]/);
  assert.equal(engine.getState().authLabel, "api-key-file");
});

test("WorkShellEngine opens secure api-key entry and saves without leaking the secret", async () => {
  const { engine, calls } = createEngine({
    extractAuthLabel(lines) {
      return lines[1]?.replace(/^Auth:\s*/, "") ?? undefined;
    },
    async refreshAuthState() {
      calls.refreshedAuth += 1;
      return { authLabel: "api-key-file" };
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/auth key");

  assert.equal(engine.getState().composerMode, "api-key-entry");
  assert.equal(engine.getState().panel.title, "Auth");
  assert.ok(engine.getState().panel.lines.includes("Secure API key entry."));

  await engine.handleSubmit("sk-secret-123 --org org_demo --project proj_demo");

  assert.deepEqual(calls.secureAuth, ["sk-secret-123 --org org_demo --project proj_demo"]);
  assert.equal(calls.refreshedAuth, 1);
  assert.equal(engine.getState().composerMode, "default");
  assert.equal(engine.getState().authLabel, "api-key-file");

  const allVisibleText = [
    engine.getState().panel.title,
    ...engine.getState().panel.lines,
    ...engine.getState().entries.map((entry) => entry.text),
  ].join("\n");

  assert.doesNotMatch(allVisibleText, /sk-secret-123/);
  assert.match(allVisibleText, /✓ auth key/);
  assert.match(allVisibleText, /API key login saved\./);
});

test("WorkShellEngine refreshes runtime auth after inline auth commands", async () => {
  const { engine, calls } = createEngine({
    resolveWorkShellSlashCommand(input) {
      return input === "/auth login" ? ["auth", "login", "--browser"] : undefined;
    },
    async resolveWorkShellInlineCommand() {
      return { lines: ["Saved auth found.", "Auth: oauth-file"], failed: false };
    },
    async refreshAuthState() {
      calls.refreshedAuth += 1;
      return { authLabel: "oauth-file", authIssueLines: [] };
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/auth login");

  assert.equal(calls.refreshedAuth, 1);
  assert.equal(engine.getState().authLabel, "oauth-file");
  assert.equal(engine.getState().entries.filter((entry) => entry.role === "tool").length, 1);
  assert.ok(engine.getState().entries.some((entry) => entry.text.includes("✓ auth login --browser")));
});

test("WorkShellEngine clears stale auth issue context after auth recovers", async () => {
  const { engine } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "oauth-file",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: [
        "Auth issue: saved OAuth needs refresh.",
        "Loaded guidance: AGENTS.md",
      ],
    },
    resolveWorkShellSlashCommand(input) {
      return input === "/auth login" ? ["auth", "login", "--browser"] : undefined;
    },
    async resolveWorkShellInlineCommand() {
      return { lines: ["OAuth login complete.", "Auth: oauth-file"], failed: false };
    },
    async refreshAuthState() {
      return { authLabel: "oauth-file", authIssueLines: [] };
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/auth login");
  await engine.handleSubmit("/context");

  const contextText = engine.getState().panel.lines.join("\n");
  assert.doesNotMatch(contextText, /Auth issue:/);
  assert.match(contextText, /Loaded guidance: AGENTS\.md/);
});

test("WorkShellEngine shows auth progress while inline oauth is pending", async () => {
  let resolveInline;
  const inlinePromise = new Promise((resolve) => {
    resolveInline = resolve;
  });
  const { engine } = createEngine({
    resolveWorkShellSlashCommand(input) {
      return input === "/auth login" ? ["auth", "login"] : undefined;
    },
    async resolveWorkShellInlineCommand(_args, _runInlineCommand, onProgress) {
      onProgress?.("Opening browser…");
      onProgress?.("Enter code: ABCD-1234");
      onProgress?.("Waiting for device approval…");
      return inlinePromise;
    },
  });

  await engine.initialize();
  const pending = engine.handleSubmit("/auth login");
  await Promise.resolve();

  assert.equal(engine.getState().panel.title, "Auth");
  assert.deepEqual(engine.getState().panel.lines, [
    "Enter code: ABCD-1234",
    "Waiting for device approval…",
    "Opening browser…",
  ]);

  resolveInline({ lines: ["OAuth login complete.", "Auth: oauth-file", "Route: device-oauth"], failed: false });
  await pending;

  assert.equal(engine.getState().panel.title, "auth login");
  assert.equal(engine.getState().panel.lines[0], "OAuth login complete.");
});

test("WorkShellEngine cancels secure api-key entry without opening sessions", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/auth key");
  engine.cancelSensitiveInput();

  assert.equal(engine.getState().composerMode, "default");
  assert.equal(engine.getState().panel.title, "Status");
  assert.ok(engine.getState().entries.some((entry) => entry.text === "API key entry canceled."));
});

test("WorkShellEngine can refine inline auth failures into product guidance", async () => {
  const { engine } = createEngine({
    resolveWorkShellSlashCommand(input) {
      return input === "/auth login" ? ["auth", "login", "--browser"] : undefined;
    },
    async resolveWorkShellInlineCommand() {
      return { lines: ["Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID."], failed: true };
    },
    refineInlineCommandResultLines({ args, lines, failed, authLabel }) {
      assert.deepEqual(args, ["auth", "login", "--browser"]);
      assert.equal(failed, true);
      assert.equal(authLabel, "api-key-env");
      assert.deepEqual(lines, ["Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID."]);
      return ["Signed in · API key · env", "Browser OAuth is separate."];
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/auth login");

  assert.equal(engine.getState().panel.title, "auth login --browser");
  assert.deepEqual(engine.getState().panel.lines, ["Signed in · API key · env", "Browser OAuth is separate."]);
});

test("WorkShellEngine remembers refined auth status guidance for later launcher use", async () => {
  const { engine } = createEngine({
    resolveWorkShellSlashCommand(input) {
      return input === "/auth status" ? ["auth", "status"] : undefined;
    },
    async resolveWorkShellInlineCommand() {
      return {
        lines: [
          "provider: openai",
          "source: oauth-file",
          "auth: oauth",
          "expiresAt: refresh-required",
          "expired: yes",
        ],
        failed: false,
      };
    },
    refineInlineCommandResultLines() {
      return [
        "Current",
        "Signed in · Browser OAuth · file",
        "Browser OAuth needs refresh.",
        "",
        "Next",
        "Use /auth login to refresh in this shell.",
      ];
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/auth status");

  assert.deepEqual(engine.getState().authLauncherLines, [
    "Current",
    "Signed in · Browser OAuth · file",
    "Browser OAuth needs refresh.",
    "",
    "Next",
    "Use /auth login to refresh in this shell.",
  ]);
});

test("WorkShellEngine keeps skill summaries visible in the skills panel", async () => {
  const { engine } = createEngine({
    listAvailableSkills: async () => [
      { name: "autopilot", path: "/skills/autopilot", scope: "project", summary: "Keep moving." },
    ],
  });

  await engine.initialize();
  await engine.handleSubmit("/skills");

  assert.equal(engine.getState().panel.title, "Skills");
  assert.deepEqual(engine.getState().panel.lines, ["autopilot · project", "  Keep moving."]);
});

test("WorkShellEngine turns /review into a focused review prompt", async () => {
  const prompts = [];
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        return { text: "review-result" };
      },
    },
    resolveWorkShellSlashCommand(input) {
      return input === "/review auth flow" ? ["prompt", "review", "auth", "flow"] : undefined;
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/review auth flow");

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Review the current repository changes and implementation/);
  assert.match(prompts[0] ?? "", /Focus request: auth flow/);
  assert.ok(engine.getState().entries.some((entry) => entry.role === "assistant" && entry.text === "review-result"));
});

test("WorkShellEngine turns /commit into a Lore-protocol commit prompt", async () => {
  const prompts = [];
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        return { text: "commit-result" };
      },
    },
    resolveWorkShellSlashCommand(input) {
      return input === "/commit auth flow cleanup" ? ["prompt", "commit", "auth", "flow", "cleanup"] : undefined;
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/commit auth flow cleanup");

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Draft a single git commit message using the Lore protocol/);
  assert.match(prompts[0] ?? "", /Focus request: auth flow cleanup/);
  assert.match(prompts[0] ?? "", /Constraint:/);
  assert.match(prompts[0] ?? "", /Tested:/);
  assert.ok(engine.getState().entries.some((entry) => entry.role === "assistant" && entry.text === "commit-result"));
});

test("WorkShellEngine can execute /research topics through the inline action lane", async () => {
  const { engine, calls } = createEngine({
    resolveWorkShellSlashCommand(input) {
      return input === "/research current workspace" ? ["research", "run", "current", "workspace"] : undefined;
    },
    async runInlineCommand(args) {
      calls.inline.push(args);
      return ["Research completed", "Artifact: /tmp/research.md"];
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/research current workspace");

  assert.deepEqual(calls.inline, [["research", "run", "current", "workspace"]]);
  assert.equal(engine.getState().panel.title, "research run current workspace");
  assert.ok(engine.getState().entries.some((entry) => entry.text.includes("Research completed")));
});

test("WorkShellEngine shows memories and records /remember through the local command seam", async () => {
  const writes = [];
  const { engine } = createEngine({
    sessionId: "work-shell-test-session",
    async listScopedMemoryLines({ scope }) {
      return scope === "session" ? ["session memory"] : ["project memory"];
    },
    async writeScopedMemory(input) {
      writes.push(input);
      return { memoryId: `${input.scope}:${input.summary}` };
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/memories");

  assert.equal(engine.getState().panel.title, "Memories");
  assert.deepEqual(engine.getState().panel.lines, [
    "Session",
    "session memory",
    "",
    "Project",
    "project memory",
  ]);

  await engine.handleSubmit("/remember session keep auth fix visible");

  assert.deepEqual(writes, [{
    scope: "session",
    cwd: "/repo",
    summary: "keep auth fix visible",
    sessionId: "work-shell-test-session",
    agentId: "work-shell",
  }]);
  assert.ok(engine.getState().entries.some((entry) => entry.role === "tool" && /memory keep auth fix visible/.test(entry.text)));
});

test("WorkShellEngine reloads workspace context on demand", async () => {
  const { engine } = createEngine({
    reloadWorkspaceContext: async () => ["Loaded guidance: CLAUDE.md", "Loaded extension: focus-tools"],
    async listProjectBridgeLines() {
      return ["bridge refreshed"];
    },
    async listScopedMemoryLines() {
      return ["memory refreshed"];
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/reload");

  assert.equal(engine.getState().panel.title, "Context");
  assert.deepEqual(engine.getState().panel.lines, [
    "Loaded guidance: CLAUDE.md",
    "Loaded extension: focus-tools",
    "bridge refreshed",
    "memory refreshed",
  ]);
  assert.ok(engine.getState().entries.some((entry) => entry.text === "Workspace context reloaded."));
});

test("WorkShellEngine starts in minimal trace mode for default sessions", async () => {
  const { engine, emitTrace } = createEngine();

  await engine.initialize();
  emitTrace({
    type: "orchestrator.step",
    role: "executor",
    status: "running",
    summary: "Inspect login.ts",
  });

  assert.equal(engine.getState().traceMode, "minimal");
  assert.deepEqual(engine.getState().traceLines, []);
});

test("WorkShellEngine keeps a lightweight busy status even outside verbose trace mode", async () => {
  const { engine, emitTrace } = createEngine();

  await engine.initialize();
  emitTrace({
    type: "turn.started",
    provider: "openai",
    model: "gpt-5.4",
    prompt: "inspect repo",
    startedAt: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(engine.getState().busyStatus ?? "", /thinking/i);
  assert.equal(typeof engine.getState().currentTurnStartedAt, "number");
  assert.equal(engine.getState().traceLines.length, 0);
});

test("WorkShellEngine can switch to verbose trace mode explicitly", async () => {
  const { engine, calls, emitTrace } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/verbose");
  emitTrace({
    type: "orchestrator.step",
    role: "executor",
    status: "running",
    summary: "Inspect login.ts",
  });

  assert.equal(engine.getState().traceMode, "verbose");
  assert.ok(engine.getState().traceLines.some((line) => /Inspect login.ts/.test(line)));
  assert.equal(calls.snapshots.at(-1)?.traceMode, "verbose");
});

test("WorkShellEngine can restore a persisted trace mode for a resumed work session", async () => {
  const { engine } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      initialTraceMode: "verbose",
    },
  });

  await engine.initialize();

  assert.equal(engine.getState().traceMode, "verbose");
});

test("WorkShellEngine keeps automatic bridge and memory bookkeeping out of the conversation transcript", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("hello");

  assert.deepEqual(
    engine.getState().entries.map((entry) => entry.role),
    ["user", "assistant"],
  );
  assert.equal(typeof engine.getState().lastTurnDurationMs, "number");
  assert.ok((engine.getState().lastTurnDurationMs ?? 0) >= 0);
  assert.ok(engine.getState().traceLines.some((line) => line.startsWith("bridge ")));
  assert.ok(engine.getState().traceLines.some((line) => line.startsWith("memory ")));
});

test("WorkShellEngine trims permission-seeking stall outros from assistant replies", async () => {
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn() {
        return {
          text: "Implemented the refactor and verified the tests pass.\n\nIf you want, I can keep going and clean up the remaining files.",
        };
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("finish the refactor");

  const assistantEntry = engine.getState().entries.findLast((entry) => entry.role === "assistant");
  assert.equal(assistantEntry?.text, "Implemented the refactor and verified the tests pass.");
});

test("WorkShellEngine can inject a continue follow-up when a reply stalls on permission-seeking language", async () => {
  const prompts = [];
  const { engine } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      autoContinueOnPermissionStall: true,
    },
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { text: "I finished the first pass. If you want, I can continue with the remaining cleanup." };
        }
        return { text: "I continued automatically and completed the remaining cleanup." };
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("finish the cleanup");

  const assistantEntries = engine.getState().entries.filter((entry) => entry.role === "assistant");
  assert.deepEqual(assistantEntries.map((entry) => entry.text), ["I continued automatically and completed the remaining cleanup."]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Continue automatically without asking for permission/i);
});
