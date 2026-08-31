import assert from "node:assert/strict";
import test from "node:test";

import { createRepoMapCache } from "@unclecode/context-broker";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function repoMap(rootDir, gitHeadSha, label = gitHeadSha) {
  return {
    rootDir,
    generatedAt: `2026-08-29T00:00:00.000Z#${label}`,
    gitHeadSha,
    entries: [],
    totalFiles: 0,
    totalLines: 0,
  };
}

test("repo-map cache coalesces concurrent misses for one exact root and head", async () => {
  const cache = createRepoMapCache();
  const loading = deferred();
  let loadCount = 0;
  const input = {
    rootDir: "/workspace/coalesced",
    gitHeadSha: "head-a",
    loader() {
      loadCount += 1;
      return loading.promise;
    },
  };

  const loads = Array.from({ length: 64 }, () => cache.load(input));
  await Promise.resolve();
  assert.equal(loadCount, 1);

  const loadedMap = repoMap(input.rootDir, input.gitHeadSha);
  loading.resolve(loadedMap);
  const results = await Promise.all(loads);

  assert.ok(results.every((result) => result.repoMap === loadedMap));
  assert.ok(results.every((result) => result.cacheHit === false));
  assert.equal(cache.snapshot().currentSize, 1);

  const cached = await cache.load({
    ...input,
    loader: async () => { throw new Error("cached entry unexpectedly reloaded"); },
  });
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.repoMap, loadedMap);
});

test("repo-map cache keeps different head keys independent and rejects late stale replacement", async () => {
  const cache = createRepoMapCache();
  const firstLoad = deferred();
  const secondLoad = deferred();
  let loadCount = 0;
  const rootDir = "/workspace/versioned";

  const first = cache.load({
    rootDir,
    gitHeadSha: "head-old",
    loader() {
      loadCount += 1;
      return firstLoad.promise;
    },
  });
  const second = cache.load({
    rootDir,
    gitHeadSha: "head-new",
    loader() {
      loadCount += 1;
      return secondLoad.promise;
    },
  });
  await Promise.resolve();
  assert.equal(loadCount, 2);

  const newMap = repoMap(rootDir, "head-new", "new");
  secondLoad.resolve(newMap);
  assert.equal((await second).repoMap, newMap);

  const oldMap = repoMap(rootDir, "head-old", "old");
  firstLoad.resolve(oldMap);
  assert.equal((await first).repoMap, oldMap);

  const cachedNew = await cache.load({
    rootDir,
    gitHeadSha: "head-new",
    loader: async () => { throw new Error("newer map was replaced by a stale load"); },
  });
  assert.equal(cachedNew.cacheHit, true);
  assert.equal(cachedNew.repoMap, newMap);
  assert.equal(cache.snapshot().currentSize, 1);
});

test("repo-map cache clears a failed in-flight load for retry without evicting the existing head", async () => {
  const cache = createRepoMapCache();
  const rootDir = "/workspace/retry";
  const stableMap = repoMap(rootDir, "head-stable", "stable");
  await cache.load({
    rootDir,
    gitHeadSha: "head-stable",
    loader: async () => stableMap,
  });

  const failedLoad = deferred();
  let failedLoadCount = 0;
  const failingInput = {
    rootDir,
    gitHeadSha: "head-failed",
    loader() {
      failedLoadCount += 1;
      return failedLoad.promise;
    },
  };
  const firstFailure = cache.load(failingInput);
  const joinedFailure = cache.load(failingInput);
  await Promise.resolve();
  assert.equal(failedLoadCount, 1);
  failedLoad.reject(new Error("repo-map loader failed"));
  await assert.rejects(firstFailure, /repo-map loader failed/);
  await assert.rejects(joinedFailure, /repo-map loader failed/);

  const cachedStable = await cache.load({
    rootDir,
    gitHeadSha: "head-stable",
    loader: async () => { throw new Error("failed load evicted the stable map"); },
  });
  assert.equal(cachedStable.cacheHit, true);
  assert.equal(cachedStable.repoMap, stableMap);

  const retryMap = repoMap(rootDir, "head-failed", "retry");
  const retried = await cache.load({
    rootDir,
    gitHeadSha: "head-failed",
    loader: async () => {
      failedLoadCount += 1;
      return retryMap;
    },
  });
  assert.equal(failedLoadCount, 2);
  assert.equal(retried.cacheHit, false);
  assert.equal(retried.repoMap, retryMap);

  const cachedRetry = await cache.load({
    rootDir,
    gitHeadSha: "head-failed",
    loader: async () => { throw new Error("retry result was not cached"); },
  });
  assert.equal(cachedRetry.cacheHit, true);
  assert.equal(cachedRetry.repoMap, retryMap);
  assert.equal(cache.snapshot().currentSize, 1);
});

test("repo-map cache bounds active loaders and coalesces a same-key request waiting beyond the cap", async () => {
  const cache = createRepoMapCache({ maxEntries: 2 });
  const loaders = Array.from({ length: 3 }, () => deferred());
  const loadCounts = [0, 0, 0];
  let activeLoaders = 0;
  let peakActiveLoaders = 0;

  function load(index) {
    return cache.load({
      rootDir: `/workspace/bounded-${index}`,
      gitHeadSha: `head-${index}`,
      loader() {
        loadCounts[index] += 1;
        activeLoaders += 1;
        peakActiveLoaders = Math.max(peakActiveLoaders, activeLoaders);
        return loaders[index].promise.finally(() => {
          activeLoaders -= 1;
        });
      },
    });
  }

  const first = load(0);
  const second = load(1);
  const queued = load(2);
  const joinedQueued = load(2);
  await Promise.resolve();
  assert.deepEqual(loadCounts, [1, 1, 0]);
  assert.equal(activeLoaders, 2);
  assert.equal(peakActiveLoaders, 2);

  loaders[0].resolve(repoMap("/workspace/bounded-0", "head-0"));
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loadCounts, [1, 1, 1]);
  assert.equal(activeLoaders, 2);
  assert.equal(peakActiveLoaders, 2);

  const queuedMap = repoMap("/workspace/bounded-2", "head-2");
  loaders[2].resolve(queuedMap);
  const [queuedResult, joinedResult] = await Promise.all([queued, joinedQueued]);
  assert.equal(queuedResult.repoMap, queuedMap);
  assert.equal(joinedResult.repoMap, queuedMap);
  assert.equal(loadCounts[2], 1);

  loaders[1].resolve(repoMap("/workspace/bounded-1", "head-1"));
  await second;
  assert.equal(activeLoaders, 0);
  assert.equal(peakActiveLoaders, 2);
});
