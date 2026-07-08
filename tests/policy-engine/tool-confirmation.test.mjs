import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_CONFIRMATION_POLICIES,
  resolveToolConfirmationDecision,
} from "@unclecode/policy-engine";
import { toolDefinitions } from "@unclecode/orchestrator";

function tool(name) {
  return toolDefinitions.find((definition) => definition.name === name);
}

test("tool confirmation policy exposes stable modes", () => {
  assert.deepEqual(TOOL_CONFIRMATION_POLICIES, ["always", "never", "risky"]);
});

test("risky confirmation policy allows low-risk read-only tools", () => {
  const decision = resolveToolConfirmationDecision({
    toolName: "read_file",
    metadata: tool("read_file").metadata,
  });

  assert.equal(decision.effect, "allow");
  assert.equal(decision.matchedRule, "tool-confirmation.risky.read_file.allow");
});

test("risky confirmation policy prompts for destructive and unknown tools", () => {
  const writeDecision = resolveToolConfirmationDecision({
    toolName: "write_file",
    metadata: tool("write_file").metadata,
  });
  const shellDecision = resolveToolConfirmationDecision({
    toolName: "run_shell",
    metadata: tool("run_shell").metadata,
  });
  const missingDecision = resolveToolConfirmationDecision({
    toolName: "external_tool",
  });

  assert.equal(writeDecision.effect, "prompt");
  assert.match(writeDecision.reason, /Overwrites workspace file content/);
  assert.equal(shellDecision.effect, "prompt");
  assert.match(shellDecision.reason, /Shell commands/);
  assert.equal(missingDecision.effect, "prompt");
  assert.match(missingDecision.reason, /metadata is missing/);
});

test("always and never policies override metadata risk", () => {
  const always = resolveToolConfirmationDecision({
    toolName: "read_file",
    metadata: tool("read_file").metadata,
    policy: "always",
  });
  const never = resolveToolConfirmationDecision({
    toolName: "run_shell",
    metadata: tool("run_shell").metadata,
    policy: "never",
  });

  assert.equal(always.effect, "prompt");
  assert.equal(never.effect, "allow");
});

