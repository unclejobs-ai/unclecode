import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRuntime,
  createWorkShellInteractionBridge,
} from "@unclecode/orchestrator";

const request = {
  kind: "user-decision",
  id: "decision-1",
  title: "Execution choice",
  questions: [{
    id: "strategy",
    question: "Which strategy?",
    options: [
      { label: "Safe", description: "Use the existing pattern." },
      { label: "Fast", description: "Use the smallest direct change." },
    ],
    recommended: 0,
  }],
};

test("ask_user reports unavailable before a Work Shell interaction host binds", async () => {
  const bridge = createWorkShellInteractionBridge();
  const runtime = createToolRuntime({ interactionBridge: bridge });
  assert.ok(runtime.definitions.some((tool) => tool.name === "ask_user"));
  const result = await runtime.executor.execute({
    toolName: "ask_user",
    input: request,
    cwd: "/repo",
  });

  assert.deepEqual(JSON.parse(result.content), {
    status: "unavailable",
    reason: "Work Shell interaction is unavailable.",
  });
  const definition = runtime.definitions.find((tool) => tool.name === "ask_user");
  assert.deepEqual(definition?.metadata?.resources, [{
    kind: "context",
    mode: "write",
    template: "context:decision",
    declared: true,
  }]);
});

test("ask_user declares its nested question and option schema", () => {
  const runtime = createToolRuntime({
    interactionBridge: createWorkShellInteractionBridge(),
  });
  const definition = runtime.definitions.find((tool) => tool.name === "ask_user");

  assert.deepEqual(definition?.input_schema, {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, description: "Stable interaction id for this request." },
      title: { type: "string", description: "Optional short decision title." },
      questions: {
        type: "array",
        minItems: 1,
        description: "One or more questions with explicit options.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, description: "Stable question id." },
            question: { type: "string", minLength: 1, description: "Question shown to the user." },
            options: {
              type: "array",
              minItems: 1,
              description: "Explicit choices for this question.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", minLength: 1, description: "Option label." },
                  description: { type: "string", description: "Optional option detail." },
                },
                required: ["label"],
              },
            },
            multi: { type: "boolean", description: "Whether multiple options may be selected." },
            recommended: {
              type: "integer",
              minimum: 0,
              description: "Optional zero-based recommended option index.",
            },
          },
          required: ["id", "question", "options"],
        },
      },
    },
    required: ["id", "questions"],
  });
});

test("ask_user returns a real structured response from the bound interaction host", async () => {
  const bridge = createWorkShellInteractionBridge();
  const runtime = createToolRuntime({ interactionBridge: bridge });
  bridge.bind({
    ask: async (received) => {
      assert.deepEqual(received, request);
      return {
        status: "answered",
        answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
      };
    },
  });

  const result = await runtime.executor.execute({ toolName: "ask_user", input: request, cwd: "/repo" });
  assert.deepEqual(JSON.parse(result.content), {
    status: "answered",
    answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
  });
});

test("ask_user reports unavailable when the bound interaction host throws synchronously", async () => {
  const bridge = createWorkShellInteractionBridge();
  const runtime = createToolRuntime({ interactionBridge: bridge });
  bridge.bind({
    ask: () => {
      throw new Error("host disconnected");
    },
  });

  const result = await runtime.executor.execute({ toolName: "ask_user", input: request, cwd: "/repo" });
  assert.deepEqual(JSON.parse(result.content), {
    status: "unavailable",
    reason: "Work Shell interaction is unavailable.",
  });
});

test("ask_user validates malformed decisions before they reach the UI host", async () => {
  const bridge = createWorkShellInteractionBridge();
  const runtime = createToolRuntime({ interactionBridge: bridge });
  let hostCalled = false;
  bridge.bind({
    ask: async () => {
      hostCalled = true;
      return { status: "cancelled" };
    },
  });

  await assert.rejects(
    () => runtime.executor.execute({
      toolName: "ask_user",
      input: {
        ...request,
        questions: [{
          ...request.questions[0],
          options: [{ label: "Other" }],
          recommended: 1,
        }],
      },
      cwd: "/repo",
    }),
    /must not use reserved label "Other"|recommended index/i,
  );
  assert.equal(hostCalled, false);
});

test("unbinding resolves an in-flight interaction exactly once as unavailable", async () => {
  const bridge = createWorkShellInteractionBridge();
  let resolveHost;
  bridge.bind({
    ask: () => new Promise((resolve) => {
      resolveHost = resolve;
    }),
  });

  const pending = bridge.ask(request);
  bridge.unbind("Work Shell closed.");
  resolveHost?.({ status: "answered", answers: [] });

  assert.deepEqual(await pending, {
    status: "unavailable",
    reason: "Work Shell closed.",
  });
});

test("unbinding aborts the host interaction before resolving the bridge result", async () => {
  const bridge = createWorkShellInteractionBridge();
  let signalFromHost;
  let resolveHostStarted;
  const hostStarted = new Promise((resolve) => {
    resolveHostStarted = resolve;
  });
  bridge.bind({
    ask: (_request, signal) => new Promise((resolve) => {
      signalFromHost = signal;
      resolveHostStarted?.();
      signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
    }),
  });

  const pending = bridge.ask(request);
  await hostStarted;
  assert.equal(signalFromHost?.aborted, false);

  bridge.unbind("Work Shell closed.");

  assert.equal(signalFromHost?.aborted, true);
  assert.deepEqual(await pending, {
    status: "unavailable",
    reason: "Work Shell closed.",
  });
});

test("rebinding resolves an in-flight interaction from the replaced host as unavailable", async () => {
  const bridge = createWorkShellInteractionBridge();
  let signalFromPreviousHost;
  let resolvePreviousHostStarted;
  const previousHostStarted = new Promise((resolve) => {
    resolvePreviousHostStarted = resolve;
  });
  bridge.bind({
    ask: (_request, signal) => new Promise((resolve) => {
      signalFromPreviousHost = signal;
      resolvePreviousHostStarted?.();
      signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
    }),
  });

  const pending = bridge.ask(request);
  await previousHostStarted;
  bridge.bind({
    ask: async () => ({ status: "cancelled" }),
  });
  assert.equal(signalFromPreviousHost?.aborted, true);

  assert.deepEqual(await pending, {
    status: "unavailable",
    reason: "Work Shell interaction is unavailable.",
  });
});
