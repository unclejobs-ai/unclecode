import { SESSION_STATES } from "@unclecode/contracts";

export { getSessionStoreRoot } from "./root.js";
export { createSessionStore } from "./store.js";
export {
  getSessionPersistenceNoticeDir,
  watchSessionPersistenceNotices,
} from "./persistence-notifications.js";
export type {
  SessionPersistenceNotice,
  SessionPersistenceNoticeWatcher,
} from "./persistence-notifications.js";
export type {
  ProjectMemoryEntry,
  SessionCheckpointSnapshot,
  SessionForkOptions,
  SessionResumeResult,
  SessionStore,
  SessionStoreOptions,
  SessionStorePaths,
  SessionStoreRecord,
  SessionStoreSessionRef,
  SessionTaskSummarySnapshot,
} from "./types.js";

export const SESSION_STORE_DEFAULT_STATE = SESSION_STATES[0];

export {
  appendTeamCheckpoint,
  createTeamRun,
  generateRunId,
  getRunStatusFromCheckpoints,
  getTeamRunRoot,
  getTeamRunsRoot,
  lockTeamRun,
  readTeamCheckpoints,
  readTeamRunManifest,
  verifyTeamRunChain,
} from "./team-run-store.js";
export type {
  AppendableTeamCheckpoint,
  ChainVerification,
  CreateTeamRunInput,
  TeamCheckpoint,
  TeamRunRef,
} from "./team-run-store.js";
