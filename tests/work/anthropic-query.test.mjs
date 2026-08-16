import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { AnthropicProvider as BaseAnthropicProvider } from "@unclecode/providers";
import { AnthropicProvider } from "@unclecode/orchestrator";

function makeStubClient(responses) {
  let i = 0;
  const captured = [];
  const client = {
    messages: {
      async create(params) {
        captured.push(params);
        const response = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return response;
      },
    },
  };
  return { client, captured };
}

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function waitForWorkerMessages(worker, type, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (message) => {
      if (message?.type !== type) return;
      messages.push(message);
      if (messages.length === count) {
        cleanup();
        resolve(messages);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

test("AnthropicProvider.query returns plain text when model emits no tool_use", async () => {
  const { client, captured } = makeStubClient([
    { content: [{ type: "text", text: "all done" }], usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 7 } },
  ]);
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.query([
    { role: "system", content: "you are a worker" },
    { role: "user", content: "do nothing" },
  ]);

  assert.equal(result.content, "all done");
  assert.deepEqual(result.actions, []);
  assert.ok(Math.abs(result.costUsd - 0.000078) < 1e-12);
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 2, cacheReadTokens: 7 });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].system, [
    { type: "text", text: "you are a worker", cache_control: { type: "ephemeral" } },
  ]);
  assert.equal(captured[0].messages[0].role, "user");
});

test("AnthropicProvider.query normalizes tool_use blocks into actions", async () => {
  const { client, captured } = makeStubClient([
    {
      content: [
        { type: "text", text: "running shell" },
        {
          type: "tool_use",
          id: "tu_42",
          name: "run_shell",
          input: { command: "echo ok" },
        },
      ],
    },
  ]);
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.query(
    [{ role: "user", content: "run echo ok" }],
    {
      tools: [
        {
          name: "run_shell",
          description: "Execute a shell command.",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
  );

  assert.equal(result.content, "running shell");
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0], {
    callId: "tu_42",
    tool: "run_shell",
    input: { command: "echo ok" },
  });
  assert.ok(Array.isArray(captured[0].tools));
  assert.equal(captured[0].tools[0].name, "run_shell");
});

test("AnthropicProvider.query round-trips assistant tool_use + tool_result", async () => {
  const { client, captured } = makeStubClient([
    { content: [{ type: "text", text: "submit ready" }] },
  ]);
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  await provider.query([
    { role: "system", content: "system override" },
    { role: "user", content: "run shell and report" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { callId: "tu_1", name: "run_shell", argumentsJson: '{"command":"echo hi"}' },
      ],
    },
    { role: "tool", content: "hi", callId: "tu_1" },
  ]);

  const params = captured[0];
  assert.deepEqual(params.system, [
    { type: "text", text: "system override", cache_control: { type: "ephemeral" } },
  ]);
  assert.equal(params.messages.length, 3);
  // assistant block carries tool_use shape
  const assistantBlocks = params.messages[1].content;
  assert.equal(assistantBlocks[0].type, "tool_use");
  assert.equal(assistantBlocks[0].id, "tu_1");
  assert.equal(assistantBlocks[0].name, "run_shell");
  assert.deepEqual(assistantBlocks[0].input, { command: "echo hi" });
  // tool_result wrapped in user message
  const userBlocks = params.messages[2].content;
  assert.equal(userBlocks[0].type, "tool_result");
  assert.equal(userBlocks[0].tool_use_id, "tu_1");
  assert.equal(userBlocks[0].content, "hi");
});

test("AnthropicProvider.query falls back to default system prompt when caller omits one", async () => {
  const { client, captured } = makeStubClient([
    { content: [{ type: "text", text: "ok" }] },
  ]);
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
    systemPrompt: "extra-instructions",
  });

  await provider.query([{ role: "user", content: "hello" }]);

  assert.ok(Array.isArray(captured[0].system));
  assert.match(captured[0].system[0].text, /extra-instructions/);
  assert.deepEqual(captured[0].system[0].cache_control, { type: "ephemeral" });
});

test("AnthropicProvider.query omits an explicitly empty system block", async () => {
  const { client, captured } = makeStubClient([
    { content: [{ type: "text", text: "ok" }] },
  ]);
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  await provider.query([
    { role: "system", content: "" },
    { role: "user", content: "hello" },
  ]);

  assert.equal(captured[0].system, undefined);
});

test("AnthropicProvider.query reports token usage and caches stable prompt prefixes", async () => {
  const { client, captured } = makeStubClient([
    {
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 750_000,
      },
    },
  ]);
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.query([
    { role: "system", content: "stable instructions" },
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second" },
  ]);

  // Provider usage keeps uncached, cache-read, and cache-write input disjoint.
  assert.equal(result.costUsd, 20.25);
  assert.deepEqual(result.usage, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 750_000,
  });
  assert.deepEqual(captured[0].system[0].cache_control, { type: "ephemeral" });
  assert.equal(captured[0].messages[0].content[0].cache_control, undefined);
  assert.deepEqual(captured[0].messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(captured[0].messages[2].content[0].cache_control, { type: "ephemeral" });
});

test("AnthropicProvider.query tolerates malformed tool_call argumentsJson", async () => {
  const { client, captured } = makeStubClient([
    { content: [{ type: "text", text: "ok" }] },
  ]);
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  await provider.query([
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ callId: "tu_bad", name: "run_shell", argumentsJson: "not-json" }],
    },
    { role: "tool", content: "x", callId: "tu_bad" },
  ]);

  const assistantBlocks = captured[0].messages[1].content;
  assert.equal(assistantBlocks[0].type, "tool_use");
  assert.deepEqual(assistantBlocks[0].input, {});
});

test("AnthropicProvider.query uses Rust HTTP transport when no SDK client is injected", async () => {
  const originalBaseUrl = process.env.ANTHROPIC_API_BASE_URL;
  const originalNoProxy = process.env.NO_PROXY;
  const worker = new Worker(`
    const http = require("node:http");
    const { parentPort } = require("node:worker_threads");
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        parentPort.postMessage({
          type: "request",
          request: {
            method: req.method,
            url: req.url,
            apiKey: req.headers["x-api-key"],
            version: req.headers["anthropic-version"],
            body: JSON.parse(body),
          },
        });
        const responseBody = JSON.stringify({
          content: [{ type: "text", text: "rust transport" }],
          usage: { input_tokens: 2, output_tokens: 3 },
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(responseBody),
          connection: "close",
        });
        res.end(responseBody);
      });
    });
    parentPort.on("message", (message) => {
      if (message === "close") server.close(() => parentPort.postMessage({ type: "closed" }));
    });
    server.listen(0, "127.0.0.1", () => {
      parentPort.postMessage({ type: "listening", port: server.address().port });
    });
  `, { eval: true });

  try {
    const port = await waitForWorkerMessage(worker, "listening").then((message) => message.port);
    process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.NO_PROXY = [originalNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    const provider = new BaseAnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      cwd: process.cwd(),
    });

    const requestPromise = waitForWorkerMessage(worker, "request").then((message) => message.request);
    const result = await provider.query([{ role: "user", content: "hi" }]);
    const observedRequest = await requestPromise;

    assert.equal(result.content, "rust transport");
    assert.equal(observedRequest.method, "POST");
    assert.equal(observedRequest.url, "/v1/messages");
    assert.equal(observedRequest.apiKey, "sk-ant-test");
    assert.equal(observedRequest.version, "2023-06-01");
    assert.deepEqual(observedRequest.body.messages[0].content, [
      { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
    ]);
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_API_BASE_URL;
    } else {
      process.env.ANTHROPIC_API_BASE_URL = originalBaseUrl;
    }
    if (originalNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = originalNoProxy;
    }
    worker.postMessage("close");
    await waitForWorkerMessage(worker, "closed");
    await worker.terminate();
  }
});

test("AnthropicProvider.runTurn sends Rust-built user message with supported inline attachments", async () => {
  const { client, captured } = makeStubClient([
    { content: [{ type: "text", text: "seen" }] },
  ]);
  const provider = new BaseAnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.runTurn("inspect this", [
    {
      type: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      displayName: "clip.png",
    },
    {
      type: "image",
      mimeType: "image/svg+xml",
      dataUrl: "data:image/svg+xml;base64,BBBB",
      displayName: "skip.svg",
    },
  ]);

  assert.equal(result.text, "seen");
  assert.deepEqual(captured[0].messages[0], {
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "AAAA",
        },
        cache_control: { type: "ephemeral" },
      },
    ],
  });
});

test("AnthropicProvider.runTurn uses Rust HTTP transport for live tool loop when no SDK client is injected", async () => {
  const originalBaseUrl = process.env.ANTHROPIC_API_BASE_URL;
  const originalNoProxy = process.env.NO_PROXY;
  const worker = new Worker(`
    const http = require("node:http");
    const { parentPort } = require("node:worker_threads");
    let count = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        count += 1;
        const parsedBody = JSON.parse(body);
        parentPort.postMessage({
          type: "request",
          request: {
            count,
            method: req.method,
            url: req.url,
            apiKey: req.headers["x-api-key"],
            body: parsedBody,
          },
        });
        const responseBody = count === 1
          ? JSON.stringify({
              content: [{
                type: "tool_use",
                id: "tu_1",
                name: "run_shell",
                input: { command: "echo ok" },
              }],
              usage: { input_tokens: 2, output_tokens: 1 },
            })
          : JSON.stringify({
              content: [{ type: "text", text: "done via rust" }],
              usage: { input_tokens: 3, output_tokens: 4 },
            });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(responseBody),
          connection: "close",
        });
        res.end(responseBody);
      });
    });
    parentPort.on("message", (message) => {
      if (message === "close") server.close(() => parentPort.postMessage({ type: "closed" }));
    });
    server.listen(0, "127.0.0.1", () => {
      parentPort.postMessage({ type: "listening", port: server.address().port });
    });
  `, { eval: true });

  try {
    const port = await waitForWorkerMessage(worker, "listening").then((message) => message.port);
    process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.NO_PROXY = [originalNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    const provider = new BaseAnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      cwd: process.cwd(),
      toolRuntime: {
        definitions: [
          {
            name: "run_shell",
            description: "Execute a shell command.",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
        executor: {
          async execute({ input }) {
            assert.deepEqual(input, { command: "echo ok" });
            return { content: "ok", isError: false };
          },
        },
      },
    });

    const requestMessagesPromise = waitForWorkerMessages(worker, "request", 2);
    const resultPromise = provider.runTurn("use tool");
    const [firstRequest, secondRequest] = (await requestMessagesPromise).map((message) => message.request);
    const result = await resultPromise;

    assert.equal(result.text, "done via rust");
    assert.equal(firstRequest.method, "POST");
    assert.equal(firstRequest.url, "/v1/messages");
    assert.equal(firstRequest.apiKey, "sk-ant-test");
    assert.deepEqual(firstRequest.body.messages[0].content, [
      { type: "text", text: "use tool", cache_control: { type: "ephemeral" } },
    ]);
    assert.equal(secondRequest.body.messages[1].content[0].type, "tool_use");
    assert.equal(secondRequest.body.messages[2].content[0].tool_use_id, "tu_1");
    assert.equal(secondRequest.body.messages[2].content[0].content, "ok");
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_API_BASE_URL;
    } else {
      process.env.ANTHROPIC_API_BASE_URL = originalBaseUrl;
    }
    if (originalNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = originalNoProxy;
    }
    worker.postMessage("close");
    await waitForWorkerMessage(worker, "closed");
    await worker.terminate();
  }
});

test("AnthropicProvider.runTurn sends Rust-built tool_result blocks after tool calls", async () => {
  const { client, captured } = makeStubClient([
    {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "run_shell",
          input: { command: "echo ok" },
        },
      ],
    },
    { content: [{ type: "text", text: "done" }] },
  ]);
  let provider;
  provider = new BaseAnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
    toolRuntime: {
      definitions: [
        {
          name: "run_shell",
          description: "Execute a shell command.",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      executor: {
        async execute({ input }) {
          assert.deepEqual(input, { command: "echo ok" });
          provider.updateRuntimeSettings({ model: "claude-opus-4-6" });
          return { content: "ok", isError: false };
        },
      },
    },
  });

  const result = await provider.runTurn("use tool");

  assert.equal(result.text, "done");
  assert.deepEqual(captured.map((request) => request.model), [
    "claude-sonnet-4-6",
    "claude-sonnet-4-6",
  ]);
  assert.deepEqual(captured[1].messages[2], {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "ok",
        is_error: false,
        cache_control: { type: "ephemeral" },
      },
    ],
  });
});

test("AnthropicProvider.runTurn reports one step and the response cost for a single model response", async () => {
  const { client } = makeStubClient([
    {
      content: [{ type: "text", text: "single done" }],
      usage: { input_tokens: 1000, output_tokens: 200 },
    },
  ]);
  const provider = new BaseAnthropicProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.runTurn("do one thing");

  assert.equal(result.text, "single done");
  // Claude Sonnet 4.6: $3.00/M input + $15.00/M output → $0.006 for 1000 + 200 tokens.
  assert.deepEqual(
    { steps: result.steps, costUsd: result.costUsd },
    { steps: 1, costUsd: 0.006 },
  );
});
