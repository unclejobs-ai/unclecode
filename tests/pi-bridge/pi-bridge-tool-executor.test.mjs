import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createPiBridgeProvider } from "@unclecode/pi-bridge";

const TEST_MODEL = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const REASONING_OFF = {
  effort: "none",
  source: "mode-default",
  support: { status: "supported", defaultEffort: "none", supportedEfforts: ["none"] },
};

function makeAssistantMessage(content, overrides = {}) {
  return {
    role: "assistant",
    content,
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function fakeStreamFn(script) {
  const calls = [];
  const streamFn = (model, context, options) => {
    calls.push({ model, context, options });
    const step = script[calls.length - 1];
    assert.ok(step, `unexpected stream call #${calls.length}`);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      for (const event of step.events) {
        stream.push(event);
      }
      stream.push({ type: "done", reason: "stop", message: step.message });
    });
    return stream;
  };
  return { calls, streamFn };
}

function textOnlyStep(text) {
  return {
    events: [{ type: "start", partial: makeAssistantMessage([]) }],
    message: makeAssistantMessage([{ type: "text", text }]),
  };
}

const readFileTool = {
  name: "read_file",
  description: "read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function createProvider(overrides = {}) {
  return createPiBridgeProvider({
    provider: "openai",
    apiKey: "test-key",
    model: TEST_MODEL.id,
    cwd: "/tmp/pi-executor",
    reasoning: REASONING_OFF,
    piModel: TEST_MODEL,
    ...overrides,
  });
}

test("pi bridge dispatch executes tool calls through the injected ToolExecutor", async () => {
  const toolCall = { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.ts" } };
  const { calls, streamFn } = fakeStreamFn([
    { events: [], message: makeAssistantMessage([toolCall], { stopReason: "toolUse" }) },
    textOnlyStep("파일 내용입니다"),
  ]);
  const requests = [];
  const provider = createProvider({
    streamFn,
    toolRuntime: {
      definitions: [readFileTool],
      executor: {
        async execute(request) {
          requests.push(request);
          return { content: "file-body" };
        },
      },
    },
  });

  const result = await provider.runTurn("a.ts 읽어줘");

  assert.equal(result.text, "파일 내용입니다");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, "read_file");
  assert.deepEqual(requests[0].input, { path: "a.ts" });
  assert.equal(requests[0].cwd, "/tmp/pi-executor");
  const toolResult = calls[1].context.messages.at(-1);
  assert.equal(toolResult.role, "toolResult");
  assert.equal(toolResult.content[0].text, "file-body");
  assert.equal(toolResult.isError, false);
});

test("pi bridge reports an executor refusal as a tool error without throwing", async () => {
  const toolCall = { type: "toolCall", id: "call-2", name: "run_shell", arguments: { command: "ls" } };
  const { calls, streamFn } = fakeStreamFn([
    { events: [], message: makeAssistantMessage([toolCall], { stopReason: "toolUse" }) },
    textOnlyStep("거부되었습니다"),
  ]);
  const provider = createProvider({
    streamFn,
    toolRuntime: {
      definitions: [],
      executor: {
        async execute() {
          return { isError: true, content: "policy denied shell.run" };
        },
      },
    },
  });

  const result = await provider.runTurn("실행해줘");

  assert.equal(result.text, "거부되었습니다");
  const toolResult = calls[1].context.messages.at(-1);
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.content[0].text, "policy denied shell.run");
});

test("pi bridge rethrows executor aborts instead of continuing the model loop", async () => {
  const toolCall = { type: "toolCall", id: "call-abort", name: "read_file", arguments: { path: "a.ts" } };
  const { calls, streamFn } = fakeStreamFn([
    { events: [], message: makeAssistantMessage([toolCall], { stopReason: "toolUse" }) },
  ]);
  const controller = new AbortController();
  const provider = createProvider({
    streamFn,
    toolRuntime: {
      definitions: [readFileTool],
      executor: {
        async execute() {
          controller.abort();
          const error = new Error("Operation aborted");
          error.name = "AbortError";
          throw error;
        },
      },
    },
  });

  await assert.rejects(
    provider.runTurn("a.ts 읽어줘", [], { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(calls.length, 1);
});
