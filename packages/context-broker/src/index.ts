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
export type { WorkspaceGuidance, WorkspaceGuidanceSkill } from "./workspace-guidance.js";
export {
  clearCachedWorkspaceGuidance,
  loadCachedWorkspaceGuidance,
  loadWorkspaceGuidance,
} from "./workspace-guidance.js";
export type { MemoryScope } from "./context-memory.js";
export {
  listProjectBridgeLines,
  listScopedMemoryLines,
  publishContextBridge,
  writeScopedMemory,
} from "./context-memory.js";
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
