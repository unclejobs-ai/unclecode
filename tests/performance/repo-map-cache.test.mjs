import assert from "node:assert/strict";
import test from "node:test";

import { createRepoMapCache } from "../../packages/context-broker/src/repo-map-cache.ts";

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
});
