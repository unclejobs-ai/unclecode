import assert from "node:assert/strict";
import test from "node:test";

import { FileOwnershipRegistry } from "../../packages/orchestrator/src/file-ownership-registry.ts";
import { runBoundedExecutorPool } from "../../packages/orchestrator/src/turn-orchestrator.ts";

// Split out of tests/contracts/orchestrator-multi-agent.contract.test.mjs.
// These two concerns share a file because both protect multi-agent
// runtime isolation: bounded concurrency and exclusive file ownership.

test("runBoundedExecutorPool respects maxWorkers concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await runBoundedExecutorPool({
    tasks: Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      summary: `task ${i}`,
    })),
    maxWorkers: 2,
    async executeTask(task) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { id: task.id, done: true };
    },
  });

  assert.equal(results.length, 6);
  assert.ok(peak <= 2, `peak concurrency ${peak} should be <= 2`);
});

test("FileOwnershipRegistry prevents concurrent writes to the same file", () => {
  const registry = new FileOwnershipRegistry();
  assert.equal(registry.claim("worker-1", "src/auth.ts"), true);
  assert.equal(registry.claim("worker-2", "src/auth.ts"), false);
  assert.equal(registry.claim("worker-2", "src/login.ts"), true);
  registry.releaseAll("worker-1");
  assert.equal(registry.claim("worker-2", "src/auth.ts"), true);
});

test("FileOwnershipRegistry claimAll is atomic — fails without partial claims", () => {
  const registry = new FileOwnershipRegistry();
  registry.claim("worker-1", "a.ts");
  const result = registry.claimAll("worker-2", ["a.ts", "b.ts"]);
  assert.equal(result, false, "claimAll should fail if any file is owned");
  assert.equal(
    registry.claim("worker-3", "b.ts"),
    true,
    "claimAll must not retain partial claims after failure",
  );
});
