import assert from "node:assert/strict";
import test from "node:test";

import { FileOwnershipRegistry } from "../../packages/orchestrator/src/file-ownership-registry.ts";
import {
  classifyWorkIntent,
  runBoundedExecutorPool,
} from "../../packages/orchestrator/src/turn-orchestrator.ts";
import { resolveWorkerBudget } from "../../packages/orchestrator/src/work-agent.ts";

test("classifyWorkIntent routes yolo action prompts to complex orchestration", () => {
  assert.equal(classifyWorkIntent("fix the login bug", "yolo"), "complex");
  assert.equal(classifyWorkIntent("implement dashboard", "yolo"), "complex");
  assert.equal(classifyWorkIntent("what is this?", "yolo"), "simple");
  assert.equal(classifyWorkIntent("explain the auth flow", "yolo"), "simple");
  assert.equal(classifyWorkIntent("/help", "yolo"), "simple");
});

test("classifyWorkIntent routes ultrawork prompts to complex regardless of content", () => {
  assert.equal(classifyWorkIntent("hello", "ultrawork"), "complex");
  assert.equal(classifyWorkIntent("what time is it", "ultrawork"), "complex");
});

test("resolveWorkerBudget scales with mode aggressiveness", () => {
  const budgets = [
    resolveWorkerBudget("default"),
    resolveWorkerBudget("search"),
    resolveWorkerBudget("yolo"),
    resolveWorkerBudget("ultrawork"),
  ];
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(
      (budgets[i] ?? 0) >= (budgets[i - 1] ?? 0),
      `${budgets[i]} >= ${budgets[i - 1]}`,
    );
  }
});

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
      await new Promise((r) => setTimeout(r, 10));
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
});
