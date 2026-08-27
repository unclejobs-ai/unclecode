import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as orchestrator from "@unclecode/orchestrator";
import {
  PluginHost,
  registerBuiltInSccQualityEngine,
} from "@unclecode/plugin-host";

const supportedReasoning = {
  effort: "medium",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

const qualityPlan = JSON.stringify([
  {
    id: "task-1",
    summary: "Set the implementation pattern",
    prompt: "Implement login.ts",
    goal: "Refactor authentication safely",
    constraints: ["Preserve public behavior"],
    acceptanceCriteria: ["Login tests pass"],
    dependsOn: [],
    writePaths: ["login.ts"],
  },
  {
    id: "task-2",
    summary: "Follow the implementation pattern",
    prompt: "Implement session.ts",
    goal: "Refactor authentication safely",
    constraints: ["Preserve public behavior"],
    acceptanceCriteria: ["Session tests pass"],
    dependsOn: ["task-1"],
    writePaths: ["session.ts"],
  },
]);

const passingCriticVerdict = JSON.stringify({
  verdict: "pass",
  summary: "Implementation matches the requested acceptance criteria.",
  findings: [],
});

test("balanced-prewalk uses direct frontier for pattern setting and commodity only for followers", () => {
  const directRoute = { provider: "openai", model: "gpt-5.4" };
  const commodityRoute = { provider: "omp", model: "kimi-code/k3" };

  assert.deepEqual(
    orchestrator.resolveBalancedPrewalkRoute({ stage: "plan", directRoute, commodityRoute }),
    { stage: "plan", route: "frontier", executor: "direct", ...directRoute, independent: false },
  );
  assert.deepEqual(
    orchestrator.resolveBalancedPrewalkRoute({
      stage: "work",
      workerIndex: 0,
      directRoute,
      commodityRoute,
    }),
    { stage: "work", route: "frontier", executor: "direct", ...directRoute, independent: false },
  );
  assert.deepEqual(
    orchestrator.resolveBalancedPrewalkRoute({
      stage: "work",
      workerIndex: 1,
      directRoute,
      commodityRoute,
    }),
    { stage: "work", route: "commodity", executor: "commodity", ...commodityRoute, independent: false },
  );
  assert.deepEqual(
    orchestrator.resolveBalancedPrewalkRoute({
      stage: "critic",
      directRoute,
      commodityRoute,
      producerRoutes: [directRoute, commodityRoute],
    }),
    { stage: "critic", route: "direct", executor: "direct", ...directRoute, independent: false },
  );
  assert.deepEqual(
    orchestrator.resolveBalancedPrewalkRoute({
      stage: "critic",
      directRoute,
      commodityRoute,
      reviewRoute: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      producerRoutes: [directRoute, commodityRoute],
    }),
    {
      stage: "critic",
      route: "direct",
      executor: "reviewer",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      independent: true,
    },
  );
});

test("WorkAgent runs the real quality lifecycle, persists hashed artifacts, and reports non-independent review unproven", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-runtime-"));
  const traces = [];
  const directCalls = [];
  const commodityCalls = [];
  const hookCalls = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  host.register("observer", {
    runClassified: () => { hookCalls.push("classified"); return { action: "proceed" }; },
    planCreated: () => { hookCalls.push("planned"); return { action: "proceed" }; },
    beforeNodeDispatch: ({ node }) => { hookCalls.push(`before:${node.id}`); return { action: "proceed" }; },
    afterNodeCompleted: ({ node }) => { hookCalls.push(`after:${node.id}`); return { action: "proceed" }; },
    beforeRunComplete: () => { hookCalls.push("complete"); return { action: "proceed" }; },
    contextContribute: () => ({ content: "Bounded project quality standards." }),
  });

  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      directCalls.push(prompt);
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) {
        writeFileSync(path.join(workspace, "login.ts"), "export const login = true;\n");
        return { text: "pattern worker complete" };
      }
      throw new Error(`unexpected direct quality prompt: ${prompt}`);
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      directCalls.push(prompt);
      if (prompt.includes("Synthesize executor findings")) return { text: "synthesis handoff" };
      return { text: passingCriticVerdict };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      reviewAgent,
      async createExecutorAgent() {
        return {
          clear() {},
          updateRuntimeSettings() {},
          setTraceListener() {},
          async runTurn(prompt) {
            commodityCalls.push(prompt);
            writeFileSync(path.join(workspace, "session.ts"), "export const session = true;\n");
            return { text: "commodity worker complete" };
          },
        };
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      reviewRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
    });
    agent.setTraceListener((event) => traces.push(event));

    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.text, "synthesis handoff");
    assert.equal(result.qualityStatus, "unproven");
    assert.deepEqual(hookCalls, [
      "classified",
      "planned",
      "before:task-1",
      "after:task-1",
      "before:task-2",
      "after:task-2",
      "complete",
    ]);
    assert.ok(directCalls.some((prompt) => prompt.includes("Implement login.ts")));
    assert.ok(commodityCalls.some((prompt) => prompt.includes("Implement session.ts")));
    assert.ok([...directCalls, ...commodityCalls].every((prompt) =>
      prompt.includes("SCC Quality Engine") || prompt.includes("Bounded project quality standards")
    ));
    const criticPrompt = directCalls.find((prompt) => prompt.includes("Artifact manifest:"));
    const promotePrompt = directCalls.find((prompt) => prompt.includes("Synthesize executor findings"));
    assert.match(criticPrompt ?? "", /<quality_critic_read_only>/);
    assert.match(criticPrompt ?? "", /return only one JSON object/i);
    assert.match(promotePrompt ?? "", /<quality_promote_read_only>/);
    assert.match(promotePrompt ?? "", /do not invoke tools|tools are unavailable/i);

    const qualityTraces = traces.filter((event) => event.type.startsWith("quality."));
    assert.deepEqual(
      qualityTraces.filter((event) => event.type === "quality.stage_started").map((event) => [
        event.stage,
        event.provider,
        event.model,
        event.route,
      ]),
      [
        ["explore", undefined, undefined, undefined],
        ["plan", "openai", "gpt-5.4", "frontier"],
        ["work", "openai", "gpt-5.4", "frontier"],
        ["work", "omp", "kimi-code/k3", "commodity"],
        ["critic", "openai", "gpt-5.4", "direct"],
        ["promote", "openai", "gpt-5.4", "direct"],
      ],
    );
    const gate = qualityTraces.find((event) => event.type === "quality.gate_evaluated" && event.stage === "critic");
    assert.equal(gate?.decision, "unproven");
    assert.equal(gate?.independentVerification, false);
    assert.match(gate?.artifactHash ?? "", /^sha256:[a-f0-9]{64}$/);
    const workerGate = qualityTraces.find((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "work" && event.nodeId === "task-1"
    );
    assert.equal(workerGate?.nodeAttempt, 0);
    assert.deepEqual(workerGate?.artifactRefs, [
      `.unclecode/artifacts/${workerGate?.runId}/task-1-attempt-0.json`,
    ]);
    assert.equal(qualityTraces.at(-1)?.type, "quality.completed");
    assert.equal(qualityTraces.at(-1)?.decision, "unproven");

    const runIds = new Set(qualityTraces.map((event) => event.runId));
    assert.equal(runIds.size, 1);
    const [runId] = runIds;
    const artifactDir = path.join(workspace, ".unclecode", "artifacts", runId);
    const artifactFiles = readdirSync(artifactDir).sort();
    assert.deepEqual(artifactFiles, ["critic.json", "run.json", "task-1-attempt-0.json", "task-2-attempt-0.json"]);
    for (const file of artifactFiles) {
      const artifact = JSON.parse(readFileSync(path.join(artifactDir, file), "utf8"));
      assert.equal(artifact.runId, runId);
    }
    assert.throws(() => readdirSync(path.join(workspace, ".data")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a refine decision terminates explicitly instead of silently reaching critic or promote", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-refine-"));
  const traces = [];
  let factoryCalls = 0;
  const host = new PluginHost();
  host.register("refiner", {
    afterNodeCompleted: () => ({ action: "refine", reason: "add a boundary test" }),
  });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) return { text: "first pass" };
      return { text: "must not reach critic or promote" };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      async createExecutorAgent() {
        factoryCalls += 1;
        return directAgent;
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
    });
    agent.setTraceListener((event) => traces.push(event));
    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /refine requested.*add a boundary test/i);
    assert.equal(factoryCalls, 0, "the follower, critic, and promote never run after refine termination");
    assert.equal(traces.filter((event) => event.type === "quality.refine_requested").length, 1);
    assert.equal(traces.some((event) => event.type === "quality.stage_started" && event.stage === "critic"), false);
    assert.equal(traces.some((event) => event.type === "quality.stage_started" && event.stage === "promote"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed and dependency-blocked workers both reach afterNodeCompleted and block before critic", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-terminal-hooks-"));
  const terminalHooks = [];
  const unexpectedPrompts = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  host.register("terminal-observer", {
    afterNodeCompleted: ({ node, outcome }) => {
      terminalHooks.push([node.id, outcome.status]);
      return { action: "proceed" };
    },
  });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) throw new Error("worker exploded");
      unexpectedPrompts.push(prompt);
      return { text: passingCriticVerdict };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      async createExecutorAgent() {
        throw new Error("a dependency-blocked worker must not dispatch");
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
    });

    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.qualityStatus, "block");
    assert.deepEqual(terminalHooks, [["task-1", "failed"], ["task-2", "blocked"]]);
    assert.equal(unexpectedPrompts.length, 0, "worker failure must prevent critic and promote dispatch");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a cancelled worker reaches afterNodeCompleted before parent abort propagation", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-cancelled-hook-"));
  const controller = new AbortController();
  const terminalHooks = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  host.register("terminal-observer", {
    afterNodeCompleted: ({ node, outcome }) => {
      terminalHooks.push([node.id, outcome.status]);
      return { action: "proceed" };
    },
  });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt, _attachments, options) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) {
        controller.abort(new DOMException("parent cancelled", "AbortError"));
        options?.signal?.throwIfAborted();
      }
      throw new Error(`unexpected prompt after cancellation: ${prompt}`);
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
    });

    await assert.rejects(
      agent.runTurn("refactor login.ts and session.ts", [], { signal: controller.signal }),
      (error) => error?.name === "AbortError",
    );
    assert.deepEqual(terminalHooks, [["task-1", "cancelled"], ["task-2", "blocked"]]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an invalid critic verdict blocks before promote instead of becoming pass evidence", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-invalid-critic-"));
  const reviewPrompts = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) {
        writeFileSync(path.join(workspace, "login.ts"), "export const login = true;\n");
        return { text: "pattern complete" };
      }
      throw new Error(`unexpected direct prompt: ${prompt}`);
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      reviewPrompts.push(prompt);
      return { text: "looks good to me" };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      reviewAgent,
      reviewRoute: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      async createExecutorAgent() {
        return {
          clear() {},
          updateRuntimeSettings() {},
          setTraceListener() {},
          async runTurn() {
            writeFileSync(path.join(workspace, "session.ts"), "export const session = true;\n");
            return { text: "follower complete" };
          },
        };
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
      async runExecutableGuardianChecks() {
        return {
          checks: [{ name: "test", status: "passed", summary: "test PASS" }],
          summary: "test PASS",
        };
      },
    });

    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /invalid critic verdict/i);
    assert.equal(reviewPrompts.length, 1, "invalid critic output must prevent promote");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failing executable check blocks a passing critic before promote", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-failing-check-"));
  const reviewPrompts = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) {
        writeFileSync(path.join(workspace, "login.ts"), "export const login = true;\n");
        return { text: "pattern complete" };
      }
      throw new Error(`unexpected direct prompt: ${prompt}`);
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      reviewPrompts.push(prompt);
      return { text: passingCriticVerdict };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      reviewAgent,
      reviewRoute: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      async createExecutorAgent() {
        return {
          clear() {},
          updateRuntimeSettings() {},
          setTraceListener() {},
          async runTurn() {
            writeFileSync(path.join(workspace, "session.ts"), "export const session = true;\n");
            return { text: "follower complete" };
          },
        };
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
      async runExecutableGuardianChecks() {
        return {
          checks: [{ name: "test", status: "failed", summary: "test FAIL" }],
          summary: "test FAIL",
        };
      },
    });

    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /executable check failed/i);
    assert.equal(reviewPrompts.length, 1, "failed checks must prevent promote");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a workspace mutation during critic invalidates reviewer evidence before promote", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-stale-critic-"));
  const reviewPrompts = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) {
        writeFileSync(path.join(workspace, "login.ts"), "export const login = true;\n");
        return { text: "pattern complete" };
      }
      throw new Error(`unexpected direct prompt: ${prompt}`);
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      reviewPrompts.push(prompt);
      writeFileSync(path.join(workspace, "login.ts"), "export const login = 'mutated-by-review';\n");
      return { text: passingCriticVerdict };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      reviewAgent,
      reviewRoute: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      async createExecutorAgent() {
        return {
          clear() {},
          updateRuntimeSettings() {},
          setTraceListener() {},
          async runTurn() {
            writeFileSync(path.join(workspace, "session.ts"), "export const session = true;\n");
            return { text: "follower complete" };
          },
        };
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
      async runExecutableGuardianChecks() {
        return {
          checks: [{ name: "test", status: "passed", summary: "test PASS" }],
          summary: "test PASS",
        };
      },
    });

    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /artifact manifest changed during critic/i);
    assert.equal(reviewPrompts.length, 1, "stale critic evidence must prevent promote");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a workspace mutation during promote blocks completion and invalidates the critic", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-stale-promote-"));
  const reviewPrompts = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) {
        writeFileSync(path.join(workspace, "login.ts"), "export const login = true;\n");
        return { text: "pattern complete" };
      }
      throw new Error(`unexpected direct prompt: ${prompt}`);
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      reviewPrompts.push(prompt);
      if (prompt.includes("Synthesize executor findings")) {
        writeFileSync(path.join(workspace, "session.ts"), "export const session = 'mutated-by-promote';\n");
        return { text: "handoff" };
      }
      return { text: passingCriticVerdict };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      reviewAgent,
      reviewRoute: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      async createExecutorAgent() {
        return {
          clear() {},
          updateRuntimeSettings() {},
          setTraceListener() {},
          async runTurn() {
            writeFileSync(path.join(workspace, "session.ts"), "export const session = true;\n");
            return { text: "follower complete" };
          },
        };
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
      async runExecutableGuardianChecks() {
        return {
          checks: [{ name: "test", status: "passed", summary: "test PASS" }],
          summary: "test PASS",
        };
      },
    });

    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /artifact manifest changed during promote/i);
    assert.equal(reviewPrompts.length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a workspace mutation inside beforeRunComplete invalidates reviewer evidence", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-stale-completion-"));
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  host.register("completion-mutator", {
    beforeRunComplete() {
      writeFileSync(path.join(workspace, "login.ts"), "export const login = 'mutated-at-completion';\n");
      return { action: "proceed" };
    },
  });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: qualityPlan };
      if (prompt.includes("Implement login.ts")) {
        writeFileSync(path.join(workspace, "login.ts"), "export const login = true;\n");
        return { text: "pattern complete" };
      }
      throw new Error(`unexpected direct prompt: ${prompt}`);
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      return { text: prompt.includes("Synthesize executor findings") ? "handoff" : passingCriticVerdict };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      reviewAgent,
      reviewRoute: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      async createExecutorAgent() {
        return {
          clear() {},
          updateRuntimeSettings() {},
          setTraceListener() {},
          async runTurn() {
            writeFileSync(path.join(workspace, "session.ts"), "export const session = true;\n");
            return { text: "follower complete" };
          },
        };
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      qualityRisk: "medium",
      directRoute: { provider: "openai", model: "gpt-5.4" },
      commodityRoute: { provider: "omp", model: "kimi-code/k3" },
      async runExecutableGuardianChecks() {
        return {
          checks: [{ name: "test", status: "passed", summary: "test PASS" }],
          summary: "test PASS",
        };
      },
    });

    const result = await agent.runTurn("refactor login.ts and session.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /artifact manifest changed during promote/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
