import assert from "node:assert/strict";
import test from "node:test";

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

test("AnthropicProvider.query returns plain text when model emits no tool_use", async () => {
  const { client, captured } = makeStubClient([
    { content: [{ type: "text", text: "all done" }] },
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
  assert.equal(result.costUsd, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].system, "you are a worker");
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
  assert.equal(params.system, "system override");
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

  assert.ok(typeof captured[0].system === "string");
  assert.ok(captured[0].system.length > 0);
  assert.match(captured[0].system, /extra-instructions/);
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
