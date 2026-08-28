import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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

const directoryQualityPlan = JSON.stringify([
  {
    id: "task-directory-runtime",
    summary: "Implement the owned runtime tree",
    prompt: "Implement the src/runtime directory",
    goal: "Build the source tree safely",
    constraints: ["Keep every source under src"],
    acceptanceCriteria: ["Runtime checks pass"],
    dependsOn: [],
    writePaths: ["src/runtime"],
  },
  {
    id: "task-directory-tests",
    summary: "Implement the owned test tree",
    prompt: "Implement the src/tests directory",
    goal: "Build the source tree safely",
    constraints: ["Keep every source under src"],
    acceptanceCriteria: ["Test checks pass"],
    dependsOn: ["task-directory-runtime"],
    writePaths: ["src/tests"],
  },
]);

function createDirectoryQualityAgent(input) {
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: input.workspace });
  if (input.mutateCompletion) {
    host.register("directory-completion-mutator", {
      beforeRunComplete() {
        input.mutateCompletion();
        return { action: "proceed" };
      },
    });
  }
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<goal_task_planner>")) return { text: directoryQualityPlan };
      if (prompt.includes("Implement the src/runtime directory")) {
        mkdirSync(path.join(input.workspace, "src", "runtime", "nested"), { recursive: true });
        writeFileSync(path.join(input.workspace, "src", "runtime", "nested", "baseline.ts"), "baseline\n");
        await input.mutateRuntimeWorker?.();
        return { text: "runtime directory worker complete" };
      }
      if (prompt.includes("Implement the src/tests directory")) {
        mkdirSync(path.join(input.workspace, "src", "tests"), { recursive: true });
        writeFileSync(path.join(input.workspace, "src", "tests", "runtime.test.ts"), "test\n");
        return { text: "test directory worker complete" };
      }
      throw new Error(`unexpected direct directory prompt: ${prompt}`);
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<quality_critic_read_only>")) {
        input.mutateCritic?.();
        return { text: passingCriticVerdict };
      }
      if (prompt.includes("<quality_promote_read_only>")) {
        input.mutatePromote?.();
        return { text: "directory handoff" };
      }
      throw new Error(`unexpected directory review prompt: ${prompt}`);
    },
  };
  const agent = new orchestrator.WorkAgent({
    directAgent,
    reviewAgent,
    reviewRoute: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    workspaceRoot: input.workspace,
    pluginHost: host,
    qualityRisk: "medium",
    directRoute: { provider: "openai", model: "gpt-5.4" },
    async runExecutableGuardianChecks() {
      return {
        checks: [{ name: "test", status: "passed", summary: "test PASS" }],
        summary: "test PASS",
      };
    },
  });
  if (input.traces) agent.setTraceListener((event) => input.traces.push(event));
  return agent;
}

function replaceNestedDirectoryWithInternalSymlink(workspace, content) {
  const targetDirectory = path.join(workspace, "internal-target");
  const linkPath = path.join(workspace, "src", "runtime", "nested");
  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(path.join(targetDirectory, "target.ts"), "initial target\n");
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(targetDirectory, linkPath, "dir");
  writeFileSync(path.join(targetDirectory, "target.ts"), content);
}

function unsupportedOwnershipFailures(traces) {
  return traces
    .filter((event) => event.type === "quality.gate_evaluated")
    .flatMap((event) => event.failures ?? [])
    .filter((failure) => failure === "UNSUPPORTED_OWNERSHIP_EVIDENCE");
}

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

test("simple English and Korean turns run the minimal SCC lifecycle without planner or critic calls", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-minimal-simple-"));
  const classifications = [];
  const completionHooks = [];
  const providerCalls = [];
  const traces = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  host.register("minimal-observer", {
    runClassified(event) {
      classifications.push(event);
      return { action: "proceed" };
    },
    beforeRunComplete(event) {
      completionHooks.push(event);
      return { action: "proceed" };
    },
  });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt, attachments) {
      providerCalls.push({ prompt, attachments });
      if (prompt.includes("<goal_task_planner>") || prompt.includes("<quality_critic_read_only>")) {
        throw new Error("minimal turns must not invoke planner or critic prompts");
      }
      return { text: `direct answer ${providerCalls.length}` };
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
      directRoute: { provider: "openai", model: "gpt-5.4" },
    });
    agent.setTraceListener((event) => traces.push(event));

    const english = await agent.runTurn("hello");
    const koreanAttachment = { id: "ko-context" };
    const korean = await agent.runTurn("반갑다", [koreanAttachment]);

    assert.deepEqual([english.qualityStatus, korean.qualityStatus], ["proceed", "proceed"]);
    assert.deepEqual(
      classifications.map(({ complexity, proposedProfile }) => ({ complexity, proposedProfile })),
      [
        { complexity: "simple", proposedProfile: "minimal" },
        { complexity: "simple", proposedProfile: "minimal" },
      ],
    );
    assert.equal(providerCalls.length, 2, "minimal quality must add no planner, critic, or synthesis provider call");
    assert.deepEqual(providerCalls[1].attachments, [koreanAttachment]);
    assert.ok(providerCalls.every(({ prompt }) => prompt.includes("SCC Quality Engine (minimal/work)")));
    assert.equal(completionHooks.length, 2);
    assert.ok(completionHooks.every(({ reviewRequired, independentReviewerAvailable }) =>
      reviewRequired === false && independentReviewerAvailable === false
    ));

    const qualityTraces = traces.filter((event) => event.type.startsWith("quality."));
    const runIds = [...new Set(qualityTraces.map((event) => event.runId))];
    assert.equal(runIds.length, 2);
    for (const runId of runIds) {
      const runTraces = qualityTraces.filter((event) => event.runId === runId);
      assert.deepEqual(
        runTraces.filter((event) => event.type === "quality.stage_started").map((event) => event.stage),
        ["explore", "work"],
      );
      assert.equal(runTraces.some((event) => ["plan", "critic", "promote"].includes(event.stage)), false);
      assert.equal(runTraces.some((event) => event.independentVerification === true), false);
      const gate = runTraces.find((event) => event.type === "quality.gate_evaluated");
      const completed = runTraces.find((event) => event.type === "quality.completed");
      assert.equal(gate?.decision, "proceed");
      assert.equal(completed?.decision, "proceed");
      assert.deepEqual(completed?.evidenceRefs, gate?.evidenceRefs);
      assert.equal(gate?.independentVerification, false);
      assert.equal(completed?.independentVerification, false);
      assert.equal(gate?.reviewerRunId, undefined);
      assert.match(gate?.artifactHash ?? "", /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(readdirSync(path.join(workspace, ".unclecode", "artifacts", runId)), ["direct-turn.json"]);
      const artifact = JSON.parse(readFileSync(path.join(workspace, gate.evidenceRefs[0]), "utf8"));
      assert.equal(artifact.kind, "direct-turn");
      assert.equal(artifact.status, "completed");
      assert.equal(artifact.artifactHash, gate.artifactHash);
      assert.ok(artifact.summary.length <= 8_000);
    }
    assert.equal(traces.some((event) => event.type === "work.proposed"), false, "minimal quality must not invent a DAG");
    assert.throws(() => readdirSync(path.join(workspace, ".data")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("research turns are classified as deep and reach SCC completion instead of bypassing the plugin host", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-research-"));
  const classifications = [];
  const traces = [];
  let providerCalls = 0;
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  host.register("research-observer", {
    runClassified(event) {
      classifications.push(event);
      return { action: "proceed" };
    },
  });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      providerCalls += 1;
      assert.match(prompt, /SCC Quality Engine \(deep\/work\)/);
      return { text: "research answer" };
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      mode: "search",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
      directRoute: { provider: "openai", model: "gpt-5.4" },
    });
    agent.setTraceListener((event) => traces.push(event));

    const result = await agent.runTurn("explain auth");

    assert.equal(result.text, "research answer");
    assert.equal(result.qualityStatus, "unproven");
    assert.equal(providerCalls, 1);
    assert.deepEqual(
      classifications.map(({ complexity, proposedProfile }) => ({ complexity, proposedProfile })),
      [{ complexity: "research", proposedProfile: "deep" }],
    );
    const gate = traces.find((event) => event.type === "quality.gate_evaluated");
    assert.equal(gate?.decision, "unproven");
    assert.ok(gate?.failures.includes("MISSING_CRITIC_STAGE"));
    assert.ok(gate?.failures.includes("MISSING_PROMOTE_STAGE"));
    assert.equal(gate?.independentVerification, false);
    assert.equal(traces.at(-1)?.type, "quality.completed");
    assert.equal(traces.at(-1)?.decision, "unproven");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failed simple provider turn persists failed evidence and completes quality before rethrowing", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-minimal-failure-"));
  const traces = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn() {
      throw new Error("provider exploded");
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
      directRoute: { provider: "openai", model: "gpt-5.4" },
    });
    agent.setTraceListener((event) => traces.push(event));

    await assert.rejects(agent.runTurn("hello"), /provider exploded/);

    const qualityTraces = traces.filter((event) => event.type.startsWith("quality."));
    const gate = qualityTraces.find((event) => event.type === "quality.gate_evaluated");
    const completed = qualityTraces.find((event) => event.type === "quality.completed");
    assert.equal(gate?.decision, "block");
    assert.equal(completed?.decision, "block");
    assert.deepEqual(completed?.evidenceRefs, gate?.evidenceRefs);
    assert.ok(qualityTraces.every((event) => event.runId === gate.runId && event.graphId === gate.graphId));
    assert.equal(qualityTraces.some((event) => event.independentVerification === true), false);
    const artifact = JSON.parse(readFileSync(path.join(workspace, gate.evidenceRefs[0]), "utf8"));
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.artifactHash, gate.artifactHash);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a cancelled simple provider turn records cancelled evidence before preserving AbortError", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-minimal-cancel-"));
  const traces = [];
  const controller = new AbortController();
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(_prompt, _attachments, options) {
      controller.abort(new DOMException("parent cancelled", "AbortError"));
      options.signal.throwIfAborted();
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
      directRoute: { provider: "openai", model: "gpt-5.4" },
    });
    agent.setTraceListener((event) => traces.push(event));

    await assert.rejects(
      agent.runTurn("hello", [], { signal: controller.signal }),
      (error) => error?.name === "AbortError",
    );

    const gate = traces.find((event) => event.type === "quality.gate_evaluated");
    const completed = traces.find((event) => event.type === "quality.completed");
    assert.equal(gate?.decision, "block");
    assert.equal(completed?.decision, "block");
    assert.deepEqual(completed?.evidenceRefs, gate?.evidenceRefs);
    assert.equal(traces.some((event) => event.independentVerification === true), false);
    const artifact = JSON.parse(readFileSync(path.join(workspace, gate.evidenceRefs[0]), "utf8"));
    assert.equal(artifact.status, "cancelled");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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

test("a commodity factory failure emits no quality route trace for an executor that never ran", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-factory-trace-"));
  const traces = [];
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
      throw new Error(`unexpected factory trace prompt: ${prompt}`);
    },
  };

  try {
    const agent = new orchestrator.WorkAgent({
      directAgent,
      async createExecutorAgent() {
        throw new Error("commodity factory exploded");
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
    const workStarts = traces.filter((event) =>
      event.type === "quality.stage_started" && event.stage === "work"
    );
    assert.deepEqual(workStarts.map((event) => ({
      nodeId: event.nodeId,
      provider: event.provider,
      model: event.model,
      hasAgentRunId: typeof event.agentRunId === "string",
    })), [{
      nodeId: "task-1",
      provider: "openai",
      model: "gpt-5.4",
      hasAgentRunId: true,
    }]);
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

test("directory ownership detects a file created during critic", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-critic-"));
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      mutateCritic() {
        writeFileSync(path.join(workspace, "src", "runtime", "nested", "created-during-critic.ts"), "created\n");
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /artifact manifest changed during critic/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("directory ownership detects a file renamed during promote", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-promote-"));
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      mutatePromote() {
        renameSync(
          path.join(workspace, "src", "runtime", "nested", "baseline.ts"),
          path.join(workspace, "src", "runtime", "nested", "renamed-during-promote.ts"),
        );
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /artifact manifest changed during promote/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("directory ownership detects a file deleted inside beforeRunComplete", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-completion-"));
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      mutateCompletion() {
        unlinkSync(path.join(workspace, "src", "runtime", "nested", "baseline.ts"));
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /artifact manifest changed during promote/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an internal directory symlink is unsupported before its critic can mutate the target", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-link-precritic-"));
  let criticCalls = 0;
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      mutateRuntimeWorker() {
        replaceNestedDirectoryWithInternalSymlink(workspace, "worker target\n");
      },
      mutateCritic() {
        criticCalls += 1;
        writeFileSync(path.join(workspace, "internal-target", "target.ts"), "critic target mutation\n");
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /unsupported owned workspace evidence/i);
    assert.equal(criticCalls, 0, "unsupported worker evidence must block before critic execution");
    assert.equal(
      readFileSync(path.join(workspace, "internal-target", "target.ts"), "utf8"),
      "worker target\n",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a directory symlink introduced during critic invalidates target-mutation evidence as unsupported", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-link-critic-"));
  const traces = [];
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      traces,
      mutateCritic() {
        replaceNestedDirectoryWithInternalSymlink(workspace, "critic target mutation\n");
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /unsupported owned workspace evidence/i);
    assert.deepEqual(unsupportedOwnershipFailures(traces), ["UNSUPPORTED_OWNERSHIP_EVIDENCE"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a directory symlink introduced during promote invalidates target-mutation evidence as unsupported", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-link-promote-"));
  const traces = [];
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      traces,
      mutatePromote() {
        replaceNestedDirectoryWithInternalSymlink(workspace, "promote target mutation\n");
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /unsupported owned workspace evidence/i);
    assert.deepEqual(unsupportedOwnershipFailures(traces), ["UNSUPPORTED_OWNERSHIP_EVIDENCE"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a directory symlink introduced in beforeRunComplete invalidates target-mutation evidence as unsupported", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-link-completion-"));
  const traces = [];
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      traces,
      mutateCompletion() {
        replaceNestedDirectoryWithInternalSymlink(workspace, "completion target mutation\n");
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /unsupported owned workspace evidence/i);
    assert.deepEqual(unsupportedOwnershipFailures(traces), ["UNSUPPORTED_OWNERSHIP_EVIDENCE"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a nested special entry is unsupported before review", {
  skip: process.platform === "win32",
}, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-s-"));
  const socketPath = path.join(workspace, "src", "runtime", "owned.sock");
  const server = createServer();
  let criticCalls = 0;
  try {
    const agent = createDirectoryQualityAgent({
      workspace,
      async mutateRuntimeWorker() {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
      },
      mutateCritic() {
        criticCalls += 1;
      },
    });

    const result = await agent.runTurn("refactor src/runtime.ts and src/nested/tests.ts");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /unsupported owned workspace evidence/i);
    assert.equal(criticCalls, 0);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("directory ownership persists canonical recursive worker evidence", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-dir-evidence-"));
  try {
    mkdirSync(path.join(workspace, "src", "nested"), { recursive: true });
    writeFileSync(path.join(workspace, "src", "alpha.ts"), "alpha\n");
    writeFileSync(path.join(workspace, "src", "nested", "beta.ts"), "nested\n");
    writeFileSync(path.join(workspace, "outside-secret.txt"), "must not be followed\n");
    symlinkSync("../outside-secret.txt", path.join(workspace, "src", "external-link"));
    const store = new orchestrator.QualityArtifactStore(workspace, "directory-evidence");
    const expectedFiles = [
      { path: "src", kind: "directory", sha256: null },
      {
        path: "src/alpha.ts",
        kind: "file",
        sha256: "sha256:b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060",
      },
      {
        path: "src/external-link",
        kind: "symlink",
        sha256: "sha256:ac9b38ca422ebb62cab06155a594906004d01601ffd2f5cf054db4301e523a7b",
      },
      { path: "src/nested", kind: "directory", sha256: null },
      {
        path: "src/nested/beta.ts",
        kind: "file",
        sha256: "sha256:370a8c04b8a65bb4494275eec227f1b694db04c76da6b0b8ae88ed1ab19790a3",
      },
    ];

    const manifest = store.captureWorkspaceManifest(["src/", "src/nested/beta.ts"]);
    const artifact = store.persistNode({
      nodeId: "directory-node",
      attempt: 0,
      producerId: "worker:test",
      summary: "directory complete",
      writePaths: ["src/", "src/nested/beta.ts"],
      completedAt: "2026-08-28T00:00:00.000Z",
    });
    const persisted = JSON.parse(readFileSync(path.join(workspace, artifact.path), "utf8"));

    assert.equal(manifest.evidenceStatus, "unsupported");
    assert.deepEqual(manifest.unsupportedEntries, [expectedFiles[2]]);
    assert.deepEqual(manifest.files, expectedFiles);
    assert.equal(persisted.evidenceStatus, "unsupported");
    assert.deepEqual(persisted.unsupportedEntries, [expectedFiles[2]]);
    assert.deepEqual(persisted.files, expectedFiles);
    assert.doesNotMatch(JSON.stringify(persisted), /must not be followed/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ordinary files, directories, and missing owned roots remain supported evidence", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-supported-evidence-"));
  try {
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, "src", "ordinary.ts"), "ordinary\n");
    const store = new orchestrator.QualityArtifactStore(workspace, "supported-evidence");

    const manifest = store.captureWorkspaceManifest(["src", "missing-output.ts"]);

    assert.equal(manifest.evidenceStatus, "supported");
    assert.deepEqual(manifest.unsupportedEntries, []);
    assert.deepEqual(
      manifest.files.map(({ path: entryPath, kind }) => ({ path: entryPath, kind })),
      [
        { path: "missing-output.ts", kind: "missing" },
        { path: "src", kind: "directory" },
        { path: "src/ordinary.ts", kind: "file" },
      ],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a symlink at an owned root is explicitly unsupported without following its target", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-root-link-"));
  try {
    writeFileSync(path.join(workspace, "target.ts"), "external target contents must stay unread\n");
    symlinkSync("target.ts", path.join(workspace, "owned-link.ts"));
    const store = new orchestrator.QualityArtifactStore(workspace, "root-link");

    const manifest = store.captureWorkspaceManifest(["owned-link.ts"]);

    assert.equal(manifest.evidenceStatus, "unsupported");
    assert.deepEqual(
      manifest.unsupportedEntries.map(({ path: entryPath, kind }) => ({ path: entryPath, kind })),
      [{ path: "owned-link.ts", kind: "symlink" }],
    );
    assert.doesNotMatch(JSON.stringify(manifest), /external target contents must stay unread/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a symlink in the path to an owned root is unsupported without reading the nested target", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-ancestor-link-"));
  try {
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    mkdirSync(path.join(workspace, "internal-target"), { recursive: true });
    writeFileSync(
      path.join(workspace, "internal-target", "secret.ts"),
      "nested target contents must stay unread\n",
    );
    symlinkSync(path.join(workspace, "internal-target"), path.join(workspace, "src", "linked"), "dir");
    const store = new orchestrator.QualityArtifactStore(workspace, "ancestor-link");

    const manifest = store.captureWorkspaceManifest(["src/linked/secret.ts"]);

    assert.equal(manifest.evidenceStatus, "unsupported");
    assert.deepEqual(
      manifest.unsupportedEntries.map(({ path: entryPath, kind }) => ({ path: entryPath, kind })),
      [{ path: "src/linked", kind: "symlink" }],
    );
    assert.doesNotMatch(JSON.stringify(manifest), /nested target contents must stay unread/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ownership snapshots refuse paths outside the workspace", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-contained-"));
  try {
    const store = new orchestrator.QualityArtifactStore(workspace, "contained");
    assert.throws(
      () => store.captureWorkspaceManifest(["../outside-secret.txt"]),
      /outside the workspace/i,
    );
    assert.throws(
      () => store.persistNode({
        nodeId: "escaping-node",
        attempt: 0,
        producerId: "worker:test",
        summary: "must fail closed",
        writePaths: ["../outside-secret.txt"],
        completedAt: "2026-08-28T00:00:00.000Z",
      }),
      /outside the workspace/i,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ownership snapshots record a filesystem socket without reading it", {
  skip: process.platform === "win32",
}, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-special-"));
  const socketPath = path.join(workspace, "owned.sock");
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const store = new orchestrator.QualityArtifactStore(workspace, "special");

    const manifest = store.captureWorkspaceManifest(["owned.sock"]);
    const artifact = store.persistNode({
      nodeId: "special-node",
      attempt: 0,
      producerId: "worker:test",
      summary: "special file observed safely",
      writePaths: ["owned.sock"],
      completedAt: "2026-08-28T00:00:00.000Z",
    });
    const persisted = JSON.parse(readFileSync(path.join(workspace, artifact.path), "utf8"));

    assert.equal(manifest.evidenceStatus, "unsupported");
    assert.deepEqual(manifest.unsupportedEntries, [
      { path: "owned.sock", kind: "special", sha256: null },
    ]);
    assert.deepEqual(manifest.files, [{ path: "owned.sock", kind: "special", sha256: null }]);
    assert.equal(persisted.evidenceStatus, "unsupported");
    assert.deepEqual(persisted.unsupportedEntries, [
      { path: "owned.sock", kind: "special", sha256: null },
    ]);
    assert.deepEqual(persisted.files, [{ path: "owned.sock", kind: "special", sha256: null }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
