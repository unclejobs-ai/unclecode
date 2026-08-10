import assert from "node:assert/strict";
import test from "node:test";

import { applyTraceEventToAgentConsole } from "@unclecode/orchestrator";
import { RuntimeCodingAgent } from "../../packages/orchestrator/src/runtime-coding-agent.ts";
import { attributeTraceToAgentRun } from "../../packages/orchestrator/src/work-agent-lifecycle.ts";

const OMP_PROVIDER = "omp";
const OMP_DEFAULT_SELECTOR = "kimi-code/k3";

const SUPPORTED_REASONING = {
  effort: "none",
  source: "mode-default",
  support: { status: "supported", defaultEffort: "none", supportedEfforts: ["none"] },
};

/**
 * One OMP worker turn as the Bun helper reports it, already mapped onto the
 * `AgentTurnResult` shape the provider boundary owns.
 */
function ompTurnResult(overrides = {}) {
  return {
    text: "worker answered",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheWriteTokens: 120,
      ...(overrides.usage ?? {}),
    },
    costUsd: overrides.costUsd ?? 0.0042,
  };
}

function createOmpAgent(results) {
  const queue = [...results];
  const events = [];
  const agent = new RuntimeCodingAgent({
    provider: OMP_PROVIDER,
    apiKey: "",
    model: OMP_DEFAULT_SELECTOR,
    cwd: "/tmp",
    reasoning: SUPPORTED_REASONING,
    providerOverride: {
      clear() {},
      setTraceListener() {},
      updateRuntimeSettings() {},
      async runTurn() {
        const next = queue.shift();
        assert.ok(next, "the OMP stub ran more turns than the test queued");
        return next;
      },
    },
  });
  agent.setTraceListener((event) => events.push(event));
  return { agent, events };
}

function usageEvents(events) {
  return events.filter((event) => event.type === "usage.recorded");
}

function createRunningConsole(runId, jobId) {
  const queued = applyTraceEventToAgentConsole(
    { profileId: "build", activity: [], agents: [], jobs: [] },
    {
      type: "job.queued",
      eventId: `queued:${jobId}`,
      jobId,
      jobType: "work-node",
      label: "OMP worker",
      queuedAt: 90,
    },
  );
  return applyTraceEventToAgentConsole(queued, {
    type: "agent.run.started",
    eventId: `started:${runId}`,
    runId,
    jobId,
    displayName: "OmpWorker",
    agentType: "executor",
    startedAt: 100,
  });
}

test("one OMP worker turn emits exactly one usage.recorded carrying cache read, cache write, and cost", async () => {
  const { agent, events } = createOmpAgent([ompTurnResult()]);

  await agent.runTurn("route this through the OMP worker");

  const recorded = usageEvents(events);
  assert.equal(recorded.length, 1, "an OMP turn must produce exactly one usage identity");
  const [usage] = recorded;
  assert.equal(usage.provider, OMP_PROVIDER);
  assert.equal(usage.model, OMP_DEFAULT_SELECTOR);
  assert.equal(usage.inputTokens, 1_200);
  assert.equal(usage.outputTokens, 340);
  assert.equal(usage.cacheReadTokens, 900);
  assert.equal(usage.cacheWriteTokens, 120);
  assert.equal(usage.costUsd, 0.0042);
  assert.equal(typeof usage.eventId, "string");
  assert.ok(usage.eventId.length > 0);

  // The lifecycle events that frame the turn must agree on the OMP identity, so
  // the console cannot show one provider in the route and another in the ledger.
  const framed = events.filter((event) =>
    event.type === "turn.started"
    || event.type === "provider.route"
    || event.type === "provider.calling"
    || event.type === "turn.completed"
  );
  assert.deepEqual(framed.map((event) => event.provider), framed.map(() => OMP_PROVIDER));
  assert.deepEqual(framed.map((event) => event.model), framed.map(() => OMP_DEFAULT_SELECTOR));
});

test("OMP usage lands on exactly one agent-run ledger and replay never double counts", async () => {
  const runId = "run-omp-worker";
  const jobId = "job-omp-worker";
  const { agent, events } = createOmpAgent([ompTurnResult()]);

  await agent.runTurn("delegate to the worker");

  const [raw] = usageEvents(events);
  const scoped = attributeTraceToAgentRun(raw, runId);
  assert.equal(scoped.agentRunId, runId);

  const started = createRunningConsole(runId, jobId);
  const recorded = applyTraceEventToAgentConsole(started, scoped);

  assert.equal(recorded.mainUsage, undefined, "a scoped worker turn must not charge the session ledger");
  assert.deepEqual(recorded.agents[0]?.usage, {
    eventIds: [raw.eventId],
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadTokens: 900,
    cacheWriteTokens: 120,
    costUsd: 0.0042,
    routes: [{
      provider: OMP_PROVIDER,
      model: OMP_DEFAULT_SELECTOR,
      eventIds: [raw.eventId],
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheWriteTokens: 120,
      costUsd: 0.0042,
    }],
  });

  // Replaying the persisted event, and replaying it with a rewritten scope, both
  // have to be inert: the identity already belongs to one ledger.
  assert.strictEqual(applyTraceEventToAgentConsole(recorded, scoped), recorded);
  const { agentRunId: _dropped, ...unscoped } = scoped;
  assert.strictEqual(applyTraceEventToAgentConsole(recorded, unscoped), recorded);
});

test("repeated OMP worker turns keep one route with exact totals and distinct identities", async () => {
  const runId = "run-omp-retry";
  const jobId = "job-omp-retry";
  const { agent, events } = createOmpAgent([
    ompTurnResult(),
    ompTurnResult({
      usage: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 1_100, cacheWriteTokens: 0 },
      costUsd: 0.0008,
    }),
  ]);

  await agent.runTurn("first worker pass");
  await agent.runTurn("second worker pass after operator guidance");

  const recorded = usageEvents(events);
  assert.equal(recorded.length, 2);
  assert.notEqual(
    recorded[0].eventId,
    recorded[1].eventId,
    "two provider requests must not share one usage identity",
  );

  let snapshot = createRunningConsole(runId, jobId);
  for (const event of recorded) {
    snapshot = applyTraceEventToAgentConsole(snapshot, attributeTraceToAgentRun(event, runId));
  }

  const usage = snapshot.agents[0]?.usage;
  assert.equal(usage?.eventIds.length, 2);
  assert.equal(usage?.inputTokens, 1_500);
  assert.equal(usage?.outputTokens, 400);
  assert.equal(usage?.cacheReadTokens, 2_000);
  assert.equal(usage?.cacheWriteTokens, 120);
  assert.equal(usage?.costUsd, 0.005);
  assert.equal(usage?.routes?.length, 1, "one selector must not fan out into several routes");
  assert.equal(usage.routes[0].provider, OMP_PROVIDER);
  assert.equal(usage.routes[0].model, OMP_DEFAULT_SELECTOR);
  assert.equal(usage.routes[0].cacheReadTokens, 2_000);
  assert.equal(usage.routes[0].cacheWriteTokens, 120);

  // Replaying the whole run in order is idempotent, so a resumed session shows
  // the same totals it persisted.
  let replayed = snapshot;
  for (const event of recorded) {
    replayed = applyTraceEventToAgentConsole(replayed, attributeTraceToAgentRun(event, runId));
  }
  assert.strictEqual(replayed, snapshot);
});
