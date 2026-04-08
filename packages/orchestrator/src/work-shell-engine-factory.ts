import { describeReasoning, type WorkShellReasoningConfig } from "./reasoning.js";
import {
  WorkShellEngine,
  type WorkShellAgent,
  type WorkShellComposerResolution,
  type WorkShellEngineInput,
  type WorkShellEngineOptions,
  type WorkShellLoadedSkill,
  type WorkShellMemoryScope,
  type WorkShellPanel,
  type WorkShellSkillListItem,
} from "./work-shell-engine.js";

export type CreateWorkShellEngineInput<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
> = Omit<
  WorkShellEngineInput<Attachment, Reasoning, TraceEvent>,
  "buildStatusPanel" | "resolveWorkShellSlashCommand" | "refineInlineCommandResultLines"
> & {
  readonly buildStatusPanel: (input: {
    readonly options: WorkShellEngineOptions<Reasoning>;
    readonly reasoning: Reasoning;
    readonly authLabel: string;
    readonly reasoningLabel: string;
  }) => WorkShellPanel;
  readonly resolveWorkShellSlashCommand: (
    input: string,
    options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string },
  ) => readonly string[] | undefined;
  readonly refineInlineCommandResultLines?: ((input: {
    readonly args: readonly string[];
    readonly lines: readonly string[];
    readonly failed: boolean;
    readonly authLabel: string;
    readonly browserOAuthAvailable: boolean;
  }) => readonly string[]) | undefined;
  readonly userHomeDir?: string | undefined;
  readonly browserOAuthAvailable?: boolean | undefined;
};

export function createWorkShellEngine<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
>(
  input: CreateWorkShellEngineInput<Attachment, Reasoning, TraceEvent>,
): WorkShellEngine<Attachment, Reasoning, TraceEvent> {
  return new WorkShellEngine<Attachment, Reasoning, TraceEvent>({
    agent: input.agent as WorkShellAgent<Attachment, TraceEvent, Reasoning>,
    options: {
      ...input.options,
      autoContinueOnPermissionStall:
        input.options.autoContinueOnPermissionStall ?? true,
    },
    buildContextPanel: input.buildContextPanel,
    buildHelpPanel: input.buildHelpPanel,
    buildStatusPanel: (options, reasoning, authLabel) =>
      input.buildStatusPanel({
        options,
        reasoning,
        authLabel,
        reasoningLabel: describeReasoning(reasoning),
      }),
    buildInlineCommandPanel: input.buildInlineCommandPanel,
    formatInlineCommandResultSummary: input.formatInlineCommandResultSummary,
    formatAgentTraceLine: input.formatAgentTraceLine,
    formatWorkShellError: input.formatWorkShellError,
    listProjectBridgeLines: input.listProjectBridgeLines,
    listScopedMemoryLines: input.listScopedMemoryLines as (input: {
      scope: WorkShellMemoryScope;
      cwd: string;
      sessionId?: string;
      agentId?: string;
    }) => Promise<readonly string[]>,
    listSessionLines: input.listSessionLines,
    persistWorkShellSessionSnapshot: input.persistWorkShellSessionSnapshot,
    resolveReasoningCommand: input.resolveReasoningCommand,
    ...(input.resolveModelCommand
      ? { resolveModelCommand: input.resolveModelCommand }
      : {}),
    resolveWorkShellSlashCommand: (value) =>
      input.resolveWorkShellSlashCommand(value, {
        workspaceRoot: input.options.cwd,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
      }),
    resolveWorkShellInlineCommand: input.resolveWorkShellInlineCommand,
    ...(input.refreshAuthState
      ? { refreshAuthState: input.refreshAuthState }
      : {}),
    ...(input.runInlineCommand
      ? { runInlineCommand: input.runInlineCommand }
      : {}),
    ...(input.saveApiKeyAuth
      ? { saveApiKeyAuth: input.saveApiKeyAuth }
      : {}),
    resolveComposerInput: input.resolveComposerInput as (
      value: string,
      cwd: string,
    ) => Promise<WorkShellComposerResolution<Attachment>>,
    ...(input.refineInlineCommandResultLines
      ? {
          refineInlineCommandResultLines: ({ args, lines, failed, authLabel }: {
            readonly args: readonly string[];
            readonly lines: readonly string[];
            readonly failed: boolean;
            readonly authLabel: string;
          }) =>
            input.refineInlineCommandResultLines?.({
              args,
              lines,
              failed,
              authLabel,
              browserOAuthAvailable: Boolean(input.browserOAuthAvailable),
            }) ?? lines,
        }
      : {}),
    publishContextBridge: input.publishContextBridge,
    writeScopedMemory: input.writeScopedMemory,
    ...(input.listAvailableSkills
      ? {
          listAvailableSkills: input.listAvailableSkills as (
            cwd: string,
          ) => Promise<readonly WorkShellSkillListItem[]>,
        }
      : {}),
    ...(input.loadNamedSkill
      ? {
          loadNamedSkill: input.loadNamedSkill as (
            name: string,
            cwd: string,
          ) => Promise<WorkShellLoadedSkill>,
        }
      : {}),
    ...(input.reloadWorkspaceContext
      ? { reloadWorkspaceContext: input.reloadWorkspaceContext }
      : {}),
    ...(input.toolLines ? { toolLines: input.toolLines } : {}),
    ...(input.extractAuthLabel
      ? { extractAuthLabel: input.extractAuthLabel }
      : {}),
    onExit: input.onExit,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
}
