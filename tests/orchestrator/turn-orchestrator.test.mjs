import assert from "node:assert/strict";
import test from "node:test";

import {
  FileOwnershipRegistry,
  classifyWorkIntent,
  createTurnOrchestrator,
  runBoundedExecutorPool,
} from "../../packages/orchestrator/src/index.ts";

test("classifyWorkIntent keeps fast paths simple and routes explicit complex or research work", () => {
  assert.equal(classifyWorkIntent("/doctor", "default"), "simple");
  assert.equal(classifyWorkIntent("inspect repo", "analyze"), "research");
  assert.equal(classifyWorkIntent("inspect repo", "ultrawork"), "complex");
  assert.equal(
    classifyWorkIntent("refactor login.ts oauth.ts session.ts", "default"),
    "complex",
  );
  assert.equal(classifyWorkIntent("summarize this file", "default"), "simple");
});

test("createTurnOrchestrator executes complex plans with bounded concurrency and real steps", async () => {
  let activeWorkers = 0;
  let maxWorkers = 0;
  const traces = [];

  const orchestrator = createTurnOrchestrator({
    async runSimpleTurn(prompt) {
      return { text: `simple:${prompt}` };
    },
    async runResearchTurn(prompt) {
      return { text: `research:${prompt}` };
    },
    async planComplexTurn() {
      return [
        { id: "task-1", summary: "Inspect login.ts" },
        { id: "task-2", summary: "Inspect oauth.ts" },
        { id: "task-3", summary: "Inspect session.ts" },
      ];
    },
    async executeComplexTask(task) {
      activeWorkers += 1;
      maxWorkers = Math.max(maxWorkers, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeWorkers -= 1;
      return { id: task.id, summary: `done:${task.summary}` };
    },
  });

  const result = await orchestrator.run({
    prompt: "refactor login.ts oauth.ts session.ts",
    mode: "default",
    maxWorkers: 2,
    onTrace(event) {
      traces.push(event);
    },
  });

  assert.equal(result.kind, "complex");
  assert.equal(maxWorkers, 2);
  assert.deepEqual(result.results.map((item) => item.id), ["task-1", "task-2", "task-3"]);
  assert.ok(
    traces.some(
      (event) => event.role === "planner" && event.status === "completed",
    ),
  );
  assert.equal(
    traces.filter((event) => event.role === "executor" && event.status === "running").length,
    3,
  );
  assert.ok(
    traces.some(
      (event) => event.role === "coordinator" && event.status === "completed",
    ),
  );
});

test("runBoundedExecutorPool serializes overlapping write claims while keeping unrelated work parallel", async () => {
  const registry = new FileOwnershipRegistry();
  const executionOrder = [];
  let activeWorkers = 0;
  let maxWorkers = 0;

  const results = await runBoundedExecutorPool({
    tasks: [
      { id: "task-1", summary: "Update login.ts", writePaths: ["src/login.ts"] },
      { id: "task-2", summary: "Update login.ts again", writePaths: ["src/login.ts"] },
      { id: "task-3", summary: "Update oauth.ts", writePaths: ["src/oauth.ts"] },
    ],
    maxWorkers: 3,
    ownershipRegistry: registry,
    async executeTask(task) {
      executionOrder.push(`start:${task.id}`);
      activeWorkers += 1;
      maxWorkers = Math.max(maxWorkers, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, task.id === "task-1" ? 25 : 5));
      activeWorkers -= 1;
      executionOrder.push(`done:${task.id}`);
      return task.id;
    },
  });

  assert.deepEqual(results, ["task-1", "task-2", "task-3"]);
  assert.equal(maxWorkers, 2);
  assert.ok(executionOrder.indexOf("done:task-1") < executionOrder.indexOf("start:task-2"));
  assert.equal(registry.claim("probe", "src/login.ts"), true);
});

test("createTurnOrchestrator runs guardian auto-review after complex execution", async () => {
  const calls = [];
  const traces = [];
  const orchestrator = createTurnOrchestrator({
    async runSimpleTurn(prompt) {
      calls.push(["simple", prompt]);
      return { text: `simple:${prompt}` };
    },
    async runResearchTurn(prompt) {
      calls.push(["research", prompt]);
      return { text: `research:${prompt}` };
    },
    async planComplexTurn() {
      calls.push(["plan"]);
      return [{ id: "task-1", summary: "Inspect login.ts", writePaths: ["src/login.ts"] }];
    },
    async executeComplexTask(task) {
      calls.push(["execute", task.id]);
      return { id: task.id, summary: `done:${task.summary}` };
    },
    async runGuardianReview(input) {
      calls.push(["guardian", input.results.length, input.tasks[0]?.id]);
      return { summary: `guardian:${input.results.length}` };
    },
  });

  const result = await orchestrator.run({
    prompt: "refactor login.ts",
    mode: "ultrawork",
    onTrace(event) {
      traces.push(event);
    },
  });

  assert.equal(result.kind, "complex");
  assert.equal(result.guardian?.summary, "guardian:1");
  assert.deepEqual(calls, [
    ["plan"],
    ["execute", "task-1"],
    ["guardian", 1, "task-1"],
  ]);
  assert.ok(
    traces.some(
      (event) => event.role === "reviewer" && event.status === "running" && event.summary.includes("Guardian"),
    ),
  );
  assert.ok(
    traces.some(
      (event) => event.role === "reviewer" && event.status === "completed" && event.summary.includes("guardian:1"),
    ),
  );
});

test("createTurnOrchestrator preserves direct simple and research paths", async () => {
  const calls = [];
  const orchestrator = createTurnOrchestrator({
    async runSimpleTurn(prompt) {
      calls.push(["simple", prompt]);
      return { text: `simple:${prompt}` };
    },
    async runResearchTurn(prompt) {
      calls.push(["research", prompt]);
      return { text: `research:${prompt}` };
    },
    async planComplexTurn() {
      calls.push(["plan"]);
      return [];
    },
    async executeComplexTask(task) {
      calls.push(["execute", task.id]);
      return { id: task.id, summary: task.summary };
    },
  });

  const simple = await orchestrator.run({
    prompt: "summarize this file",
    mode: "default",
  });
  const research = await orchestrator.run({
    prompt: "inspect repo",
    mode: "analyze",
  });

  assert.equal(simple.kind, "simple");
  assert.equal(simple.text, "simple:summarize this file");
  assert.equal(research.kind, "research");
  assert.equal(research.text, "research:inspect repo");
  assert.deepEqual(calls, [
    ["simple", "summarize this file"],
    ["research", "inspect repo"],
  ]);
});
