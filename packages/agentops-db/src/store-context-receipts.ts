import type { DatabaseSync } from "node:sqlite";

import {
  isContextPacketReceiptState,
  type ContextPacketReceipt,
  type ContextPacketReceiptSourceRef,
  type ContextPacketSourceCategory,
  type ContextPacketTokenEstimateState,
  type ContextPacketViewTrustTier,
  type RecordContextPacketPreviewInput,
  type SubmitContextPacketReceiptInput,
} from "@unclecode/contracts";

import { numberValue, optionalNumber, optionalString, requiredString, sqlRow, type SqlRow } from "./sql-row.js";

const SOURCE_REF_KEYS = new Set([
  "sourceId",
  "category",
  "sha256",
  "trustTier",
  "salience",
  "includedInModel",
]);

const CONTEXT_PACKET_SOURCE_CATEGORIES = [
  "workspace",
  "workspace-guidance",
  "provider-system-prompt",
  "loop-trail",
  "condensed-history",
  "memory",
  "bridge",
  "runtime",
  "attachment",
  "system",
  "user",
] as const satisfies readonly ContextPacketSourceCategory[];

const CONTEXT_PACKET_SOURCE_CATEGORY_SET: ReadonlySet<string> = new Set(CONTEXT_PACKET_SOURCE_CATEGORIES);

const TOKEN_ESTIMATE_STATES = ["exact", "estimated", "unknown"] as const satisfies readonly ContextPacketTokenEstimateState[];
const TOKEN_ESTIMATE_STATE_SET: ReadonlySet<string> = new Set(TOKEN_ESTIMATE_STATES);

const TRUST_TIERS = ["builtin", "project", "user", "external", "runtime"] as const satisfies readonly ContextPacketViewTrustTier[];
const TRUST_TIER_SET: ReadonlySet<string> = new Set(TRUST_TIERS);

export type AgentOpsContextReceiptStoreMethods = {
  recordContextPacketPreview(input: RecordContextPacketPreviewInput): ContextPacketReceipt;
  invalidateContextPacketReceipt(projectId: string, receiptId: string): ContextPacketReceipt;
  submitContextPacketReceipt(input: SubmitContextPacketReceiptInput): ContextPacketReceipt;
  getContextPacketReceipt(projectId: string, receiptId: string): ContextPacketReceipt | undefined;
  getActiveContextPacketPreview(projectId: string, sessionId: string): ContextPacketReceipt | undefined;
};

export function createAgentOpsContextReceiptStoreMethods(db: DatabaseSync): AgentOpsContextReceiptStoreMethods {
  return {
    recordContextPacketPreview(input) {
      return recordContextPacketPreview(db, input);
    },
    invalidateContextPacketReceipt(projectId, receiptId) {
      return invalidateContextPacketReceipt(db, projectId, receiptId);
    },
    submitContextPacketReceipt(input) {
      return submitContextPacketReceipt(db, input);
    },
    getContextPacketReceipt(projectId, receiptId) {
      return getContextPacketReceipt(db, projectId, receiptId);
    },
    getActiveContextPacketPreview(projectId, sessionId) {
      return getActiveContextPacketPreview(db, projectId, sessionId);
    },
  };
}

export function recordContextPacketPreview(
  db: DatabaseSync,
  input: RecordContextPacketPreviewInput,
): ContextPacketReceipt {
  if (!projectExists(db, input.projectId)) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }

  const sourceRefs = normalizeSourceRefs(input.sourceRefs);
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO context_packet_receipts (
      id, project_id, session_id, turn_id, packet_id, state, replaces_receipt_id,
      profile, token_estimate, token_estimate_state, source_count, source_refs_json, created_at
    ) VALUES (?, ?, ?, NULL, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.projectId,
    input.sessionId,
    input.packetId,
    input.replacesReceiptId ?? null,
    input.profile,
    input.tokenEstimate ?? null,
    input.tokenEstimateState,
    input.sourceCount,
    JSON.stringify(sourceRefs),
    createdAt,
  );

  return getContextPacketReceiptOrThrow(db, input.projectId, input.id);
}

export function invalidateContextPacketReceipt(
  db: DatabaseSync,
  projectId: string,
  receiptId: string,
): ContextPacketReceipt {
  const result = db
    .prepare(
      `UPDATE context_packet_receipts
       SET state = 'invalidated'
       WHERE id = ? AND project_id = ? AND state = 'previewed'`,
    )
    .run(receiptId, projectId);
  if (result.changes !== 1) {
    throw new Error(`Preview receipt is not invalidatable: ${receiptId}`);
  }
  return getContextPacketReceiptOrThrow(db, projectId, receiptId);
}

export function submitContextPacketReceipt(
  db: DatabaseSync,
  input: SubmitContextPacketReceiptInput,
): ContextPacketReceipt {
  db.exec("BEGIN IMMEDIATE");
  try {
    const duplicate = db
      .prepare(
        `SELECT id FROM context_packet_receipts
         WHERE project_id = ? AND session_id = ? AND turn_id = ? AND state = 'submitted'`,
      )
      .get(input.projectId, input.sessionId, input.turnId);
    if (duplicate !== undefined) {
      throw new Error(`Submitted receipt already exists for turn: ${input.turnId}`);
    }
    const result = db
      .prepare(
        `UPDATE context_packet_receipts
         SET state = 'submitted', turn_id = ?
         WHERE id = ? AND project_id = ? AND session_id = ? AND state = 'previewed'`,
      )
      .run(input.turnId, input.receiptId, input.projectId, input.sessionId);
    if (result.changes !== 1) {
      throw new Error(`Preview receipt is not submittable: ${input.receiptId}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getContextPacketReceiptOrThrow(db, input.projectId, input.receiptId);
}

export function getContextPacketReceipt(
  db: DatabaseSync,
  projectId: string,
  receiptId: string,
): ContextPacketReceipt | undefined {
  const row = db
    .prepare(`SELECT * FROM context_packet_receipts WHERE project_id = ? AND id = ?`)
    .get(projectId, receiptId);
  return row === undefined ? undefined : mapContextPacketReceiptRow(sqlRow(row, `context packet receipt ${receiptId}`));
}

export function getActiveContextPacketPreview(
  db: DatabaseSync,
  projectId: string,
  sessionId: string,
): ContextPacketReceipt | undefined {
  const row = db
    .prepare(
      `SELECT * FROM context_packet_receipts
       WHERE project_id = ? AND session_id = ? AND state = 'previewed'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(projectId, sessionId);
  return row === undefined
    ? undefined
    : mapContextPacketReceiptRow(sqlRow(row, `active context packet preview ${sessionId}`));
}

function getContextPacketReceiptOrThrow(
  db: DatabaseSync,
  projectId: string,
  receiptId: string,
): ContextPacketReceipt {
  const receipt = getContextPacketReceipt(db, projectId, receiptId);
  if (receipt === undefined) {
    throw new Error(`Context packet receipt not found: ${receiptId}`);
  }
  return receipt;
}

function projectExists(db: DatabaseSync, projectId: string): boolean {
  return db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId) !== undefined;
}

function normalizeSourceRefs(
  sourceRefs: readonly ContextPacketReceiptSourceRef[],
): readonly ContextPacketReceiptSourceRef[] {
  return sourceRefs.map((ref, index) => normalizeSourceRef(ref, index));
}

function normalizeSourceRef(value: unknown, index: number): ContextPacketReceiptSourceRef {
  if (!isPlainRecord(value)) {
    throw new TypeError(`Expected source ref object at index ${index}`);
  }
  for (const key of Object.keys(value)) {
    if (!SOURCE_REF_KEYS.has(key)) {
      throw new Error(`Unsupported source ref key: ${key}`);
    }
  }

  const sourceId = value.sourceId;
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new TypeError(`Expected sourceId string at source ref index ${index}`);
  }
  const category = categoryValue(value.category, index);
  const salience = value.salience;
  if (typeof salience !== "number" || !Number.isFinite(salience)) {
    throw new TypeError(`Expected salience number at source ref index ${index}`);
  }
  const includedInModel = value.includedInModel;
  if (typeof includedInModel !== "boolean") {
    throw new TypeError(`Expected includedInModel boolean at source ref index ${index}`);
  }

  const normalized: {
    sourceId: string;
    category: ContextPacketSourceCategory;
    sha256?: string;
    trustTier?: ContextPacketViewTrustTier;
    salience: number;
    includedInModel: boolean;
  } = {
    sourceId,
    category,
    salience,
    includedInModel,
  };

  if (value.sha256 !== undefined) {
    if (typeof value.sha256 !== "string") {
      throw new TypeError(`Expected sha256 string at source ref index ${index}`);
    }
    normalized.sha256 = value.sha256;
  }
  if (value.trustTier !== undefined) {
    normalized.trustTier = trustTierValue(value.trustTier, index);
  }
  return normalized;
}

function mapContextPacketReceiptRow(row: SqlRow): ContextPacketReceipt {
  const state = requiredString(row, "state");
  if (!isContextPacketReceiptState(state)) {
    throw new TypeError(`Unknown context packet receipt state: ${state}`);
  }
  const tokenEstimateState = requiredString(row, "token_estimate_state");
  if (!isTokenEstimateState(tokenEstimateState)) {
    throw new TypeError(`Unknown token estimate state: ${tokenEstimateState}`);
  }

  const receipt: {
    id: string;
    projectId: string;
    sessionId: string;
    turnId?: string;
    packetId: string;
    state: typeof state;
    replacesReceiptId?: string;
    profile: string;
    tokenEstimate?: number;
    tokenEstimateState: ContextPacketTokenEstimateState;
    sourceCount: number;
    sourceRefs: readonly ContextPacketReceiptSourceRef[];
    createdAt: string;
  } = {
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    sessionId: requiredString(row, "session_id"),
    packetId: requiredString(row, "packet_id"),
    state,
    profile: requiredString(row, "profile"),
    tokenEstimateState,
    sourceCount: numberValue(row, "source_count"),
    sourceRefs: parseSourceRefsJson(requiredString(row, "source_refs_json")),
    createdAt: requiredString(row, "created_at"),
  };

  const turnId = optionalString(row, "turn_id");
  if (turnId !== undefined) receipt.turnId = turnId;
  const replacesReceiptId = optionalString(row, "replaces_receipt_id");
  if (replacesReceiptId !== undefined) receipt.replacesReceiptId = replacesReceiptId;
  const tokenEstimate = optionalNumber(row, "token_estimate");
  if (tokenEstimate !== undefined) receipt.tokenEstimate = tokenEstimate;
  return receipt;
}

function parseSourceRefsJson(value: string): readonly ContextPacketReceiptSourceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Invalid source_refs_json");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("Expected source_refs_json to be an array");
  }
  return parsed.map((entry, index) => normalizeSourceRef(entry, index));
}

function categoryValue(value: unknown, index: number): ContextPacketSourceCategory {
  if (!isContextPacketSourceCategory(value)) {
    throw new TypeError(`Unknown context packet source category at index ${index}: ${String(value)}`);
  }
  return value;
}

function trustTierValue(value: unknown, index: number): ContextPacketViewTrustTier {
  if (!isTrustTier(value)) {
    throw new TypeError(`Unknown trust tier at source ref index ${index}: ${String(value)}`);
  }
  return value;
}

function isContextPacketSourceCategory(value: unknown): value is ContextPacketSourceCategory {
  return typeof value === "string" && CONTEXT_PACKET_SOURCE_CATEGORY_SET.has(value);
}

function isTrustTier(value: unknown): value is ContextPacketViewTrustTier {
  return typeof value === "string" && TRUST_TIER_SET.has(value);
}

function isTokenEstimateState(value: string): value is ContextPacketTokenEstimateState {
  return TOKEN_ESTIMATE_STATE_SET.has(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
