import assert from "node:assert/strict";
import test from "node:test";

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
      usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
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
});
