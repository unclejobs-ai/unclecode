import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIProvider } from "@unclecode/providers";

const UNSUPPORTED_REASONING = {
  effort: "unsupported",
  source: "model-capability",
  support: { status: "unsupported", supportedEfforts: [] },
};

const readFileTool = {
  name: "read_file",
  description: "Read a file.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

function createTwoStepProvider(toolCalls, toolRuntime, cwd) {
  let callCount = 0;
  return new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd,
    reasoning: UNSUPPORTED_REASONING,
    toolRuntime,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        callCount += 1;
        if (callCount === 1) {
          return { choices: [{ message: { content: "", tool_calls: toolCalls } }] };
        }
        return { choices: [{ message: { content: "done" } }] };
      },
    }),
  });
}

test("native provider dispatch executes tool calls through the injected ToolExecutor", async () => {
  const requests = [];
  const provider = createTwoStepProvider(
    [{ id: "call_a", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }],
    {
      definitions: [readFileTool],
      executor: {
        async execute(request) {
          requests.push(request);
          return { content: "file-body" };
        },
      },
    },
    "/tmp/native-executor",
  );

  const result = await provider.runTurn("a.txt 읽어줘");

  assert.equal(result.text, "done");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, "read_file");
  assert.deepEqual(requests[0].input, { path: "a.txt" });
  assert.equal(requests[0].cwd, "/tmp/native-executor");
});

test("native provider dispatch forwards the turn abort signal to the ToolExecutor", async () => {
  const controller = new AbortController();
  const seen = [];
  const provider = createTwoStepProvider(
    [{ id: "call_b", function: { name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) } }],
    {
      definitions: [readFileTool],
      executor: {
        async execute(request) {
          seen.push(request.signal);
          return { content: "file-body" };
        },
      },
    },
    "/tmp/native-executor",
  );

  await provider.runTurn("b.txt 읽어줘", [], { signal: controller.signal });

  assert.deepEqual(seen, [controller.signal]);
});
