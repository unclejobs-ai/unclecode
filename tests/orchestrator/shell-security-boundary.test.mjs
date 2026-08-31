import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
    "docker run --rm alpine true",
    "kubectl get secrets",
    "gh issue create --title release",
    "git status --short",
    "git ls-files",
    "tar --to-command=./scripts/upload -xf artifact.tar",
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
    "git",
    "git -h",
    "git --version",
    "git version",
    "docker --version",
    "podman --help",
    "kubectl version --client",
    "helm version",
    "gh --version",
    "glab help",
    "hub version",
    "vercel --version",
    "wrangler --help",
    "tar -tf artifact.tgz",
    "tar -cf out.tar src",
    "tar -cf out.tar -- -T",
    "tsc --noEmit",
    "rg -n TODO src",
    "sed -n '1,20p' README.md",
    "printf '%s\\n' ok",
  ]) {
    assert.equal(resolveOneShotShellApproval({ toolName: "run_shell", input: { command } }), undefined, command);
  }
});

test("every tar files-from form is exact non-persistable project code", () => {
  const commands = [
    "tar -cf out.tar -T options.txt",
    "tar --files-from options.txt -cf out.tar",
    "tar --files-from=options.txt -cf out.tar",
    "tar --files-f=options.txt -cf out.tar",
    "tar -Toptions.txt -cf out.tar",
    "tar -cfT out.tar options.txt",
    "tar cfT out.tar options.txt",
    "command tar --verbatim-files-from -T options.txt -cf out.tar",
    "command env TAR_OPTIONS=--files-from=options.txt tar -cf out.tar src",
    "bash -c 'tar --null -T outer.txt -cf out.tar'",
    "/usr/bin/tar -cf out.tar -T options.txt",
  ];

  for (const command of commands) {
    const approval = resolveOneShotShellApproval({ toolName: "run_shell", input: { command } });
    assert.equal(approval?.kind, "project-code", command);
    assert.equal(approval.scope.key, `bash:once:${command}`);
  }
});

test("all Git work outside exact built-in inspection is one-shot project code", () => {
  const commands = [
    "git ls-files",
    "git --help",
    "git ls-files -- -C",
    "git --no-pager ls-files",
    "git config --get core.fsmonitor",
    "git rev-parse --show-toplevel",
    "git ls-tree HEAD",
    "git merge-base HEAD main",
    "git name-rev HEAD",
    "git status --short",
    "git diff --stat",
    "git push origin main",
    "git merge feature",
    "git log --ext-diff -p",
    "git show --ext-diff HEAD",
    "git grep --textconv needle",
    "git archive --format=custom HEAD",
    "git reset --hard HEAD",
    "git branch -D release",
    "git --paginate ls-files",
    "git --exec-path=./bin ls-files",
    "git -C ../outside ls-files",
    "git -cdiff.external=./scripts/publish log -p",
  ];

  for (const command of commands) {
    const approval = resolveOneShotShellApproval({ toolName: "run_shell", input: { command } });
    assert.equal(approval?.kind, "project-code", command);
    assert.equal(approval.scope.key, `bash:once:${command}`);
  }
});

test("an executable Git diff callback cannot pass through a persisted bash grant", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-git-callback-"));
  const callback = path.join(root, "diff-callback.sh");
  const marker = path.join(root, "callback-ran");
  const command = "git show --ext-diff --format= HEAD";

  try {
    writeFileSync(callback, "#!/bin/sh\n: > callback-ran\n", "utf8");
    chmodSync(callback, 0o700);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "UncleCode Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@unclecode.invalid"], { cwd: root });
    execFileSync("git", ["config", "diff.external", callback], { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "first\n", "utf8");
    execFileSync("git", ["add", "fixture.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "first"], { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "second\n", "utf8");
    execFileSync("git", ["add", "fixture.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "second"], { cwd: root });

    execFileSync("git", ["show", "--ext-diff", "--format=", "HEAD"], { cwd: root });
    assert.equal(existsSync(marker), true, "fixture must prove that the Git option executes diff.external");
    unlinkSync(marker);

    const invoked = [];
    const executor = createPolicyAwareToolExecutor({
      definitions: [RUN_SHELL_DEFINITION],
      handlers: {
        run_shell: async () => {
          invoked.push(command);
          execFileSync("git", ["show", "--ext-diff", "--format=", "HEAD"], { cwd: root });
          return { content: "ran" };
        },
      },
      policyProfile: resolveModeExecutionPolicyProfile({ mode: "yolo", envShellOptIn: false }),
      runtimeMode: "yolo",
      permissionRuleStore: createCanonicalPermissionRuleStore([{ kind: "tool", key: "bash" }]),
    });
    const result = await executor.execute({ toolName: "run_shell", input: { command }, cwd: root });

    assert.equal(result.isError, true);
    assert.deepEqual(invoked, []);
    assert.equal(existsSync(marker), false, "policy must stop the callback before dispatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an apparently read-only Git command cannot dispatch a configured fsmonitor hook", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-git-fsmonitor-"));
  const callback = path.join(root, "fsmonitor-hook.sh");
  const marker = path.join(root, "fsmonitor-ran");
  const command = "git ls-files";

  try {
    writeFileSync(callback, "#!/bin/sh\n: > fsmonitor-ran\nprintf 'unclecode-token\\n'\n", "utf8");
    chmodSync(callback, 0o700);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "core.fsmonitor", callback], { cwd: root });
    execFileSync("git", ["config", "core.fsmonitorHookVersion", "2"], { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "fixture\n", "utf8");
    execFileSync("git", ["add", "fixture.txt"], { cwd: root });

    execFileSync("git", ["ls-files"], { cwd: root });
    assert.equal(existsSync(marker), true, "fixture must prove ls-files can invoke core.fsmonitor");
    unlinkSync(marker);

    const invoked = [];
    const executor = createPolicyAwareToolExecutor({
      definitions: [RUN_SHELL_DEFINITION],
      handlers: {
        run_shell: async () => {
          invoked.push(command);
          execFileSync("git", ["ls-files"], { cwd: root });
          return { content: "ran" };
        },
      },
      policyProfile: resolveModeExecutionPolicyProfile({ mode: "yolo", envShellOptIn: false }),
      runtimeMode: "yolo",
      permissionRuleStore: createCanonicalPermissionRuleStore([{ kind: "tool", key: "bash" }]),
    });
    const result = await executor.execute({ toolName: "run_shell", input: { command }, cwd: root });

    assert.equal(result.isError, true);
    assert.deepEqual(invoked, []);
    assert.equal(existsSync(marker), false, "policy must stop fsmonitor before dispatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partial-clone read cannot dispatch an ext remote helper before approval", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-git-promisor-"));
  const callback = path.join(root, "remote-helper.sh");
  const marker = path.join(root, "remote-helper-ran");
  const command = "git ls-tree HEAD";
  const childEnvironment = { ...process.env, GIT_ALLOW_PROTOCOL: "ext" };

  try {
    writeFileSync(callback, "#!/bin/sh\n: > remote-helper-ran\nexit 1\n", "utf8");
    chmodSync(callback, 0o700);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "core.repositoryformatversion", "1"], { cwd: root });
    execFileSync("git", ["config", "extensions.partialClone", "origin"], { cwd: root });
    execFileSync("git", ["config", "remote.origin.promisor", "true"], { cwd: root });
    execFileSync("git", ["config", "remote.origin.partialCloneFilter", "blob:none"], { cwd: root });
    execFileSync("git", ["config", "remote.origin.url", `ext::${callback}`], { cwd: root });
    writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"1".repeat(40)}\n`, "utf8");

    assert.throws(() => execFileSync("git", ["ls-tree", "HEAD"], {
      cwd: root,
      env: childEnvironment,
      stdio: "ignore",
    }));
    assert.equal(existsSync(marker), true, "fixture must prove lazy object lookup reached git-remote-ext");
    unlinkSync(marker);

    const invoked = [];
    const executor = createPolicyAwareToolExecutor({
      definitions: [RUN_SHELL_DEFINITION],
      handlers: {
        run_shell: async () => {
          invoked.push(command);
          return { content: "ran" };
        },
      },
      policyProfile: resolveModeExecutionPolicyProfile({ mode: "yolo", envShellOptIn: false }),
      runtimeMode: "yolo",
      permissionRuleStore: createCanonicalPermissionRuleStore([{ kind: "tool", key: "bash" }]),
    });
    const result = await executor.execute({ toolName: "run_shell", input: { command }, cwd: root });

    assert.equal(result.isError, true);
    assert.deepEqual(invoked, []);
    assert.equal(existsSync(marker), false, "policy must stop the remote helper before dispatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("known control clients and callback-bearing inspections never inherit a bash grant", () => {
  const commands = [
    "docker run --rm alpine true",
    "podman rm release-container",
    "kubectl get secrets",
    "kubectl exec deploy/app -- sh -c release",
    "helm list",
    "gh issue create --title release",
    "gh workflow run deploy.yml",
    "glab issue create --title release",
    "hub issue create -m release",
    "vercel env rm API_KEY production",
    "netlify env:unset API_KEY",
    "wrangler secret delete API_KEY",
    "firebase functions:delete publishRelease",
    "fly secrets unset API_KEY",
    "railway variables delete API_KEY",
    "git status --short",
    "git diff --stat",
    "git config core.fsmonitor ./scripts/fsmonitor",
    "git config --unset core.fsmonitor",
    "tar --checkpoint=1 --checkpoint-action=exec=./scripts/publish -cf out.tar .",
    "tar --checkpoint-act=exec=./scripts/publish -cf out.tar .",
    "tar --to-command=./scripts/upload -xf artifact.tar",
    "tar -I ./scripts/compress -cf artifact.tar src",
    "tar -cfI artifact.tar ./scripts/compress src",
    "tar cfI artifact.tar ./scripts/compress src",
    "tar -cf out.tar -T options.txt",
    "tar --files-from options.txt -cf out.tar",
    "tar --files-from=options.txt -cf out.tar",
    "tar --files-f=options.txt -cf out.tar",
    "tar -Toptions.txt -cf out.tar",
    "tar -cfT out.tar options.txt",
    "tar cfT out.tar options.txt",
  ];

  for (const command of commands) {
    const approval = resolveOneShotShellApproval({ toolName: "run_shell", input: { command } });
    assert.ok(approval, command);
    assert.equal(approval.scope.key, `bash:once:${command}`);
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
    "CI=1 tsc --noEmit",
    "GIT_EXTERNAL_DIFF=./scripts/ship git diff",
    "git commit -m local",
    "git checkout feature",
    "git fetch origin",
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
    "cat ~/[.]uncl*/server[.]tok*",
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
    BASH_ENV: "./scripts/bash-env.sh",
    ENV: "./scripts/sh-env.sh",
    ZDOTDIR: "./dotfiles",
    NODE_OPTIONS: "--require=./scripts/node-hook.cjs",
    PYTHONSTARTUP: "./scripts/python-startup.py",
    PYTHONPATH: "./python-hooks",
    RUBYOPT: "-r./scripts/ruby-hook.rb",
    RUBYLIB: "./ruby-hooks",
    PERL5OPT: "-Mproject_hook",
    PERL5LIB: "./perl-hooks",
    GIT_CONFIG_COUNT: "1",
    GIT_EXTERNAL_DIFF: "./scripts/diff-hook.sh",
    GIT_DIFF_OPTS: "--stat",
    GIT_PAGER: "./scripts/pager.sh",
    PAGER: "./scripts/pager.sh",
    LESS: "-R",
    TAR_OPTIONS: "--files-from=options.txt",
    LD_PRELOAD: "./native-hook.so",
    DYLD_INSERT_LIBRARIES: "./native-hook.dylib",
    RIPGREP_CONFIG_PATH: "./ripgrep.conf",
    MAKEFLAGS: "--eval=all:;./scripts/make-hook.sh",
    JAVA_TOOL_OPTIONS: "-javaagent:./agent.jar",
    PHP_INI_SCAN_DIR: "./php-config",
    RUSTC_WRAPPER: "./scripts/rustc-wrapper.sh",
    PSModulePath: "./powershell-modules",
    "BASH_FUNC_git%%": "() { ./scripts/git-hook.sh; }",
    "legacy_function%%": "ignored",
    LEGACY_SHELL_FUNCTION: "() { ./scripts/legacy-hook.sh; }",
    HTTP_PROXY: "http://proxy.example:8080",
    LANG: "ko_KR.UTF-8",
    CC: "clang",
    SAFE_BUILD_FLAG: "1",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/Users/example",
    HTTP_PROXY: "http://proxy.example:8080",
    LANG: "ko_KR.UTF-8",
    CC: "clang",
    SAFE_BUILD_FLAG: "1",
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  });
});

test("exported shell functions cannot replace a model-approved command", () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-shell-function-env-"));
  const marker = path.join(root, "function-ran");
  const functionName = "BASH_FUNC_git%%";
  const source = {
    PATH: process.env.PATH,
    MARKER_PATH: marker,
    [functionName]: "() { : > \"$MARKER_PATH\"; command git \"$@\"; }",
  };

  try {
    execFileSync("/bin/bash", ["-c", "git --version"], { env: source });
    assert.equal(existsSync(marker), true, "fixture must prove Bash imported and executed the function");
    unlinkSync(marker);

    execFileSync("/bin/bash", ["-c", "git --version"], {
      env: createModelShellEnvironment(source),
    });
    assert.equal(existsSync(marker), false, "the sanitized child must execute the real Git binary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
