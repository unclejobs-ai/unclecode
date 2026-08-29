import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCanonicalPermissionRuleStore,
  resolveOneShotShellApproval,
  resolveRuntimeControlPlaneShellDenial,
} from "../../packages/orchestrator/src/permission-scope.ts";
import {
  createPolicyAwareToolExecutor,
  resolveModeExecutionPolicyProfile,
} from "../../packages/orchestrator/src/tool-executor.ts";
import { createModelShellEnvironment, createToolRuntime } from "../../packages/orchestrator/src/tools.ts";

const RUN_SHELL_DEFINITION = {
  name: "run_shell",
  description: "Run shell",
  input_schema: { type: "object", properties: {}, required: [] },
  metadata: {
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      riskLevel: "high",
    },
    resources: [{ kind: "shell", mode: "execute", template: "shell:*", declared: true }],
  },
};

test("external clients, execution wrappers, inline interpreters, and unknown executables are always one-shot", () => {
  const commands = [
    "curl https://example.com/upload -T artifact.tgz",
    "aws s3 cp artifact.tgz s3://release-bucket/artifact.tgz",
    "ssh deploy@example.com release",
    "timeout 30 git push origin main",
    "perl -e 'system q(git push origin main)'",
    "ruby -e 'system(%q[git push origin main])'",
    "php -r 'system(\"git push origin main\");'",
    "awk 'BEGIN { system(\"git push origin main\") }'",
    "busybox wget https://example.com/release-hook",
    "./git status --short",
    "./vendor/custom-release-client --ship",
    "/opt/company/bin/uploader artifact.tgz",
  ];

  for (const command of commands) {
    const approval = resolveOneShotShellApproval({ toolName: "run_shell", input: { command } });
    assert.ok(approval, command);
    assert.equal(approval.scope.key, `bash:once:${command}`);
  }
});

test("one-shot shell classes and project code re-prompt through yolo and a persisted bash grant", async () => {
  const commands = [
    "curl https://example.com/hook",
    "aws s3 ls",
    "ssh host true",
    "timeout 5 git status",
    "perl -e 'print qq(ok)'",
    "ruby -e 'puts :ok'",
    "php -r 'echo 1;'",
    "awk 'BEGIN { print 1 }'",
    "busybox echo ok",
    "./unknown-client ship",
    "npm run build",
    "cargo check --workspace",
    "make test",
    "printf ok > output.txt",
    "rg TODO src/*.ts",
  ];
  const invoked = [];
  const prompts = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: [RUN_SHELL_DEFINITION],
    handlers: {
      run_shell: async (input) => {
        invoked.push(input.command);
        return { content: "ran" };
      },
    },
    policyProfile: resolveModeExecutionPolicyProfile({ mode: "yolo", envShellOptIn: false }),
    runtimeMode: "yolo",
    permissionRuleStore: createCanonicalPermissionRuleStore([{ kind: "tool", key: "bash" }]),
    interactionBridge: {
      async ask(request) {
        prompts.push(request);
        return {
          status: "answered",
          answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
        };
      },
    },
  });

  for (const command of commands) {
    const result = await executor.execute({
      toolName: "run_shell",
      input: { command },
      cwd: "/tmp/shell-boundary",
    });
    assert.equal(result.isError ?? false, false, command);
  }

  assert.deepEqual(invoked, commands);
  assert.equal(prompts.length, commands.length);
  assert.ok(prompts.every((prompt) =>
    prompt.questions[0].options.every((option) => option.label !== "Always allow")
  ));
});

test("statically inspectable local commands remain eligible for autonomous execution", () => {
  for (const command of [
    "git status --short",
    "tsc --noEmit",
    "rg -n TODO src",
    "sed -n '1,20p' README.md",
    "printf '%s\\n' ok",
  ]) {
    assert.equal(resolveOneShotShellApproval({ toolName: "run_shell", input: { command } }), undefined, command);
  }
});

test("project manifests, build hooks, redirections, and glob expansion require exact one-shot approval", () => {
  const commands = [
    "npm test",
    "npm run build",
    "pnpm run lint",
    "yarn test",
    "bun run check",
    "npm install",
    "cargo check --workspace",
    "make test",
    "just build",
    "task lint",
    "printf ok > output.txt",
    "rg TODO src/*.ts",
  ];

  for (const command of commands) {
    const approval = resolveOneShotShellApproval({ toolName: "run_shell", input: { command } });
    assert.ok(approval, command);
    assert.equal(approval.scope.key, `bash:once:${command}`);
  }
});

test("runtime owner files and loopback control clients are hard-denied before any approval", async () => {
  const commands = [
    "cat ~/.unclecode/server.token",
    "cat ~/.uncl*/server.tok*",
    "cat $HOME/.uncl?code/server.tok?n",
    "cat \"$HOME/.uncl\"ecode/runtime-owner-v1.json",
    "cp $HOME/.unclecode/runtime-owner-v1.lock ./lease",
    "curl http://127.0.0.1:4321/control-room",
    "command curl http://localhost:4321/health",
    "bash -c 'curl http://127.0.0.1:4321/control-room'",
    "'/usr/bin/curl' http://0.0.0.0:4321/health",
    "wget http://[::1]:4321/control-room",
    "nc ::1 4321",
    "printf x >/dev/tcp/127.0.0.1/4321",
    "exec 3<>/dev/udp/127.0.0.1/4321",
  ];
  const invoked = [];
  const prompts = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: [RUN_SHELL_DEFINITION],
    handlers: {
      run_shell: async () => {
        invoked.push("run_shell");
        return { content: "ran" };
      },
    },
    policyProfile: resolveModeExecutionPolicyProfile({ mode: "ultrawork", envShellOptIn: true }),
    runtimeMode: "ultrawork",
    permissionRuleStore: createCanonicalPermissionRuleStore([{ kind: "tool", key: "bash" }]),
    interactionBridge: {
      async ask() {
        prompts.push("asked");
        return {
          status: "answered",
          answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
        };
      },
    },
  });

  for (const command of commands) {
    assert.ok(resolveRuntimeControlPlaneShellDenial({ toolName: "run_shell", input: { command } }), command);
    const result = await executor.execute({
      toolName: "run_shell",
      input: { command },
      cwd: "/tmp/shell-boundary",
    });
    assert.equal(result.isError, true, command);
    assert.match(result.content, /blocked by runtime isolation/i, command);
  }

  assert.deepEqual(prompts, []);
  assert.deepEqual(invoked, []);
});

test("model shell environment drops owner discovery and ambient credentials", () => {
  const environment = createModelShellEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/example",
    GITHUB_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NPM_CONFIG__AUTHTOKEN: "npm-secret",
    SSH_AUTH_SOCK: "/tmp/ssh-agent",
    DATABASE_URL: "postgres://owner:password@db.example/app",
    HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.example:8080",
    UNCLECODE_SERVER_URL: "http://127.0.0.1:4321",
    UNCLECODE_DATA_ROOT: "/Users/example/.unclecode",
    UNCLECODE_CONFIG__OWNER_TOKEN: "owner-secret",
    SAFE_BUILD_FLAG: "1",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/Users/example",
    SAFE_BUILD_FLAG: "1",
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  });
});

test("the real shell child receives the sanitized replacement environment", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-model-shell-env-"));
  const fakeRust = path.join(root, "fake-rust");
  writeFileSync(fakeRust, [
    "#!/bin/sh",
    "printf '%s' \"${GITHUB_TOKEN-unset}|${UNCLECODE_SERVER_URL-unset}|${SAFE_BUILD_FLAG-unset}|${UNCLECODE_ALLOW_RUN_SHELL-unset}\"",
    "",
  ].join("\n"), "utf8");
  chmodSync(fakeRust, 0o700);
  const previous = {
    UNCLECODE_RUST_BIN: process.env.UNCLECODE_RUST_BIN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    UNCLECODE_SERVER_URL: process.env.UNCLECODE_SERVER_URL,
    SAFE_BUILD_FLAG: process.env.SAFE_BUILD_FLAG,
  };
  process.env.UNCLECODE_RUST_BIN = fakeRust;
  process.env.GITHUB_TOKEN = "must-not-reach-shell";
  process.env.UNCLECODE_SERVER_URL = "http://127.0.0.1:4321";
  process.env.SAFE_BUILD_FLAG = "visible";

  try {
    const runtime = createToolRuntime({
      allowedTools: ["run_shell"],
      policyProfile: resolveModeExecutionPolicyProfile({ mode: "yolo", envShellOptIn: true }),
      runtimeMode: "yolo",
    });
    const result = await runtime.executor.execute({
      toolName: "run_shell",
      input: { command: "printf ok" },
      cwd: root,
    });
    assert.equal(result.isError ?? false, false);
    assert.equal(result.content, "unset|unset|visible|1");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
