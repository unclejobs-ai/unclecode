import {
  CONTEXT_PACKET_VIEW_BADGE_TONES,
  CONTEXT_SOURCE_COMPRESSION_METHODS,
  WORK_NODE_STATUSES,
  type ContextPacketViewBadge,
  type ContextSourceCategory,
  type ContextSourceCompressionMetadata,
  type ContextSourceCompressionMethod,
  type ContextSourceMetadata,
  type ContextSourceRecord,
  type WorkNodeStatus,
} from "@unclecode/contracts";

import {
  numberValue,
  optionalNumber,
  optionalString,
  requiredString,
  type SqlRow,
} from "./sql-row.js";
import type { AgentOpsContextSourceRow } from "./types.js";

const CONTEXT_PACKET_VIEW_BADGE_TONE_SET: ReadonlySet<string> = new Set(CONTEXT_PACKET_VIEW_BADGE_TONES);
const CONTEXT_SOURCE_COMPRESSION_METHOD_SET: ReadonlySet<string> = new Set(CONTEXT_SOURCE_COMPRESSION_METHODS);

export function mapContextSourceRow(row: SqlRow): AgentOpsContextSourceRow {
  const content = optionalString(row, "content");
  const sha256 = optionalString(row, "sha256");
  const turnLastSeen = optionalNumber(row, "turn_last_seen");
  const expiresAt = optionalString(row, "expires_at");
  const badgesJson = optionalString(row, "badges_json");
  const metadataJson = optionalString(row, "metadata_json");
  return {
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    category: requiredString(row, "category"),
    label: requiredString(row, "label"),
    reason: requiredString(row, "reason"),
    salience: numberValue(row, "salience"),
    tokenEstimate: numberValue(row, "token_estimate"),
    includedInModel: numberValue(row, "included_in_model"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    content: content === undefined ? null : content,
    sha256: sha256 === undefined ? null : sha256,
    turnLastSeen: turnLastSeen === undefined ? null : turnLastSeen,
    expiresAt: expiresAt === undefined ? null : expiresAt,
    badgesJson: badgesJson === undefined ? null : badgesJson,
    metadataJson: metadataJson === undefined ? null : metadataJson,
  };
}

export function contextSourceRowToRecord(row: AgentOpsContextSourceRow): ContextSourceRecord {
  const category = contextSourceCategoryValue(row.category);
  const badges = parseContextSourceBadges(row.badgesJson);
  const metadata = parseContextSourceMetadata(row.metadataJson);
  return {
    id: row.id,
    projectId: row.projectId,
    category,
    label: row.label,
    content: row.content,
    reason: row.reason,
    sha256: row.sha256,
    salience: row.salience,
    tokenEstimate: row.tokenEstimate,
    includedInModel: row.includedInModel !== 0,
    turnLastSeen: row.turnLastSeen,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...(badges === undefined ? {} : { badges }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function contextSourceCategoryValue(value: string): ContextSourceCategory {
  switch (value) {
    case "workspace":
    case "workspace-guidance":
    case "bridge":
    case "loop-trail":
    case "condensed-history":
    case "memory":
    case "runtime":
    case "attachment":
    case "system":
      return value;
  }
  throw new TypeError(`Unknown context source category: ${value}`);
}

function parseContextSourceBadges(value: string | null): readonly ContextPacketViewBadge[] | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const badges: ContextPacketViewBadge[] = [];
  for (const entry of parsed) {
    if (isContextPacketViewBadge(entry)) {
      badges.push(entry);
    }
  }
  return badges.length === 0 ? undefined : badges;
}

function isContextPacketViewBadge(value: unknown): value is ContextPacketViewBadge {
  if (!isPlainRecord(value)) return false;
  return typeof value.label === "string" && isContextPacketViewBadgeTone(value.tone);
}

function isContextPacketViewBadgeTone(value: unknown): value is ContextPacketViewBadge["tone"] {
  return typeof value === "string" && CONTEXT_PACKET_VIEW_BADGE_TONE_SET.has(value);
}

function parseContextSourceMetadata(value: string | null): ContextSourceMetadata | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return isContextSourceMetadata(parsed) ? parsed : undefined;
}

function isContextSourceMetadata(value: unknown): value is ContextSourceMetadata {
  if (!isPlainRecord(value)) return false;
  switch (value.kind) {
    case "condensed-history":
      return isCondensedHistoryMetadata(value);
    case "work-node":
      return isWorkNodeMetadata(value);
    default:
      return false;
  }
}

function isCondensedHistoryMetadata(value: Readonly<Record<string, unknown>>): boolean {
  const sourceEventPreviews = stringArrayProperty(value, "sourceEventPreviews");
  return (
    Array.isArray(value.sourceEventIds) &&
    value.sourceEventIds.every((entry) => typeof entry === "string") &&
    (!("sourceEventPreviews" in value) || sourceEventPreviews !== undefined) &&
    stringProperty(value, "summary") !== undefined &&
    stringProperty(value, "recomputeReason") !== undefined &&
    numberProperty(value, "compactedEventCount") !== undefined &&
    numberProperty(value, "recentEventCount") !== undefined &&
    "compression" in value &&
    isContextSourceCompressionMetadata(value.compression)
  );
}

function isWorkNodeMetadata(value: Readonly<Record<string, unknown>>): boolean {
  const goal = stringProperty(value, "goal");
  return (
    stringProperty(value, "graphId") !== undefined &&
    stringProperty(value, "nodeId") !== undefined &&
    stringProperty(value, "title") !== undefined &&
    (!("goal" in value) || goal !== undefined) &&
    stringArrayProperty(value, "constraints") !== undefined &&
    workNodeStatusProperty(value, "status") !== undefined &&
    stringArrayProperty(value, "acceptanceCriteria") !== undefined &&
    stringArrayProperty(value, "evidenceRefs") !== undefined
  );
}

function isContextSourceCompressionMetadata(
  value: unknown,
): value is ContextSourceCompressionMetadata {
  if (!isPlainRecord(value)) return false;
  const model = stringProperty(value, "model");
  return (
    compressionMethodProperty(value, "method") !== undefined &&
    numberProperty(value, "inputTokensEstimate") !== undefined &&
    numberProperty(value, "outputTokensEstimate") !== undefined &&
    (!("model" in value) || model !== undefined)
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberProperty(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : undefined;
}

function stringArrayProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const candidate = value[key];
  return Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")
    ? candidate
    : undefined;
}

function compressionMethodProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): ContextSourceCompressionMethod | undefined {
  const method = stringProperty(value, key);
  if (method === undefined || !CONTEXT_SOURCE_COMPRESSION_METHOD_SET.has(method)) return undefined;
  switch (method) {
    case "llm-summary":
    case "recent-window":
    case "masking":
      return method;
  }
}

function workNodeStatusProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): WorkNodeStatus | undefined {
  const status = stringProperty(value, key);
  return WORK_NODE_STATUSES.find((candidate) => candidate === status);
}
