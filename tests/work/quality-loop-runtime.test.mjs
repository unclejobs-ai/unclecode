import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyTraceEventToAgentConsole,
  CooperativePauseController,
  persistWorkShellSessionSnapshot,
  runExecutionNonInterruptible,
  WorkAgent,
} from "@unclecode/orchestrator";
import { parseAgentConsoleSnapshot } from "@unclecode/contracts";
import {
  PluginHost,
  registerBuiltInSccQualityEngine,
} from "@unclecode/plugin-host";

import { loadResumedWorkSession } from "../../apps/unclecode-cli/src/work-runtime.ts";

const supportedReasoning = {
  effort: "medium",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

function plan(version) {
  return JSON.stringify([
    {
      id: `${version}-foundation`,
      summary: `Implement ${version} foundation`,
      prompt: `Implement ${version}-foundation.ts`,
      goal: "Ship a reviewed quality-loop change",
      constraints: ["Preserve public behavior"],
      acceptanceCriteria: [`${version} foundation passes`],
      dependsOn: [],
      writePaths: [`${version}-foundation.ts`],
    },
    {
      id: `${version}-integration`,
      summary: `Implement ${version} integration`,
      prompt: `Implement ${version}-integration.ts`,
      goal: "Ship a reviewed quality-loop change",
      constraints: ["Preserve public behavior"],
      acceptanceCriteria: [`${version} integration passes`],
      dependsOn: [`${version}-foundation`],
      writePaths: [`${version}-integration.ts`],
    },
  ]);
}

function verdict(findings = [], outcome = "pass") {
  return JSON.stringify({
    verdict: outcome,
    summary: findings.length === 0 ? "Fresh implementation passes." : "A bounded correction is required.",
    findings,
  });
}

const evolutionHash = `sha256:${"b".repeat(64)}`;

function createRecordedEvolutionService(order, state = "pr-ready", recorded = true) {
  return {
    async run(input) {
      order.push("evolution:run");
      const timestamp = "2026-08-28T12:00:00.000Z";
      const proposal = {
        candidateId: "candidate-quality-loop",
        creatorId: input.creatorId,
        isolatedBranch: "unclecode/evolve/candidate-quality-loop",
        isolatedWorktree: "/repo/.candidates/candidate-quality-loop",
        changedAssets: ["v1-foundation.ts"],
        evaluatorId: "held-out-evaluator",
        heldOutBenchmarkId: "held-out-suite-v1",
        baselineScore: 0.7,
        candidateScore: 0.9,
        validationEvidence: [
          {
            kind: "artifact",
            artifactHash: evolutionHash,
            producerId: input.creatorId,
            result: "pass",
            timestamp,
          },
          {
            kind: "reviewer",
            artifactHash: evolutionHash,
            producerId: input.creatorId,
            reviewerId: "held-out-evaluator",
            result: "pass",
            timestamp,
          },
        ],
        humanApproval: "pending",
      };
      const context = {
        currentArtifactHash: evolutionHash,
        evaluatorAssets: ["host/evaluator.json"],
        policyAssets: ["AGENTS.md"],
        benchmarkAssets: ["bench/held-out.json"],
        evaluationTimestamp: timestamp,
        maxAttestationAgeMs: 300_000,
        isolation: {
          candidateId: proposal.candidateId,
          candidateBranch: proposal.isolatedBranch,
          candidateWorktree: proposal.isolatedWorktree,
          branchExists: true,
          worktreeExists: true,
          baseBranch: "main",
          baseWorktree: "/repo/.baseline/candidate-quality-loop",
          hostCurrentBranch: "feature/current",
          hostCurrentWorktree: "/repo/current",
          attestorId: "unclecode-git-attestor",
          timestamp,
        },
      };
      if (state === "pr-ready") {
        const decision = await input.dispatchEvolutionProposed({
          runId: input.runId,
          proposal,
          context,
        });
        assert.equal(decision.action, "proceed");
      }
      const projection = {
        id: "evolution-quality-loop",
        runId: input.runId,
        candidateId: proposal.candidateId,
        creatorId: input.creatorId,
        evaluatorId: proposal.evaluatorId,
        attestorId: context.isolation.attestorId,
        state,
        isolation: "worktree",
        isolatedBranch: proposal.isolatedBranch,
        isolatedWorktree: proposal.isolatedWorktree,
        heldOutBenchmark: true,
        heldOutBenchmarkId: proposal.heldOutBenchmarkId,
        humanApproval: "pending",
        mergeRequiresHumanApproval: true,
        stale: state === "stale",
        changedAssets: [{ path: "v1-foundation.ts", sha256: evolutionHash }],
        hashes: {
          baseCommit: "1".repeat(40),
          candidateCommit: "2".repeat(40),
          patch: evolutionHash,
          candidateArtifact: evolutionHash,
          evaluator: evolutionHash,
          evaluatorEnvironment: evolutionHash,
          policy: evolutionHash,
          suite: evolutionHash,
          baselineResult: evolutionHash,
          candidateResult: evolutionHash,
        },
        comparison: {
          baselineScore: 0.7,
          candidateScore: 0.9,
          delta: 0.2,
          passed: state === "pr-ready",
          thresholdsHash: evolutionHash,
        },
        attestation: {
          timestamp,
          maxAgeMs: 300_000,
          branchExists: true,
          worktreeExists: true,
        },
        cleanup: {
          status: state === "pr-ready" ? "retained" : "completed",
          resources: [],
        },
        failures: state === "pr-ready" ? [] : ["EVOLUTION_THRESHOLD_FAILED"],
        summary: state === "pr-ready" ? "PR-ready; human approval pending." : "Candidate rejected.",
        artifactRefs: [`.unclecode/artifacts/${input.runId}/evolution-proposal.json`],
        createdAt: timestamp,
      };
      return {
        status: state,
        recorded,
        projection,
        ...(state === "pr-ready" ? { proposal, context } : {}),
      };
    },
    async verifyFresh(result) {
      order.push("evolution:fresh");
      return result;
    },
  };
}

function parallelPlan(version) {
  const tasks = JSON.parse(plan(version));
  tasks[1].dependsOn = [];
  return JSON.stringify(tasks);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPauseRuntime(turnId) {
  const persisted = [];
  const controller = new CooperativePauseController();
  controller.beginTurn(turnId);
  const persist = async (snapshot) => {
    persisted.push(snapshot);
  };
  return {
    controller,
    persisted,
    port: {
      checkpoint: (boundary) => controller.checkpoint(boundary, persist),
      runNonInterruptible: (operation, run) =>
        controller.runNonInterruptible(operation, run, persist),
    },
  };
}

function nextEventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

const refineFinding = {
  kind: "implementation",
  severity: "medium",
  correctable: true,
  direction: "Apply the critic's bounded correction.",
};

const pivotFinding = {
  kind: "acceptance",
  severity: "high",
  correctable: true,
  direction: "Replace the plan with explicit acceptance coverage.",
};

function createLoopHarness(input) {
  const traces = [];
  const plannerCalls = [];
  const workerCalls = [];
  const reviewCalls = [];
  const planEvents = [];
  const evolutionEvents = [];
  const completionEvents = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: input.workspace });
  host.registerBuiltIn("quality-loop-observer", {
    planCreated(event) {
      planEvents.push(event);
      return { action: "proceed" };
    },
    afterNodeCompleted(event) {
      return input.onNodeCompleted?.(event) ?? { action: "proceed" };
    },
    beforeRunComplete(event) {
      completionEvents.push(event);
      return input.onBeforeRunComplete?.(event) ?? { action: "proceed" };
    },
    evolutionProposed(event) {
      evolutionEvents.push(event);
      return input.onEvolutionProposed?.(event) ?? { action: "proceed" };
    },
  });
  const plans = [...input.plans];
  const criticVerdicts = [...input.criticVerdicts];
  const runWorkerTurn = async (prompt, options) => {
    const match = prompt.match(/Implement (v\d+)-(foundation|integration)\.ts/);
    if (!match) throw new Error(`unexpected quality-loop worker prompt: ${prompt}`);
    const call = {
      version: match[1],
      part: match[2],
      ordinal: workerCalls.length + 1,
    };
    workerCalls.push(call);
    await input.onWorker?.({ ...call, signal: options?.signal });
    writeFileSync(
      path.join(input.workspace, `${call.version}-${call.part}.ts`),
      `export const value = "${call.version}-${call.part}-${call.ordinal}";\n`,
    );
    return { text: `${call.version}-${call.part} worker ${call.ordinal} complete` };
  };
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt, _attachments, options) {
      if (prompt.includes("<goal_task_planner>")) {
        plannerCalls.push(prompt);
        const next = plans.shift();
        if (!next) throw new Error("planner was called beyond the configured replacement plans");
        return { text: next };
      }
      return await runWorkerTurn(prompt, options);
    },
  };
  const commodityAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt, _attachments, options) {
      return await runWorkerTurn(prompt, options);
    },
  };
  let reviewTraceListener;
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener(listener) {
      reviewTraceListener = listener;
    },
    async runTurn(prompt) {
      if (input.observedReviewRoute) {
        reviewTraceListener?.({
          type: "provider.route",
          level: "default",
          ...input.observedReviewRoute,
          startedAt: Date.now(),
        });
      }
      if (prompt.includes("<quality_critic_read_only>")) {
        reviewCalls.push("critic");
        const next = criticVerdicts.shift();
        if (!next) throw new Error("critic was called beyond the configured verdicts");
        return { text: next };
      }
      if (prompt.includes("<quality_promote_read_only>")) {
        reviewCalls.push("promote");
        return { text: "reviewed handoff" };
      }
      throw new Error(`unexpected read-only quality-loop prompt: ${prompt}`);
    },
  };
  const agent = new WorkAgent({
    directAgent,
    reviewAgent: input.selfReview ? directAgent : reviewAgent,
    reviewRoute: input.reviewRoute ?? { provider: "anthropic", model: "claude-review" },
    ...(input.requireObservedReviewRoute ? {} : { reviewRouteEvidence: "declared" }),
    mode: input.parallelWorkers ? "ultrawork" : "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    workspaceRoot: input.workspace,
    pluginHost: host,
    qualityRisk: "medium",
    ...(input.creatorEvolutionService
      ? { creatorEvolutionService: input.creatorEvolutionService }
      : {}),
    directRoute: { provider: "openai", model: "gpt-5.4" },
    ...(input.parallelWorkers
      ? {
          commodityRoute: { provider: "omp", model: "worker-model" },
          async createExecutorAgent() {
            return commodityAgent;
          },
        }
      : {}),
    async runExecutableGuardianChecks() {
      return {
        checks: [{ name: "test", status: "passed", summary: "test PASS" }],
        summary: "test PASS",
      };
    },
  });
  agent.setTraceListener((event) => {
    traces.push(event);
    input.onTrace?.(event);
  });
  return {
    agent,
    traces,
    plannerCalls,
    workerCalls,
    reviewCalls,
    planEvents,
    evolutionEvents,
    completionEvents,
  };
}

function createDirectLoopHarness(input) {
  const traces = [];
  const directCalls = [];
  const plannerCalls = [];
  const workerCalls = [];
  const reviewCalls = [];
  const completionEvents = [];
  const planEvents = [];
  const host = new PluginHost();
  registerBuiltInSccQualityEngine(host, { workspaceRoot: input.workspace });
  const registerObserver = input.externalObserver
    ? host.register.bind(host)
    : host.registerBuiltIn.bind(host);
  registerObserver("direct-quality-loop-observer", {
    planCreated(event) {
      planEvents.push(event);
      return { action: "proceed" };
    },
    beforeRunComplete(event) {
      completionEvents.push(event);
      return input.onBeforeRunComplete?.({ event, ordinal: completionEvents.length })
        ?? { action: "proceed" };
    },
  });
  const plans = [...(input.plans ?? [])];
  const criticVerdicts = [...(input.criticVerdicts ?? [])];
  const directTexts = [...(input.directTexts ?? [])];
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt, attachments, options) {
      if (prompt.includes("<goal_task_planner>")) {
        plannerCalls.push(prompt);
        const next = plans.shift();
        if (!next) throw new Error("planner was called beyond the configured direct-pivot plans");
        return { text: next };
      }
      const workerMatch = prompt.match(/Implement (v\d+)-(foundation|integration)\.ts/);
      if (workerMatch) {
        const call = {
          version: workerMatch[1],
          part: workerMatch[2],
          ordinal: workerCalls.length + 1,
        };
        workerCalls.push(call);
        await input.onWorker?.({ ...call, signal: options?.signal });
        writeFileSync(
          path.join(input.workspace, `${call.version}-${call.part}.ts`),
          `export const value = "${call.version}-${call.part}-${call.ordinal}";\n`,
        );
        return { text: `${call.version}-${call.part} worker ${call.ordinal} complete` };
      }
      const call = {
        ordinal: directCalls.length + 1,
        prompt,
        attachments,
        signal: options?.signal,
      };
      directCalls.push(call);
      await input.onDirect?.(call);
      return { text: directTexts.shift() ?? `direct answer ${call.ordinal}` };
    },
  };
  const reviewAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.includes("<quality_critic_read_only>")) {
        reviewCalls.push("critic");
        const next = criticVerdicts.shift();
        if (!next) throw new Error("critic was called beyond the configured direct-pivot verdicts");
        return { text: next };
      }
      if (prompt.includes("<quality_promote_read_only>")) {
        reviewCalls.push("promote");
        return { text: "reviewed handoff" };
      }
      throw new Error(`unexpected direct-loop review prompt: ${prompt}`);
    },
  };
  const agent = new WorkAgent({
    directAgent,
    reviewAgent,
    reviewRoute: { provider: "anthropic", model: "claude-review" },
    reviewRouteEvidence: "declared",
    mode: input.mode ?? "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    workspaceRoot: input.workspace,
    pluginHost: host,
    ...(input.qualityRisk ? { qualityRisk: input.qualityRisk } : {}),
    directRoute: { provider: "openai", model: "gpt-5.4" },
    async runExecutableGuardianChecks() {
      return {
        checks: [{ name: "test", status: "passed", summary: "test PASS" }],
        summary: "test PASS",
      };
    },
  });
  agent.setTraceListener((event) => traces.push(event));
  return {
    agent,
    traces,
    directCalls,
    plannerCalls,
    workerCalls,
    reviewCalls,
    completionEvents,
    planEvents,
  };
}

function reduceTracePrefix(traces, endIndex) {
  let snapshot = { profileId: "build", activity: [], agents: [], jobs: [] };
  for (const event of traces.slice(0, endIndex + 1)) {
    snapshot = applyTraceEventToAgentConsole(snapshot, event);
  }
  return parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(snapshot)));
}

async function persistAndResumeTracePrefix(workspace, traces, endIndex, sessionId) {
  const agentConsole = reduceTracePrefix(traces, endIndex);
  const sessionStoreRoot = path.join(workspace, ".resume-state");
  await persistWorkShellSessionSnapshot({
    cwd: workspace,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId,
    model: "gpt-5.4",
    mode: "default",
    state: "running",
    summary: "Chat: interrupted quality iteration",
    traceMode: "minimal",
    entries: [{ role: "user", text: "continue the interrupted quality iteration" }],
    agentConsole,
  });
  return await loadResumedWorkSession({
    cwd: workspace,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId,
  });
}

test("a multi-node WorkAgent pauses after each settled DAG node and resumes without replay", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-node-pause-"));
  const foundationHookEntered = deferred();
  const releaseFoundationHook = deferred();
  const toolEffects = [];
  const pause = createPauseRuntime("quality-node-pause");
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    async onWorker({ part }) {
      await runExecutionNonInterruptible("tool.dispatch", async () => {
        toolEffects.push(part);
      });
    },
    async onNodeCompleted({ node }) {
      if (node.id === "v1-foundation") {
        foundationHookEntered.resolve();
        await releaseFoundationHook.promise;
      }
      return { action: "proceed" };
    },
  });
  const run = harness.agent.runTurn(
    "refactor v1 foundation and integration safely",
    [],
    { pause: pause.port },
  );

  try {
    await foundationHookEntered.promise;
    const receiptPromise = pause.controller.requestPause();
    releaseFoundationHook.resolve();
    const receipt = await receiptPromise;
    const workerCallsAtPause = harness.workerCalls.map(({ part }) => part);
    const pausedConsole = reduceTracePrefix(harness.traces, harness.traces.length - 1);

    assert.equal(pause.controller.resume(), true);
    const result = await run;

    assert.equal(receipt.boundary, "between_nodes");
    assert.deepEqual(pause.persisted.map(({ boundary }) => boundary), ["between_nodes"]);
    assert.deepEqual(workerCallsAtPause, ["foundation"]);
    assert.equal(
      pausedConsole.workGraph?.nodes.find((node) => node.id === "v1-foundation")?.status,
      "completed",
    );
    assert.notEqual(
      pausedConsole.workGraph?.nodes.find((node) => node.id === "v1-integration")?.status,
      "running",
    );
    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.deepEqual(harness.workerCalls.map(({ part }) => part), ["foundation", "integration"]);
    assert.deepEqual(toolEffects, ["foundation", "integration"]);
    assert.deepEqual(harness.reviewCalls, ["critic", "promote"]);
  } finally {
    releaseFoundationHook.resolve();
    pause.controller.cancel();
    await run.catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a parallel WorkAgent pauses only after sibling provider and tool work settles, without replay", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-parallel-pause-"));
  const foundationHookEntered = deferred();
  const releaseFoundationHook = deferred();
  const integrationToolEntered = deferred();
  const releaseIntegrationTool = deferred();
  const toolEffects = [];
  const pause = createPauseRuntime("quality-parallel-pause");
  const harness = createLoopHarness({
    workspace,
    plans: [parallelPlan("v1")],
    criticVerdicts: [verdict()],
    parallelWorkers: true,
    async onWorker({ part }) {
      await runExecutionNonInterruptible("tool.dispatch", async () => {
        toolEffects.push(part);
        if (part === "integration") {
          integrationToolEntered.resolve();
          await releaseIntegrationTool.promise;
        }
      });
    },
    async onNodeCompleted({ node }) {
      if (node.id === "v1-foundation") {
        foundationHookEntered.resolve();
        await releaseFoundationHook.promise;
      }
      return { action: "proceed" };
    },
  });
  const run = harness.agent.runTurn(
    "refactor v1 foundation and integration safely",
    [],
    { pause: pause.port },
  );

  try {
    await Promise.all([foundationHookEntered.promise, integrationToolEntered.promise]);
    let acknowledged = false;
    const receiptPromise = pause.controller.requestPause().then((receipt) => {
      acknowledged = true;
      return receipt;
    });
    releaseFoundationHook.resolve();
    await nextEventLoopTurn();
    await nextEventLoopTurn();
    assert.equal(acknowledged, false, "a sibling provider/tool remains noninterruptible");

    releaseIntegrationTool.resolve();
    const receipt = await receiptPromise;
    const pausedConsole = reduceTracePrefix(harness.traces, harness.traces.length - 1);
    assert.equal(pause.controller.resume(), true);
    const result = await run;

    assert.equal(receipt.boundary, "after_provider");
    assert.deepEqual(pause.persisted.map(({ boundary }) => boundary), ["after_provider"]);
    assert.equal(
      pausedConsole.workGraph?.nodes.find((node) => node.id === "v1-foundation")?.status,
      "completed",
    );
    assert.equal(
      pausedConsole.workGraph?.nodes.find((node) => node.id === "v1-integration")?.status,
      "running",
    );
    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.deepEqual(harness.workerCalls.map(({ part }) => part).sort(), ["foundation", "integration"]);
    assert.deepEqual(toolEffects.sort(), ["foundation", "integration"]);
    assert.deepEqual(harness.reviewCalls, ["critic", "promote"]);
  } finally {
    releaseFoundationHook.resolve();
    releaseIntegrationTool.resolve();
    pause.controller.cancel();
    await run.catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a WorkAgent pauses between quality iterations and resumes the retry without replay", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-iteration-pause-"));
  const toolEffects = [];
  const pause = createPauseRuntime("quality-iteration-pause");
  const refineGateObserved = deferred();
  let receiptPromise;
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict([refineFinding]), verdict()],
    async onWorker({ part, ordinal }) {
      await runExecutionNonInterruptible("tool.dispatch", async () => {
        toolEffects.push(`${part}:${ordinal}`);
      });
    },
    onTrace(event) {
      if (event.type === "quality.gate_evaluated" && event.decision === "refine") {
        receiptPromise = pause.controller.requestPause();
        refineGateObserved.resolve();
      }
    },
  });
  const run = harness.agent.runTurn(
    "refactor v1 foundation and integration safely",
    [],
    { pause: pause.port },
  );

  try {
    await refineGateObserved.promise;
    const receipt = await receiptPromise;
    const workerCallsAtPause = harness.workerCalls.map(({ part, ordinal }) => `${part}:${ordinal}`);
    assert.equal(pause.controller.resume(), true);
    const result = await run;

    assert.equal(receipt.boundary, "between_quality_iterations");
    assert.deepEqual(
      pause.persisted.map(({ boundary }) => boundary),
      ["between_quality_iterations"],
    );
    assert.deepEqual(workerCallsAtPause, ["foundation:1", "integration:2"]);
    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.deepEqual(harness.workerCalls.map(({ part, ordinal }) => `${part}:${ordinal}`), [
      "foundation:1",
      "integration:2",
      "foundation:3",
      "integration:4",
    ]);
    assert.deepEqual(toolEffects, [
      "foundation:1",
      "integration:2",
      "foundation:3",
      "integration:4",
    ]);
    assert.deepEqual(harness.reviewCalls, ["critic", "critic", "promote"]);
  } finally {
    pause.controller.cancel();
    await run.catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("creator routing invokes the recorded evolution lifecycle before completion and rechecks freshness", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-creator-evolution-"));
  const order = [];
  const creatorEvolutionService = createRecordedEvolutionService(order);
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    creatorEvolutionService,
    onEvolutionProposed() {
      order.push("hook:evolution-proposed");
      return { action: "proceed" };
    },
    onBeforeRunComplete() {
      order.push("hook:before-run-complete");
      return { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn(
      "create and refactor an agent skill using v1 foundation and integration safely",
    );

    assert.equal(result.qualityStatus, "proceed", JSON.stringify({ result, traces: harness.traces }, null, 2));
    assert.deepEqual(harness.plannerCalls, []);
    assert.deepEqual(harness.workerCalls, []);
    assert.deepEqual(harness.reviewCalls, []);
    assert.equal(harness.evolutionEvents.length, 1);
    assert.equal(harness.completionEvents.length, 1);
    assert.equal(harness.completionEvents[0].evolution?.recorded, true);
    assert.equal(harness.completionEvents[0].evolution?.state, "pr-ready");
    assert.deepEqual(order, [
      "evolution:run",
      "hook:evolution-proposed",
      "hook:before-run-complete",
      "evolution:fresh",
    ]);
    const evolutionTraceIndex = harness.traces.findIndex((event) => event.type === "evolution.proposed");
    const completionTraceIndex = harness.traces.findIndex((event) => event.type === "quality.completed");
    assert.ok(evolutionTraceIndex >= 0);
    assert.ok(evolutionTraceIndex < completionTraceIndex);
    assert.equal(harness.traces[evolutionTraceIndex].proposal.humanApproval, "pending");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("creator profile enters isolated evolution before any mutation-capable direct or worker execution", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-creator-isolated-first-"));
  const primaryAsset = path.join(workspace, "skills", "creator.md");
  const order = [];
  const service = createRecordedEvolutionService(order);
  const originalRun = service.run.bind(service);
  service.run = async (input) => {
    assert.deepEqual(input.mutableTargets, ["skills/creator.md"]);
    assert.equal(readFileSync(primaryAsset, "utf8"), "primary workspace\n");
    return originalRun(input);
  };
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    creatorEvolutionService: service,
  });

  mkdirSync(path.dirname(primaryAsset), { recursive: true });
  writeFileSync(primaryAsset, "primary workspace\n");

  try {
    const result = await harness.agent.runTurn(
      "create an agent skill in skills/creator.md without changing the primary workspace",
    );

    assert.equal(result.qualityStatus, "proceed", JSON.stringify({ result, traces: harness.traces }, null, 2));
    assert.deepEqual(harness.plannerCalls, []);
    assert.deepEqual(harness.workerCalls, []);
    assert.deepEqual(harness.reviewCalls, []);
    assert.equal(readFileSync(primaryAsset, "utf8"), "primary workspace\n");
    assert.deepEqual(order, ["evolution:run", "evolution:fresh"]);
    assert.equal(harness.completionEvents[0]?.evolution?.state, "pr-ready");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("recorded rejected creator candidates project honestly but cannot complete", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-creator-rejected-"));
  const order = [];
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    creatorEvolutionService: createRecordedEvolutionService(order, "rejected"),
  });

  try {
    const result = await harness.agent.runTurn(
      "create and refactor an agent skill using v1 foundation and integration safely",
    );
    assert.equal(result.qualityStatus, "block");
    assert.equal(harness.evolutionEvents.length, 0, "rejected candidates never dispatch a valid proposal");
    assert.equal(harness.traces.filter((event) => event.type === "evolution.proposed").length, 1);
    assert.equal(harness.traces.find((event) => event.type === "evolution.proposed")?.proposal.state, "rejected");
    assert.equal(harness.completionEvents[0].evolution?.state, "rejected");
    assert.deepEqual(order, ["evolution:run"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct simple completion refine reruns with fresh identity and resumes interrupted as unproven", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-refine-"));
  const attachment = { id: "direct-refine-context" };
  const harness = createDirectLoopHarness({
    workspace,
    directTexts: ["first direct answer", "refined direct answer"],
    onBeforeRunComplete({ ordinal }) {
      return ordinal === 1
        ? { action: "refine", reason: "tighten the direct response" }
        : { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("hello", [attachment]);

    assert.deepEqual(result, { text: "refined direct answer", qualityStatus: "proceed" });
    assert.equal(harness.directCalls.length, 2);
    assert.ok(harness.directCalls.every((call) => call.attachments[0] === attachment));
    assert.deepEqual(harness.plannerCalls, []);
    assert.deepEqual(harness.workerCalls, []);
    assert.deepEqual(harness.reviewCalls, []);

    const gates = harness.traces.filter((event) => event.type === "quality.gate_evaluated");
    assert.deepEqual(gates.map((event) => event.decision), ["refine", "proceed"]);
    assert.deepEqual(gates.map((event) => event.iteration), [0, 1]);
    assert.notEqual(gates[0].artifactHash, gates[1].artifactHash);
    assert.notEqual(gates[0].evidenceRefs[0], gates[1].evidenceRefs[0]);
    assert.notEqual(harness.completionEvents[0].producerId, harness.completionEvents[1].producerId);
    assert.equal(harness.completionEvents[1].evidence.length, 1, "stale direct evidence is not reused");
    assert.equal(
      harness.completionEvents[1].evidence[0].artifactHash,
      harness.completionEvents[1].currentArtifactHash,
    );
    const workStages = harness.traces.filter((event) =>
      event.type === "quality.stage_started" && event.stage === "work"
    );
    assert.equal(new Set(workStages.map((event) => event.agentRunId)).size, 2);

    const runId = gates[0].runId;
    assert.equal(new Set(gates.map((event) => event.runId)).size, 1);
    assert.equal(new Set(gates.map((event) => event.graphId)).size, 1);
    const artifactDirectory = path.join(workspace, ".unclecode", "artifacts", runId);
    assert.deepEqual(new Set(readdirSync(artifactDirectory)), new Set([
      "direct-turn.json",
      "direct-turn-iteration-1.json",
    ]));
    const artifacts = gates.map((gate) =>
      JSON.parse(readFileSync(path.join(workspace, gate.evidenceRefs[0]), "utf8"))
    );
    assert.deepEqual(artifacts.map(({ iteration }) => iteration), [0, 1]);
    assert.equal(new Set(artifacts.map(({ producerId }) => producerId)).size, 2);
    assert.equal(new Set(artifacts.map(({ artifactHash }) => artifactHash)).size, 2);

    const requestIndex = harness.traces.findIndex((event) => event.type === "quality.refine_requested");
    const interrupted = reduceTracePrefix(harness.traces, requestIndex);
    assert.equal(interrupted?.workGraph, undefined, "direct quality must not invent a DAG");
    assert.equal(interrupted?.qualityReview?.latestDecision, "refine");
    assert.equal(interrupted?.qualityReview?.iteration, 1);
    const resumed = await persistAndResumeTracePrefix(
      workspace,
      harness.traces,
      requestIndex,
      "quality-direct-refine-interrupted",
    );
    assert.equal(resumed.initialAgentConsole?.workGraph, undefined);
    assert.equal(resumed.initialAgentConsole?.qualityReview?.latestDecision, "unproven");
    assert.equal(resumed.initialAgentConsole?.qualityReview?.iteration, 1);
    assert.deepEqual(
      resumed.initialAgentConsole?.qualityReview?.history.at(-1)?.failures,
      ["QUALITY_RUN_INTERRUPTED"],
    );
    assert.equal(harness.traces.filter((event) => event.type === "quality.completed").length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct completion evidence binds the actual post-tool workspace manifest", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-manifest-"));
  const harness = createDirectLoopHarness({
    workspace,
    directTexts: ["changed the workspace"],
    onDirect() {
      writeFileSync(path.join(workspace, "direct-change.txt"), "post-tool state\n");
    },
  });

  try {
    const result = await harness.agent.runTurn("hello");
    assert.equal(result.qualityStatus, "proceed");
    const completed = harness.traces.find((event) => event.type === "quality.completed");
    const artifact = JSON.parse(readFileSync(
      path.join(workspace, completed.evidenceRefs[0]),
      "utf8",
    ));
    assert.equal(artifact.workspaceManifest.evidenceStatus, "supported");
    assert.ok(artifact.workspaceManifest.files.some((entry) =>
      entry.path === "direct-change.txt" && entry.kind === "file"
    ));
    assert.match(artifact.workspaceManifest.artifactHash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("uncontracted external completion hooks block before callback or workspace mutation", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-stale-manifest-"));
  let callbackCalls = 0;
  const harness = createDirectLoopHarness({
    workspace,
    directTexts: ["stable answer"],
    externalObserver: true,
    onBeforeRunComplete() {
      callbackCalls += 1;
      writeFileSync(path.join(workspace, "concurrent-change.txt"), "stale\n");
      return { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("hello");
    assert.equal(result.qualityStatus, "block");
    assert.equal(callbackCalls, 0);
    assert.equal(existsSync(path.join(workspace, "concurrent-change.txt")), false);
    assert.ok(harness.traces.some((event) =>
      event.failures?.includes("DIRECT_EXTERNAL_LIFECYCLE_CONTRACT_UNPROVEN")
    ));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("deep research completion refine reruns the DAG and crosses a fresh critic and promote", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-research-refine-"));
  const harness = createDirectLoopHarness({
    workspace,
    mode: "search",
    plans: [plan("v1")],
    criticVerdicts: [verdict(), verdict()],
    onBeforeRunComplete({ ordinal }) {
      return ordinal === 1
        ? { action: "refine", reason: "research needs a narrower answer" }
        : { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("explain auth");

    assert.equal(result.qualityStatus, "proceed");
    assert.equal(result.text, "reviewed handoff");
    assert.equal(harness.directCalls.length, 0);
    assert.equal(harness.plannerCalls.length, 1);
    assert.equal(harness.workerCalls.length, 4);
    assert.deepEqual(harness.reviewCalls, ["critic", "promote", "critic", "promote"]);
    assert.equal(harness.traces.filter((event) => event.type === "quality.refine_requested").length, 1);
    assert.equal(harness.traces.filter((event) =>
      event.type === "quality.stage_started" && event.stage === "critic"
    ).length, 2);
    assert.equal(harness.traces.at(-1)?.type, "quality.completed");
    assert.equal(harness.traces.at(-1)?.decision, "proceed");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct standard completion refine reruns but cannot promote unreviewed output", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-standard-refine-"));
  const harness = createDirectLoopHarness({
    workspace,
    qualityRisk: "medium",
    onBeforeRunComplete({ ordinal }) {
      return ordinal === 1
        ? { action: "refine", reason: "standard response needs one correction" }
        : { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("hello");

    assert.equal(result.qualityStatus, "unproven");
    assert.equal(harness.directCalls.length, 2);
    assert.deepEqual(harness.reviewCalls, []);
    assert.equal(harness.traces.some((event) =>
      event.type === "quality.stage_started" && event.stage === "promote"
    ), false);
    assert.ok(harness.traces.filter((event) => event.type === "quality.stage_started")
      .every((event) => event.profile === "standard"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("creator completion without isolated evolution stays blocked before direct execution", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-creator-block-"));
  const harness = createDirectLoopHarness({
    workspace,
    onBeforeRunComplete() {
      return { action: "refine", reason: "retry creator output without evolution evidence" };
    },
  });

  try {
    const result = await harness.agent.runTurn("create an agent skill");

    assert.equal(result.qualityStatus, "block");
    assert.equal(harness.directCalls.length, 0);
    assert.equal(harness.traces.some((event) => event.type === "quality.refine_requested"), false);
    assert.equal(harness.traces.some((event) =>
      event.type === "quality.stage_started" && event.stage === "promote"
    ), false);
    const terminal = harness.traces.findLast((event) => event.type === "quality.gate_evaluated");
    assert.equal(terminal?.profile, "creator");
    assert.equal(terminal?.decision, "block");
    assert.ok(terminal?.failures.includes("CREATOR_EVOLUTION_LIFECYCLE_UNAVAILABLE"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ambiguous safety mutations escalate from research routing into the worker pipeline", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-safety-escalation-"));
  const harness = createDirectLoopHarness({
    workspace,
    mode: "search",
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
  });

  try {
    await harness.agent.runTurn("production auth settings");
    assert.deepEqual(harness.directCalls, []);
    assert.equal(harness.plannerCalls.length, 1);
    assert.equal(harness.workerCalls.length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct completion pivot escalates into the existing explicit DAG review pipeline", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-pivot-"));
  const harness = createDirectLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    onBeforeRunComplete({ ordinal }) {
      return ordinal === 1
        ? { action: "pivot", reason: "direct response requires explicit implementation work" }
        : { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("hello");

    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.equal(harness.directCalls.length, 1);
    assert.equal(harness.plannerCalls.length, 1);
    assert.equal(harness.planEvents.length, 1, "the escalated DAG crosses planCreated validation");
    assert.equal(harness.workerCalls.length, 2);
    assert.deepEqual(harness.reviewCalls, ["critic", "promote"]);
    assert.deepEqual(harness.completionEvents.map(({ graph }) => graph.nodes.length), [0, 2]);
    assert.equal(harness.completionEvents[0].runId, harness.planEvents[0].runId);
    assert.equal(harness.completionEvents[0].graph.id, harness.planEvents[0].graph.id);
    const request = harness.traces.find((event) => event.type === "quality.pivot_requested");
    assert.deepEqual([request?.iteration, request?.count, request?.stage], [1, 1, "work"]);
    const critic = harness.traces.find((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "critic"
    );
    assert.equal(critic?.iteration, 1);
    assert.equal(critic?.decision, "proceed");
    assert.equal(critic?.independentVerification, true);
    assert.equal(harness.traces.filter((event) => event.type === "quality.completed").length, 1);
    const completed = harness.traces.at(-1);
    assert.equal(completed?.decision, "proceed");
    assert.equal(completed?.reviewerRunId, critic?.reviewerRunId);
    assert.equal(completed?.artifactHash, critic?.artifactHash);
    assert.equal(completed?.reviewedArtifactHash, critic?.reviewedArtifactHash);
    assert.equal(completed?.currentArtifactHash, critic?.currentArtifactHash);
    assert.equal(completed?.stale, false);
    assert.deepEqual(critic?.artifactRefs, critic?.evidenceRefs);
    assert.deepEqual(completed?.artifactRefs, critic?.artifactRefs);
    assert.deepEqual(completed?.evidenceRefs, critic?.evidenceRefs);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct completion refine and pivot limits remain authoritative", async (t) => {
  await t.test("direct refine limit", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-refine-limit-"));
    const harness = createDirectLoopHarness({
      workspace,
      onBeforeRunComplete() {
        return { action: "refine", reason: "keep retrying the direct response" };
      },
    });
    try {
      const result = await harness.agent.runTurn("hello");
      assert.equal(result.qualityStatus, "block");
      assert.equal(harness.directCalls.length, 4);
      assert.equal(harness.traces.filter((event) => event.type === "quality.refine_requested").length, 3);
      assert.equal(harness.reviewCalls.length, 0);
      const terminal = harness.traces.findLast((event) => event.type === "quality.gate_evaluated");
      assert.ok(terminal?.failures.includes("QUALITY_REFINE_LIMIT_REACHED"));
      const runId = terminal.runId;
      const artifacts = readdirSync(path.join(workspace, ".unclecode", "artifacts", runId));
      assert.equal(artifacts.length, 4);
      assert.equal(new Set(artifacts).size, 4);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  await t.test("direct pivot limit", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-pivot-limit-"));
    const harness = createDirectLoopHarness({
      workspace,
      plans: [plan("v1"), plan("v2")],
      criticVerdicts: [verdict(), verdict()],
      onBeforeRunComplete() {
        return { action: "pivot", reason: "keep replacing the direct response plan" };
      },
    });
    try {
      const result = await harness.agent.runTurn("hello");
      assert.equal(result.qualityStatus, "block");
      assert.equal(harness.directCalls.length, 1);
      assert.equal(harness.plannerCalls.length, 2);
      assert.equal(harness.planEvents.length, 2);
      assert.equal(harness.workerCalls.length, 4);
      assert.deepEqual(harness.reviewCalls, ["critic", "promote", "critic", "promote"]);
      assert.equal(harness.traces.filter((event) => event.type === "quality.pivot_requested").length, 2);
      const terminal = harness.traces.findLast((event) => event.type === "quality.gate_evaluated");
      assert.ok(terminal?.failures.includes("QUALITY_PIVOT_LIMIT_REACHED"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

test("direct retry cancellation and failure propagate with iteration-specific evidence", async (t) => {
  await t.test("direct retry cancellation", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-retry-cancel-"));
    const controller = new AbortController();
    const harness = createDirectLoopHarness({
      workspace,
      onBeforeRunComplete({ ordinal }) {
        return ordinal === 1 ? { action: "refine", reason: "retry once" } : { action: "proceed" };
      },
      onDirect({ ordinal, signal }) {
        if (ordinal === 2) {
          controller.abort(new DOMException("cancel direct retry", "AbortError"));
          signal.throwIfAborted();
        }
      },
    });
    try {
      await assert.rejects(
        harness.agent.runTurn("hello", [], { signal: controller.signal }),
        (error) => error?.name === "AbortError",
      );
      assert.equal(harness.directCalls.length, 2);
      assert.equal(harness.completionEvents.length, 1);
      const completed = harness.traces.find((event) => event.type === "quality.completed");
      assert.equal(completed?.decision, "block");
      assert.ok(completed?.failures.includes("DIRECT_TURN_CANCELLED"));
      const artifact = JSON.parse(readFileSync(path.join(workspace, completed.evidenceRefs[0]), "utf8"));
      assert.equal(artifact.iteration, 1);
      assert.equal(artifact.status, "cancelled");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  await t.test("direct retry failure", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-direct-retry-failure-"));
    const harness = createDirectLoopHarness({
      workspace,
      onBeforeRunComplete({ ordinal }) {
        return ordinal === 1 ? { action: "refine", reason: "retry once" } : { action: "proceed" };
      },
      onDirect({ ordinal }) {
        if (ordinal === 2) throw new Error("direct retry exploded");
      },
    });
    try {
      await assert.rejects(harness.agent.runTurn("hello"), /direct retry exploded/);
      assert.equal(harness.directCalls.length, 2);
      assert.equal(harness.completionEvents.length, 1);
      const completed = harness.traces.find((event) => event.type === "quality.completed");
      assert.equal(completed?.decision, "block");
      assert.ok(completed?.failures.includes("DIRECT_TURN_FAILED"));
      const artifact = JSON.parse(readFileSync(path.join(workspace, completed.evidenceRefs[0]), "utf8"));
      assert.equal(artifact.iteration, 1);
      assert.equal(artifact.status, "failed");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

test("critic refine reruns the stable DAG with fresh attempts, identities, artifacts, and review before promote", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-refine-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict([refineFinding]), verdict()],
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.equal(harness.plannerCalls.length, 1, "refine reuses the validated explicit DAG");
    assert.deepEqual(harness.reviewCalls, ["critic", "critic", "promote"]);
    assert.equal(harness.workerCalls.length, 4, "critic findings without a node mapping rerun the worker DAG");

    const proposed = harness.traces.filter((event) => event.type === "work.proposed");
    assert.equal(new Set(proposed.map((event) => event.graphId)).size, 1);
    assert.deepEqual(proposed.map((event) => event.graph.nodes.map((node) => [node.id, node.attempt])), [
      [["v1-foundation", 0], ["v1-integration", 0]],
      [["v1-foundation", 1], ["v1-integration", 1]],
    ]);

    const jobs = harness.traces.filter((event) => event.type === "job.queued").map((event) => event.jobId);
    assert.equal(new Set(jobs).size, 4);
    assert.ok(jobs.some((jobId) => jobId.includes("v1-foundation:attempt-1:iteration-1")));
    assert.ok(jobs.some((jobId) => jobId.includes("v1-integration:attempt-1:iteration-1")));

    const criticGates = harness.traces.filter((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "critic"
    );
    assert.deepEqual(criticGates.map((event) => event.decision), ["refine", "proceed"]);
    assert.notEqual(criticGates[0].artifactHash, criticGates[1].artifactHash);
    assert.notEqual(criticGates[0].reviewerRunId, criticGates[1].reviewerRunId);
    assert.ok(criticGates.every((event) => event.independentVerification === true));
    const completion = harness.traces.findLast((event) => event.type === "quality.completed");
    assert.deepEqual(completion.failures, [], "resolved findings are absent from the active failure set");

    const runId = criticGates[0].runId;
    const artifacts = readdirSync(path.join(workspace, ".unclecode", "artifacts", runId)).sort();
    const nonWorkerArtifacts = artifacts.filter((filename) => !filename.startsWith("v1-"));
    assert.deepEqual(nonWorkerArtifacts.filter((filename) => !filename.startsWith("review-packet-")), [
      "critic-iteration-1.json", "critic.json", "run-iteration-1.json", "run.json",
    ]);
    assert.deepEqual(
      nonWorkerArtifacts.filter((filename) => filename.startsWith("review-packet-")).map((filename) =>
        filename.replace(/[a-f0-9]{64}\.json$/u, "<hash>.json")
      ),
      ["review-packet-iteration-0-<hash>.json", "review-packet-iteration-1-<hash>.json"],
    );
    const workerArtifactNames = artifacts.filter((filename) => filename.startsWith("v1-"));
    assert.equal(workerArtifactNames.length, 4);
    assert.ok(workerArtifactNames.every((filename) =>
      /-[a-f0-9]{16}-iteration-[01]-attempt-[01]\.json$/u.test(filename)
    ));
    const firstRun = JSON.parse(readFileSync(path.join(workspace, ".unclecode", "artifacts", runId, "run.json"), "utf8"));
    const retryRun = JSON.parse(readFileSync(path.join(workspace, ".unclecode", "artifacts", runId, "run-iteration-1.json"), "utf8"));
    assert.notEqual(firstRun.artifactHash, retryRun.artifactHash);

    const requestIndex = harness.traces.findIndex((event) => event.type === "quality.refine_requested");
    const interrupted = reduceTracePrefix(harness.traces, requestIndex);
    assert.equal(interrupted?.workGraph?.gateStatus, "refine");
    assert.equal(interrupted?.qualityReview?.iteration, 1);
    const durableResume = await persistAndResumeTracePrefix(
      workspace,
      harness.traces,
      requestIndex,
      "quality-refine-interrupted",
    );
    assert.equal(durableResume.initialAgentConsole?.workGraph?.gateStatus, "unproven");
    assert.equal(durableResume.initialAgentConsole?.workGraph?.iteration, 1);
    assert.equal(durableResume.initialAgentConsole?.qualityReview?.latestDecision, "unproven");
    assert.deepEqual(
      durableResume.initialAgentConsole?.qualityReview?.history.at(-1)?.failures,
      ["QUALITY_RUN_INTERRUPTED"],
    );
    const retryProposalIndex = harness.traces.findIndex((event, index) =>
      index > requestIndex && event.type === "work.proposed"
    );
    const resumedRetry = reduceTracePrefix(harness.traces, retryProposalIndex);
    assert.equal(resumedRetry?.workGraph?.gateStatus, "unproven");
    assert.equal(resumedRetry?.workGraph?.iteration, 1);
    assert.deepEqual(resumedRetry?.workGraph?.nodes.map((node) => node.attempt), [1, 1]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("acceptance defect pivots through planner and plan validation before executing a replacement DAG in the same run", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-pivot-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1"), plan("v2")],
    criticVerdicts: [verdict([pivotFinding]), verdict()],
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.equal(harness.plannerCalls.length, 2);
    assert.equal(harness.planEvents.length, 2, "replacement DAG crosses planCreated validation");
    assert.deepEqual(harness.planEvents.map((event) => event.graph.nodes.map((node) => node.id)), [
      ["v1-foundation", "v1-integration"],
      ["v2-foundation", "v2-integration"],
    ]);
    assert.equal(new Set(harness.planEvents.map((event) => event.runId)).size, 1);
    assert.equal(new Set(harness.planEvents.map((event) => event.graph.id)).size, 1);
    assert.deepEqual(harness.reviewCalls, ["critic", "critic", "promote"]);
    assert.deepEqual(harness.workerCalls.map((call) => call.version), ["v1", "v1", "v2", "v2"]);
    assert.equal(harness.traces.filter((event) => event.type === "quality.pivot_requested").length, 1);
    const completion = harness.traces.findLast((event) => event.type === "quality.completed");
    assert.deepEqual(completion.failures, []);

    const pivotIndex = harness.traces.findIndex((event) => event.type === "quality.pivot_requested");
    const replacementIndex = harness.traces.findIndex((event, index) =>
      index > pivotIndex && event.type === "work.proposed"
    );
    const resumedPivot = reduceTracePrefix(harness.traces, replacementIndex);
    assert.equal(resumedPivot?.workGraph?.gateStatus, "unproven");
    assert.equal(resumedPivot?.workGraph?.iteration, 1);
    assert.deepEqual(resumedPivot?.workGraph?.nodes.map((node) => node.id), ["v2-foundation", "v2-integration"]);
    const durableResume = await persistAndResumeTracePrefix(
      workspace,
      harness.traces,
      pivotIndex,
      "quality-pivot-interrupted",
    );
    assert.equal(durableResume.initialAgentConsole?.workGraph?.gateStatus, "unproven");
    assert.equal(durableResume.initialAgentConsole?.workGraph?.iteration, 1);
    assert.equal(durableResume.initialAgentConsole?.qualityReview?.latestDecision, "unproven");
    assert.deepEqual(
      durableResume.initialAgentConsole?.qualityReview?.history.at(-1)?.failures,
      ["QUALITY_RUN_INTERRUPTED"],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a same-wave sibling failure takes precedence over a refinement request", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-wave-failure-"));
  const refinementRecorded = deferred();
  const integrationEntered = deferred();
  const harness = createLoopHarness({
    workspace,
    plans: [parallelPlan("v1")],
    criticVerdicts: [],
    parallelWorkers: true,
    async onWorker({ part }) {
      if (part === "foundation") await integrationEntered.promise;
      if (part === "integration") {
        integrationEntered.resolve();
        await refinementRecorded.promise;
        throw new Error("parallel sibling exploded");
      }
    },
    onNodeCompleted({ node, outcome }) {
      if (node.id === "v1-foundation" && node.attempt === 0 && outcome.status === "completed") {
        refinementRecorded.resolve();
        return { action: "refine", reason: "tighten the foundation" };
      }
      return { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /worker.*failed|parallel sibling exploded/i);
    assert.equal(harness.workerCalls.length, 2, "the failed wave is never retried away");
    assert.deepEqual(harness.reviewCalls, []);
    assert.equal(
      harness.traces.filter((event) => event.type === "quality.refine_requested").length,
      0,
      "an iteration that terminal failure prevents is never projected as requested",
    );
    assert.equal(
      harness.traces.findLast((event) => event.type === "quality.gate_evaluated")?.decision,
      "block",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("same-wave refinement requests coalesce into one retry iteration", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-wave-coalesce-"));
  const initialWaveEntered = deferred();
  let initialWaveEntrants = 0;
  const harness = createLoopHarness({
    workspace,
    plans: [parallelPlan("v1")],
    criticVerdicts: [verdict()],
    parallelWorkers: true,
    async onWorker({ ordinal }) {
      if (ordinal > 2) return;
      initialWaveEntrants += 1;
      if (initialWaveEntrants === 2) initialWaveEntered.resolve();
      await initialWaveEntered.promise;
    },
    onNodeCompleted({ node, outcome }) {
      return node.attempt === 0 && outcome.status === "completed"
        ? { action: "refine", reason: `tighten ${node.id}` }
        : { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.equal(result.qualityStatus, "proceed");
    assert.equal(harness.workerCalls.length, 4);
    const requests = harness.traces.filter((event) => event.type === "quality.refine_requested");
    assert.deepEqual(requests.map((event) => [event.iteration, event.count]), [[1, 1]]);
    const proposals = harness.traces.filter((event) => event.type === "work.proposed");
    assert.deepEqual(proposals.map((event) => event.graph.iteration), [0, 1]);
    assert.ok(proposals[1].sequence > proposals[0].sequence);
    assert.deepEqual(
      proposals.map((event) => event.graph.nodes.map((node) => node.attempt)),
      [[0, 0], [1, 1]],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a completion-hook refinement returns through work and fresh critic before completing", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-completion-refine-"));
  let completionCalls = 0;
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict(), verdict()],
    onBeforeRunComplete() {
      completionCalls += 1;
      return completionCalls === 1
        ? { action: "refine", reason: "completion evidence needs one more boundary pass" }
        : { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.equal(harness.plannerCalls.length, 1);
    assert.equal(harness.workerCalls.length, 4);
    assert.deepEqual(harness.reviewCalls, ["critic", "promote", "critic", "promote"]);
    assert.equal(completionCalls, 2);
    const requests = harness.traces.filter((event) => event.type === "quality.refine_requested");
    assert.deepEqual(requests.map((event) => [event.stage, event.iteration, event.count]), [
      ["promote", 1, 1],
    ]);
    assert.equal(harness.traces.filter((event) => event.type === "quality.completed").length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a completion-hook pivot replans, revalidates, and reaches a fresh critic before completing", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-completion-pivot-"));
  let completionCalls = 0;
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1"), plan("v2")],
    criticVerdicts: [verdict(), verdict()],
    onBeforeRunComplete() {
      completionCalls += 1;
      return completionCalls === 1
        ? { action: "pivot", reason: "completion evidence requires a replacement DAG" }
        : { action: "proceed" };
    },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.equal(harness.plannerCalls.length, 2);
    assert.equal(harness.planEvents.length, 2, "the replacement DAG crosses planCreated validation");
    assert.deepEqual(harness.workerCalls.map((call) => call.version), ["v1", "v1", "v2", "v2"]);
    assert.deepEqual(harness.reviewCalls, ["critic", "promote", "critic", "promote"]);
    assert.equal(completionCalls, 2);
    const requests = harness.traces.filter((event) => event.type === "quality.pivot_requested");
    assert.deepEqual(requests.map((event) => [event.stage, event.iteration, event.count]), [
      ["promote", 1, 1],
    ]);
    assert.equal(harness.traces.filter((event) => event.type === "quality.completed").length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a fail verdict with one correctable direction drives a bounded refinement", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-fail-refine-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict([refineFinding], "fail"), verdict()],
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.deepEqual(result, { text: "reviewed handoff", qualityStatus: "proceed" });
    assert.equal(harness.workerCalls.length, 4);
    assert.deepEqual(harness.reviewCalls, ["critic", "critic", "promote"]);
    assert.deepEqual(
      harness.traces
        .filter((event) => event.type === "quality.gate_evaluated" && event.stage === "critic")
        .map((event) => event.decision),
      ["refine", "proceed"],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a pivot that reintroduces prior node ids preserves every iteration artifact", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-pivot-repeat-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1"), plan("v2"), plan("v1")],
    criticVerdicts: [verdict([pivotFinding], "fail"), verdict([pivotFinding], "fail"), verdict()],
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.equal(result.qualityStatus, "proceed");
    const runId = harness.traces.find((event) => event.type === "quality.gate_evaluated")?.runId;
    assert.ok(runId);
    const directory = path.join(workspace, ".unclecode", "artifacts", runId);
    const workerArtifacts = readdirSync(directory)
      .map((filename) => ({
        filename,
        body: JSON.parse(readFileSync(path.join(directory, filename), "utf8")),
      }))
      .filter(({ body }) => body.kind === "worker");
    assert.equal(workerArtifacts.length, 6);
    const repeatedFoundation = workerArtifacts.filter(({ body }) => body.nodeId === "v1-foundation");
    assert.equal(repeatedFoundation.length, 2);
    assert.equal(new Set(repeatedFoundation.map(({ filename }) => filename)).size, 2);
    assert.deepEqual(repeatedFoundation.map(({ body }) => body.iteration).sort(), [0, 2]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a reintroduced pivot node keeps terminal observation scoped to its iteration", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-pivot-repeat-failure-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1"), plan("v2"), plan("v1")],
    criticVerdicts: [verdict([pivotFinding], "fail"), verdict([pivotFinding], "fail")],
    onWorker({ version, ordinal }) {
      if (version === "v1" && ordinal === 5) throw new Error("reintroduced worker exploded");
    },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");

    assert.equal(result.qualityStatus, "block");
    assert.match(result.text, /worker.*failed|reintroduced worker exploded/i);
    assert.equal(harness.workerCalls.length, 5, "the failed prerequisite blocks its dependent");
    assert.deepEqual(harness.reviewCalls, ["critic", "critic"]);
    const terminal = harness.traces.findLast((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "work"
    );
    assert.equal(terminal?.iteration, 2);
    assert.equal(terminal?.decision, "block");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("core refine and pivot bounds terminate with explicit limit failures", async (t) => {
  await t.test("refine limit", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-refine-limit-"));
    const harness = createLoopHarness({
      workspace,
      plans: [plan("v1")],
      criticVerdicts: Array.from({ length: 4 }, () => verdict([refineFinding])),
    });
    try {
      const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
      assert.equal(result.qualityStatus, "block");
      assert.equal(harness.traces.filter((event) => event.type === "quality.refine_requested").length, 3);
      assert.equal(harness.reviewCalls.filter((call) => call === "critic").length, 4);
      assert.equal(harness.reviewCalls.includes("promote"), false);
      const terminal = harness.traces.findLast((event) => event.type === "quality.gate_evaluated");
      assert.equal(terminal.decision, "block");
      assert.ok(terminal.failures.includes("QUALITY_REFINE_LIMIT_REACHED"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  await t.test("pivot limit", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-pivot-limit-"));
    const harness = createLoopHarness({
      workspace,
      plans: [plan("v1"), plan("v2"), plan("v3")],
      criticVerdicts: Array.from({ length: 3 }, () => verdict([pivotFinding])),
    });
    try {
      const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
      assert.equal(result.qualityStatus, "block");
      assert.equal(harness.traces.filter((event) => event.type === "quality.pivot_requested").length, 2);
      assert.equal(harness.plannerCalls.length, 3);
      assert.equal(harness.reviewCalls.filter((call) => call === "critic").length, 3);
      assert.equal(harness.reviewCalls.includes("promote"), false);
      const terminal = harness.traces.findLast((event) => event.type === "quality.gate_evaluated");
      assert.equal(terminal.decision, "block");
      assert.ok(terminal.failures.includes("QUALITY_PIVOT_LIMIT_REACHED"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

test("retry cancellation and worker failure propagate without another critic or promote", async (t) => {
  await t.test("parent cancellation during retry preserves AbortError", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-cancel-"));
    const controller = new AbortController();
    const harness = createLoopHarness({
      workspace,
      plans: [plan("v1")],
      criticVerdicts: [verdict([refineFinding])],
      onWorker({ ordinal, signal }) {
        if (ordinal === 3) {
          controller.abort(new DOMException("cancel retry", "AbortError"));
          signal.throwIfAborted();
        }
      },
    });
    try {
      await assert.rejects(
        harness.agent.runTurn("refactor v1 foundation and integration safely", [], { signal: controller.signal }),
        (error) => error?.name === "AbortError",
      );
      assert.deepEqual(harness.reviewCalls, ["critic"]);
      assert.equal(
        harness.traces.findLast((event) => event.type === "quality.gate_evaluated")?.decision,
        "block",
      );
      assert.equal(
        harness.traces.some((event) => event.type === "quality.completed"),
        false,
        "an interrupted retry must not be projected as completed",
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  await t.test("worker failure during retry blocks the run", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-worker-failure-"));
    const harness = createLoopHarness({
      workspace,
      plans: [plan("v1")],
      criticVerdicts: [verdict([refineFinding])],
      onWorker({ ordinal }) {
        if (ordinal === 3) throw new Error("retry worker exploded");
      },
    });
    try {
      const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
      assert.equal(result.qualityStatus, "block");
      assert.match(result.text, /worker.*failed|executor failed/i);
      assert.deepEqual(harness.reviewCalls, ["critic"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

test("same-provider different-model critic remains unproven despite a distinct reviewer run", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-same-provider-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    reviewRoute: { provider: "openai", model: "gpt-5.6-sol" },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
    assert.equal(result.qualityStatus, "unproven");
    assert.deepEqual(harness.reviewCalls, ["critic"]);
    assert.equal(harness.traces.some((event) =>
      event.type === "quality.stage_started" && event.stage === "promote"
    ), false);
    const critic = harness.traces.find((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "critic"
    );
    assert.equal(critic.independentVerification, false);
    assert.ok(critic.failures.includes("INDEPENDENT_PROVIDER_UNAVAILABLE"));
    assert.equal(critic.failures.includes("INDEPENDENT_REVIEWER_UNAVAILABLE"), false);
    assert.ok(critic.failures.includes("INDEPENDENT_REVIEW_UNAVAILABLE"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an alternate-provider critic without explicit or observed route evidence remains unproven", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-missing-review-route-evidence-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    requireObservedReviewRoute: true,
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
    assert.equal(result.qualityStatus, "unproven");
    assert.deepEqual(harness.reviewCalls, ["critic"]);
    const critic = harness.traces.find((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "critic"
    );
    assert.equal(critic.independentVerification, false);
    assert.ok(critic.failures.includes("REVIEW_ROUTE_EVIDENCE_MISSING"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("observed critic route evidence is bound to the declared route and reviewer run identity", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-observed-review-route-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    requireObservedReviewRoute: true,
    observedReviewRoute: { provider: "anthropic", model: "claude-review" },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
    assert.equal(result.qualityStatus, "proceed");
    const criticStage = harness.traces.find((event) =>
      event.type === "quality.stage_started" && event.stage === "critic"
    );
    const criticGate = harness.traces.find((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "critic"
    );
    assert.equal(criticGate.independentVerification, true);
    assert.equal(criticGate.reviewerRunId, criticStage.agentRunId);
    assert.match(criticGate.reviewerRunId, /:critic:0:reviewer$/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a critic route telemetry mismatch cannot prove independent review", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-mismatched-review-route-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [verdict()],
    requireObservedReviewRoute: true,
    observedReviewRoute: { provider: "openai", model: "gpt-5.4" },
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
    assert.equal(result.qualityStatus, "unproven");
    const critic = harness.traces.find((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "critic"
    );
    assert.equal(critic.independentVerification, false);
    assert.ok(critic.failures.includes("REVIEW_ROUTE_EVIDENCE_MISMATCH"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a worker agent cannot review its own retry artifacts", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-quality-loop-self-review-"));
  const harness = createLoopHarness({
    workspace,
    plans: [plan("v1")],
    criticVerdicts: [],
    selfReview: true,
  });

  try {
    const result = await harness.agent.runTurn("refactor v1 foundation and integration safely");
    assert.equal(result.qualityStatus, "block");
    assert.equal(harness.reviewCalls.length, 0);
    assert.equal(harness.traces.some((event) =>
      event.type === "quality.stage_started" && event.stage === "promote"
    ), false);
    const gate = harness.traces.find((event) =>
      event.type === "quality.gate_evaluated" && event.stage === "critic"
    );
    assert.equal(gate.decision, "block");
    assert.ok(gate.failures.includes("READ_ONLY_REVIEWER_UNAVAILABLE"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
