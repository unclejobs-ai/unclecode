import {
  createAuthKeyBuiltinResult,
  createClearBuiltinResult,
  createContextBuiltinResult,
  createHarnessBuiltinResult,
  createHelpBuiltinResult,
  createLoadedSkillBuiltinResult,
  buildWorkShellQueueBuiltinInput,
  createQueueBuiltinResult,
  type WorkShellQueueBuiltinInput,
  createReloadBuiltinResult,
  createSessionsBuiltinResult,
  createSkillLoadErrorEntries,
  createSkillsBuiltinResult,
  createSkillUsageErrorEntries,
  createStatusBuiltinResult,
  createToolsBuiltinResult,
  createTraceModeBuiltinResult,
  resolveModelBuiltinResult,
  resolveReasoningBuiltinResult,
} from "./work-shell-engine-builtins.js";
import { resolveWorkerBudget } from "./work-agent.js";
import {
  createWorkShellStatusPanel,
} from "./work-shell-engine-panels.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellLoadedSkill,
  WorkShellPanel,
  WorkShellSkillListItem,
  WorkShellTraceMode,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";
import type { WorkShellSubmitRoute } from "./work-shell-engine-submit.js";
import type { AgentConsoleTab, ContextPacketView } from "@unclecode/contracts";
import { createPermissionPolicyPanel, type CanonicalPermissionRule } from "./permission-scope.js";

type WorkShellBuiltinCommand = Extract<
  WorkShellSubmitRoute,
  { readonly kind: "builtin" }
>["command"];

type WorkShellBuiltinSubmitInput<Reasoning extends WorkShellReasoningConfig> = Parameters<
  typeof executeWorkShellBuiltinSubmit<Reasoning>
>[0];

function applyQueueBuiltinResult<Reasoning extends WorkShellReasoningConfig>(
  input: Pick<WorkShellBuiltinSubmitInput<Reasoning>, "appendEntries" | "setState">,
  payload: WorkShellQueueBuiltinInput,
): void {
  const result = createQueueBuiltinResult(payload);
  input.appendEntries(...result.entries);
  input.setState({ panel: result.panel });
}

function buildQueueBuiltinBase<Reasoning extends WorkShellReasoningConfig>(
  input: Pick<
    WorkShellBuiltinSubmitInput<Reasoning>,
    "line" | "state" | "currentContextSummaryLines" | "lastCompletedTurn"
  >,
) {
  const snapshotTurn = input.lastCompletedTurn?.();
  return {
    line: input.line,
    state: input.state,
    workerBudget: resolveWorkerBudget(input.state.mode),
    contextSummaryLines: input.currentContextSummaryLines,
    ...(snapshotTurn ? { lastCompletedTurn: snapshotTurn } : {}),
  };
}

export async function executeWorkShellBuiltinSubmit<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  builtinCommand: WorkShellBuiltinCommand;
  state: WorkShellEngineState<Reasoning>;
  options: WorkShellEngineOptions<Reasoning>;
  currentContextSummaryLines: readonly string[];
  buildHelpPanel: () => WorkShellPanel;
  buildContextPanel: (
    contextSummaryLines: readonly string[],
    bridgeLines: readonly string[],
    memoryLines: readonly string[],
    traceLines: readonly string[],
    expanded?: boolean,
  ) => WorkShellPanel;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
    statusContext?: {
      readonly contextSummaryLines: readonly string[];
      readonly bridgeLines: readonly string[];
      readonly memoryLines: readonly string[];
      readonly traceLines: readonly string[];
    },
  ) => WorkShellPanel;
  resolveReasoningCommand: (
    input: string,
    reasoning: Reasoning,
    modeDefault: Reasoning,
  ) => { nextReasoning: Reasoning; message: string };
  resolveModelCommand?: ((
    input: string,
    currentModel: string,
    currentReasoning: Reasoning,
    modeDefault: Reasoning,
  ) => {
    readonly nextModel: string;
    readonly nextReasoning: Reasoning;
    readonly message: string;
    readonly panel: WorkShellPanel;
  } | undefined) | undefined;
  modeDefaultReasoning: Reasoning;
  listAvailableSkills: (cwd: string) => Promise<readonly WorkShellSkillListItem[]>;
  loadNamedSkill: (name: string, cwd: string) => Promise<WorkShellLoadedSkill>;
  toolLines: readonly string[];
  listCanonicalPermissionRules?: (() => readonly CanonicalPermissionRule[]) | undefined;
  clearAgent: () => void;
  interruptTurn: () => void;
  updateRuntimeSettings: (settings: {
    reasoning?: Reasoning | undefined;
    model?: string | undefined;
  }) => void;
  onExit: () => void;
  openSessionsPanel: () => Promise<void>;
  openAgentConsole: (tab: AgentConsoleTab) => void;
  reloadContextState: () => Promise<void>;
  refreshContextPacket?: (() => Promise<ContextPacketView | undefined>) | undefined;
  queuedCount?: (() => number) | undefined;
  queuedItems?: (() => Promise<readonly {
    readonly id: number;
    readonly line: string;
    readonly attachmentCount?: number;
  }[]>) | undefined;
  clearQueuedItems?: (() => Promise<void>) | undefined;
  removeQueuedItem?: ((id: number) => Promise<boolean>) | undefined;
  moveQueuedItem?: ((id: number, direction: "up" | "down") => Promise<boolean>) | undefined;
  resumeQueuedItems?: (() => Promise<void>) | undefined;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  persistSessionSnapshot: (
    state: "running" | "idle" | "requires_action",
    summary: string,
    traceMode?: WorkShellTraceMode,
  ) => Promise<void>;
  lastSessionSummary: string;
  lastCompletedTurn?: (() => { readonly user: string; readonly assistant: string } | undefined) | undefined;
  clearLastCompletedTurn?: (() => void) | undefined;
}): Promise<void> {
  switch (input.builtinCommand.kind) {
    case "exit":
      input.onExit();
      return;
    case "clear":
      input.clearAgent();
      input.clearLastCompletedTurn?.();
      input.setState(createClearBuiltinResult(input.line).patch);
      return;
    case "cancel":
      input.interruptTurn();
      return;
    case "help": {
      const result = createHelpBuiltinResult(input.line, input.buildHelpPanel);
      input.appendEntries(...result.entries);
      input.setState({ panel: result.panel });
      return;
    }
    case "context": {
      const contextPacket = await input.refreshContextPacket?.();
      const activeContextPacket = contextPacket ?? input.state.contextPacket;
      const result = createContextBuiltinResult({
        line: input.line,
        contextSummaryLines: input.currentContextSummaryLines,
        state: input.state,
        contextPacket: activeContextPacket,
        buildContextPanel: input.buildContextPanel,
      });
      // Context Inspector redesign: /context is an inspector, not a chat
      // turn. It must NOT pollute the conversation history with
      // `user: /context` + `system: Context opened` entries. Only the
      // panel state changes (opens the overlay). See
      // docs/design/context-inspector-redesign.md §A.
      input.setState({
        panel: result.panel,
        contextInspectorCursor: activeContextPacket ? 0 : -1,
        contextInspectorExpanded: null,
        contextInspectorDetailContent: undefined,
        contextInspectorDetailOffset: 0,
      });
      return;
    }
    case "cache":
      input.setState({ panel: { title: "Cache Telemetry", lines: [] } });
      return;
    // The console is an inspector, not a chat turn: it opens the view and
    // leaves the transcript untouched, exactly like /context.
    case "agent-console":
      input.openAgentConsole(input.builtinCommand.tab);
      return;
    case "reload":
      {
        const result = createReloadBuiltinResult(input.line);
        input.appendEntries(...result.startEntries);
        await input.reloadContextState();
        input.appendEntries(result.completeEntry);
      }
      return;
    case "status": {
      const result = createStatusBuiltinResult({
        line: input.line,
        options: input.options,
        stateModel: input.state.model,
        reasoning: input.state.reasoning,
        authLabel: input.state.authLabel,
        statusContext: {
          contextSummaryLines: input.currentContextSummaryLines,
          bridgeLines: input.state.bridgeLines,
          memoryLines: input.state.memoryLines,
          traceLines: input.state.traceLines,
        },
        isBusy: input.state.isBusy,
        ...(input.state.busyStatus ? { busyStatus: input.state.busyStatus } : {}),
        ...(input.state.currentTurnStartedAt !== undefined
          ? { currentTurnStartedAt: input.state.currentTurnStartedAt }
          : {}),
        ...(input.state.lastTurnDurationMs !== undefined
          ? { lastTurnDurationMs: input.state.lastTurnDurationMs }
          : {}),
        nowMs: Date.now(),
        buildStatusPanel: (reasoning, authLabel, statusContext) =>
          createWorkShellStatusPanel({
            options: input.options,
            stateModel: input.state.model,
            reasoning,
            authLabel,
            statusContext,
            buildStatusPanel: input.buildStatusPanel,
          }),
      });
      input.appendEntries(...result.entries);
      input.setState({ panel: result.panel });
      return;
    }
    case "trace-mode": {
      const result = createTraceModeBuiltinResult({
        line: input.line,
        traceMode: input.builtinCommand.traceMode,
        state: input.state,
        contextSummaryLines: input.currentContextSummaryLines,
        buildContextPanel: input.buildContextPanel,
      });
      input.appendEntries(...result.entries);
      input.setState(result.patch);
      await input.persistSessionSnapshot("idle", input.lastSessionSummary, input.builtinCommand.traceMode).catch(() => undefined);
      return;
    }
    case "sessions":
      input.appendEntries(...createSessionsBuiltinResult(input.line).entries);
      await input.openSessionsPanel();
      return;
    case "reasoning": {
      const result = resolveReasoningBuiltinResult({
        line: input.line,
        options: input.options,
        stateModel: input.state.model,
        currentReasoning: input.state.reasoning,
        modeDefaultReasoning: input.modeDefaultReasoning,
        authLabel: input.state.authLabel,
        statusContext: {
          contextSummaryLines: input.currentContextSummaryLines,
          bridgeLines: input.state.bridgeLines,
          memoryLines: input.state.memoryLines,
          traceLines: input.state.traceLines,
        },
        buildStatusPanel: (reasoning, authLabel) => createWorkShellStatusPanel({
          options: input.options,
          stateModel: input.state.model,
          reasoning,
          authLabel,
          statusContext: {
            contextSummaryLines: input.currentContextSummaryLines,
            bridgeLines: input.state.bridgeLines,
            memoryLines: input.state.memoryLines,
            traceLines: input.state.traceLines,
          },
          buildStatusPanel: input.buildStatusPanel,
        }),
      });
      input.updateRuntimeSettings({ reasoning: result.nextReasoning });
      input.appendEntries(...result.entries);
      input.setState({
        reasoning: result.nextReasoning,
        panel: result.panel,
      });
      return;
    }
    case "model": {
      const result = resolveModelBuiltinResult({
        line: input.line,
        provider: input.options.provider,
        currentModel: input.state.model,
        currentReasoning: input.state.reasoning,
        modeDefaultReasoning: input.modeDefaultReasoning,
      });
      if (result.shouldUpdateRuntime) {
        input.updateRuntimeSettings({ model: result.nextModel, reasoning: result.nextReasoning });
      }
      const panel = result.shouldUpdateRuntime
        ? createWorkShellStatusPanel({
            options: input.options,
            stateModel: result.nextModel,
            reasoning: result.nextReasoning,
            authLabel: input.state.authLabel,
            statusContext: {
              contextSummaryLines: input.currentContextSummaryLines,
              bridgeLines: input.state.bridgeLines,
              memoryLines: input.state.memoryLines,
              traceLines: input.state.traceLines,
            },
            buildStatusPanel: input.buildStatusPanel,
          })
        : result.panel;
      input.appendEntries(...result.entries);
      input.setState({
        model: result.nextModel,
        reasoning: result.nextReasoning,
        panel,
      });
      await input.persistSessionSnapshot("idle", input.lastSessionSummary).catch(() => undefined);
      return;
    }
    case "tools":
      input.appendEntries(...createToolsBuiltinResult(input.line, input.toolLines));
      return;
    case "policy":
      input.setState({
        panel: createPermissionPolicyPanel(input.listCanonicalPermissionRules?.() ?? []),
      });
      return;
    case "queue": {
      const queuedItems = input.queuedItems ? await input.queuedItems() : undefined;
      applyQueueBuiltinResult(input, buildWorkShellQueueBuiltinInput({
        ...buildQueueBuiltinBase(input),
        ...(input.queuedCount ? { queuedCount: input.queuedCount() } : {}),
        ...(queuedItems ? { queuedItems } : {}),
      }));
      return;
    }
    case "queue-clear": {
      await input.clearQueuedItems?.();
      const queuedItems = input.queuedItems ? await input.queuedItems() : undefined;
      applyQueueBuiltinResult(input, buildWorkShellQueueBuiltinInput({
        ...buildQueueBuiltinBase(input),
        ...(input.queuedCount ? { queuedCount: input.queuedCount() } : {}),
        ...(queuedItems ? { queuedItems } : {}),
        transcriptText: input.state.isBusy
          ? "Queue cleared. Active turn is still running."
          : "Queue cleared.",
      }));
      return;
    }
    case "queue-remove": {
      const removed = await input.removeQueuedItem?.(input.builtinCommand.id) ?? false;
      const queuedItems = input.queuedItems ? await input.queuedItems() : undefined;
      applyQueueBuiltinResult(input, buildWorkShellQueueBuiltinInput({
        ...buildQueueBuiltinBase(input),
        ...(input.queuedCount ? { queuedCount: input.queuedCount() } : {}),
        ...(queuedItems ? { queuedItems } : {}),
        transcriptText: removed
          ? `Removed queued follow-up id ${input.builtinCommand.id}.`
          : `Queued follow-up id ${input.builtinCommand.id} was not found.`,
      }));
      return;
    }
    case "queue-move": {
      const moved = await input.moveQueuedItem?.(
        input.builtinCommand.id,
        input.builtinCommand.direction,
      ) ?? false;
      const queuedItems = input.queuedItems ? await input.queuedItems() : undefined;
      applyQueueBuiltinResult(input, buildWorkShellQueueBuiltinInput({
        ...buildQueueBuiltinBase(input),
        ...(input.queuedCount ? { queuedCount: input.queuedCount() } : {}),
        ...(queuedItems ? { queuedItems } : {}),
        transcriptText: moved
          ? `Moved queued follow-up id ${input.builtinCommand.id} ${input.builtinCommand.direction}.`
          : `Queued follow-up id ${input.builtinCommand.id} cannot move ${input.builtinCommand.direction}.`,
      }));
      return;
    }
    case "queue-resume": {
      await input.resumeQueuedItems?.();
      const queuedItems = input.queuedItems ? await input.queuedItems() : undefined;
      const base = buildQueueBuiltinBase(input);
      applyQueueBuiltinResult(input, buildWorkShellQueueBuiltinInput({
        ...base,
        state: { ...base.state, queuePaused: false },
        ...(input.queuedCount ? { queuedCount: input.queuedCount() } : {}),
        ...(queuedItems ? { queuedItems } : {}),
        transcriptText: "Queue resumed. Follow-ups will run in order.",
      }));
      return;
    }
    case "harness": {
      const result = createHarnessBuiltinResult({
        line: input.line,
        mode: input.state.mode,
        workerBudget: resolveWorkerBudget(input.state.mode),
        autoContinue: true,
      });
      input.appendEntries(...result.entries);
      input.setState({ panel: result.panel });
      return;
    }
    case "auth-key": {
      const result = createAuthKeyBuiltinResult(input.line);
      input.appendEntries(...result.entries);
      input.setState({
        composerMode: result.composerMode,
        panel: result.panel,
      });
      return;
    }
    case "unknown-slash": {
      // Rust marked this line as a console-like form that can never run: a
      // half-typed `/tod`, or `/agents extra`. There is nothing to execute and
      // nothing worth narrating, so the transcript and the panel stay as they
      // were. Ordinary unknown commands keep their guidance below.
      if (input.builtinCommand.consoleInvalid) {
        return;
      }
      const suggestion = input.builtinCommand.suggestion;
      const commandToken = input.builtinCommand.line.trim().split(/\s+/, 1)[0] ?? input.builtinCommand.line;
      const message = suggestion
        ? `Unknown command ${commandToken}. Did you mean ${suggestion}?`
        : `Unknown command ${commandToken}. Type / for commands.`;
      input.appendEntries(
        { role: "user", text: commandToken },
        { role: "system", text: message },
      );
      input.setState({
        panel: {
          title: "Command",
          lines: suggestion
            ? [message, `Run ${suggestion} or type / for commands.`]
            : [message],
        },
      });
      return;
    }
    case "skills": {
      const skills = await input.listAvailableSkills(input.options.cwd);
      const result = createSkillsBuiltinResult(input.line, skills);
      input.appendEntries(...result.entries);
      input.setState({ panel: result.panel });
      return;
    }
    case "skill": {
      if (!input.builtinCommand.skillName) {
        input.appendEntries(...createSkillUsageErrorEntries(input.line));
        return;
      }

      try {
        const skill = await input.loadNamedSkill(input.builtinCommand.skillName, input.options.cwd);
        const result = createLoadedSkillBuiltinResult(input.line, skill);
        input.appendEntries(...result.entries);
        input.setState({ panel: result.panel });
      } catch (error) {
        input.appendEntries(...createSkillLoadErrorEntries(input.line, error));
      }
      return;
    }
  }
}
