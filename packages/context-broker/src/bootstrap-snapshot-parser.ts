import type { BootstrapSnapshot, BootstrapSourceKind, BootstrapSourceRecord } from "./context-bootstrap.js";

const BOOTSTRAP_SOURCE_KINDS = ["guidance", "cursor-rule", "skill", "mcp", "memory"] as const;
const BOOTSTRAP_SOURCE_KIND_SET: ReadonlySet<string> = new Set(BOOTSTRAP_SOURCE_KINDS);
const BOOTSTRAP_SOURCE_SCOPES = ["project", "user", "workspace"] as const;
const BOOTSTRAP_SOURCE_SCOPE_SET: ReadonlySet<string> = new Set(BOOTSTRAP_SOURCE_SCOPES);
const MEMORY_PREFETCH_STATUSES = ["ok", "empty", "degraded"] as const;
const MEMORY_PREFETCH_STATUS_SET: ReadonlySet<string> = new Set(MEMORY_PREFETCH_STATUSES);

type BootstrapSourceScope = BootstrapSourceRecord["scope"];
type MemoryPrefetchStatus = BootstrapSnapshot["memoryPrefetch"]["status"];
type OptionalStringParse =
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false };

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadonlyUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isBootstrapSourceKind(value: unknown): value is BootstrapSourceKind {
  return typeof value === "string" && BOOTSTRAP_SOURCE_KIND_SET.has(value);
}

function isBootstrapSourceScope(value: unknown): value is BootstrapSourceScope {
  return typeof value === "string" && BOOTSTRAP_SOURCE_SCOPE_SET.has(value);
}

function isMemoryPrefetchStatus(value: unknown): value is MemoryPrefetchStatus {
  return typeof value === "string" && MEMORY_PREFETCH_STATUS_SET.has(value);
}

function parseOptionalString(value: unknown): OptionalStringParse {
  if (value === undefined) {
    return { ok: true };
  }
  return typeof value === "string" ? { ok: true, value } : { ok: false };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!isReadonlyUnknownArray(value)) {
    return undefined;
  }
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function parseBootstrapSourceRecord(value: unknown): BootstrapSourceRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value["id"];
  const kind = value["kind"];
  const sourcePath = value["path"];
  const scope = value["scope"];
  const sha256 = value["sha256"];
  const bytes = value["bytes"];
  const summary = value["summary"];
  const includedInModel = value["includedInModel"];
  const includedInView = value["includedInView"];
  const reason = value["reason"];

  if (
    typeof id !== "string" ||
    !isBootstrapSourceKind(kind) ||
    typeof sourcePath !== "string" ||
    !isBootstrapSourceScope(scope) ||
    typeof sha256 !== "string" ||
    typeof bytes !== "number" ||
    typeof summary !== "string" ||
    typeof includedInModel !== "boolean" ||
    typeof includedInView !== "boolean" ||
    typeof reason !== "string"
  ) {
    return undefined;
  }

  return {
    id,
    kind,
    path: sourcePath,
    scope,
    sha256,
    bytes,
    summary,
    includedInModel,
    includedInView,
    reason,
  };
}

function parseBootstrapSourceRecords(value: unknown): readonly BootstrapSourceRecord[] | undefined {
  if (!isReadonlyUnknownArray(value)) {
    return undefined;
  }

  const records: BootstrapSourceRecord[] = [];
  for (const item of value) {
    const record = parseBootstrapSourceRecord(item);
    if (record === undefined) {
      return undefined;
    }
    records.push(record);
  }
  return records;
}

function parseMemoryPrefetch(value: unknown): BootstrapSnapshot["memoryPrefetch"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = value["status"];
  const reason = parseOptionalString(value["reason"]);
  if (!isMemoryPrefetchStatus(status) || !reason.ok) {
    return undefined;
  }

  return reason.value === undefined ? { status } : { status, reason: reason.value };
}

export function parseBootstrapSnapshot(raw: string): BootstrapSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const sessionId = parseOptionalString(parsed["sessionId"]);
  const sources = parseBootstrapSourceRecords(parsed["sources"]);
  const warnings = parseStringArray(parsed["warnings"]);
  const conflicts = parseStringArray(parsed["conflicts"]);
  const memoryPrefetch = parseMemoryPrefetch(parsed["memoryPrefetch"]);

  if (
    parsed["version"] !== 1 ||
    !sessionId.ok ||
    typeof parsed["workspaceRoot"] !== "string" ||
    typeof parsed["generatedAt"] !== "string" ||
    sources === undefined ||
    warnings === undefined ||
    conflicts === undefined ||
    memoryPrefetch === undefined
  ) {
    return undefined;
  }

  return {
    version: 1,
    ...(sessionId.value === undefined ? {} : { sessionId: sessionId.value }),
    workspaceRoot: parsed["workspaceRoot"],
    generatedAt: parsed["generatedAt"],
    sources,
    warnings,
    conflicts,
    memoryPrefetch,
  };
}
