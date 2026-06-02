import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TeamBinding, createSdkAdapter } from "@unclecode/orchestrator";
import { createTeamRun, generateRunId } from "@unclecode/session-store";

function makeBinding() {
  const dataRoot = mkdtempSync(join(process.cwd(), ".test-tmp-sdk-"));
  const runId = generateRunId();
  const ref = createTeamRun({
    dataRoot,
    runId,
    objective: "sdk adapter test",
    persona: "coder",
    lanes: 1,
    gate: "warn",
    runtime: "local",
    workspaceRoot: dataRoot,
    createdBy: "tests",
  });
  const binding = new TeamBinding({
    runId: ref.runId,
    runRoot: ref.runRoot,
    role: "worker",
    workspaceRoot: dataRoot,
  });
  return { binding, dataRoot };
}

function fakeProvider() {
  return { query: async () => ({ content: "", actions: [], costUsd: 0 }) };
}

function fakeMiniLoop(submission, status = "submitted") {
  return async (args) => ({
    status,
    submission,
    steps: 1,
    costUsd: 0,
    args,
  });
}

const SDK_IDS = ["openai", "anthropic", "gemini"];

test("sdk adapter id surfaces the runtime it serves", () => {
  for (const id of SDK_IDS) {
    const adapter = createSdkAdapter({
      id,
      providerFactory: fakeProvider,
      miniLoopRunner: fakeMiniLoop("x"),
    });
    assert.equal(adapter.id, id);
  }
});

test("sdk adapter run() returns submission from injected mini-loop", async () => {
  const { binding, dataRoot } = makeBinding();
  try {
    const adapter = createSdkAdapter({
      id: "openai",
      providerFactory: fakeProvider,
      miniLoopRunner: fakeMiniLoop("hello-from-stub"),
    });
    const result = await adapter.run(
      { workerId: "w1", persona: "coder", task: "stub task", runtime: "openai" },
      { binding, cwd: dataRoot, env: { OPENAI_API_KEY: "sk-test" } },
    );
    assert.equal(result.ok, true);
    assert.equal(result.submission, "hello-from-stub");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("sdk adapter forwards runtime mode and execution policy profile to mini-loop", async () => {
  const { binding, dataRoot } = makeBinding();
  let observedArgs;
  const profile = {
    id: "test.enforce",
    mode: "enforce",
    defaultEffect: "deny",
    rules: [],
  };
  try {
    const adapter = createSdkAdapter({
      id: "openai",
      providerFactory: fakeProvider,
      miniLoopRunner: async (args) => {
        observedArgs = args;
        return {
          status: "submitted",
          submission: "ok",
          steps: 1,
          costUsd: 0,
        };
      },
    });
    await adapter.run(
      { workerId: "w1", persona: "coder", task: "stub task", runtime: "openai" },
      {
        binding,
        cwd: dataRoot,
        runtimeMode: "openshell",
        executionPolicyProfile: profile,
        env: { OPENAI_API_KEY: "sk-test" },
      },
    );

    assert.equal(observedArgs.runtimeMode, "openshell");
    assert.equal(observedArgs.executionPolicyProfile, profile);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("sdk adapter run() reports ok=false when mini-loop returns non-submitted status", async () => {
  const { binding, dataRoot } = makeBinding();
  try {
    const adapter = createSdkAdapter({
      id: "anthropic",
      providerFactory: fakeProvider,
      miniLoopRunner: fakeMiniLoop("partial", "halted"),
    });
    const result = await adapter.run(
      { workerId: "w1", persona: "coder", task: "x", runtime: "anthropic" },
      { binding, cwd: dataRoot, env: { ANTHROPIC_API_KEY: "k" } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.submission, "partial");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("sdk adapter preflight reports missing credential per provider env", () => {
  const cases = [
    { id: "openai", envName: "OPENAI_API_KEY" },
    { id: "anthropic", envName: "ANTHROPIC_API_KEY" },
    { id: "gemini", envName: "GEMINI_API_KEY" },
  ];
  for (const c of cases) {
    const adapter = createSdkAdapter({
      id: c.id,
      providerFactory: fakeProvider,
      miniLoopRunner: fakeMiniLoop("x"),
    });
    const result = adapter.preflight({});
    assert.equal(result.status, "missing", `${c.id} missing without env`);
    assert.match(result.reason, new RegExp(c.envName));
  }
});

test("sdk adapter preflight returns ok when credential env present", () => {
  for (const c of [
    { id: "openai", env: { OPENAI_API_KEY: "sk-test" } },
    { id: "anthropic", env: { ANTHROPIC_API_KEY: "sk-ant" } },
    { id: "gemini", env: { GEMINI_API_KEY: "g" } },
  ]) {
    const adapter = createSdkAdapter({
      id: c.id,
      providerFactory: fakeProvider,
      miniLoopRunner: fakeMiniLoop("x"),
    });
    assert.equal(adapter.preflight(c.env).status, "ok");
  }
});

test("sdk adapter run() fails fast when credential env missing", async () => {
  const { binding, dataRoot } = makeBinding();
  try {
    const adapter = createSdkAdapter({
      id: "gemini",
      providerFactory: fakeProvider,
      miniLoopRunner: fakeMiniLoop("x"),
    });
    await assert.rejects(
      adapter.run(
        { workerId: "w1", persona: "coder", task: "x", runtime: "gemini" },
        { binding, cwd: dataRoot, env: {} },
      ),
      /GEMINI_API_KEY/,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("sdk adapter forwards spec.model into provider factory", async () => {
  const { binding, dataRoot } = makeBinding();
  let observedModel;
  try {
    const adapter = createSdkAdapter({
      id: "openai",
      providerFactory: ({ model }) => {
        observedModel = model;
        return fakeProvider();
      },
      miniLoopRunner: fakeMiniLoop("ok"),
    });
    await adapter.run(
      {
        workerId: "w1",
        persona: "coder",
        task: "x",
        runtime: "openai",
        model: "gpt-5.5",
      },
      { binding, cwd: dataRoot, env: { OPENAI_API_KEY: "k" } },
    );
    assert.equal(observedModel, "gpt-5.5");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
