import type { DatabaseSync } from "node:sqlite";

import {
  MEMORY_LINEAGE_STATES,
  type MemoryLineageRecord,
  type MemoryLineageState,
  type RecordMemoryLineageInput,
} from "@unclecode/contracts";

import {
  numberValue,
  optionalString,
  requiredString,
  sqlRow,
  sqlRows,
  type SqlRow,
} from "./sql-row.js";

const STATES: ReadonlySet<string> = new Set(MEMORY_LINEAGE_STATES);
const FIXED_WIDTH_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type AgentOpsMemoryLineageStoreMethods = {
  recordMemoryLineage(input: RecordMemoryLineageInput): MemoryLineageRecord;
  supersedeMemoryLineage(memoryId: string): MemoryLineageRecord;
  expireMemoryLineage(now?: Date): number;
  getMemoryLineage(memoryId: string): MemoryLineageRecord | undefined;
  listActiveMemoryLineage(): readonly MemoryLineageRecord[];
};

export function createAgentOpsMemoryLineageStoreMethods(
  db: DatabaseSync,
): AgentOpsMemoryLineageStoreMethods {
  return {
    recordMemoryLineage(input) {
      return recordMemoryLineage(db, input);
    },
    supersedeMemoryLineage(memoryId) {
      return supersedeMemoryLineage(db, memoryId);
    },
    expireMemoryLineage(now) {
      return expireMemoryLineage(db, now);
    },
    getMemoryLineage(memoryId) {
      return getMemoryLineage(db, memoryId);
    },
    listActiveMemoryLineage() {
      return listActiveMemoryLineage(db);
    },
  };
}

export function recordMemoryLineage(
  db: DatabaseSync,
  input: RecordMemoryLineageInput,
): MemoryLineageRecord {
  assertRecordInput(input);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const insert = () => {
    db.prepare(
      `INSERT INTO memory_lineage (
        memory_id, source_id, origin_turn_id, origin_packet_receipt_id,
        supersedes_memory_id, state, confidence, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.memoryId,
      input.sourceId,
      input.originTurnId,
      input.originPacketReceiptId,
      input.supersedesMemoryId ?? null,
      input.state,
      input.confidence,
      createdAt,
      input.expiresAt ?? null,
    );
  };

  if (input.supersedesMemoryId === undefined) {
    insert();
    return getMemoryLineageOrThrow(db, input.memoryId);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const predecessor = getMemoryLineage(db, input.supersedesMemoryId);
    if (predecessor === undefined) {
      throw new Error(`Memory lineage predecessor not found: ${input.supersedesMemoryId}`);
    }
    if (predecessor.state !== "active") {
      throw new Error(`Memory lineage predecessor is not active: ${input.supersedesMemoryId}`);
    }
    const transition = db
      .prepare("UPDATE memory_lineage SET state = 'superseded' WHERE memory_id = ? AND state = 'active'")
      .run(input.supersedesMemoryId);
    if (transition.changes !== 1) {
      throw new Error(`Memory lineage predecessor is not active: ${input.supersedesMemoryId}`);
    }
    insert();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getMemoryLineageOrThrow(db, input.memoryId);
}

export function supersedeMemoryLineage(
  db: DatabaseSync,
  memoryId: string,
): MemoryLineageRecord {
  assertIdentifier(memoryId, "memoryId");
  const current = getMemoryLineage(db, memoryId);
  if (current === undefined) throw new Error(`Memory lineage not found: ${memoryId}`);
  if (current.state !== "active") throw new Error(`Memory lineage is not active: ${memoryId}`);
  const result = db
    .prepare("UPDATE memory_lineage SET state = 'superseded' WHERE memory_id = ? AND state = 'active'")
    .run(memoryId);
  if (result.changes !== 1) throw new Error(`Memory lineage is not active: ${memoryId}`);
  return getMemoryLineageOrThrow(db, memoryId);
}

export function expireMemoryLineage(db: DatabaseSync, now = new Date()): number {
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date");
  const timestamp = now.toISOString();
  assertIsoTimestamp(timestamp, "now");
  const result = db
    .prepare(
      `UPDATE memory_lineage
       SET state = 'expired'
       WHERE state = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
    )
    .run(timestamp);
  return Number(result.changes);
}

export function getMemoryLineage(
  db: DatabaseSync,
  memoryId: string,
): MemoryLineageRecord | undefined {
  assertIdentifier(memoryId, "memoryId");
  const row = db.prepare("SELECT * FROM memory_lineage WHERE memory_id = ?").get(memoryId);
  return row === undefined ? undefined : mapMemoryLineageRow(sqlRow(row, `memory lineage ${memoryId}`));
}

export function listActiveMemoryLineage(db: DatabaseSync): readonly MemoryLineageRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_lineage
       WHERE state = 'active'
       ORDER BY created_at ASC, memory_id ASC`,
    )
    .all();
  return sqlRows(rows, "active memory lineage").map(mapMemoryLineageRow);
}

function getMemoryLineageOrThrow(db: DatabaseSync, memoryId: string): MemoryLineageRecord {
  const record = getMemoryLineage(db, memoryId);
  if (record === undefined) throw new Error(`Memory lineage not found: ${memoryId}`);
  return record;
}

function mapMemoryLineageRow(row: SqlRow): MemoryLineageRecord {
  const state = requiredString(row, "state");
  const supersedesMemoryId = optionalString(row, "supersedes_memory_id");
  const expiresAt = optionalString(row, "expires_at");
  assertState(state);
  return {
    memoryId: requiredString(row, "memory_id"),
    sourceId: requiredString(row, "source_id"),
    originTurnId: requiredString(row, "origin_turn_id"),
    originPacketReceiptId: requiredString(row, "origin_packet_receipt_id"),
    ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId }),
    state,
    confidence: numberValue(row, "confidence"),
    createdAt: requiredString(row, "created_at"),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function assertRecordInput(input: RecordMemoryLineageInput): void {
  assertIdentifier(input.memoryId, "memoryId");
  assertIdentifier(input.sourceId, "sourceId");
  assertIdentifier(input.originTurnId, "originTurnId");
  assertIdentifier(input.originPacketReceiptId, "originPacketReceiptId");
  if (input.supersedesMemoryId !== undefined) {
    assertIdentifier(input.supersedesMemoryId, "supersedesMemoryId");
    if (input.supersedesMemoryId === input.memoryId) {
      throw new TypeError("supersedesMemoryId must differ from memoryId");
    }
    if (input.state !== "active") {
      throw new TypeError("replacement memory lineage must be active");
    }
  }
  assertState(input.state);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new TypeError("confidence must be a finite number between 0 and 1");
  }
  if (input.createdAt !== undefined) assertIsoTimestamp(input.createdAt, "createdAt");
  if (input.expiresAt !== undefined) assertIsoTimestamp(input.expiresAt, "expiresAt");
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertState(value: string): asserts value is MemoryLineageState {
  if (!STATES.has(value)) throw new TypeError(`Unknown memory lineage state: ${value}`);
}

function assertIsoTimestamp(value: string, name: string): void {
  const parsed = new Date(value);
  if (
    !FIXED_WIDTH_ISO_TIMESTAMP.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new TypeError(`${name} must be a fixed-width UTC ISO timestamp`);
  }
}
