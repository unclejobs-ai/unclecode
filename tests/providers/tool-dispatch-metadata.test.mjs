import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIProvider } from "@unclecode/providers";

const UNSUPPORTED_REASONING = {
  effort: "unsupported",
  source: "model-capability",
  support: { status: "unsupported", supportedEfforts: [] },
};

function fileTool(name) {
  return {
    name,
    description: `Read ${name}.`,
    metadata: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        riskLevel: "low",
      },
      resources: [
        {
          kind: "file",
          mode: "read",
          template: "file:{path}",
          declared: true,
        },
      ],
    },
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  };
}

const opaqueShellTool = {
  name: "run_shell",
  description: "Run shell.",
  metadata: {
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      riskLevel: "unknown",
    },
    resources: [
      {
        kind: "shell",
        mode: "execute",
        template: "shell:*",
        declared: false,
      },
    ],
  },
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

const applyPatchTool = {
  name: "apply_patch",
  description: "Apply patch.",
  metadata: {
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      riskLevel: "high",
    },
    resources: [
      {
        kind: "file",
        mode: "write",
        template: "file:<patch files>",
        declared: true,
        resolver: "apply-patch-files",
      },
    ],
  },
  input_schema: {
    type: "object",
    properties: { patch: { type: "string" } },
    required: ["patch"],
  },
};

function patchFor(filePath) {
  return [
    "*** Begin Patch",
    `*** Update File: ${filePath}`,
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
}

function createTwoStepProvider(toolCalls, toolRuntime) {
  let callCount = 0;
  return new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: UNSUPPORTED_REASONING,
    toolRuntime,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        callCount += 1;
        if (callCount === 1) {
          return {
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: toolCalls,
                },
              },
            ],
          };
        }
        return { choices: [{ message: { content: "done" } }] };
      },
    }),
  });
}

test("provider dispatch runs independent declared resources concurrently", async () => {
  const started = [];
  let releaseBoth;
  const bothStarted = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const runTool = async (name) => {
    started.push(name);
    if (started.length === 2) {
      releaseBoth();
    }
    await bothStarted;
    return { content: `${name}-ok` };
  };

  const provider = createTwoStepProvider(
    [
      {
        id: "call_a",
        function: { name: "read_a", arguments: JSON.stringify({ path: "a.txt" }) },
      },
      {
        id: "call_b",
        function: { name: "read_b", arguments: JSON.stringify({ path: "b.txt" }) },
      },
    ],
    {
      definitions: [fileTool("read_a"), fileTool("read_b")],
      executor: {
        async execute({ toolName }) {
          return await runTool(toolName === "read_a" ? "a" : "b");
        },
      },
    },
  );

  const result = await Promise.race([
    provider.runTurn("read both"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("tool dispatch did not run concurrently")), 2000)),
  ]);

  assert.equal(result.text, "done");
  assert.deepEqual(started.sort(), ["a", "b"]);
});

test("provider dispatch serializes opaque resources before later tools", async () => {
  const events = [];
  const provider = createTwoStepProvider(
    [
      {
        id: "call_shell",
        function: { name: "run_shell", arguments: JSON.stringify({ command: "echo hi" }) },
      },
      {
        id: "call_read",
        function: { name: "read_file", arguments: JSON.stringify({ path: "safe.txt" }) },
      },
    ],
    {
      definitions: [opaqueShellTool, fileTool("read_file")],
      executor: {
        async execute({ toolName }) {
          if (toolName === "run_shell") {
            events.push("shell:start");
            await new Promise((resolve) => setTimeout(resolve, 50));
            events.push("shell:end");
            return { content: "shell-ok" };
          }
          events.push("read:start");
          return { content: "read-ok" };
        },
      },
    },
  );

  const result = await provider.runTurn("shell then read");

  assert.equal(result.text, "done");
  assert.deepEqual(events, ["shell:start", "shell:end", "read:start"]);
});

test("provider dispatch runs apply_patch calls for different files concurrently", async () => {
  const started = [];
  let releaseBoth;
  const bothStarted = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const provider = createTwoStepProvider(
    [
      {
        id: "call_patch_a",
        function: { name: "apply_patch", arguments: JSON.stringify({ patch: patchFor("src/a.ts") }) },
      },
      {
        id: "call_patch_b",
        function: { name: "apply_patch", arguments: JSON.stringify({ patch: patchFor("src/b.ts") }) },
      },
    ],
    {
      definitions: [applyPatchTool],
      executor: {
        async execute({ input }) {
          started.push(input.patch.includes("src/a.ts") ? "a" : "b");
          if (started.length === 2) {
            releaseBoth();
          }
          await bothStarted;
          return { content: "patch-ok" };
        },
      },
    },
  );

  const result = await Promise.race([
    provider.runTurn("patch both"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("patch dispatch did not run concurrently")), 2000)),
  ]);

  assert.equal(result.text, "done");
  assert.deepEqual(started.sort(), ["a", "b"]);
});

test("provider dispatch serializes apply_patch with reads for the same file", async () => {
  const events = [];
  const provider = createTwoStepProvider(
    [
      {
        id: "call_patch",
        function: { name: "apply_patch", arguments: JSON.stringify({ patch: patchFor("src/a.ts") }) },
      },
      {
        id: "call_read",
        function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) },
      },
    ],
    {
      definitions: [applyPatchTool, fileTool("read_file")],
      executor: {
        async execute({ toolName }) {
          if (toolName === "apply_patch") {
            events.push("patch:start");
            await new Promise((resolve) => setTimeout(resolve, 50));
            events.push("patch:end");
            return { content: "patch-ok" };
          }
          events.push("read:start");
          return { content: "read-ok" };
        },
      },
    },
  );

  const result = await provider.runTurn("patch then read");

  assert.equal(result.text, "done");
  assert.deepEqual(events, ["patch:start", "patch:end", "read:start"]);
});
