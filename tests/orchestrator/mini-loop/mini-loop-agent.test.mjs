import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MiniLoopAgent,
  collapseOlderObservations,
  getPersonaConfig,
} from "@unclecode/orchestrator";

const SUBMIT = "__UNCLECODE_SUBMIT__";

function makeMockExecutor(responses) {
  let callIndex = 0;
  return {
    async execute() {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex += 1;
      return response;
    },
  };
}

function makeMockModel(responses) {
  let callIndex = 0;
  return {
    async query() {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex += 1;
      return response;
    },
  };
}

test("MiniLoopAgent submits when stdout first line matches submit marker", async () => {
  const config = getPersonaConfig("mini");
  const executor = makeMockExecutor([
    { stdout: `${SUBMIT}\nfinal patch contents`, stderr: "", exitCode: 0, truncated: false },
  ]);
  const model = makeMockModel([
    { content: "echo submit", actions: [{ tool: "run_shell", input: { command: "echo submit" } }], costUsd: 0.01 },
  ]);
  const agent = new MiniLoopAgent({ config, executor, model, cwd: "/tmp" });
  const result = await agent.run("test task");
  assert.equal(result.status, "submitted");
  assert.equal(result.submission, "final patch contents");
  assert.equal(result.steps, 1);
});

test("MiniLoopAgent exits limits_exceeded when step budget runs out", async () => {
  const config = { ...getPersonaConfig("mini"), stepLimit: 2 };
  const executor = makeMockExecutor([
    { stdout: "ok", stderr: "", exitCode: 0, truncated: false },
  ]);
  const model = makeMockModel([
    { content: "step", actions: [{ tool: "run_shell", input: { command: "true" } }], costUsd: 0.01 },
  ]);
  const agent = new MiniLoopAgent({ config, executor, model, cwd: "/tmp" });
  const result = await agent.run("infinite");
  assert.equal(result.status, "limits_exceeded");
  assert.equal(result.steps, 2);
});

test("MiniLoopAgent rejects tools outside allowedTools allowlist", async () => {
  const config = { ...getPersonaConfig("auditor") };
  const executor = makeMockExecutor([
    { stdout: "should not run", stderr: "", exitCode: 0, truncated: false },
  ]);
  const model = makeMockModel([
    { content: "try shell", actions: [{ tool: "run_shell", input: { command: "rm -rf /" } }], costUsd: 0.01 },
    { content: "all done", actions: [], costUsd: 0.01 },
  ]);
  const agent = new MiniLoopAgent({ config, executor, model, cwd: "/tmp" });
  const result = await agent.run("audit");
  assert.equal(result.status, "submitted");
  const toolMessage = result.messages.find((m) => m.role === "tool");
  assert.match(toolMessage?.content ?? "", /not allowed/);
});

test("MiniLoopAgent honors onSubmit halt hook", async () => {
  const config = getPersonaConfig("mini");
  const executor = makeMockExecutor([
    { stdout: `${SUBMIT}\nproposed patch`, stderr: "", exitCode: 0, truncated: false },
  ]);
  const model = makeMockModel([
    { content: "submit", actions: [{ tool: "run_shell", input: { command: "echo submit" } }], costUsd: 0.01 },
  ]);
  const agent = new MiniLoopAgent({
    config,
    executor,
    model,
    cwd: "/tmp",
    hooks: {
      async onSubmit() {
        return { kind: "halt", reason: "gate failed" };
      },
    },
  });
  const result = await agent.run("test");
  assert.equal(result.status, "halted");
});

test("collapseOlderObservations preserves the last 5 tool messages verbatim", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
  ];
  for (let i = 0; i < 8; i += 1) {
    messages.push({
      role: "tool",
      content: `output-${i}`.repeat(50),
      stepIndex: i + 1,
      action: { tool: "run_shell", input: {} },
      observation: { stdout: `output-${i}`.repeat(50), stderr: "", exitCode: 0, truncated: false },
    });
  }
  const collapsed = collapseOlderObservations(messages, 5);
  const toolMessages = collapsed.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 8);
  const firstThreeCollapsed = toolMessages.slice(0, 3);
  for (const message of firstThreeCollapsed) {
    assert.equal(message.collapsed, true);
    assert.match(message.content, /Output collapsed/);
  }
  const lastFiveFull = toolMessages.slice(3);
  for (const message of lastFiveFull) {
    assert.notEqual(message.collapsed, true);
    assert.match(message.content, /^output-\d/);
  }
});

test("getPersonaConfig returns budget-calibrated configs for each persona", () => {
  const coder = getPersonaConfig("coder");
  const auditor = getPersonaConfig("auditor");
  const agentlessFix = getPersonaConfig("agentless-fix");
  assert.equal(coder.persona, "coder");
  assert.equal(coder.stepLimit, 12);
  assert.equal(auditor.allowedTools.includes("run_shell"), false);
  assert.equal(agentlessFix.stepLimit, 4);
  assert.ok(coder.systemPrompt.includes("__UNCLECODE_SUBMIT__"));
});
