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

const REASONING_HIGH = {
  effort: "high",
  source: "override",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 },
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
    events: [
      { type: "start", partial: makeAssistantMessage([]) },
      { type: "text_delta", contentIndex: 0, delta: text, partial: makeAssistantMessage([]) },
    ],
    message: makeAssistantMessage([{ type: "text", text }]),
  };
}

function createProvider(overrides = {}) {
  return createPiBridgeProvider({
    provider: "openai",
    apiKey: "test-key",
    model: TEST_MODEL.id,
    cwd: "/tmp",
    reasoning: REASONING_OFF,
    piModel: TEST_MODEL,
    ...overrides,
  });
}

test("runTurn streams text deltas to the trace listener and returns final text", async () => {
  const { calls, streamFn } = fakeStreamFn([textOnlyStep("안녕하세요")]);
  const provider = createProvider({ streamFn });
  const trace = [];
  provider.setTraceListener((event) => trace.push(event));

  const result = await provider.runTurn("인사해줘");

  assert.equal(result.text, "안녕하세요");
  assert.equal(result.steps, 1);
  assert.equal(result.costUsd, 0.0042);
  assert.deepEqual(
    trace.map((event) => [event.type, event.delta]),
    [["assistant.delta", "안녕하세요"]],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.apiKey, "test-key");
  assert.equal(calls[0].options.reasoning, undefined);
  assert.deepEqual(calls[0].context.messages, [
    { role: "user", content: "인사해줘", timestamp: calls[0].context.messages[0].timestamp },
  ]);
});

test("Codex OAuth replaces the local web_search function with the hosted search tool", async () => {
  const { calls, streamFn } = fakeStreamFn([textOnlyStep("Agent automation | herdr")]);
  const provider = createProvider({
    piModel: {
      ...TEST_MODEL,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    streamFn,
    toolRuntime: {
      definitions: [
        {
          name: "web_search",
          description: "search the web",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "read_file",
          description: "read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      executor: {
        async execute({ toolName }) {
          return { isError: true, content: `no handler registered for tool "${toolName}".` };
        },
      },
    },
  });

  const result = await provider.runTurn("문서를 검색해");

  assert.equal(result.text, "Agent automation | herdr");
  assert.deepEqual(calls[0].context.tools.map((tool) => tool.name), ["read_file"]);
  assert.equal(typeof calls[0].options.onPayload, "function");
  assert.deepEqual(
    await calls[0].options.onPayload({
      tools: [{ type: "function", name: "read_file" }],
      input: [],
    }),
    {
      tools: [
        { type: "function", name: "read_file" },
        { type: "web_search" },
      ],
      input: [],
    },
  );
});

test("runTurn executes tool calls through the tool runtime and loops until a final answer", async () => {
  const toolCall = { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.ts" } };
  const { calls, streamFn } = fakeStreamFn([
    {
      events: [],
      message: makeAssistantMessage([toolCall], { stopReason: "toolUse" }),
    },
    textOnlyStep("파일 내용입니다"),
  ]);
  const handled = [];
  const provider = createProvider({
    streamFn,
    toolRuntime: {
      definitions: [
        {
          name: "read_file",
          description: "read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
      executor: {
        async execute({ input, cwd }) {
          handled.push({ input, cwd });
          return { content: "file-body" };
        },
      },
    },
  });
  const trace = [];
  provider.setTraceListener((event) => trace.push(event));

  const result = await provider.runTurn("a.ts 읽어줘");

  assert.equal(result.text, "파일 내용입니다");
  assert.deepEqual(handled, [{ input: { path: "a.ts" }, cwd: "/tmp" }]);
  assert.deepEqual(
    trace.map((event) => event.type),
    ["tool.started", "tool.completed", "assistant.delta"],
  );
  const secondMessages = calls[1].context.messages;
  const toolResult = secondMessages.at(-1);
  assert.equal(toolResult.role, "toolResult");
  assert.equal(toolResult.toolCallId, "call-1");
  assert.equal(toolResult.toolName, "read_file");
  assert.equal(toolResult.content[0].text, "file-body");
  assert.equal(toolResult.isError, false);
  const piTools = calls[0].context.tools;
  assert.equal(piTools.length, 1);
  assert.equal(piTools[0].name, "read_file");
  assert.deepEqual(piTools[0].parameters.required, ["path"]);
});

test("runTurn surfaces a tool error result instead of throwing", async () => {
  const toolCall = { type: "toolCall", id: "call-9", name: "missing_tool", arguments: {} };
  const { calls, streamFn } = fakeStreamFn([
    { events: [], message: makeAssistantMessage([toolCall], { stopReason: "toolUse" }) },
    textOnlyStep("도구가 없습니다"),
  ]);
  const provider = createProvider({
    streamFn,
    toolRuntime: {
      definitions: [],
      executor: {
        async execute({ toolName }) {
          return { isError: true, content: `no handler registered for tool "${toolName}".` };
        },
      },
    },
  });

  const result = await provider.runTurn("실행해줘");

  assert.equal(result.text, "도구가 없습니다");
  assert.equal(result.steps, 2);
  assert.equal(result.costUsd, 0.0084);
  const toolResult = calls[1].context.messages.at(-1);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /no handler registered/);
});

test("query maps message roles, tool names, reasoning, and cost without touching history", async () => {
  const { calls, streamFn } = fakeStreamFn([
    {
      events: [],
      message: makeAssistantMessage(
        [
          { type: "text", text: "요약" },
          { type: "toolCall", id: "c2", name: "search", arguments: { q: "x" } },
        ],
        { stopReason: "toolUse" },
      ),
    },
    textOnlyStep("히스토리 없음"),
  ]);
  const provider = createProvider({ streamFn, reasoning: REASONING_HIGH });

  const result = await provider.query(
    [
      { role: "system", content: "규칙 A" },
      { role: "system", content: "규칙 B" },
      { role: "user", content: "질문" },
      {
        role: "assistant",
        content: "이전 답",
        toolCalls: [{ callId: "c1", name: "lookup", argumentsJson: "{\"k\":1}" }],
      },
      { role: "tool", callId: "c1", content: "결과" },
    ],
    {
      tools: [
        {
          name: "search",
          description: "search",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    },
  );

  assert.equal(result.content, "요약");
  assert.deepEqual(result.actions, [{ callId: "c2", tool: "search", input: { q: "x" } }]);
  assert.equal(result.costUsd, 0.0042);
  const context = calls[0].context;
  assert.equal(context.systemPrompt, "규칙 A\n\n규칙 B");
  const toolResult = context.messages.find((message) => message.role === "toolResult");
  assert.equal(toolResult.toolName, "lookup");
  const assistant = context.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.stopReason, "toolUse");
  assert.deepEqual(assistant.content[1].arguments, { k: 1 });
  assert.equal(calls[0].options.reasoning, "high");

  await provider.runTurn("히스토리 확인");
  const runTurnMessages = calls[1].context.messages;
  assert.equal(runTurnMessages.length, 1);
  assert.equal(runTurnMessages[0].role, "user");
  assert.equal(runTurnMessages[0].content, "히스토리 확인");
});

test("query preserves malformed tool calls with empty arguments", async () => {
  const { calls, streamFn } = fakeStreamFn([textOnlyStep("ok")]);
  const provider = createProvider({ streamFn });

  await provider.query([{
    role: "assistant",
    content: "",
    toolCalls: [{ callId: "broken", name: "lookup", argumentsJson: "{" }],
  }]);

  const assistant = calls[0].context.messages[0];
  assert.equal(assistant.content[0].id, "broken");
  assert.equal(assistant.content[0].name, "lookup");
  assert.deepEqual(assistant.content[0].arguments, {});
});

test("runTurn keeps conversation history across turns and clear() resets it", async () => {
  const { calls, streamFn } = fakeStreamFn([
    textOnlyStep("첫 답"),
    textOnlyStep("둘째 답"),
    textOnlyStep("셋째 답"),
  ]);
  const provider = createProvider({ streamFn });

  await provider.runTurn("첫 질문");
  await provider.runTurn("둘 질문");
  const rolesBeforeClear = calls[1].context.messages.map((message) => message.role);
  assert.deepEqual(rolesBeforeClear, ["user", "assistant", "user"]);

  provider.clear();
  await provider.runTurn("셋 질문");
  const rolesAfterClear = calls[2].context.messages.map((message) => message.role);
  assert.deepEqual(rolesAfterClear, ["user"]);
});

test("runTurn reports tool handler failures to the model and continues", async () => {
  const toolCall = { type: "toolCall", id: "call-fail", name: "explode", arguments: {} };
  const { calls, streamFn } = fakeStreamFn([
    { events: [], message: makeAssistantMessage([toolCall], { stopReason: "toolUse" }) },
    textOnlyStep("recovered"),
  ]);
  const provider = createProvider({
    streamFn,
    toolRuntime: {
      definitions: [],
      executor: {
        async execute() {
          throw new Error("tool exploded");
        },
      },
    },
  });

  const result = await provider.runTurn("recover this turn");

  assert.equal(result.text, "recovered");
  assert.deepEqual(
    calls[1].context.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  const toolResult = calls[1].context.messages[2];
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /tool exploded/);
});

test("runTurn enforces configured step and cost budgets", async () => {
  const toolCall = { type: "toolCall", id: "call-loop", name: "lookup", arguments: {} };
  const looping = fakeStreamFn([
    { events: [], message: makeAssistantMessage([toolCall], { stopReason: "toolUse" }) },
    textOnlyStep("should not run"),
  ]);
  const stepLimited = createProvider({
    streamFn: looping.streamFn,
    toolLoopMax: 1,
    toolRuntime: {
      definitions: [],
      executor: { async execute() { return { content: "ok" }; } },
    },
  });
  await assert.rejects(() => stepLimited.runTurn("loop"), /step limit of 1/i);
  assert.equal(looping.calls.length, 1);

  const costly = fakeStreamFn([textOnlyStep("expensive")]);
  const costLimited = createProvider({
    streamFn: costly.streamFn,
    costLimitUsd: 0.001,
  });
  await assert.rejects(() => costLimited.runTurn("spend"), /cost limit of \$0\.001/i);
});

test("runTurn forwards image attachments as pi image content", async () => {
  const { calls, streamFn } = fakeStreamFn([textOnlyStep("이미지 봤습니다")]);
  const provider = createProvider({ streamFn });

  await provider.runTurn("이게 뭐야", [
    { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,QUJD" },
  ]);

  const content = calls[0].context.messages[0].content;
  assert.equal(content[0].text, "이게 뭐야");
  assert.deepEqual(content[1], { type: "image", data: "QUJD", mimeType: "image/png" });
});

test("piProvider resolves models from an arbitrary pi provider catalog", async () => {
  const catalogModel = { ...TEST_MODEL, id: "z-ai/glm-5.2", provider: "openrouter" };
  const lookups = [];
  const fakeModels = {
    getModel: (providerId, modelId) => {
      lookups.push([providerId, modelId]);
      return providerId === "openrouter" ? catalogModel : undefined;
    },
  };
  const { calls, streamFn } = fakeStreamFn([textOnlyStep("ok")]);
  const provider = createProvider({
    piProvider: "openrouter",
    model: "z-ai/glm-5.2",
    models: fakeModels,
    piModel: undefined,
    streamFn,
  });

  const result = await provider.runTurn("질문");

  assert.equal(result.text, "ok");
  assert.deepEqual(lookups, [["openrouter", "z-ai/glm-5.2"]]);
  assert.equal(calls[0].model.provider, "openrouter");
});

test("provider base URL override replaces a catalog model endpoint", async () => {
  const catalogModel = {
    ...TEST_MODEL,
    id: "catalog-model",
    baseUrl: "https://api.example.invalid/v1",
  };
  const fakeModels = {
    getModel: (_providerId, modelId) => modelId === catalogModel.id ? catalogModel : undefined,
  };
  const { calls, streamFn } = fakeStreamFn([textOnlyStep("ok")]);
  const provider = createProvider({
    model: catalogModel.id,
    models: fakeModels,
    piModel: undefined,
    baseUrl: "http://127.0.0.1:43123/v1",
    streamFn,
  });

  await provider.runTurn("질문");

  assert.equal(calls[0].model.baseUrl, "http://127.0.0.1:43123/v1");
  assert.equal(catalogModel.baseUrl, "https://api.example.invalid/v1");
});

test("custom piProvider without a catalog hit throws instead of synthesizing", () => {
  const fakeModels = { getModel: () => undefined };
  assert.throws(
    () =>
      createProvider({
        piProvider: "openrouter",
        model: "missing-model",
        models: fakeModels,
        piModel: undefined,
      }),
    /not available in the pi-ai catalog for provider "openrouter"/,
  );
});

test("built-in pi provider ids may synthesize models but provider aliases may not", () => {
  const fakeModels = { getModel: () => undefined };
  const common = {
    provider: "gemini",
    apiKey: "test-key",
    model: "missing-model",
    cwd: "/tmp",
    reasoning: REASONING_OFF,
    models: fakeModels,
  };

  assert.doesNotThrow(() => createPiBridgeProvider({ ...common, piProvider: "google" }));
  assert.throws(
    () => createPiBridgeProvider({ ...common, piProvider: "gemini" }),
    /not available in the pi-ai catalog for provider "gemini"/,
  );
});

test("updateAuthToken and updateRuntimeSettings affect subsequent requests", async () => {
  const { calls, streamFn } = fakeStreamFn([textOnlyStep("ok"), textOnlyStep("ok2")]);
  const provider = createProvider({ streamFn });

  provider.updateAuthToken("rotated-key");
  provider.updateRuntimeSettings({ reasoning: REASONING_HIGH });
  await provider.runTurn("질문");

  assert.equal(calls[0].options.apiKey, "rotated-key");
  assert.equal(calls[0].options.reasoning, "high");
});
