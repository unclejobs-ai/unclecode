import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { OpenAIProvider } from "@unclecode/orchestrator";

const UNSUPPORTED_REASONING = {
  effort: "unsupported",
  source: "model-capability",
  support: { status: "unsupported", supportedEfforts: [] },
};

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for worker message: ${type}`));
    }, 5000);
    const onMessage = (message) => {
      if (message?.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

test("OpenAIProvider.query returns plain content when model emits no tool calls", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: "all done" } }],
        };
      },
    }),
  });

  const result = await provider.query([
    { role: "system", content: "You are a worker." },
    { role: "user", content: "do nothing" },
  ]);

  assert.equal(result.content, "all done");
  assert.deepEqual(result.actions, []);
  assert.equal(result.costUsd, 0);
});

test("OpenAIProvider.query normalizes tool_calls into actions", async () => {
  let captured;
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: "running shell",
                  tool_calls: [
                    {
                      id: "call_42",
                      function: {
                        name: "run_shell",
                        arguments: JSON.stringify({ command: "echo ok" }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        },
      };
    },
  });

  const result = await provider.query(
    [
      { role: "system", content: "You are a worker." },
      { role: "user", content: "run echo ok" },
    ],
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
    callId: "call_42",
    tool: "run_shell",
    input: { command: "echo ok" },
  });

  assert.ok(Array.isArray(captured.tools));
  assert.equal(captured.tools[0].function.name, "run_shell");
  assert.equal(captured.tool_choice, "auto");
  assert.equal(captured.messages[0].role, "system");
  assert.equal(captured.messages[1].role, "user");
});

test("OpenAIProvider.query round-trips assistant tool_calls and tool observations", async () => {
  let captured;
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: "submit ready" } }],
          };
        },
      };
    },
  });

  const result = await provider.query([
    { role: "system", content: "You are a worker." },
    { role: "user", content: "run shell and report" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { callId: "call_1", name: "run_shell", argumentsJson: '{"command":"echo hi"}' },
      ],
    },
    { role: "tool", content: "hi", callId: "call_1" },
  ]);

  assert.equal(result.content, "submit ready");
  const wireMessages = captured.messages;
  assert.equal(wireMessages.length, 4);
  assert.equal(wireMessages[2].role, "assistant");
  assert.equal(wireMessages[2].tool_calls?.[0]?.id, "call_1");
  assert.equal(wireMessages[2].tool_calls?.[0]?.function?.name, "run_shell");
  assert.equal(wireMessages[3].role, "tool");
  assert.equal(wireMessages[3].tool_call_id, "call_1");
});

test("OpenAIProvider.query injects default system prompt when caller omits one", async () => {
  let captured;
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: "ok" } }],
          };
        },
      };
    },
  });

  await provider.query([{ role: "user", content: "hello" }]);

  assert.equal(captured.messages[0].role, "system");
  assert.ok(typeof captured.messages[0].content === "string");
  assert.ok(captured.messages[0].content.length > 0);
});

test("OpenAIProvider.query throws on non-2xx response", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return "boom";
      },
    }),
  });

  await assert.rejects(
    () => provider.query([{ role: "user", content: "hi" }]),
    /OpenAI request failed with status 500[\s\S]*Route · openai · https:\/\/api\.openai\.com\/v1\/responses[\s\S]*Retry · attempt count unavailable; transient status[\s\S]*Response · boom/,
  );
});

test("OpenAIProvider.query reports non-zero costUsd when the response carries token usage", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-5.6-luna",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        };
      },
    }),
  });

  const result = await provider.query([{ role: "user", content: "hi" }]);
  // GPT-5.6 Luna: $1.00/M input + $6.00/M output → $7.00 for 1M+1M
  assert.equal(result.costUsd, 7.0);
});

test("OpenAIProvider.query falls back to zero cost when the model is unknown", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "no-such-model",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        };
      },
    }),
  });

  const result = await provider.query([{ role: "user", content: "hi" }]);
  assert.equal(result.costUsd, 0);
});

test("OpenAIProvider.query tolerates malformed tool_call arguments", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "broken args",
                tool_calls: [
                  {
                    id: "call_bad",
                    function: { name: "run_shell", arguments: "not-json" },
                  },
                ],
              },
            },
          ],
        };
      },
    }),
  });

  const result = await provider.query([{ role: "user", content: "go" }]);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].input, {});
  assert.equal(result.actions[0].tool, "run_shell");
});

test("OpenAIProvider.query uses Rust one-shot chat query when fetch is not injected", async () => {
  const originalBaseUrl = process.env.OPENAI_API_BASE_URL;
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
            authorization: req.headers.authorization,
            body: JSON.parse(body),
          },
        });
        const responseBody = JSON.stringify({
          choices: [{
            message: {
              content: "rust query",
              tool_calls: [{
                id: "call_rust",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "echo rust" }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 1000000, completion_tokens: 1000000 },
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
    process.env.OPENAI_API_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.NO_PROXY = [originalNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    const provider = new OpenAIProvider({
      apiKey: "sk-test-rust",
      model: "gpt-5.6-luna",
      cwd: process.cwd(),
      reasoning: UNSUPPORTED_REASONING,
    });

    const requestPromise = waitForWorkerMessage(worker, "request").then((message) => message.request);
    const result = await provider.query(
      [{ role: "user", content: "run echo" }],
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
    const observedRequest = await requestPromise;

    assert.equal(result.content, "rust query");
    assert.deepEqual(result.actions, [
      { callId: "call_rust", tool: "run_shell", input: { command: "echo rust" } },
    ]);
    assert.equal(result.costUsd, 7.0);
    assert.equal(observedRequest.method, "POST");
    assert.equal(observedRequest.url, "/v1/chat/completions");
    assert.equal(observedRequest.authorization, "Bearer sk-test-rust");
    assert.equal(observedRequest.body.messages[0].role, "system");
    assert.equal(observedRequest.body.messages[1].role, "user");
    assert.equal(observedRequest.body.tools[0].function.name, "run_shell");
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_API_BASE_URL;
    } else {
      process.env.OPENAI_API_BASE_URL = originalBaseUrl;
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
