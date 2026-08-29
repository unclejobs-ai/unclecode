import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  await host.dispatchToolExecuteBefore({ runId: "tr_x", toolName: "write_file", input: {} });
  await host.dispatchToolExecuteAfter({ runId: "tr_x", toolName: "write_file", output: "ok", isError: false });
  await host.dispatchRunCompleted({ runId: "tr_x", status: "accepted" });
  assert.deepEqual(calls, ["before:write_file", "after:write_file:ok", "done:tr_x:accepted"]);
});

test("tool and file hook dispatch rejects a missing run scope instead of globally deduping as unscoped", async () => {
  const diagnostics = [];
  const host = new PluginHost({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  host.register("workspace-tools", {
    toolExecuteBefore: () => { throw new Error("tool hook failed"); },
    fileEdited: () => { throw new Error("file hook failed"); },
  }, "workspace");

  await assert.rejects(
    () => host.dispatchToolExecuteBefore({ toolName: "write_file", input: {} }),
    /runId/i,
  );
  await assert.rejects(
    () => host.dispatchFileEdited({ path: "src/a.ts", sha256: "sha256:a" }),
    /runId/i,
  );
  assert.deepEqual(diagnostics, [], "a scope contract error is not attributed to a plugin hook");
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

test("same-source registration replacement disposes the previous hooks exactly once", async () => {
  const host = new PluginHost();
  const calls = [];
  let disposed = 0;
  await host.register("audit", {
    runStarted: () => calls.push("old"),
    dispose: () => { disposed += 1; },
  });

  await host.register("audit", {
    runStarted: () => calls.push("new"),
  });
  await host.dispatchRunStarted({ runId: "run-replaced" });

  assert.equal(disposed, 1);
  assert.deepEqual(calls, ["new"]);
  assert.deepEqual(host.list().map(({ name, source }) => ({ name, source })), [
    { name: "audit", source: "memory" },
  ]);
});

test("reloading entries removes the previous listener and unload is source-aware", async () => {
  const host = new PluginHost();
  const events = new EventEmitter();
  const seen = [];
  let generation = 0;
  const entry = async () => {
    const current = ++generation;
    const listener = () => seen.push(current);
    events.on("tick", listener);
    return {
      runStarted: () => seen.push(`run:${current}`),
      dispose: () => events.off("tick", listener),
    };
  };

  await host.loadEntries(process.cwd(), [{ name: "watcher", entry }]);
  await host.loadEntries(process.cwd(), [{ name: "watcher", entry }]);

  assert.equal(events.listenerCount("tick"), 1);
  events.emit("tick");
  await host.dispatchRunStarted({ runId: "run-reload" });
  assert.deepEqual(seen, [2, "run:2"]);
  assert.equal(await host.unload("watcher", "workspace"), false);
  assert.equal(events.listenerCount("tick"), 1);
  assert.equal(await host.unload("watcher", "memory"), true);
  assert.equal(events.listenerCount("tick"), 0);
  assert.deepEqual(host.list(), []);
});

test("workspace registration cannot replace the trusted SCC built-in identity", async () => {
  const host = new PluginHost();
  pluginHost.registerBuiltInSccQualityEngine(host, { workspaceRoot: process.cwd() });
  const original = host.list()[0];

  await assert.rejects(
    () => host.register("scc-quality-engine", {
      planCreated: () => ({ action: "proceed" }),
    }, "workspace"),
    /conflict|source|built-?in/i,
  );

  assert.equal(host.list().length, 1);
  assert.equal(host.list()[0], original);
  assert.equal(host.list()[0].source, "builtin");
});

test("dispose removes every hook and listener exactly once and remains idempotent", async () => {
  const host = new PluginHost();
  const events = new EventEmitter();
  let disposed = 0;
  const listener = () => {};
  events.on("tick", listener);
  await host.register("listener", {
    runStarted: () => {},
    dispose: async () => {
      await Promise.resolve();
      events.off("tick", listener);
      disposed += 1;
    },
  });

  await Promise.all([host.dispose(), host.dispose()]);
  await host.dispose();

  assert.equal(disposed, 1);
  assert.equal(events.listenerCount("tick"), 0);
  assert.deepEqual(host.list(), []);
  await assert.rejects(
    () => host.register("late", {}),
    /disposed/i,
  );
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

test("beforeNodeDispatch rejects malformed replacement lifecycle fields at the host boundary", async () => {
  const invalidReplacements = [
    { status: "done" },
    { stage: "deploy" },
    { role: "owner" },
    { acceptanceCriteria: [""] },
  ];

  for (const replacement of invalidReplacements) {
    const host = new PluginHost();
    host.register("workspace-rewriter", {
      beforeNodeDispatch: ({ node }) => ({
        action: "proceed",
        replacementNode: { ...node, ...replacement },
      }),
    }, "workspace");
    const graph = qualityGraph();
    await assert.rejects(
      () => host.dispatchBeforeNodeDispatch({ runId: "run-invalid", graph, node: graph.nodes[0] }),
      /invalid replacement node/i,
    );
  }
});

test("host-owned SCC revalidation blocks an approved workspace replacement after built-in validation", async () => {
  const host = new PluginHost();
  pluginHost.registerBuiltInSccQualityEngine(host, { workspaceRoot: process.cwd() });
  host.register("workspace-optimist", {
    beforeNodeDispatch: ({ node }) => ({
      action: "proceed",
      replacementNode: { ...node, acceptanceCriteria: [] },
    }),
  }, "workspace");

  const graph = qualityGraph();
  const decision = await host.dispatchBeforeNodeDispatch({
    runId: "run-host-revalidation",
    graph,
    node: graph.nodes[0],
  });

  assert.equal(decision.action, "block");
  assert.ok(decision.failures.includes("MISSING_ACCEPTANCE_CRITERIA"));
  assert.ok(decision.decisions.some(({ pluginName, action }) =>
    pluginName === "unclecode-plugin-host" && action === "block"
  ));
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
  assert.equal(
    Object.hasOwn(host.list()[0].hooks, "stopHook"),
    false,
    "the in-process Quality Engine must not claim a Claude Stop hook",
  );

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

test("loadFromDisk reloads a workspace plugin without duplicate hooks or retained cleanup", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "uc-plugin-reload-"));
  const env = {};
  try {
    const pluginsDir = join(workspace, ".unclecode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "reloadable.mjs"),
      `export default ({ env }) => {
        const generation = Number(env.PLUGIN_GENERATION ?? "0") + 1;
        env.PLUGIN_GENERATION = String(generation);
        return {
          runStarted: () => { env.PLUGIN_CALLS = String(generation); },
          dispose: () => { env.PLUGIN_DISPOSED = String(Number(env.PLUGIN_DISPOSED ?? "0") + 1); },
        };
      };`,
    );
    const host = new PluginHost();

    assert.deepEqual(
      [...await host.loadFromDisk(workspace, { env, requireTrust: false })],
      ["reloadable"],
    );
    assert.deepEqual(
      [...await host.loadFromDisk(workspace, { env, requireTrust: false })],
      ["reloadable"],
    );
    assert.equal(env.PLUGIN_DISPOSED, "1");
    assert.equal(host.list().length, 1);

    await host.dispatchRunStarted({ runId: "run-disk-reload" });
    assert.equal(env.PLUGIN_CALLS, "2");
    rmSync(join(pluginsDir, "reloadable.mjs"));
    assert.deepEqual(
      [...await host.loadFromDisk(workspace, { env, requireTrust: false })],
      [],
    );
    assert.equal(env.PLUGIN_DISPOSED, "2");
    assert.deepEqual(host.list(), []);
    await host.dispose();
    assert.equal(env.PLUGIN_DISPOSED, "2", "host disposal must not re-clean an unloaded plugin");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("external hook failures emit one source-labelled diagnostic per run and preserve the cause", async () => {
  const diagnostics = [];
  const host = new PluginHost({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  const failure = new Error("Stop hook failed: zod/v3");
  host.register("claude-mem", {
    runClassified: () => {
      throw failure;
    },
  }, "cached");
  pluginHost.registerBuiltInSccQualityEngine(host, { workspaceRoot: process.cwd() });

  const event = {
    runId: "run-plugin-diagnostic",
    prompt: "review this",
    complexity: "complex",
    risk: "high",
    creatorIntent: false,
    proposedProfile: "deep",
  };
  await assert.rejects(() => host.dispatchRunClassified(event), (error) => error === failure);
  await assert.rejects(() => host.dispatchRunClassified(event), (error) => error === failure);

  assert.deepEqual(diagnostics, [{
    runId: "run-plugin-diagnostic",
    source: "cached",
    trustLane: "cached-external",
    pluginId: "claude-mem",
    pluginName: "claude-mem",
    hookName: "runClassified",
    status: "error",
    errorName: "Error",
    errorMessage: "Stop hook failed: zod/v3",
    exitStatus: undefined,
    dedupeKey: "sha256:595a95dc6b3af6680b1b5543236da928b1c812121623201e34013a6443c51a22",
  }]);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.pluginName === "scc-quality-engine"),
    false,
    "an external adapter failure must never be attributed to the built-in Quality Engine",
  );
});

test("workspace context and decision failures are typed independently for each run", async () => {
  const diagnostics = [];
  const host = new PluginHost({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  host.register("workspace-review", {
    contextContribute: () => {
      throw new Error("context unavailable");
    },
    beforeNodeDispatch: () => {
      throw Object.assign(new Error("review process failed"), { exitStatus: 2 });
    },
  }, "workspace");

  await assert.rejects(() => host.dispatchContextContribute({
    runId: "run-a",
    graphId: "quality-graph",
    profile: "standard",
    stage: "work",
  }), /context unavailable/);
  const graph = qualityGraph();
  await assert.rejects(() => host.dispatchBeforeNodeDispatch({
    runId: "run-b",
    graph,
    node: graph.nodes[0],
  }), /review process failed/);

  assert.deepEqual(
    diagnostics.map(({ runId, source, trustLane, hookName, exitStatus }) => ({
      runId, source, trustLane, hookName, exitStatus,
    })),
    [
      { runId: "run-a", source: "workspace", trustLane: "workspace-trusted", hookName: "contextContribute", exitStatus: undefined },
      { runId: "run-b", source: "workspace", trustLane: "workspace-trusted", hookName: "beforeNodeDispatch", exitStatus: "2" },
    ],
  );
});

test("a failing diagnostic sink cannot replace the external hook's original cause", async () => {
  const hookFailure = new Error("Stop hook failed: zod/v3");
  const host = new PluginHost({
    onDiagnostic: () => {
      throw new Error("diagnostic transport unavailable");
    },
  });
  host.register("workspace-stop-adapter", {
    runCompleted: () => {
      throw hookFailure;
    },
  }, "workspace");

  await assert.rejects(
    () => host.dispatchRunCompleted({ runId: "run-sink-failure", status: "failed" }),
    (error) => error === hookFailure,
  );
});
