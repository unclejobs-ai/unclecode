import { createInstrumentedLruCache } from "@unclecode/contracts";

import type { RepoMap } from "./types.js";

type RepoMapCacheEntry = {
  readonly rootDir: string;
  readonly repoMap: RepoMap;
};

const REPO_MAP_ENTRY_RETAINED_BYTES_ESTIMATE = 96;
const REPO_MAP_CACHE_MAX_RETAINED_BYTES = 64 * 1024 * 1024;

function estimateRepoMapCacheEntryBytes(cacheKey: string, entry: RepoMapCacheEntry): number {
  const map = entry.repoMap;
  const reportedFiles = Number.isFinite(map.totalFiles) ? Math.max(0, map.totalFiles) : 0;
  const entryCount = Math.max(map.entries.length, reportedFiles);
  const summaryCodeUnits = cacheKey.length
    + entry.rootDir.length
    + map.generatedAt.length
    + map.gitHeadSha.length;
  const measuredEntryBytes = map.entries.reduce(
    (total, mapEntry) => total
      + REPO_MAP_ENTRY_RETAINED_BYTES_ESTIMATE
      + mapEntry.path.length * 2
      + mapEntry.lastModified.length * 2,
    0,
  );
  const unmaterializedEntryCount = Math.max(0, entryCount - map.entries.length);

  // Account for every retained path. A fixed per-entry estimate alone lets a
  // repository with long valid paths exceed the advertised byte budget while
  // telemetry still reports a small cache. `totalFiles` can exceed the
  // materialized list, so keep a conservative allowance for omitted entries.
  return summaryCodeUnits * 2
    + measuredEntryBytes
    + unmaterializedEntryCount * REPO_MAP_ENTRY_RETAINED_BYTES_ESTIMATE;
}

export function createRepoMapCache(options?: {
  readonly maxEntries?: number;
  readonly maxRetainedBytes?: number;
}) {
  const maxEntries = Math.max(1, options?.maxEntries ?? 8);
  const entries = createInstrumentedLruCache<string, RepoMapCacheEntry>({
    name: "repo-map",
    maxEntries,
    maxRetainedBytes: options?.maxRetainedBytes ?? REPO_MAP_CACHE_MAX_RETAINED_BYTES,
    estimateEntryBytes: estimateRepoMapCacheEntryBytes,
  });

  return {
    async load(input: {
      readonly rootDir: string;
      readonly gitHeadSha: string;
      readonly loader: () => Promise<RepoMap>;
    }): Promise<{ readonly repoMap: RepoMap; readonly cacheHit: boolean }> {
      const cacheKey = JSON.stringify([input.rootDir, input.gitHeadSha]);
      const cached = entries.lookup(cacheKey);

      if (cached.hit) {
        return { repoMap: cached.value.repoMap, cacheHit: true };
      }

      const repoMap = await input.loader();

      for (const [entryKey, entry] of entries.entries()) {
        if (entry.rootDir === input.rootDir && entryKey !== cacheKey) {
          entries.invalidate(entryKey);
        }
      }

      entries.set(cacheKey, { rootDir: input.rootDir, repoMap });

      return { repoMap, cacheHit: false };
    },

    snapshot() {
      return entries.snapshot();
    },
  };
}

export const defaultRepoMapCache = createRepoMapCache();
