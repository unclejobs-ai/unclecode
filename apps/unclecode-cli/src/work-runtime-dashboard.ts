import {
  listAvailableSkills,
  listProjectBridgeLines,
  listScopedMemoryLines,
  loadNamedSkill,
  publishContextBridge,
  writeScopedMemory,
} from "@unclecode/context-broker";
import type {
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPacketViewItem,
  ContextPolicySuggestion,
  ContextPolicySuggestionState,
  ExecutionTraceEvent,
  ProviderId,
  ConsoleMotionPreference,
  ContextProfileId,
  AgentConsoleSnapshot,
  SubmitContextPacketReceiptInput,
} from "@unclecode/contracts";
import {
  describeReasoning,
  listSessionLines,
  persistWorkShellSessionSnapshot,
  resolveComposerInput,
  resolveModelCommand,
  resolveReasoningCommand,
  resolveWorkShellSlashCommand,
  toolDefinitions,
  type AppReasoningConfig,
  type CodingAgentTraceEvent,
  type OrchestratedWorkAgentTraceEvent,
  type WorkShellChatEntry,
  type WorkShellReasoningConfig,
  type WorkShellPromptManifestResolver,
} from "@unclecode/orchestrator";
import type { WorkShellInteractionBridge } from "@unclecode/orchestrator";
import type {
  ProviderInputAttachment,
  ProviderName,
  ProviderToolTraceEvent,
} from "@unclecode/providers";
import {
  buildContextPanel,
  buildInlineCommandPanel,
  buildWorkShellHelpPanel,
  buildWorkShellStatusPanel,
  extractAuthLabel,
  formatAgentTraceLine,
  formatInlineCommandResultSummary,
  formatWorkShellError,
  refineInlineCommandPanelLines,
  type TuiShellHomeState,
  type TuiRenderOptions,
} from "@unclecode/tui";

export type StartReplOptions = {
  provider: ProviderName;
  model: string;
  mode: string;
  authLabel: string;
  reasoning: AppReasoningConfig;
  cwd: string;
  modelWindow: number;
  contextProfile?: ContextProfileId | undefined;
  motion?: ConsoleMotionPreference | undefined;
  contextSummaryLines: readonly string[];
  contextPacketSourceMetadata?: readonly ContextPacketViewItem[] | undefined;
  homeState: TuiShellHomeState;
  sessionId?: string | undefined;
  initialTraceMode?: "minimal" | "verbose" | undefined;
  initialEntries?: readonly WorkShellChatEntry[] | undefined;
  initialSessionSummary?: string | undefined;
  initialAgentConsole?: AgentConsoleSnapshot | undefined;
  interactionBridge?: WorkShellInteractionBridge | undefined;
  reloadWorkspaceContext?: ((cwd: string) => Promise<readonly string[]>) | undefined;
  resolveContextPacket?: ((input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly contextSummaryLines: readonly string[];
    readonly bridgeLines: readonly string[];
    readonly memoryLines: readonly string[];
    readonly traceLines: readonly string[];
  }) => Promise<ContextPacketView>) | undefined;
  resolveContextSourceDetail?: ((sourceId: string) => Promise<string | undefined>) | undefined;
  resolvePromptManifest?: WorkShellPromptManifestResolver | undefined;
  refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  runInlineCommand?: ((args: readonly string[]) => Promise<readonly string[]>) | undefined;
  runAction?: TuiRenderOptions<TuiShellHomeState>["runAction"];
  runSession?: TuiRenderOptions<TuiShellHomeState>["runSession"];
  launchWorkSession?: TuiRenderOptions<TuiShellHomeState>["launchWorkSession"];
  saveApiKeyAuth?: ((raw: string) => Promise<readonly string[]>) | undefined;
  browserOAuthAvailable?: boolean | undefined;
  /** Optional agentops recorder callback. Non-blocking. Fired after every prompt turn. */
  recordTurn?: ((turn: { prompt: string; status: string; summary?: string; turnId?: string; contextReceiptId?: string; packetId?: string }) => void) | undefined;
  /** Context Inspector (Sprint 2): SQL mutation callback for the /context overlay. */
  mutateContextSource?: ((
    action: { readonly kind: "pin" | "unpin" | "forget" | "include"; readonly id: string },
  ) => ContextPacketViewActionReceipt | undefined) | undefined;
  previewContextPacket?: ((input: {
    readonly sessionId: string;
    readonly packet: ContextPacketView;
    readonly profile: string;
  }) => ContextPacketReceipt) | undefined;
  revalidateContextPacket?: ((input: {
    readonly sessionId: string;
    readonly preview: ContextPacketReceipt;
    readonly packet: ContextPacketView;
  }) => ContextPacketChangeClassification) | undefined;
  submitContextPacketReceipt?: ((
    input: Omit<SubmitContextPacketReceiptInput, "projectId">,
  ) => ContextPacketReceipt) | undefined;
  generateContextSuggestions?: ((input: {
    readonly receipt: ContextPacketReceipt;
    readonly packet: ContextPacketView;
  }) => Promise<readonly ContextPolicySuggestion[]>) | undefined;
  resolveContextSuggestion?: ((
    suggestionId: string,
    status: Extract<ContextPolicySuggestionState, "accepted" | "rejected">,
  ) => ContextPolicySuggestion) | undefined;
  invalidateContextSuggestions?: ((receiptId: string) => number) | undefined;
  refreshCondensedHistory?: (() => Promise<void>) | undefined;
};

type StartReplTraceEvent =
  | OrchestratedWorkAgentTraceEvent<CodingAgentTraceEvent<ProviderToolTraceEvent>>
  | Extract<ExecutionTraceEvent, { type: "bridge.published" | "memory.written" }>;

export type StartReplAgent = {
  runTurn(
    prompt: string,
    attachments?: readonly ProviderInputAttachment[],
  ): Promise<{ text: string }>;
  clear(): void;
  updateRuntimeSettings(settings: {
    reasoning?: AppReasoningConfig | undefined;
    model?: string | undefined;
  }): void;
  setTraceListener(
    listener?: ((event: StartReplTraceEvent) => void) | undefined,
  ): void;
};

export type ManagedDashboardSession = {
  agent: StartReplAgent;
  options: StartReplOptions;
};

type ResolveWorkShellInlineCommand = (
  args: readonly string[],
  runInlineCommand: (
    args: readonly string[],
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<readonly string[]>,
  onProgress?: ((line: string) => void) | undefined,
) => Promise<{ readonly lines: readonly string[]; readonly failed: boolean }>;

export function createManagedDashboardInput(
  session: ManagedDashboardSession,
  input: {
    resolveWorkShellInlineCommand: ResolveWorkShellInlineCommand;
    userHomeDir?: string;
  },
) {
  return {
    homeState: session.options.homeState,
    ...(session.options.refreshHomeState
      ? { refreshHomeState: session.options.refreshHomeState }
      : {}),
    ...(session.options.runAction ? { runAction: session.options.runAction } : {}),
    ...(session.options.runSession ? { runSession: session.options.runSession } : {}),
    ...(session.options.launchWorkSession
      ? { launchWorkSession: session.options.launchWorkSession }
      : {}),
    paneRuntime: {
      agent: session.agent,
      options: session.options,
      buildContextPanel,
      buildHelpPanel: buildWorkShellHelpPanel,
      buildStatusPanel: ({ options, reasoningLabel, authLabel, statusContext }: {
        options: { model: string; mode: string };
        reasoningLabel: string;
        authLabel: string;
        statusContext?: {
          readonly contextSummaryLines: readonly string[];
          readonly bridgeLines: readonly string[];
          readonly memoryLines: readonly string[];
          readonly traceLines: readonly string[];
        } | undefined;
      }) =>
        buildWorkShellStatusPanel({
          provider: session.options.provider,
          model: options.model,
          mode: options.mode,
          cwd: session.options.cwd,
          reasoningLabel,
          authLabel,
          ...(statusContext ?? {}),
        }),
      buildInlineCommandPanel,
      formatInlineCommandResultSummary,
      formatAgentTraceLine: (
        event: ExecutionTraceEvent | { readonly type: "bridge.published" | "memory.written"; readonly [key: string]: unknown },
      ) => formatAgentTraceLine(event as ExecutionTraceEvent),
      formatWorkShellError,
      listProjectBridgeLines,
      listScopedMemoryLines,
      listSessionLines,
      persistWorkShellSessionSnapshot,
      resolveReasoningCommand,
      resolveModelCommand: (
        value: string,
        currentModel: string,
        currentReasoning: WorkShellReasoningConfig,
        modeDefaultReasoning: WorkShellReasoningConfig,
      ) =>
        resolveModelCommand(value, {
          provider: session.options.provider as ProviderId,
          currentModel,
          currentReasoning,
          modeDefaultReasoning,
        }),
      resolveWorkShellSlashCommand,
      resolveWorkShellInlineCommand: input.resolveWorkShellInlineCommand,
      ...(session.options.refreshAuthState
        ? { refreshAuthState: session.options.refreshAuthState }
        : {}),
      ...(session.options.runInlineCommand
        ? { runInlineCommand: session.options.runInlineCommand }
        : {}),
      ...(session.options.saveApiKeyAuth
        ? { saveApiKeyAuth: session.options.saveApiKeyAuth }
        : {}),
      resolveComposerInput,
      refineInlineCommandResultLines: ({
        args,
        lines,
        failed,
        authLabel,
        browserOAuthAvailable,
      }: {
        args: readonly string[];
        lines: readonly string[];
        failed: boolean;
        authLabel: string;
        browserOAuthAvailable: boolean;
      }) =>
        refineInlineCommandPanelLines({
          args,
          lines,
          failed,
          authLabel,
          browserOAuthAvailable,
        }),
      ...(session.options.reloadWorkspaceContext
        ? { reloadWorkspaceContext: session.options.reloadWorkspaceContext }
        : {}),
      ...(session.options.resolveContextPacket
        ? { resolveContextPacket: session.options.resolveContextPacket }
        : {}),
      ...(session.options.resolvePromptManifest
        ? { resolvePromptManifest: session.options.resolvePromptManifest }
        : {}),
      publishContextBridge,
      writeScopedMemory,
      listAvailableSkills,
      loadNamedSkill,
      toolLines: toolDefinitions.map(
        (tool) => `${tool.name}: ${tool.description}`,
      ),
      extractAuthLabel,
      ...(session.options.sessionId
        ? { sessionId: session.options.sessionId }
        : {}),
      ...(session.options.initialEntries
        ? { initialEntries: session.options.initialEntries }
        : {}),
      ...(session.options.initialSessionSummary
        ? { initialSessionSummary: session.options.initialSessionSummary }
        : {}),
      ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
      browserOAuthAvailable: Boolean(session.options.browserOAuthAvailable),
      ...(session.options.recordTurn !== undefined
        ? { recordTurn: session.options.recordTurn }
        : {}),
      ...(session.options.mutateContextSource !== undefined
        ? { mutateContextSource: session.options.mutateContextSource }
        : {}),
      ...(session.options.previewContextPacket !== undefined
        ? { previewContextPacket: session.options.previewContextPacket }
        : {}),
      ...(session.options.revalidateContextPacket !== undefined
        ? { revalidateContextPacket: session.options.revalidateContextPacket }
        : {}),
      ...(session.options.submitContextPacketReceipt !== undefined
        ? { submitContextPacketReceipt: session.options.submitContextPacketReceipt }
        : {}),
      ...(session.options.generateContextSuggestions !== undefined
        ? { generateContextSuggestions: session.options.generateContextSuggestions }
        : {}),
      ...(session.options.resolveContextSuggestion !== undefined
        ? { resolveContextSuggestion: session.options.resolveContextSuggestion }
        : {}),
      ...(session.options.invalidateContextSuggestions !== undefined
        ? { invalidateContextSuggestions: session.options.invalidateContextSuggestions }
        : {}),
      ...(session.options.refreshCondensedHistory !== undefined
        ? { refreshCondensedHistory: session.options.refreshCondensedHistory }
        : {}),
      ...(session.options.resolveContextSourceDetail !== undefined
        ? { resolveContextSourceDetail: session.options.resolveContextSourceDetail }
        : {}),
    },
    getReasoningLabel: describeReasoning,
    isReasoningSupported: (reasoning: WorkShellReasoningConfig) =>
      reasoning.support.status === "supported",
  };
}
