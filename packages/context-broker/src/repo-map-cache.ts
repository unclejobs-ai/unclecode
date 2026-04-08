import type { RepoMap } from "./types.js";

type RepoMapCacheEntry = {
  readonly cacheKey: string;
  readonly repoMap: RepoMap;
};

export function createRepoMapCache(options?: { readonly maxEntries?: number }) {
  const maxEntries = Math.max(1, options?.maxEntries ?? 8);
  const entries = new Map<string, RepoMapCacheEntry>();

  return {
    async load(input: {
      readonly rootDir: string;
      readonly gitHeadSha: string;
      readonly loader: () => Promise<RepoMap>;
    }): Promise<{ readonly repoMap: RepoMap; readonly cacheHit: boolean }> {
      const cacheKey = `${input.rootDir}::${input.gitHeadSha}`;
      const cached = entries.get(cacheKey);

      if (cached) {
        entries.delete(cacheKey);
        entries.set(cacheKey, cached);
        return { repoMap: cached.repoMap, cacheHit: true };
      }

      const repoMap = await input.loader();
      entries.set(cacheKey, { cacheKey, repoMap });

      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (typeof oldestKey !== "string") {
          break;
        }
        entries.delete(oldestKey);
      }

      return { repoMap, cacheHit: false };
    },
  };
}

export const defaultRepoMapCache = createRepoMapCache();
