import type { DatabaseSync } from "node:sqlite";

import {
  CONTEXT_SOURCE_DEFAULT_SALIENCE,
  type ContextPacketViewBadge,
  type ContextSourceMetadata,
  type UpsertContextSourceInput,
} from "@unclecode/contracts";

import { redactAgentOpsSecrets } from "./redaction.js";
import { sqlRow } from "./sql-row.js";
import { contextSourceRowToRecord, mapContextSourceRow } from "./store-context-source-mappers.js";
import type { AgentOpsContextSourceRow } from "./types.js";

function projectExists(db: DatabaseSync, projectId: string): boolean {
  return db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId) !== undefined;
}

function contextSourceBadgesJson(badges: readonly ContextPacketViewBadge[] | undefined): string | null {
  if (badges === undefined || badges.length === 0) return null;
  return JSON.stringify(
    badges.map((badge) => ({
      label: redactAgentOpsSecrets(badge.label),
      tone: badge.tone,
    })),
  );
}

function contextSourceMetadataJson(metadata: ContextSourceMetadata | undefined): string | null {
  if (metadata === undefined) return null;
  return JSON.stringify(redactContextSourceMetadata(metadata));
}

function redactContextSourceMetadata(metadata: ContextSourceMetadata): ContextSourceMetadata {
  switch (metadata.kind) {
    case "condensed-history":
      return {
        kind: "condensed-history",
        sourceEventIds: metadata.sourceEventIds.map(redactAgentOpsSecrets),
        ...(metadata.sourceEventPreviews === undefined
          ? {}
          : { sourceEventPreviews: metadata.sourceEventPreviews.map(redactAgentOpsSecrets) }),
        summary: redactAgentOpsSecrets(metadata.summary),
        recomputeReason: redactAgentOpsSecrets(metadata.recomputeReason),
        compactedEventCount: metadata.compactedEventCount,
        recentEventCount: metadata.recentEventCount,
        compression: {
          method: metadata.compression.method,
          inputTokensEstimate: metadata.compression.inputTokensEstimate,
          outputTokensEstimate: metadata.compression.outputTokensEstimate,
          ...(metadata.compression.model === undefined
            ? {}
            : { model: redactAgentOpsSecrets(metadata.compression.model) }),
        },
      };
    case "work-node":
      return {
        kind: "work-node",
        graphId: redactAgentOpsSecrets(metadata.graphId),
        nodeId: redactAgentOpsSecrets(metadata.nodeId),
        title: redactAgentOpsSecrets(metadata.title),
        ...(metadata.goal === undefined
          ? {}
          : { goal: redactAgentOpsSecrets(metadata.goal) }),
        constraints: metadata.constraints.map(redactAgentOpsSecrets),
        status: metadata.status,
        acceptanceCriteria: metadata.acceptanceCriteria.map(redactAgentOpsSecrets),
        evidenceRefs: metadata.evidenceRefs.map(redactAgentOpsSecrets),
      };
  }
}

export function upsertContextSource(
  db: DatabaseSync,
  input: UpsertContextSourceInput,
): AgentOpsContextSourceRow {
  if (!projectExists(db, input.projectId)) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }
  const timestamp = new Date().toISOString();
  const salience = input.salience ?? CONTEXT_SOURCE_DEFAULT_SALIENCE;
  const tokenEstimate = input.tokenEstimate ?? 0;
  const includedInModel = input.includedInModel === false ? 0 : 1;
  const label = redactAgentOpsSecrets(input.label);
  const content = input.content === undefined || input.content === null
    ? null
    : redactAgentOpsSecrets(input.content);
  const reason = redactAgentOpsSecrets(input.reason);
  const sha256 = input.sha256 === undefined ? null : input.sha256;
  const expiresAt = input.expiresAt === undefined ? null : input.expiresAt;
  const badgesJson = contextSourceBadgesJson(input.badges);
  const metadataJson = contextSourceMetadataJson(input.metadata);

  db.prepare(
    `INSERT INTO context_sources (
       id, project_id, category, label, content, reason, sha256,
       salience, token_estimate, included_in_model, turn_last_seen,
       created_at, updated_at, expires_at, badges_json, metadata_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, id) DO UPDATE SET
       category = excluded.category,
       label = excluded.label,
       content = excluded.content,
       reason = excluded.reason,
       sha256 = excluded.sha256,
       salience = CASE
         WHEN context_sources.salience >= 1.0 THEN context_sources.salience
         ELSE excluded.salience
       END,
       token_estimate = excluded.token_estimate,
       included_in_model = context_sources.included_in_model,
       expires_at = excluded.expires_at,
       badges_json = excluded.badges_json,
       metadata_json = excluded.metadata_json,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.projectId,
    input.category,
    label,
    content,
    reason,
    sha256,
    salience,
    tokenEstimate,
    includedInModel,
    timestamp,
    timestamp,
    expiresAt,
    badgesJson,
    metadataJson,
  );
  return getContextSourceOrThrow(db, input.projectId, input.id);
}

export function upsertContextSources(
  db: DatabaseSync,
  inputs: readonly UpsertContextSourceInput[],
): void {
  if (inputs.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const input of inputs) {
      upsertContextSource(db, input);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteContextSourcesByIdPrefix(
  db: DatabaseSync,
  input: {
    readonly projectId: string;
    readonly idPrefix: string;
    readonly keepIds?: readonly string[];
  },
): number {
  const keepIds = input.keepIds ?? [];
  const params: (string | number)[] = [input.projectId, `${input.idPrefix}%`];
  const keepClause = keepIds.length > 0
    ? ` AND id NOT IN (${keepIds.map(() => "?").join(",")})`
    : "";
  params.push(...keepIds);
  const result = db.prepare(
    `DELETE FROM context_sources
     WHERE project_id = ?
       AND id LIKE ?${keepClause}`,
  ).run(...params);
  return typeof result.changes === "number" ? result.changes : 0;
}

export function markContextSourceTurnSeen(
  db: DatabaseSync,
  projectId: string,
  ids: readonly string[],
  turnIndex: number,
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE context_sources
     SET turn_last_seen = ?, updated_at = ?
     WHERE project_id = ? AND id IN (${placeholders})`,
  ).run(turnIndex, new Date().toISOString(), projectId, ...ids);
}

export function pruneExpiredContextSources(db: DatabaseSync, now = new Date()): number {
  const nowIso = now.toISOString();
  const result = db.prepare(
    "DELETE FROM context_sources WHERE expires_at IS NOT NULL AND expires_at <= ?",
  ).run(nowIso);
  return typeof result.changes === "number" ? result.changes : 0;
}

export function pinContextSource(db: DatabaseSync, projectId: string, id: string): void {
  db.prepare(
    "UPDATE context_sources SET salience = 1.0, updated_at = ? WHERE project_id = ? AND id = ?",
  ).run(new Date().toISOString(), projectId, id);
}

export function unpinContextSource(db: DatabaseSync, projectId: string, id: string): void {
  db.prepare(
    "UPDATE context_sources SET salience = 0.5, updated_at = ? WHERE project_id = ? AND id = ?",
  ).run(new Date().toISOString(), projectId, id);
}

export function forgetContextSource(db: DatabaseSync, projectId: string, id: string): void {
  db.prepare(
    "UPDATE context_sources SET included_in_model = 0, updated_at = ? WHERE project_id = ? AND id = ?",
  ).run(new Date().toISOString(), projectId, id);
}

export function includeContextSource(db: DatabaseSync, projectId: string, id: string): void {
  db.prepare(
    "UPDATE context_sources SET included_in_model = 1, updated_at = ? WHERE project_id = ? AND id = ?",
  ).run(new Date().toISOString(), projectId, id);
}

export function restoreContextSourceState(
  db: DatabaseSync,
  input: {
    readonly projectId: string;
    readonly id: string;
    readonly salience: number;
    readonly includedInModel: boolean;
  },
): void {
  db.prepare(
    "UPDATE context_sources SET salience = ?, included_in_model = ?, updated_at = ? WHERE project_id = ? AND id = ?",
  ).run(
    input.salience,
    input.includedInModel ? 1 : 0,
    new Date().toISOString(),
    input.projectId,
    input.id,
  );
}

function getContextSourceOrThrow(db: DatabaseSync, projectId: string, id: string): AgentOpsContextSourceRow {
  const row = db.prepare("SELECT * FROM context_sources WHERE project_id = ? AND id = ?").get(projectId, id);
  if (row === undefined) throw new Error(`Context source not found: ${projectId}/${id}`);
  return mapContextSourceRow(sqlRow(row, `context source ${projectId}/${id}`));
}

export { contextSourceRowToRecord };
