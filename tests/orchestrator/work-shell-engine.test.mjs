import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkShellEngine,
  createWorkShellEngine,
  createWorkShellInteractionBridge,
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
  resolveQueueBlockedReason,
  resolveReasoningBuiltinResult,
  buildWorkShellQueueBuiltinInput,
} from "../../packages/orchestrator/src/work-shell-engine-builtins.ts";
import { executeWorkShellBuiltinSubmit } from "../../packages/orchestrator/src/work-shell-engine-builtin-runtime.ts";
import {
  executeInlineCommandSubmit,
  executeLocalCommandSubmit,
  executeSecureApiKeyEntrySubmit,
} from "../../packages/orchestrator/src/work-shell-engine-command-runtime.ts";
import {
  buildAuthProgressPanelLines,
  buildPromptCommandPrompt,
  createAuthLoginPendingPanel,
  createLoadedSkillPanel,
  createHarnessPanel,
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
  executeWorkShellPromptTurn,
  resolvePromptTurnFailurePayload,
  resolvePromptTurnFailureResult,
  resolvePromptTurnFinalizePatch,
  resolvePromptTurnStartPatch,
  resolvePromptTurnSuccessPayload,
  runPromptTurnSuccessSequence,
} from "../../packages/orchestrator/src/work-shell-engine-execution.ts";
import {
  executeWorkShellChatSubmit,
  executeWorkShellPromptCommandSubmit,
} from "../../packages/orchestrator/src/work-shell-engine-prompt-runtime.ts";
import {
  applyAuthIssueLinesToContextSummaryLines,
  loadInitialWorkShellContextState,
  loadWorkShellContextState,
  reloadWorkShellContextState,
} from "../../packages/orchestrator/src/work-shell-engine-context.ts";
import {
  createOpenSessionsFailurePanel,
  createOpenSessionsLoadingPanel,
  loadInitialWorkShellLifecycleState as loadWorkShellLifecycleState,
  loadOpenSessionsLoadedPanel,
  loadOpenSessionsPanelState,
  resolveCloseOverlayState,
  resolveSensitiveInputCancelState,
} from "../../packages/orchestrator/src/work-shell-engine-lifecycle.ts";
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
import { createWorkShellSessionSnapshotInput } from "../../packages/orchestrator/src/work-shell-engine-persistence.ts";
import {
  isWorkShellAuthFailure,
  resolveWorkShellPostTurnSuccessEffectsPayload,
  resolveWorkShellFailureAuthLabel,
  runWorkShellPostTurnSuccessEffects,
} from "../../packages/orchestrator/src/work-shell-engine-post-turns.ts";
import {
  applyWorkShellTraceEvent,
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
  detectEditIntent,
  detectPermissionSeekingStall,
  finalizeWorkShellAssistantReply,
  resolveReadOnlyModeGuard,
  sanitizeWorkShellAssistantText,
  stripPermissionSeekingStallOutro,
} from "../../packages/orchestrator/src/work-shell-engine-turns.ts";

import {
  parallelModeKoreanCleanResponseText,
  parallelModeKoreanLeakyResponseText,
} from "../../scripts/runtime-qa/constants.mjs";
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
    modeUpdates: [],
    secureAuth: [],
    turns: [],
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
    updateMode(mode) {
      calls.modeUpdates.push(mode);
    },
    setTraceListener(listener) {
      calls.traceListener = listener;
    },
    async runTurn(prompt) {
      calls.turns.push(prompt);
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
            message: "Reasoning · Light selected.",
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
  assert.deepEqual(resolveWorkShellBuiltinCommand("/queue"), { kind: "queue" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/queue clear"), { kind: "queue-clear" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/cancel"), { kind: "cancel" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/harness"), { kind: "harness" });
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
  const harnessPanel = createHarnessPanel({ mode: "yolo", workerBudget: 4, autoContinue: true });
  assert.equal(harnessPanel.title, "Harness");
  assert.ok(harnessPanel.lines.some((l) => l.includes("yolo")));
  assert.ok(harnessPanel.lines.some((l) => l.includes("4 max")));
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
  assert.deepEqual(
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
    value: "/queue clear",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  }), {
    kind: "builtin",
    line: "/queue clear",
    command: { kind: "queue-clear" },
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/review auth flow",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => {
      throw new Error("Rust-owned prompt routes should not need TS re-resolution");
    },
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
    resolveWorkShellSlashCommand: () => {
      throw new Error("Rust-owned local routes should not need TS re-resolution");
    },
    hasInlineCommandRunner: false,
  }), {
    kind: "local-command",
    line: "/remember session keep this",
    localCommand: { kind: "remember", scope: "session", summary: "keep this" },
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/focus",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => ["doctor"],
    hasInlineCommandRunner: true,
  }), {
    kind: "inline-command",
    line: "/focus",
    slashCommand: ["doctor"],
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/modl",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  }), {
    kind: "builtin",
    line: "/modl",
    command: { kind: "unknown-slash", line: "/modl", suggestion: "/model" },
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/stpo",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  }), {
    kind: "builtin",
    line: "/stpo",
    command: { kind: "unknown-slash", line: "/stpo", suggestion: "/stop" },
  });
  assert.deepEqual(resolveWorkShellSubmitRoute({
    value: "/mmbrige",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  }), {
    kind: "builtin",
    line: "/mmbrige",
    command: { kind: "unknown-slash", line: "/mmbrige", suggestion: "/mmbridge" },
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
  assert.equal(
    resolveWorkShellSubmitRoute({
      value: "second submit while busy",
      isBusy: true,
      composerMode: "default",
      resolveWorkShellSlashCommand: () => undefined,
      hasInlineCommandRunner: true,
    }),
    undefined,
    "busy queuing is handled before route resolution",
  );
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
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    stateModel: "gpt-5.4",
    reasoning: supportedReasoning,
    authLabel: "api-key-env",
    statusContext: {
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      bridgeLines: state.bridgeLines,
      memoryLines: state.memoryLines,
      traceLines: state.traceLines,
    },
    isBusy: true,
    busyStatus: "· thinking inspect repo",
    currentTurnStartedAt: 1000,
    nowMs: 2480,
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
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    stateModel: "gpt-5.4",
    currentReasoning: supportedReasoning,
    modeDefaultReasoning: supportedReasoning,
    authLabel: "api-key-env",
    statusContext: {
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      bridgeLines: state.bridgeLines,
      memoryLines: state.memoryLines,
      traceLines: state.traceLines,
    },
    buildStatusPanel: (nextReasoning, authLabel) => ({ title: "Status", lines: [nextReasoning.effort, authLabel] }),
  });
  const model = resolveModelBuiltinResult({
    line: "/model gpt-4.1-mini",
    provider: "openai",
    currentModel: "gpt-5.4",
    currentReasoning: supportedReasoning,
    modeDefaultReasoning: supportedReasoning,
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
  assert.equal(status.panel.title, "Session status");
  assert.ok(status.panel.lines.includes("Provider · openai"));
  assert.ok(status.panel.lines.includes("Activity"));
  assert.ok(status.panel.lines.includes("State · running"));
  assert.ok(status.panel.lines.includes("Now · thinking inspect repo"));
  assert.ok(status.panel.lines.includes("Elapsed · 1.5s"));
  assert.ok(status.panel.lines.some((line) => line.includes("Runtime · OpenAI")));
  assert.equal(traceMode.patch.traceMode, "minimal");
  assert.deepEqual(reasoning.entries.at(-1), { role: "system", text: "Reasoning · Light selected." });
  assert.equal(reasoning.nextReasoning.effort, "low");
  assert.equal(reasoning.panel.title, "Status");
  assert.deepEqual(reasoning.panel.lines, ["low", "api-key-env"]);
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

test("work-shell builtin runtime helper orchestrates stateful builtin transitions without engine-local switch logic", async () => {
  const appendedEntries = [];
  const statePatches = [];
  const runtimeSettings = [];
  const snapshots = [];
  let exited = 0;
  let cleared = 0;
  let openedSessions = 0;
  let reloadedContext = 0;

  await executeWorkShellBuiltinSubmit({
    line: "/reasoning low",
    builtinCommand: { kind: "reasoning" },
    state: createState({ authLabel: "oauth-file" }),
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "oauth-file",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
    buildHelpPanel() {
      return { title: "Help", lines: ["help"] };
    },
    buildContextPanel,
    buildStatusPanel(options, reasoning, authLabel) {
      return { title: "Status", lines: [options.model, reasoning.effort, authLabel] };
    },
    resolveReasoningCommand(input, reasoning) {
      assert.equal(input, "/reasoning low");
      return {
        nextReasoning: { ...reasoning, effort: "low", source: "override" },
        message: "Reasoning · Light selected.",
      };
    },
    resolveModelCommand() {
      return undefined;
    },
    modeDefaultReasoning: supportedReasoning,
    listAvailableSkills: async () => [{ name: "analyze", path: "/skills/analyze", scope: "project", summary: "Look deeper." }],
    loadNamedSkill: async (name) => ({ name, path: `/skills/${name}`, content: `${name} content`, attempts: [] }),
    toolLines: ["read", "write"],
    clearAgent() {
      cleared += 1;
    },
    updateRuntimeSettings(settings) {
      runtimeSettings.push(settings);
    },
    onExit() {
      exited += 1;
    },
    openSessionsPanel: async () => {
      openedSessions += 1;
    },
    reloadContextState: async () => {
      reloadedContext += 1;
    },
    appendEntries: (...entries) => {
      appendedEntries.push(...entries);
    },
    setState: (patch) => {
      statePatches.push(patch);
    },
    persistSessionSnapshot: async (state, summary, traceMode) => {
      snapshots.push({ state, summary, traceMode });
    },
    lastSessionSummary: "Work shell ready.",
  });

  await executeWorkShellBuiltinSubmit({
    line: "/sessions",
    builtinCommand: { kind: "sessions" },
    state: createState({ authLabel: "oauth-file" }),
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "oauth-file",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
    buildHelpPanel() {
      return { title: "Help", lines: ["help"] };
    },
    buildContextPanel,
    buildStatusPanel(options, reasoning, authLabel) {
      return { title: "Status", lines: [options.model, reasoning.effort, authLabel] };
    },
    resolveReasoningCommand(_input, reasoning) {
      return { nextReasoning: reasoning, message: "noop" };
    },
    resolveModelCommand() {
      return undefined;
    },
    modeDefaultReasoning: supportedReasoning,
    listAvailableSkills: async () => [],
    loadNamedSkill: async (name) => ({ name, path: `/skills/${name}`, content: `${name} content`, attempts: [] }),
    toolLines: [],
    clearAgent() {
      cleared += 1;
    },
    updateRuntimeSettings(settings) {
      runtimeSettings.push(settings);
    },
    onExit() {
      exited += 1;
    },
    openSessionsPanel: async () => {
      openedSessions += 1;
    },
    reloadContextState: async () => {
      reloadedContext += 1;
    },
    appendEntries: (...entries) => {
      appendedEntries.push(...entries);
    },
    setState: (patch) => {
      statePatches.push(patch);
    },
    persistSessionSnapshot: async (state, summary, traceMode) => {
      snapshots.push({ state, summary, traceMode });
    },
    lastSessionSummary: "Work shell ready.",
  });

  assert.equal(runtimeSettings.length, 1);
  assert.equal(runtimeSettings[0]?.reasoning?.effort, "low");
  assert.equal(statePatches[0]?.reasoning?.effort, "low");
  assert.equal(statePatches[0]?.panel?.title, "Status");
  assert.ok(statePatches[0]?.panel?.lines.includes("low"));
  assert.equal(openedSessions, 1);
  assert.equal(reloadedContext, 0);
  assert.equal(exited, 0);
  assert.equal(cleared, 0);
  assert.deepEqual(snapshots, []);
  assert.equal(appendedEntries[0]?.text, "/reasoning low");
  assert.equal(appendedEntries.at(-1)?.text, "/sessions");
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
  assert.equal(
    stripPermissionSeekingStallOutro("Done.\n\nIf you want, I can continue."),
    "Done.",
  );
  assert.equal(
    detectPermissionSeekingStall("완료했습니다.\n\n계속 진행할까요?"),
    true,
    "Korean permission stall detected",
  );
  assert.equal(
    detectPermissionSeekingStall("원하시면 나머지도 수정하겠습니다."),
    true,
    "Korean conditional offer detected",
  );
  assert.equal(detectEditIntent("provider parity 구현해줘"), true);
  assert.equal(detectEditIntent("summarize current repo"), false);
  assert.match(
    resolveReadOnlyModeGuard({ mode: "search", prompt: "Anthropic parity 구현해줘" }) ?? "",
    /Search mode is read-only/,
  );
  assert.match(
    resolveReadOnlyModeGuard({ mode: "plan", prompt: "Anthropic parity 구현해줘" }) ?? "",
    /Plan mode blocks edits/,
  );
  assert.equal(
    resolveReadOnlyModeGuard({ mode: "default", prompt: "Anthropic parity 구현해줘" }),
    undefined,
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
  const leakedPlanAndDuplicateGreeting = `[
    {"id":"greet-user","summary":"Respond to the user greeting.","prompt":"Reply briefly to hi."},
    {"id":"offer-help","summary":"Invite next task.","prompt":"Ask what they need next."}
  ]Hi! What would you like help withHi! What can next? I help you with today?`;
  assert.equal(
    sanitizeWorkShellAssistantText(leakedPlanAndDuplicateGreeting),
    "Hi! What would you like help with?",
  );
  const duplicatedMultilingualAnswer = `핵심은 handoff_contexts로 좁히는 겁니다. ಈಗ 구체적으로 보면:

\`\`\`sql
create table handoff_contexts (
  id text primary key
);
\`\`\`

결론

Runbook은 일반 메모리가 아니라 작업 인계 컨텍스트만 가져야 합니다.

Yes — add a dedicated context table, but I’d name it handoff_contexts, not generic contexts.

That keeps Runbook aligned with its boundary: a local-first AgentOps operational DB, not a general memory backend.`;
  const cleanedDuplicatedAnswer = sanitizeWorkShellAssistantText(duplicatedMultilingualAnswer);
  assert.match(cleanedDuplicatedAnswer, /핵심은 handoff_contexts/);
  assert.match(cleanedDuplicatedAnswer, /```sql\ncreate table handoff_contexts/);
  assert.doesNotMatch(cleanedDuplicatedAnswer, /ಈಗ|Yes — add a dedicated context table/);
  const intentionalMultilingualAnswer =
    "한국어와 Kannada 예시를 같이 보겠습니다.\n\nಇದು ಕನ್ನಡದಲ್ಲಿ ಬರೆಯಲಾದ 정상 문장입니다.";
  assert.equal(
    sanitizeWorkShellAssistantText(intentionalMultilingualAnswer),
    intentionalMultilingualAnswer,
    "intentional substantial multilingual prose must be preserved",
  );
  const codeFenceWithKannadaLiteral = `한국어 설명입니다. ಈಗ 불필요한 토큰입니다.

\`\`\`js
const label = "ಕೋಡ್";
\`\`\``;
  const cleanedCodeFenceWithKannadaLiteral = sanitizeWorkShellAssistantText(codeFenceWithKannadaLiteral);
  assert.doesNotMatch(cleanedCodeFenceWithKannadaLiteral, /ಈಗ/);
  assert.match(cleanedCodeFenceWithKannadaLiteral, /const label = "ಕೋಡ್";/);
  const intentionalEnglishConclusion = `${"한국어 설명입니다. ".repeat(20)}

Conclusion

This English conclusion is intentional and contains useful details.`;
  assert.match(
    sanitizeWorkShellAssistantText(intentionalEnglishConclusion),
    /This English conclusion is intentional/,
    "intentional English conclusion sections must not be truncated",
  );
  const validJsonTaskAnswer = `[{"id":"task-1","summary":"Do thing","prompt":"Run this prompt"}]`;
  assert.equal(
    sanitizeWorkShellAssistantText(validJsonTaskAnswer),
    validJsonTaskAnswer,
    "valid assistant JSON answers must not be stripped as internal plans",
  );
  const leakedSubtaskPlanOnly = `[
    {"id":"subtask-1","summary":"Locate parallel mode","prompt":"Search codebase"},
    {"id":"subtask-2","summary":"Explain behavior","prompt":"Summarize UX"}
  ]`;
  assert.equal(
    sanitizeWorkShellAssistantText(leakedSubtaskPlanOnly),
    "",
    "orchestrator subtask JSON must never surface in assistant text",
  );
  assert.equal(
    sanitizeWorkShellAssistantText("I'll trace the repo for parallel mode.\n\nParallel mode runs subtasks concurrently."),
    "Parallel mode runs subtasks concurrently.",
    "internal orchestrator meta lines must be stripped",
  );
  assert.equal(
    sanitizeWorkShellAssistantText(parallelModeKoreanLeakyResponseText),
    parallelModeKoreanCleanResponseText,
    "leaky parallel synthesis must collapse to the clean Korean answer",
  );
  assert.equal(
    sanitizeWorkShellAssistantText("관련 파일을 확인했습니다. 병렬 모드는 동시 처리입니다."),
    "관련 파일을 확인했습니다. 병렬 모드는 동시 처리입니다.",
    "substantial Korean prose must not be stripped as orchestrator meta",
  );
  assert.equal(
    await finalizeWorkShellAssistantReply({
      prompt: "explain parallel mode",
      assistantText: parallelModeKoreanLeakyResponseText,
      async runTurn() {
        throw new Error("continuation should not run");
      },
    }),
    parallelModeKoreanCleanResponseText,
  );
  assert.equal(
    await finalizeWorkShellAssistantReply({
      prompt: "leak only",
      assistantText: leakedSubtaskPlanOnly,
      async runTurn() {
        throw new Error("continuation should not run");
      },
    }),
    "",
    "fully sanitized assistant replies must not surface an empty-response bubble",
  );
  assert.equal(
    sanitizeWorkShellAssistantText("Hello Alice. Hello Bob. This is a transcript example."),
    "Hello Alice. Hello Bob. This is a transcript example.",
    "valid repeated greeting words in user-requested prose must be preserved",
  );
  assert.equal(
    await finalizeWorkShellAssistantReply({
      prompt: "hi",
      assistantText: leakedPlanAndDuplicateGreeting,
      async runTurn() {
        throw new Error("continuation should not run");
      },
    }),
    "Hi! What would you like help with?",
  );
  assert.equal(
    await finalizeWorkShellAssistantReply({
      prompt: "return JSON tasks",
      assistantText: validJsonTaskAnswer,
      async runTurn() {
        throw new Error("continuation should not run");
      },
    }),
    validJsonTaskAnswer,
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
      memoryLines: ["session · memory-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged"],
      panel: {
        title: "Context",
        lines: ["Loaded guidance: AGENTS.md", "bridge-1", "session · memory-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged"],
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
      expanded: true,
    }),
    {
      contextSummaryLines: ["Loaded guidance: CLAUDE.md"],
      bridgeLines: ["bridge-2"],
      memoryLines: ["session · memory-2 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged"],
      panel: {
        title: "Context expanded",
        lines: ["Loaded guidance: CLAUDE.md", "bridge-2", "session · memory-2 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged", "trace-1"],
      },
    },
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
        return ["memory-fallback"];
      },
      buildContextPanel,
      prefetchScopedMemory: async () => ({
        status: "degraded",
        lines: [],
        entries: [],
        reason: "memory prefetch timed out after 5ms",
      }),
    }).then(({ memoryLines }) => memoryLines),
    ["session · memory-fallback · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged"],
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
  assert.deepEqual(createRecentSessionsPanel([]), {
    title: "Recent sessions",
    lines: [
      "No recent sessions found.",
      "Run unclecode work to start one, then press Esc here to resume.",
      "Use /context for workspace guidance and memory.",
    ],
  });
  assert.deepEqual(createOpenSessionsLoadingPanel(), {
    title: "Recent sessions",
    lines: ["Loading sessions…"],
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
  assert.deepEqual(
    await loadOpenSessionsLoadedPanel({
      cwd: "/repo",
      async listSessionLines() {
        return ["session-3"];
      },
    }),
    {
      title: "Recent sessions",
      lines: ["session-3"],
    },
  );
  assert.deepEqual(createOpenSessionsFailurePanel(new Error("store unavailable")), {
    title: "Recent sessions",
    lines: [
      "Unable to load sessions · store unavailable",
      "Use /context to inspect the loaded workspace context.",
    ],
  });
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
  const cancelResult = createSensitiveInputCancelResult({
    options,
    stateModel: "gpt-5.4-mini",
    reasoning: supportedReasoning,
    authLabel: "api-key-file",
    buildStatusPanel(nextOptions, reasoning, authLabel) {
      return { title: "Status", lines: [nextOptions.model, reasoning.effort, authLabel] };
    },
  });
  assert.deepEqual(cancelResult.entries, [{ role: "system", text: "API key entry canceled." }]);
  assert.equal(cancelResult.composerMode, "default");
  assert.equal(cancelResult.panel.title, "Session status");
  assert.ok(cancelResult.panel.lines.includes("Model · gpt-5.4-mini"));
  assert.ok(cancelResult.panel.lines.includes("Auth · API key · file"));
});

test("work-shell execution helpers assemble start, success, failure, finalize, and full prompt-turn orchestration", async () => {
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
  const orchestratedEntries = [];
  const orchestratedPatches = [];
  const orchestratedTraceLines = [];
  const orchestratedSnapshots = [];
  await executeWorkShellPromptTurn({
    promptTurn: {
      transcriptText: "finish cleanup",
      prompt: "finish cleanup",
      sessionSummary: "Chat: finish cleanup",
      failureSummary: "Needs action: finish cleanup",
      attachments: ["img-1"],
    },
    state: createState({
      authLabel: "oauth-file",
      bridgeLines: ["bridge-0"],
      memoryLines: ["memory-0"],
      model: "gpt-5.4",
      reasoning: supportedReasoning,
    }),
    cwd: "/repo",
    sessionId: "work-1",
    autoContinueOnPermissionStall: true,
    async runAgentTurn(prompt, attachments) {
      assert.equal(prompt, "finish cleanup");
      assert.deepEqual(attachments, ["img-1"]);
      return { text: "Done." };
    },
    async publishContextBridge({ summary }) {
      return { bridgeId: "bridge-2", line: `bridge ${summary}` };
    },
    async writeScopedMemory() {
      return { memoryId: "memory-2" };
    },
    async listScopedMemoryLines() {
      return ["memory-2 line"];
    },
    refreshAuthState: async () => ({ authLabel: "oauth-file", authIssueLines: [] }),
    applyAuthIssueLines() {},
    formatWorkShellError: (message) => `ERR:${message}`,
    formatAgentTraceLine: (event) => `${event.type}:${String(event.summary ?? "")}`,
    buildAuthFailureStatusPanel: (authLabel) => ({ title: "Status", lines: [`auth:${authLabel}`] }),
    appendEntries: (...entries) => {
      orchestratedEntries.push(...entries);
    },
    setState: (patch) => {
      orchestratedPatches.push(patch);
    },
    pushTraceLine: (line) => {
      orchestratedTraceLines.push(line);
    },
    persistSessionSnapshot: async (snapshotState, summary) => {
      orchestratedSnapshots.push({ snapshotState, summary });
    },
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
  assert.deepEqual(
    orchestratedEntries.map((entry) => entry.role),
    ["user", "assistant"],
  );
  assert.equal(orchestratedTraceLines.length, 2);
  assert.deepEqual(
    orchestratedSnapshots,
    [
      { snapshotState: "running", summary: "Chat: finish cleanup" },
      { snapshotState: "idle", summary: "Chat: finish cleanup" },
    ],
  );
  assert.equal(orchestratedPatches[0]?.isBusy, true);
  assert.equal(orchestratedPatches.at(-1)?.isBusy, false);

  assert.deepEqual(createPromptTurnStartPatch({ state, turnStartedAt: 42 }), {
    isBusy: true,
    busyStatus: "thinking",
    currentTurnStartedAt: 42,
  });
  assert.deepEqual(resolvePromptTurnStartPatch(42), {
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
  const rustSuccessPayload = resolvePromptTurnSuccessPayload({
    assistantText: "Done.",
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    lastTurnDurationMs: 123,
  });
  assert.deepEqual(rustSuccessPayload.entries, [{ role: "assistant", text: "Done." }]);
  assert.deepEqual(rustSuccessPayload.patch, {
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
  const rustFailurePayload = resolvePromptTurnFailurePayload({
    state,
    formattedMessage: "ERR:request failed with status 401",
    nextAuthLabel: "api-key-file",
    lastTurnDurationMs: 456,
    isAuthFailure: true,
    statusInput: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      cwd: "/repo",
      reasoningLabel: "high (override)",
      authLabel: "api-key-file",
      contextSummaryLines: ["Auth issue: saved OAuth needs refresh."],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    },
  });
  assert.deepEqual(rustFailurePayload.entries, [
    { role: "system", text: "ERR:request failed with status 401" },
  ]);
  assert.equal(rustFailurePayload.patch.authLabel, "api-key-file");
  assert.equal(rustFailurePayload.patch.lastTurnDurationMs, 456);
  assert.equal(rustFailurePayload.patch.panel.title, "Session status");
  assert.ok(rustFailurePayload.patch.panel.lines.includes("Auth · API key · file"));
  assert.deepEqual(createPromptTurnFinalizePatch(state), {
    isBusy: false,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
    streamingAssistantText: undefined,
  });
  assert.deepEqual(resolvePromptTurnFinalizePatch(), {
    isBusy: false,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
    streamingAssistantText: undefined,
  });
});

test("work-shell prompt runtime helpers adapt chat and prompt commands into execution turns", async () => {
  const chatEntries = [];
  const commandEntries = [];
  const snapshots = [];

  await executeWorkShellChatSubmit({
    line: "summarize repo",
    resolveComposerInput: async () => ({
      prompt: "summarize repo",
      transcriptText: "summarize repo",
      attachments: ["img-1"],
    }),
    state: createState({ model: "gpt-5.4", reasoning: supportedReasoning }),
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "oauth-file",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    sessionId: "work-1",
    buildStatusPanel: (_options, reasoning, authLabel) => ({
      title: "Status",
      lines: [reasoning.effort, authLabel],
    }),
    runAgentTurn: async (prompt, attachments) => {
      assert.equal(prompt, "summarize repo");
      assert.deepEqual(attachments, ["img-1"]);
      return { text: "Chat done." };
    },
    publishContextBridge: async ({ summary }) => ({ bridgeId: "bridge-1", line: `bridge ${summary}` }),
    writeScopedMemory: async () => ({ memoryId: "memory-1" }),
    listScopedMemoryLines: async () => ["memory-1 line"],
    refreshAuthState: async () => ({ authLabel: "oauth-file", authIssueLines: [] }),
    applyAuthIssueLines() {},
    formatWorkShellError: (message) => `ERR:${message}`,
    formatAgentTraceLine: (event) => `${event.type}:${String(event.summary ?? "")}`,
    appendEntries: (...entries) => {
      chatEntries.push(...entries);
    },
    setState() {},
    pushTraceLine() {},
    persistSessionSnapshot: async (state, summary) => {
      snapshots.push({ state, summary });
    },
  });

  await executeWorkShellPromptCommandSubmit({
    transcriptText: "/review auth flow",
    promptCommand: { kind: "review", focus: "auth flow" },
    state: createState({ model: "gpt-5.4", reasoning: supportedReasoning }),
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "oauth-file",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    sessionId: "work-1",
    buildStatusPanel: (_options, reasoning, authLabel) => ({
      title: "Status",
      lines: [reasoning.effort, authLabel],
    }),
    runAgentTurn: async (prompt) => {
      assert.match(prompt, /Review the current repository changes and implementation\./);
      assert.match(prompt, /Focus request: auth flow/);
      return { text: "Review done." };
    },
    publishContextBridge: async ({ summary }) => ({ bridgeId: "bridge-2", line: `bridge ${summary}` }),
    writeScopedMemory: async () => ({ memoryId: "memory-2" }),
    listScopedMemoryLines: async () => ["memory-2 line"],
    refreshAuthState: async () => ({ authLabel: "oauth-file", authIssueLines: [] }),
    applyAuthIssueLines() {},
    formatWorkShellError: (message) => `ERR:${message}`,
    formatAgentTraceLine: (event) => `${event.type}:${String(event.summary ?? "")}`,
    appendEntries: (...entries) => {
      commandEntries.push(...entries);
    },
    setState() {},
    pushTraceLine() {},
    persistSessionSnapshot: async () => {},
  });

  assert.deepEqual(chatEntries.map((entry) => entry.role), ["user", "assistant"]);
  assert.equal(chatEntries[0]?.text, "summarize repo");
  assert.equal(commandEntries[0]?.text, "/review auth flow");
  assert.equal(commandEntries[1]?.text, "Review done.");
  assert.deepEqual(snapshots, [
    { state: "running", summary: "Chat: summarize repo" },
    { state: "idle", summary: "Chat: summarize repo" },
  ]);
});

test("work-shell chat runtime short-circuits edit requests in search mode with a concise local reply", async () => {
  const entries = [];
  const snapshots = [];
  let agentCalls = 0;

  await executeWorkShellChatSubmit({
    line: "Anthropic parity 구현해줘",
    resolveComposerInput: async () => ({
      prompt: "Anthropic parity 구현해줘",
      transcriptText: "Anthropic parity 구현해줘",
      attachments: [],
    }),
    state: createState({ model: "gpt-5.4", reasoning: supportedReasoning, mode: "search" }),
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "search",
      authLabel: "oauth-file",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    sessionId: "work-1",
    buildStatusPanel: (_options, reasoning, authLabel) => ({
      title: "Status",
      lines: [reasoning.effort, authLabel],
    }),
    runAgentTurn: async () => {
      agentCalls += 1;
      return { text: "should not run" };
    },
    publishContextBridge: async ({ summary }) => ({ bridgeId: "bridge-3", line: `bridge ${summary}` }),
    writeScopedMemory: async () => ({ memoryId: "memory-3" }),
    listScopedMemoryLines: async () => ["memory-3 line"],
    refreshAuthState: async () => ({ authLabel: "oauth-file", authIssueLines: [] }),
    applyAuthIssueLines() {},
    formatWorkShellError: (message) => `ERR:${message}`,
    formatAgentTraceLine: (event) => `${event.type}:${String(event.summary ?? "")}`,
    appendEntries: (...nextEntries) => {
      entries.push(...nextEntries);
    },
    setState() {},
    pushTraceLine() {},
    persistSessionSnapshot: async (state, summary) => {
      snapshots.push({ state, summary });
    },
  });

  assert.equal(agentCalls, 0);
  assert.deepEqual(entries.map((entry) => entry.role), ["user", "assistant"]);
  assert.match(entries[1]?.text ?? "", /Search mode is read-only/);
  assert.match(entries[1]?.text ?? "", /\/mode set yolo/);
  assert.deepEqual(snapshots, [
    { state: "idle", summary: "Chat: Anthropic parity 구현해줘" },
  ]);
});

test("work-shell lifecycle helpers load initial state, session panels, and overlay/cancel transitions", async () => {
  const options = {
    provider: "openai",
    model: "gpt-5.4",
    mode: "default",
    authLabel: "api-key-env",
    reasoning: supportedReasoning,
    cwd: "/repo",
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
  };

  const loadedState = await loadWorkShellLifecycleState({
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
  });
  const fallbackState = await loadWorkShellLifecycleState({
    cwd: "/repo",
    sessionId: "work-1",
    currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
    async listProjectBridgeLines() {
      throw new Error("bridge unavailable");
    },
    async listScopedMemoryLines() {
      return ["memory-1"];
    },
    buildContextPanel,
  });
  const sessionPanels = await loadOpenSessionsPanelState({
    cwd: "/repo",
    async listSessionLines() {
      return ["session-1", "session-2"];
    },
  });

  assert.deepEqual(loadedState, {
    bridgeLines: ["bridge-1"],
    memoryLines: ["session · memory-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged"],
    panel: {
      title: "Context",
      lines: ["Loaded guidance: AGENTS.md", "bridge-1", "session · memory-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged"],
    },
  });
  assert.deepEqual(fallbackState, {
    bridgeLines: [],
    memoryLines: [],
    panel: {
      title: "Context",
      lines: ["Loaded guidance: AGENTS.md"],
    },
  });
  assert.deepEqual(sessionPanels, {
    loadingPanel: { title: "Recent sessions", lines: ["Loading sessions…"] },
    loadedPanel: { title: "Recent sessions", lines: ["session-1", "session-2"] },
  });
  assert.deepEqual(resolveSensitiveInputCancelState({
    composerMode: "default",
    options,
    stateModel: "gpt-5.4",
    reasoning: supportedReasoning,
    authLabel: "api-key-env",
    buildStatusPanel(nextOptions, reasoning, authLabel) {
      return { title: "Status", lines: [nextOptions.model, reasoning.effort, authLabel] };
    },
  }), undefined);
  const cancelState = resolveSensitiveInputCancelState({
    composerMode: "api-key-entry",
    options,
    stateModel: "gpt-5.4",
    reasoning: supportedReasoning,
    authLabel: "api-key-file",
    buildStatusPanel(nextOptions, reasoning, authLabel) {
      return { title: "Status", lines: [nextOptions.model, reasoning.effort, authLabel] };
    },
  });
  assert.deepEqual(cancelState.entries, [{ role: "system", text: "API key entry canceled." }]);
  assert.equal(cancelState.composerMode, "default");
  assert.equal(cancelState.panel.title, "Session status");
  assert.ok(cancelState.panel.lines.includes("Model · gpt-5.4"));
  assert.ok(cancelState.panel.lines.includes("Auth · API key · file"));
  assert.equal(resolveCloseOverlayState({
    panel: { title: "Status", lines: [] },
    currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    traceLines: ["trace-1"],
    buildContextPanel,
  }), undefined);
  assert.deepEqual(resolveCloseOverlayState({
    panel: { title: "Context expanded", lines: [] },
    currentContextSummaryLines: ["Loaded guidance: AGENTS.md"],
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    traceLines: ["trace-1"],
    buildContextPanel,
  }), {
    title: "Context",
    lines: ["Loaded guidance: AGENTS.md", "bridge-1", "memory-1", "trace-1"],
  });
});

test("work-shell command runtime helpers orchestrate secure, inline, and local command submits", async () => {
  const commandEntries = [];
  const commandPatches = [];
  const commandTraceLines = [];

  await executeSecureApiKeyEntrySubmit({
    line: "sk-secret-123",
    state: createState({ authLabel: "api-key-env" }),
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    buildStatusPanel(options, reasoning, authLabel) {
      return { title: "Status", lines: [options.model, reasoning.effort, authLabel] };
    },
    buildInlineCommandPanel(args, lines) {
      return { title: args.join(" "), lines };
    },
    formatInlineCommandResultSummary(args, lines) {
      return `${args.join(" ")} :: ${lines[0] ?? "No output."}`;
    },
    saveApiKeyAuth: async () => ["API key login saved.", "Auth: api-key-file"],
    refreshAuthState: async () => ({ authLabel: "api-key-file", authIssueLines: [] }),
    extractAuthLabel: (lines) => lines[1]?.replace(/^Auth:\s*/, ""),
    applyAuthIssueLines() {},
    formatWorkShellError: (message) => `ERR:${message}`,
    appendEntries: (...entries) => {
      commandEntries.push(...entries);
    },
    setState: (patch) => {
      commandPatches.push(patch);
    },
    pushTraceLine: (line) => {
      commandTraceLines.push(line);
    },
  });

  await executeInlineCommandSubmit({
    line: "/auth login --api-key sk-secret-123",
    slashCommand: ["auth", "login", "--api-key", "sk-secret-123"],
    state: createState({ authLabel: "api-key-env" }),
    resolveWorkShellInlineCommand: async (_args, _runInlineCommand, onProgress) => {
      onProgress?.("Opening browser…");
      return { lines: ["OAuth login complete.", "Auth: oauth-file"], failed: false };
    },
    runInlineCommand: async () => [],
    refineInlineCommandResultLines: undefined,
    refreshAuthState: async () => ({ authLabel: "oauth-file", authIssueLines: [] }),
    extractAuthLabel: (lines) => lines[1]?.replace(/^Auth:\s*/, ""),
    applyAuthIssueLines() {},
    buildInlineCommandPanel(args, lines) {
      return { title: args.join(" "), lines };
    },
    formatInlineCommandResultSummary(args, lines) {
      return `${args.join(" ")} :: ${lines[0] ?? "No output."}`;
    },
    appendEntries: (...entries) => {
      commandEntries.push(...entries);
    },
    setState: (patch) => {
      commandPatches.push(patch);
    },
    pushTraceLine: (line) => {
      commandTraceLines.push(line);
    },
  });

  await executeLocalCommandSubmit({
    line: "/remember session keep this",
    localCommand: { kind: "remember", scope: "session", summary: "keep this" },
    cwd: "/repo",
    sessionId: "work-1",
    listScopedMemoryLines: async () => ["session-1", "session-2"],
    writeScopedMemory: async ({ scope, summary }) => ({ memoryId: `${scope}:${summary}` }),
    formatAgentTraceLine: (event) => `memory ${event.summary}`,
    appendEntries: (...entries) => {
      commandEntries.push(...entries);
    },
    setState: (patch) => {
      commandPatches.push(patch);
    },
    pushTraceLine: (line) => {
      commandTraceLines.push(line);
    },
  });

  assert.equal(commandEntries[0]?.text, "✓ auth key");
  assert.match(commandEntries[1]?.text ?? "", /Auth · API key login saved/);
  assert.match(commandEntries[2]?.text ?? "", /\[REDACTED\]/);
  assert.match(commandEntries.at(-1)?.text ?? "", /memory keep this/);
  assert.equal(commandPatches[0]?.isBusy, true);
  assert.equal(commandPatches[1]?.composerMode, "default");
  assert.equal(commandPatches[2]?.isBusy, false);
  assert.equal(commandPatches[3]?.isBusy, true);
  assert.equal(commandPatches[4]?.panel?.title, "Auth");
  assert.equal(commandPatches[5]?.authLabel, "oauth-file");
  assert.deepEqual(commandPatches.at(-1), {
    memoryLines: [
      "session · session-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged",
      "session · session-2 · cite memory:session:1970-01-01T00:00:00.000Z:test0002 · aged",
    ],
  });
  assert.deepEqual(commandTraceLines, ["→ auth key", "✓ auth key", "→ auth login --api-key [REDACTED]", "✓ auth login --api-key [REDACTED]", "memory keep this"]);
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
  assert.deepEqual(rememberResult.nextMemoryLines, [
    "session · session-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged",
    "session · session-2 · cite memory:session:1970-01-01T00:00:00.000Z:test0002 · aged",
  ]);
  assert.equal(rememberResult.memoryTrace, "memory keep auth fix visible");
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

function createNativeMemoryAbiError() {
  return new Error(
    "The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
    "was compiled against a different Node.js version using\n" +
    "NODE_MODULE_VERSION 141. This version of Node.js requires\n" +
    "NODE_MODULE_VERSION 127. Please try re-compiling or re-installing\n" +
    "the module (for instance, using `npm rebuild` or `npm install`).",
  );
}

test("work-shell success sequence keeps the assistant reply when post-turn memory storage fails", async () => {
  const success = await runPromptTurnSuccessSequence({
    prompt: "answer normally",
    transcriptText: "answer normally",
    turnStartedAt: Date.now() - 5,
    async runAgentTurn() {
      return { text: "Done." };
    },
    cwd: "/repo",
    sessionId: "work-1",
    currentBridgeLines: ["bridge-0"],
    currentMemoryLines: ["memory-0"],
    async publishContextBridge({ summary }) {
      return { bridgeId: "bridge-1", line: `bridge ${summary}` };
    },
    async writeScopedMemory() {
      throw createNativeMemoryAbiError();
    },
    async listScopedMemoryLines() {
      throw new Error("memory lines should not be listed after write failure");
    },
  });

  assert.equal(success.assistantText, "Done.");
  assert.deepEqual(success.postTurnEffects.bridgeLines, [
    "bridge Q: answer normally · A: Done.",
    "bridge-0",
  ]);
  assert.deepEqual(success.postTurnEffects.memoryLines, ["memory-0"]);
  assert.equal(success.postTurnEffects.memoryTraceEvent.type, "memory.written");
  assert.equal(success.postTurnEffects.memoryTraceEvent.degraded, true);
  assert.equal(success.postTurnEffects.memoryTraceEvent.errorClass, "native-module-version-mismatch");
  assert.match(success.postTurnEffects.memorySummary, /unavailable/i);
});

test("work-shell prompt turn does not surface native post-turn memory errors in chat", async () => {
  const entries = [];
  const patches = [];
  const traceLines = [];
  const snapshots = [];
  await executeWorkShellPromptTurn({
    promptTurn: {
      transcriptText: "hi",
      prompt: "hi",
      sessionSummary: "Chat: hi",
      failureSummary: "Needs action: hi",
    },
    state: createState({
      authLabel: "oauth-file",
      bridgeLines: ["bridge-0"],
      memoryLines: ["memory-0"],
      model: "gpt-5.4",
      reasoning: supportedReasoning,
    }),
    cwd: "/repo",
    sessionId: "work-1",
    async runAgentTurn() {
      return { text: "반갑다." };
    },
    async publishContextBridge({ summary }) {
      return { bridgeId: "bridge-2", line: `bridge ${summary}` };
    },
    async writeScopedMemory() {
      throw createNativeMemoryAbiError();
    },
    async listScopedMemoryLines() {
      throw new Error("memory lines should not be listed after write failure");
    },
    refreshAuthState: async () => ({ authLabel: "oauth-file", authIssueLines: [] }),
    applyAuthIssueLines() {},
    formatWorkShellError: (message) => `ERR:${message}`,
    formatAgentTraceLine: (event) => `${event.type}:${String(event.summary ?? "")}:${String(event.errorClass ?? "")}`,
    buildAuthFailureStatusPanel: (authLabel) => ({ title: "Status", lines: [`auth:${authLabel}`] }),
    appendEntries: (...nextEntries) => {
      entries.push(...nextEntries);
    },
    setState: (patch) => {
      patches.push(patch);
    },
    pushTraceLine: (line) => {
      traceLines.push(line);
    },
    persistSessionSnapshot: async (snapshotState, summary) => {
      snapshots.push({ snapshotState, summary });
    },
  });

  assert.deepEqual(entries.map((entry) => entry.role), ["user", "assistant"]);
  assert.equal(entries.at(-1)?.text, "반갑다.");
  assert.equal(entries.some((entry) => /better_sqlite3\.node|NODE_MODULE_VERSION/.test(entry.text)), false);
  assert.equal(patches.some((patch) => patch.memoryLines?.includes("memory-0")), true);
  assert.ok(traceLines.some((line) => /native-module-version-mismatch/.test(line)));
  assert.deepEqual(
    snapshots,
    [
      { snapshotState: "running", summary: "Chat: hi" },
      { snapshotState: "idle", summary: "Chat: hi" },
    ],
  );
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
  assert.deepEqual(effects.memoryLines, [
    "session · memory-1 line · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged",
  ]);
  assert.equal(effects.bridgeTraceEvent.type, "bridge.published");
  assert.equal(effects.memoryTraceEvent.type, "memory.written");
  const rustEffects = resolveWorkShellPostTurnSuccessEffectsPayload({
    summary: "User: hello\nAssistant: world",
    bridgeId: "bridge-1",
    bridgeLine: "bridge-1 line",
    currentBridgeLines: ["bridge-0"],
    memoryId: "memory-1",
    memoryLines: ["memory-1 line"],
  });
  assert.deepEqual(rustEffects.bridgeLines, ["bridge-1 line", "bridge-0"]);
  assert.equal(rustEffects.bridgeTraceEvent.type, "bridge.published");
  assert.equal(rustEffects.memoryTraceEvent.type, "memory.written");
  assert.equal(authLabel, "api-key-file");
  assert.deepEqual(refreshedAuthIssues, ["Auth issue: saved OAuth needs refresh."]);
});

test("work-shell post-turn helpers skip bridge and memory when assistant text is empty", async () => {
  let bridgeCalled = false;
  let memoryCalled = false;
  const effects = await runWorkShellPostTurnSuccessEffects({
    cwd: "/repo",
    transcriptText: "leak only",
    assistantText: "",
    sessionId: "work-1",
    currentBridgeLines: ["bridge-0"],
    currentMemoryLines: ["memory-0"],
    async publishContextBridge() {
      bridgeCalled = true;
      return { bridgeId: "bridge-1", line: "bridge-1 line" };
    },
    async writeScopedMemory() {
      memoryCalled = true;
      return { memoryId: "memory-1" };
    },
    async listScopedMemoryLines() {
      return ["memory-1 line"];
    },
  });

  assert.equal(effects.skipped, true);
  assert.equal(bridgeCalled, false);
  assert.equal(memoryCalled, false);
  assert.deepEqual(effects.bridgeLines, ["bridge-0"]);
  assert.deepEqual(effects.memoryLines, ["memory-0"]);
});

test("work-shell trace helpers derive busy status, apply live updates, and map transcript roles honestly", () => {
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
  assert.equal(
    resolveBusyStatusFromTraceEvent(
      { type: "policy.denied" },
      "✖ policy denied filesystem.write/write_file · openshell · denied",
    ),
    null,
    "policy.denied must not overwrite the active busy status",
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
    undefined,
    "verbose traces stay in the context overlay, not the conversation transcript",
  );
  assert.equal(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "provider.route" },
      line: "route openai direct",
    }),
    undefined,
    "provider.route stays out of the default conversation transcript",
  );
  assert.equal(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "provider.calling" },
      line: "calling openai gpt-5.4",
    }),
    undefined,
    "provider.calling is suppressed in minimal mode",
  );
  assert.deepEqual(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "tool.started" },
      line: "Reading src/index.ts",
    }),
    undefined,
    "tool.started stays out of the default conversation transcript",
  );
  assert.deepEqual(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "tool.completed", toolName: "write_file" },
      line: "✓ wrote notes.txt · 7 lines",
    }),
    {
      role: "tool",
      text: "✓ wrote notes.txt · 7 lines",
    },
    "a completed file mutation remains visible in minimal mode",
  );
  assert.deepEqual(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "tool.completed", toolName: "read_file" },
      line: "Read src/index.ts · 18 lines",
    }),
    {
      role: "tool",
      text: "Read src/index.ts · 18 lines",
    },
    "a completed read remains visible for the later activity projection to coalesce",
  );
  assert.equal(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "reasoning.delta" },
      line: "✦ thinking· inspect repo before editing",
    }),
    undefined,
    "reasoning.delta stays out of the conversation transcript",
  );
  assert.deepEqual(
    resolveVerboseTraceEntry({
      traceMode: "minimal",
      event: { type: "policy.denied" },
      line: "✖ policy denied filesystem.write/write_file · openshell · denied",
    }),
    {
      role: "tool",
      text: "✖ policy denied filesystem.write/write_file · openshell · denied",
    },
    "policy.denied shows in minimal mode as a single high-signal tool entry",
  );
  assert.equal(resolveTraceEntryRole({ type: "turn.started" }), "system");
  assert.equal(resolveTraceEntryRole({ type: "provider.calling" }), "tool");
  assert.equal(resolveTraceEntryRole({ type: "reasoning.delta" }), "assistant");
  assert.equal(extractCurrentTurnStartedAt({ type: "turn.started", startedAt: 123 }), 123);
  assert.equal(extractCurrentTurnStartedAt({ type: "tool.started", startedAt: 123 }), undefined);

  const livePatches = [];
  const liveEntries = [];
  const liveTraceLines = [];
  applyWorkShellTraceEvent({
    state: createState({ traceMode: "verbose", isBusy: true }),
    event: { type: "provider.calling", status: "running" },
    formatAgentTraceLine: () => "calling openai gpt-5.4",
    setState: (patch) => {
      livePatches.push(patch);
    },
    appendEntries: (...entries) => {
      liveEntries.push(...entries);
    },
    pushTraceLine: (line) => {
      liveTraceLines.push(line);
    },
  });
  assert.equal(livePatches.length, 1);
  assert.equal(liveEntries.length, 0);
  assert.deepEqual(liveTraceLines, ["calling openai gpt-5.4"]);
  const completedEntries = [];
  applyWorkShellTraceEvent({
    state: createState({ traceMode: "minimal", isBusy: true }),
    event: { type: "tool.completed", toolName: "run_shell" },
    formatAgentTraceLine: () => "✓ $ npm test -- work · 34ms",
    setState() {},
    appendEntries: (...entries) => {
      completedEntries.push(...entries);
    },
    pushTraceLine() {},
  });
  assert.deepEqual(completedEntries, [{
    role: "tool",
    text: "✓ $ npm test -- work · 34ms",
  }]);
});

test("assistant delta trace accumulates streaming assistant text without transcript noise", () => {
  const patches = [];
  const liveEntries = [];
  const liveTraceLines = [];
  applyWorkShellTraceEvent({
    state: createState({ streamingAssistantText: "Hel" }),
    event: {
      type: "assistant.delta",
      level: "default",
      provider: "openai",
      model: "gpt-5.4",
      itemId: "msg_1",
      delta: "lo",
    },
    formatAgentTraceLine: () => {
      throw new Error("assistant delta should bypass trace line formatting");
    },
    setState: (patch) => {
      patches.push(patch);
    },
    appendEntries: (...entries) => {
      liveEntries.push(...entries);
    },
    pushTraceLine: (line) => {
      liveTraceLines.push(line);
    },
  });

  assert.deepEqual(patches, [{ streamingAssistantText: "Hello" }]);
  assert.deepEqual(liveEntries, []);
  assert.deepEqual(liveTraceLines, []);
});

test("work-shell snapshot and context loaders stay available through their helper seams", async () => {
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
    memoryLines: ["session · memory-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged"],
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
  assert.equal(state.traceMode, "minimal");
  assert.equal(state.authLabel, "oauth-file");
  assert.deepEqual(state.entries, []);

  const defaultState = createInitialWorkShellEngineState({
    options: {
      provider: "openai",
      model: "gpt-5.4-mini",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      initialEntries: [
        { role: "user", text: "inspect repo" },
        { role: "assistant", text: "repo inspected" },
      ],
    },
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    buildContextPanel,
  });
  assert.equal(defaultState.traceMode, "minimal");
  assert.equal(defaultState.composerMode, "default");
  assert.equal(defaultState.isBusy, false);
  assert.deepEqual(defaultState.entries, [
    { role: "user", text: "inspect repo" },
    { role: "assistant", text: "repo inspected" },
  ]);
});

test("work-shell state helpers append entries and update auth/busy transitions deterministically", () => {
  const state = createState();
  const withEntries = {
    ...state,
    ...appendWorkShellEntries(
      state,
      { role: "system", text: "hello" },
      { role: "assistant", text: "world" },
    ),
  };
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

  assert.deepEqual(withEntries.entries, [
    { role: "system", text: "hello" },
    { role: "assistant", text: "world" },
  ]);
  assert.equal(withAuth.authLabel, "oauth-file");
  assert.deepEqual(withAuth.authLauncherLines, ["Saved auth found."]);
  assert.deepEqual(
    createWorkShellAuthStatePatch({ state: withEntries, authLabel: "none", authLauncherLines: [] }),
    { authLabel: "none", authLauncherLines: [] },
  );
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

test("work-shell state helpers keep expanded context open across trace rebuilds", () => {
  const state = createState({
    panel: { title: "Context expanded", lines: ["Loaded guidance: AGENTS.md"] },
    bridgeLines: ["bridge-1"],
    memoryLines: ["memory-1"],
    traceLines: ["old trace"],
  });

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
  const minimal = {
    ...state,
    ...createWorkShellTraceModePatch({
      state,
      traceMode: "minimal",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      buildContextPanel,
    }),
  };

  assert.equal(traced.panel.title, "Context expanded");
  assert.deepEqual(traced.panel.lines, [
    "Loaded guidance: AGENTS.md",
    "bridge-1",
    "memory-1",
    "new trace",
    "old trace",
  ]);
  assert.equal(minimal.panel.title, "Context expanded");
});

test("createWorkShellPaneRuntime builds shared engine and slash runtime helpers", async () => {
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
  assert.ok(runtime.getSuggestions("/mmbridge").some((item) => item.command === "/mmbridge context"));
  assert.ok(runtime.getSuggestions("/mmbridge").some((item) => item.command === "/mmbridge review"));
  assert.ok(runtime.getSuggestions("/mmbridge").some((item) => item.command === "/mmbridge gate"));
  assert.ok(runtime.getSuggestions("/mmbridge").some((item) => item.command === "/mmbridge handoff"));
  assert.ok(runtime.getSuggestions("/mmbridge").some((item) => item.command === "/mmbridge health"));
  assert.ok(runtime.getSuggestions("/mmbridge").some((item) => item.command === "/mmbridge doctor"));
  assert.ok(runtime.getSuggestions("/context").some((item) => item.command === "/context"));
  assert.equal(runtime.shouldBlockSlashSubmit("/auth"), true);
  assert.equal(runtime.shouldBlockSlashSubmit("/context"), false);

  await runtime.engine.handleSubmit("/model gpt-4.1-mini");
  const modelSuggestions = runtime.getSuggestions("/model");
  assert.equal(modelSuggestions[0]?.command, "/model gpt-4.1-mini");
  assert.match(modelSuggestions[0]?.description ?? "", /Current/i);
  assert.equal(runtime.shouldBlockSlashSubmit("/model"), true);
  assert.equal(runtime.shouldBlockSlashSubmit("/model gpt-4.1-mini"), false);
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

test("WorkShellEngine /clear clears stale work board done snapshot", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("hello");
  await engine.handleSubmit("/queue");
  assert.ok(engine.getState().panel?.lines.some((line) => /Done · 1/.test(line)));

  await engine.handleSubmit("/clear");
  await engine.handleSubmit("/queue");
  assert.ok(engine.getState().panel?.lines.some((line) => /Done · 0/.test(line)));
});

test("WorkShellEngine applies /reasoning updates and syncs agent runtime settings", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/reasoning low");

  assert.equal(engine.getState().reasoning.effort, "low");
  assert.equal(calls.runtimeSettings.length, 1);
  assert.equal(calls.runtimeSettings[0]?.reasoning?.effort, "low");
  assert.equal(engine.getState().panel.title, "Status");
  assert.ok(engine.getState().panel.lines.includes("reasoning:low"));
  assert.ok(
    engine.getState().entries.some((entry) => entry.text === "Reasoning · Light selected."),
  );
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
  assert.equal(engine.getState().panel.title, "Status");
  assert.ok(engine.getState().panel.lines.includes("model:gpt-4.1-mini"));
  assert.ok(engine.getState().panel.lines.includes("reasoning:unsupported"));
});

test("WorkShellEngine applies supported /model updates without losing reasoning overrides", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/model gpt-5.5");

  assert.equal(engine.getState().model, "gpt-5.5");
  assert.equal(engine.getState().reasoning.effort, "high");
  assert.equal(engine.getState().reasoning.source, "mode-default");
  assert.equal(calls.runtimeSettings.length, 1);
  assert.equal(calls.runtimeSettings[0]?.model, "gpt-5.5");
  assert.equal(calls.runtimeSettings[0]?.reasoning?.effort, "high");
  assert.equal(calls.turns.length, 0);
});

test("WorkShellEngine keeps malformed slash commands local", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/modl");

  assert.equal(calls.turns.length, 0);
  assert.ok(
    engine.getState().entries.some(
      (entry) => entry.role === "system" && /Unknown command \/modl\. Did you mean \/model\?/.test(entry.text),
    ),
  );
});

test("WorkShellEngine does not echo malformed slash command arguments", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/modl SECRET_ARGUMENT_DO_NOT_ECHO");

  assert.equal(calls.turns.length, 0);
  assert.doesNotMatch(
    JSON.stringify(engine.getState().entries),
    /SECRET_ARGUMENT_DO_NOT_ECHO/,
  );
  assert.doesNotMatch(
    JSON.stringify(engine.getState().panel),
    /SECRET_ARGUMENT_DO_NOT_ECHO/,
  );
  assert.ok(
    engine.getState().entries.some(
      (entry) => entry.role === "system" && /Unknown command \/modl\. Did you mean \/model\?/.test(entry.text),
    ),
  );
});

test("WorkShellEngine opens sessions with immediate loading and visible failure states", async () => {
  let resolveSessions;
  const { engine } = createEngine({
    async listSessionLines() {
      return new Promise((resolve) => {
        resolveSessions = resolve;
      });
    },
  });

  await engine.initialize();
  const pending = engine.openSessionsPanel();
  assert.deepEqual(engine.getState().panel, {
    title: "Recent sessions",
    lines: ["Loading sessions…"],
  });

  resolveSessions(["session-1"]);
  await pending;
  assert.deepEqual(engine.getState().panel, {
    title: "Recent sessions",
    lines: ["session-1"],
  });

  const failing = createEngine({
    async listSessionLines() {
      throw new Error("store unavailable");
    },
  }).engine;
  await failing.initialize();
  await failing.openSessionsPanel();
  assert.deepEqual(failing.getState().panel, {
    title: "Recent sessions",
    lines: [
      "Unable to load sessions · store unavailable",
      "Use /context to inspect the loaded workspace context.",
    ],
  });
});

test("WorkShellEngine opens /context as an overlay and can dismiss it", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  const entriesBefore = engine.getState().entries.length;
  await engine.handleSubmit("/context");

  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.equal(engine.getState().entries.length, entriesBefore);

  engine.closeOverlay();

  assert.equal(engine.getState().panel.title, "Context");
});

test("WorkShellEngine binds chat prompts and /context inspector to the same injected context packet", async () => {
  const prompts = [];
  let packetCalls = 0;
  const packet = {
    id: "packet-work-shell-1",
    version: 1,
    generatedAt: "2026-06-04T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "workspace-guidance",
        category: "workspace",
        label: "AGENTS.md",
        reason: "repo instructions loaded",
        preview: "Use <small> reversible diffs.",
        tokenEstimate: 12,
      },
      {
        id: "omo-goal",
        category: "omo",
        label: "G001 context MVP",
        reason: "active ULW goal",
        preview: "Deliver context view.",
        tokenEstimate: 18,
      },
    ],
    excluded: [
      {
        id: "omo-ledger",
        category: "omo",
        label: ".omo/ulw-loop/session/ledger.jsonl",
        reason: "raw OMO ledger stays local",
      },
    ],
    warnings: [
      {
        code: "omo.multiple-active",
        message: "Multiple active OMO sessions detected.",
        severity: "warning",
      },
    ],
    preview: ["Context will be carried into the next answer."],
    sourceCounts: {
      included: 2,
      excluded: 1,
      warnings: 1,
    },
    tokenEstimate: 30,
  };
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        return { text: "packet-bound response" };
      },
    },
    resolveContextPacket: async () => {
      packetCalls += 1;
      return packet;
    },
  });

  await engine.initialize();
  assert.equal(packetCalls, 0);
  assert.equal(engine.getState().contextIndicator, undefined);

  await engine.handleSubmit("summarize repo");

  assert.equal(packetCalls, 1);
  assert.match(engine.getState().contextIndicator ?? "", /▤ 2 ctx · ~30t · 1 held · 1⚠/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /<unclecode_context_packet id="packet-work-shell-1" version="1">/);
  assert.match(prompts[0] ?? "", /Included:\n- workspace: AGENTS\.md \(repo instructions loaded\) - Use &lt;small&gt; reversible diffs\./);
  assert.match(prompts[0] ?? "", /- omo: G001 context MVP \(active ULW goal\) - Deliver context view\./);
  assert.match(prompts[0] ?? "", /Excluded raw artifacts:\n- 1 raw artifact withheld from model-ready context; inspect \/context for local-only details\./);
  assert.doesNotMatch(prompts[0] ?? "", /\.omo\/ulw-loop\/session\/ledger\.jsonl/);
  assert.match(prompts[0] ?? "", /Warnings:\n- 1 context issue withheld from model-ready context; inspect \/context for local-only details\./);
  assert.doesNotMatch(prompts[0] ?? "", /Multiple active OMO sessions/);
  assert.match(prompts[0] ?? "", /User request:\nsummarize repo$/);
  assert.equal(engine.getState().entries.find((entry) => entry.role === "user")?.text, "summarize repo");
  assert.equal(engine.getState().entries.some(
    (entry) => entry.role === "system" && entry.text.startsWith("Context used ·"),
  ), false, "context packet receipts stay in the context surface, not the transcript");

  await engine.handleSubmit("/context");

  assert.equal(packetCalls, 2);
  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.ok(engine.getState().panel.lines.some((line) => line.startsWith("Sources ·")));
  assert.ok(engine.getState().panel.lines.includes("Included in next answer"));
  assert.ok(engine.getState().panel.lines.some((line) => /workspace · 1 · Use <small> reversible diffs\./.test(line)));
  assert.ok(engine.getState().panel.lines.some((line) => /omo · 1 · Deliver context view\./.test(line)));
  assert.ok(engine.getState().panel.lines.includes("Held back locally"));
  assert.ok(engine.getState().panel.lines.some((line) => line.includes('Next answer · <unclecode_context_packet id="packet-work-shell-1" version="1">')));
  assert.ok(engine.getState().panel.lines.includes("Provider prompt prefix"));
  assert.equal(engine.getState().panel.lines.some((line) => /\bPacket\b|provider packet|Next model-call packet/.test(line)), false);
  assert.equal(engine.getState().panel.lines.some((line) => line.startsWith("Context ·")), false);
  assert.equal(engine.getState().panel.lines.some((line) => line.startsWith("Controls ·")), false);
});

test("WorkShellEngine sends the manifest-owned provider prompt for a resolved packet", async () => {
  const providerPrompts = [];
  const manifestInputs = [];
  const packet = {
    id: "packet-manifest-1",
    version: 1,
    generatedAt: "2026-07-12T00:00:00.000Z",
    title: "Next answer context",
    included: [],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 0, excluded: 0, warnings: 0 },
    tokenEstimate: 0,
    tokenEstimateState: "exact",
    manifest: {
      id: "packet-manifest-1:build",
      profileId: "build",
      createdAt: "2026-07-12T00:00:00.000Z",
      packetId: "packet-manifest-1",
      policy: [],
      includedSourceCount: 0,
      excludedSourceCount: 0,
      tokenEstimate: 0,
    },
  };
  const { engine, calls } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        providerPrompts.push(prompt);
        return { text: "done" };
      },
    },
    resolveContextPacket: async () => packet,
    resolvePromptManifest(input) {
      manifestInputs.push(input);
      return { providerPrompt: `manifest-owned:${input.packet.id}:${input.userPrompt}` };
    },
  });

  await engine.handleSubmit("write focused tests");

  assert.deepEqual(manifestInputs, [{ packet, userPrompt: "write focused tests" }]);
  assert.deepEqual(providerPrompts, ["manifest-owned:packet-manifest-1:write focused tests"]);
  assert.deepEqual(engine.getState().agentConsole.manifest, packet.manifest);
  assert.deepEqual(calls.snapshots.at(-1)?.agentConsole?.manifest, packet.manifest);
});

test("WorkShellEngine binds ask_user to a durable composer decision", async () => {
  const interactionBridge = createWorkShellInteractionBridge();
  const { engine, calls } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      interactionBridge,
    },
  });
  await engine.initialize();

  const result = interactionBridge.ask({
    id: "decision-1",
    title: "Execution choice",
    questions: [{
      id: "strategy",
      question: "Choose execution strategy.",
      options: [{ label: "Safe" }, { label: "Fast" }],
      recommended: 0,
    }],
  });
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-1");
  assert.equal(engine.getState().panel.title, "Decision");

  await engine.handleSubmit("2");

  assert.deepEqual(await result, {
    status: "answered",
    answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
  });
  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
  assert.ok(calls.snapshots.some((snapshot) => snapshot.state === "requires_action"));
  assert.ok(calls.snapshots.some((snapshot) => snapshot.state === "running"));
});

test("WorkShellEngine clears orphaned resumed decisions before accepting new input", async () => {
  const { engine } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      initialAgentConsole: {
        profileId: "build",
        pendingDecision: {
          id: "decision-stale",
          questions: [{
            id: "strategy",
            question: "Choose a strategy.",
            options: [{ label: "Safe" }],
          }],
        },
        activity: [],
      },
    },
  });

  await engine.initialize();

  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
  assert.ok(engine.getState().entries.some((entry) => entry.text.includes("could not be resumed")));
});

test("WorkShellEngine context inspector actions mutate the selected CRP source", async () => {
  let salience = 0.5;
  let includedInModel = true;
  const mutations = [];
  const makePacket = () => {
    const item = {
      id: "workspace-guidance",
      category: "workspace",
      label: "AGENTS.md",
      reason: "repo instructions loaded",
      preview: "Use narrow diffs.",
      tokenEstimate: 12,
      salience,
      includedInModel,
    };
    return {
      id: `packet-${mutations.length}`,
      version: 1,
      generatedAt: "2026-06-04T00:00:00.000Z",
      title: "Next answer context",
      included: includedInModel ? [item] : [],
      excluded: includedInModel ? [] : [item],
      warnings: [],
      preview: ["Context will be carried into the next answer."],
      sourceCounts: {
        included: includedInModel ? 1 : 0,
        excluded: includedInModel ? 0 : 1,
        warnings: 0,
      },
      tokenEstimate: includedInModel ? 12 : 0,
    };
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => makePacket(),
    mutateContextSource(action) {
      const before = {
        category: "workspace",
        label: "AGENTS.md",
        includedInModel,
        salience,
        tokenEstimate: 12,
      };
      mutations.push(action);
      if (action.kind === "pin") salience = 1;
      if (action.kind === "unpin") salience = 0.5;
      if (action.kind === "forget") includedInModel = false;
      if (action.kind === "include") includedInModel = true;
      return {
        id: `receipt-${mutations.length}`,
        action: action.kind === "forget" ? "hold-back" : action.kind,
        sourceId: action.id,
        sourceLabel: "AGENTS.md",
        message: `${action.kind} AGENTS.md`,
        canUndo: true,
        before,
        after: {
          category: "workspace",
          label: "AGENTS.md",
          includedInModel,
          salience,
          tokenEstimate: 12,
        },
      };
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  assert.equal(engine.getState().contextInspectorCursor, 0);

  await engine.toggleContextInspectorPin();
  assert.deepEqual(mutations.at(-1), { kind: "pin", id: "workspace-guidance" });
  assert.equal(engine.getState().contextPacket?.included[0]?.salience, 1);
  assert.equal(engine.getState().contextActionReceipt?.beforePacketId, "packet-0");
  assert.equal(engine.getState().contextActionReceipt?.afterPacketId, "packet-1");
  assert.equal(engine.getState().contextActionReceipt?.action, "pin");

  await engine.toggleContextInspectorPin();
  assert.deepEqual(mutations.at(-1), { kind: "unpin", id: "workspace-guidance" });
  assert.equal(engine.getState().contextPacket?.included[0]?.salience, 0.5);

  await engine.forgetContextSourceAtCursor();
  assert.deepEqual(mutations.at(-1), { kind: "forget", id: "workspace-guidance" });
  assert.equal(engine.getState().contextPacket?.excluded[0]?.includedInModel, false);
  assert.equal(engine.getState().contextActionReceipt?.action, "hold-back");
  assert.equal(engine.getState().contextActionReceipt?.before?.includedInModel, true);
  assert.equal(engine.getState().contextActionReceipt?.after?.includedInModel, false);

  await engine.includeContextSourceAtCursor();
  assert.deepEqual(mutations.at(-1), { kind: "include", id: "workspace-guidance" });
  assert.equal(engine.getState().contextPacket?.included[0]?.includedInModel, true);
});

test("WorkShellEngine loads local source details on Enter and scrolls without moving the source cursor", async () => {
  const packet = {
    id: "packet-detail-reader",
    version: 1,
    generatedAt: "2026-07-12T00:00:00.000Z",
    title: "Next answer context",
    included: [{
      id: "provider-system-prompt-configured",
      category: "provider-system-prompt",
      label: "Configured prompt",
      reason: "prompt guidance active",
      preview: "Configured prompt sections are active; raw prompt text stays local.",
      tokenEstimate: 22,
      includedInModel: true,
    }],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 22,
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    resolveContextSourceDetail: async (sourceId) =>
      sourceId === "provider-system-prompt-configured"
        ? "# Configured prompt\nRule one.\nRule two.\nRule three."
        : undefined,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  await engine.toggleContextInspectorExpanded();

  assert.equal(engine.getState().contextInspectorExpanded, "provider-system-prompt-configured");
  assert.match(engine.getState().contextInspectorDetailContent ?? "", /Rule three\./);
  assert.equal(engine.getState().contextInspectorDetailOffset, 0);

  engine.moveContextInspectorDetailOffset(1);
  assert.equal(engine.getState().contextInspectorDetailOffset, 1);
  assert.equal(engine.getState().contextInspectorCursor, 0);

  await engine.toggleContextInspectorExpanded();
  assert.equal(engine.getState().contextInspectorExpanded, null);
  assert.equal(engine.getState().contextInspectorDetailContent, undefined);
  assert.equal(engine.getState().contextInspectorDetailOffset, 0);
});

test("WorkShellEngine clears local detail when the next source has no resolver content", async () => {
  const packet = {
    id: "packet-detail-switch",
    version: 1,
    generatedAt: "2026-07-12T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "source-with-detail",
        category: "workspace-guidance",
        label: "Workspace guidance",
        reason: "local detail available",
        preview: "Detail stays local.",
        includedInModel: true,
      },
      {
        id: "source-without-detail",
        category: "runtime",
        label: "Runtime source",
        reason: "metadata only",
        preview: "No local detail.",
        includedInModel: true,
      },
    ],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 2, excluded: 0, warnings: 0 },
    tokenEstimate: 0,
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    resolveContextSourceDetail: async (sourceId) =>
      sourceId === "source-with-detail" ? "LOCAL_DETAIL_A" : undefined,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  await engine.toggleContextInspectorExpanded();
  assert.equal(engine.getState().contextInspectorDetailContent, "LOCAL_DETAIL_A");

  engine.moveContextInspectorCursor(1);
  await engine.toggleContextInspectorExpanded();

  assert.equal(engine.getState().contextInspectorExpanded, "source-without-detail");
  assert.equal(engine.getState().contextInspectorDetailContent, undefined);
});

test("WorkShellEngine ignores late local detail after the Context Desk closes", async () => {
  let releaseDetail;
  const packet = {
    id: "packet-late-detail",
    version: 1,
    generatedAt: "2026-07-12T00:00:00.000Z",
    title: "Next answer context",
    included: [{
      id: "configured-prompt",
      category: "provider-system-prompt",
      label: "Configured prompt",
      reason: "prompt guidance active",
      preview: "Local detail available.",
      includedInModel: true,
    }],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 0,
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    resolveContextSourceDetail: async () => new Promise((resolve) => {
      releaseDetail = resolve;
    }),
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  const opening = engine.toggleContextInspectorExpanded();
  engine.closeOverlay();
  releaseDetail?.("LATE_LOCAL_PROMPT");
  await opening;

  assert.equal(engine.getState().contextInspectorExpanded, null);
  assert.equal(engine.getState().contextInspectorDetailContent, undefined);
});

test("WorkShellEngine preserves selected source identity across include/hold refresh reorder", async () => {
  /** @type {Map<string, { includedInModel: boolean, salience: number }>} */
  const sourceState = new Map([
    ["alpha", { includedInModel: true, salience: 0.4 }],
    ["beta", { includedInModel: true, salience: 0.9 }],
    ["gamma", { includedInModel: false, salience: 0.5 }],
  ]);
  const mutations = [];
  const makePacket = () => {
    const items = [...sourceState.entries()].map(([id, state]) => ({
      id,
      category: id === "gamma" ? "runtime" : "workspace",
      label: `${id}.md`,
      reason: "identity fixture",
      preview: `${id} preview`,
      tokenEstimate: 10,
      salience: state.salience,
      includedInModel: state.includedInModel,
    }));
    // Reorder on every refresh: held sources first by descending salience, then included.
    // This intentionally reshuffles numeric indexes after include/hold.
    const held = items.filter((item) => !item.includedInModel).sort((a, b) => b.salience - a.salience);
    const included = items.filter((item) => item.includedInModel).sort((a, b) => b.salience - a.salience);
    return {
      id: `packet-identity-${mutations.length}`,
      version: 1,
      generatedAt: "2026-07-12T00:00:00.000Z",
      title: "Next answer context",
      included,
      excluded: held,
      warnings: [],
      preview: [],
      sourceCounts: { included: included.length, excluded: held.length, warnings: 0 },
      tokenEstimate: included.length * 10,
    };
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => makePacket(),
    mutateContextSource(action) {
      mutations.push(action);
      const current = sourceState.get(action.id);
      if (!current) {
        throw new Error(`unknown source ${action.id}`);
      }
      if (action.kind === "forget") {
        sourceState.set(action.id, { ...current, includedInModel: false });
      }
      if (action.kind === "include") {
        sourceState.set(action.id, { ...current, includedInModel: true, salience: 1 });
      }
      if (action.kind === "pin") {
        sourceState.set(action.id, { ...current, salience: 1 });
      }
      if (action.kind === "unpin") {
        sourceState.set(action.id, { ...current, salience: 0.5 });
      }
      return {
        id: `receipt-${mutations.length}`,
        action: action.kind === "forget" ? "hold-back" : action.kind,
        sourceId: action.id,
        sourceLabel: `${action.id}.md`,
        message: `${action.kind} ${action.id}.md`,
        canUndo: true,
      };
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");

  // included order after first load: beta (0.9), alpha (0.4), then held gamma
  assert.deepEqual(
    engine.getState().contextPacket?.included.map((item) => item.id),
    ["beta", "alpha"],
  );
  engine.moveContextInspectorCursor(1); // land on alpha (index 1)
  assert.equal(engine.getState().contextInspectorCursor, 1);

  await engine.forgetContextSourceAtCursor();
  assert.deepEqual(mutations.at(-1), { kind: "forget", id: "alpha" });
  // After hold-back, packet reorders but selection must stay on alpha by id.
  assert.equal(
    engine.getState().contextPacket?.excluded.some((item) => item.id === "alpha"),
    true,
  );

  // Prove identity via the next action, not packet concat order (inspector list is group-sorted).
  await engine.includeContextSourceAtCursor();
  assert.deepEqual(mutations.at(-1), { kind: "include", id: "alpha" });
  assert.equal(
    engine.getState().contextPacket?.included.some((item) => item.id === "alpha"),
    true,
  );
  // Include fixture pins salience to 1.0; the next Enter must still target alpha.
  await engine.toggleContextInspectorPin();
  assert.deepEqual(mutations.at(-1), { kind: "unpin", id: "alpha" });
});

test("WorkShellEngine reuses the previewed /context packet for the next chat turn", async () => {
  const prompts = [];
  let packetCalls = 0;
  const makePacket = (id) => ({
    id,
    version: 1,
    generatedAt: "2026-07-08T00:00:00.000Z",
    title: "Next answer context",
    included: [{
      id: "workspace-guidance",
      category: "workspace",
      label: "AGENTS.md",
      reason: "repo instructions loaded",
      preview: "Keep diffs small.",
      tokenEstimate: 20,
    }],
    excluded: [],
    warnings: [],
    preview: ["decorative preview"],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 20,
  });
  const previewPacket = makePacket("packet-previewed");
  const refreshedPacket = makePacket("packet-refreshed");
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        return { text: "used preview" };
      },
    },
    resolveContextPacket: async () => {
      packetCalls += 1;
      return packetCalls === 1 ? previewPacket : refreshedPacket;
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  assert.equal(packetCalls, 1);
  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.ok(engine.getState().panel.lines.some((line) => line.includes("packet-previewed")));

  await engine.handleSubmit("use the preview");

  assert.equal(packetCalls, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /<unclecode_context_packet id="packet-previewed" version="1">/);
  assert.doesNotMatch(prompts[0] ?? "", /packet-refreshed/);
  assert.equal(engine.getState().entries.some(
    (entry) => entry.role === "system" && entry.text.startsWith("Context used ·"),
  ), false, "reusing a previewed packet does not append a duplicate context receipt");
});

test("WorkShellEngine shows a busy spinner state while resolving composer context", async () => {
  let releaseComposer;
  let agentCalled = false;
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        agentCalled = true;
        return { text: `reply:${prompt}` };
      },
    },
    resolveComposerInput: async (value) => new Promise((resolve) => {
      releaseComposer = () => resolve({
        prompt: value.trim(),
        attachments: [],
        transcriptText: value.trim(),
      });
    }),
  });

  await engine.initialize();
  const submit = engine.handleSubmit("제대로 되는거 맞냐");
  for (let attempt = 0; attempt < 100 && !engine.getState().isBusy; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(engine.getState().isBusy, true);
  assert.equal(engine.getState().busyStatus, "preparing context");
  assert.equal(agentCalled, false);
  for (let attempt = 0; attempt < 100 && typeof releaseComposer !== "function"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(typeof releaseComposer, "function");

  releaseComposer();
  await submit;

  assert.equal(agentCalled, true);
  assert.equal(engine.getState().isBusy, false);
});

test("WorkShellEngine treats /con as the human context shortcut", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/con");

  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.equal(engine.getState().entries.some((entry) => entry.text === "Context opened."), false);
  assert.doesNotMatch(engine.getState().entries.map((entry) => entry.text).join("\n"), /Unsupported work-shell inline command|packet/i);
});

test("WorkShellEngine collapses expanded context when a normal chat turn starts", async () => {
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn() {
        return { text: "chat response" };
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  assert.equal(engine.getState().panel.title, "Context expanded");

  await engine.handleSubmit("반갑다");

  assert.equal(engine.getState().panel.title, "Context");
  assert.ok(engine.getState().entries.some((entry) => entry.role === "assistant" && entry.text === "chat response"));
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
  assert.equal(engine.getState().panel.title, "Doctor");
  assert.equal(engine.getState().authLabel, "oauth-file");
  assert.ok(engine.getState().entries.some((entry) => entry.text.includes("Doctor · Doctor report")));
});

test("WorkShellEngine setMode switches runtime mode without transcript residue", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  const entriesBefore = engine.getState().entries.length;
  await engine.setMode("search");

  assert.equal(engine.getState().mode, "search");
  assert.deepEqual(calls.modeUpdates, ["search"]);
  assert.deepEqual(calls.inline, []);
  assert.equal(engine.getState().entries.length, entriesBefore);

  await engine.handleSubmit("please edit src/app.ts");

  assert.ok(engine.getState().entries.some((entry) => /Search mode is read-only/.test(entry.text)));
  assert.deepEqual(calls.inline, []);
});

test("WorkShellEngine accepts explicit /mode set without unsupported inline residue", async () => {
  const { engine, calls } = createEngine({
    async runInlineCommand(args) {
      calls.inline.push(args);
      return ["Active mode saved: search", "Label: 탐색 모드"];
    },
    resolveWorkShellSlashCommand(input) {
      throw new Error(`Rust-owned mode route should not need TS re-resolution for ${input}`);
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/mode set search");

  assert.deepEqual(calls.inline, [["mode", "set", "search"]]);
  assert.deepEqual(calls.modeUpdates, ["search"]);
  assert.equal(engine.getState().mode, "search");
  assert.doesNotMatch(engine.getState().entries.map((entry) => entry.text).join("\n"), /Unsupported work-shell inline command/);
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
      throw new Error(`Rust-owned auth submit route should not need TS re-resolution for ${input}`);
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
  await engine.handleSubmit("/browser");

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

  assert.equal(engine.getState().panel.title, "Auth");
  assert.equal(engine.getState().panel.lines[0], "OAuth login complete.");
});

test("WorkShellEngine cancels secure api-key entry without opening sessions", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/auth key");
  engine.cancelSensitiveInput();

  assert.equal(engine.getState().composerMode, "default");
  assert.equal(engine.getState().panel.title, "Session status");
  assert.ok(engine.getState().panel.lines.includes("Auth · API key · env"));
  assert.ok(engine.getState().entries.some((entry) => entry.text === "API key entry canceled."));
});

test("WorkShellEngine can refine inline auth failures into product guidance", async () => {
  const { engine } = createEngine({
    resolveWorkShellSlashCommand(input) {
      throw new Error(`Rust-owned auth submit route should not need TS re-resolution for ${input}`);
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
  await engine.handleSubmit("/browser");

  assert.equal(engine.getState().panel.title, "Auth");
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
      return ["Work context refreshed", "Saved locally: /tmp/research.md"];
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/research current workspace");

  assert.deepEqual(calls.inline, [["research", "run", "current", "workspace"]]);
  assert.equal(engine.getState().panel.title, "research run current workspace");
  assert.ok(engine.getState().entries.some((entry) => entry.text.includes("Work context refreshed")));
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
    "session · memory refreshed · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged",
  ]);
  assert.ok(engine.getState().entries.some((entry) => entry.text === "Workspace context reloaded."));
});

test("WorkShellEngine preserves expanded context while reloading workspace context", async () => {
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
  await engine.handleSubmit("/context");
  await engine.handleSubmit("/reload");

  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.deepEqual(engine.getState().panel.lines, [
    "Loaded guidance: CLAUDE.md",
    "Loaded extension: focus-tools",
    "bridge refreshed",
    "session · memory refreshed · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged",
  ]);

  engine.closeOverlay();

  assert.equal(engine.getState().panel.title, "Context");
  assert.deepEqual(engine.getState().panel.lines, [
    "Loaded guidance: CLAUDE.md",
    "Loaded extension: focus-tools",
    "bridge refreshed",
    "session · memory refreshed · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged",
  ]);
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

test("WorkShellEngine soft-interrupts a busy turn and ignores late assistant output", async () => {
  let releaseTurn;
  let turnSignal;
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt, _attachments, options) {
        turnSignal = options?.signal;
        await new Promise((resolve) => {
          releaseTurn = resolve;
        });
        return { text: `late:${prompt}` };
      },
    },
  });

  await engine.initialize();
  const turn = engine.handleSubmit("first");
  for (let attempt = 0; attempt < 400 && !turnSignal; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(engine.getState().isBusy, true);
  assert.equal(turnSignal?.aborted, false);
  engine.interruptTurn();
  assert.equal(engine.getState().isBusy, false);
  assert.equal(turnSignal?.aborted, true);
  assert.ok(engine.getState().entries.some((entry) => entry.text.startsWith("Turn interrupted.")));

  releaseTurn();
  await turn;

  assert.equal(engine.getState().isBusy, false);
  assert.equal(
    engine.getState().entries.some((entry) => entry.text.includes("late:first")),
    false,
  );
});

test("WorkShellEngine persists an interrupted turn as idle and ignores late failure snapshots", async () => {
  let releaseTurn;
  let turnSignal;
  const { engine, calls } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(_prompt, _attachments, options) {
        turnSignal = options?.signal;
        await new Promise((resolve) => {
          releaseTurn = resolve;
        });
        throw new Error("late failure after interrupt");
      },
    },
  });

  await engine.initialize();
  const turn = engine.handleSubmit("first");
  for (let attempt = 0; attempt < 400 && !turnSignal; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  engine.interruptTurn();
  for (let attempt = 0; attempt < 400 && calls.snapshots.at(-1)?.summary !== "Turn interrupted."; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(calls.snapshots.at(-1)?.state, "idle");
  assert.equal(calls.snapshots.at(-1)?.summary, "Turn interrupted.");

  releaseTurn();
  await turn;

  assert.equal(
    calls.snapshots.some((snapshot) => snapshot.state === "requires_action" && /first/.test(snapshot.summary)),
    false,
  );
});

test("WorkShellEngine resumes interrupted queued follow-ups after the next chat turn", async () => {
  let releaseFirst;
  let releaseThird;
  const prompts = [];
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        if (prompt === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        if (prompt === "third") {
          await new Promise((resolve) => {
            releaseThird = resolve;
          });
        }
        return { text: `reply:${prompt}` };
      },
    },
  });

  await engine.initialize();
  const firstTurn = engine.handleSubmit("first");
  while (!engine.getState().isBusy || typeof releaseFirst !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("second");
  engine.interruptTurn();
  assert.equal(engine.getState().queuePaused, true);
  const thirdTurn = engine.handleSubmit("third");
  while (typeof releaseThird !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  releaseThird();
  await thirdTurn;

  assert.deepEqual(prompts, ["first", "third", "second"]);
  assert.equal(engine.getState().queuePaused, false);

  releaseFirst();
  await firstTurn;

  assert.deepEqual(prompts, ["first", "third", "second"]);
});

test("WorkShellEngine queues follow-up chat while a turn is busy", async () => {
  let releaseFirst;
  const prompts = [];
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        if (prompt === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { text: `reply:${prompt}` };
      },
    },
  });

  await engine.initialize();
  const firstTurn = engine.handleSubmit("first");
  while (!engine.getState().isBusy) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("second");
  assert.ok(engine.getState().entries.some((entry) => /Queued follow-up #1/.test(entry.text)));
  assert.ok(engine.getState().entries.some((entry) => /run automatically/.test(entry.text)));
  assert.ok(engine.getState().entries.some((entry) => /\/queue shows backlog/.test(entry.text)));
  await engine.handleSubmit("/queue");
  assert.equal(engine.getState().panel?.title, "Work board");
  assert.ok(engine.getState().panel?.lines.some((line) => line === "Board"));
  assert.ok(engine.getState().panel?.lines.some((line) => /Queued · 1/.test(line)));
  assert.ok(engine.getState().panel?.lines.some((line) => /#1 second/.test(line)));
  assert.ok(engine.getState().panel?.lines.some((line) => /Enter queues follow-up/.test(line)));
  assert.ok(engine.getState().panel?.lines.some((line) => /\/queue clear drops queued follow-ups/.test(line)));

  releaseFirst();
  await firstTurn;

  assert.deepEqual(prompts, ["first", "second"]);
  assert.ok(engine.getState().entries.some((entry) => /Running queued follow-up #1: second/.test(entry.text)));
});

test("WorkShellEngine binds queued follow-up chat to a fresh context packet", async () => {
  let releaseFirst;
  let packetCalls = 0;
  const prompts = [];
  const makePacket = (id) => ({
    id,
    version: 1,
    generatedAt: "2026-06-04T00:00:00.000Z",
    title: "Next answer context",
    included: [{
      id: "workspace-guidance",
      category: "workspace",
      label: "AGENTS.md",
      reason: "repo instructions loaded",
      preview: "Keep diffs small.",
      tokenEstimate: 8,
    }],
    excluded: [],
    warnings: [],
    preview: ["Context will be carried into the next answer."],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 8,
  });
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        if (/User request:\nfirst$/.test(prompt)) {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { text: `reply:${prompt.match(/User request:\n([\s\S]*)$/)?.[1] ?? prompt}` };
      },
    },
    resolveContextPacket: async () => {
      packetCalls += 1;
      return makePacket(`packet-${packetCalls}`);
    },
  });

  await engine.initialize();
  const firstTurn = engine.handleSubmit("first");
  while (!engine.getState().isBusy || typeof releaseFirst !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("second");
  assert.ok(engine.getState().entries.some((entry) => /Queued follow-up #1/.test(entry.text)));

  releaseFirst();
  await firstTurn;

  assert.equal(packetCalls, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? "", /<unclecode_context_packet id="packet-1" version="1">/);
  assert.match(prompts[0] ?? "", /User request:\nfirst$/);
  assert.match(prompts[1] ?? "", /<unclecode_context_packet id="packet-2" version="1">/);
  assert.match(prompts[1] ?? "", /User request:\nsecond$/);
  assert.ok(engine.getState().entries.some((entry) => /Running queued follow-up #1: second/.test(entry.text)));
});

test("WorkShellEngine clears queued follow-ups while busy", async () => {
  let releaseFirst;
  const prompts = [];
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        if (prompt === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { text: `reply:${prompt}` };
      },
    },
  });

  await engine.initialize();
  const firstTurn = engine.handleSubmit("first");
  while (!engine.getState().isBusy) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("second");
  await engine.handleSubmit("/queue clear");
  assert.equal(
    engine.getState().entries.filter((entry) => /Queue cleared/.test(entry.text)).length,
    1,
  );
  assert.equal(
    engine.getState().entries.filter((entry) => /Queue shown/.test(entry.text)).length,
    0,
  );
  assert.equal(engine.getState().panel?.title, "Work board");
  assert.ok(engine.getState().panel?.lines.some((line) => /Queued · 0/.test(line)));
  assert.ok(engine.getState().panel?.lines.some((line) => /Running · 1/.test(line)));

  releaseFirst();
  await firstTurn;

  assert.deepEqual(prompts, ["first"]);
});

test("WorkShellEngine queue panel respects terminal width for board layout", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  engine.updateTerminalColumns(80);
  await engine.handleSubmit("/queue");
  const narrowLines = engine.getState().panel?.lines ?? [];
  assert.equal(engine.getState().panel?.title, "Work board");
  assert.ok(
    !narrowLines.some((line) => /Queued ·/.test(line) && /Done ·/.test(line)),
    "80-column layout should use 2×2 rows instead of a single four-column header",
  );

  engine.updateTerminalColumns(120);
  let wideLines = engine.getState().panel?.lines ?? [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    wideLines = engine.getState().panel?.lines ?? [];
    if (wideLines.some((line) => /Queued ·/.test(line) && /Done ·/.test(line))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    wideLines.some((line) => /Queued ·/.test(line) && /Done ·/.test(line)),
    "wide layout should rebuild on resize without re-running /queue",
  );
});

test("resolveQueueBlockedReason covers auth, plan guard, and read-only guard", () => {
  assert.equal(
    resolveQueueBlockedReason({ authLabel: "oauth-file-api-blocked" }),
    "oauth file api blocked",
  );
  assert.equal(
    resolveQueueBlockedReason({ authLabel: "none" }),
    "not signed in",
  );
  assert.equal(
    resolveQueueBlockedReason({
      authLabel: "oauth-file",
      contextSummaryLines: [
        "Auth issue: saved OAuth needs refresh. Use /auth login.",
      ],
    }),
    "saved OAuth needs refresh. Use /auth login.",
  );
  assert.match(
    resolveQueueBlockedReason({
      authLabel: "api-key-env",
      entries: [
        {
          role: "system",
          text: "Plan mode blocks edits. Switch with /mode set build or yolo, then resend.",
        },
      ],
    }) ?? "",
    /Plan mode blocks edits/,
  );
  assert.match(
    resolveQueueBlockedReason({
      authLabel: "api-key-env",
      entries: [
        {
          role: "system",
          text: "Search mode is read-only. Switch with /mode set yolo, then resend your edit request.",
        },
      ],
    }) ?? "",
    /Search mode is read-only/,
  );
  assert.equal(
    resolveQueueBlockedReason({
      authLabel: "api-key-env",
      entries: [{ role: "system", text: "Queue shown." }],
    }),
    undefined,
  );
});

test("buildWorkShellQueueBuiltinInput prefers session snapshot for done column", () => {
  const payload = buildWorkShellQueueBuiltinInput({
    line: "/queue",
    state: {
      isBusy: false,
      busyStatus: undefined,
      mode: "default",
      authLabel: "api-key-env",
      queuePaused: false,
      entries: [
        { role: "user", text: "/queue" },
        { role: "system", text: "Queue shown." },
      ],
      terminalColumns: 100,
    },
    lastCompletedTurn: { user: "hi", assistant: "hello from snapshot" },
  });
  assert.deepEqual(payload.lastCompletedTurn, {
    user: "hi",
    assistant: "hello from snapshot",
  });
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

test("resolveWorkerBudget returns correct budget per mode including yolo", async () => {
  const { resolveWorkerBudget } = await import("../../packages/orchestrator/src/work-agent.ts");
  assert.equal(resolveWorkerBudget("default"), 1);
  assert.equal(resolveWorkerBudget("yolo"), 4);
  assert.equal(resolveWorkerBudget("ultrawork"), 5);
  assert.equal(resolveWorkerBudget("search"), 3);
  assert.equal(resolveWorkerBudget("analyze"), 3);
});

test("resolveModeDefaultReasoning preserves unsupported and tags supported with mode-default source", async () => {
  const { resolveModeDefaultReasoning } = await import("../../packages/orchestrator/src/work-shell-engine-state.ts");

  const unsupported = { effort: "medium", support: { status: "unsupported" }, source: "override" };
  assert.deepEqual(resolveModeDefaultReasoning(unsupported), unsupported);

  const supported = { effort: "high", support: { status: "supported" }, source: "override" };
  const result = resolveModeDefaultReasoning(supported);
  assert.equal(result.effort, "high");
  assert.equal(result.source, "mode-default");
});

test("parseAgentPlanResponse extracts valid tasks from agent JSON output", async () => {
  const { parseAgentPlanResponse } = await import("../../packages/orchestrator/src/work-agent.ts");

  const validJson = `Here are the tasks:
[
  {"id": "task-1", "summary": "Read the files", "prompt": "Read src/index.ts"},
  {"id": "task-2", "summary": "Fix the bug", "prompt": "Fix the null check in auth.ts"}
]`;
  const tasks = parseAgentPlanResponse(validJson);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.id, "task-1");
  assert.equal(tasks[1]?.summary, "Fix the bug");

  assert.deepEqual(parseAgentPlanResponse("no json here"), []);
  assert.deepEqual(parseAgentPlanResponse("[invalid json"), []);
  assert.deepEqual(parseAgentPlanResponse('["not objects"]'), []);
});
