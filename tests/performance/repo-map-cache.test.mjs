import assert from "node:assert/strict";
import test from "node:test";

import { createRepoMapCache } from "../../packages/context-broker/src/repo-map-cache.ts";

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("createRepoMapCache reuses a repo map for the same root and git head", async () => {
  const cache = createRepoMapCache();
  let loadCount = 0;

  const first = await cache.load({
    rootDir: "/repo",
    gitHeadSha: "abc123",
    loader: async () => {
      loadCount += 1;
      return {
        rootDir: "/repo",
        generatedAt: "2026-04-05T00:00:00.000Z",
        gitHeadSha: "abc123",
        entries: [],
        totalFiles: 0,
        totalLines: 0,
      };
    },
  });

  const second = await cache.load({
    rootDir: "/repo",
    gitHeadSha: "abc123",
    loader: async () => {
      loadCount += 1;
      return {
        rootDir: "/repo",
        generatedAt: "2026-04-05T00:00:01.000Z",
        gitHeadSha: "abc123",
        entries: [],
        totalFiles: 0,
        totalLines: 0,
      };
    },
  });

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(loadCount, 1);
  assert.equal(second.repoMap.gitHeadSha, "abc123");
  const snapshot = cache.snapshot();
  assert.equal(snapshot.name, "repo-map");
  assert.equal(snapshot.hits, 1);
  assert.equal(snapshot.misses, 1);
  assert.equal(snapshot.evictions, 0);
  assert.equal(snapshot.invalidations, 0);
  assert.equal(snapshot.currentSize, 1);
  assert.equal(snapshot.maxEntries, 8);
  assert.ok(snapshot.maxRetainedBytes > 0);
  assert.ok(snapshot.retainedBytesEstimate > 0);
});

test("createRepoMapCache invalidates when the git head changes", async () => {
  const cache = createRepoMapCache();
  let loadCount = 0;

  await cache.load({
    rootDir: "/repo",
    gitHeadSha: "abc123",
    loader: async () => {
      loadCount += 1;
      return {
        rootDir: "/repo",
        generatedAt: "2026-04-05T00:00:00.000Z",
        gitHeadSha: "abc123",
        entries: [],
        totalFiles: 0,
        totalLines: 0,
      };
    },
  });

  const next = await cache.load({
    rootDir: "/repo",
    gitHeadSha: "def456",
    loader: async () => {
      loadCount += 1;
      return {
        rootDir: "/repo",
        generatedAt: "2026-04-05T00:00:02.000Z",
        gitHeadSha: "def456",
        entries: [],
        totalFiles: 0,
        totalLines: 0,
      };
    },
  });

  assert.equal(next.cacheHit, false);
  assert.equal(loadCount, 2);
  assert.equal(next.repoMap.gitHeadSha, "def456");
  assert.equal(cache.snapshot().invalidations, 1);
  assert.equal(cache.snapshot().currentSize, 1);
});

test("createRepoMapCache evicts the least-recently-used root without invalidating another root", async () => {
  const cache = createRepoMapCache({ maxEntries: 2 });
  const loads = new Map();
  const load = async (rootDir, gitHeadSha) => await cache.load({
    rootDir,
    gitHeadSha,
    loader: async () => {
      loads.set(`${rootDir}:${gitHeadSha}`, (loads.get(`${rootDir}:${gitHeadSha}`) ?? 0) + 1);
      return {
        rootDir,
        generatedAt: "2026-04-05T00:00:00.000Z",
        gitHeadSha,
        entries: [],
        totalFiles: 0,
        totalLines: 0,
      };
    },
  });

  await load("/repo-a", "head-1");
  await load("/repo-b", "head-1");
  assert.equal((await load("/repo-a", "head-1")).cacheHit, true);
  await load("/repo-c", "head-1");

  const beforeReload = cache.snapshot();
  assert.equal(beforeReload.evictions, 1);
  assert.equal(beforeReload.invalidations, 0);
  assert.equal(beforeReload.currentSize, 2);
  assert.equal((await load("/repo-b", "head-1")).cacheHit, false);
  assert.equal(loads.get("/repo-a:head-1"), 1);
  assert.equal(loads.get("/repo-b:head-1"), 2);
});

test("createRepoMapCache keeps retained size bounded under repeated head churn", async () => {
  const cache = createRepoMapCache({ maxEntries: 3 });

  for (let index = 0; index < 2_000; index += 1) {
    await cache.load({
      rootDir: "/repo",
      gitHeadSha: `head-${index}`,
      loader: async () => ({
        rootDir: "/repo",
        generatedAt: "2026-04-05T00:00:00.000Z",
        gitHeadSha: `head-${index}`,
        entries: [{
          path: `src/file-${index}.ts`,
          lastModified: "2026-04-05T00:00:00.000Z",
          lineCount: index,
          changeFrequency: 1,
          hotspotScore: 1,
        }],
        totalFiles: 1,
        totalLines: index,
      }),
    });
  }

  const snapshot = cache.snapshot();
  assert.equal(snapshot.currentSize, 1);
  assert.equal(snapshot.invalidations, 1_999);
  assert.ok(snapshot.retainedBytesEstimate < 1_000);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snapshot)));
});

test("createRepoMapCache commits one exact version after concurrent head misses", async () => {
  const cache = createRepoMapCache({ maxEntries: 4 });
  const headA = createDeferred();
  const headB = createDeferred();
  const load = (gitHeadSha, deferred) => cache.load({
    rootDir: "/repo",
    gitHeadSha,
    loader: async () => {
      await deferred.promise;
      return {
        rootDir: "/repo",
        generatedAt: "2026-04-05T00:00:00.000Z",
        gitHeadSha,
        entries: [],
        totalFiles: 0,
        totalLines: 0,
      };
    },
  });

  const loadingA = load("head-a", headA);
  const loadingB = load("head-b", headB);
  headA.resolve();
  await loadingA;
  headB.resolve();
  await loadingB;

  assert.equal(cache.snapshot().currentSize, 1);
  assert.equal(cache.snapshot().invalidations, 1);
  assert.equal((await load("head-b", createDeferred())).cacheHit, true);
});

test("createRepoMapCache preserves the prior exact entry when a refresh loader fails", async () => {
  const cache = createRepoMapCache();
  const original = {
    rootDir: "/repo",
    generatedAt: "2026-04-05T00:00:00.000Z",
    gitHeadSha: "head-a",
    entries: [],
    totalFiles: 0,
    totalLines: 0,
  };
  await cache.load({ rootDir: "/repo", gitHeadSha: "head-a", loader: async () => original });

  await assert.rejects(
    cache.load({
      rootDir: "/repo",
      gitHeadSha: "head-b",
      loader: async () => {
        throw new Error("repo-map refresh failed");
      },
    }),
    /repo-map refresh failed/,
  );

  const reused = await cache.load({
    rootDir: "/repo",
    gitHeadSha: "head-a",
    loader: async () => assert.fail("prior exact entry should survive"),
  });
  assert.equal(reused.cacheHit, true);
  assert.equal(reused.repoMap, original);
  assert.equal(cache.snapshot().invalidations, 0);
});

test("createRepoMapCache estimates a large map from retained entry fields", async () => {
  const cache = createRepoMapCache();
  const entries = Array.from({ length: 100_000 }, (_, index) => ({
    path: `src/generated/file-${index}.ts`,
    lastModified: "2026-04-05T00:00:00.000Z",
    lineCount: 1,
    changeFrequency: 1,
    hotspotScore: 1,
  }));

  await cache.load({
    rootDir: "/large-repo",
    gitHeadSha: "head-a",
    loader: async () => ({
      rootDir: "/large-repo",
      generatedAt: "2026-04-05T00:00:00.000Z",
      gitHeadSha: "head-a",
      entries,
      totalFiles: 100_000,
      totalLines: 5_000_000,
    }),
  });

  const snapshot = cache.snapshot();
  assert.equal(snapshot.currentSize, 1);
  assert.ok(snapshot.retainedBytesEstimate > 10_000_000);
});

test("createRepoMapCache rejects a long retained path that exceeds its byte budget", async () => {
  const cache = createRepoMapCache({ maxEntries: 8, maxRetainedBytes: 1_000 });
  const load = () => cache.load({
    rootDir: "/long-path-repo",
    gitHeadSha: "head-a",
    loader: async () => ({
      rootDir: "/long-path-repo",
      generatedAt: "2026-04-05T00:00:00.000Z",
      gitHeadSha: "head-a",
      entries: [{
        path: `src/${"nested-".repeat(500)}file.ts`,
        lastModified: "2026-04-05T00:00:00.000Z",
        lineCount: 1,
        changeFrequency: 1,
        hotspotScore: 1,
      }],
      totalFiles: 1,
      totalLines: 1,
    }),
  });

  assert.equal((await load()).cacheHit, false);
  assert.equal(cache.snapshot().currentSize, 0);
  assert.equal(cache.snapshot().byteEvictions, 1);
  assert.equal((await load()).cacheHit, false);
});

test("createRepoMapCache does not retain a single map larger than its byte budget", async () => {
  const cache = createRepoMapCache({ maxEntries: 8, maxRetainedBytes: 1_000 });
  let loadCount = 0;
  const load = () => cache.load({
    rootDir: "/oversized-repo",
    gitHeadSha: "head-a",
    loader: async () => {
      loadCount += 1;
      return {
        rootDir: "/oversized-repo",
        generatedAt: "2026-04-05T00:00:00.000Z",
        gitHeadSha: "head-a",
        entries: Array.from({ length: 100 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          lastModified: "2026-04-05T00:00:00.000Z",
          lineCount: 1,
          changeFrequency: 1,
          hotspotScore: 1,
        })),
        totalFiles: 100,
        totalLines: 100,
      };
    },
  });

  assert.equal((await load()).cacheHit, false);
  assert.equal((await load()).cacheHit, false);
  const snapshot = cache.snapshot();
  assert.equal(loadCount, 2);
  assert.equal(snapshot.currentSize, 0);
  assert.equal(snapshot.retainedBytesEstimate, 0);
  assert.equal(snapshot.maxRetainedBytes, 1_000);
  assert.equal(snapshot.byteEvictions, 2);
});
