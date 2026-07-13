import type { DatabaseSync } from "node:sqlite";

import {
  CONTEXT_POLICY_ACTIONS,
  CONTEXT_POLICY_SUGGESTION_STATES,
  type AddContextPolicySuggestionInput,
  type ContextPolicyAction,
  type ContextPolicySuggestion,
  type ContextPolicySuggestionState,
} from "@unclecode/contracts";

import {
  optionalNumber,
  optionalString,
  requiredString,
  sqlRow,
  sqlRows,
  type SqlRow,
} from "./sql-row.js";

const ACTIONS: ReadonlySet<string> = new Set(CONTEXT_POLICY_ACTIONS);
const STATES: ReadonlySet<string> = new Set(CONTEXT_POLICY_SUGGESTION_STATES);

export type ResolvedContextPolicySuggestionState = Extract<
  ContextPolicySuggestionState,
  "accepted" | "rejected"
>;

export type AgentOpsContextSuggestionStoreMethods = {
  addContextPolicySuggestion(input: AddContextPolicySuggestionInput): ContextPolicySuggestion;
  resolveContextPolicySuggestion(
    id: string,
    status: ResolvedContextPolicySuggestionState,
  ): ContextPolicySuggestion;
  markContextPolicySuggestionsStale(packetReceiptId: string): number;
  listContextPolicySuggestions(packetReceiptId: string): readonly ContextPolicySuggestion[];
};

export function createAgentOpsContextSuggestionStoreMethods(
  db: DatabaseSync,
): AgentOpsContextSuggestionStoreMethods {
  return {
    addContextPolicySuggestion(input) {
      return addContextPolicySuggestion(db, input);
    },
    resolveContextPolicySuggestion(id, status) {
      return resolveContextPolicySuggestion(db, id, status);
    },
    markContextPolicySuggestionsStale(packetReceiptId) {
      return markContextPolicySuggestionsStale(db, packetReceiptId);
    },
    listContextPolicySuggestions(packetReceiptId) {
      return listContextPolicySuggestions(db, packetReceiptId);
    },
  };
}

export function addContextPolicySuggestion(
  db: DatabaseSync,
  input: AddContextPolicySuggestionInput,
): ContextPolicySuggestion {
  assertAction(input.action);
  assertOptionalTokenSaving(input.estimatedTokenSaving);
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO context_policy_suggestions (
      id, packet_receipt_id, source_id, action, reason_code, reason_text,
      estimated_token_saving, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, NULL)`,
  ).run(
    input.id,
    input.packetReceiptId,
    input.sourceId,
    input.action,
    input.reasonCode,
    input.reasonText,
    input.estimatedTokenSaving ?? null,
    createdAt,
  );
  return getContextPolicySuggestionOrThrow(db, input.id);
}

export function resolveContextPolicySuggestion(
  db: DatabaseSync,
  id: string,
  status: ResolvedContextPolicySuggestionState,
): ContextPolicySuggestion {
  if (status !== "accepted" && status !== "rejected") {
    throw new TypeError(`Unsupported context policy resolution: ${String(status)}`);
  }
  const current = getContextPolicySuggestion(db, id);
  if (current === undefined) {
    throw new Error(`Context policy suggestion not found: ${id}`);
  }
  if (current.status !== "proposed") {
    throw new Error(`Context policy suggestion already resolved: ${id}`);
  }
  const result = db
    .prepare(
      `UPDATE context_policy_suggestions
       SET status = ?, resolved_at = ?
       WHERE id = ? AND status = 'proposed'`,
    )
    .run(status, new Date().toISOString(), id);
  if (result.changes !== 1) {
    throw new Error(`Context policy suggestion already resolved: ${id}`);
  }
  return getContextPolicySuggestionOrThrow(db, id);
}

export function markContextPolicySuggestionsStale(
  db: DatabaseSync,
  packetReceiptId: string,
): number {
  const result = db
    .prepare(
      `UPDATE context_policy_suggestions
       SET status = 'stale', resolved_at = ?
       WHERE packet_receipt_id = ?
         AND status = 'proposed'`,
    )
    .run(new Date().toISOString(), packetReceiptId);
  return Number(result.changes);
}

export function listContextPolicySuggestions(
  db: DatabaseSync,
  packetReceiptId: string,
): readonly ContextPolicySuggestion[] {
  const rows = db
    .prepare(
      `SELECT * FROM context_policy_suggestions
       WHERE packet_receipt_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(packetReceiptId);
  return sqlRows(rows, `context policy suggestions for ${packetReceiptId}`).map(
    mapContextPolicySuggestionRow,
  );
}

function getContextPolicySuggestion(
  db: DatabaseSync,
  id: string,
): ContextPolicySuggestion | undefined {
  const row = db.prepare("SELECT * FROM context_policy_suggestions WHERE id = ?").get(id);
  return row === undefined
    ? undefined
    : mapContextPolicySuggestionRow(sqlRow(row, `context policy suggestion ${id}`));
}

function getContextPolicySuggestionOrThrow(
  db: DatabaseSync,
  id: string,
): ContextPolicySuggestion {
  const suggestion = getContextPolicySuggestion(db, id);
  if (suggestion === undefined) {
    throw new Error(`Context policy suggestion not found: ${id}`);
  }
  return suggestion;
}

function mapContextPolicySuggestionRow(row: SqlRow): ContextPolicySuggestion {
  const action = requiredString(row, "action");
  const status = requiredString(row, "status");
  const estimatedTokenSaving = optionalNumber(row, "estimated_token_saving");
  const resolvedAt = optionalString(row, "resolved_at");
  assertAction(action);
  assertState(status);
  return {
    id: requiredString(row, "id"),
    packetReceiptId: requiredString(row, "packet_receipt_id"),
    sourceId: requiredString(row, "source_id"),
    action,
    reasonCode: requiredString(row, "reason_code"),
    reasonText: requiredString(row, "reason_text"),
    ...(estimatedTokenSaving === undefined ? {} : { estimatedTokenSaving }),
    status,
    createdAt: requiredString(row, "created_at"),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
  };
}

function assertAction(value: string): asserts value is ContextPolicyAction {
  if (!ACTIONS.has(value)) {
    throw new TypeError(`Unknown context policy action: ${value}`);
  }
}

function assertState(value: string): asserts value is ContextPolicySuggestionState {
  if (!STATES.has(value)) {
    throw new TypeError(`Unknown context policy suggestion state: ${value}`);
  }
}

function assertOptionalTokenSaving(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("estimatedTokenSaving must be a non-negative safe integer");
  }
}
