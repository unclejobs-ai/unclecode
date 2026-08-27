import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pluginHost from "@unclecode/plugin-host";

import {
  PluginHost,
  PluginTrustError,
  discoverPluginNames,
  isWorkspaceTrusted,
  listTrustedWorkspaces,
  recordWorkspaceTrust,
  revokeWorkspaceTrust,
} from "@unclecode/plugin-host";

const MAX_CONTEXT_CONTRIBUTION_CHARS = 2_000;
const MAX_CONTEXT_CONTRIBUTION_TOTAL_CHARS = 6_000;

function qualityGraph() {
  return {
    id: "quality-graph",
    qualityProfile: "standard",
    currentStage: "work",
    gateStatus: "unproven",
    iteration: 0,
    approval: "approved",
    nodes: [
      {
        id: "work-1",
        title: "Implement",
        prompt: "Implement the change.",
        status: "running",
        dependsOn: [],
        fileOwnership: ["src/change.ts"],
        acceptanceCriteria: ["Focused tests pass"],
        evidenceRefs: [],
        stage: "work",
        role: "worker",
        attempt: 0,
        artifactRefs: [],
        reviewRequired: true,
      },
    ],
  };
}

test("PluginHost dispatches lifecycle events to registered hooks", async () => {
  const host = new PluginHost();
  const calls = [];
  host.register("audit", {
    async toolExecuteBefore(event) {
      calls.push(`before:${event.toolName}`);
    },
    async toolExecuteAfter(event) {
      calls.push(`after:${event.toolName}:${event.isError ? "err" : "ok"}`);
    },
    async runCompleted(event) {
      calls.push(`done:${event.runId}:${event.status}`);
    },
  });
  await host.dispatchToolExecuteBefore({ toolName: "write_file", input: {} });
  await host.dispatchToolExecuteAfter({ toolName: "write_file", output: "ok", isError: false });
  await host.dispatchRunCompleted({ runId: "tr_x", status: "accepted" });
  assert.deepEqual(calls, ["before:write_file", "after:write_file:ok", "done:tr_x:accepted"]);
});

test("PluginHost.loadEntries instantiates plugin entries via context", async () => {
  const host = new PluginHost();
  const seen = [];
  await host.loadEntries(process.cwd(), [
    {
      name: "tracker",
      async entry(ctx) {
        seen.push(ctx.workspaceRoot);
        return {
          toolExecuteAfter: () => seen.push("after"),
        };
      },
    },
  ]);
  assert.equal(seen.length, 1);
  assert.equal(host.list().length, 1);
});

test("decision hooks aggregate deterministically and a block cannot be overridden", async () => {
  const host = new PluginHost();
  host.register("refiner", {
    afterNodeCompleted: () => ({ action: "refine", reason: "tighten the tests" }),
  });
  host.register("policy", {
    afterNodeCompleted: () => ({ action: "block", reason: "policy evidence is missing" }),
  });
  host.register("optimist", {
    afterNodeCompleted: () => ({ action: "proceed", reason: "looks fine" }),
  });

  const decision = await host.dispatchAfterNodeCompleted({
    runId: "run-1",
    graph: qualityGraph(),
    node: qualityGraph().nodes[0],
    outcome: { nodeId: "work-1", status: "completed", summary: "done", evidenceRefs: [] },
    artifactHash: "sha256:artifact",
    producerId: "worker-1",
    evidence: [],
    findings: [],
    independentProviderAvailable: true,
    independentReviewerAvailable: true,
    refineCount: 0,
    pivotCount: 0,
  });

  assert.equal(decision.action, "block");
  assert.deepEqual(
    decision.decisions.map(({ pluginName, action }) => ({ pluginName, action })),
    [
      { pluginName: "refiner", action: "refine" },
      { pluginName: "policy", action: "block" },
      { pluginName: "optimist", action: "proceed" },
    ],
  );
});

test("beforeNodeDispatch composes typed replacement nodes in registration order", async () => {
  const host = new PluginHost();
  host.register("first", {
    beforeNodeDispatch: ({ node }) => ({
      action: "proceed",
      replacementNode: { ...node, attempt: node.attempt + 1 },
    }),
  });
  host.register("second", {
    beforeNodeDispatch: ({ node }) => ({
      action: "proceed",
      replacementNode: { ...node, prompt: `${node.prompt}\nQuality context applied.` },
    }),
  });

  const graph = qualityGraph();
  const decision = await host.dispatchBeforeNodeDispatch({
    runId: "run-1",
    graph,
    node: graph.nodes[0],
  });

  assert.equal(decision.action, "proceed");
  assert.equal(decision.node.attempt, 1);
  assert.match(decision.node.prompt, /Quality context applied/);
});

test("context contributions are bounded by plugin and total limits and attributed", async () => {
  const host = new PluginHost();
  for (const name of ["alpha", "beta", "gamma", "delta"]) {
    host.register(name, {
      contextContribute: () => ({ content: name.repeat(MAX_CONTEXT_CONTRIBUTION_CHARS) }),
    });
  }

  const contributions = await host.dispatchContextContribute({
    runId: "run-1",
    graphId: "quality-graph",
    profile: "standard",
    stage: "work",
  });

  assert.deepEqual(contributions.map((item) => item.pluginName), ["alpha", "beta", "gamma"]);
  assert.ok(contributions.every((item) => item.content.length <= MAX_CONTEXT_CONTRIBUTION_CHARS));
  assert.ok(
    contributions.reduce((total, item) => total + item.content.length, 0)
      <= MAX_CONTEXT_CONTRIBUTION_TOTAL_CHARS,
  );
});

test("the compiled SCC quality engine registers without workspace trust and delegates plan validation", async () => {
  const host = new PluginHost();
  pluginHost.registerBuiltInSccQualityEngine(host, { workspaceRoot: process.cwd() });

  assert.deepEqual(host.list().map(({ name, source }) => ({ name, source })), [
    { name: "scc-quality-engine", source: "builtin" },
  ]);

  const invalid = qualityGraph();
  invalid.nodes[0].acceptanceCriteria = [];
  const decision = await host.dispatchPlanCreated({ runId: "run-1", graph: invalid });
  assert.equal(decision.action, "block");
  assert.deepEqual(decision.failures, ["MISSING_ACCEPTANCE_CRITERIA"]);

  const classification = await host.dispatchRunClassified({
    runId: "run-1",
    prompt: "Refactor a risky authentication flow",
    complexity: "complex",
    risk: "high",
    creatorIntent: false,
    proposedProfile: "deep",
  });
  assert.equal(classification.action, "proceed");
});

test("discoverPluginNames lists ts/mjs files in .unclecode/plugins", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-plugins-"));
  try {
    const pluginsDir = join(dir, ".unclecode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "alpha.ts"), "export default () => ({})");
    writeFileSync(join(pluginsDir, "beta.mjs"), "export default () => ({})");
    writeFileSync(join(pluginsDir, "gamma.txt"), "ignored");
    const names = discoverPluginNames(dir);
    assert.deepEqual(names.sort(), ["alpha", "beta"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFromDisk refuses untrusted workspaces and accepts trusted ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "uc-trust-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "uc-trust-ws-"));
  try {
    const pluginsDir = join(workspace, ".unclecode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "tap.mjs"),
      "export default ({ log }) => { log('loaded'); return { runStarted: () => {} }; };",
    );

    const host = new PluginHost();
    assert.equal(isWorkspaceTrusted(workspace, home), false);
    assert.deepEqual(listTrustedWorkspaces(home), []);

    await assert.rejects(
      () => host.loadFromDisk(workspace, { homeDir: home }),
      (err) => err instanceof PluginTrustError && err.workspaceRoot.includes("uc-trust-ws-"),
    );

    recordWorkspaceTrust(workspace, home);
    assert.equal(isWorkspaceTrusted(workspace, home), true);

    const loaded = await host.loadFromDisk(workspace, { homeDir: home });
    assert.deepEqual([...loaded], ["tap"]);
    assert.equal(host.list().length, 1);

    revokeWorkspaceTrust(workspace, home);
    assert.equal(isWorkspaceTrusted(workspace, home), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadFromDisk respects requireTrust:false escape hatch", async () => {
  const home = mkdtempSync(join(tmpdir(), "uc-trust-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "uc-trust-ws-"));
  try {
    const pluginsDir = join(workspace, ".unclecode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "auto.mjs"),
      "export default () => ({ runCompleted: () => {} });",
    );
    const host = new PluginHost();
    const loaded = await host.loadFromDisk(workspace, {
      homeDir: home,
      requireTrust: false,
    });
    assert.deepEqual([...loaded], ["auto"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
