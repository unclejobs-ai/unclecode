import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderContextInspectorOverlay } from "../../packages/tui/src/work-shell-context-inspector.tsx";
import { renderDebugFrame, waitForSettledFrame } from "../tui/work-shell-render-harness.mjs";

import { CONTEXT_DESK_GROUPS } from "@unclecode/contracts";
import { createOmpWorkerProvider, createOmpWorkerRunner } from "@unclecode/providers";
import { LiveRuntimeEngineRegistry } from "../../apps/unclecode-server/src/runtime-engine-rpc.ts";
import { createUsageRecorder } from "./usage-recorder-fixture.mjs";

import {
  WorkShellEngine,
  createWorkShellEngine,
  createWorkShellInteractionBridge,
  createWorkShellPaneRuntime,
  runRustCommandSync,
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
  resolveLastCompletedTurn,
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

function stripWorkShellLanguageInstruction(prompt) {
  if (!/^(?:Respond in English for this session\.|현재 세션의 사용자 언어를 따라)/u.test(prompt)) {
    return prompt;
  }
  const separator = prompt.indexOf("\n\n");
  return separator < 0 ? prompt : prompt.slice(separator + 2);
}
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
import { wrapDisplayTextFast } from "../../packages/tui/src/text-width.ts";

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
        if (event.type === "reasoning.delta") return `✦ thinking· ${event.delta}`;
        if (event.type === "tool.started") return `→ read ${event.input?.path ?? ""}`;
        if (event.type === "tool.completed") return `✓ read ${event.durationMs ?? 0}ms`;
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

test("WorkShellEngine restores a replay-safe approval pause without rerunning or overwriting it", async () => {
  let providerCalls = 0;
  const checkpoint = {
    turnId: "turn-restored-1",
    boundary: "before_approval",
    decisionId: "decision-restored-1",
    contextReceiptId: "receipt-restored-1",
    attachmentRefs: [],
    artifactRefs: ["artifact:sha256:restored"],
  };
  const { engine, calls } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      initialPauseCheckpoint: checkpoint,
      initialAgentConsole: {
        profileId: "build",
        pendingDecision: {
          kind: "user-decision",
          id: "decision-restored-1",
          title: "Continue?",
          questions: [{ id: "continue", question: "Continue?", options: [{ label: "Yes" }] }],
        },
        activity: [],
        agents: [],
        jobs: [],
      },
    },
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn() {
        providerCalls += 1;
        return { text: "must not run" };
      },
    },
  });

  await engine.initialize();

  assert.deepEqual(engine.getTurnLifecycle(), {
    state: "paused",
    turnId: "turn-restored-1",
    boundary: "before_approval",
  });
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-restored-1");
  assert.equal(providerCalls, 0);
  assert.equal(calls.snapshots.at(-1)?.state, "paused");
  assert.deepEqual(calls.snapshots.at(-1)?.pauseCheckpoint, checkpoint);
  await engine.persistRuntimeRevision(17);
  assert.equal(calls.snapshots.at(-1)?.ownerMutationRevision, 17);
  assert.deepEqual(calls.snapshots.at(-1)?.pauseCheckpoint, checkpoint);
  assert.equal(engine.resumeTurn(), false, "a recovered pause has no detached continuation to auto-rerun");
});

test("WorkShellEngine acknowledges pause only after the provider settles and resumes the same turn", async () => {
  let releaseProvider;
  let providerCalls = 0;
  const { engine, calls } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      updateMode() {},
      setTraceListener() {},
      async runTurn() {
        providerCalls += 1;
        return new Promise((resolve) => { releaseProvider = resolve; });
      },
    },
  });
  await engine.initialize();

  const turn = engine.handleSubmit("keep the same turn");
  while (!releaseProvider) await new Promise((resolve) => setImmediate(resolve));
  const turnId = engine.getTurnLifecycle().turnId;
  let acknowledged = false;
  const pause = engine.requestTurnPause().then((receipt) => {
    acknowledged = true;
    return receipt;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.getTurnLifecycle().state, "pause_pending");
  assert.equal(acknowledged, false);
  assert.equal(providerCalls, 1);

  releaseProvider({ text: "provider finished" });
  const receipt = await pause;
  assert.equal(receipt.turnId, turnId);
  assert.equal(receipt.boundary, "after_provider");
  assert.equal(engine.getTurnLifecycle().state, "paused");
  assert.ok(calls.snapshots.some((snapshot) => snapshot.state === "paused"));

  assert.equal(engine.resumeTurn(), true);
  await turn;
  assert.equal(providerCalls, 1, "resume must not create a second user or provider turn");
  assert.equal(engine.getTurnLifecycle().state, "completed");
});

test("WorkShellEngine can suspend at a pending approval without cancelling or answering it", async () => {
  const interactionBridge = createWorkShellInteractionBridge();
  let decision;
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
      initialLastSubmittedContextReceiptId: "receipt-pause-1",
      initialAgentConsole: {
        profileId: "build",
        activity: [],
        agents: [],
        jobs: [],
        workGraph: {
          id: "graph-pause",
          qualityProfile: "deep",
          currentStage: "critic",
          gateStatus: "refine",
          iteration: 2,
          approval: "approved",
          nodes: [{
            id: "critic-1", title: "Independent review", prompt: "review",
            status: "requires_action", dependsOn: [], fileOwnership: [],
            evidenceRefs: [], stage: "critic", role: "critic", attempt: 3,
            artifactRefs: ["artifact:sha256:abc"], reviewRequired: true,
          }],
        },
      },
    },
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn() {
        decision = interactionBridge.ask({
          id: "pause-at-approval",
          title: "Permission",
          questions: [{
            id: "permission",
            question: "Proceed?",
            options: [{ label: "Approve" }, { label: "Reject" }],
            recommended: 0,
          }],
        });
        const answer = await decision;
        return { text: answer.status };
      },
    },
  });
  await engine.initialize();

  const turn = engine.handleSubmit("needs approval", [{
    type: "image", mimeType: "image/png", displayName: "clipboard.png",
    path: "(clipboard)", dataUrl: "data:image/png;base64,AA==",
  }]);
  while (!engine.getState().agentConsole.pendingDecision) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const receipt = await engine.requestTurnPause();

  assert.equal(receipt.boundary, "before_approval");
  assert.equal(engine.getTurnLifecycle().state, "paused");
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "pause-at-approval");
  const paused = calls.snapshots.find((snapshot) => snapshot.state === "paused");
  assert.deepEqual(paused?.pauseCheckpoint, {
    turnId: receipt.turnId,
    boundary: "before_approval",
    activeNode: { id: "critic-1", attempt: 3 },
    currentStage: "critic",
    gateStatus: "refine",
    iteration: 2,
    decisionId: "pause-at-approval",
    contextReceiptId: "receipt-pause-1",
    attachmentRefs: ["image:image/png:clipboard.png"],
    artifactRefs: ["artifact:sha256:abc"],
  });

  assert.equal(engine.resumeTurn(), true);
  assert.equal(engine.answerPendingDecisionByIndex(1, "pause-at-approval"), true);
  await decision;
  await turn;
  assert.equal(engine.getTurnLifecycle().state, "completed");
});

test("work-shell command helpers classify builtins, local commands, and reusable panels/prompts", () => {
  assert.deepEqual(resolveWorkShellBuiltinCommand("/help"), { kind: "help" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/v"), { kind: "trace-mode", traceMode: "verbose" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/minimal"), { kind: "trace-mode", traceMode: "minimal" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/auth key"), { kind: "auth-key" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/queue"), { kind: "queue" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/cache"), { kind: "cache" });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/agents"), { kind: "agent-console", tab: "agents" });
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
      model: "gpt-5.6-sol",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    },
    stateModel: "gpt-5.6-sol",
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
    line: "/model gpt-5.6-terra",
    provider: "openai",
    currentModel: "gpt-5.6-sol",
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
  assert.equal(model?.nextModel, "gpt-5.6-terra");
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
        lines: ["Loaded guidance: AGENTS.md", "bridge-1", "session · memory-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged", "Inspect sources · /context"],
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
    lines: ["Loaded guidance: AGENTS.md", "bridge-1", "memory-1", "trace-1", "Inspect sources · /context"],
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
    streamingReasoningText: undefined,
  });
  assert.deepEqual(resolvePromptTurnFinalizePatch(), {
    isBusy: false,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
    streamingAssistantText: undefined,
    streamingReasoningText: undefined,
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

test("work-shell chat runtime blocks API-unready auth before provider invocation", async () => {
  const entries = [];
  const snapshots = [];
  const statePatches = [];
  let agentCalls = 0;
  const state = createState({
    model: "gpt-5.6-luna",
    reasoning: supportedReasoning,
    authLabel: "oauth-file-api-blocked",
  });

  await executeWorkShellChatSubmit({
    line: "inspect the repository",
    resolveComposerInput: async () => ({
      prompt: "inspect the repository",
      transcriptText: "inspect the repository",
      attachments: [],
    }),
    state,
    options: {
      provider: "openai",
      model: "gpt-5.6-luna",
      mode: "default",
      authLabel: "oauth-file-api-blocked",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: [],
    },
    sessionId: "work-auth-blocked",
    buildStatusPanel: () => ({ title: "Status", lines: [] }),
    runAgentTurn: async () => {
      agentCalls += 1;
      return { text: "should not run" };
    },
    publishContextBridge: async () => ({ bridgeId: "unused", line: "unused" }),
    writeScopedMemory: async () => ({ memoryId: "unused" }),
    listScopedMemoryLines: async () => [],
    applyAuthIssueLines() {},
    formatWorkShellError: (message) => message,
    formatAgentTraceLine: () => "",
    appendEntries: (...nextEntries) => {
      entries.push(...nextEntries);
    },
    setState(patch) {
      statePatches.push(patch);
    },
    pushTraceLine() {},
    persistSessionSnapshot: async (state, summary) => {
      snapshots.push({ state, summary });
    },
  });

  assert.deepEqual(statePatches, [{ lastTurnDurationMs: 0 }]);
  assert.equal(agentCalls, 0);
  assert.deepEqual(entries.map((entry) => entry.role), ["user", "assistant"]);
  assert.match(entries[1]?.text ?? "", /\/auth key/);
  assert.deepEqual(snapshots, [
    { state: "idle", summary: "Chat: inspect the repository" },
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
      lines: ["Loaded guidance: AGENTS.md", "bridge-1", "session · memory-1 · cite memory:session:1970-01-01T00:00:00.000Z:test0001 · aged", "Inspect sources · /context"],
    },
  });
  assert.deepEqual(fallbackState, {
    bridgeLines: [],
    memoryLines: [],
    panel: {
      title: "Context",
      lines: ["Loaded guidance: AGENTS.md", "Inspect sources · /context"],
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
    lines: ["Loaded guidance: AGENTS.md", "bridge-1", "memory-1", "trace-1", "Inspect sources · /context"],
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
  assert.equal(success.postTurnEffects.memoryTraceEvent, undefined);
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
  assert.equal(traceLines.some((line) => /native-module-version-mismatch/.test(line)), false);
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

test("work-shell post-turn memory promotion carries submitted proof and active predecessor", async () => {
  const oldMemoryId = "memory:session:2026-07-13T00:00:00.000Z:aaaaaaaa";
  const newMemoryId = "memory:session:2026-07-13T00:00:01.000Z:bbbbbbbb";
  const lineageRecords = new Map([[
    oldMemoryId,
    {
      memoryId: oldMemoryId,
      sourceId: "assistant-summary",
      originTurnId: "turn-old",
      originPacketReceiptId: "receipt-old",
      state: "active",
      confidence: 0.9,
      createdAt: "2026-07-13T00:00:00.000Z",
    },
  ]]);
  const lineage = {
    record(input) {
      const record = { ...input, createdAt: "2026-07-13T00:00:01.000Z" };
      lineageRecords.set(record.memoryId, record);
      return record;
    },
    invalidate(memoryId) {
      const current = lineageRecords.get(memoryId);
      if (!current) throw new Error("missing");
      const invalid = { ...current, state: "superseded" };
      lineageRecords.set(memoryId, invalid);
      return invalid;
    },
    expire() {
      return 0;
    },
    get(memoryId) {
      return lineageRecords.get(memoryId);
    },
    isActive(memoryId) {
      return lineageRecords.get(memoryId)?.state === "active";
    },
  };
  const promotions = [];
  let legacyWrites = 0;
  let listedLineage;
  const effects = await runWorkShellPostTurnSuccessEffects({
    cwd: "/repo",
    transcriptText: "hello",
    assistantText: "world",
    sessionId: "work-1",
    currentBridgeLines: [],
    currentMemoryLines: [
      `session · previous summary · cite ${oldMemoryId} · recent`,
    ],
    turnId: "turn-2",
    contextReceipt: {
      id: "receipt-2",
      projectId: "project-1",
      sessionId: "work-1",
      turnId: "turn-2",
      packetId: "packet-2",
      state: "submitted",
      profile: "build",
      tokenEstimate: 0,
      tokenEstimateState: "exact",
      sourceCount: 0,
      sourceRefs: [],
      createdAt: "2026-07-13T00:00:01.000Z",
    },
    memoryLineage: lineage,
    async promoteScopedMemory(input) {
      promotions.push(input);
      return { memoryId: newMemoryId };
    },
    async publishContextBridge() {
      return { bridgeId: "bridge-2", line: "bridge-2 line" };
    },
    async writeScopedMemory() {
      legacyWrites += 1;
      return { memoryId: "legacy-memory" };
    },
    async listScopedMemoryLines(input) {
      listedLineage = input.lineage;
      return [`session · current summary · cite ${newMemoryId} · fresh`];
    },
  });

  assert.equal(legacyWrites, 0);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].turnId, "turn-2");
  assert.equal(promotions[0].packetReceiptId, "receipt-2");
  assert.equal(promotions[0].sourceId, "assistant-summary");
  assert.equal(promotions[0].confidence, 0.9);
  assert.equal(promotions[0].supersedesMemoryId, oldMemoryId);
  assert.equal(promotions[0].lineage, lineage);
  assert.equal(listedLineage, lineage);
  assert.equal(effects.memoryTraceEvent.degraded, undefined);
  assert.deepEqual(effects.memoryLines, [
    `session · current summary · cite ${newMemoryId} · fresh`,
  ]);
});

test("work-shell success sequence forwards lineage proof into post-turn promotion", async () => {
  const lineage = {
    record() {
      throw new Error("not used");
    },
    invalidate() {
      throw new Error("not used");
    },
    expire() {
      return 0;
    },
    get() {
      return undefined;
    },
    isActive() {
      return false;
    },
  };
  const promotions = [];
  let legacyWrites = 0;
  const result = await runPromptTurnSuccessSequence({
    prompt: "hello",
    transcriptText: "hello",
    turnStartedAt: Date.now(),
    runAgentTurn: async () => ({ text: "world" }),
    cwd: "/repo",
    sessionId: "work-1",
    currentBridgeLines: [],
    currentMemoryLines: [],
    turnId: "turn-3",
    contextReceipt: {
      id: "receipt-3",
      projectId: "project-1",
      sessionId: "work-1",
      turnId: "turn-3",
      packetId: "packet-3",
      state: "submitted",
      profile: "build",
      tokenEstimate: 0,
      tokenEstimateState: "exact",
      sourceCount: 0,
      sourceRefs: [],
      createdAt: "2026-07-13T00:00:02.000Z",
    },
    memoryLineage: lineage,
    async promoteScopedMemory(input) {
      promotions.push(input);
      return { memoryId: "memory:session:2026-07-13T00:00:02.000Z:cccccccc" };
    },
    publishContextBridge: async () => ({ bridgeId: "bridge-3", line: "bridge-3 line" }),
    async writeScopedMemory() {
      legacyWrites += 1;
      return { memoryId: "legacy-memory" };
    },
    async listScopedMemoryLines(input) {
      assert.equal(input.lineage, lineage);
      return [];
    },
  });

  assert.equal(result.assistantText, "world");
  assert.equal(legacyWrites, 0);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].turnId, "turn-3");
  assert.equal(promotions[0].packetReceiptId, "receipt-3");
});

test("work-shell never falls back under incomplete or invalid lifecycle proof", async () => {
  const lineage = {
    record() {
      throw new Error("not used");
    },
    invalidate() {
      throw new Error("not used");
    },
    expire() {
      return 0;
    },
    get() {
      return undefined;
    },
    isActive() {
      return false;
    },
  };
  for (const configuration of ["partial", "preview", "cross-session", "receipt-only"]) {
    let legacyWrites = 0;
    let promotions = 0;
    const effects = await runWorkShellPostTurnSuccessEffects({
      cwd: "/repo",
      transcriptText: "hello",
      assistantText: "world",
      sessionId: "work-1",
      currentBridgeLines: [],
      currentMemoryLines: ["memory-0"],
      turnId: "turn-2",
      contextReceipt: {
        id: "receipt-2",
        projectId: "project-1",
        sessionId: configuration === "cross-session" ? "work-2" : "work-1",
        packetId: "packet-2",
        state: configuration === "preview" ? "previewed" : "submitted",
        ...(configuration === "preview" ? {} : { turnId: "turn-2" }),
        profile: "build",
        tokenEstimate: 0,
        tokenEstimateState: "exact",
        sourceCount: 0,
        sourceRefs: [],
        createdAt: "2026-07-13T00:00:01.000Z",
      },
      ...(configuration === "receipt-only" ? {} : { memoryLineage: lineage }),
      ...(["preview", "cross-session"].includes(configuration)
        ? {
            async promoteScopedMemory() {
              promotions += 1;
              return { memoryId: "governed-memory" };
            },
          }
        : {}),
      async publishContextBridge() {
        return { bridgeId: "bridge-2", line: "bridge-2 line" };
      },
      async writeScopedMemory() {
        legacyWrites += 1;
        return { memoryId: "legacy-memory" };
      },
      async listScopedMemoryLines() {
        return [];
      },
    });

    assert.equal(legacyWrites, 0, configuration);
    assert.equal(promotions, 0, configuration);
    assert.equal(effects.memoryTraceEvent, undefined, configuration);
    assert.deepEqual(effects.memoryLines, ["memory-0"], configuration);
  }
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
    "completed file mutations append a transcript entry in every trace mode; the engine swaps the line for assembled detail text",
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
    "completed reads append a transcript entry in every trace mode too",
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
  assert.equal(
    resolveBusyStatusFromTraceEvent(
      { type: "reasoning.delta" },
      "✦ thinking· inspect repo before editing",
    ),
    "✦ thinking· inspect repo before editing",
    "reasoning.delta surfaces on the active status row instead",
  );
  assert.equal(
    resolveBusyStatusFromTraceEvent({ type: "reasoning.delta" }, ""),
    null,
    "an empty reasoning.delta leaves the active status row alone",
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
  assert.equal(livePatches.length, 2);
  assert.equal(liveEntries.length, 0);
  assert.deepEqual(liveTraceLines, ["calling openai gpt-5.4"]);
  assert.deepEqual(
    livePatches[1],
    { liveTraceLines: ["calling openai gpt-5.4"] },
    "verbose mode fills the always-on live feed buffer alongside traceLines",
  );
  const completedPatches = [];
  const completedEntries = [];
  applyWorkShellTraceEvent({
    state: createState({ traceMode: "minimal", isBusy: true }),
    event: { type: "tool.completed", toolName: "run_shell" },
    formatAgentTraceLine: () => "✓ $ npm test -- work · 34ms",
    setState: (patch) => {
      completedPatches.push(patch);
    },
    appendEntries: (...entries) => {
      completedEntries.push(...entries);
    },
    pushTraceLine() {},
  });
  assert.match(completedPatches[0]?.busyStatus ?? "", /npm test -- work/);
  assert.deepEqual(
    completedPatches[1],
    { liveTraceLines: ["✓ $ npm test -- work · 34ms"] },
    "minimal mode fills the live feed buffer too — the dock feed never depends on verbose mode",
  );
  assert.deepEqual(
    completedEntries,
    [{ role: "tool", text: "bash" }],
    "a completed tool appends the glyph-less assembled detail entry (verb row first), not the formatted one-liner",
  );
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

/**
 * Drive applyWorkShellTraceEvent the way the engine does: the trace listener
 * stages each patch synchronously, so every event sees the previous event's
 * streaming state. The returned apply() threads that staging forward.
 */
function createTraceEventDriver(overrides = {}) {
  let state = createState({ isBusy: true, ...overrides });
  const entries = [];
  const apply = (event) => {
    applyWorkShellTraceEvent({
      state,
      event,
      formatAgentTraceLine: (candidate) => {
        if (candidate.type === "reasoning.delta") return `✦ thinking· ${candidate.delta ?? ""}`;
        if (candidate.type === "turn.completed") return `done ${candidate.durationMs ?? 0}`;
        return "";
      },
      setState: (patch) => {
        state = { ...state, ...patch };
      },
      appendEntries: (...next) => {
        entries.push(...next);
        state = { ...state, entries: [...state.entries, ...next] };
      },
      pushTraceLine() {},
    });
  };
  return { apply, get state() { return state; }, entries };
}

test("reasoning deltas accumulate per turn without transcript noise or busy-status drift", () => {
  const driver = createTraceEventDriver();

  driver.apply({ type: "reasoning.delta", kind: "text", delta: "inspect the repo" });
  driver.apply({ type: "reasoning.delta", kind: "summary", delta: "\nthen edit notes.txt" });

  assert.equal(driver.state.streamingReasoningText, "inspect the repo\nthen edit notes.txt");
  assert.deepEqual(driver.entries, [], "reasoning never appends live transcript entries");
  // The dock activity row keeps its existing behavior: the LAST reasoning
  // line stays the busy phrase — accumulation did not disturb it.
  assert.match(driver.state.busyStatus ?? "", /✦ thinking· \nthen edit notes\.txt/u);
});

test("the accumulated reasoning flushes as ONE ✻ entry at the first assistant delta", () => {
  const driver = createTraceEventDriver();

  driver.apply({ type: "reasoning.delta", kind: "text", delta: "inspect the repo" });
  driver.apply({ type: "reasoning.delta", kind: "summary", delta: "\nthen edit notes.txt" });
  driver.apply({ type: "assistant.delta", delta: "He" });
  driver.apply({ type: "assistant.delta", delta: "llo" });

  assert.deepEqual(
    driver.entries,
    [{ role: "assistant", text: "✻ inspect the repo\nthen edit notes.txt" }],
    "exactly one ✻ entry flushes — later assistant deltas never add a second",
  );
  assert.equal(driver.state.streamingReasoningText, undefined, "the buffer resets after the flush");
  assert.equal(driver.state.streamingAssistantText, "Hello", "the answer text still streams normally");
});

test("the ✻ summary carries at most the first 6 rows of the accumulated reasoning", () => {
  const driver = createTraceEventDriver();
  driver.apply({
    type: "reasoning.delta",
    kind: "text",
    delta: ["row 1", "row 2", "row 3", "row 4", "row 5", "row 6", "row 7", "row 8"].join("\n"),
  });
  driver.apply({ type: "assistant.delta", delta: "Answer." });

  assert.equal(driver.entries.length, 1);
  assert.deepEqual(
    driver.entries[0].text.split("\n"),
    ["✻ row 1", "row 2", "row 3", "row 4", "row 5", "row 6"],
    "rows past the 6th are dropped by the hard cap",
  );
});

test("the reasoning buffer stops at 2000 characters even against a runaway stream", () => {
  const driver = createTraceEventDriver();

  driver.apply({ type: "reasoning.delta", kind: "text", delta: "x".repeat(1500) });
  driver.apply({ type: "reasoning.delta", kind: "summary", delta: "y".repeat(900) });
  driver.apply({ type: "reasoning.delta", kind: "text", delta: "z".repeat(50) });

  assert.equal(driver.state.streamingReasoningText?.length, 2000);
  assert.ok(driver.state.streamingReasoningText?.endsWith("y"), "the cap keeps the earliest 2000 chars");
});

test("turn.completed flushes the reasoning when no assistant delta ever arrived", () => {
  const driver = createTraceEventDriver();

  driver.apply({ type: "reasoning.delta", kind: "text", delta: "thought about it, decided to stay quiet" });
  driver.apply({ type: "turn.completed", durationMs: 42 });

  assert.deepEqual(driver.entries, [
    { role: "assistant", text: "✻ thought about it, decided to stay quiet" },
  ]);
  assert.equal(driver.state.streamingReasoningText, undefined);
  assert.equal(driver.state.busyStatus, undefined, "turn completion still clears the busy row");
});

test("turns without visible reasoning never grow a ✻ entry", () => {
  const quiet = createTraceEventDriver();
  quiet.apply({ type: "assistant.delta", delta: "Hi" });
  quiet.apply({ type: "turn.completed", durationMs: 7 });
  assert.deepEqual(quiet.entries, [], "no accumulation means no entry at either flush trigger");

  const blank = createTraceEventDriver();
  blank.apply({ type: "reasoning.delta", kind: "text", delta: "   " });
  blank.apply({ type: "reasoning.delta", kind: "summary", delta: "\n \n" });
  blank.apply({ type: "turn.completed", durationMs: 7 });
  assert.deepEqual(blank.entries, [], "a whitespace-only accumulation is empty, not blank-row noise");
  assert.equal(blank.state.streamingReasoningText, undefined, "the flush still resets the buffer");
});

test("the reasoning buffer resets between turns", () => {
  const driver = createTraceEventDriver();

  driver.apply({ type: "reasoning.delta", kind: "text", delta: "first turn thinking" });
  driver.apply({ type: "turn.completed", durationMs: 5 });
  driver.apply({ type: "reasoning.delta", kind: "text", delta: "second turn thinking" });
  driver.apply({ type: "turn.completed", durationMs: 6 });

  assert.deepEqual(driver.entries, [
    { role: "assistant", text: "✻ first turn thinking" },
    { role: "assistant", text: "✻ second turn thinking" },
  ], "each turn's summary carries only that turn's reasoning");
});

test("WorkShellEngine lands the ✻ reasoning summary in front of the assistant reply", async () => {
  const { engine, calls } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener(listener) {
        calls.traceListener = listener;
      },
      async runTurn() {
        const emit = calls.traceListener;
        emit?.({
          type: "reasoning.delta",
          level: "default",
          provider: "openai",
          model: "gpt-5.4",
          kind: "text",
          itemId: "rs_1",
          delta: "inspect repo before editing",
        });
        emit?.({
          type: "assistant.delta",
          level: "default",
          provider: "openai",
          model: "gpt-5.4",
          itemId: "msg_1",
          delta: "All clear.",
        });
        return { text: "All clear." };
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("check the repo");

  const texts = engine.getState().entries.map((entry) => entry.text);
  const reasoningIndex = texts.findIndex((text) => text.startsWith("✻ "));
  const answerIndex = texts.indexOf("All clear.");
  assert.ok(reasoningIndex >= 0, "the turn's reasoning summary must land in the transcript");
  assert.ok(
    answerIndex > reasoningIndex,
    "the ✻ summary lands in front of the assistant reply it preceded",
  );
  assert.equal(
    texts.filter((text) => text.startsWith("✻ ")).length,
    1,
    "exactly one ✻ entry per turn",
  );
  assert.equal(texts[reasoningIndex], "✻ inspect repo before editing");
  assert.equal(engine.getState().streamingReasoningText, undefined, "the turn end resets the buffer");
});

test("resolveLastCompletedTurn skips ✻ reasoning entries so thinking never poses as the reply", () => {
  // The reasoning summary behind a real answer is invisible to the snapshot.
  assert.deepEqual(
    resolveLastCompletedTurn([
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "✻ plan the fix" },
      { role: "assistant", text: "Fixed in a.ts" },
    ]),
    { user: "fix the bug", assistant: "Fixed in a.ts" },
  );
  // An answer-less turn: the ✻ summary is not the reply, so the turn
  // contributes nothing to the queue preview / idle snapshot.
  assert.equal(
    resolveLastCompletedTurn([
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "✻ plan the fix" },
    ]),
    undefined,
  );
  // An earlier turn's real answer is still reachable through the skipped one.
  assert.deepEqual(
    resolveLastCompletedTurn([
      { role: "user", text: "earlier ask" },
      { role: "assistant", text: "earlier answer" },
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "✻ plan the fix" },
    ]),
    { user: "earlier ask", assistant: "earlier answer" },
  );
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
  assert.ok(state.panel.lines.includes("Inspect sources · /context"));
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
    { id: "entry-0", role: "user", text: "inspect repo" },
    { id: "entry-1", role: "assistant", text: "repo inspected" },
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
    { id: "entry-0", role: "system", text: "hello" },
    { id: "entry-1", role: "assistant", text: "world" },
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

  await runtime.engine.handleSubmit("/model gpt-5.6-terra");
  const modelSuggestions = runtime.getSuggestions("/model");
  assert.equal(modelSuggestions[0]?.command, "/model gpt-5.6-terra");
  assert.match(modelSuggestions[0]?.description ?? "", /Current/i);
  assert.equal(runtime.shouldBlockSlashSubmit("/model"), true);
  assert.equal(runtime.shouldBlockSlashSubmit("/model gpt-5.6-terra"), false);
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

test("WorkShellEngine queue never mixes completed turn history into follow-ups", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("hello");
  await engine.handleSubmit("/queue");
  assert.equal(engine.getState().panel.title, "Queue · follow-ups");
  assert.ok(!engine.getState().panel.lines.some((line) => /Done|hello →/.test(line)));

  await engine.handleSubmit("/clear");
  await engine.handleSubmit("/queue");
  assert.equal(engine.getState().panel.title, "Queue · follow-ups");
  assert.ok(!engine.getState().panel.lines.some((line) => /Done|hello →/.test(line)));
});

test("WorkShellEngine replaces a queue overlay with the security policy projection", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/queue");
  await engine.handleSubmit("/policy");

  assert.equal(engine.getState().panel.title, "Security policy");
  assert.match(engine.getState().panel.lines.join("\n"), /Security approval only/);
  assert.doesNotMatch(engine.getState().panel.lines.join("\n"), /follow-ups/);
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

test("WorkShellEngine applies GPT-5.6 model and reasoning updates together", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/model gpt-5.6-luna none");

  assert.equal(engine.getState().model, "gpt-5.6-luna");
  assert.equal(engine.getState().reasoning.effort, "none");
  assert.equal(calls.runtimeSettings.length, 1);
  assert.equal(calls.runtimeSettings[0]?.model, "gpt-5.6-luna");
  assert.equal(calls.runtimeSettings[0]?.reasoning?.effort, "none");
  assert.equal(engine.getState().panel.title, "Status");
  assert.ok(engine.getState().panel.lines.includes("model:gpt-5.6-luna"));
  assert.ok(engine.getState().panel.lines.includes("reasoning:none"));
});

test("WorkShellEngine opens cache telemetry locally", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/cache");
  assert.equal(engine.getState().panel.title, "Cache Telemetry");
  assert.equal(calls.turns.length, 0);
});

test("WorkShellEngine opens the agent console tab an idle slash command names", async () => {
  for (const [line, tab] of [["/agents", "agents"], ["/jobs", "jobs"], ["/todo", "plan"]]) {
    const { engine, calls } = createEngine();

    await engine.initialize();
    const entriesBefore = engine.getState().entries.length;
    await engine.handleSubmit(line);

    assert.equal(engine.getState().agentConsoleView.open, true, `${line} must open the console`);
    assert.equal(engine.getState().agentConsoleView.tab, tab);
    assert.equal(
      engine.getState().entries.length,
      entriesBefore,
      `${line} must not write a conversation entry`,
    );
    assert.equal(calls.turns.length, 0);
  }
});

test("WorkShellEngine projects provider cache usage into the session ledger", async () => {
  const { engine, emitTrace } = createEngine();
  engine.bindRuntimeUsageRecorder(createUsageRecorder());

  await engine.initialize();
  emitTrace({
    type: "usage.recorded",
    eventId: "usage-1",
    provider: "openai",
    model: "gpt-5.6-sol",
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 750,
    cacheWriteTokens: 50,
    cacheSavingsUsd: 0.004,
    costUsd: 0.01,
    startedAt: 100,
  });

  assert.deepEqual(engine.getState().agentConsole.mainUsage, {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 750,
    cacheWriteTokens: 50,
    cacheSavingsUsd: 0.004,
    costUsd: 0.01,
  });
  assert.deepEqual(engine.getState().agentConsole.totalUsage?.routes, [{
      provider: "openai",
      model: "gpt-5.6-sol",
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 750,
      cacheWriteTokens: 50,
      cacheSavingsUsd: 0.004,
      costUsd: 0.01,
    }]);
});

test("WorkShellEngine preserves GPT-5.6 reasoning overrides across model switches", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/model gpt-5.6-terra max");

  assert.equal(engine.getState().model, "gpt-5.6-terra");
  assert.equal(engine.getState().reasoning.effort, "max");
  assert.equal(engine.getState().reasoning.source, "override");
  assert.equal(calls.runtimeSettings.length, 1);
  assert.equal(calls.runtimeSettings[0]?.model, "gpt-5.6-terra");
  assert.equal(calls.runtimeSettings[0]?.reasoning?.effort, "max");
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
  assert.deepEqual(providerPrompts, [
    "Respond in English for this session. Preserve code, paths, commands, and proper names when needed.\n\nmanifest-owned:packet-manifest-1:write focused tests",
  ]);
  assert.deepEqual(engine.getState().agentConsole.manifest, packet.manifest);
  assert.deepEqual(calls.snapshots.at(-1)?.agentConsole?.manifest, packet.manifest);
});

function createLifecyclePacket(overrides = {}) {
  return {
    id: "packet-lifecycle-1",
    version: 1,
    generatedAt: "2026-07-13T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "pinned-auth",
        category: "workspace",
        label: "auth.ts",
        reason: "pinned source",
        preview: "export function auth() {}",
        tokenEstimate: 8,
        salience: 1,
        includedInModel: true,
      },
    ],
    excluded: [],
    warnings: [],
    preview: ["Pinned auth context."],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 8,
    tokenEstimateState: "exact",
    ...overrides,
  };
}

function createLifecycleLedgerHarness(overrides = {}) {
  const providerPrompts = [];
  const providerAttachments = [];
  const ledgerPreviews = [];
  const ledgerSubmissions = [];
  const ledgerRevalidations = [];
  const receiptsById = new Map();
  const submittedReceiptIds = new Set();
  let packet = overrides.packet ?? createLifecyclePacket();
  let previewCounter = 0;
  let resolveGate = overrides.resolveGate;
  const ledger = {
    previewPacket({ sessionId, packet: nextPacket, profile }) {
      const active = [...receiptsById.values()].find((receipt) => (
        receipt.state === "previewed"
        && receipt.sessionId === sessionId
        && receipt.packetId === nextPacket.id
      ));
      if (active) {
        ledgerPreviews.push({ sessionId, packetId: nextPacket.id, profile, receiptId: active.id, reused: true });
        return active;
      }
      previewCounter += 1;
      const receipt = {
        id: `preview-${previewCounter}`,
        projectId: "project-1",
        sessionId,
        packetId: nextPacket.id,
        state: "previewed",
        profile,
        tokenEstimate: nextPacket.tokenEstimate,
        tokenEstimateState: nextPacket.tokenEstimateState,
        sourceCount: nextPacket.included.length + nextPacket.excluded.length,
        sourceRefs: [...nextPacket.included, ...nextPacket.excluded].map((item) => ({
          sourceId: item.id,
          category: item.category,
          salience: item.salience ?? 0,
          includedInModel: item.includedInModel !== false && nextPacket.included.some((entry) => entry.id === item.id),
        })),
        createdAt: "2026-07-13T00:00:00.000Z",
      };
      receiptsById.set(receipt.id, receipt);
      ledgerPreviews.push({ sessionId, packetId: nextPacket.id, profile, receiptId: receipt.id, reused: false });
      return receipt;
    },
    revalidate({ sessionId, preview, packet: nextPacket }) {
      const result = (overrides.revalidate ?? (() => ({
        kind: "unchanged",
        removedSourceIds: [],
        addedSourceIds: [],
        protectedSourceIds: [],
        reason: "Packet source selection is unchanged.",
      })))({ sessionId, preview, packet: nextPacket });
      ledgerRevalidations.push({ sessionId, previewId: preview.id, packetId: nextPacket.id, kind: result.kind });
      return result;
    },
    submitPreview(input) {
      if (typeof overrides.submitPreview === "function") {
        return overrides.submitPreview(input);
      }
      if (submittedReceiptIds.has(input.receiptId)) {
        throw new Error(`submitted receipt already exists: ${input.receiptId}`);
      }
      const preview = receiptsById.get(input.receiptId);
      if (!preview || preview.state !== "previewed") {
        throw new Error(`receipt not submittable: ${input.receiptId}`);
      }
      submittedReceiptIds.add(input.receiptId);
      const receipt = {
        ...preview,
        state: "submitted",
        turnId: input.turnId,
      };
      receiptsById.set(receipt.id, receipt);
      ledgerSubmissions.push({
        ...input,
        packetId: receipt.packetId,
      });
      return receipt;
    },
  };
  const { engine, calls } = createEngine({
    sessionId: overrides.sessionId ?? "session-lifecycle-1",
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: overrides.mode ?? "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      contextProfile: "build",
    },
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt, attachments) {
        providerPrompts.push(prompt);
        providerAttachments.push(attachments);
        if (typeof overrides.agentRunTurn === "function") {
          return overrides.agentRunTurn(prompt, attachments);
        }
        return { text: "lifecycle-ok" };
      },
    },
    resolveContextPacket: async () => {
      if (typeof resolveGate === "function") {
        await resolveGate();
      }
      return packet;
    },
    previewContextPacket: (input) => ledger.previewPacket(input),
    revalidateContextPacket: (input) => ledger.revalidate(input),
    submitContextPacketReceipt: (input) => ledger.submitPreview(input),
    ...(overrides.engineOverrides ?? {}),
  });
  return {
    engine,
    calls,
    providerAttachments,
    providerPrompts,
    ledgerPreviews,
    ledgerSubmissions,
    ledgerRevalidations,
    ledger,
    setPacket(next) {
      packet = next;
    },
    getPacket() {
      return packet;
    },
    setResolveGate(next) {
      resolveGate = next;
    },
  };
}

test("WorkShellEngine submits exactly the inspected packet receipt", async () => {
  const {
    engine,
    providerPrompts,
    ledgerSubmissions,
    ledgerPreviews,
    setPacket,
    getPacket,
  } = createLifecycleLedgerHarness();

  await engine.initialize();
  await engine.handleSubmit("/context");
  const inspectedPreviewId = engine.getState().contextPreviewReceipt?.id;
  const inspectedPacketId = getPacket().id;
  assert.equal(typeof inspectedPreviewId, "string");
  assert.equal(inspectedPacketId, "packet-lifecycle-1");

  // Production CRP mint a fresh packet ID on every resolve even when sources
  // are unchanged. The submitted receipt must track that candidate.
  setPacket(createLifecyclePacket({ id: "packet-lifecycle-2" }));
  await engine.handleSubmit("inspect auth");

  assert.equal(providerPrompts.length, 1);
  assert.equal(ledgerSubmissions.length, 1);
  assert.notEqual(ledgerSubmissions[0].receiptId, inspectedPreviewId);
  assert.equal(ledgerSubmissions[0].packetId, "packet-lifecycle-2");
  assert.match(ledgerSubmissions[0].turnId, /^turn-session-lifecycle-1-\d+$/);
  assert.equal(engine.getState().contextSubmittedReceipt?.packetId, "packet-lifecycle-2");
  assert.equal(engine.getState().contextSubmittedReceipt?.id, ledgerSubmissions[0].receiptId);
  assert.match(providerPrompts[0] ?? "", /id="packet-lifecycle-2"/);
  assert.ok(ledgerPreviews.some((entry) => entry.packetId === "packet-lifecycle-2"));
});

test("WorkShellEngine generates optimizer advice only after a submitted turn", async () => {
  const generated = [];
  const invalidated = [];
  const { engine, ledgerSubmissions } = createLifecycleLedgerHarness({
    engineOverrides: {
      async generateContextSuggestions({ receipt, packet }) {
        generated.push({ receiptId: receipt.id, packetId: packet.id, state: receipt.state });
        return [{
          id: `suggestion-${receipt.id}`,
          packetReceiptId: receipt.id,
          sourceId: "pinned-auth",
          action: "keep",
          reasonCode: "mandatory-guidance",
          reasonText: "Mandatory guidance remains active.",
          status: "proposed",
          createdAt: "2026-07-13T00:00:01.000Z",
        }];
      },
      invalidateContextSuggestions(receiptId) {
        invalidated.push(receiptId);
        return 1;
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("first turn");

  const firstReceiptId = ledgerSubmissions[0].receiptId;
  assert.deepEqual(generated, [{
    receiptId: firstReceiptId,
    packetId: ledgerSubmissions[0].packetId,
    state: "submitted",
  }]);
  assert.equal(engine.getState().contextPolicySuggestions[0]?.packetReceiptId, firstReceiptId);
  assert.equal(engine.getState().contextAdviceUnavailable, undefined);
  assert.ok(engine.getState().entries.some((entry) => entry.role === "assistant" && entry.text === "lifecycle-ok"));

  await engine.handleSubmit("second turn");

  assert.deepEqual(invalidated, [firstReceiptId]);
  assert.equal(engine.getState().contextPolicySuggestions[0]?.packetReceiptId, ledgerSubmissions[1].receiptId);
});

test("WorkShellEngine keeps the assistant reply when optimizer advice fails", async () => {
  const { engine } = createLifecycleLedgerHarness({
    engineOverrides: {
      async generateContextSuggestions() {
        throw new Error("optimizer database unavailable");
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("reply must survive");

  assert.ok(engine.getState().entries.some((entry) => entry.role === "assistant" && entry.text === "lifecycle-ok"));
  assert.deepEqual(engine.getState().contextPolicySuggestions, []);
  assert.equal(engine.getState().contextAdviceUnavailable, "Context optimizer unavailable; reply kept.");
});

test("WorkShellEngine skips advice when the completed reply snapshot is not durable", async () => {
  let generationCount = 0;
  const { engine } = createLifecycleLedgerHarness({
    engineOverrides: {
      async persistWorkShellSessionSnapshot(input) {
        if (input.state === "idle") {
          throw new Error("snapshot unavailable");
        }
      },
      async generateContextSuggestions() {
        generationCount += 1;
        return [];
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("reply persistence fails");

  assert.equal(generationCount, 0);
  assert.ok(engine.getState().entries.some((entry) => entry.role === "assistant" && entry.text === "lifecycle-ok"));
  assert.deepEqual(engine.getState().contextPolicySuggestions, []);
});
test("WorkShellEngine retires prior advice before a newer reply snapshot can fail", async () => {
  let idleSnapshotCount = 0;
  let generationCount = 0;
  const invalidated = [];
  const { engine } = createLifecycleLedgerHarness({
    engineOverrides: {
      async persistWorkShellSessionSnapshot(input) {
        if (input.state === "idle") {
          idleSnapshotCount += 1;
          if (idleSnapshotCount === 3) {
            throw new Error("snapshot unavailable");
          }
        }
      },
      async generateContextSuggestions({ receipt }) {
        generationCount += 1;
        return [{
          id: `suggestion-${receipt.id}`,
          packetReceiptId: receipt.id,
          sourceId: "pinned-auth",
          action: "hold-back",
          reasonCode: "low-trust-token-hotspot",
          reasonText: "Hold back oversized context.",
          status: "proposed",
          createdAt: "2026-07-13T00:00:01.000Z",
        }];
      },
      invalidateContextSuggestions(receiptId) {
        invalidated.push(receiptId);
        return 1;
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("first reply persists");
  const firstReceiptId = engine.getState().contextPolicySuggestions[0]?.packetReceiptId;
  await engine.handleSubmit("second reply persistence fails");

  assert.equal(generationCount, 1);
  assert.deepEqual(invalidated, [firstReceiptId]);
  assert.equal(engine.getState().contextPolicySuggestions[0]?.status, "stale");
  assert.equal(
    engine.getState().contextPolicySuggestions.some(({ status }) => status === "proposed"),
    false,
  );
});


test("WorkShellEngine stales advice generated after its turn is superseded", async () => {
  const firstGeneration = Promise.withResolvers();
  const firstGenerationEntered = Promise.withResolvers();
  const invalidated = [];
  let generationCount = 0;
  let firstReceiptId;
  const { engine } = createLifecycleLedgerHarness({
    engineOverrides: {
      async generateContextSuggestions({ receipt }) {
        generationCount += 1;
        const suggestion = {
          id: `suggestion-${receipt.id}`,
          packetReceiptId: receipt.id,
          sourceId: "pinned-auth",
          action: "keep",
          reasonCode: "mandatory-guidance",
          reasonText: "Mandatory guidance remains active.",
          status: "proposed",
          createdAt: "2026-07-13T00:00:01.000Z",
        };
        if (generationCount === 1) {
          firstReceiptId = receipt.id;
          firstGenerationEntered.resolve();
          return firstGeneration.promise;
        }
        return [suggestion];
      },
      invalidateContextSuggestions(receiptId) {
        invalidated.push(receiptId);
        if (
          receiptId === firstReceiptId
          && invalidated.filter((id) => id === receiptId).length === 1
        ) {
          throw new Error("transient stale failure");
        }
        return 1;
      },
    },
  });

  await engine.initialize();
  const firstTurn = engine.handleSubmit("first turn");
  await firstGenerationEntered.promise;
  await engine.handleSubmit("second turn");
  const currentReceiptId = engine.getState().contextPolicySuggestions[0]?.packetReceiptId;
  firstGeneration.resolve([{
    id: `suggestion-${firstReceiptId}`,
    packetReceiptId: firstReceiptId,
    sourceId: "pinned-auth",
    action: "keep",
    reasonCode: "mandatory-guidance",
    reasonText: "Mandatory guidance remains active.",
    status: "proposed",
    createdAt: "2026-07-13T00:00:01.000Z",
  }]);
  await firstTurn;

  assert.notEqual(currentReceiptId, firstReceiptId);
  assert.equal(engine.getState().contextPolicySuggestions[0]?.packetReceiptId, currentReceiptId);
  assert.equal(invalidated.filter((id) => id === firstReceiptId).length, 2);
});

test("WorkShellEngine applies accepted advice and never applies rejected advice", async () => {
  const mutations = [];
  const resolutions = [];
  const makeSuggestion = (status = "proposed") => ({
    id: "suggestion-hold-auth",
    packetReceiptId: "preview-1",
    sourceId: "pinned-auth",
    action: "hold-back",
    reasonCode: "low-trust-token-hotspot",
    reasonText: "External source exceeds the strict hotspot threshold.",
    estimatedTokenSaving: 8,
    status,
    createdAt: "2026-07-13T00:00:01.000Z",
    ...(status === "proposed" ? {} : { resolvedAt: "2026-07-13T00:00:02.000Z" }),
  });
  const createHarness = () => createLifecycleLedgerHarness({
    engineOverrides: {
      async generateContextSuggestions() {
        return [makeSuggestion()];
      },
      resolveContextSuggestion(id, status) {
        resolutions.push({ id, status });
        return makeSuggestion(status);
      },
      mutateContextSource(action) {
        mutations.push(action);
        return {
          id: `action-${mutations.length}`,
          action: "hold-back",
          sourceId: action.id,
          sourceLabel: "auth.ts",
          message: "Held back auth.ts",
          canUndo: true,
          succeeded: true,
        };
      },
    },
  });

  const acceptedHarness = createHarness();
  const accepted = acceptedHarness.engine;
  await accepted.initialize();
  await accepted.handleSubmit("accept advice");
  const submittedPacketId = accepted.getState().contextSubmittedReceipt?.packetId;
  acceptedHarness.setPacket(createLifecyclePacket({ id: "packet-after-hold-back" }));
  await accepted.acceptContextSuggestion("suggestion-hold-auth");
  assert.deepEqual(resolutions.at(-1), { id: "suggestion-hold-auth", status: "accepted" });
  assert.deepEqual(mutations, [{ kind: "forget", id: "pinned-auth" }]);
  assert.equal(accepted.getState().contextPolicySuggestions[0]?.status, "accepted");
  assert.equal(accepted.getState().contextActionReceipt?.action, "hold-back");
  // Both compare sides survive the desk-side refresh the hold-back triggered.
  assert.notEqual(accepted.getState().contextPreviewReceipt?.packetId, submittedPacketId);
  assert.equal(accepted.getState().contextSubmittedReceipt?.packetId, submittedPacketId);

  const rejected = createHarness().engine;
  await rejected.initialize();
  await rejected.handleSubmit("reject advice");
  await rejected.rejectContextSuggestion("suggestion-hold-auth");
  assert.deepEqual(resolutions.at(-1), { id: "suggestion-hold-auth", status: "rejected" });
  assert.deepEqual(mutations, [{ kind: "forget", id: "pinned-auth" }]);
  assert.equal(rejected.getState().contextPolicySuggestions[0]?.status, "rejected");
});

test("WorkShellEngine applies one packet-changing advice at a time and closes the rest after it lands", async () => {
  const refreshGate = Promise.withResolvers();
  const resolutions = [];
  const mutations = [];
  const suggestions = [
    {
      id: "suggestion-first",
      packetReceiptId: "receipt-placeholder",
      sourceId: "pinned-auth",
      action: "hold-back",
      reasonCode: "low-trust-token-hotspot",
      reasonText: "Hold back oversized context.",
      status: "proposed",
      createdAt: "2026-07-13T00:00:01.000Z",
    },
    {
      id: "suggestion-second",
      packetReceiptId: "receipt-placeholder",
      sourceId: "pinned-auth",
      action: "refresh",
      reasonCode: "expired-source",
      reasonText: "Refresh stale context.",
      status: "proposed",
      createdAt: "2026-07-13T00:00:02.000Z",
    },
  ];
  const harness = createLifecycleLedgerHarness({
    engineOverrides: {
      async generateContextSuggestions({ receipt }) {
        return suggestions.map((suggestion) => ({
          ...suggestion,
          packetReceiptId: receipt.id,
        }));
      },
      resolveContextSuggestion(id, status) {
        resolutions.push({ id, status });
        const suggestion = harness.engine.getState().contextPolicySuggestions.find(
          (candidate) => candidate.id === id,
        );
        return { ...suggestion, status, resolvedAt: "2026-07-13T00:00:03.000Z" };
      },
      mutateContextSource(action) {
        mutations.push(action);
        return undefined;
      },
      invalidateContextSuggestions() {
        return 1;
      },
    },
  });

  await harness.engine.initialize();
  await harness.engine.handleSubmit("generate concurrent advice");
  harness.setResolveGate(() => refreshGate.promise);
  const firstAcceptance = harness.engine.acceptContextSuggestion("suggestion-first");
  const secondAcceptance = harness.engine.acceptContextSuggestion("suggestion-second");
  await Promise.resolve();

  // Nothing is recorded as accepted until the hold-back actually lands, and a
  // second accept cannot start against the packet the first is rewriting.
  assert.deepEqual(resolutions, []);
  assert.deepEqual(mutations, [{ kind: "forget", id: "pinned-auth" }]);
  assert.equal(
    harness.engine.getState().contextPolicySuggestions.find(
      ({ id }) => id === "suggestion-second",
    )?.status,
    "proposed",
  );

  refreshGate.resolve();
  await Promise.all([firstAcceptance, secondAcceptance]);

  assert.deepEqual(resolutions, [{ id: "suggestion-first", status: "accepted" }]);
  assert.deepEqual(mutations, [{ kind: "forget", id: "pinned-auth" }]);
  assert.equal(
    harness.engine.getState().contextPolicySuggestions.find(
      ({ id }) => id === "suggestion-first",
    )?.status,
    "accepted",
  );
  assert.equal(
    harness.engine.getState().contextPolicySuggestions.find(
      ({ id }) => id === "suggestion-second",
    )?.status,
    "stale",
  );
});

test("WorkShellEngine forces condensed-history refresh for accepted summarize advice", async () => {
  const effects = [];
  const suggestion = (status = "proposed") => ({
    id: "suggestion-summarize-history",
    packetReceiptId: "preview-1",
    sourceId: "pinned-auth",
    action: "summarize",
    reasonCode: "stale-condensed-history",
    reasonText: "Condensed history is stale.",
    status,
    createdAt: "2026-07-13T00:00:01.000Z",
    ...(status === "proposed" ? {} : { resolvedAt: "2026-07-13T00:00:02.000Z" }),
  });
  const { engine } = createLifecycleLedgerHarness({
    engineOverrides: {
      async generateContextSuggestions() {
        return [suggestion()];
      },
      resolveContextSuggestion(_id, status) {
        effects.push(`resolve:${status}`);
        return suggestion(status);
      },
      async refreshCondensedHistory() {
        effects.push("summarize");
      },
      invalidateContextSuggestions(receiptId) {
        effects.push(`stale:${receiptId}`);
        return 0;
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("summarize advice");
  await engine.acceptContextSuggestion("suggestion-summarize-history");

  // The summarize effect lands before the acceptance is persisted, and the
  // rest of that receipt's advice is retired afterwards.
  assert.deepEqual(effects, ["summarize", "resolve:accepted", "stale:preview-1"]);
  assert.equal(engine.getState().contextPolicySuggestions[0]?.status, "accepted");
});

test("WorkShellEngine keeps advice proposed and retryable when its effect fails", async () => {
  const effects = [];
  let summarizeFailures = 1;
  const suggestion = (status = "proposed") => ({
    id: "suggestion-summarize-retry",
    packetReceiptId: "preview-1",
    sourceId: "pinned-auth",
    action: "summarize",
    reasonCode: "stale-condensed-history",
    reasonText: "Condensed history is stale.",
    status,
    createdAt: "2026-07-14T00:00:01.000Z",
    ...(status === "proposed" ? {} : { resolvedAt: "2026-07-14T00:00:02.000Z" }),
  });
  const { engine } = createLifecycleLedgerHarness({
    engineOverrides: {
      async generateContextSuggestions() {
        return [suggestion()];
      },
      resolveContextSuggestion(_id, status) {
        effects.push(`resolve:${status}`);
        return suggestion(status);
      },
      async refreshCondensedHistory() {
        if (summarizeFailures > 0) {
          summarizeFailures -= 1;
          effects.push("summarize:failed");
          throw new Error("condensed history rebuild failed");
        }
        effects.push("summarize:ok");
      },
      invalidateContextSuggestions(receiptId) {
        effects.push(`stale:${receiptId}`);
        return 1;
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("summarize advice");

  // A failed effect must not leave the advice looking applied.
  await engine.acceptContextSuggestion("suggestion-summarize-retry");
  assert.deepEqual(effects, ["summarize:failed"]);
  assert.equal(engine.getState().contextPolicySuggestions[0]?.status, "proposed");
  assert.equal(
    engine.getState().contextAdviceUnavailable,
    "Context optimizer unavailable; reply kept.",
  );

  // Still actionable: the same key applies it once the effect succeeds.
  await engine.acceptContextSuggestion("suggestion-summarize-retry");
  assert.deepEqual(
    effects,
    ["summarize:failed", "summarize:ok", "resolve:accepted", "stale:preview-1"],
  );
  assert.equal(engine.getState().contextPolicySuggestions[0]?.status, "accepted");
  assert.equal(engine.getState().contextAdviceUnavailable, undefined);
});


test("WorkShellEngine blocks provider when a protected source disappears", async () => {
  const {
    engine,
    providerPrompts,
    ledgerSubmissions,
    setPacket,
  } = createLifecycleLedgerHarness({
    revalidate: () => ({
      kind: "meaning-change",
      removedSourceIds: ["pinned-auth"],
      addedSourceIds: [],
      protectedSourceIds: ["pinned-auth"],
      reason: "A pinned or explicitly included source disappeared.",
    }),
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  setPacket(createLifecyclePacket({
    id: "packet-lifecycle-missing-pin",
    included: [],
    sourceCounts: { included: 0, excluded: 0, warnings: 0 },
    tokenEstimate: 0,
  }));
  await engine.handleSubmit("inspect auth");

  assert.equal(providerPrompts.length, 0);
  assert.equal(ledgerSubmissions.length, 0);
  assert.equal(engine.getState().contextPacketChange?.kind, "meaning-change");
  assert.equal(engine.getState().panel.title, "Context expanded");
});

test("WorkShellEngine aborts provider call when context proof unavailable", async () => {
  const { engine, providerPrompts, ledgerSubmissions } = createLifecycleLedgerHarness({
    submitPreview: () => {
      throw new Error("ledger unavailable");
    },
  });

  await engine.initialize();
  await engine.handleSubmit("inspect auth");

  assert.equal(providerPrompts.length, 0);
  assert.equal(ledgerSubmissions.length, 0);
  assert.match(engine.getState().entries.at(-1)?.text ?? "", /context proof unavailable/i);
});

test("WorkShellEngine applies the search-mode guard before submitting context proof", async () => {
  const { engine, providerPrompts, ledgerSubmissions } = createLifecycleLedgerHarness({
    mode: "search",
  });

  await engine.initialize();
  await engine.handleSubmit("Anthropic parity 구현해줘");

  assert.equal(providerPrompts.length, 0);
  assert.equal(ledgerSubmissions.length, 0);
  assert.match(engine.getState().entries.at(-1)?.text ?? "", /Search mode is read-only/);
});

test("WorkShellEngine handles preview classification failure before provider invocation", async () => {
  const { engine, providerPrompts, ledgerSubmissions } = createLifecycleLedgerHarness({
    revalidate: () => {
      throw new Error("classifier unavailable");
    },
  });

  await engine.initialize();
  await engine.handleSubmit("inspect auth");

  assert.equal(providerPrompts.length, 0);
  assert.equal(ledgerSubmissions.length, 0);
  assert.match(engine.getState().entries.at(-1)?.text ?? "", /context proof unavailable/i);
});

test("WorkShellEngine rejects a submitted receipt that does not match the provider packet", async () => {
  const { engine, providerPrompts } = createLifecycleLedgerHarness({
    submitPreview: (input) => ({
      id: input.receiptId,
      projectId: "project-1",
      sessionId: input.sessionId,
      turnId: input.turnId,
      packetId: "wrong-packet",
      state: "submitted",
      profile: "build",
      tokenEstimate: 0,
      tokenEstimateState: "exact",
      sourceCount: 0,
      sourceRefs: [],
      createdAt: "2026-07-13T00:00:00.000Z",
    }),
  });

  await engine.initialize();
  await engine.handleSubmit("inspect auth");

  assert.equal(providerPrompts.length, 0);
  assert.match(engine.getState().entries.at(-1)?.text ?? "", /context proof unavailable/i);
});

test("WorkShellEngine prompt-command submits the same inspected packet receipt", async () => {
  const {
    engine,
    providerPrompts,
    ledgerSubmissions,
    setPacket,
  } = createLifecycleLedgerHarness();

  await engine.initialize();
  await engine.handleSubmit("/context");
  const inspectedPreviewId = engine.getState().contextPreviewReceipt?.id;
  assert.equal(typeof inspectedPreviewId, "string");

  setPacket(createLifecyclePacket({ id: "packet-lifecycle-review-2" }));
  await engine.handleSubmit("/review auth flow");

  assert.equal(providerPrompts.length, 1);
  assert.equal(ledgerSubmissions.length, 1);
  assert.notEqual(ledgerSubmissions[0].receiptId, inspectedPreviewId);
  assert.equal(ledgerSubmissions[0].packetId, "packet-lifecycle-review-2");
  assert.equal(engine.getState().contextSubmittedReceipt?.packetId, "packet-lifecycle-review-2");
  assert.match(providerPrompts[0] ?? "", /id="packet-lifecycle-review-2"/);
});

test("WorkShellEngine advances preview after submit so the next turn does not re-submit", async () => {
  const {
    engine,
    providerPrompts,
    ledgerSubmissions,
    setPacket,
  } = createLifecycleLedgerHarness({
    packet: createLifecyclePacket({ id: "packet-seq-1" }),
  });

  await engine.initialize();
  await engine.handleSubmit("/context");

  setPacket(createLifecyclePacket({ id: "packet-seq-2" }));
  await engine.handleSubmit("first turn");
  assert.equal(providerPrompts.length, 1);
  assert.equal(ledgerSubmissions.length, 1);
  assert.equal(ledgerSubmissions[0].packetId, "packet-seq-2");
  const firstReceiptId = ledgerSubmissions[0].receiptId;
  assert.equal(engine.getState().contextPreviewReceipt, undefined);
  assert.equal(engine.getState().contextSubmittedReceipt?.id, firstReceiptId);

  setPacket(createLifecyclePacket({ id: "packet-seq-3" }));
  await engine.handleSubmit("second turn");

  assert.equal(providerPrompts.length, 2);
  assert.equal(ledgerSubmissions.length, 2);
  assert.notEqual(ledgerSubmissions[1].receiptId, firstReceiptId);
  assert.equal(ledgerSubmissions[1].packetId, "packet-seq-3");
  assert.match(providerPrompts[1] ?? "", /id="packet-seq-3"/);
});

test("WorkShellEngine preserves the last submitted receipt across later previews", async () => {
  const {
    engine,
    calls,
    ledgerRevalidations,
    ledgerSubmissions,
    setPacket,
  } = createLifecycleLedgerHarness({
    revalidate: ({ preview, packet: nextPacket }) => {
      const before = new Set(
        preview.sourceRefs
          .filter((source) => source.includedInModel)
          .map((source) => source.sourceId),
      );
      const after = new Set(nextPacket.included.map((source) => source.id));
      const removedSourceIds = [...before].filter((sourceId) => !after.has(sourceId));
      const addedSourceIds = [...after].filter((sourceId) => !before.has(sourceId));
      return {
        kind: removedSourceIds.length > 0 ? "meaning-change" : "unchanged",
        removedSourceIds,
        addedSourceIds,
        protectedSourceIds: [],
        reason: removedSourceIds.length > 0
          ? "A source from the last request was removed."
          : "Packet source selection is unchanged.",
      };
    },
  });

  await engine.initialize();
  setPacket(createLifecyclePacket({ id: "packet-last-submitted-1" }));
  await engine.handleSubmit("first turn");
  const submittedReceiptId = ledgerSubmissions[0]?.receiptId;
  assert.equal(typeof submittedReceiptId, "string");

  setPacket(createLifecyclePacket({
    id: "packet-last-submitted-preview",
    included: [{
      id: "replacement-source",
      category: "workspace",
      label: "replacement.ts",
      reason: "replacement source",
      preview: "export function replacement() {}",
      tokenEstimate: 10,
      salience: 1,
      includedInModel: true,
    }],
  }));
  await engine.handleSubmit("/context");
  // Compare needs both sides: the freshly previewed candidate and the packet
  // the provider last saw.
  assert.equal(
    engine.getState().contextPreviewReceipt?.packetId,
    "packet-last-submitted-preview",
  );
  assert.equal(engine.getState().contextSubmittedReceipt?.id, submittedReceiptId);
  assert.equal(
    engine.getState().contextSubmittedReceipt?.packetId,
    "packet-last-submitted-1",
  );
  assert.equal(
    ledgerRevalidations.at(-1)?.previewId,
    submittedReceiptId,
    "the visible comparison must use the packet the provider last saw",
  );
  assert.deepEqual(engine.getState().contextPacketChange, {
    kind: "meaning-change",
    removedSourceIds: ["pinned-auth"],
    addedSourceIds: ["replacement-source"],
    protectedSourceIds: [],
    reason: "A source from the last request was removed.",
  });

  const snapshotCountBeforeModelChange = calls.snapshots.length;
  await engine.handleSubmit("/model gpt-4.1-mini");
  assert.equal(calls.snapshots.length, snapshotCountBeforeModelChange + 1);
  assert.equal(
    calls.snapshots.at(-1)?.lastSubmittedContextReceiptId,
    submittedReceiptId,
  );
});

test("WorkShellEngine cancels during context refresh without submitting or calling provider", async () => {
  let releaseResolve;
  const {
    engine,
    providerPrompts,
    ledgerSubmissions,
    setResolveGate,
  } = createLifecycleLedgerHarness();
  setResolveGate(() => new Promise((resolve) => {
    releaseResolve = resolve;
  }));

  await engine.initialize();
  const turn = engine.handleSubmit("inspect auth");
  while (!engine.getState().isBusy || typeof releaseResolve !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  engine.interruptTurn();
  releaseResolve();
  await turn;

  assert.equal(providerPrompts.length, 0);
  assert.equal(ledgerSubmissions.length, 0);
  assert.equal(
    engine.getState().entries.some((entry) => /context proof unavailable/i.test(entry.text)),
    false,
  );
});

test("WorkShellEngine preserves queued follow-ups when context proof blocks a turn", async () => {
  let releaseResolve;
  const {
    engine,
    providerPrompts,
    ledgerSubmissions,
    setPacket,
    setResolveGate,
  } = createLifecycleLedgerHarness({
    sessionId: "session-lifecycle-proof-block",
    revalidate: () => ({
      kind: "meaning-change",
      removedSourceIds: ["pinned-auth"],
      addedSourceIds: [],
      protectedSourceIds: ["pinned-auth"],
      reason: "A pinned or explicitly included source disappeared.",
    }),
  });

  await engine.initialize();
  await engine.handleSubmit("/queue clear");
  await engine.handleSubmit("/context");
  setPacket(createLifecyclePacket({
    id: "packet-lifecycle-missing-pin",
    included: [],
    sourceCounts: { included: 0, excluded: 0, warnings: 0 },
    tokenEstimate: 0,
  }));
  setResolveGate(() => new Promise((resolve) => {
    releaseResolve = resolve;
  }));

  const blockedTurn = engine.handleSubmit("inspect auth");
  while (!engine.getState().isBusy || typeof releaseResolve !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await engine.handleSubmit("queued follow-up");
  assert.ok(engine.getState().entries.some((entry) => /Queued follow-up #1/.test(entry.text)));
  assert.equal(engine.getState().queuedCount, 1);

  releaseResolve();
  await blockedTurn;

  assert.equal(providerPrompts.length, 0);
  assert.equal(ledgerSubmissions.length, 0);
  assert.equal(engine.getState().queuedCount, 1);
  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.equal(
    engine.getState().entries.some((entry) => /Running queued follow-up/.test(entry.text)),
    false,
  );
});

test("WorkShellEngine stops queue drain when a queued turn fails context proof", async () => {
  let releaseFirstTurn;
  let releaseQueuedResolve;
  const firstTurnGate = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });
  const {
    engine,
    providerPrompts,
    providerAttachments,
    ledgerSubmissions,
    setPacket,
    setResolveGate,
  } = createLifecycleLedgerHarness({
    sessionId: "session-lifecycle-queued-proof-block",
    agentRunTurn: async () => {
      await firstTurnGate;
      return { text: "lifecycle-ok" };
    },
    revalidate: ({ packet: nextPacket }) => nextPacket.id === "packet-queued-proof-block"
      ? {
          kind: "meaning-change",
          removedSourceIds: ["pinned-auth"],
          addedSourceIds: [],
          protectedSourceIds: ["pinned-auth"],
          reason: "A pinned or explicitly included source disappeared.",
        }
      : {
          kind: "unchanged",
          removedSourceIds: [],
          addedSourceIds: [],
          protectedSourceIds: [],
          reason: "Packet source selection is unchanged.",
        },
  });

  await engine.initialize();
  await engine.handleSubmit("/queue clear");
  const firstTurn = engine.handleSubmit("first turn");
  while (providerPrompts.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("blocked queued turn", [{ id: "queued-attachment" }]);
  await engine.handleSubmit("preserved queued follow-up");
  assert.equal(engine.getState().queuedCount, 2);
  setPacket(createLifecyclePacket({ id: "packet-queued-proof-block" }));
  setResolveGate(() => new Promise((resolve) => {
    releaseQueuedResolve = resolve;
  }));

  releaseFirstTurn();
  while (typeof releaseQueuedResolve !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await engine.handleSubmit("late queued follow-up");
  setResolveGate(undefined);
  releaseQueuedResolve();
  await firstTurn;

  assert.equal(providerPrompts.length, 1);
  assert.equal(ledgerSubmissions.length, 1);
  assert.equal(engine.getState().queuedCount, 3);
  assert.equal(engine.getState().queuePaused, true);
  assert.equal(
    engine.getState().entries.some((entry) => /Running queued follow-up #2/.test(entry.text)),
    false,
  );

  setPacket(createLifecyclePacket({ id: "packet-queued-proof-repaired" }));
  await engine.handleSubmit("repair turn");

  assert.equal(engine.getState().queuedCount, 0);
  assert.equal(engine.getState().queuePaused, false);
  assert.equal(providerPrompts.length, 5);
  assert.ok(providerAttachments.some((attachments) => (
    attachments?.some((attachment) => attachment.id === "queued-attachment")
  )));
});

test("WorkShellEngine recordTurn receives the same turnId and packet receipt evidence", async () => {
  const recordedTurns = [];
  const {
    engine,
    ledgerSubmissions,
    setPacket,
  } = createLifecycleLedgerHarness({
    engineOverrides: {
      recordTurn(turn) {
        recordedTurns.push(turn);
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  setPacket(createLifecyclePacket({ id: "packet-lifecycle-record-2" }));
  await engine.handleSubmit("inspect auth");

  assert.equal(ledgerSubmissions.length, 1);
  assert.equal(recordedTurns.length, 1);
  assert.equal(recordedTurns[0]?.turnId, ledgerSubmissions[0].turnId);
  assert.equal(recordedTurns[0]?.contextReceiptId, ledgerSubmissions[0].receiptId);
  assert.equal(recordedTurns[0]?.packetId, "packet-lifecycle-record-2");
  assert.match(recordedTurns[0]?.turnId ?? "", /^turn-session-lifecycle-1-\d+$/);
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

test("WorkShellEngine answers and cancels a pending decision by one-key methods", async () => {
  const interactionBridge = createWorkShellInteractionBridge();
  const { engine } = createEngine({
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
    id: "decision-one-key",
    title: "Execution choice",
    questions: [{
      id: "strategy",
      question: "Choose execution strategy.",
      options: [{ label: "Safe" }, { label: "Fast" }, { label: "Deep" }],
      recommended: 0,
    }],
  });
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-one-key");

  // Out-of-range indices are rejected up front (handlePendingDecisionReply
  // is void, so the range check is the only guard) and keep the decision
  // pending for a later reply.
  assert.equal(engine.answerPendingDecisionByIndex(0, "decision-one-key"), false);
  assert.equal(engine.answerPendingDecisionByIndex(99, "decision-one-key"), false);
  assert.equal(engine.answerPendingDecisionByIndex(1.5, "decision-one-key"), false);
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-one-key");
  assert.equal((await Promise.race([result, Promise.resolve("pending")])), "pending");

  assert.equal(engine.answerPendingDecisionByIndex(2, "stale-decision"), false);
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-one-key");
  assert.equal(engine.answerPendingDecisionByIndex(2, "decision-one-key"), true);

  assert.deepEqual(await result, {
    status: "answered",
    answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
  });
  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
  // A settled decision cannot be settled twice: the pending identity guard
  // makes both one-key methods no-ops after the fact.
  assert.equal(engine.answerPendingDecisionByIndex(1, "decision-one-key"), false);
  assert.equal(engine.cancelPendingDecision("decision-one-key"), false);
});

test("WorkShellEngine never settles replacement decision B with delayed controls for A", async () => {
  const interactionBridge = createWorkShellInteractionBridge();
  const { engine } = createEngine({
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

  const resultA = interactionBridge.ask({
    id: "decision-a",
    title: "First choice",
    questions: [{
      id: "first",
      question: "Choose first.",
      options: [{ label: "One" }, { label: "Two" }],
    }],
  });
  assert.equal(engine.cancelPendingDecision("decision-a"), true);
  assert.deepEqual(await resultA, { status: "cancelled" });

  const resultB = interactionBridge.ask({
    id: "decision-b",
    title: "Replacement choice",
    questions: [{
      id: "replacement",
      question: "Choose replacement.",
      options: [{ label: "Keep" }, { label: "Replace" }],
    }],
  });
  assert.equal(engine.answerPendingDecisionByIndex(1, "decision-a"), false);
  assert.equal(engine.cancelPendingDecision("decision-a"), false);
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-b");
  assert.equal(await Promise.race([resultB, Promise.resolve("pending")]), "pending");

  assert.equal(engine.answerPendingDecisionByIndex(2, "decision-b"), true);
  assert.deepEqual(await resultB, {
    status: "answered",
    answers: [{ id: "replacement", selectedOptions: ["Replace"] }],
  });
});

test("WorkShellEngine settles only the exact pending typed user decision", async () => {
  const interactionBridge = createWorkShellInteractionBridge();
  const { engine } = createEngine({
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
    id: "typed-decision",
    title: "Release choice",
    questions: [{
      id: "lane",
      question: "Which lane?",
      options: [{ label: "Canary" }, { label: "Stable" }],
    }],
  });
  assert.equal(engine.answerPendingUserDecision("stale-decision", [{ id: "lane", selectedOptions: ["Canary"] }]), false);
  assert.equal(engine.answerPendingUserDecision("typed-decision", [{ id: "lane", selectedOptions: ["Unknown"] }]), false);
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "typed-decision");
  assert.equal(engine.answerPendingUserDecision("typed-decision", [{ id: "lane", selectedOptions: ["Stable"] }]), true);
  assert.deepEqual(await result, {
    status: "answered",
    answers: [{ id: "lane", selectedOptions: ["Stable"] }],
  });
  assert.equal(engine.answerPendingUserDecision("typed-decision", [{ id: "lane", selectedOptions: ["Canary"] }]), false);
});

test("WorkShellEngine one-key decision methods refuse multi-question and absent decisions", async () => {
  const interactionBridge = createWorkShellInteractionBridge();
  const { engine } = createEngine({
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

  assert.equal(engine.answerPendingDecisionByIndex(1, "absent-decision"), false);
  assert.equal(engine.cancelPendingDecision("absent-decision"), false);

  const result = interactionBridge.ask({
    id: "decision-multi",
    title: "Scope",
    questions: [
      {
        id: "depth",
        question: "How deep?",
        options: [{ label: "Shallow" }, { label: "Deep" }],
      },
      {
        id: "breadth",
        question: "How wide?",
        options: [{ label: "Narrow" }, { label: "Wide" }],
      },
    ],
  });
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-multi");
  // Multi-question decisions need typed `question-id: n` replies; digits
  // must stay ordinary input instead of half-answering.
  assert.equal(engine.answerPendingDecisionByIndex(1, "decision-multi"), false);
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-multi");

  assert.equal(engine.cancelPendingDecision("decision-multi"), true);

  assert.deepEqual(await result, { status: "cancelled" });
  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
});

test("WorkShellEngine still settles a pending decision when console routing throws", async () => {
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

  // Classifying the line is a console convenience. When it blows up, the
  // answer the operator typed is still an answer: swallowing it would leave
  // the run parked behind a question nothing can settle.
  let routeCalls = 0;
  engine.resolveBusySubmitDecision = async () => {
    routeCalls += 1;
    throw new Error("rust steer busy-submit exited 1");
  };
  const replies = [];
  const handleReply = engine.handlePendingDecisionReply.bind(engine);
  engine.handlePendingDecisionReply = (value) => {
    replies.push(value);
    handleReply(value);
  };
  const entriesBefore = engine.getState().entries.length;

  await engine.handleSubmit("2");

  assert.equal(routeCalls, 1, "the classifier is consulted exactly once");
  assert.deepEqual(replies, ["2"], "the original line settles the decision exactly once");
  assert.deepEqual(await result, {
    status: "answered",
    answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
  });
  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
  assert.equal(engine.getState().queuedCount, 0, "a failed route must not queue the answer");
  assert.deepEqual(calls.turns, [], "a failed route must not open a provider turn");
  assert.equal(engine.getState().isBusy, false);

  // The failure is reported once, in the shell's own error voice, and the raw
  // command failure never reaches the operator.
  const added = engine.getState().entries.slice(entriesBefore);
  assert.equal(added.length, 1, "the failure is reported once, not per question");
  assert.equal(added[0]?.role, "system");
  assert.match(added[0]?.text ?? "", /^ERR:Console commands are unavailable\./);
  assert.doesNotMatch(added[0]?.text ?? "", /busy-submit/);
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
        succeeded: true,
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
    undoContextSourceAction() {
      const before = {
        category: "workspace",
        label: "AGENTS.md",
        includedInModel,
        salience,
        tokenEstimate: 12,
      };
      includedInModel = false;
      return {
        id: "receipt-undo",
        action: "undo",
        sourceId: "workspace-guidance",
        sourceLabel: "AGENTS.md",
        message: "undid include AGENTS.md",
        canUndo: false,
        succeeded: true,
        before,
        after: {
          ...before,
          includedInModel,
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

  await engine.undoLastContextSourceAction();
  assert.equal(engine.getState().contextPacket?.excluded[0]?.includedInModel, false);
  assert.equal(engine.getState().contextActionReceipt?.action, "undo");
  assert.equal(engine.getState().contextActionReceipt?.canUndo, false);
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
  engine.updateTerminalRows(32);

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
        succeeded: true,
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

test("WorkShellEngine numeric source cursor follows the desk stage-then-group order", async () => {
  const mutations = [];
  const packet = {
    id: "packet-stage-order",
    version: 1,
    generatedAt: "2026-07-14T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "sent-workspace",
        category: "workspace",
        label: "AGENTS.md",
        reason: "repo instructions loaded",
        preview: "Keep diffs small.",
        tokenEstimate: 10,
        includedInModel: true,
      },
      {
        id: "sent-runtime",
        category: "runtime",
        label: "Runtime probe",
        reason: "live runtime state",
        preview: "Runtime is idle.",
        tokenEstimate: 6,
        includedInModel: true,
      },
    ],
    excluded: [{
      id: "held-workspace",
      category: "workspace",
      label: "LEGACY.md",
      reason: "over budget",
      preview: "Legacy notes.",
      tokenEstimate: 40,
      includedInModel: false,
    }],
    warnings: [],
    preview: [],
    sourceCounts: { included: 2, excluded: 1, warnings: 0 },
    tokenEstimate: 16,
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    mutateContextSource(action) {
      mutations.push(action);
      return undefined;
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");

  // The desk draws every "In next request" row above the "Held back" block, so
  // row 1 is the other sent source — not the held source that shares row 0's
  // category group.
  engine.moveContextInspectorCursor(1);
  await engine.forgetContextSourceAtCursor();
  assert.deepEqual(mutations.at(-1), { kind: "forget", id: "sent-runtime" });

  engine.moveContextInspectorCursor(1);
  await engine.includeContextSourceAtCursor();
  assert.deepEqual(mutations.at(-1), { kind: "include", id: "held-workspace" });
});

test("WorkShellEngine ignores source keys the selected row does not offer", async () => {
  const mutations = [];
  const packet = {
    id: "packet-capability",
    version: 1,
    generatedAt: "2026-07-14T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "provider-system-prompt-configured",
        category: "provider-system-prompt",
        label: "Configured prompt",
        reason: "prompt guidance active",
        preview: "Prompt sections are active.",
        tokenEstimate: 22,
        includedInModel: true,
        actions: ["preview"],
      },
      {
        id: "workspace-notes",
        category: "workspace",
        label: "NOTES.md",
        reason: "repo instructions loaded",
        preview: "Keep diffs small.",
        tokenEstimate: 12,
        includedInModel: true,
        actions: ["hold-back", "preview"],
      },
    ],
    excluded: [{
      id: "sealed-transcript",
      category: "runtime",
      label: "Sealed transcript",
      reason: "held back by policy",
      preview: "Transcript stays local.",
      tokenEstimate: 30,
      includedInModel: false,
      actions: ["preview", "compare"],
    }],
    warnings: [],
    preview: [],
    sourceCounts: { included: 2, excluded: 1, warnings: 0 },
    tokenEstimate: 34,
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    mutateContextSource(action) {
      mutations.push(action);
      return undefined;
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");

  // Row 0 only offers preview: pin and hold-back keys leave the packet alone.
  await engine.toggleContextInspectorPin();
  await engine.forgetContextSourceAtCursor();
  assert.deepEqual(mutations, []);

  // Row 1 offers hold-back but not pin.
  engine.moveContextInspectorCursor(1);
  await engine.forgetContextSourceAtCursor();
  assert.deepEqual(mutations, [{ kind: "forget", id: "workspace-notes" }]);
  await engine.toggleContextInspectorPin();
  assert.deepEqual(mutations, [{ kind: "forget", id: "workspace-notes" }]);

  // Row 2 is held back and never re-includable.
  engine.moveContextInspectorCursor(1);
  await engine.includeContextSourceAtCursor();
  assert.deepEqual(mutations, [{ kind: "forget", id: "workspace-notes" }]);
  assert.equal(engine.getState().contextPacket?.excluded[0]?.includedInModel, false);
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

test("WorkShellEngine shows the copyable auth URL while inline oauth is pending", async () => {
  let resolveInline;
  const inlinePromise = new Promise((resolve) => {
    resolveInline = resolve;
  });
  const { engine } = createEngine({
    resolveWorkShellSlashCommand(input) {
      return input === "/auth login" ? ["auth", "login"] : undefined;
    },
    async resolveWorkShellInlineCommand(_args, _runInlineCommand, onProgress) {
      onProgress?.("Open this URL in your browser:");
      onProgress?.("https://auth.openai.com/oauth/authorize?client_id=test");
      onProgress?.("Waiting for callback…");
      return inlinePromise;
    },
  });

  await engine.initialize();
  const pending = engine.handleSubmit("/auth login");
  await Promise.resolve();

  assert.equal(engine.getState().panel.title, "Auth");
  assert.deepEqual(engine.getState().panel.lines, [
    "Waiting for callback…",
    "Open this URL in your browser:",
    "https://auth.openai.com/oauth/authorize?client_id=test",
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
    "Inspect sources · /context",
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
    "Inspect sources · /context",
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
  assert.deepEqual(
    engine.getState().liveTraceLines,
    ["executor Inspect login.ts"],
    "the always-on live feed buffer fills even in minimal trace mode",
  );
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
  assert.deepEqual(
    engine.getState().liveTraceLines,
    ["thinking inspect repo"],
    "a minimal-mode turn already feeds the live dock buffer",
  );

  emitTrace({
    type: "reasoning.delta",
    provider: "openai",
    model: "gpt-5.6-luna",
    kind: "summary",
    delta: "inspect repo before editing",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(engine.getState().busyStatus ?? "", /inspect repo before editing/i);
  assert.deepEqual(
    engine.getState().liveTraceLines,
    ["thinking inspect repo", "✦ thinking· inspect repo before editing"],
    "reasoning deltas append to the live feed buffer",
  );

  emitTrace({
    type: "tool.started",
    provider: "openai",
    toolName: "read_file",
    toolCallId: "call-visible-1",
    input: { path: "README.md" },
    startedAt: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(engine.getState().busyStatus ?? "", /read.*README\.md/i);

  emitTrace({
    type: "tool.completed",
    provider: "openai",
    toolName: "read_file",
    toolCallId: "call-visible-1",
    isError: false,
    content: "ok",
    startedAt: 1,
    durationMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(engine.getState().busyStatus ?? "", /read/i);
  assert.deepEqual(
    engine.getState().entries,
    [{ id: "entry-0", role: "tool", text: "read\n5ms" }],
    "a completed read appends the assembled tool detail entry even in minimal trace mode",
  );
  assert.deepEqual(engine.getState().traceLines, []);
  assert.deepEqual(
    engine.getState().liveTraceLines,
    [
      "thinking inspect repo",
      "✦ thinking· inspect repo before editing",
      "→ read README.md",
      "✓ read 5ms",
    ],
    "minimal mode keeps filling the live dock buffer while traceLines stays empty",
  );
});

test("WorkShellEngine fills both trace buffers in verbose mode", async () => {
  const { engine, emitTrace } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/verbose");
  emitTrace({
    type: "tool.started",
    provider: "openai",
    toolName: "read_file",
    toolCallId: "call-verbose-1",
    input: { path: "README.md" },
    startedAt: 1,
  });
  emitTrace({
    type: "reasoning.delta",
    provider: "openai",
    model: "gpt-5.6-luna",
    kind: "summary",
    delta: "inspect repo before editing",
  });

  assert.deepEqual(
    engine.getState().traceLines,
    ["✦ thinking· inspect repo before editing", "→ read README.md"],
    "traceLines keeps its existing newest-first buffer ordering",
  );
  assert.deepEqual(
    engine.getState().liveTraceLines,
    ["→ read README.md", "✦ thinking· inspect repo before editing"],
    "liveTraceLines fills in chronological order (newest last) in verbose mode too",
  );
});

test("WorkShellEngine keeps the live feed buffer alive across /minimal", async () => {
  const { engine, emitTrace } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/verbose");
  emitTrace({
    type: "tool.started",
    provider: "openai",
    toolName: "read_file",
    toolCallId: "call-minimal-1",
    input: { path: "README.md" },
    startedAt: 1,
  });
  assert.ok(engine.getState().traceLines.length > 0);
  assert.ok(engine.getState().liveTraceLines.length > 0);

  await engine.handleSubmit("/minimal");

  assert.equal(engine.getState().traceMode, "minimal");
  assert.deepEqual(
    engine.getState().traceLines,
    [],
    "/minimal still clears the verbose-only trace buffer",
  );
  assert.deepEqual(
    engine.getState().liveTraceLines,
    ["→ read README.md"],
    "/minimal leaves the live dock buffer alone so the feed never breaks",
  );
});

test("WorkShellEngine caps the live feed buffer at the newest 8 lines", async () => {
  const { engine, emitTrace } = createEngine();

  await engine.initialize();
  for (let step = 1; step <= 10; step += 1) {
    emitTrace({
      type: "orchestrator.step",
      role: "executor",
      status: "running",
      summary: `step ${step}`,
    });
  }

  assert.deepEqual(
    engine.getState().liveTraceLines,
    Array.from({ length: 8 }, (_, index) => `executor step ${index + 3}`),
    "the live buffer keeps only the newest 8 lines (oldest dropped first)",
  );
  assert.deepEqual(
    engine.getState().traceLines,
    [],
    "minimal mode keeps the verbose-only trace buffer empty",
  );
});

test("WorkShellEngine soft-interrupts a busy turn and ignores late assistant output", async () => {
  let releaseTurn;
  let turnSignal;
  const bridgeWrites = [];
  const memoryWrites = [];
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
    async publishContextBridge(input) {
      bridgeWrites.push(input);
      return { bridgeId: "late-bridge", line: "late bridge" };
    },
    async writeScopedMemory(input) {
      memoryWrites.push(input);
      return { memoryId: "late-memory" };
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
  assert.deepEqual(bridgeWrites, []);
  assert.deepEqual(memoryWrites, []);
});

test("WorkShellEngine shutdown aborts the active turn and fails visibly when its provider will not settle", async () => {
  let releaseTurn;
  let turnSignal;
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(_prompt, _attachments, options) {
        turnSignal = options?.signal;
        await new Promise(resolve => { releaseTurn = resolve; });
        return { text: "late shutdown result" };
      },
    },
  });

  await engine.initialize();
  const turn = engine.handleSubmit("hold provider open");
  while (!turnSignal) await new Promise(resolve => setImmediate(resolve));
  try {
    await assert.rejects(
      engine.shutdown({ timeoutMs: 25 }),
      /did not settle/i,
    );
    assert.equal(turnSignal.aborted, true);
  } finally {
    releaseTurn?.();
    await turn;
    engine.dispose();
  }
});

test("an admitted remote turn cancelled before busy state never reaches the provider", async () => {
  let providerCalls = 0;
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn() { providerCalls += 1; return { text: "must not run" }; },
    },
  });
  await engine.initialize();

  engine.admitRuntimeTurn();
  assert.equal(engine.getState().isBusy, false);
  assert.equal(engine.interruptTurn(), true);
  await engine.handleSubmit("accepted before projected busy");

  assert.equal(providerCalls, 0);
  assert.equal(engine.getState().isBusy, false);
  assert.match(engine.getState().entries.at(-1)?.text ?? "", /cancelled before it started/i);
  assert.equal(engine.interruptTurn(), false, "an idle cancel must not report success");
});

test("owner shutdown waits for a SIGTERM-ignoring provider process group to be SIGKILLed", {
  skip: process.platform === "win32" ? "process-group settlement is POSIX-only" : false,
}, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "unclecode-owner-child-shutdown-"));
  const entryPath = path.join(workspace, "stubborn-provider.mjs");
  const pidPath = path.join(workspace, "provider.pid");
  const termPath = path.join(workspace, "provider.term");
  const readyPath = path.join(workspace, "provider.ready");
  let childPid;
  writeFileSync(entryPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termPath)}, "SIGTERM"));`,
    `writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
    "process.stdin.resume();",
    "setInterval(() => {}, 1_000);",
    "",
  ].join("\n"), "utf8");

  const provider = createOmpWorkerProvider({
    cwd: workspace,
    reasoning: supportedReasoning,
    env: {},
    runWorker: createOmpWorkerRunner({
      env: {},
      bunPath: process.execPath,
      workerEntryPath: entryPath,
      forceKillDelayMs: 500,
    }),
  });
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      runTurn(prompt, attachments, options) {
        return provider.runTurn(prompt, attachments, options);
      },
    },
    options: {
      provider: "omp",
      model: "kimi-code/k3",
      mode: "default",
      authLabel: "omp-managed",
      reasoning: supportedReasoning,
      cwd: workspace,
      contextSummaryLines: [],
    },
  });
  const registry = new LiveRuntimeEngineRegistry();

  try {
    await engine.initialize();
    registry.attach("child-shutdown", engine, { projectPath: workspace });
    const turn = engine.handleSubmit("hold provider child open");
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(readyPath), true, "the production provider child must install its signal handler");
    childPid = Number(readFileSync(pidPath, "utf8"));

    await registry.disposeAll();
    await turn;

    assert.equal(readFileSync(termPath, "utf8"), "SIGTERM");
    assert.throws(
      () => process.kill(childPid, 0),
      (error) => error?.code === "ESRCH",
      "owner shutdown cannot return while the provider process group is alive",
    );
  } finally {
    if (Number.isInteger(childPid)) {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
    }
    try { await registry.disposeAll(); } catch {}
    engine.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("WorkShellEngine retracts a bridge when interruption lands during publication", async () => {
  let releaseBridge;
  let markBridgeStarted;
  const bridgeStarted = new Promise((resolve) => {
    markBridgeStarted = resolve;
  });
  const durableBridges = new Set();
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn() {
        return { text: "finished reply" };
      },
    },
    async publishContextBridge() {
      markBridgeStarted();
      await new Promise((resolve) => {
        releaseBridge = resolve;
      });
      durableBridges.add("bridge-during-cancel");
      return {
        bridgeId: "bridge-during-cancel",
        line: "bridge during cancel",
        async rollback() {
          durableBridges.delete("bridge-during-cancel");
        },
      };
    },
  });

  await engine.initialize();
  const turn = engine.handleSubmit("first");
  await bridgeStarted;
  engine.interruptTurn();
  releaseBridge();
  await turn;

  assert.deepEqual([...durableBridges], []);
});

test("WorkShellEngine rolls back bridge and memory when interruption lands during promotion", async () => {
  let releaseMemory;
  let markMemoryStarted;
  const memoryStarted = new Promise((resolve) => {
    markMemoryStarted = resolve;
  });
  const durableBridges = new Set();
  const activeMemories = new Set(["memory-predecessor"]);
  const { engine } = createLifecycleLedgerHarness({
    agentRunTurn: async () => ({ text: "finished reply" }),
    engineOverrides: {
      async publishContextBridge() {
        durableBridges.add("bridge-before-memory");
        return {
          bridgeId: "bridge-before-memory",
          line: "bridge before memory",
          async rollback() {
            durableBridges.delete("bridge-before-memory");
          },
        };
      },
      memoryLineage: {
        record(input) {
          return { ...input, createdAt: "2026-07-13T00:00:00.000Z" };
        },
        invalidate() {
          throw new Error("not used");
        },
        rollbackPromotion() {},
        expire() {
          return 0;
        },
        get() {
          return undefined;
        },
        isActive(memoryId) {
          return activeMemories.has(memoryId);
        },
      },
      async promoteScopedMemory() {
        markMemoryStarted();
        await new Promise((resolve) => {
          releaseMemory = resolve;
        });
        activeMemories.delete("memory-predecessor");
        activeMemories.add("memory-during-cancel");
        return {
          memoryId: "memory-during-cancel",
          async rollback() {
            activeMemories.delete("memory-during-cancel");
            activeMemories.add("memory-predecessor");
          },
        };
      },
    },
  });

  await engine.initialize();
  const turn = engine.handleSubmit("first");
  await memoryStarted;
  engine.interruptTurn();
  releaseMemory();
  await turn;

  assert.deepEqual([...durableBridges], []);
  assert.deepEqual([...activeMemories], ["memory-predecessor"]);
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
        const userPrompt = stripWorkShellLanguageInstruction(prompt);
        prompts.push(userPrompt);
        if (userPrompt === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        if (userPrompt === "third") {
          await new Promise((resolve) => {
            releaseThird = resolve;
          });
        }
        return { text: `reply:${userPrompt}` };
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
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(prompts, ["first"]);

  releaseFirst();
  await firstTurn;
  while (typeof releaseThird !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  releaseThird();
  await thirdTurn;

  assert.deepEqual(prompts, ["first", "third", "second"]);
  assert.equal(engine.getState().queuePaused, false);
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
        const userPrompt = stripWorkShellLanguageInstruction(prompt);
        prompts.push(userPrompt);
        if (userPrompt === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { text: `reply:${userPrompt}` };
      },
    },
  });

  await engine.initialize();
  const firstTurn = engine.handleSubmit("first");
  while (!engine.getState().isBusy) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("second", [{ id: "queued-attachment" }]);
  assert.ok(engine.getState().entries.some((entry) => /Queued follow-up #1/.test(entry.text)));
  assert.ok(engine.getState().entries.some((entry) => /run automatically/.test(entry.text)));
  assert.ok(engine.getState().entries.some((entry) => /\/queue shows backlog/.test(entry.text)));
  await engine.handleSubmit("/queue");
  assert.equal(engine.getState().panel?.title, "Queue · follow-ups");
  assert.ok(
    engine
      .getState()
      .panel?.lines.some((line) =>
        /Running · 1 total · 1 pending · 0 in flight · 0 requires action/.test(line),
      ),
  );
  assert.ok(engine.getState().panel?.lines.some((line) => /Next · id 1 · pending(?: · wait \d+s)? · second · 1 attachment/.test(line)));
  assert.ok(engine.getState().panel?.lines.some((line) => /Enter queues one follow-up exactly once/.test(line)));
  assert.ok(engine.getState().panel?.lines.some((line) => /\/queue clear · \/queue resume/.test(line)));

  releaseFirst();
  await firstTurn;

  assert.deepEqual(prompts, ["first", "second"]);
  assert.ok(engine.getState().entries.some((entry) => /Running queued follow-up #1: second/.test(entry.text)));
});

test("WorkShellEngine never nacks completed work when post-ack attachment cleanup must retry", {
  skip: process.platform === "win32",
}, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-shell-cleanup-retry-"));
  const sessionId = "queue-cleanup-retry";
  const outside = path.join(cwd, "outside.json");
  let releaseFirst;
  let artifactPath;
  const prompts = [];
  writeFileSync(outside, "{}\n", "utf8");
  try {
    const options = {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd,
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    };
    const { engine } = createEngine({
      sessionId,
      options,
      agent: {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(prompt) {
          const userPrompt = stripWorkShellLanguageInstruction(prompt);
          prompts.push(userPrompt);
          if (userPrompt === "first") {
            await new Promise((resolve) => { releaseFirst = resolve; });
          } else if (userPrompt === "second") {
            const directory = path.join(
              cwd,
              ".unclecode",
              "artifacts",
              sessionId,
              "queue-attachments",
            );
            artifactPath = path.join(directory, readdirSync(directory)[0]);
            unlinkSync(artifactPath);
            symlinkSync(outside, artifactPath);
          }
          return { text: `reply:${userPrompt}` };
        },
      },
    });

    await engine.initialize();
    const firstTurn = engine.handleSubmit("first");
    while (typeof releaseFirst !== "function") {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await engine.handleSubmit("second", [{ id: "queued-attachment" }]);
    releaseFirst();
    await firstTurn;

    assert.deepEqual(prompts, ["first", "second"]);
    assert.deepEqual(JSON.parse(runRustCommandSync(
      ["rust", "queue", "list", sessionId], cwd,
    )), [], "the acknowledged ID stays removed when deletion fails");
    assert.equal(JSON.parse(runRustCommandSync(
      ["rust", "queue", "cleanup-list-json", sessionId, "64"], cwd,
    )).length, 1, "the orphan remains durably tracked for retry");
    assert.equal(
      engine.getState().entries.some((entry) => /symbolic-link|symlink/i.test(entry.text)),
      false,
      "post-ack cleanup does not turn a completed provider turn into a queue failure",
    );

    unlinkSync(artifactPath);
    const { engine: restarted } = createEngine({ sessionId, options });
    await restarted.initialize();
    assert.deepEqual(JSON.parse(runRustCommandSync(
      ["rust", "queue", "cleanup-list-json", sessionId, "64"], cwd,
    )), [], "startup retries and completes the bounded cleanup batch");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkShellEngine keeps a queued follow-up stable while paused and drains it once after resume", async () => {
  let releaseFirst;
  const prompts = [];
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        const userPrompt = stripWorkShellLanguageInstruction(prompt);
        prompts.push(userPrompt);
        if (userPrompt === "first") {
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { text: `reply:${userPrompt}` };
      },
    },
  });
  await engine.initialize();
  const firstTurn = engine.handleSubmit("first");
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await engine.handleSubmit("second");
  assert.equal(engine.getState().queuedCount, 1);

  const pause = engine.requestTurnPause();
  releaseFirst();
  const receipt = await pause;
  assert.equal(receipt.boundary, "after_provider");
  assert.deepEqual(prompts, ["first"]);
  assert.equal(engine.getState().queuedCount, 1);

  assert.equal(engine.resumeTurn(), true);
  await firstTurn;
  assert.deepEqual(prompts, ["first", "second"]);
  assert.equal(engine.getState().queuedCount, 0);
});

function createBusyEngine() {
  let releaseTurn;
  const prompts = [];
  const { engine, calls } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        const userPrompt = stripWorkShellLanguageInstruction(prompt);
        prompts.push(userPrompt);
        if (userPrompt === "first") {
          await new Promise((resolve) => {
            releaseTurn = resolve;
          });
        }
        return { text: `reply:${userPrompt}` };
      },
    },
  });
  return { engine, calls, prompts, release: () => releaseTurn?.() };
}

test("WorkShellEngine opens the agent console during a busy turn without queueing it", async () => {
  for (const [line, tab] of [["/agents", "agents"], ["/jobs", "jobs"], ["/todo", "plan"]]) {
    const { engine, prompts, release } = createBusyEngine();

    await engine.initialize();
    const firstTurn = engine.handleSubmit("first");
    while (
      !engine.getState().isBusy
      || !engine.getState().entries.some((entry) => entry.text === "first")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const entriesBefore = engine.getState().entries.map((entry) => entry.text);

    await engine.handleSubmit(line);

    assert.equal(engine.getState().agentConsoleView.open, true, `${line} must open while busy`);
    assert.equal(engine.getState().agentConsoleView.tab, tab);
    assert.equal(engine.getState().queuedCount, 0, `${line} must not be queued`);
    assert.deepEqual(
      engine.getState().entries.map((entry) => entry.text),
      entriesBefore,
      `${line} must not write a conversation entry`,
    );
    assert.equal(engine.getState().isBusy, true);

    release();
    await firstTurn;
    assert.deepEqual(prompts, ["first"]);
  }
});

test("WorkShellEngine still refuses unrelated slash commands during a busy turn", async () => {
  const { engine, release } = createBusyEngine();

  await engine.initialize();
  const firstTurn = engine.handleSubmit("first");
  while (!engine.getState().isBusy) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("/model gpt-5.4");

  assert.equal(engine.getState().agentConsoleView.open, false);
  assert.equal(engine.getState().queuedCount, 0);
  const rejection = engine.getState().entries.at(-1);
  assert.equal(rejection?.role, "system");
  assert.match(rejection?.text ?? "", /not queued/);
  assert.match(rejection?.text ?? "", /\/agents/);
  assert.match(rejection?.text ?? "", /\/jobs/);
  assert.match(rejection?.text ?? "", /\/todo/);

  release();
  await firstTurn;
});

test("WorkShellEngine opens the agent console while a busy turn waits on a decision", async () => {
  for (const [line, tab] of [["/agents", "agents"], ["/jobs", "jobs"], ["/todo", "plan"]]) {
    const interactionBridge = createWorkShellInteractionBridge();
    const prompts = [];
    let releaseTurn;
    let decision;
    let settled;
    const { engine } = createEngine({
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
      agent: {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(prompt) {
          const userPrompt = stripWorkShellLanguageInstruction(prompt);
          prompts.push(userPrompt);
          // The turn stays in flight while it waits on the operator, so the
          // shell is genuinely busy with a decision open — the exact state the
          // console has to stay reachable in.
          decision = interactionBridge.ask({
            id: "decision-1",
            title: "Execution choice",
            questions: [{
              id: "strategy",
              question: "Choose execution strategy.",
              options: [{ label: "Safe" }, { label: "Fast" }],
              recommended: 0,
            }],
          });
          void decision.then((value) => {
            settled = value;
          });
          await new Promise((resolve) => {
            releaseTurn = resolve;
          });
          return { text: `reply:${userPrompt}` };
        },
      },
    });
    await engine.initialize();

    const firstTurn = engine.handleSubmit("first");
    while (
      !engine.getState().isBusy
      || engine.getState().agentConsole.pendingDecision?.id !== "decision-1"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(engine.getState().isBusy, true, `${line} needs a busy turn to be meaningful`);

    const classified = [];
    const classify = engine.resolveBusySubmitDecision.bind(engine);
    engine.resolveBusySubmitDecision = async (value) => {
      classified.push(value);
      return classify(value);
    };
    const entriesBefore = engine.getState().entries.map((entry) => entry.text);

    await engine.handleSubmit(line);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(classified, [line], `${line} must consult the Rust classifier once`);
    assert.equal(engine.getState().isBusy, true, `${line} must not end the turn`);
    assert.equal(engine.getState().agentConsoleView.open, true, `${line} must open the console`);
    assert.equal(engine.getState().agentConsoleView.tab, tab);
    assert.equal(
      engine.getState().agentConsole.pendingDecision?.id,
      "decision-1",
      `${line} must leave the decision pending`,
    );
    assert.equal(settled, undefined, `${line} must not answer the decision`);
    assert.equal(engine.getState().queuedCount, 0, `${line} must not queue`);
    assert.deepEqual(engine.getState().entries.map((entry) => entry.text), entriesBefore);

    await engine.handleSubmit("2");
    assert.deepEqual(await decision, {
      status: "answered",
      answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
    });
    assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
    assert.deepEqual(
      classified,
      [line, "2"],
      "an ordinary answer must be classified once and still answer the decision",
    );
    assert.equal(engine.getState().queuedCount, 0, "the answer must not be queued either");

    releaseTurn();
    await firstTurn;
    assert.deepEqual(prompts, ["first"]);
  }
});

test("WorkShellEngine treats every console-like invalid slash form as a silent no-op", async () => {
  for (const line of [
    "/agent",
    "/agen",
    "/age",
    "/job",
    "/tod",
    "/agents extra",
    "/jobs extra",
    "/todo extra",
  ]) {
    const { engine, calls } = createEngine();

    await engine.initialize();
    const entriesBefore = engine.getState().entries.map((entry) => entry.text);
    const panelBefore = engine.getState().panel;

    await engine.handleSubmit(line);

    assert.equal(engine.getState().agentConsoleView.open, false, `${line} must not open the console`);
    assert.deepEqual(calls.inline, [], `${line} must not run an inline command`);
    assert.deepEqual(calls.turns, [], `${line} must not reach the provider`);
    assert.equal(engine.getState().queuedCount, 0, `${line} must not touch the queue`);
    assert.deepEqual(
      engine.getState().entries.map((entry) => entry.text),
      entriesBefore,
      `${line} must leave no transcript residue`,
    );
    assert.equal(engine.getState().panel, panelBefore, `${line} must not replace the panel`);
  }
});

test("WorkShellEngine keeps the established guidance for an ordinary unknown slash command", async () => {
  const { engine, calls } = createEngine();

  await engine.initialize();
  await engine.handleSubmit("/definitely-unknown");

  assert.equal(engine.getState().panel.title, "Command");
  assert.ok(
    engine.getState().entries.some((entry) => /^Unknown command \/definitely-unknown/.test(entry.text)),
    "an unrelated unknown slash keeps its user-visible guidance",
  );
  assert.deepEqual(calls.inline, []);
  assert.deepEqual(calls.turns, []);
  assert.equal(engine.getState().agentConsoleView.open, false);
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
        const userPrompt = stripWorkShellLanguageInstruction(prompt);
        prompts.push(userPrompt);
        if (userPrompt === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { text: `reply:${userPrompt}` };
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
  assert.equal(engine.getState().panel?.title, "Queue · follow-ups");
  assert.ok(
    engine
      .getState()
      .panel?.lines.some((line) =>
        /Running · 0 total · 0 pending · 0 in flight · 0 requires action/.test(line),
      ),
  );
  assert.ok(engine.getState().panel?.lines.some((line) => /Queue empty/.test(line)));

  releaseFirst();
  await firstTurn;

  assert.deepEqual(prompts, ["first"]);
});

test("WorkShellEngine clear during a claimed follow-up cannot replace or duplicate the executing id", async () => {
  let releaseFirst;
  let releaseSecond;
  const prompts = [];
  const { engine } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        const userPrompt = stripWorkShellLanguageInstruction(prompt);
        prompts.push(userPrompt);
        if (userPrompt === "first") {
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        if (userPrompt === "second") {
          await new Promise((resolve) => { releaseSecond = resolve; });
        }
        return { text: `reply:${userPrompt}` };
      },
    },
  });

  await engine.initialize();
  const drain = engine.handleSubmit("first");
  while (typeof releaseFirst !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await engine.handleSubmit("second");
  await engine.handleSubmit("third");
  releaseFirst();
  while (typeof releaseSecond !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await engine.handleSubmit("/queue clear");
  assert.equal(engine.getState().queuedCount, 0, "the count remains pending-only");
  assert.ok(
    engine.getState().panel?.lines.some((line) =>
      /Running · 1 total · 0 pending · 1 in flight · 0 requires action/.test(line),
    ),
    "clear must render the surviving claimed item from the full snapshot",
  );
  assert.ok(engine.getState().panel?.lines.some((line) => /id 1 · in flight/.test(line)));
  releaseSecond();
  await drain;

  assert.deepEqual(prompts, ["first", "second"]);
  assert.equal(engine.getState().queuedCount, 0);
  assert.equal(
    engine.getState().entries.filter((entry) => /Running queued follow-up.*second/.test(entry.text)).length,
    1,
  );
});

test("WorkShellEngine startup quarantines a persisted claim until explicit retry", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-shell-queue-restart-"));
  const sessionId = "queue-restart-session";
  const turns = [];
  try {
    const pushed = JSON.parse(runRustCommandSync(
      ["rust", "queue", "push-json", sessionId, "stale claimed follow-up"], cwd,
    ));
    assert.equal(JSON.parse(runRustCommandSync(
      ["rust", "queue", "claim-json", sessionId], cwd,
    )).id, pushed.id);

    const { engine } = createEngine({
      sessionId,
      options: {
        provider: "openai",
        model: "gpt-5.4",
        mode: "default",
        authLabel: "api-key-env",
        reasoning: supportedReasoning,
        cwd,
        contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      },
      agent: {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(prompt) {
          turns.push(stripWorkShellLanguageInstruction(prompt));
          return { text: "done" };
        },
      },
    });

    await engine.initialize();
    assert.deepEqual(turns, [], "startup recovery must never execute a stale claim");
    assert.equal(engine.getState().queuedCount, 0, "requires-action is not a pending count");
    assert.equal(engine.getState().queuePaused, true);
    assert.ok(engine.getState().entries.some((entry) => /requires action.*retry or discard/i.test(entry.text)));

    await engine.handleSubmit("/queue");
    const panelText = engine.getState().panel.lines.join("\n");
    assert.match(panelText, /1 total · 0 pending · 0 in flight · 1 requires action/);
    assert.match(panelText, new RegExp(`id ${pushed.id} · requires action`));
    assert.match(panelText, /UncleCode restarted before this…/);

    assert.equal(await engine.retryQueueItem(pushed.id), true);
    assert.equal(engine.getState().queuedCount, 1);
    assert.deepEqual(turns, [], "retry only makes the stable id pending");
    await engine.resumeQueueItems();
    assert.deepEqual(turns, ["stale claimed follow-up"]);
    assert.equal(engine.getState().queuedCount, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkShellEngine queue panel keeps follow-up separation across terminal widths", async () => {
  const { engine } = createEngine();

  await engine.initialize();
  engine.updateTerminalColumns(80);
  await engine.handleSubmit("/queue");
  const narrowLines = engine.getState().panel?.lines ?? [];
  assert.equal(engine.getState().panel?.title, "Queue · follow-ups");
  assert.ok(
    narrowLines.some((line) => /Queue = user follow-ups/.test(line) && /Plan\/PDCA/.test(line)),
    "80-column layout should explain that Queue and Plan/PDCA are different models",
  );

  engine.updateTerminalColumns(120);
  let wideLines = engine.getState().panel?.lines ?? [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    wideLines = engine.getState().panel?.lines ?? [];
    if (wideLines.some((line) => /Queue = user follow-ups/.test(line))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    wideLines.some((line) => /Queue = user follow-ups/.test(line) && /Agents|agents/.test(line)),
    "wide layout should preserve Queue/Plan/Agents separation without re-running /queue",
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

test("WorkShellEngine Ctrl+O path reprojects retained tool history through the one persisted trace mode", async () => {
  const retained = [
    { id: "tool-running", role: "tool", text: "bash npm test\nrunning" },
    { id: "tool-done", role: "tool", text: "bash npm test\n12 lines · 34ms\npassed" },
    { id: "tool-error", role: "tool", text: "read missing.txt\nENOENT · 2ms\nmissing" },
    { id: "approval", role: "tool", text: "Security approval · write_file\nAllowed once" },
  ];
  const { engine, calls } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      initialTraceMode: "minimal",
      initialEntries: retained,
    },
  });
  await engine.initialize();
  const before = engine.getState().entries;

  await engine.toggleToolHistoryDisplay();
  assert.equal(engine.getState().traceMode, "verbose");
  assert.deepEqual(engine.getState().entries, before);
  assert.equal(calls.snapshots.at(-1)?.traceMode, "verbose");

  await engine.toggleToolHistoryDisplay();
  assert.equal(engine.getState().traceMode, "minimal");
  assert.deepEqual(engine.getState().entries, before);
  assert.equal(calls.snapshots.at(-1)?.traceMode, "minimal");
});

test("WorkShellEngine keeps the session locale stable when a later sentence uses another language", async () => {
  const { engine, calls } = createEngine({
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "default",
      authLabel: "api-key-env",
      reasoning: supportedReasoning,
      cwd: "/repo",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      initialUiLocale: "ko",
    },
  });
  await engine.initialize();

  await engine.handleSubmit("이 파일을 설명해 주세요");
  assert.equal(engine.getState().uiLocale, "ko");
  assert.match(calls.turns[0], /^현재 세션의 사용자 언어를 따라 한국어로 답변하세요/u);
  assert.doesNotMatch(calls.turns[0], /Respond in English/u);
  assert.equal(calls.snapshots.at(-1)?.uiLocale, "ko");

  await engine.handleSubmit("Explain the next file in English");
  assert.equal(engine.getState().uiLocale, "ko");
  assert.match(calls.turns[1], /^현재 세션의 사용자 언어를 따라 한국어로 답변하세요/u);
  assert.doesNotMatch(calls.turns[1], /Respond in English/u);
  assert.equal(calls.snapshots.at(-1)?.uiLocale, "ko");
});

test("WorkShellEngine locks the first prose language across opposite terminal locales", async () => {
  const previousLcAll = process.env.LC_ALL;
  try {
    for (const fixture of [
      {
        terminal: "en_US.UTF-8",
        initial: "en",
        first: "첫 요청을 처리해 주세요",
        later: "Explain the next file",
        expected: "ko",
        instruction: /^현재 세션의 사용자 언어를 따라 한국어로 답변하세요/u,
      },
      {
        terminal: "ko_KR.UTF-8",
        initial: "ko",
        first: "Handle the first request",
        later: "다음 파일도 설명해 주세요",
        expected: "en",
        instruction: /^Respond in English for this session/u,
      },
    ]) {
      process.env.LC_ALL = fixture.terminal;
      const { engine, calls } = createEngine({
        options: {
          provider: "openai",
          model: "gpt-5.4",
          mode: "default",
          authLabel: "api-key-env",
          reasoning: supportedReasoning,
          cwd: "/repo",
          contextSummaryLines: ["Loaded guidance: AGENTS.md"],
        },
      });
      await engine.initialize();
      assert.equal(engine.getState().uiLocale, fixture.initial);
      assert.equal(engine.getState().uiLocaleLocked, false);

      await engine.handleSubmit(fixture.first);
      assert.equal(engine.getState().uiLocale, fixture.expected);
      assert.equal(engine.getState().uiLocaleLocked, true);
      assert.match(calls.turns[0], fixture.instruction);

      await engine.handleSubmit(fixture.later);
      assert.equal(engine.getState().uiLocale, fixture.expected);
      assert.match(calls.turns[1], fixture.instruction);
    }
  } finally {
    if (previousLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousLcAll;
  }
});

test("WorkShellEngine ignores local command prose until the first provider-bound request", async () => {
  const previousLcAll = process.env.LC_ALL;
  try {
    for (const fixture of [
      {
        terminal: "en_US.UTF-8",
        command: "/remember session keep this note",
        first: "첫 요청을 처리해 주세요",
        initial: "en",
        expected: "ko",
      },
      {
        terminal: "ko_KR.UTF-8",
        command: "/remember session 이 메모를 보관해 주세요",
        first: "Handle the first request",
        initial: "ko",
        expected: "en",
      },
    ]) {
      process.env.LC_ALL = fixture.terminal;
      const { engine, calls } = createEngine();
      await engine.initialize();

      await engine.handleSubmit(fixture.command);
      assert.equal(engine.getState().uiLocale, fixture.initial);
      assert.equal(engine.getState().uiLocaleLocked, false);
      assert.deepEqual(calls.turns, []);

      await engine.handleSubmit(fixture.first);
      assert.equal(engine.getState().uiLocale, fixture.expected);
      assert.equal(engine.getState().uiLocaleLocked, true);
      assert.equal(calls.turns.length, 1);
    }
  } finally {
    if (previousLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousLcAll;
  }
});

test("WorkShellEngine detects locale from prompt-command focus instead of slash syntax", async () => {
  const previousLcAll = process.env.LC_ALL;
  try {
    process.env.LC_ALL = "ko_KR.UTF-8";
    const { engine, calls } = createEngine({
      resolveWorkShellSlashCommand(input) {
        return input.startsWith("/review") ? ["prompt", "review", ...input.split(/\s+/u).slice(1)] : undefined;
      },
    });
    await engine.initialize();

    await engine.handleSubmit("/review Handle the authentication flow");
    assert.equal(engine.getState().uiLocale, "en");
    assert.equal(engine.getState().uiLocaleLocked, true);
    assert.match(calls.turns[0], /^Respond in English for this session/u);
  } finally {
    if (previousLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousLcAll;
  }
});

test("WorkShellEngine keeps bridge bookkeeping and unproven memory out of the transcript", async () => {
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
  assert.equal(engine.getState().traceLines.some((line) => line.startsWith("memory ")), false);
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
  {"id": "task-1", "summary": "Read the files", "prompt": "Read src/index.ts", "goal": "Fix auth", "constraints": ["No dependencies"], "acceptanceCriteria": ["Relevant code is understood"], "dependsOn": [], "writePaths": []},
  {"id": "task-2", "summary": "Fix the bug", "prompt": "Fix the null check in auth.ts", "goal": "Fix auth", "constraints": ["No dependencies"], "acceptanceCriteria": ["Auth tests pass"], "dependsOn": ["task-1"], "writePaths": ["auth.ts"]}
]`;
  const tasks = parseAgentPlanResponse(validJson);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.id, "task-1");
  assert.equal(tasks[1]?.summary, "Fix the bug");

  assert.deepEqual(parseAgentPlanResponse("no json here"), []);
  assert.deepEqual(parseAgentPlanResponse("[invalid json"), []);
  assert.deepEqual(parseAgentPlanResponse('["not objects"]'), []);
});

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createAgentConsoleEngine(overrides = {}) {
  const control = { steer: [], cancel: [], continued: [], cleared: [] };
  const runtime = {
    async steer(agentRunId, message) {
      control.steer.push({ agentRunId, message });
      return { status: "accepted", message: "Steer queued." };
    },
    async cancel(agentRunId) {
      control.cancel.push(agentRunId);
      return { status: "accepted", message: "Cancelling." };
    },
    async continueRun(source, message) {
      control.continued.push({ source, message });
      return { status: "accepted", message: "Continuation started." };
    },
    clear(reason) {
      control.cleared.push(reason);
    },
  };
  const { calls, input } = createEngineInput(overrides);
  if (overrides.agentControlRuntime !== false) {
    input.agent = { ...input.agent, getAgentControlRuntime: () => runtime };
  }
  delete input.agentControlRuntime;
  const engine = new WorkShellEngine(input);
  return {
    engine,
    calls,
    control,
    emitTrace(event) {
      return calls.traceListener?.(event);
    },
  };
}

/**
 * Stands a run up with the job that owns it. Ownership is strict: a run can
 * only start against a job that was queued first, so the fixture queues that
 * job in the same burst and names it on the run.
 */
function emitRunStarted(emitTrace, runId, extra = {}) {
  const startedAt = extra.startedAt ?? 20;
  const jobId = extra.jobId ?? `${runId}-job`;
  emitTrace({
    type: "job.queued",
    jobId,
    jobType: "executor",
    label: `Work for ${runId}`,
    queuedAt: startedAt,
  });
  emitTrace({
    type: "agent.run.started",
    runId,
    jobId,
    displayName: `Executor ${runId}`,
    agentType: "executor",
    startedAt,
    ...extra,
  });
}

/** Settles a run with the exact job `emitRunStarted` gave it. */
function emitRunSettled(emitTrace, runId, extra = {}) {
  emitTrace({
    type: "agent.run.settled",
    runId,
    jobId: `${runId}-job`,
    status: "completed",
    completedAt: 40,
    ...extra,
  });
}

test("WorkShellEngine opens and closes the agent console without touching the console snapshot", async () => {
  const { engine } = createAgentConsoleEngine();
  await engine.initialize();

  const snapshotBefore = engine.getState().agentConsole;
  engine.openAgentConsole("jobs");

  assert.equal(engine.getState().agentConsole, snapshotBefore);
  assert.equal(engine.getState().agentConsoleView.open, true);
  assert.equal(engine.getState().agentConsoleView.tab, "jobs");
  assert.equal(engine.getState().agentConsoleView.cursor, 0);

  engine.selectAgentConsoleTab("plan");
  assert.equal(engine.getState().agentConsoleView.tab, "plan");
  const inspectorVisible = engine.getState().agentConsoleView.inspectorVisible;
  engine.toggleAgentConsoleInspector();
  assert.equal(engine.getState().agentConsoleView.inspectorVisible, !inspectorVisible);

  engine.closeAgentConsole();
  assert.equal(engine.getState().agentConsoleView.open, false);
  assert.equal(engine.getState().agentConsole, snapshotBefore);
});

test("WorkShellEngine refuses a steer for a missing, settled, or empty target before reaching the runtime", async () => {
  const { engine, control, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  emitRunStarted(emitTrace, "run-1");
  emitRunSettled(emitTrace, "run-1", { summary: "Executor completed." });
  emitRunStarted(emitTrace, "run-live", { startedAt: 50 });

  const port = engine.getAgentControlPort();
  assert.equal((await port.steer("run-missing", "focus")).status, "rejected");
  assert.equal((await port.steer("run-1", "focus")).status, "rejected");
  assert.equal((await port.steer("run-live", "   ")).status, "rejected");
  assert.deepEqual(control.steer, []);

  engine.openAgentConsole("agents");
  engine.beginAgentSteer();
  assert.equal(engine.getState().composerMode, "default");
  assert.equal(engine.getState().agentConsoleView.receipt?.status, "rejected");
  assert.deepEqual(control.steer, []);
});

test("WorkShellEngine reports agent controls as undelivered when the agent exposes no runtime", async () => {
  const { engine, calls, emitTrace } = createAgentConsoleEngine({ agentControlRuntime: false });
  await engine.initialize();

  emitRunStarted(emitTrace, "run-1");
  const receipt = await engine.getAgentControlPort().steer("run-1", "focus");

  assert.equal(receipt.status, "not_delivered");
  assert.deepEqual(calls.turns, []);
});

test("WorkShellEngine delivers a trimmed steer as control input and leaves the steer composer", async () => {
  const { engine, calls, control, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  emitRunStarted(emitTrace, "run-1");
  engine.openAgentConsole("agents");
  engine.beginAgentSteer();
  assert.equal(engine.getState().composerMode, "agent-steer");

  await engine.handleSubmit("   narrow the diff   ");

  assert.deepEqual(control.steer, [{ agentRunId: "run-1", message: "narrow the diff" }]);
  assert.equal(engine.getState().composerMode, "default");
  assert.deepEqual(engine.getState().agentConsoleView.receipt, {
    status: "accepted",
    message: "Steer queued.",
  });
  // A steer submit is control input: it never opens a provider turn or a chat entry.
  assert.deepEqual(calls.turns, []);
  assert.equal(engine.getState().entries.some((entry) => entry.text.includes("narrow the diff")), false);
});

test("WorkShellEngine binds a steer draft to the run selected when composition begins", async () => {
  const { engine, calls, control, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  emitRunStarted(emitTrace, "run-a");
  emitRunStarted(emitTrace, "run-b", { startedAt: 50 });
  engine.openAgentConsole("agents");
  engine.beginAgentSteer();
  assert.deepEqual(engine.getState().agentSteerTarget, {
    kind: "agent-steer",
    agentRunId: "run-a",
  });

  // The selected run settles while the operator is still composing. Even if
  // the cursor now points at run B, the stale draft must never retarget B.
  emitRunSettled(emitTrace, "run-a", { summary: "A completed." });
  engine.moveAgentConsoleCursor(1);
  await engine.handleSubmit("do not retarget this");

  assert.deepEqual(control.steer, []);
  assert.deepEqual(calls.turns, []);
  assert.equal(engine.getState().composerMode, "default");
  assert.equal(engine.getState().agentSteerTarget, undefined);
  assert.equal(engine.getState().agentConsoleView.receipt?.status, "rejected");
  assert.match(engine.getState().agentConsoleView.receipt?.message ?? "", /run-a|finished/i);
});

test("WorkShellEngine cancels a selected run exactly once and only after confirmation", async () => {
  const { engine, control, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  emitRunStarted(emitTrace, "run-1");
  engine.openAgentConsole("agents");

  engine.requestAgentCancel();
  assert.deepEqual(engine.getState().agentConsoleView.control, {
    kind: "confirm-cancel",
    agentRunId: "run-1",
  });

  await engine.confirmAgentCancel(false);
  assert.deepEqual(control.cancel, []);
  assert.deepEqual(engine.getState().agentConsoleView.control, { kind: "browse" });

  engine.requestAgentCancel();
  await Promise.all([engine.confirmAgentCancel(true), engine.confirmAgentCancel(true)]);

  assert.deepEqual(control.cancel, ["run-1"]);
  assert.deepEqual(engine.getState().agentConsoleView.control, { kind: "browse" });
  assert.equal(engine.getState().agentConsoleView.receipt?.status, "accepted");
});

test("WorkShellEngine continues a selected run with the persisted safe console record", async () => {
  const { engine, control, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  emitRunStarted(emitTrace, "run-1");
  emitRunSettled(emitTrace, "run-1", { summary: "Executor completed." });
  engine.openAgentConsole("agents");

  await engine.continueSelectedAgent();

  assert.equal(control.continued.length, 1);
  assert.deepEqual(control.continued[0]?.source, engine.getState().agentConsole.agents[0]);
  assert.equal(control.continued[0]?.source.summary, "Executor completed.");
  assert.equal(control.continued[0]?.source.transcriptRef, undefined);
  assert.equal(engine.getState().agentConsoleView.receipt?.status, "accepted");
});

test("WorkShellEngine coalesces a lifecycle burst into one publication and one durable write", async () => {
  const { engine, calls, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  const publications = [];
  engine.subscribe((state) => publications.push(state.agentConsole));
  const snapshotsBefore = calls.snapshots.length;

  emitTrace({ type: "job.queued", jobId: "job-1", jobType: "executor", label: "Plan step", queuedAt: 10 });
  emitRunStarted(emitTrace, "run-1", { jobId: "job-1" });
  emitTrace({
    type: "agent.run.settled",
    runId: "run-1",
    status: "completed",
    completedAt: 40,
    jobId: "job-1",
    summary: "Executor completed.",
  });

  // Nothing is visible yet: the whole burst folded into the private pending
  // snapshot before any window elapsed.
  assert.equal(publications.length, 0);
  assert.equal(calls.snapshots.length, snapshotsBefore);

  // Longer than both coalescing windows; each trace event blocks on a Rust
  // decision call, so the windows cannot be probed individually by wall clock.
  await delay(200);

  assert.equal(publications.length, 1);
  const published = publications[0];
  // Every event in the burst reduced against its predecessor, in order.
  assert.equal(published.agents.length, 1);
  assert.equal(published.agents[0]?.status, "completed");
  assert.equal(published.jobs.length, 1);
  assert.equal(published.jobs[0]?.status, "completed");
  assert.equal(published.jobs[0]?.agentRunId, "run-1");
  assert.equal(published.jobs[0]?.startedAt, 20);

  assert.equal(calls.snapshots.length, snapshotsBefore + 1);
  assert.equal(calls.snapshots.at(-1)?.state, "idle");
  assert.equal(calls.snapshots.at(-1)?.agentConsole?.agents[0]?.status, "completed");

  engine.dispose();
});

test("WorkShellEngine persists a running console while agent or job work is still active", async () => {
  const { engine, calls, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  const snapshotsBefore = calls.snapshots.length;
  emitTrace({ type: "job.queued", jobId: "job-1", jobType: "executor", label: "Plan step", queuedAt: 10 });
  emitRunStarted(emitTrace, "run-1", { jobId: "job-1" });

  await delay(90);

  assert.equal(calls.snapshots.length, snapshotsBefore + 1);
  assert.equal(calls.snapshots.at(-1)?.state, "running");
  assert.equal(calls.snapshots.at(-1)?.agentConsole?.agents[0]?.status, "running");

  engine.dispose();
});

test("WorkShellEngine flushes the pending console snapshot on dispose and clears background runs", async () => {
  const { engine, calls, control, emitTrace } = createAgentConsoleEngine();
  await engine.initialize();

  const publications = [];
  engine.subscribe((state) => publications.push(state.agentConsole));
  const snapshotsBefore = calls.snapshots.length;

  emitTrace({ type: "job.queued", jobId: "job-1", jobType: "executor", label: "Plan step", queuedAt: 10 });
  emitRunStarted(emitTrace, "run-1", { jobId: "job-1" });
  assert.equal(publications.length, 0);

  engine.dispose();

  assert.equal(publications.length, 1);
  assert.equal(publications[0]?.agents[0]?.id, "run-1");
  assert.deepEqual(control.cleared, ["Work Shell closed."]);

  await delay(10);
  assert.equal(calls.snapshots.length, snapshotsBefore + 1);
  assert.equal(calls.snapshots.at(-1)?.state, "running");

  await delay(90);
  assert.equal(publications.length, 1);
  assert.equal(calls.snapshots.length, snapshotsBefore + 1);
});

test("WorkShellEngine keeps the console snapshot when a durable write fails and never leaks the failure text", async () => {
  const { engine, emitTrace } = createAgentConsoleEngine({
    async persistWorkShellSessionSnapshot() {
      throw new Error("ENOSPC: no space left on device, write '/tmp/.state/sessions/work.jsonl'");
    },
  });
  await engine.initialize();

  emitRunStarted(emitTrace, "run-1");
  await delay(90);

  assert.equal(engine.getState().agentConsole.agents.length, 1);
  assert.equal(engine.getState().agentConsole.agents[0]?.id, "run-1");
  assert.equal(
    engine.getState().entries.some((entry) => entry.text.includes("ENOSPC")),
    false,
  );

  await assert.rejects(engine.dispose(), /ENOSPC: no space left on device/u);
});

test("WorkShellEngine treats a cleared work turn as cancellation, not assistant output", async () => {
  const bridged = [];
  const memories = [];
  const recorded = [];
  const prompts = [];
  const { engine, calls } = createEngine({
    agent: {
      clear() {},
      updateRuntimeSettings() {},
      updateMode() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(stripWorkShellLanguageInstruction(prompt));
        return { text: "Work turn cancelled by the operator.", cancelled: true };
      },
    },
    async publishContextBridge({ summary }) {
      bridged.push(summary);
      return { bridgeId: "bridge-cancelled", line: summary };
    },
    async writeScopedMemory({ scope, summary }) {
      memories.push(summary);
      return { memoryId: `${scope}:${summary}` };
    },
    recordTurn(turn) {
      recorded.push(turn);
    },
  });

  await engine.initialize();
  await engine.handleSubmit("run the plan");

  assert.deepEqual(prompts, ["run the plan"]);
  const entries = engine.getState().entries;
  assert.equal(entries.some((entry) => entry.role === "assistant"), false);
  assert.ok(entries.some(
    (entry) => entry.role === "system" && entry.text.includes("Work turn cancelled by the operator."),
  ));
  assert.deepEqual(bridged, []);
  assert.deepEqual(memories, []);
  assert.deepEqual(recorded.map((turn) => turn.status), ["cancelled"]);
  assert.equal(engine.getState().isBusy, false);
  assert.equal(engine.getState().streamingAssistantText, undefined);
  assert.equal(calls.snapshots.at(-1)?.state, "idle");
});

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function emitToolStarted(emitTrace, toolCallId, extra = {}) {
  emitTrace({
    type: "tool.started",
    toolCallId,
    toolName: "read_file",
    input: { i: "Reading session state", path: "state.json" },
    startedAt: 30,
    ...extra,
  });
}

function emitToolCompleted(emitTrace, toolCallId, extra = {}) {
  emitTrace({
    type: "tool.completed",
    toolCallId,
    toolName: "read_file",
    status: "completed",
    startedAt: 30,
    completedAt: 40,
    durationMs: 10,
    ...extra,
  });
}

test("WorkShellEngine keeps a tool lifecycle burst out of the subscriber fan-out until the publish window", async () => {
  const { engine, emitTrace } = createAgentConsoleEngine({
    formatAgentTraceLine(event) {
      if (event.type === "tool.started") return "→ read state.json";
      if (event.type === "tool.completed") return `✓ read ${event.toolCallId}`;
      return "";
    },
  });
  await engine.initialize();

  const notifications = [];
  engine.subscribe((state) => notifications.push(state));

  emitRunStarted(emitTrace, "run-1", { jobId: "job-1" });
  emitToolStarted(emitTrace, "call-1", { agentRunId: "run-1", asyncJobId: "job-1" });
  emitToolCompleted(emitTrace, "call-1", { agentRunId: "run-1", asyncJobId: "job-1" });
  // The operator's own tool call rides the same burst. It is the only one of
  // the two whose line may move the shell's busy status or reach the
  // transcript, and it still has to wait for the publish window to do it.
  emitToolStarted(emitTrace, "call-main");
  emitToolCompleted(emitTrace, "call-main");
  emitTrace({
    type: "agent.run.settled",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    completedAt: 50,
    summary: "Executor completed.",
  });

  // Busy status and the tool trace entry are lifecycle effects too: none of
  // them may reach a subscriber before the publish window closes. The busy
  // line is the operator's own tool completion — the delegated run's
  // completion (call-1) never reaches the shell status.
  assert.equal(notifications.length, 0);
  assert.equal(engine.getState().busyStatus, "✓ read call-main");
  assert.equal(engine.getState().agentConsole.activity.length, 2);

  await delay(200);

  assert.equal(notifications.length, 1);
  const published = notifications[0];
  assert.equal(published.agentConsole.activity.length, 2);
  assert.equal(published.agentConsole.activity[0]?.status, "completed");
  assert.equal(published.agentConsole.activity[1]?.status, "completed");
  assert.equal(published.agentConsole.agents[0]?.status, "completed");
  assert.equal(published.agentConsole.agents[0]?.currentActivity, undefined);
  // Completed tools land as assembled detail entries (never as the raw
  // formatted one-liner), and only for the operator's own calls: a delegated
  // run's completion (call-1) never reaches the transcript at all.
  assert.ok(
    !published.entries.some((entry) => entry.text === "✓ read call-main"),
    "the formatted one-liner itself never lands in the transcript",
  );
  assert.ok(
    !published.entries.some((entry) => entry.text === "✓ read call-1"),
    "a delegated run's tool output belongs to the console, never to the transcript",
  );
  assert.equal(
    published.entries.filter((entry) => entry.text === "read\n10ms").length,
    1,
    "exactly one assembled tool detail entry lands — the operator's call, not the delegated twin",
  );
});

test("WorkShellEngine keeps executor-scoped turn traces off the main transcript and busy clock", async () => {
  const { engine, emitTrace } = createAgentConsoleEngine({
    formatAgentTraceLine(event) {
      if (event.type === "turn.started") return `thinking ${event.prompt}`;
      if (event.type === "turn.completed") return `done ${event.durationMs}`;
      return "";
    },
  });
  await engine.initialize();
  // Verbose is the strictest setting: every formatted line it sees becomes a
  // transcript entry, so nothing can hide behind a quiet formatter.
  await engine.handleSubmit("/verbose");
  assert.equal(engine.getState().traceMode, "verbose");

  const entriesBefore = engine.getState().entries.length;
  const scope = { agentRunId: "run-1", asyncJobId: "job-1" };

  emitRunStarted(emitTrace, "run-1", { jobId: "job-1" });
  emitTrace({
    type: "turn.started",
    provider: "openai",
    model: "gpt-5.4",
    prompt: "map the runtime",
    startedAt: 0,
    ...scope,
  });
  emitTrace({ type: "assistant.delta", delta: "executor thinking out loud", ...scope });
  emitTrace({ type: "turn.completed", durationMs: 12, ...scope });
  await delay(200);

  assert.equal(engine.getState().isBusy, false, "a delegated turn is not the operator's turn");
  assert.equal(engine.getState().busyStatus, undefined);
  assert.equal(engine.getState().currentTurnStartedAt, undefined);
  assert.equal(
    engine.getState().streamingAssistantText,
    undefined,
    "an executor never streams into the main transcript",
  );
  assert.deepEqual(engine.getState().traceLines, []);
  assert.deepEqual(
    engine.getState().liveTraceLines,
    [],
    "executor-scoped lines never reach the live dock feed either",
  );
  assert.deepEqual(
    engine.getState().entries.slice(entriesBefore).map((entry) => entry.text),
    [],
    "no executor-scoped line may reach the operator's transcript",
  );
  // Scoping decides who owns a trace, not whether the console spine reduces
  // it: the run and its job are still there.
  assert.equal(engine.getState().agentConsole.agents[0]?.id, "run-1");
  assert.equal(engine.getState().agentConsole.jobs[0]?.agentRunId, "run-1");

  // The skip is scoped, not a blanket mute: the operator's own turn still
  // drives the shell exactly as it did before.
  emitTrace({
    type: "turn.started",
    provider: "openai",
    model: "gpt-5.4",
    prompt: "inspect repo",
    startedAt: 0,
  });
  await delay(200);

  assert.match(engine.getState().busyStatus ?? "", /thinking/i);
  assert.doesNotMatch(
    engine.getState().busyStatus ?? "",
    /map the runtime/,
    "the delegated prompt never reaches the operator's status line",
  );
  assert.ok(engine.getState().traceLines.some((line) => /thinking inspect repo/.test(line)));
  assert.ok(
    engine.getState().liveTraceLines.some((line) => /thinking inspect repo/.test(line)),
    "the operator's own turn feeds the live dock buffer",
  );
});

test("WorkShellEngine reduces lifecycle events from the newest decision and manifest state", async () => {
  const interactionBridge = createWorkShellInteractionBridge();
  const { engine, emitTrace } = createAgentConsoleEngine({
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

  emitToolStarted(emitTrace, "call-1");

  const answer = interactionBridge.ask({
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

  // The next lifecycle event must reduce from the newest mixed state, not from
  // the pending snapshot captured before the decision opened.
  emitToolCompleted(emitTrace, "call-1");
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-1");
  assert.equal(engine.getState().agentConsole.activity[0]?.status, "completed");

  await delay(200);
  assert.equal(engine.getState().agentConsole.pendingDecision?.id, "decision-1");
  assert.equal(engine.getState().agentConsole.activity[0]?.status, "completed");

  await engine.handleSubmit("2");
  assert.deepEqual(await answer, {
    status: "answered",
    answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
  });
  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);

  // A settled decision must not be resurrected by a later lifecycle reduction.
  emitRunStarted(emitTrace, "run-late", { startedAt: 60 });
  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
  assert.equal(engine.getState().agentConsole.agents[0]?.id, "run-late");
  await delay(200);
  assert.equal(engine.getState().agentConsole.pendingDecision, undefined);
});

test("WorkShellEngine serializes checkpoint writes so an older snapshot cannot overwrite a newer one", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  // A console lifecycle write ("running") starts first and stays in flight.
  emitRunStarted(emitTrace, "run-1");
  await waitFor(() => writes.length === 2, "the console lifecycle checkpoint");
  assert.equal(writes[1]?.snapshot.state, "running");

  // A newer turn write is requested while the older one is unresolved.
  const modePersist = engine.setMode("analyze");
  await delay(60);
  assert.equal(writes.length, 2);

  writes[1].resolve();
  await waitFor(() => writes.length === 3, "the queued mode checkpoint");
  assert.equal(writes[2]?.snapshot.state, "idle");
  writes[2].resolve();
  await modePersist;

  // Durable order matches request order, so the newer idle state wins.
  assert.deepEqual(writes.map((write) => write.snapshot.state), ["idle", "running", "idle"]);

  // A failed write must not wedge the queue.
  const failing = engine.setMode("search");
  await waitFor(() => writes.length === 4, "the failing checkpoint");
  writes[3].reject(new Error("ENOSPC: no space left on device"));
  await failing;

  const recovered = engine.setMode("default");
  await waitFor(() => writes.length === 5, "the checkpoint after a failure");
  writes[4].resolve();
  await recovered;
  assert.equal(writes[4]?.snapshot.mode, "default");
  assert.equal(
    engine.getState().entries.some((entry) => entry.text.includes("ENOSPC")),
    false,
  );
  // Dispose flushes the still-pending console write through the same queue.
  emitRunStarted(emitTrace, "run-2", { startedAt: 70 });
  engine.dispose();
  await waitFor(() => writes.length === 6, "the dispose flush checkpoint");
  assert.equal(writes[5]?.snapshot.state, "running");
  assert.equal(writes[5]?.snapshot.agentConsole?.agents.length, 2);
  writes[5].resolve();
});

test("WorkShellEngine coalesces queued checkpoints to the latest pending snapshot", async () => {
  const writes = [];
  const { engine } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  const first = engine.setMode("analyze");
  await waitFor(() => writes.length === 2, "the first mode checkpoint");
  const pending = Array.from({ length: 256 }, (_, index) => engine.enqueueSessionSnapshotWrite({
    ...writes[1].snapshot,
    mode: index === 255 ? "default" : index % 2 === 0 ? "search" : "analyze",
  }));
  await delay(20);
  assert.equal(writes.length, 2, "256 pending snapshots stay coalesced behind the active write");

  writes[1].resolve();
  await waitFor(() => writes.length === 3, "the latest coalesced checkpoint");
  assert.equal(writes[2].snapshot.mode, "default");
  writes[2].resolve();
  await Promise.all([first, ...pending]);
  assert.equal(writes.length, 3);
  await engine.dispose();
});

test("WorkShellEngine dispose is awaitable through its final console checkpoint", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-final-write");
  let disposed = false;
  const disposal = engine.dispose().then(() => { disposed = true; });
  await waitFor(() => writes.length === 2, "the dispose checkpoint");
  await delay(10);
  assert.equal(disposed, false);
  assert.equal(writes[1].snapshot.agentConsole?.agents[0]?.id, "run-final-write");

  writes[1].resolve();
  await disposal;
  assert.equal(disposed, true);
});

test("WorkShellEngine dispose rejects when its final console checkpoint cannot be written", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-failed-final-write");
  const disposal = engine.dispose();
  assert.equal(engine.dispose(), disposal, "dispose remains idempotent while the flush is pending");
  await waitFor(() => writes.length === 2, "the dispose checkpoint");
  writes[1].reject(new Error("ENOSPC: no space left on device"));

  await assert.rejects(disposal, /ENOSPC: no space left on device/u);
});

test("WorkShellEngine dispose observes a background console checkpoint already in flight", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-background-final-write");
  await waitFor(() => writes.length === 2, "the timer-fired background checkpoint");
  const disposal = engine.dispose();
  assert.equal(engine.dispose(), disposal, "dispose remains idempotent after the timer fires");
  writes[1].reject(new Error("ENOSPC: background checkpoint failed"));

  await assert.rejects(disposal, /ENOSPC: background checkpoint failed/u);
});

test("WorkShellEngine dispose rejects an unsuperseded background failure that already settled", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-settled-failed-write");
  await waitFor(() => writes.length === 2, "the timer-fired background checkpoint");
  writes[1].reject(new Error("ENOSPC: settled background checkpoint failed"));
  await delay(0);

  const disposal = engine.dispose();
  assert.equal(engine.dispose(), disposal, "dispose remains idempotent after failure settlement");
  await assert.rejects(disposal, /ENOSPC: settled background checkpoint failed/u);
});

test("WorkShellEngine successful checkpoint supersedes a settled background failure", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-superseded-failed-write");
  await waitFor(() => writes.length === 2, "the timer-fired background checkpoint");
  writes[1].reject(new Error("ENOSPC: superseded background checkpoint failed"));
  await delay(0);

  const modePersist = engine.setMode("analyze");
  await waitFor(() => writes.length === 3, "the successful superseding checkpoint");
  writes[2].resolve();
  await modePersist;

  const disposal = engine.dispose();
  assert.equal(engine.dispose(), disposal, "dispose remains idempotent after supersession");
  await disposal;
});

test("WorkShellEngine shutdown flushes pending console timers before awaiting durable writes", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-shutdown-write");
  let shutdownSettled = false;
  const shutdown = engine.shutdown({ timeoutMs: 1_000 }).then((result) => {
    shutdownSettled = true;
    return result;
  });
  await waitFor(() => writes.length === 2, "the shutdown checkpoint");
  await delay(10);
  assert.equal(shutdownSettled, false);
  assert.equal(writes[1].snapshot.agentConsole?.agents[0]?.id, "run-shutdown-write");

  writes[1].resolve();
  assert.equal(await shutdown, true);
});

test("WorkShellEngine shutdown reports a failed final durable write", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-failed-shutdown-write");
  const shutdown = engine.shutdown({ timeoutMs: 1_000 });
  await waitFor(() => writes.length === 2, "the shutdown checkpoint");
  writes[1].reject(new Error("ENOSPC: no space left on device"));

  await assert.rejects(shutdown, /ENOSPC: no space left on device/u);
});

test("WorkShellEngine shutdown reports an unsuperseded background failure that already settled", async () => {
  const writes = [];
  const { engine, emitTrace } = createAgentConsoleEngine({
    persistWorkShellSessionSnapshot(snapshot) {
      return new Promise((resolve, reject) => {
        writes.push({ snapshot, resolve, reject });
      });
    },
  });

  const initializing = engine.initialize();
  await waitFor(() => writes.length === 1, "the initialize checkpoint");
  writes[0].resolve();
  await initializing;

  emitRunStarted(emitTrace, "run-settled-shutdown-failure");
  await waitFor(() => writes.length === 2, "the timer-fired background checkpoint");
  writes[1].reject(new Error("ENOSPC: settled shutdown checkpoint failed"));
  await delay(0);

  await assert.rejects(
    engine.shutdown({ timeoutMs: 1_000 }),
    /ENOSPC: settled shutdown checkpoint failed/u,
  );
});

// ---------------------------------------------------------------------------
// Context Desk — "Pure Yazi" three-pane redesign (Groups → Sources → Preview).
// ---------------------------------------------------------------------------

// The groups pane walks the desk collections in CONTEXT_DESK_GROUPS descriptor
// order and closes with the DELIVERY block. Empty collections stay navigable so
// the pane and the rendered rows never disagree about which rows exist.
const CONTEXT_DESK_COLLECTION_WALK = [
  "all",
  "guidance",
  "conversation",
  "memory",
  "tools",
  "attachments",
  "other",
  "sent",
  "held",
];

function createContextDeskPacket() {
  return {
    id: "packet-context-desk",
    version: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "guidance-agents",
        category: "workspace",
        label: "AGENTS.md",
        reason: "repo instructions loaded",
        preview: "Keep diffs small.",
        tokenEstimate: 12,
        includedInModel: true,
      },
      {
        id: "conversation-history",
        category: "condensed-history",
        label: "Condensed history",
        reason: "earlier turns summarized",
        preview: "Three turns condensed.",
        tokenEstimate: 20,
        includedInModel: true,
      },
      {
        id: "memory-note",
        category: "memory",
        label: "Project memory",
        reason: "scoped memory recalled",
        preview: "Prefer narrow diffs.",
        tokenEstimate: 8,
        includedInModel: true,
      },
      {
        id: "tools-runtime",
        category: "runtime",
        label: "Runtime probe",
        reason: "live runtime state",
        preview: "Runtime is idle.",
        tokenEstimate: 6,
        includedInModel: true,
      },
      {
        id: "attachments-image",
        category: "attachment",
        label: "screenshot.png",
        reason: "attached this turn",
        preview: "Image attached.",
        tokenEstimate: 30,
        includedInModel: true,
      },
    ],
    // Guidance spans both delivery stages: the collection must gather the sent
    // AGENTS.md row and this held-back prompt row together.
    excluded: [
      {
        id: "held-guidance-prompt",
        category: "provider-system-prompt",
        label: "Configured prompt",
        reason: "held back by policy",
        preview: "Prompt text stays local.",
        tokenEstimate: 22,
        includedInModel: false,
      },
    ],
    warnings: [],
    preview: [],
    sourceCounts: { included: 5, excluded: 1, warnings: 0 },
    tokenEstimate: 76,
  };
}

function createContextDeskEngine(overrides = {}) {
  const mutations = [];
  const packet = createContextDeskPacket();
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    mutateContextSource(action) {
      mutations.push(action);
      return undefined;
    },
    ...overrides,
  });

  return {
    engine,
    mutations,
    // Identity probe for the current selection. The pin key targets whatever
    // source the desk has selected, and this fixture never re-ranks (the
    // mutation is a no-op and the packet is static), so the recorded id names
    // the selection without moving it. `undefined` means nothing is selected.
    selectedSourceId: async () => {
      const before = mutations.length;
      await engine.toggleContextInspectorPin();
      return mutations.length > before ? mutations.at(-1)?.id : undefined;
    },
  };
}

test("WorkShellEngine /context opens the Context Desk on the sources pane with the all-sources collection", async () => {
  const { engine, mutations } = createContextDeskEngine();

  await engine.initialize();
  assert.equal(engine.getState().contextInspectorOpen, false);

  await engine.handleSubmit("/context");

  const opened = engine.getState();
  assert.equal(opened.contextInspectorOpen, true);
  assert.equal(opened.contextInspectorPane, "sources");
  assert.equal(opened.contextInspectorCollection, "all");
  assert.equal(opened.contextInspectorCursor, 0);
  assert.equal(opened.contextInspectorExpanded, null);

  // The default selection is the first source of the all-sources collection.
  await engine.toggleContextInspectorPin();
  assert.deepEqual(mutations, [{ kind: "pin", id: "guidance-agents" }]);
});

test("WorkShellEngine closing the Context Desk clears the open flag and reopening restores the default pane and collection", async () => {
  const { engine } = createContextDeskEngine();

  await engine.initialize();
  await engine.handleSubmit("/context");

  engine.moveContextInspectorPane(-1);
  engine.moveContextInspectorCursor(1);
  assert.equal(engine.getState().contextInspectorPane, "groups");
  assert.equal(engine.getState().contextInspectorCollection, "guidance");

  engine.closeOverlay();
  assert.equal(engine.getState().contextInspectorOpen, false);
  assert.equal(engine.getState().contextInspectorCursor, -1);
  assert.equal(engine.getState().contextInspectorExpanded, null);

  await engine.handleSubmit("/context");
  const reopened = engine.getState();
  assert.equal(reopened.contextInspectorOpen, true);
  assert.equal(reopened.contextInspectorPane, "sources");
  assert.equal(reopened.contextInspectorCollection, "all");
});

test("WorkShellEngine closes the Context Desk when the operator submits a turn", async () => {
  const { engine } = createContextDeskEngine();

  await engine.initialize();
  await engine.handleSubmit("/context");
  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.equal(engine.getState().contextInspectorOpen, true);

  // A turn submit retires the desk, so it stops owning the keyboard once the
  // turn starts. (Builtin reloads keep the desk open — pinned separately
  // above; this ledger-less engine closes after packet preparation, which is
  // what keeps the previewed-packet reuse contract intact.)
  await engine.handleSubmit("ship the reviewed change");

  const submitted = engine.getState();
  assert.equal(submitted.panel.title, "Context");
  assert.equal(submitted.contextInspectorOpen, false);
  assert.equal(submitted.contextInspectorCursor, -1);
  assert.equal(submitted.contextInspectorExpanded, null);
});

test("WorkShellEngine retires the Context Desk before the ledger resolves the turn packet", async () => {
  let releaseResolve;
  const gate = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  const { engine, setResolveGate } = createLifecycleLedgerHarness();

  await engine.initialize();
  await engine.handleSubmit("/context");
  assert.equal(engine.getState().panel.title, "Context expanded");
  assert.equal(engine.getState().contextInspectorOpen, true);

  setResolveGate(() => gate);
  const turn = engine.handleSubmit("ship the reviewed change");

  // While packet resolution is still parked on the gate, the desk has already
  // left the screen: on ledger engines the submit retires it up front instead
  // of waiting out the prepare cycle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(engine.getState().panel.title, "Context");
  assert.equal(engine.getState().contextInspectorOpen, false);

  releaseResolve();
  await turn;
  assert.equal(engine.getState().contextInspectorOpen, false);
  assert.equal(engine.getState().contextInspectorCursor, -1);
});

test("WorkShellEngine Context Desk pane movement clamps at the groups and preview edges", async () => {
  const { engine } = createContextDeskEngine();

  await engine.initialize();
  await engine.handleSubmit("/context");

  const panes = [engine.getState().contextInspectorPane];
  for (const direction of [-1, -1, 1, 1, 1, 1]) {
    engine.moveContextInspectorPane(direction);
    panes.push(engine.getState().contextInspectorPane);
  }

  // Groups is the left edge and preview the right edge: neither wraps.
  assert.deepEqual(panes, [
    "sources",
    "groups",
    "groups",
    "sources",
    "preview",
    "preview",
    "preview",
  ]);
});

test("WorkShellEngine groups-pane movement walks every desk collection and reanchors the sources selection", async () => {
  const { engine, mutations, selectedSourceId } = createContextDeskEngine();

  await engine.initialize();
  await engine.handleSubmit("/context");
  engine.moveContextInspectorPane(-1);

  const walked = [engine.getState().contextInspectorCollection];
  for (let step = 1; step < CONTEXT_DESK_COLLECTION_WALK.length; step += 1) {
    engine.moveContextInspectorCursor(1);
    walked.push(engine.getState().contextInspectorCollection);
  }
  // `other` owns no fixture source, yet the groups pane still stops on it.
  assert.deepEqual(walked, CONTEXT_DESK_COLLECTION_WALK);

  for (let step = 1; step < CONTEXT_DESK_COLLECTION_WALK.length; step += 1) {
    engine.moveContextInspectorCursor(-1);
  }
  assert.equal(engine.getState().contextInspectorCollection, "all");

  // Selecting a group reanchors the sources pane on that group's first source.
  engine.moveContextInspectorCursor(1); // guidance
  engine.moveContextInspectorCursor(1); // conversation
  engine.moveContextInspectorCursor(1); // memory
  engine.moveContextInspectorCursor(1); // tools
  assert.equal(engine.getState().contextInspectorCollection, "tools");
  engine.moveContextInspectorPane(1);
  assert.equal(await selectedSourceId(), "tools-runtime");

  // An empty collection leaves nothing selected, so source keys do nothing.
  engine.moveContextInspectorPane(-1);
  engine.moveContextInspectorCursor(1); // attachments
  engine.moveContextInspectorCursor(1); // other
  assert.equal(engine.getState().contextInspectorCollection, "other");
  engine.moveContextInspectorPane(1);
  assert.equal(engine.getState().contextInspectorCursor, -1);
  assert.equal(await selectedSourceId(), undefined);

  // The delivery collections reanchor the same way as the group collections.
  engine.moveContextInspectorPane(-1);
  engine.moveContextInspectorCursor(1); // sent
  engine.moveContextInspectorCursor(1); // held
  assert.equal(engine.getState().contextInspectorCollection, "held");
  engine.moveContextInspectorPane(1);
  assert.equal(await selectedSourceId(), "held-guidance-prompt");

  assert.deepEqual(mutations.map((mutation) => mutation.id), [
    "tools-runtime",
    "held-guidance-prompt",
  ]);
});

test("WorkShellEngine sources-pane movement never leaves the active desk collection", async () => {
  const { engine, selectedSourceId } = createContextDeskEngine();

  await engine.initialize();
  await engine.handleSubmit("/context");

  engine.moveContextInspectorPane(-1);
  engine.moveContextInspectorCursor(1);
  assert.equal(engine.getState().contextInspectorCollection, "guidance");
  engine.moveContextInspectorPane(1);

  const visited = [await selectedSourceId()];
  for (const direction of [1, 1, 1, -1, -1]) {
    engine.moveContextInspectorCursor(direction);
    visited.push(await selectedSourceId());
  }

  assert.equal(visited.length, 6);
  assert.equal(visited[0], "guidance-agents");
  // Two members means the first move must actually move.
  assert.notEqual(visited[1], visited[0]);
  for (const id of visited) {
    assert.ok(
      id === "guidance-agents" || id === "held-guidance-prompt",
      `sources pane selected ${id}, which is outside the guidance collection`,
    );
  }
});

test("WorkShellEngine Context Desk page movement jumps to the active collection bounds", async () => {
  const { engine, selectedSourceId } = createContextDeskEngine();

  await engine.initialize();
  await engine.handleSubmit("/context");

  engine.moveContextInspectorPane(-1);
  engine.moveContextInspectorCursor(1);
  engine.moveContextInspectorPane(1);
  assert.equal(await selectedSourceId(), "guidance-agents");

  // A page is at least one row and paging clamps instead of wrapping, so a
  // page down inside the two-source guidance collection lands on its last row
  // and stays there; a page up returns to the first row and stays there.
  engine.moveContextInspectorPage(1);
  assert.equal(await selectedSourceId(), "held-guidance-prompt");
  engine.moveContextInspectorPage(1);
  assert.equal(await selectedSourceId(), "held-guidance-prompt");
  engine.moveContextInspectorPage(-1);
  assert.equal(await selectedSourceId(), "guidance-agents");
  engine.moveContextInspectorPage(-1);
  assert.equal(await selectedSourceId(), "guidance-agents");
});

test("WorkShellEngine Context Desk keys stay inert when the desk is closed behind a panel titled like the desk", async () => {
  const { engine, mutations } = createContextDeskEngine({
    // A collapsed context panel whose title collides with the desk overlay
    // title. Desk navigation must key off contextInspectorOpen, never off the
    // panel title alone.
    buildContextPanel() {
      return { title: "Context expanded", lines: ["Loaded guidance: AGENTS.md"] };
    },
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  engine.closeOverlay();

  const closed = engine.getState();
  assert.equal(closed.contextInspectorOpen, false);
  assert.equal(closed.panel.title, "Context expanded");
  assert.ok(closed.contextPacket, "the resolved packet stays cached after the desk closes");
  assert.equal(closed.contextInspectorCursor, -1);

  const paneBeforeKeys = closed.contextInspectorPane;
  const collectionBeforeKeys = closed.contextInspectorCollection;

  engine.moveContextInspectorCursor(1);
  engine.moveContextInspectorCursor(-1);
  assert.equal(engine.getState().contextInspectorCursor, -1);

  engine.moveContextInspectorPane(1);
  engine.moveContextInspectorPane(-1);
  engine.moveContextInspectorPage(1);
  engine.moveContextInspectorPage(-1);
  await engine.toggleContextInspectorPin();
  await engine.forgetContextSourceAtCursor();
  await engine.includeContextSourceAtCursor();
  await engine.toggleContextInspectorExpanded();

  const after = engine.getState();
  assert.equal(after.contextInspectorOpen, false);
  assert.equal(after.contextInspectorCursor, -1);
  assert.equal(after.contextInspectorPane, paneBeforeKeys);
  assert.equal(after.contextInspectorCollection, collectionBeforeKeys);
  assert.equal(after.contextInspectorExpanded, null);
  assert.deepEqual(mutations, []);
});

test("WorkShellEngine groups-pane reanchoring to a different source clears the previous expansion", async () => {
  const { engine, selectedSourceId } = createContextDeskEngine({
    resolveContextSourceDetail: async (sourceId) =>
      sourceId === "guidance-agents"
        ? "# AGENTS.md\nKeep diffs small.\nPrefer narrow changes."
        : undefined,
  });
  engine.updateTerminalRows(32);

  await engine.initialize();
  await engine.handleSubmit("/context");

  // Expand the all-collection anchor and scroll it, so both the expansion and
  // its local detail are demonstrably attached to that one source.
  await engine.toggleContextInspectorExpanded();
  const expandedSourceId = engine.getState().contextInspectorExpanded;
  assert.equal(expandedSourceId, "guidance-agents");
  assert.match(engine.getState().contextInspectorDetailContent ?? "", /Prefer narrow changes\./);
  engine.moveContextInspectorDetailOffset(1);
  assert.equal(engine.getState().contextInspectorDetailOffset, 1);

  // Walk the groups pane past `guidance` — which still owns the expanded row —
  // and stop on `conversation`, whose only member is a different source.
  engine.moveContextInspectorPane(-1);
  engine.moveContextInspectorCursor(1); // guidance
  engine.moveContextInspectorCursor(1); // conversation
  assert.equal(engine.getState().contextInspectorCollection, "conversation");
  engine.moveContextInspectorPane(1);

  // Snapshot before probing identity: the probe pins the selection, and the
  // continuity claim is about the state the reanchor itself left behind.
  const afterReanchor = engine.getState();
  assert.notEqual(await selectedSourceId(), expandedSourceId);
  assert.equal(await selectedSourceId(), "conversation-history");

  // PREVIEW must follow the newly selected source rather than keep rendering
  // the old one's expansion and scrolled detail.
  assert.equal(afterReanchor.contextInspectorExpanded, null);
  assert.equal(afterReanchor.contextInspectorDetailContent, undefined);
  assert.equal(afterReanchor.contextInspectorDetailOffset, 0);
});

test("WorkShellEngine preview-pane focus scrolls the ordinary selected preview without expanding the row", async () => {
  // The preview pane renders the selected row's own preview text whenever the
  // row is collapsed, and the desk footer advertises "↑↓ scroll" for exactly
  // that state. A preview long enough to overflow any plausible viewport makes
  // the scroll observable no matter how the offset is clamped.
  const base = createContextDeskPacket();
  const scrollablePreview = Array.from(
    { length: 24 },
    (_, line) => `AGENTS.md line ${line + 1}`,
  ).join("\n");
  const packet = {
    ...base,
    included: base.included.map((item, index) =>
      index === 0 ? { ...item, preview: scrollablePreview } : item
    ),
  };
  // No `resolveContextSourceDetail`: the pane must scroll on the packet's own
  // preview, without any resolved detail body to fall back on.
  const { engine, selectedSourceId } = createContextDeskEngine({
    resolveContextPacket: async () => packet,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");

  // An ordinary, unexpanded source is selected before focus reaches PREVIEW.
  assert.equal(engine.getState().contextInspectorPane, "sources");
  assert.equal(engine.getState().contextInspectorExpanded, null);
  assert.equal(await selectedSourceId(), "guidance-agents");
  assert.equal(engine.getState().contextInspectorCursor, 0);

  engine.moveContextInspectorPane(1);
  assert.equal(engine.getState().contextInspectorPane, "preview");

  engine.moveContextInspectorCursor(1);
  const afterLineDown = engine.getState();
  // The scroll belongs to the pane, not to an expansion: neither an expanded
  // id nor a resolved detail body may be required to make the body move.
  assert.equal(afterLineDown.contextInspectorExpanded, null);
  assert.equal(afterLineDown.contextInspectorDetailContent, undefined);
  assert.equal(afterLineDown.contextInspectorDetailOffset, 1);
  // Scrolling the preview never moves the sources selection.
  assert.equal(afterLineDown.contextInspectorCursor, 0);

  engine.moveContextInspectorCursor(-1);
  assert.equal(engine.getState().contextInspectorDetailOffset, 0);

  // A page is a block of rows, so a page down on a 24-line preview has to
  // travel further than the single-line key did.
  engine.moveContextInspectorPage(1);
  const afterPageDown = engine.getState();
  assert.equal(afterPageDown.contextInspectorExpanded, null);
  assert.ok(
    afterPageDown.contextInspectorDetailOffset > 1,
    `preview page down left the offset at ${afterPageDown.contextInspectorDetailOffset}`,
  );

  engine.moveContextInspectorPage(-1);
  assert.equal(engine.getState().contextInspectorDetailOffset, 0);
  assert.equal(engine.getState().contextInspectorCursor, 0);
});

/**
 * A desk whose delivery stage actually moves. Holding a row back drops it out
 * of the `sent` collection — which is what makes the filtered collection the
 * sharp case: the cursor cannot stay on the row it was pointing at, so any
 * state keyed to that row has to travel with it. `undo` puts the row back.
 */
function createDeliveryDeskEngine() {
  const base = createContextDeskPacket();
  const rows = [...base.included, ...base.excluded];
  const heldIds = new Set(["held-guidance-prompt"]);
  const mutations = [];
  let lastDeliveryMutation;
  let revision = 0;

  const buildPacket = () => {
    revision += 1;
    const included = rows
      .filter((item) => !heldIds.has(item.id))
      .map((item) => ({ ...item, includedInModel: true }));
    const excluded = rows
      .filter((item) => heldIds.has(item.id))
      .map((item) => ({ ...item, includedInModel: false }));
    return {
      ...base,
      id: `packet-delivery-${revision}`,
      included,
      excluded,
      sourceCounts: { included: included.length, excluded: excluded.length, warnings: 0 },
    };
  };

  const { engine } = createEngine({
    resolveContextPacket: async () => buildPacket(),
    resolveContextSourceDetail: async (sourceId) =>
      [`# ${sourceId}`, ...Array.from({ length: 6 }, (_, line) => `${sourceId} body ${line + 1}`)]
        .join("\n"),
    mutateContextSource(action) {
      mutations.push(action);
      if (action.kind === "forget") {
        heldIds.add(action.id);
        lastDeliveryMutation = action;
      }
      if (action.kind === "include") {
        heldIds.delete(action.id);
        lastDeliveryMutation = action;
      }
      return {
        id: `receipt-${mutations.length}`,
        action: action.kind === "forget" ? "hold-back" : action.kind,
        sourceId: action.id,
        sourceLabel: action.id,
        message: `${action.kind} ${action.id}`,
        canUndo: true,
        succeeded: true,
      };
    },
    undoContextSourceAction() {
      const undone = lastDeliveryMutation;
      if (undone === undefined) {
        return undefined;
      }
      if (undone.kind === "forget") {
        heldIds.delete(undone.id);
      } else {
        heldIds.add(undone.id);
      }
      lastDeliveryMutation = undefined;
      return {
        id: "receipt-delivery-undo",
        action: "undo",
        sourceId: undone.id,
        sourceLabel: undone.id,
        message: `undid ${undone.kind} ${undone.id}`,
        canUndo: false,
        succeeded: true,
      };
    },
  });

  return {
    engine,
    mutations,
    // Same identity probe the other desk tests use: pin targets the selected
    // row, and pinning never re-ranks this fixture, so the recorded id names
    // the selection without moving it.
    selectedSourceId: async () => {
      const before = mutations.length;
      await engine.toggleContextInspectorPin();
      return mutations.length > before ? mutations.at(-1)?.id : undefined;
    },
    // Focus the DELIVERY `sent` collection through the groups pane and hand
    // focus back to the sources pane on its first row.
    focusSentCollection: () => {
      engine.moveContextInspectorPane(-1);
      for (
        let step = 0;
        step < CONTEXT_DESK_COLLECTION_WALK.length
          && engine.getState().contextInspectorCollection !== "sent";
        step += 1
      ) {
        engine.moveContextInspectorCursor(1);
      }
      engine.moveContextInspectorPane(1);
    },
  };
}

test("WorkShellEngine holding back the selected row in a filtered collection clears the expansion the cursor no longer targets", async () => {
  const { engine, selectedSourceId, focusSentCollection } = createDeliveryDeskEngine();
  engine.updateTerminalRows(32);

  await engine.initialize();
  await engine.handleSubmit("/context");
  focusSentCollection();
  assert.equal(engine.getState().contextInspectorCollection, "sent");

  // Expand and scroll the first sent row, so both the expansion and its local
  // offset are demonstrably attached to that one source.
  await engine.toggleContextInspectorExpanded();
  const expandedSourceId = engine.getState().contextInspectorExpanded;
  assert.equal(expandedSourceId, "guidance-agents");
  assert.match(engine.getState().contextInspectorDetailContent ?? "", /guidance-agents body 1/);
  engine.moveContextInspectorDetailOffset(1);
  assert.equal(engine.getState().contextInspectorDetailOffset, 1);

  // Space on a sent row holds it back, which drops it out of `sent` entirely.
  await engine.forgetContextSourceAtCursor();

  // Snapshot before probing identity: the probe pins the selection, and the
  // claim is about the state the mutation itself left behind.
  const afterHold = engine.getState();
  assert.equal(afterHold.contextInspectorCollection, "sent");
  assert.equal(
    engine.getState().contextPacket?.excluded.some((item) => item.id === expandedSourceId),
    true,
    "the held-back row must actually leave the sent collection",
  );
  assert.notEqual(await selectedSourceId(), expandedSourceId);
  assert.equal(await selectedSourceId(), "conversation-history");

  // The cursor now targets a different row, so PREVIEW must not keep rendering
  // the departed row's body at the departed row's scroll offset.
  assert.equal(afterHold.contextInspectorExpanded, null);
  assert.equal(afterHold.contextInspectorDetailContent, undefined);
  assert.equal(afterHold.contextInspectorDetailOffset, 0);
});

test("WorkShellEngine undoing a hold-back clears the expansion the restored cursor no longer targets", async () => {
  const { engine, selectedSourceId, focusSentCollection } = createDeliveryDeskEngine();
  engine.updateTerminalRows(32);

  await engine.initialize();
  await engine.handleSubmit("/context");
  focusSentCollection();
  assert.equal(engine.getState().contextInspectorCollection, "sent");

  // Hold back the first sent row with nothing expanded; the cursor reanchors
  // onto the row that took its place.
  await engine.forgetContextSourceAtCursor();
  assert.equal(engine.getState().contextActionReceipt?.canUndo, true);
  assert.equal(await selectedSourceId(), "conversation-history");

  // Expand and scroll the replacement row.
  await engine.toggleContextInspectorExpanded();
  const expandedSourceId = engine.getState().contextInspectorExpanded;
  assert.equal(expandedSourceId, "conversation-history");
  assert.match(engine.getState().contextInspectorDetailContent ?? "", /conversation-history body 1/);
  engine.moveContextInspectorDetailOffset(1);
  assert.equal(engine.getState().contextInspectorDetailOffset, 1);

  // Undo restores the held-back row, and the undo refresh remaps the cursor
  // back onto it — off the row that is still expanded.
  await engine.undoLastContextSourceAction();

  const afterUndo = engine.getState();
  assert.equal(afterUndo.contextActionReceipt?.action, "undo");
  assert.notEqual(await selectedSourceId(), expandedSourceId);
  assert.equal(await selectedSourceId(), "guidance-agents");

  assert.equal(afterUndo.contextInspectorExpanded, null);
  assert.equal(afterUndo.contextInspectorDetailContent, undefined);
  assert.equal(afterUndo.contextInspectorDetailOffset, 0);
});

test("WorkShellEngine page keys scroll the expanded detail instead of walking the sources cursor behind it", async () => {
  // Enter expands a row without leaving the sources pane, and the line keys
  // already hand the expanded row its own scroll from there. PgDn/PgUp are the
  // same gesture at page granularity, so they must page the open detail rather
  // than move a selection the user cannot currently see.
  const detailBody = [
    "# AGENTS.md",
    ...Array.from({ length: 23 }, (_, line) => `AGENTS.md body ${line + 1}`),
  ].join("\n");
  const { engine, selectedSourceId } = createContextDeskEngine({
    resolveContextSourceDetail: async (sourceId) =>
      sourceId === "guidance-agents" ? detailBody : undefined,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");

  const opened = engine.getState();
  assert.equal(opened.contextInspectorPane, "sources");
  assert.equal(opened.contextInspectorCursor, 0);
  // A page has to be able to move this cursor, otherwise the "cursor stays
  // put" claim below would hold for the wrong reason.
  assert.equal(
    (opened.contextPacket?.included.length ?? 0) + (opened.contextPacket?.excluded.length ?? 0),
    6,
    "the all-sources collection must be shorter than a page and longer than one row",
  );

  await engine.toggleContextInspectorExpanded();
  assert.equal(engine.getState().contextInspectorExpanded, "guidance-agents");
  assert.equal(engine.getState().contextInspectorDetailContent, detailBody);
  assert.equal(engine.getState().contextInspectorDetailOffset, 0);
  // The pane never moved: Enter expands in place, so PgDn arrives with focus
  // still nominally on `sources`.
  assert.equal(engine.getState().contextInspectorPane, "sources");

  engine.moveContextInspectorPage(1);
  const afterPageDown = engine.getState();
  assert.ok(
    afterPageDown.contextInspectorDetailOffset > 1,
    `page down left the expanded detail at offset ${afterPageDown.contextInspectorDetailOffset}`,
  );
  assert.equal(afterPageDown.contextInspectorCursor, 0);
  assert.equal(afterPageDown.contextInspectorExpanded, "guidance-agents");
  assert.equal(afterPageDown.contextInspectorDetailContent, detailBody);

  engine.moveContextInspectorPage(-1);
  const afterPageUp = engine.getState();
  assert.equal(afterPageUp.contextInspectorDetailOffset, 0);
  assert.equal(afterPageUp.contextInspectorCursor, 0);
  assert.equal(afterPageUp.contextInspectorExpanded, "guidance-agents");

  // The row under the open detail is still the row the detail belongs to.
  assert.equal(await selectedSourceId(), "guidance-agents");
});

test("WorkShellEngine page keys move the expanded detail by a page from wherever it is already scrolled", async () => {
  // Paging an open detail is relative motion, not a jump to a fixed anchor:
  // PgDn from a mid-body offset has to advance a page from *there*, and PgUp
  // has to give that same page back, clamping at the top rather than
  // underflowing. A body far longer than a page keeps the downward move off
  // the bottom clamp, so the observed delta names the page size itself.
  const detailBody = [
    "# AGENTS.md",
    ...Array.from({ length: 59 }, (_, line) => `AGENTS.md body ${line + 1}`),
  ].join("\n");
  const { engine, selectedSourceId } = createContextDeskEngine({
    resolveContextSourceDetail: async (sourceId) =>
      sourceId === "guidance-agents" ? detailBody : undefined,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");

  const opened = engine.getState();
  assert.equal(opened.contextInspectorPane, "sources");
  assert.equal(opened.contextInspectorCursor, 0);
  // A page must be able to walk this collection, otherwise "the cursor stayed
  // put" would hold for the wrong reason.
  assert.equal(
    (opened.contextPacket?.included.length ?? 0) + (opened.contextPacket?.excluded.length ?? 0),
    6,
    "the all-sources collection must be shorter than a page and longer than one row",
  );

  await engine.toggleContextInspectorExpanded();
  assert.equal(engine.getState().contextInspectorExpanded, "guidance-agents");
  assert.equal(engine.getState().contextInspectorDetailContent, detailBody);

  // Scroll the open detail to a known, non-zero starting offset with the line
  // key, which already belongs to the expansion. Enter never left `sources`,
  // so the page keys arrive with focus still nominally on the source list.
  const startOffset = 3;
  for (let line = 0; line < startOffset; line += 1) {
    engine.moveContextInspectorDetailOffset(1);
  }
  assert.equal(engine.getState().contextInspectorDetailOffset, startOffset);
  assert.equal(engine.getState().contextInspectorPane, "sources");

  engine.moveContextInspectorPage(1);
  const afterPageDown = engine.getState();
  const pageSize = afterPageDown.contextInspectorDetailOffset - startOffset;
  assert.ok(
    pageSize > 1,
    `page down from offset ${startOffset} left the expanded detail at `
      + `${afterPageDown.contextInspectorDetailOffset}`,
  );
  // The body is long enough that a page cannot have hit the bottom clamp.
  assert.ok(
    afterPageDown.contextInspectorDetailOffset < detailBody.split("\n").length - 1,
    "the fixture body must outrun a single page so the delta is a true page",
  );
  assert.equal(afterPageDown.contextInspectorCursor, 0);
  assert.equal(afterPageDown.contextInspectorExpanded, "guidance-agents");
  assert.equal(afterPageDown.contextInspectorDetailContent, detailBody);

  // PgUp is the same page in reverse: back to exactly where PgDn started.
  engine.moveContextInspectorPage(-1);
  const afterPageUp = engine.getState();
  assert.equal(afterPageUp.contextInspectorDetailOffset, startOffset);
  assert.equal(afterPageUp.contextInspectorCursor, 0);
  assert.equal(afterPageUp.contextInspectorExpanded, "guidance-agents");

  // A second PgUp has less than a page left above it, so it clamps at the top
  // of the body instead of running the offset negative.
  engine.moveContextInspectorPage(-1);
  const afterTopClamp = engine.getState();
  assert.equal(afterTopClamp.contextInspectorDetailOffset, Math.max(0, startOffset - pageSize));
  assert.equal(afterTopClamp.contextInspectorCursor, 0);
  assert.equal(afterTopClamp.contextInspectorExpanded, "guidance-agents");
  assert.equal(afterTopClamp.contextInspectorDetailContent, detailBody);

  // Every page key acted on the detail, never on the list hidden behind it.
  assert.equal(await selectedSourceId(), "guidance-agents");
});

/**
 * A desk parked on the unselected sentinel with rows underneath it.
 *
 * `/context` anchors the cursor on row 0, and every reanchor path clamps a
 * negative cursor back to 0, so the only way to observe the sentinel over a
 * *populated* collection is to reach it while the packet is empty — the
 * sources key clears the cursor to -1 when the active collection draws no
 * rows — and then let `/reload` re-resolve a populated packet. That reload is
 * the refresh that rewrites the packet without also rewriting the cursor,
 * which is the state a user lands in when context arrives while the desk is
 * already open and nothing is selected.
 */
async function createSentinelDeskEngine() {
  const populated = createContextDeskPacket();
  let packet = {
    ...populated,
    id: "packet-context-desk-empty",
    included: [],
    excluded: [],
    sourceCounts: { included: 0, excluded: 0, warnings: 0 },
    tokenEstimate: 0,
  };
  const harness = createContextDeskEngine({
    resolveContextPacket: async () => packet,
  });

  await harness.engine.initialize();
  await harness.engine.handleSubmit("/context");
  // An empty collection has no row to hold, so the sources key retires the
  // opening anchor to the sentinel instead of pointing past the last row.
  harness.engine.moveContextInspectorCursor(1);
  packet = populated;
  await harness.engine.handleSubmit("/reload");
  return harness;
}

test("WorkShellEngine desk sources keys resolve the unselected sentinel to the first row going down and the last row going up", async () => {
  const down = await createSentinelDeskEngine();

  const parked = down.engine.getState();
  assert.equal(parked.contextInspectorOpen, true);
  assert.equal(parked.contextInspectorPane, "sources");
  assert.equal(parked.contextInspectorCollection, "all");
  assert.equal(
    parked.contextInspectorCursor,
    -1,
    "the desk must be parked on the unselected sentinel for this claim to mean anything",
  );
  assert.equal(
    (parked.contextPacket?.included.length ?? 0) + (parked.contextPacket?.excluded.length ?? 0),
    6,
    "the active collection must be populated while the cursor is the sentinel",
  );
  // -1 is "nothing selected", not "row zero": no source key may act yet.
  assert.equal(await down.selectedSourceId(), undefined);

  // Down out of the sentinel enters the list at its first row. Treating -1 as
  // if it were already row 0 steps over that row and lands on the second.
  down.engine.moveContextInspectorCursor(1);
  assert.equal(down.engine.getState().contextInspectorCursor, 0);
  assert.equal(await down.selectedSourceId(), "guidance-agents");

  // Up out of the sentinel enters the list from the other end: the last row.
  const up = await createSentinelDeskEngine();
  assert.equal(up.engine.getState().contextInspectorCursor, -1);

  up.engine.moveContextInspectorCursor(-1);
  assert.equal(up.engine.getState().contextInspectorCursor, 5);
  assert.equal(await up.selectedSourceId(), "held-guidance-prompt");
});

/**
 * A group id this build does not recognise — the projection a packet can carry
 * across a broker version change, the same way `resolveContextDeskGroup`
 * already absorbs an unknown *category*. Within each delivery stage,
 * `CONTEXT_DESK_GROUPS` sorts an unknown group after every canonical group,
 * while `CONTEXT_DESK_COLLECTIONS` has no legacy collection for it.
 */
const LEGACY_DESK_GROUP = "legacy-broker-group";

/**
 * Packet rows in no useful order: two delivery stages interleaved across five
 * canonical desk groups, two rows sharing `guidance` so the packet-index
 * tiebreak stays observable, one row whose category is unknown (and therefore
 * resolves to `other`), and one row whose *group* is unknown.
 */
const SHUFFLED_DESK_ROWS = [
  { id: "sent-attachments-shot", stage: "sent", category: "attachment", deskGroup: "attachments" },
  { id: "held-tools-runtime", stage: "held", category: "runtime", deskGroup: "tools" },
  {
    id: "sent-legacy-broker",
    stage: "sent",
    category: "workspace-guidance",
    group: LEGACY_DESK_GROUP,
    deskGroup: LEGACY_DESK_GROUP,
  },
  { id: "sent-memory-note", stage: "sent", category: "memory", deskGroup: "memory" },
  {
    id: "held-guidance-prompt",
    stage: "held",
    category: "provider-system-prompt",
    deskGroup: "guidance",
  },
  { id: "sent-guidance-agents", stage: "sent", category: "workspace", deskGroup: "guidance" },
  { id: "sent-tools-trail", stage: "sent", category: "loop-trail", deskGroup: "tools" },
  { id: "held-conversation-bridge", stage: "held", category: "bridge", deskGroup: "conversation" },
  { id: "sent-conversation-user", stage: "sent", category: "user", deskGroup: "conversation" },
  { id: "sent-guidance-system", stage: "sent", category: "system", deskGroup: "guidance" },
  { id: "sent-other-telemetry", stage: "sent", category: "telemetry", deskGroup: "other" },
];

/**
 * The order the Sources pane draws, spelled out: every sent row before every
 * held row, then the `CONTEXT_DESK_GROUPS` descriptor order inside each stage
 * (guidance → conversation → memory → tools → attachments → other, with the
 * unrecognised group behind all of them), then packet index — which is what
 * keeps `sent-guidance-agents` ahead of `sent-guidance-system`.
 */
const SHUFFLED_DESK_WALK = [
  "sent-guidance-agents",
  "sent-guidance-system",
  "sent-conversation-user",
  "sent-memory-note",
  "sent-tools-trail",
  "sent-attachments-shot",
  "sent-other-telemetry",
  "sent-legacy-broker",
  "held-guidance-prompt",
  "held-conversation-bridge",
  "held-tools-runtime",
];

function createShuffledDeskPacket() {
  const toItem = (row) => ({
    id: row.id,
    category: row.category,
    label: row.id,
    reason: "shuffled desk fixture row",
    preview: `Preview for ${row.id}.`,
    tokenEstimate: 4,
    includedInModel: row.stage === "sent",
    ...(row.group !== undefined ? { group: row.group } : {}),
  });
  const included = SHUFFLED_DESK_ROWS.filter((row) => row.stage === "sent").map(toItem);
  const excluded = SHUFFLED_DESK_ROWS.filter((row) => row.stage === "held").map(toItem);
  return {
    id: "packet-context-desk-shuffled",
    version: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    title: "Next answer context",
    included,
    excluded,
    warnings: [],
    preview: [],
    sourceCounts: { included: included.length, excluded: excluded.length, warnings: 0 },
    tokenEstimate: (included.length + excluded.length) * 4,
  };
}

test("WorkShellEngine desk source navigation orders shuffled packet rows stage-first and then by CONTEXT_DESK_GROUPS", async () => {
  const packet = createShuffledDeskPacket();
  const { engine, selectedSourceId } = createContextDeskEngine({
    resolveContextPacket: async () => packet,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  assert.equal(engine.getState().contextInspectorCollection, "all");
  assert.equal(engine.getState().contextInspectorCursor, 0);

  // Walking the all-sources collection one row at a time and naming the
  // selection at each stop is the navigable order the cursor indexes.
  const walk = [await selectedSourceId()];
  for (let step = 1; step < SHUFFLED_DESK_ROWS.length; step += 1) {
    engine.moveContextInspectorCursor(1);
    walk.push(await selectedSourceId());
  }
  assert.deepEqual(walk, SHUFFLED_DESK_WALK);

  const rowById = new Map(SHUFFLED_DESK_ROWS.map((row) => [row.id, row]));
  const stages = walk.map((id) => rowById.get(id)?.stage);
  assert.equal(stages.includes("sent") && stages.includes("held"), true);
  assert.ok(
    stages.lastIndexOf("sent") < stages.indexOf("held"),
    `held rows interleaved with sent rows: ${stages.join(" ")}`,
  );

  // The group runs are read back off the descriptor table rather than the
  // collection list, so the two cannot silently swap places: a run repeats
  // whenever a group is split, and an unrecognised group belongs at the end.
  const canonicalGroupIds = CONTEXT_DESK_GROUPS.map((group) => group.id);
  const observedGroupRun = (stage) => {
    const run = [];
    for (const id of walk) {
      const row = rowById.get(id);
      if (row?.stage !== stage) {
        continue;
      }
      if (run.at(-1) !== row.deskGroup) {
        run.push(row.deskGroup);
      }
    }
    return run;
  };
  const expectedGroupRun = (stage) => {
    const present = new Set(
      SHUFFLED_DESK_ROWS.filter((row) => row.stage === stage).map((row) => row.deskGroup),
    );
    return [
      ...canonicalGroupIds.filter((id) => present.has(id)),
      ...(present.has(LEGACY_DESK_GROUP) ? [LEGACY_DESK_GROUP] : []),
    ];
  };
  assert.deepEqual(observedGroupRun("sent"), expectedGroupRun("sent"));
  assert.deepEqual(observedGroupRun("held"), expectedGroupRun("held"));

  // Ranking a group the build does not know against CONTEXT_DESK_GROUPS places
  // it after every canonical group within its delivery stage.
  assert.equal(walk.indexOf("sent-legacy-broker"), walk.indexOf("sent-other-telemetry") + 1);
});

test("WorkShellEngine refresh reorders by source id and clears expansion when source disappears", async () => {
  const makeItem = (id) => ({
    id,
    category: "workspace",
    label: id,
    reason: "refresh identity",
    preview: `${id} preview`,
    tokenEstimate: 4,
    includedInModel: true,
  });
  let packet = {
    id: "packet-refresh-1",
    version: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    title: "Next answer context",
    included: [makeItem("alpha"), makeItem("beta")],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 2, excluded: 0, warnings: 0 },
    tokenEstimate: 8,
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    resolveContextSourceDetail: async (sourceId) => `detail:${sourceId}`,
  });

  const snapshot = () => {
    const state = engine.getState();
    const rows = [...(state.contextPacket?.included ?? []), ...(state.contextPacket?.excluded ?? [])];
    return {
      selectedId: rows[state.contextInspectorCursor]?.id,
      expandedId: state.contextInspectorExpanded,
      detail: state.contextInspectorDetailContent,
      offset: state.contextInspectorDetailOffset,
    };
  };

  await engine.initialize();
  await engine.handleSubmit("/context");
  await engine.toggleContextInspectorExpanded();
  const snapshots = [snapshot()];

  packet = {
    ...packet,
    id: "packet-refresh-2",
    included: [makeItem("beta"), makeItem("alpha")],
  };
  await engine.handleSubmit("/reload");
  snapshots.push(snapshot());

  packet = {
    ...packet,
    id: "packet-refresh-3",
    included: [makeItem("beta")],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 4,
  };
  await engine.handleSubmit("/reload");
  snapshots.push(snapshot());

  assert.deepEqual(snapshots, [
    { selectedId: "alpha", expandedId: "alpha", detail: "detail:alpha", offset: 0 },
    { selectedId: "alpha", expandedId: "alpha", detail: "detail:alpha", offset: 0 },
    { selectedId: "beta", expandedId: null, detail: undefined, offset: 0 },
  ]);
});

test("WorkShellEngine serializes deferred rapid pin toggles before Undo", async () => {
  let pinned = false;
  let lastMutation;
  let packetRevision = 0;
  const mutations = [];
  const undoCalls = [];
  const pendingResolvers = [];
  const makePacket = () => ({
    id: `packet-pin-${++packetRevision}`,
    version: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    title: "Next answer context",
    included: [{
      id: "alpha",
      category: "workspace",
      label: "Alpha",
      reason: "pin identity",
      preview: "Alpha preview",
      tokenEstimate: 4,
      salience: pinned ? 1 : 0.5,
      includedInModel: true,
      actions: ["pin", "unpin", "preview"],
    }],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 4,
  });
  const { engine } = createEngine({
    resolveContextPacket: async () =>
      new Promise((resolve) => {
        pendingResolvers.push(() => resolve(makePacket()));
      }),
    mutateContextSource(action) {
      mutations.push(action);
      lastMutation = action;
      pinned = action.kind === "pin";
      return {
        id: `receipt-${mutations.length}`,
        action: action.kind,
        sourceId: action.id,
        sourceLabel: "Alpha",
        message: `${action.kind} Alpha`,
        canUndo: true,
        succeeded: true,
      };
    },
    undoContextSourceAction() {
      undoCalls.push("undo");
      pinned = lastMutation?.kind === "unpin";
      lastMutation = undefined;
      return {
        id: "receipt-undo",
        action: "undo",
        sourceId: "alpha",
        sourceLabel: "Alpha",
        message: "undo Alpha",
        canUndo: false,
        succeeded: true,
      };
    },
  });
  const release = () => pendingResolvers.shift()?.();

  const opening = engine.handleSubmit("/context");
  await Promise.resolve();
  release();
  await opening;

  const firstToggle = engine.toggleContextInspectorPin();
  await Promise.resolve();
  const secondToggle = engine.toggleContextInspectorPin();
  await Promise.resolve();
  release();
  await firstToggle;
  await Promise.resolve();
  release();
  await secondToggle;

  const undo = engine.undoLastContextSourceAction();
  await Promise.resolve();
  release();
  await undo;

  assert.deepEqual(mutations, [
    { kind: "pin", id: "alpha" },
    { kind: "unpin", id: "alpha" },
  ]);
  assert.deepEqual(undoCalls, ["undo"]);
  assert.equal(engine.getState().contextActionReceipt?.action, "undo");
  assert.equal(engine.getState().contextPacket?.included[0]?.salience, 1);
});

test("WorkShellEngine expands only omitted or preview-capable desk rows", async () => {
  const makeItem = (id, actions) => ({
    id,
    category: "workspace",
    label: id,
    reason: "preview capability",
    preview: `${id} preview`,
    tokenEstimate: 4,
    includedInModel: true,
    ...(actions === undefined ? {} : { actions }),
  });
  const packet = {
    id: "packet-capabilities",
    version: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    title: "Next answer context",
    included: [
      makeItem("explicit", ["pin"]),
      makeItem("omitted"),
      makeItem("preview", ["preview"]),
    ],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 3, excluded: 0, warnings: 0 },
    tokenEstimate: 12,
  };
  const { engine } = createEngine({
    resolveContextPacket: async () => packet,
    resolveContextSourceDetail: async (sourceId) => `detail:${sourceId}`,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  const observations = [];
  await engine.toggleContextInspectorExpanded();
  observations.push({
    expandedId: engine.getState().contextInspectorExpanded,
    detail: engine.getState().contextInspectorDetailContent,
  });
  engine.moveContextInspectorCursor(1);
  await engine.toggleContextInspectorExpanded();
  observations.push({
    expandedId: engine.getState().contextInspectorExpanded,
    detail: engine.getState().contextInspectorDetailContent,
  });
  engine.moveContextInspectorCursor(1);
  await engine.toggleContextInspectorExpanded();
  observations.push({
    expandedId: engine.getState().contextInspectorExpanded,
    detail: engine.getState().contextInspectorDetailContent,
  });

  assert.deepEqual(observations, [
    { expandedId: null, detail: undefined },
    { expandedId: "omitted", detail: "detail:omitted" },
    { expandedId: "preview", detail: "detail:preview" },
  ]);
});

test("WorkShellEngine scrolls a long one-line preview in the preview pane", async () => {
  const base = createContextDeskPacket();
  const packet = {
    ...base,
    included: base.included.map((item, index) =>
      index === 0 ? { ...item, preview: "long preview ".repeat(80).trim() } : item
    ),
  };
  const { engine } = createContextDeskEngine({
    resolveContextPacket: async () => packet,
  });

  await engine.initialize();
  await engine.handleSubmit("/context");
  engine.moveContextInspectorPane(1);
  engine.moveContextInspectorCursor(1);

  assert.equal(engine.getState().contextInspectorExpanded, null);
  assert.equal(engine.getState().contextInspectorDetailOffset, 1);
});

test("WorkShellEngine leaves an unsupported accepted suggestion proposed without mutating its source", async () => {
  const base = createLifecyclePacket();
  const packet = createLifecyclePacket({
    included: [{
      ...base.included[0],
      id: "preview-only-source",
      label: "preview-only.md",
      actions: ["preview"],
    }],
  });
  const mutations = [];
  const resolutions = [];
  let generatedSuggestion;
  const { engine } = createLifecycleLedgerHarness({
    packet,
    engineOverrides: {
      async generateContextSuggestions({ receipt }) {
        generatedSuggestion = {
          id: "suggestion-preview-only-hold-back",
          packetReceiptId: receipt.id,
          sourceId: "preview-only-source",
          action: "hold-back",
          reasonCode: "low-trust-token-hotspot",
          reasonText: "Hold back a source that is oversized.",
          status: "proposed",
          createdAt: "2026-08-11T00:00:01.000Z",
        };
        return [generatedSuggestion];
      },
      resolveContextSuggestion(id, status) {
        resolutions.push({ id, status });
        return { ...generatedSuggestion, id, status, resolvedAt: "2026-08-11T00:00:02.000Z" };
      },
      mutateContextSource(action) {
        mutations.push(action);
        return {
          id: "mutation-preview-only",
          action: "hold-back",
          sourceId: action.id,
          sourceLabel: "preview-only.md",
          message: "Held back preview-only.md",
          canUndo: true,
          succeeded: true,
        };
      },
    },
  });

  await engine.initialize();
  await engine.handleSubmit("accept unsupported advice");
  const before = engine.getState();
  assert.equal(before.contextPolicySuggestions[0]?.status, "proposed");
  assert.equal(before.contextActionReceipt, undefined);

  await engine.acceptContextSuggestion("suggestion-preview-only-hold-back");

  const after = engine.getState();
  assert.deepEqual(mutations, []);
  assert.deepEqual(resolutions, []);
  assert.equal(after.contextActionReceipt, before.contextActionReceipt);
  assert.equal(after.contextPolicySuggestions[0]?.status, "proposed");
  assert.equal(
    after.contextAdviceUnavailable,
    "This suggestion is not available for the selected source.",
  );
  assert.equal(after.contextPacket?.included[0]?.id, "preview-only-source");
  assert.equal(after.contextPacket?.included[0]?.includedInModel, true);
});

test("WorkShellEngine bounds long preview scrolling by wrapped rows at a finite terminal width", async () => {
  const base = createContextDeskPacket();
  const preview = "long preview ".repeat(80).trim();
  const packet = {
    ...base,
    included: base.included.map((item, index) =>
      index === 0 ? { ...item, preview, actions: ["preview"] } : item
    ),
  };
  const { engine } = createContextDeskEngine({
    resolveContextPacket: async () => packet,
  });
  const terminalColumns = 28;
  const rendererMinimumWidth = 24;
  const previewWrapWidth = Math.max(rendererMinimumWidth, terminalColumns - 4);

  engine.updateTerminalColumns(terminalColumns);
  await engine.initialize();
  await engine.handleSubmit("/context");
  engine.moveContextInspectorPane(1);
  assert.equal(engine.getState().contextInspectorPane, "preview");

  for (let operation = 0; operation < 12; operation += 1) {
    engine.moveContextInspectorCursor(1);
    engine.moveContextInspectorPage(1);
  }

  const saturatedOffset = engine.getState().contextInspectorDetailOffset;
  const wrappedRowCeiling = wrapDisplayTextFast(preview, previewWrapWidth).length - 1;
  assert.ok(saturatedOffset > 0, "the long preview must actually scroll");
  assert.ok(
    saturatedOffset <= wrappedRowCeiling,
    `preview offset ${saturatedOffset} exceeded ${wrappedRowCeiling} wrapped rows`,
  );

  engine.moveContextInspectorCursor(-1);
  assert.equal(
    engine.getState().contextInspectorDetailOffset,
    saturatedOffset - 1,
    "one Up must immediately move the visible preview range back by one row",
  );
});
const DETAIL_SCROLL_TERMINAL_ROWS = 40;
const DETAIL_SCROLL_PALETTE = {
  assistant: "cyan",
  borderDefault: "gray",
  borderSoft: "gray",
  spinner: "yellow",
  success: "green",
  text: "white",
  textDim: "gray",
  textMuted: "gray",
  toolAccent: "magenta",
  user: "blue",
  warning: "yellow",
};

function createMetadataHeavyDetailPacket() {
  const base = createContextDeskPacket();
  const item = {
    id: "expanded-condensed-history",
    category: "condensed-history",
    label: "Session history compact",
    reason: "compressed session history",
    preview: "History compressed by a recent-window summary.",
    tokenEstimate: 42,
    includedInModel: true,
    actions: ["pin", "preview"],
    metadata: {
      kind: "condensed-history",
      sourceEventIds: ["trace-a", "trace-b", "trace-c", "trace-d", "trace-e", "trace-f"],
      summary: (
        "Earlier trace lines were summarized while the recent runtime rows remain "
        + "available for inspection. ".repeat(3)
      ).trim(),
      recomputeReason: (
        "History exceeded the recent-window threshold and needs a fresh compacted view. "
        + "Reason context remains visible. ".repeat(2)
      ).trim(),
      compactedEventCount: 12,
      recentEventCount: 8,
      compression: {
        method: "recent-window",
        inputTokensEstimate: 30,
        outputTokensEstimate: 11,
      },
    },
  };
  return {
    ...base,
    id: "packet-expanded-condensed-history",
    included: [item],
    excluded: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: item.tokenEstimate,
  };
}

const DETAIL_SCROLL_LOCAL_CONTENT = Array.from(
  { length: 8 },
  (_, index) => (
    `local content row ${index + 1} carries rendered evidence `
    + "that stays available in the expanded detail. ".repeat(3)
  ),
).join("\n");

async function renderExpandedDetailFrame({
  packet,
  detailContent,
  terminalColumns,
  detailOffset,
  actionReceipt,
}) {
  const overlay = renderContextInspectorOverlay({
    packet,
    cursorIndex: 0,
    activePane: "sources",
    activeCollection: "all",
    expandedId: packet.included[0]?.id ?? null,
    detailContent,
    detailOffset,
    width: Math.max(32, terminalColumns - 4),
    borderColor: "gray",
    palette: DETAIL_SCROLL_PALETTE,
    modelWindow: 200_000,
    actionsEnabled: true,
    terminalRows: DETAIL_SCROLL_TERMINAL_ROWS,
    ...(actionReceipt ? { actionReceipt } : {}),
  });
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(React.Fragment, null, overlay),
    { columns: terminalColumns, rows: DETAIL_SCROLL_TERMINAL_ROWS },
  );
  try {
    await waitForSettledFrame(getOutput);
    return getOutput();
  } finally {
    instance.unmount();
    instance.cleanup();
  }
}

async function findRendererBottomOffset(input) {
  let high = 1;
  let frame = await renderExpandedDetailFrame({ ...input, detailOffset: high });
  let attempts = 0;
  while (frame.includes("lines below") && attempts < 12) {
    high *= 2;
    attempts += 1;
    frame = await renderExpandedDetailFrame({ ...input, detailOffset: high });
  }
  assert.doesNotMatch(
    frame,
    /lines below/,
    `renderer never reached a marker-free bottom within ${high} rows`,
  );

  let low = 0;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = await renderExpandedDetailFrame({ ...input, detailOffset: middle });
    if (candidate.includes("lines below")) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function moveDetailUntilStable(engine, move) {
  let previous = engine.getState().contextInspectorDetailOffset;
  for (let step = 0; step < 512; step += 1) {
    move();
    const current = engine.getState().contextInspectorDetailOffset;
    if (current === previous) {
      return current;
    }
    previous = current;
  }
  throw new Error("detail scroll did not reach a stable offset");
}

test("WorkShellEngine detail scrolling follows the renderer with and without action receipts at 52, 80, and 120 columns", async () => {
  const packet = createMetadataHeavyDetailPacket();
  const failures = [];

  for (const withActionReceipt of [false, true]) {
    for (const terminalColumns of [52, 80, 120]) {
      const { engine } = createContextDeskEngine({
        resolveContextPacket: async () => packet,
        resolveContextSourceDetail: async (sourceId) =>
          sourceId === packet.included[0]?.id ? DETAIL_SCROLL_LOCAL_CONTENT : undefined,
        mutateContextSource: withActionReceipt
          ? (action) => ({
            id: `receipt-${action.id}`,
            action: action.kind,
            sourceId: action.id,
            sourceLabel: action.id,
            message: `${action.kind} ${action.id}`,
            canUndo: true,
            succeeded: true,
          })
          : undefined,
      });
      engine.updateTerminalColumns(terminalColumns);
      engine.updateTerminalRows(DETAIL_SCROLL_TERMINAL_ROWS);
      await engine.initialize();
      await engine.handleSubmit("/context");
      if (withActionReceipt) {
        await engine.toggleContextInspectorPin();
        assert.equal(
          typeof engine.getState().contextActionReceipt?.sourceLabel,
          "string",
          JSON.stringify(engine.getState().contextActionReceipt),
        );
        assert.equal(
          typeof engine.getState().contextActionReceipt?.action,
          "string",
          JSON.stringify(engine.getState().contextActionReceipt),
        );
      }
      await engine.toggleContextInspectorExpanded();

      const renderInput = {
        packet,
        detailContent: DETAIL_SCROLL_LOCAL_CONTENT,
        terminalColumns,
        ...(engine.getState().contextActionReceipt
          ? { actionReceipt: engine.getState().contextActionReceipt }
          : {}),
      };
      const rendererBottomOffset = await findRendererBottomOffset(renderInput);
      const topFrame = await renderExpandedDetailFrame({ ...renderInput, detailOffset: 0 });
      if (topFrame.includes("lines above") || !topFrame.includes("lines below")) {
        failures.push(
          `${withActionReceipt ? "receipt" : "no receipt"} ${terminalColumns}: `
          + `renderer top marker state was ${JSON.stringify({
            above: topFrame.includes("lines above"),
            below: topFrame.includes("lines below"),
          })}`,
        );
      }

      const downOffset = moveDetailUntilStable(
        engine,
        () => engine.moveContextInspectorDetailOffset(1),
      );
      const downFrame = await renderExpandedDetailFrame({ ...renderInput, detailOffset: downOffset });
      if (downOffset !== rendererBottomOffset || downFrame.includes("lines below")) {
        failures.push(
          `${withActionReceipt ? "receipt" : "no receipt"} ${terminalColumns}: `
          + `Down reached engine offset ${downOffset}, `
          + `renderer bottom offset ${rendererBottomOffset}, `
          + `bottom marker ${downFrame.includes("lines below") ? "present" : "absent"}`,
        );
      }

      moveDetailUntilStable(engine, () => engine.moveContextInspectorDetailOffset(-1));
      const pageDownOffset = moveDetailUntilStable(
        engine,
        () => engine.moveContextInspectorPage(1),
      );
      const pageDownFrame = await renderExpandedDetailFrame({
        ...renderInput,
        detailOffset: pageDownOffset,
      });
      if (pageDownOffset !== rendererBottomOffset || pageDownFrame.includes("lines below")) {
        failures.push(
          `${withActionReceipt ? "receipt" : "no receipt"} ${terminalColumns}: `
          + `PageDown reached engine offset ${pageDownOffset}, `
          + `renderer bottom offset ${rendererBottomOffset}, `
          + `bottom marker ${pageDownFrame.includes("lines below") ? "present" : "absent"}`,
        );
      }

      moveDetailUntilStable(engine, () => engine.moveContextInspectorPage(-1));
      const afterPageUp = engine.getState().contextInspectorDetailOffset;
      engine.moveContextInspectorPage(-1);
      if (afterPageUp !== 0 || engine.getState().contextInspectorDetailOffset !== 0) {
        failures.push(
          `${withActionReceipt ? "receipt" : "no receipt"} ${terminalColumns}: `
          + `PageUp did not clamp detail offset at top `
          + `(first ${afterPageUp}, repeat ${engine.getState().contextInspectorDetailOffset})`,
        );
      }
    }
  }

  assert.deepEqual(failures, [], failures.join("\n"));
});