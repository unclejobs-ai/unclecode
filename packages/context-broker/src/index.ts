import { SESSION_CHECKPOINT_TYPES } from "@unclecode/contracts";

export type {
  AssembleOptions,
  ContextPacket,
  ContextPacketProvenance,
  FreshnessResult,
  FreshnessStatus,
  PolicySignal,
  RepoMap,
  RepoMapEntry,
  ResearchBundle,
  ResearchBundleOptions,
  TokenBudget,
} from "./types.js";
export { ContextBrokerError, FreshnessCheckError, GitCommandError } from "./types.js";
export { createRepoMapCache, defaultRepoMapCache } from "./repo-map-cache.js";
export { generateRepoMap, getRepoMapCacheToken } from "./repo-map.js";
export { detectHotspots, summarizeDiff } from "./hotspot.js";
export { assertFreshContext, checkFreshness } from "./freshness.js";
export { assembleContextPacket, estimateTokens, getTokenBudget } from "./context-packet.js";
export { prepareResearchBundle } from "./research-bundle.js";
export {
  buildContextPacketPreviewLines,
  buildWorkShellCompactContextPacketPreviewLines,
  composeWorkShellTurnPromptFromPacket,
  createContextPacketView,
  formatContextPacketIndicator,
  formatContextPacketPromptPrefix,
} from "./context-packet-view.js";
export type { OmoContextExcludedItem, OmoContextIncludedItem, OmoContextSnapshot } from "./omo-context.js";
export { loadOmoContextSnapshot } from "./omo-context.js";
export type { WorkspaceGuidance, WorkspaceGuidanceSkill } from "./workspace-guidance.js";
export {
  clearCachedWorkspaceGuidance,
  loadCachedWorkspaceGuidance,
  loadWorkspaceGuidance,
} from "./workspace-guidance.js";
export type { MemoryScope } from "./context-memory.js";
export type { ScopedMemoryEntry } from "./memory-transparency.js";
export {
  listProjectBridgeLines,
  listScopedMemoryEntries,
  listScopedMemoryLines,
  publishContextBridge,
  writeScopedMemory,
} from "./context-memory.js";
export type { MemoryFreshnessLabel } from "./memory-transparency.js";
export type {
  BootstrapSnapshot,
  BootstrapSourceKind,
  BootstrapSourceRecord,
  IngestWorkspaceBootstrapContextInput,
  IngestWorkspaceBootstrapContextResult,
} from "./context-bootstrap.js";
export {
  augmentContextPacketViewInput,
  buildBootstrapContextPacketSupplement,
  createBootstrapPacketId,
  ingestWorkspaceBootstrapContext,
  loadBootstrapSnapshot,
  writeBootstrapSnapshot,
} from "./context-bootstrap.js";
export type { CursorRuleSource } from "./cursor-rules.js";
export { discoverCursorRules } from "./cursor-rules.js";
export type { MemoryPrefetchResult, MemoryPrefetchStatus } from "./memory-prefetch.js";
export {
  DEFAULT_MEMORY_PREFETCH_TIMEOUT_MS,
  prefetchScopedMemory,
} from "./memory-prefetch.js";
export {
  describeMemoryEntryFreshness,
  formatScopedMemoryTransparencyLine,
  formatScopedMemoryTransparencyLines,
  parseScopedMemoryId,
} from "./memory-transparency.js";
export type {
  LoadedWorkspaceSkill,
  WorkspaceSkillItem,
  WorkspaceSkillMetadata,
} from "./workspace-skills.js";
export {
  clearWorkspaceSkillCache,
  discoverSkillMetadata,
  listAvailableSkills,
  loadNamedSkill,
} from "./workspace-skills.js";

export const CONTEXT_BROKER_DEFAULT_CHECKPOINT = SESSION_CHECKPOINT_TYPES[0];
