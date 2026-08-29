import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LiveRuntimeControlRegistry,
  attachWorkShellRuntime,
  readPersistentRuntime,
} from "@unclecode/server";

function fakeEngine() {
  let lifecycle = { state: "running", turnId: "turn-1" };
  let state = {
    isBusy: true,
    queuePaused: false,
    model: "gpt-5.6-sol",
    mode: "normal",
    uiLocale: "en",
    agentConsole: {
      pendingDecision: {
        kind: "security-approval",
        id: "approval-1",
        questions: [{ id: "policy-confirmation", question: "Allow?", options: [{ label: "Approve" }, { label: "Reject" }] }],
      },
      activity: [], agents: [{ id: "agent-2", status: "running" }], jobs: [], profileId: "balanced",
    },
  };
  const listeners = new Set();
  const calls = [];
  const publish = patch => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  return {
    calls,
    publishState: publish,
    publishLifecycle(next) { lifecycle = next; publish({}); },
    getState: () => state,
    getTurnLifecycle: () => lifecycle,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    interruptTurn() { calls.push(["interrupt"]); publish({ isBusy: false, queuePaused: true }); },
    async requestTurnPause() {
      calls.push(["pause"]);
      lifecycle = { state: "paused", turnId: "turn-1", boundary: "after_provider" };
      publish({});
      return { turnId: "turn-1", boundary: "after_provider" };
    },
    resumeTurn() {
      if (lifecycle.state !== "paused") return false;
      lifecycle = { state: "running", turnId: "turn-1" };
      publish({});
      return true;
    },
    async resumeQueueItems() { calls.push(["resume"]); publish({ isBusy: true, queuePaused: false }); },
    async handleSubmit(message) { calls.push(["submit", message]); publish({ isBusy: true, queuePaused: false }); },
    answerPendingDecisionByIndex(index) {
      calls.push(["approve", index]);
      publish({ agentConsole: { ...state.agentConsole, pendingDecision: undefined } });
      return true;
    },
    answerPendingUserDecision(decisionId, answers) {
      calls.push(["decision", decisionId, answers]);
      publish({ agentConsole: { ...state.agentConsole, pendingDecision: undefined } });
      return true;
    },
    getAgentControlPort() {
      return {
        async steer(agentRunId, message) { calls.push(["steer", agentRunId, message]); return { status: "delivered" }; },
      };
    },
  };
}

test("WorkShell live adapter routes typed controls through public engine APIs", async () => {
  const controls = new LiveRuntimeControlRegistry();
  const engine = fakeEngine();
  const events = [];
  const detach = attachWorkShellRuntime(controls, {
    sessionId: "live-1",
    projectPath: "/tmp/live-project",
    engine,
    initialRevision: 4,
    onChanged: event => events.push(event),
  });

  const pause = await controls.control({ sessionId: "live-1", action: "pause", expectedRevision: 4, idempotencyKey: "p" });
  assert.deepEqual(pause, { ok: true, revision: 5, state: "paused" });
  const followUp = await controls.control({ sessionId: "live-1", action: "follow-up", expectedRevision: 5, idempotencyKey: "f", payload: { message: "continue in Korean" } });
  assert.equal(followUp.ok, true);
  const steer = await controls.control({ sessionId: "live-1", action: "steer", expectedRevision: 6, idempotencyKey: "s", payload: { agentRunId: "agent-2", message: "check tests" } });
  assert.equal(steer.ok, true);
  const approve = await controls.control({ sessionId: "live-1", action: "approve", expectedRevision: 7, idempotencyKey: "a", payload: { decision: "approve_once" } });
  assert.equal(approve.ok, true);
  assert.deepEqual(engine.calls, [["pause"], ["submit", "continue in Korean"], ["steer", "agent-2", "check tests"], ["approve", 1]]);
  assert.deepEqual(events.map(event => event.revision), [5, 6, 7, 8]);
  engine.resumeTurn();
  engine.publishLifecycle({ state: "completed", turnId: "turn-1" });
  engine.publishState({ isBusy: false });
  assert.equal(events.at(-1).revision, 11);
  assert.equal(events.at(-1).state, "idle");
  detach();
  assert.equal((await controls.control({ sessionId: "live-1", action: "cancel", expectedRevision: 8, idempotencyKey: "c" })).code, "not_attached");
});

test("WorkShell live adapter fails closed for ambiguous approvals and steer targets", async () => {
  const controls = new LiveRuntimeControlRegistry();
  const engine = fakeEngine();
  engine.getState().agentConsole.pendingDecision.kind = "user-decision";
  attachWorkShellRuntime(controls, { sessionId: "live-2", projectPath: "/tmp/p", engine, initialRevision: 1 });

  const approve = await controls.control({ sessionId: "live-2", action: "approve", expectedRevision: 1, idempotencyKey: "a" });
  const steer = await controls.control({ sessionId: "live-2", action: "steer", expectedRevision: 1, idempotencyKey: "s", payload: { message: "guess target" } });
  const staleSteer = await controls.control({
    sessionId: "live-2",
    action: "steer",
    expectedRevision: 1,
    idempotencyKey: "stale-agent",
    payload: { agentRunId: "agent-that-ended", message: "must not move" },
  });
  assert.equal(approve.code, "denied");
  assert.equal(steer.code, "invalid_action");
  assert.equal(staleSteer.code, "denied");
  assert.equal(controls.snapshot("live-2").revision, 1, "rejected controls cannot consume owner revisions");
  assert.deepEqual(engine.calls, []);
});

test("WorkShell live adapter settles one exact typed user decision", async () => {
  const controls = new LiveRuntimeControlRegistry();
  const engine = fakeEngine();
  engine.getState().agentConsole.pendingDecision = {
    kind: "user-decision",
    id: "release-choice",
    questions: [{
      id: "lane",
      question: "Which lane?",
      options: [{ label: "Canary" }, { label: "Stable" }],
    }, {
      id: "checks",
      question: "Which checks?",
      options: [{ label: "Unit" }, { label: "Integration" }],
      multi: true,
    }],
  };
  attachWorkShellRuntime(controls, { sessionId: "live-decision", projectPath: "/tmp/p", engine, initialRevision: 3 });
  const request = {
    sessionId: "live-decision",
    action: "decision",
    expectedRevision: 3,
    idempotencyKey: "decision-key",
    payload: {
      decisionId: "release-choice",
      answers: [
        { id: "lane", selectedOptions: ["Canary"] },
        { id: "checks", selectedOptions: ["Unit", "Integration"] },
      ],
    },
  };

  const first = await controls.control(request);
  const replay = await controls.control(request);
  assert.equal(first.ok, true);
  assert.deepEqual(replay, first);
  assert.equal(first.revision, 4);
  assert.deepEqual(engine.calls, [["decision", "release-choice", request.payload.answers]]);
});

test("WorkShell decision control rejects stale identity, wrong kind, invalid options, and invalid multiplicity", async () => {
  const attempts = [
    {
      name: "stale identity",
      mutate(engine) { engine.getState().agentConsole.pendingDecision.id = "new-decision"; },
      payload: { decisionId: "old-decision", answers: [{ id: "lane", selectedOptions: ["Canary"] }] },
    },
    {
      name: "wrong kind",
      mutate(engine) { engine.getState().agentConsole.pendingDecision.kind = "security-approval"; },
      payload: { decisionId: "release-choice", answers: [{ id: "lane", selectedOptions: ["Canary"] }] },
    },
    {
      name: "invalid option",
      payload: { decisionId: "release-choice", answers: [{ id: "lane", selectedOptions: ["Unknown"] }] },
    },
    {
      name: "invalid single-select multiplicity",
      payload: { decisionId: "release-choice", answers: [{ id: "lane", selectedOptions: ["Canary", "Stable"] }] },
    },
  ];

  for (const [index, attempt] of attempts.entries()) {
    const controls = new LiveRuntimeControlRegistry();
    const engine = fakeEngine();
    engine.getState().agentConsole.pendingDecision = {
      kind: "user-decision",
      id: "release-choice",
      questions: [{ id: "lane", question: "Which lane?", options: [{ label: "Canary" }, { label: "Stable" }] }],
    };
    attempt.mutate?.(engine);
    attachWorkShellRuntime(controls, { sessionId: `invalid-${index}`, projectPath: "/tmp/p", engine, initialRevision: 7 });
    const result = await controls.control({
      sessionId: `invalid-${index}`,
      action: "decision",
      expectedRevision: 7,
      idempotencyKey: attempt.name,
      payload: attempt.payload,
    });
    assert.equal(result.code, "denied", attempt.name);
    assert.equal(controls.snapshot(`invalid-${index}`).revision, 7, `${attempt.name} must not consume a revision`);
    assert.deepEqual(engine.calls, [], attempt.name);
  }

  const staleControls = new LiveRuntimeControlRegistry();
  const staleEngine = fakeEngine();
  staleEngine.getState().agentConsole.pendingDecision = {
    kind: "user-decision",
    id: "release-choice",
    questions: [{ id: "lane", question: "Which lane?", options: [{ label: "Canary" }] }],
  };
  attachWorkShellRuntime(staleControls, { sessionId: "stale-revision", projectPath: "/tmp/p", engine: staleEngine, initialRevision: 9 });
  const stale = await staleControls.control({
    sessionId: "stale-revision",
    action: "decision",
    expectedRevision: 8,
    idempotencyKey: "stale-revision",
    payload: { decisionId: "release-choice", answers: [{ id: "lane", selectedOptions: ["Canary"] }] },
  });
  assert.equal(stale.code, "revision_conflict");
  assert.deepEqual(staleEngine.calls, []);
});

test("persistent read model includes an attached live WorkShell before its first checkpoint", async () => {
  const controls = new LiveRuntimeControlRegistry();
  const engine = fakeEngine();
  attachWorkShellRuntime(controls, { sessionId: "live-only", projectPath: "/tmp/live-project", engine, initialRevision: 9 });
  const source = await readPersistentRuntime("/path/that/does/not/exist", controls);
  assert.equal(source.sessions.length, 1);
  assert.equal(source.sessions[0].sessionId, "live-only");
  assert.equal(source.sessions[0].state, "requires_action");
  assert.equal(source.sessions[0].revision, 9);
  assert.equal(source.sessions[0].metadata.model, "gpt-5.6-sol");
});
