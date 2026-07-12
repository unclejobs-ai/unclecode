import type { DatabaseSync } from "node:sqlite";

import type {
  ContextSourceRecord,
  SelectContextSourcesInput,
  UpsertContextSourceInput,
} from "@unclecode/contracts";

import {
  countContextSourcesByCategory as countContextSourcesByCategoryImpl,
  selectContextSources as selectContextSourcesImpl,
} from "./store-context-reads.js";
import {
  contextSourceRowToRecord,
  deleteContextSourcesByIdPrefix,
  forgetContextSource,
  includeContextSource,
  markContextSourceTurnSeen,
  pinContextSource,
  pruneExpiredContextSources,
  restoreContextSourceState,
  unpinContextSource,
  upsertContextSource,
} from "./store-context-writes.js";
import type { AgentOpsStore, SelectedContextSources } from "./store-types.js";

export type AgentOpsContextStoreMethods = Pick<
  AgentOpsStore,
  | "upsertContextSource"
  | "selectContextSources"
  | "countContextSourcesByCategory"
  | "markContextSourceTurnSeen"
  | "deleteContextSourcesByIdPrefix"
  | "pruneExpiredContextSources"
  | "pinContextSource"
  | "unpinContextSource"
  | "forgetContextSource"
  | "includeContextSource"
  | "restoreContextSourceState"
>;

export function createAgentOpsContextStoreMethods(db: DatabaseSync): AgentOpsContextStoreMethods {
  return {
    upsertContextSource(input: UpsertContextSourceInput): ContextSourceRecord {
      return contextSourceRowToRecord(upsertContextSource(db, input));
    },
    selectContextSources(input: SelectContextSourcesInput): SelectedContextSources {
      return selectContextSourcesImpl(db, input);
    },
    countContextSourcesByCategory(projectId: string): ReadonlyMap<string, number> {
      return countContextSourcesByCategoryImpl(db, projectId);
    },
    markContextSourceTurnSeen(projectId: string, ids: readonly string[], turnIndex: number): void {
      markContextSourceTurnSeen(db, projectId, ids, turnIndex);
    },
    deleteContextSourcesByIdPrefix(input): number {
      return deleteContextSourcesByIdPrefix(db, input);
    },
    pruneExpiredContextSources(now?: Date): number {
      return pruneExpiredContextSources(db, now);
    },
    pinContextSource(projectId: string, id: string): void {
      pinContextSource(db, projectId, id);
    },
    unpinContextSource(projectId: string, id: string): void {
      unpinContextSource(db, projectId, id);
    },
    forgetContextSource(projectId: string, id: string): void {
      forgetContextSource(db, projectId, id);
    },
    includeContextSource(projectId: string, id: string): void {
      includeContextSource(db, projectId, id);
    },
    restoreContextSourceState(input): void {
      restoreContextSourceState(db, input);
    },
  };
}
