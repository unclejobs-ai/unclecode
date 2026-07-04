export type MemoryFreshnessLabel = "fresh" | "recent" | "aged";

export type ScopedMemoryEntry = {
  readonly scope: "session" | "project" | "user" | "agent";
  readonly memoryId: string;
  readonly summary: string;
  readonly timestamp: string;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export function parseScopedMemoryId(memoryId: string): {
  readonly scope?: ScopedMemoryEntry["scope"];
  readonly timestamp?: string;
} {
  const match = /^memory:(session|project|user|agent):(.+):[a-f0-9]{8}$/i.exec(memoryId);
  if (!match) {
    return {};
  }

  return {
    scope: match[1] as ScopedMemoryEntry["scope"],
    ...(match[2] !== undefined ? { timestamp: match[2] } : {}),
  };
}

export function describeMemoryEntryFreshness(
  timestamp: string,
  nowMs: number = Date.now(),
): MemoryFreshnessLabel {
  const recordedAt = Date.parse(timestamp);
  if (!Number.isFinite(recordedAt)) {
    return "aged";
  }

  const ageMs = Math.max(0, nowMs - recordedAt);
  if (ageMs < ONE_HOUR_MS) {
    return "fresh";
  }
  if (ageMs < ONE_DAY_MS) {
    return "recent";
  }
  return "aged";
}

export function formatScopedMemoryTransparencyLine(
  entry: ScopedMemoryEntry,
  nowMs?: number,
): string {
  const freshness = describeMemoryEntryFreshness(entry.timestamp, nowMs);
  return `${entry.scope} · ${entry.summary} · cite ${entry.memoryId} · ${freshness}`;
}

export function formatScopedMemoryTransparencyLines(
  entries: readonly ScopedMemoryEntry[],
  nowMs?: number,
): readonly string[] {
  return entries.map((entry) => formatScopedMemoryTransparencyLine(entry, nowMs));
}
