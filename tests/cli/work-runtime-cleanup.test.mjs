import assert from "node:assert/strict";
import test from "node:test";

import {
  loadWorkShellDashboardProps,
  runWorkCli,
  smokeWorkShellRuntime,
} from "../../apps/unclecode-cli/src/work-runtime.ts";

const reasoning = {
  effort: "medium",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["none", "low", "medium", "high"],
  },
};

function sessionFixture(dispose) {
  return {
    agent: {
      async runTurn() { return { text: "owner-only" }; },
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
    },
    prompt: "",
    dispose,
    options: {
      provider: "openai",
      model: "test-model",
      mode: "standard",
      authLabel: "test-auth",
      reasoning,
      modelWindow: 128_000,
      contextSummaryLines: [],
      cwd: process.cwd(),
      homeState: {
        modeLabel: "standard",
        authLabel: "test-auth",
        sessionCount: 0,
        mcpServerCount: 0,
        mcpServers: [],
        sessions: [],
      },
      runAction: async ({ actionId }) => actionId === "mcp-inspect"
        ? ["No MCP server selected"]
        : ["Work context status ready"],
      runSession: async () => ["Resume context"],
      launchWorkSession: async () => {},
    },
  };
}

test("dashboard props retain bootstrap ownership until their controller disposes them", async () => {
  let disposeCalls = 0;
  const props = await loadWorkShellDashboardProps([], {
    loadSession: async () => sessionFixture(() => { disposeCalls += 1; }),
  });

  assert.equal(disposeCalls, 0);
  assert.equal(typeof props.dispose, "function");
  await props.dispose();
  assert.equal(disposeCalls, 1);
});

test("runtime smoke always disposes its bootstrap session", async () => {
  let disposeCalls = 0;
  const lines = await smokeWorkShellRuntime([], {
    loadSession: async () => sessionFixture(() => { disposeCalls += 1; }),
  });

  assert.ok(lines.includes("Work shell TUI smoke OK"));
  assert.equal(disposeCalls, 1);
});

test("interactive CLI exit disposes the attached client session", async () => {
  let disposeCalls = 0;
  let starts = 0;
  await assert.rejects(
    runWorkCli([], {
      loadInteractiveSession: async () =>
        sessionFixture(() => {
          disposeCalls += 1;
        }),
      startInteractiveSession: async () => {
        starts += 1;
        throw new Error("renderer failed during exit");
      },
    }),
    /renderer failed during exit/,
  );

  assert.equal(starts, 1);
  assert.equal(disposeCalls, 1);
});
