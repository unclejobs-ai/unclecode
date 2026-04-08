import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICodexProvider } from "@unclecode/providers";

test("OpenAICodexProvider sends requests to the chatgpt codex backend and returns assistant text", async () => {
  let capturedUrl = "";
  let capturedBody;

  const provider = new OpenAICodexProvider({
    apiKey: "codex-token-123",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: {
      effort: "high",
      source: "override",
      support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
    },
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async text() {
          return [
            'event: response.output_item.done',
            'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","id":"msg-1","content":[{"type":"output_text","text":"hello from codex"}]}}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            '',
          ].join("\n");
        },
      };
    },
  });

  const result = await provider.runTurn("say hello");

  assert.equal(capturedUrl, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(capturedBody.model, "gpt-5.4");
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.stream, true);
  assert.equal(result.text, "hello from codex");
});

test("OpenAICodexProvider emits openai-codex tool traces for codex backend tool calls", async () => {
  const seen = [];

  const provider = new OpenAICodexProvider({
    apiKey: "codex-token-123",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: {
      effort: "medium",
      source: "mode-default",
      support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
    },
    toolRuntime: {
      definitions: [
        {
          name: "echo",
          description: "Echo text",
          input_schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
      handlers: {
        async echo(input) {
          return { content: String(input.text ?? "") };
        },
      },
    },
    fetchImpl: async (_url, _init) => ({
      ok: true,
      async text() {
        return [
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"echo","arguments":"{\\"text\\":\\"hello\\"}"}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp-1"}}',
          '',
        ].join("\n");
      },
    }),
  });

  provider.setTraceListener((event) => {
    seen.push(event);
  });

  const result = await provider.runTurn("use a tool");

  assert.equal(result.text, "Stopped after reaching the tool iteration limit.");
  assert.equal(seen[0]?.type, "tool.started");
  assert.equal(seen[0]?.provider, "openai-codex");
  assert.equal(seen[1]?.type, "tool.completed");
  assert.equal(seen[1]?.provider, "openai-codex");
});
