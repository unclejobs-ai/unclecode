import type { SQLOutputValue } from "node:sqlite";

import type { AgentOpsEntityStatus } from "./types.js";

export type SqlRow = Record<string, SQLOutputValue>;

const ENTITY_STATUS_VALUES = [
  "queued",
  "active",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "skipped",
  "done",
  "archived",
] as const satisfies readonly AgentOpsEntityStatus[];

const ENTITY_STATUS_SET: ReadonlySet<string> = new Set(ENTITY_STATUS_VALUES);

export function sqlRow(value: unknown, context: string): SqlRow {
  if (!isSqlRow(value)) {
    throw new TypeError(`Expected SQLite row for ${context}`);
  }
  return value;
}

export function sqlRows(values: readonly unknown[], context: string): readonly SqlRow[] {
  return values.map((value) => sqlRow(value, context));
}

export function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${key} to be a string`);
  }
  return value;
}

export function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${key} to be a string when present`);
  }
  return value;
}

export function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return numberOutputValue(value, key);
}

export function numberValue(row: SqlRow, key: string): number {
  return numberOutputValue(row[key], key);
}

export function entityStatusValue(row: SqlRow, key: string): AgentOpsEntityStatus {
  const value = requiredString(row, key);
  if (!isEntityStatus(value)) {
    throw new TypeError(`Unknown entity status: ${value}`);
  }
  return value;
}

function numberOutputValue(value: SQLOutputValue | undefined, key: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new TypeError(`Expected ${key} to be a safe number`);
}

function isSqlRow(value: unknown): value is SqlRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isSqlOutputValue);
}

function isSqlOutputValue(value: unknown): value is SQLOutputValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value === null ||
    value instanceof Uint8Array
  );
}

function isEntityStatus(value: string): value is AgentOpsEntityStatus {
  return ENTITY_STATUS_SET.has(value);
}
