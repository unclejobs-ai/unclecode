import assert from "node:assert/strict";
import test from "node:test";

import { createPolicyAwareToolExecutor } from "@unclecode/orchestrator";

function toolDefinition(name, mode, kind) {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: "object", properties: {}, required: [] },
    metadata: {
      annotations: {
        readOnlyHint: mode === "read",
        destructiveHint: mode === "write",
        idempotentHint: false,
        openWorldHint: false,
        riskLevel: mode === "read" ? "low" : "high",
      },
      resources: [{ kind, mode, template: `${kind}:*`, declared: true }],
    },
  };
}

const DEFINITIONS = [
  toolDefinition("read_file", "read", "file"),
  toolDefinition("write_file", "write", "file"),
  toolDefinition("run_shell", "execute", "shell"),
];

const PROFILE = {
  id: "test.runtime-safety",
  mode: "enforce",
  defaultEffect: "allow",
  rules: [
    {
      id: "test.shell.deny",
      capability: "shell.run",
      effect: "deny",
      reason: "shell is not granted in this mode",
    },
    {
      id: "test.filesystem.write.prompt",
      capability: "filesystem.write",
      effect: "prompt",
      reason: "workspace writes need confirmation",
    },
  ],
};

function createRecordingHandlers(invoked) {
  const handler = (name) => async () => {
    invoked.push(name);
    return { content: `${name}-ran` };
  };
  return {
    read_file: handler("read_file"),
    write_file: handler("write_file"),
    run_shell: handler("run_shell"),
  };
}

test("policy deny never reaches the raw tool handler", async () => {
  const invoked = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers(invoked),
    policyProfile: PROFILE,
    runtimeMode: "local",
  });

  const result = await executor.execute({
    toolName: "run_shell",
    input: { command: "rm -rf /" },
    cwd: "/tmp/policy-executor",
  });

  assert.deepEqual(invoked, []);
  assert.equal(result.isError, true);
  assert.match(result.content, /shell is not granted in this mode/);
});

test("policy prompt without an available confirmation path never reaches the raw tool handler", async () => {
  const invoked = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers(invoked),
    policyProfile: PROFILE,
    runtimeMode: "local",
  });

  const result = await executor.execute({
    toolName: "write_file",
    input: { path: "a.txt", content: "x" },
    cwd: "/tmp/policy-executor",
  });

  assert.deepEqual(invoked, []);
  assert.equal(result.isError, true);
  assert.match(result.content, /workspace writes need confirmation/);
});

test("policy allow invokes the raw tool handler with the request input, cwd, and signal", async () => {
  const invoked = [];
  const seen = [];
  const controller = new AbortController();
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: {
      ...createRecordingHandlers(invoked),
      read_file: async (input, cwd, options) => {
        invoked.push("read_file");
        seen.push({ input, cwd, signal: options?.signal });
        return { content: "file-body" };
      },
    },
    policyProfile: PROFILE,
    runtimeMode: "local",
  });

  const result = await executor.execute({
    toolName: "read_file",
    input: { path: "a.txt" },
    cwd: "/tmp/policy-executor",
    signal: controller.signal,
  });

  assert.deepEqual(invoked, ["read_file"]);
  assert.equal(result.isError ?? false, false);
  assert.equal(result.content, "file-body");
  assert.deepEqual(seen, [
    { input: { path: "a.txt" }, cwd: "/tmp/policy-executor", signal: controller.signal },
  ]);
});

test("risky tool metadata requires confirmation even when execution policy defaults to allow", async () => {
  const invoked = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers(invoked),
    policyProfile: {
      id: "test.default-allow",
      mode: "enforce",
      defaultEffect: "allow",
      rules: [],
    },
    runtimeMode: "default",
  });

  const result = await executor.execute({
    toolName: "write_file",
    input: { path: "a.txt", content: "x" },
    cwd: "/tmp/policy-executor",
  });

  assert.deepEqual(invoked, []);
  assert.equal(result.isError, true);
  assert.match(result.content, /confirmation.*not granted/i);
});

test("every declared tool resource must be authorized before dispatch", async () => {
  const invoked = [];
  const definition = {
    ...toolDefinition("read_then_write", "read", "file"),
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        riskLevel: "low",
      },
      resources: [
        { kind: "file", mode: "read", template: "file:*", declared: true },
        { kind: "file", mode: "write", template: "file:*", declared: true },
      ],
    },
  };
  const executor = createPolicyAwareToolExecutor({
    definitions: [definition],
    handlers: {
      read_then_write: async () => {
        invoked.push("read_then_write");
        return { content: "ran" };
      },
    },
    policyProfile: PROFILE,
    runtimeMode: "default",
  });

  const result = await executor.execute({
    toolName: "read_then_write",
    input: { path: "a.txt" },
    cwd: "/tmp/policy-executor",
  });

  assert.deepEqual(invoked, []);
  assert.equal(result.isError, true);
  assert.match(result.content, /workspace writes need confirmation/);
});

test("one approval prompts once and invokes a risky handler once", async () => {
  const invoked = [];
  const questions = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers(invoked),
    policyProfile: {
      id: "test.default-allow",
      mode: "enforce",
      defaultEffect: "allow",
      rules: [],
    },
    runtimeMode: "default",
    interactionBridge: {
      async ask(request) {
        questions.push(request);
        return {
          status: "answered",
          answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
        };
      },
    },
  });

  const result = await executor.execute({
    toolName: "write_file",
    input: { path: "a.txt", content: "x" },
    cwd: "/tmp/policy-executor",
  });

  assert.equal(result.isError ?? false, false);
  assert.deepEqual(invoked, ["write_file"]);
  assert.equal(questions.length, 1);
});
