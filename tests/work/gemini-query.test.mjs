import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { GeminiProvider as BaseGeminiProvider } from "@unclecode/providers";
import { GeminiProvider } from "@unclecode/orchestrator";

function makeStubClient(responses) {
  let i = 0;
  const captured = [];
  const client = {
    models: {
      async generateContent(params) {
        captured.push(params);
        const response = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return response;
      },
    },
  };
  return { client, captured };
}

test("GeminiProvider.query returns plain text when the model emits no functionCall", async () => {
  const { client, captured } = makeStubClient([
    {
      candidates: [{ content: { parts: [{ text: "all done" }] } }],
    },
  ]);
  const provider = new GeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.query([
    { role: "system", content: "you are a worker" },
    { role: "user", content: "do nothing" },
  ]);

  assert.equal(result.content, "all done");
  assert.deepEqual(result.actions, []);
  assert.equal(result.costUsd, 0);
  assert.equal(captured[0].config.systemInstruction, "you are a worker");
  assert.equal(captured[0].contents[0].role, "user");
});

test("GeminiProvider.query normalizes functionCall parts into actions", async () => {
  const { client, captured } = makeStubClient([
    {
      candidates: [
        {
          content: {
            parts: [
              { text: "running shell" },
              {
                functionCall: {
                  id: "fc_42",
                  name: "run_shell",
                  args: { command: "echo ok" },
                },
              },
            ],
          },
        },
      ],
    },
  ]);
  const provider = new GeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
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
    callId: "fc_42",
    tool: "run_shell",
    input: { command: "echo ok" },
  });
  // tools should land on the request body
  assert.ok(Array.isArray(captured[0].config.tools));
  assert.equal(
    captured[0].config.tools[0].functionDeclarations[0].name,
    "run_shell",
  );
});

test("GeminiProvider.query round-trips assistant functionCall + tool functionResponse", async () => {
  const { client, captured } = makeStubClient([
    {
      candidates: [{ content: { parts: [{ text: "submit ready" }] } }],
    },
  ]);
  const provider = new GeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
    cwd: process.cwd(),
    client,
  });

  await provider.query([
    { role: "user", content: "run shell and report" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { callId: "fc_1", name: "run_shell", argumentsJson: '{"command":"echo hi"}' },
      ],
    },
    { role: "tool", content: "hi", callId: "fc_1" },
  ]);

  const contents = captured[0].contents;
  assert.equal(contents.length, 3);
  // assistant message has functionCall part
  const modelParts = contents[1].parts;
  assert.equal(modelParts[0].functionCall.id, "fc_1");
  assert.equal(modelParts[0].functionCall.name, "run_shell");
  assert.deepEqual(modelParts[0].functionCall.args, { command: "echo hi" });
  // tool result wrapped as user functionResponse
  const userParts = contents[2].parts;
  assert.ok(userParts[0].functionResponse);
  assert.equal(userParts[0].functionResponse.id, "fc_1");
  assert.equal(userParts[0].functionResponse.response.output, "hi");
});

test("GeminiProvider.query falls back to provider default systemInstruction when caller omits one", async () => {
  const { client, captured } = makeStubClient([
    { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
  ]);
  const provider = new GeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
    cwd: process.cwd(),
    systemPrompt: "extra-instructions",
    client,
  });

  await provider.query([{ role: "user", content: "hello" }]);

  assert.match(captured[0].config.systemInstruction, /extra-instructions/);
});

test("GeminiProvider.query reports non-zero costUsd when usageMetadata is present", async () => {
  const { client } = makeStubClient([
    {
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: {
        promptTokenCount: 1_000_000,
        candidatesTokenCount: 1_000_000,
        cachedContentTokenCount: 600_000,
      },
    },
  ]);
  const provider = new GeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.query([{ role: "user", content: "hi" }]);
  // gemini-3.1-flash: $0.5/M input + $3.0/M output → $3.50 for 1M+1M
  assert.equal(result.costUsd, 3.5);
  assert.deepEqual(result.usage, {
    inputTokens: 400_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 600_000,
  });
});

test("GeminiProvider.query uses Rust HTTP transport when no SDK client is injected", async () => {
  const originalBaseUrl = process.env.GEMINI_API_BASE_URL;
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
            apiKey: req.headers["x-goog-api-key"],
            body: JSON.parse(body),
          },
        });
        const responseBody = JSON.stringify({
          candidates: [{ content: { parts: [{ text: "rust transport" }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
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
    process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${port}/v1beta`;
    process.env.NO_PROXY = [originalNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    const provider = new BaseGeminiProvider({
      apiKey: "g-test",
      model: "gemini-3.1-flash",
      cwd: process.cwd(),
    });

    const observedRequestPromise = waitForWorkerMessage(worker, "request").then((message) => message.request);
    const result = await provider.query([{ role: "user", content: "hi" }]);
    const observedRequest = await observedRequestPromise;

    assert.equal(result.content, "rust transport");
    assert.equal(observedRequest.method, "POST");
    assert.equal(observedRequest.url, "/v1beta/models/gemini-3.1-flash:generateContent");
    assert.equal(observedRequest.apiKey, "g-test");
    assert.equal(observedRequest.body.model, undefined);
    assert.equal(observedRequest.body.config, undefined);
    assert.equal(typeof observedRequest.body.systemInstruction.parts[0].text, "string");
    assert.equal(observedRequest.body.contents[0].parts[0].text, "hi");
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.GEMINI_API_BASE_URL;
    } else {
      process.env.GEMINI_API_BASE_URL = originalBaseUrl;
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

test("GeminiProvider.runTurn sends Rust-built user content with inline attachments", async () => {
  const { client, captured } = makeStubClient([
    { candidates: [{ content: { parts: [{ text: "seen" }] } }] },
  ]);
  const provider = new BaseGeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
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
  ]);

  assert.equal(result.text, "seen");
  assert.equal(captured[0].contents[0].role, "user");
  assert.deepEqual(captured[0].contents[0].parts, [
    { text: "inspect this" },
    { inlineData: { mimeType: "image/png", data: "AAAA" } },
  ]);
});

test("GeminiProvider.runTurn uses Rust HTTP transport for live tool loop when no SDK client is injected", async () => {
  const originalBaseUrl = process.env.GEMINI_API_BASE_URL;
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
            apiKey: req.headers["x-goog-api-key"],
            body: parsedBody,
          },
        });
        const responseBody = count === 1
          ? JSON.stringify({
              candidates: [{
                content: {
                  parts: [{
                    functionCall: {
                      id: "fc_1",
                      name: "run_shell",
                      args: { command: "echo ok" },
                    },
                  }],
                },
              }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
            })
          : JSON.stringify({
              candidates: [{ content: { parts: [{ text: "done via rust" }] } }],
              usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
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
    process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${port}/v1beta`;
    process.env.NO_PROXY = [originalNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    const provider = new BaseGeminiProvider({
      apiKey: "g-test",
      model: "gemini-3.1-flash",
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
    assert.equal(firstRequest.url, "/v1beta/models/gemini-3.1-flash:generateContent");
    assert.equal(firstRequest.apiKey, "g-test");
    assert.equal(firstRequest.body.model, undefined);
    assert.equal(firstRequest.body.config, undefined);
    assert.equal(firstRequest.body.toolConfig.functionCallingConfig.mode, "AUTO");
    assert.equal(firstRequest.body.tools[0].functionDeclarations[0].parametersJsonSchema, undefined);
    assert.equal(
      firstRequest.body.tools[0].functionDeclarations[0].parameters.properties.command.type,
      "string",
    );
    assert.equal(firstRequest.body.contents[0].parts[0].text, "use tool");
    assert.equal(secondRequest.body.contents[1].parts[0].functionCall.name, "run_shell");
    assert.equal(secondRequest.body.contents[2].parts[0].functionResponse.response.content, "ok");
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.GEMINI_API_BASE_URL;
    } else {
      process.env.GEMINI_API_BASE_URL = originalBaseUrl;
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

test("GeminiProvider.runTurn sends Rust-built functionResponse parts after tool calls", async () => {
  const { client, captured } = makeStubClient([
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: "fc_1",
                  name: "run_shell",
                  args: { command: "echo ok" },
                },
              },
            ],
          },
        },
      ],
    },
    { candidates: [{ content: { parts: [{ text: "done" }] } }] },
  ]);
  const provider = new BaseGeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
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
          return { content: "ok", isError: false };
        },
      },
    },
  });

  const result = await provider.runTurn("use tool");

  assert.equal(result.text, "done");
  assert.ok(captured[0].config.tools[0].functionDeclarations.some(
    (declaration) => declaration.name === "run_shell",
  ));
  assert.deepEqual(captured[1].contents[2], {
    role: "user",
    parts: [
      {
        functionResponse: {
          name: "run_shell",
          id: "fc_1",
          response: { content: "ok", isError: false },
        },
      },
    ],
  });
});

test("GeminiProvider.runTurn reports one step and the response cost for a single model response", async () => {
  const { client } = makeStubClient([
    {
      candidates: [{ content: { role: "model", parts: [{ text: "single done" }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
    },
  ]);
  const provider = new BaseGeminiProvider({
    apiKey: "g-test",
    model: "gemini-3.1-flash",
    cwd: process.cwd(),
    client,
  });

  const result = await provider.runTurn("do one thing");

  assert.equal(result.text, "single done");
  // Gemini 3.1 Flash: $0.50/M input + $3.00/M output → $0.0011 for 1000 + 200 tokens.
  assert.deepEqual(
    { steps: result.steps, costUsd: result.costUsd },
    { steps: 1, costUsd: 0.0011 },
  );
});
