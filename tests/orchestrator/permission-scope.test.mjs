import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalPermissionRule,
  createCanonicalPermissionRuleStore,
  createPermissionPolicyPanel,
  matchesCanonicalPermissionRule,
  resolveCanonicalPermissionScope,
} from "@unclecode/orchestrator";

test("approval title, persisted key, and next decision share one tool-wide bash scope", () => {
  const scope = resolveCanonicalPermissionScope({
    toolName: "run_shell",
    input: { command: "export PATH=/opt/bin:$PATH && cd src && ln -s a b | tee out" },
  });
  const rule = createCanonicalPermissionRule(scope);
  assert.deepEqual(scope, {
    kind: "tool",
    key: "bash",
    label: "bash",
    detail: "All shell commands executed by bash in this workspace session.",
  });
  assert.equal(rule.key, "bash");
  assert.equal(matchesCanonicalPermissionRule(rule, {
    toolName: "run_shell",
    input: { command: "FOO=1 printf ok > output && cat output" },
  }), true);
});

test("policy view reads the same deduplicated canonical session rule store", () => {
  const store = createCanonicalPermissionRuleStore();
  const scope = resolveCanonicalPermissionScope({ toolName: "run_shell", input: { command: "echo ok" } });
  store.add(createCanonicalPermissionRule(scope));
  store.add(createCanonicalPermissionRule(scope));
  assert.deepEqual(store.list(), [{ kind: "tool", key: "bash" }]);
  assert.deepEqual(createPermissionPolicyPanel(store.list()), {
    title: "Security policy",
    lines: [
      "Session approvals · 1",
      "- bash · tool-wide · all shell commands through bash",
      "Security approval only · quality gates and user decisions are separate.",
    ],
  });
});

test("canonical rules do not widen a non-shell tool", () => {
  const scope = resolveCanonicalPermissionScope({ toolName: "write_file", input: { path: "a.txt" } });
  const rule = createCanonicalPermissionRule(scope);
  assert.equal(scope.key, "write_file");
  assert.equal(matchesCanonicalPermissionRule(rule, { toolName: "read_file", input: { path: "a.txt" } }), false);
});

test("canonical rule store restores only safe deduplicated Always rules", () => {
  const store = createCanonicalPermissionRuleStore([
    { kind: "tool", key: "bash" },
    { kind: "tool", key: "bash" },
    { kind: "tool", key: "write_file" },
    { kind: "tool", key: "../escape" },
    { kind: "quality-gate", key: "proceed" },
  ]);
  assert.deepEqual(store.list(), [
    { kind: "tool", key: "bash" },
    { kind: "tool", key: "write_file" },
  ]);
});
