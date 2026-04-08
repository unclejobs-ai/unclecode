import { SESSION_STATES } from "@unclecode/contracts";

export { getSessionStoreRoot } from "./root.js";
export { createSessionStore } from "./store.js";
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
