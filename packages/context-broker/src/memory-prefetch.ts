import {
  listScopedMemoryEntries,
  type MemoryLineageAdapter,
  type MemoryScope,
} from "./context-memory.js";
import {
  formatScopedMemoryTransparencyLines,
  type ScopedMemoryEntry,
} from "./memory-transparency.js";

export const DEFAULT_MEMORY_PREFETCH_TIMEOUT_MS = 2_000;

export type MemoryPrefetchStatus = "ok" | "empty" | "degraded";

export type MemoryPrefetchResult = {
  readonly lines: readonly string[];
  readonly entries: readonly ScopedMemoryEntry[];
  readonly status: MemoryPrefetchStatus;
  readonly reason?: string;
};

const DEFAULT_PREFETCH_SCOPES: readonly MemoryScope[] = ["session", "project"];

const BOOTSTRAP_SYNTHETIC_MEMORY_PREFIX = /^Bootstrap context:/;

function isBootstrapSyntheticMemory(entry: ScopedMemoryEntry): boolean {
  return BOOTSTRAP_SYNTHETIC_MEMORY_PREFIX.test(entry.summary.trim());
}

async function withPrefetchTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`memory prefetch timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function loadPrefetchEntries(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly scopes: readonly MemoryScope[];
  readonly limit: number;
  readonly lineage?: MemoryLineageAdapter;
}): Promise<readonly ScopedMemoryEntry[]> {
  const batches = await Promise.all(
    input.scopes.map(async (scope) => {
      try {
        return await listScopedMemoryEntries({
          scope,
          cwd: input.cwd,
          ...(input.env ? { env: input.env } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.lineage ? { lineage: input.lineage } : {}),
        });
      } catch {
        return [];
      }
    }),
  );

  return batches
    .flat()
    .filter((entry) => !isBootstrapSyntheticMemory(entry))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, input.limit);
}

export type MemoryPrefetchLoader = typeof loadPrefetchEntries;

export async function prefetchScopedMemory(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly scopes?: readonly MemoryScope[];
  readonly timeoutMs?: number;
  readonly limit?: number;
  readonly loadEntries?: MemoryPrefetchLoader;
  readonly lineage?: MemoryLineageAdapter;
}): Promise<MemoryPrefetchResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_MEMORY_PREFETCH_TIMEOUT_MS;
  const scopes = input.scopes ?? DEFAULT_PREFETCH_SCOPES;
  const limit = input.limit ?? 6;
  const loadEntries = input.loadEntries ?? loadPrefetchEntries;

  try {
    const entries = await withPrefetchTimeout(
      loadEntries({
        cwd: input.cwd,
        scopes,
        limit,
        ...(input.env ? { env: input.env } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.lineage ? { lineage: input.lineage } : {}),
      }),
      timeoutMs,
    );
    const lines = formatScopedMemoryTransparencyLines(entries);

    return {
      lines,
      entries,
      status: lines.length > 0 ? "ok" : "empty",
    };
  } catch (error) {
    return {
      lines: [],
      entries: [],
      status: "degraded",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
