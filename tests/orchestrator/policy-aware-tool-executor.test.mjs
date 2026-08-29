import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalPermissionRuleStore,
  createPolicyAwareToolExecutor,
  resolveModeExecutionPolicyProfile,
} from "@unclecode/orchestrator";

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

test("release-sensitive shell actions require fresh one-shot approval despite autonomy and a bash grant", async () => {
  const commands = [
    "git push origin main",
    "git switch main && git merge feature/release-safety",
    "npm publish --access public",
    "npm --workspace @scope/package publish",
    "pnpm --filter web publish",
    "pnpm run deploy",
    "gh release create v1.2.3",
    "gh --repo owner/project pr merge 42 --merge",
    "glab mr merge 42",
    "hub merge feature/release-safety",
    "git send-pack origin HEAD:refs/heads/main",
    "vercel deploy --prod",
    "bash -c 'git push origin main'",
    "sh -c 'gh pr merge 42 --merge'",
    "sh -c -- 'git push origin main'",
    "command exec gh pr merge 42 --merge",
    "command env git push origin main",
    "env command env git push origin main",
    "git pu\\\nsh origin main",
    "gh p\\\nr merge 42 --merge",
    "git push origin main",
  ];
  const invoked = [];
  const questions = [];
  const store = createCanonicalPermissionRuleStore([{ kind: "tool", key: "bash" }]);
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: {
      ...createRecordingHandlers([]),
      run_shell: async (input) => {
        invoked.push(input.command);
        return { content: "release-action-ran" };
      },
    },
    policyProfile: resolveModeExecutionPolicyProfile({ mode: "yolo", envShellOptIn: false }),
    runtimeMode: "yolo",
    permissionRuleStore: store,
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

  for (const command of commands) {
    const result = await executor.execute({
      toolName: "run_shell",
      input: { command },
      cwd: "/tmp/policy-executor",
    });
    assert.equal(result.isError ?? false, false, command);
  }

  assert.deepEqual(invoked, commands);
  assert.equal(questions.length, commands.length);
  assert.ok(questions.every((request) =>
    request.questions[0].options.every((option) => option.label !== "Always allow")
  ));
  questions.forEach((request, index) => {
    assert.ok(request.questions[0].question.includes(JSON.stringify(commands[index])));
  });
  assert.deepEqual(store.list(), [{ kind: "tool", key: "bash" }]);
});

test("ambiguous shell wrappers fail closed before an autonomy or persisted bash grant", async () => {
  const commands = [
    'eval "$RELEASE_COMMAND"',
    "npm exec -- git push origin main",
    "npx vercel deploy --prod",
    "git -c alias.ship='push origin main' ship",
    "sh ./scripts/ship.sh",
    "./scripts/ship.sh",
    "npm run ship",
    "make ship",
    "yarn deploy",
    "vercel --prod",
    `node -e "require('node:child_process').execSync('git push origin main')"`,
    `node --eval="require('node:child_process').execSync('git push origin main')"`,
    `python -c "import os; os.system('gh pr merge 42 --merge')"`,
    `python3.12 -c "import os; os.system('git push origin main')"`,
    "node scripts/release.js",
    "python scripts/deploy.py",
    "git ship",
    "gh api --method PUT repos/o/r/pulls/42/merge",
    "glab api projects/1/releases --method POST",
  ];
  const invoked = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers(invoked),
    policyProfile: resolveModeExecutionPolicyProfile({ mode: "ultrawork", envShellOptIn: false }),
    runtimeMode: "ultrawork",
    permissionRuleStore: createCanonicalPermissionRuleStore([{ kind: "tool", key: "bash" }]),
  });

  for (const command of commands) {
    const result = await executor.execute({
      toolName: "run_shell",
      input: { command },
      cwd: "/tmp/policy-executor",
    });
    assert.equal(result.isError, true, command);
    assert.match(result.content, /not granted.*one-shot confirmation/i, command);
  }

  assert.deepEqual(invoked, []);
});

test("autonomy keeps ordinary local build and test shell commands prompt-free", async () => {
  const commands = [
    "npm test",
    "npm run build",
    "pnpm run lint",
    "cargo test --workspace",
    "make test",
    "git status --short",
    'printf "%s\\n" "release notes"',
  ];
  const invoked = [];
  let prompts = 0;
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: {
      ...createRecordingHandlers([]),
      run_shell: async (input) => {
        invoked.push(input.command);
        return { content: "local-command-ran" };
      },
    },
    policyProfile: resolveModeExecutionPolicyProfile({ mode: "yolo", envShellOptIn: false }),
    runtimeMode: "yolo",
    interactionBridge: {
      async ask() {
        prompts += 1;
        return { status: "cancelled" };
      },
    },
  });

  for (const command of commands) {
    const result = await executor.execute({
      toolName: "run_shell",
      input: { command },
      cwd: "/tmp/policy-executor",
    });
    assert.equal(result.isError ?? false, false, command);
  }

  assert.deepEqual(invoked, commands);
  assert.equal(prompts, 0);
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

test("sequential same-scope approvals receive distinct per-call decision identities", async () => {
  const decisionIds = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers([]),
    policyProfile: { id: "test.default-allow", mode: "enforce", defaultEffect: "allow", rules: [] },
    runtimeMode: "default",
    interactionBridge: {
      async ask(request) {
        decisionIds.push(request.id);
        return { status: "cancelled" };
      },
    },
  });

  await executor.execute({
    toolName: "write_file",
    input: { path: "a.txt", content: "a" },
    cwd: "/tmp/policy-executor",
  });
  await executor.execute({
    toolName: "write_file",
    input: { path: "b.txt", content: "b" },
    cwd: "/tmp/policy-executor",
  });

  assert.equal(decisionIds.length, 2);
  assert.notEqual(decisionIds[0], decisionIds[1]);
  assert.ok(decisionIds.every(decisionId => /^[A-Za-z0-9._:-]{1,160}$/.test(decisionId)));
});

test("concurrent always-allow prompts once, stores one canonical rule, and authorizes the next action", async () => {
  const invoked = [];
  const questions = [];
  const store = createCanonicalPermissionRuleStore();
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers(invoked),
    policyProfile: { id: "test.default-allow", mode: "enforce", defaultEffect: "allow", rules: [] },
    runtimeMode: "default",
    permissionRuleStore: store,
    interactionBridge: {
      async ask(request) {
        questions.push(request);
        return {
          status: "answered",
          answers: [{ id: "policy-confirmation", selectedOptions: ["Always allow"] }],
        };
      },
    },
  });

  const request = (command) => executor.execute({
    toolName: "run_shell",
    input: { command },
    cwd: "/tmp/policy-executor",
  });
  await Promise.all([request("echo one"), request("echo two")]);
  await request("echo three");

  assert.equal(questions.length, 1);
  assert.match(questions[0].title, /Security approval · bash/);
  assert.deepEqual(store.list(), [{ kind: "tool", key: "bash" }]);
  assert.deepEqual(invoked, ["run_shell", "run_shell", "run_shell"]);
});

test("concurrent approve-once authorizes only the prompt owner and re-prompts the waiter", async () => {
  const invoked = [];
  const prompts = [];
  const answers = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: {
      ...createRecordingHandlers(invoked),
      write_file: async (input) => {
        invoked.push(input.path);
        return { content: `${input.path}-ran` };
      },
    },
    policyProfile: { id: "test.default-allow", mode: "enforce", defaultEffect: "allow", rules: [] },
    runtimeMode: "default",
    interactionBridge: {
      ask(request) {
        prompts.push(request);
        return new Promise((resolve) => answers.push(resolve));
      },
    },
  });

  const first = executor.execute({
    toolName: "write_file",
    input: { path: "a.txt", content: "a" },
    cwd: "/tmp/policy-executor",
  });
  const second = executor.execute({
    toolName: "write_file",
    input: { path: "b.txt", content: "b" },
    cwd: "/tmp/policy-executor",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 1);
  answers.shift()({
    status: "answered",
    answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(invoked, ["a.txt"]);
  assert.equal(prompts.length, 2);
  answers.shift()({
    status: "answered",
    answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
  });
  await Promise.all([first, second]);
  assert.deepEqual(invoked, ["a.txt", "b.txt"]);
});

test("aborting an approval owner releases a waiter to re-prompt without stale execution", async () => {
  const invoked = [];
  const prompts = [];
  const answers = [];
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: {
      ...createRecordingHandlers(invoked),
      write_file: async (input) => {
        invoked.push(input.path);
        return { content: `${input.path}-ran` };
      },
    },
    policyProfile: { id: "test.default-allow", mode: "enforce", defaultEffect: "allow", rules: [] },
    runtimeMode: "default",
    interactionBridge: {
      ask(request, signal) {
        prompts.push(request);
        return new Promise((resolve) => {
          answers.push(resolve);
          signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
        });
      },
    },
  });
  const ownerController = new AbortController();
  const owner = executor.execute({
    toolName: "write_file",
    input: { path: "owner.txt", content: "a" },
    cwd: "/tmp/policy-executor",
    signal: ownerController.signal,
  });
  const waiter = executor.execute({
    toolName: "write_file",
    input: { path: "waiter.txt", content: "b" },
    cwd: "/tmp/policy-executor",
  });
  await new Promise((resolve) => setImmediate(resolve));
  ownerController.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prompts.length, 2);
  answers.at(-1)({
    status: "answered",
    answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
  });
  const [ownerResult, waiterResult] = await Promise.all([owner, waiter]);
  assert.equal(ownerResult.isError, true);
  assert.equal(waiterResult.isError ?? false, false);
  assert.deepEqual(invoked, ["waiter.txt"]);
});

test("aborting an approval waiter does not cancel the owner or consume its once result", async () => {
  const invoked = [];
  const prompts = [];
  let resolveOwner;
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: {
      ...createRecordingHandlers(invoked),
      write_file: async (input) => {
        invoked.push(input.path);
        return { content: `${input.path}-ran` };
      },
    },
    policyProfile: { id: "test.default-allow", mode: "enforce", defaultEffect: "allow", rules: [] },
    runtimeMode: "default",
    interactionBridge: {
      ask(request) {
        prompts.push(request);
        return new Promise((resolve) => { resolveOwner = resolve; });
      },
    },
  });
  const waiterController = new AbortController();
  const owner = executor.execute({
    toolName: "write_file",
    input: { path: "owner.txt", content: "a" },
    cwd: "/tmp/policy-executor",
  });
  const waiter = executor.execute({
    toolName: "write_file",
    input: { path: "waiter.txt", content: "b" },
    cwd: "/tmp/policy-executor",
    signal: waiterController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  waiterController.abort();
  resolveOwner({
    status: "answered",
    answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
  });
  const [ownerResult, waiterResult] = await Promise.all([owner, waiter]);

  assert.equal(ownerResult.isError ?? false, false);
  assert.equal(waiterResult.isError, true);
  assert.equal(prompts.length, 1);
  assert.deepEqual(invoked, ["owner.txt"]);
});

test("an approval resolved after abort is stale and never starts execution", async () => {
  const invoked = [];
  let resolveAnswer;
  const executor = createPolicyAwareToolExecutor({
    definitions: DEFINITIONS,
    handlers: createRecordingHandlers(invoked),
    policyProfile: { id: "test.default-allow", mode: "enforce", defaultEffect: "allow", rules: [] },
    runtimeMode: "default",
    interactionBridge: {
      ask() {
        return new Promise((resolve) => { resolveAnswer = resolve; });
      },
    },
  });
  const controller = new AbortController();
  const pending = executor.execute({
    toolName: "write_file",
    input: { path: "late.txt", content: "late" },
    cwd: "/tmp/policy-executor",
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  resolveAnswer({
    status: "answered",
    answers: [{ id: "policy-confirmation", selectedOptions: ["Approve"] }],
  });
  const result = await pending;
  assert.equal(result.isError, true);
  assert.deepEqual(invoked, []);
});
