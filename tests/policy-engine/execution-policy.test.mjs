import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_AUDIT_EXECUTION_POLICY_PROFILE,
  evaluateExecutionPolicy,
} from "@unclecode/policy-engine";

test("execution policy keeps local audit mode permissive by default", () => {
  const decision = evaluateExecutionPolicy(LOCAL_AUDIT_EXECUTION_POLICY_PROFILE, {
    capability: "shell.run",
    command: "npm test",
    runtimeMode: "local",
  });

  assert.equal(decision.effect, "allow");
  assert.equal(decision.auditOnly, false);
  assert.equal(decision.matchedRule, "local.audit.shell.run.default");
});

test("execution policy can audit denied rules without blocking local execution", () => {
  const decision = evaluateExecutionPolicy(
    {
      id: "local.audit",
      mode: "audit",
      defaultEffect: "allow",
      rules: [
        {
          id: "workspace.shell.rm.audit",
          capability: "shell.run",
          effect: "deny",
          reason: "Destructive shell commands should be reviewed.",
          match: { commandPrefix: "rm " },
        },
      ],
    },
    {
      capability: "shell.run",
      command: "rm -rf dist",
      runtimeMode: "local",
    },
  );

  assert.equal(decision.effect, "allow");
  assert.equal(decision.auditOnly, true);
  assert.equal(decision.matchedRule, "workspace.shell.rm.audit");
  assert.match(decision.reason, /Audit only/);
});

test("execution policy enforces filesystem path prefix rules", () => {
  const profile = {
    id: "workspace.enforce",
    mode: "enforce",
    defaultEffect: "deny",
    rules: [
      {
        id: "workspace.filesystem.write.src",
        capability: "filesystem.write",
        effect: "allow",
        reason: "Source writes are allowed.",
        match: { pathPrefix: "src" },
      },
    ],
  };

  const allowed = evaluateExecutionPolicy(profile, {
    capability: "filesystem.write",
    path: "src/index.ts",
    runtimeMode: "local",
  });
  assert.equal(allowed.effect, "allow");
  assert.equal(allowed.matchedRule, "workspace.filesystem.write.src");

  const normalizedInside = evaluateExecutionPolicy(profile, {
    capability: "filesystem.write",
    path: "src/lib/../index.ts",
    runtimeMode: "local",
  });
  assert.equal(normalizedInside.effect, "allow");

  for (const traversalPath of [
    "src/../secret.txt",
    "./src/../secret.txt",
    "src\\..\\secret.txt",
  ]) {
    const denied = evaluateExecutionPolicy(profile, {
      capability: "filesystem.write",
      path: traversalPath,
      runtimeMode: "local",
    });
    assert.equal(denied.effect, "deny", `${traversalPath} must not satisfy src prefix`);
    assert.equal(denied.matchedRule, "workspace.enforce.filesystem.write.default");
  }

  const denied = evaluateExecutionPolicy(profile, {
    capability: "filesystem.write",
    path: "package.json",
    runtimeMode: "local",
  });
  assert.equal(denied.effect, "deny");
  assert.equal(denied.matchedRule, "workspace.enforce.filesystem.write.default");
});

test("execution policy enforces shell command prefix rules", () => {
  const profile = {
    id: "workspace.shell.enforce",
    mode: "enforce",
    defaultEffect: "deny",
    rules: [
      {
        id: "workspace.shell.npm-test",
        capability: "shell.run",
        effect: "allow",
        reason: "NPM test commands are allowed.",
        match: { commandPrefix: "npm test" },
      },
    ],
  };

  const allowed = evaluateExecutionPolicy(profile, {
    capability: "shell.run",
    command: "npm test -- --runInBand",
    runtimeMode: "local",
  });
  assert.equal(allowed.effect, "allow");
  assert.equal(allowed.matchedRule, "workspace.shell.npm-test");

  const exact = evaluateExecutionPolicy(profile, {
    capability: "shell.run",
    command: "npm test",
    runtimeMode: "local",
  });
  assert.equal(exact.effect, "allow");

  const deniedOvermatch = evaluateExecutionPolicy(profile, {
    capability: "shell.run",
    command: "npm testevil",
    runtimeMode: "local",
  });
  assert.equal(deniedOvermatch.effect, "deny");

  const denied = evaluateExecutionPolicy(profile, {
    capability: "shell.run",
    command: "npm publish",
    runtimeMode: "local",
  });
  assert.equal(denied.effect, "deny");
  assert.equal(denied.matchedRule, "workspace.shell.enforce.shell.run.default");
});
