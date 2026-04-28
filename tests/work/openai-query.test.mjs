import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIProvider } from "@unclecode/orchestrator";

const UNSUPPORTED_REASONING = {
  effort: "unsupported",
  source: "model-capability",
  support: { status: "unsupported", supportedEfforts: [] },
};

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
    /OpenAI request failed with status 500: boom/,
  );
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
