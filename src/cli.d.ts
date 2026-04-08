export type { StartReplOptions } from "../apps/unclecode-cli/src/work-runtime.js";
export {
  resolveWorkShellInlineCommand,
  createWorkShellDashboardProps,
  startRepl,
} from "../apps/unclecode-cli/src/work-runtime.js";

export {
  buildAttachmentPreviewLines,
  buildContextPanel,
  buildInlineCommandPanel,
  buildSlashSuggestionPanel,
  buildTerminalInlineImageSequence,
  clampWorkShellSlashSelection,
  createWorkShellDashboardHomePatch,
  createWorkShellDashboardHomeSyncState,
  cycleWorkShellSlashSelection,
  extractAuthLabel,
  formatAgentTraceLine,
  formatAttachmentBadgeLine,
  formatAuthLabelForDisplay,
  formatInlineCommandResultSummary,
  formatInlineImageSupportLine,
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
export {
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
export {
  listAvailableSkills,
  listProjectBridgeLines,
  listScopedMemoryLines,
  loadNamedSkill,
  publishContextBridge,
  writeScopedMemory,
} from "@unclecode/context-broker";
export { getSessionStoreRoot } from "@unclecode/session-store";
