import assert from "node:assert/strict";
import test from "node:test";

import * as workRuntime from "../../apps/unclecode-cli/src/work-runtime.ts";

const reasoning = {
  effort: "high",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
};

function ownerState(sessionId) {
  return {
    entries: [],
    model: `model-${sessionId}`,
    mode: "standard",
    reasoning,
    authLabel: "owner-auth",
    bridgeLines: [],
    memoryLines: [],
    panel: { title: "", lines: [] },
    traceLines: [],
    liveTraceLines: [],
    traceMode: "minimal",
    composerMode: "default",
    isBusy: false,
    contextSourceActionsEnabled: false,
    contextPolicySuggestions: [],
    contextAdviceActionsEnabled: false,
    modelWindow: 128_000,
    queuedCount: 0,
    queuePaused: false,
    terminalColumns: 80,
    contextInspectorCursor: -1,
    contextInspectorExpanded: null,
    contextInspectorDetailOffset: 0,
    contextInspectorOpen: false,
    contextInspectorPane: "sources",
    contextInspectorCollection: "all",
    agentConsole: { agents: [], jobs: [] },
    agentConsoleView: { open: false, tab: "agents", cursor: 0, inspectorOpen: false },
  };
}

function sessionFixture(cwd) {
  return {
    agent: {
      runTurn: async () => ({ text: "owner-only" }),
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
    },
    options: {
      provider: "openai",
      model: "model-work-1",
      mode: "standard",
      authLabel: "owner-auth",
      reasoning,
      cwd,
      modelWindow: 128_000,
      contextSummaryLines: [],
      homeState: {
        modeLabel: "standard",
        authLabel: "owner-auth",
        sessionCount: 2,
        mcpServerCount: 0,
        mcpServers: [],
        sessions: [],
      },
      sessionId: "work-1",
    },
  };
}

function unwrapPaneEngine(snapshot) {
  const wrapper = snapshot.renderWorkPane({ openSessions() {}, syncHomeState() {} });
  return wrapper.props.buildPane({ onExit() {} });
}

async function flushPoll() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("persistent owner controller remounts and switches sessions without bootstrapping a second owner", async () => {
  const createController = workRuntime.createPersistentOwnerWorkShellController;
  assert.equal(typeof createController, "function");
  const sessions = new Map();
  const creates = [];
  const attaches = [];
  let replacementConnections = 0;
  const client = {
    async createRuntimeSession(input) {
      creates.push(input);
      sessions.set(input.sessionId, { revision: 1, state: ownerState(input.sessionId) });
      return { ok: true, session: { sessionId: input.sessionId } };
    },
    async attachRuntimeSession(sessionId) {
      attaches.push(sessionId);
      return sessions.has(sessionId)
        ? { ok: true, session: { sessionId } }
        : { ok: false, code: "not_found", message: "missing" };
    },
    async readEngineState(sessionId) {
      const session = sessions.get(sessionId);
      return session
        ? { ok: true, revision: session.revision, state: session.state, result: null }
        : { ok: false, code: "not_attached", message: "missing" };
    },
    async invokeEngineMethod(input) {
      const session = sessions.get(input.sessionId);
      session.revision += 1;
      return { ok: true, revision: session.revision, state: session.state, result: undefined };
    },
  };
  const controller = await createController({
    client,
    session: sessionFixture(process.cwd()),
    reconnectOwner: async () => {
      replacementConnections += 1;
      return client;
    },
  });

  const firstMount = unwrapPaneEngine(controller.initialProps);
  const remount = unwrapPaneEngine(controller.initialProps);
  assert.equal(firstMount.engine, remount.engine, "pane remount must reuse the shared attachment engine");
  assert.equal(firstMount.engineOwnership, "shared");

  await controller.embeddedWorkPane.openEmbeddedWorkSession(["--session-id", "work-2"]);
  const switchedPane = unwrapPaneEngine(controller.embeddedWorkPane);
  assert.equal(switchedPane.engine.getSessionId(), "work-2");
  assert.notEqual(switchedPane.engine, firstMount.engine);
  assert.deepEqual(creates.map((input) => input.sessionId), ["work-1", "work-2"]);
  assert.deepEqual(creates.map((input) => input.resume), [false, true]);
  assert.deepEqual(attaches, ["work-1", "work-2"]);
  assert.equal(replacementConnections, 0, "healthy session switching must reuse the existing owner endpoint");

  await firstMount.engine.setMode("deep");
  controller.dispose();
  await assert.rejects(firstMount.engine.setMode("standard"), /attachment is closed/i);
  await assert.rejects(switchedPane.engine.setMode("standard"), /attachment is closed/i);
});

test("persistent owner controller reattaches an existing session after owner replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sessions = new Map();
  let originalReads = 0;
  const originalClient = {
    async createRuntimeSession(input) {
      sessions.set(input.sessionId, { revision: 4, state: ownerState(input.sessionId) });
      return { ok: true, session: { sessionId: input.sessionId } };
    },
    async attachRuntimeSession(sessionId) {
      return { ok: true, session: { sessionId } };
    },
    async readEngineState(sessionId) {
      originalReads += 1;
      if (originalReads === 1) {
        const session = sessions.get(sessionId);
        return { ok: true, revision: session.revision, state: session.state, result: null };
      }
      return { ok: false, code: "not_attached", message: "old owner stopped", revision: 4 };
    },
  };
  const replacementAttaches = [];
  const replacementClient = {
    async attachRuntimeSession(sessionId) {
      replacementAttaches.push(sessionId);
      return { ok: true, session: { sessionId } };
    },
    async readEngineState(sessionId) {
      return {
        ok: true,
        revision: 5,
        state: { ...ownerState(sessionId), model: "replacement-model" },
        result: null,
      };
    },
  };
  let reconnects = 0;
  const controller = await workRuntime.createPersistentOwnerWorkShellController({
    client: originalClient,
    session: sessionFixture(process.cwd()),
    resume: false,
    reconnectOwner: async () => {
      reconnects += 1;
      return replacementClient;
    },
  });
  const pane = unwrapPaneEngine(controller.initialProps);
  pane.engine.subscribe(() => {});

  t.mock.timers.tick(100);
  await flushPoll();
  assert.equal(pane.engine.getState().remoteConnection?.state, "disconnected");
  t.mock.timers.tick(100);
  await flushPoll();

  assert.equal(reconnects, 1);
  assert.deepEqual(replacementAttaches, ["work-1"]);
  assert.equal(pane.engine.getState().model, "replacement-model");
  assert.equal(pane.engine.getState().remoteConnection, undefined);
  controller.dispose();
});
