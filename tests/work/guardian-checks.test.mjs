import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runWorkspaceGuardianChecks } from "../../apps/unclecode-cli/src/guardian-checks.ts";
import { runLspGuardianChecks } from "../../apps/unclecode-cli/src/guardian-lsp-checks.ts";

test("runWorkspaceGuardianChecks runs bounded scripts from package.json and reports pass/fail summaries", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: { HOME: "/tmp/home-a" },
      scripts: ["lint", "check"],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            lint: "biome check .",
            check: "tsc -p tsconfig.check.json --noEmit",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        const scriptName = args[1];
        if (scriptName === "lint") {
          return { stdout: "", stderr: "" };
        }
        const error = new Error("Command failed");
        error.stdout = "";
        error.stderr = "Type error: missing field";
        throw error;
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [
    ["npm", ["run", "lint", "--silent"]],
    ["npm", ["run", "check", "--silent"]],
  ]);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[0]?.name, "lint");
  assert.equal(result.checks[0]?.status, "passed");
  assert.equal(result.checks[1]?.name, "check");
  assert.equal(result.checks[1]?.status, "failed");
  assert.match(result.summary, /lint PASS/);
  assert.match(result.summary, /check FAIL/);
  assert.match(result.summary, /Type error: missing field/);
});

test("runWorkspaceGuardianChecks skips unavailable scripts and stays honest when none are configured", async () => {
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["check", "lint"],
    },
    {
      readFile: async () => JSON.stringify({ scripts: { doctor: "node doctor.js" } }),
      execFile: async () => {
        throw new Error("should not run");
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(result.checks, []);
  assert.equal(result.summary, "No executable checks configured.");
});

test("runWorkspaceGuardianChecks skips code checks when changed files are docs-only", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["lint", "check", "test"],
      changedFiles: ["docs/spec.md", "README.md"],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            lint: "biome check .",
            check: "tsc -p tsconfig.check.json --noEmit",
            test: "node --test",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, []);
  assert.deepEqual(result.checks, []);
  assert.equal(
    result.summary,
    "No applicable executable checks selected for changed files.",
  );
});

test("runWorkspaceGuardianChecks narrows test-only changes to the test script subset", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["lint", "check", "test"],
      changedFiles: ["tests/auth/login.test.mjs", "tests/auth/oauth.test.mjs"],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            lint: "biome check .",
            check: "tsc -p tsconfig.check.json --noEmit",
            test: "node --test",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [["npm", ["run", "test", "--silent"]]]);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0]?.name, "test");
  assert.match(result.summary, /test PASS/);
});

test("runWorkspaceGuardianChecks expands source changes into the matching test subset scripts when generic test is unavailable", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["check", "test"],
      changedFiles: ["packages/providers/src/runtime.ts", "packages/providers/src/openai-auth.ts"],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            check: "tsc -p tsconfig.check.json --noEmit",
            "test:providers": "node --conditions=source --import tsx --test tests/providers/*.test.mjs",
            "test:contracts": "node --conditions=source --import tsx --test tests/contracts/*.test.mjs",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [
    ["npm", ["run", "check", "--silent"]],
    ["npm", ["run", "test:providers", "--silent"]],
  ]);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[1]?.name, "test:providers");
  assert.match(result.summary, /test:providers PASS/);
});

test("runWorkspaceGuardianChecks appends LSP evidence when a bridge is provided", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "uc-guardian-workspace-"));
  const execCalls = [];
  const lspCalls = [];
  try {
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(workspace, "runtime.ts"), "const broken = true;");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "main.rs"), "fn main() {}\n");
    writeFileSync(join(workspace, "README.md"), "docs");

    const result = await runWorkspaceGuardianChecks(
      {
        cwd: workspace,
        env: {},
        scripts: [],
        changedFiles: ["runtime.ts", "src/main.rs", "README.md"],
        lspBridge: {
          async checkAfterEdit(input) {
            lspCalls.push(input);
            return {
              status: "fail",
              summary: "1 diagnostic",
            };
          },
        },
        lspTimeoutMs: 25,
        lspMaxDiagnostics: 3,
      },
      {
        execFile: async (command, args) => {
          execCalls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        platform: "darwin",
      },
    );

    assert.deepEqual(execCalls, []);
    assert.equal(lspCalls.length, 2);
    assert.equal(lspCalls[0]?.path, "runtime.ts");
    assert.equal(lspCalls[1]?.path, "src/main.rs");
    assert.deepEqual(lspCalls[0]?.options, { timeoutMs: 25, maxDiagnostics: 3 });
    assert.equal(result.checks[0]?.name, "lsp:runtime.ts");
    assert.equal(result.checks[0]?.status, "failed");
    assert.match(result.summary, /lsp:runtime\.ts FAIL · 1 diagnostic/);
    assert.match(result.summary, /lsp:src\/main\.rs FAIL · 1 diagnostic/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runWorkspaceGuardianChecks fails closed when LSP changed file paths escape the workspace", async () => {
  const lspCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: [],
      changedFiles: ["../outside.ts", "/tmp/absolute.ts"],
      lspBridge: {
        async checkAfterEdit(input) {
          lspCalls.push(input);
          return {
            status: "pass",
            summary: "should not run",
          };
        },
      },
    },
    {
      readFile: async (path) => {
        if (path === "/repo/package.json") {
          return JSON.stringify({ scripts: {} });
        }
        throw new Error(`unexpected read: ${path}`);
      },
      execFile: async () => ({ stdout: "", stderr: "" }),
      platform: "darwin",
    },
  );

  assert.deepEqual(lspCalls, []);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[0]?.status, "failed");
  assert.equal(result.checks[1]?.status, "failed");
  assert.match(result.summary, /changed file escapes workspace: \.\.\/outside\.ts/);
  assert.match(result.summary, /changed file must be workspace-relative: \/tmp\/absolute\.ts/);
});

test("runWorkspaceGuardianChecks rejects LSP changed file symlinks that resolve outside the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "uc-guardian-workspace-"));
  const outside = mkdtempSync(join(tmpdir(), "uc-guardian-outside-"));
  const lspCalls = [];
  try {
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(outside, "secret.ts"), "outside-secret");
    symlinkSync(join(outside, "secret.ts"), join(workspace, "link.ts"));

    const result = await runWorkspaceGuardianChecks(
      {
        cwd: workspace,
        env: {},
        scripts: [],
        changedFiles: ["link.ts"],
        lspBridge: {
          async checkAfterEdit(input) {
            lspCalls.push(input);
            return {
              status: "pass",
              summary: "should not run",
            };
          },
        },
      },
      {
        execFile: async () => ({ stdout: "", stderr: "" }),
        platform: "darwin",
      },
    );

    assert.deepEqual(lspCalls, []);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0]?.status, "failed");
    assert.match(result.summary, /changed file escapes workspace: link\.ts/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("runWorkspaceGuardianChecks can select multiple targeted test subsets for cross-package source changes", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["lint", "check", "test"],
      changedFiles: [
        "packages/context-broker/src/context-memory.ts",
        "packages/providers/src/runtime.ts",
      ],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            lint: "biome check .",
            check: "tsc -p tsconfig.check.json --noEmit",
            "test:context-broker": "node --conditions=source --import tsx --test tests/context-broker/*.test.mjs",
            "test:providers": "node --conditions=source --import tsx --test tests/providers/*.test.mjs",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [
    ["npm", ["run", "lint", "--silent"]],
    ["npm", ["run", "check", "--silent"]],
    ["npm", ["run", "test:context-broker", "--silent"]],
    ["npm", ["run", "test:providers", "--silent"]],
  ]);
  assert.equal(result.checks.length, 4);
  assert.equal(result.checks[2]?.name, "test:context-broker");
  assert.equal(result.checks[3]?.name, "test:providers");
});

test("runWorkspaceGuardianChecks maps work, orchestrator, tui, and command surfaces onto their targeted test scripts", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["check", "test"],
      changedFiles: [
        "apps/unclecode-cli/src/work-runtime.ts",
        "packages/orchestrator/src/work-agent.ts",
        "packages/tui/src/work-shell-pane.tsx",
        "tests/commands/router.test.mjs",
      ],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            check: "tsc -p tsconfig.check.json --noEmit",
            "test:work": "node --conditions=source --import tsx --test tests/work/*.test.mjs",
            "test:orchestrator": "node --conditions=source --import tsx --test tests/orchestrator/*.test.mjs",
            "test:tui": "node --conditions=source --import tsx --test tests/tui/*.test.mjs",
            "test:commands": "node --conditions=source --import tsx --test tests/commands/*.test.mjs",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [
    ["npm", ["run", "check", "--silent"]],
    ["npm", ["run", "test:work", "--silent"]],
    ["npm", ["run", "test:orchestrator", "--silent"]],
    ["npm", ["run", "test:tui", "--silent"]],
    ["npm", ["run", "test:commands", "--silent"]],
  ]);
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks[1]?.name, "test:work");
  assert.equal(result.checks[2]?.name, "test:orchestrator");
  assert.equal(result.checks[3]?.name, "test:tui");
  assert.equal(result.checks[4]?.name, "test:commands");
});

test("runWorkspaceGuardianChecks adds contract coverage for public shell and package boundary changes", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["check", "test"],
      changedFiles: [
        "apps/unclecode-cli/src/session-center-launcher.ts",
        "apps/unclecode-cli/src/interactive-launch-inputs.ts",
        "apps/unclecode-cli/src/work-bootstrap.ts",
        "packages/tui/src/index.tsx",
        "packages/orchestrator/src/index.ts",
        "packages/context-broker/src/index.ts",
      ],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            check: "tsc -p tsconfig.check.json --noEmit",
            "test:commands": "node --conditions=source --import tsx --test tests/commands/*.test.mjs",
            "test:tui": "node --conditions=source --import tsx --test tests/tui/*.test.mjs",
            "test:orchestrator": "node --conditions=source --import tsx --test tests/orchestrator/*.test.mjs",
            "test:context-broker": "node --conditions=source --import tsx --test tests/context-broker/*.test.mjs",
            "test:contracts": "node --conditions=source --import tsx --test tests/contracts/*.test.mjs tests/contracts/*.test.ts",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [
    ["npm", ["run", "check", "--silent"]],
    ["npm", ["run", "test:commands", "--silent"]],
    ["npm", ["run", "test:contracts", "--silent"]],
    ["npm", ["run", "test:tui", "--silent"]],
    ["npm", ["run", "test:orchestrator", "--silent"]],
    ["npm", ["run", "test:context-broker", "--silent"]],
  ]);
  assert.equal(result.checks.length, 6);
  assert.equal(result.checks[1]?.name, "test:commands");
  assert.equal(result.checks[2]?.name, "test:contracts");
  assert.equal(result.checks[3]?.name, "test:tui");
  assert.equal(result.checks[4]?.name, "test:orchestrator");
  assert.equal(result.checks[5]?.name, "test:context-broker");
});


test("runWorkspaceGuardianChecks treats the public TUI index seam as both tui and contract impact", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["check", "test"],
      changedFiles: ["packages/tui/src/index.tsx"],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            check: "tsc -p tsconfig.check.json --noEmit",
            "test:tui": "node --conditions=source --import tsx --test tests/tui/*.test.mjs",
            "test:contracts": "node --conditions=source --import tsx --test tests/contracts/*.test.mjs tests/contracts/*.test.ts",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [
    ["npm", ["run", "check", "--silent"]],
    ["npm", ["run", "test:tui", "--silent"]],
    ["npm", ["run", "test:contracts", "--silent"]],
  ]);
  assert.equal(result.checks.length, 3);
  assert.equal(result.checks[1]?.name, "test:tui");
  assert.equal(result.checks[2]?.name, "test:contracts");
});

test("runWorkspaceGuardianChecks treats shared tui controller contracts as both contract and tui impact", async () => {
  const execCalls = [];
  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["check", "test"],
      changedFiles: ["packages/contracts/src/tui.ts"],
    },
    {
      readFile: async () =>
        JSON.stringify({
          scripts: {
            check: "tsc -p tsconfig.check.json --noEmit",
            "test:tui": "node --conditions=source --import tsx --test tests/tui/*.test.mjs",
            "test:contracts": "node --conditions=source --import tsx --test tests/contracts/*.test.mjs tests/contracts/*.test.ts",
          },
        }),
      execFile: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(execCalls, [
    ["npm", ["run", "check", "--silent"]],
    ["npm", ["run", "test:contracts", "--silent"]],
    ["npm", ["run", "test:tui", "--silent"]],
  ]);
  assert.equal(result.checks.length, 3);
  assert.equal(result.checks[1]?.name, "test:contracts");
  assert.equal(result.checks[2]?.name, "test:tui");
});

test("runWorkspaceGuardianChecks hands its abort signal to every script it runs", async () => {
  const controller = new AbortController();
  const seenSignals = [];

  const result = await runWorkspaceGuardianChecks(
    {
      cwd: "/repo",
      env: {},
      scripts: ["lint", "check"],
      signal: controller.signal,
    },
    {
      readFile: async () => JSON.stringify({ scripts: { lint: "biome check .", check: "tsc" } }),
      execFile: async (_command, _args, options) => {
        seenSignals.push(options.signal);
        return { stdout: "", stderr: "" };
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(seenSignals, [controller.signal, controller.signal]);
  assert.equal(result.checks.length, 2);
});

test("an aborted guardian check propagates instead of being recorded as a failure", async () => {
  const controller = new AbortController();
  const execCalls = [];

  // One script, so nothing but the catch itself can stop the abort becoming a
  // FAIL entry in the returned summary.
  await assert.rejects(
    runWorkspaceGuardianChecks(
      {
        cwd: "/repo",
        env: {},
        scripts: ["lint"],
        signal: controller.signal,
      },
      {
        readFile: async () => JSON.stringify({ scripts: { lint: "biome check ." } }),
        execFile: async (_command, args) => {
          execCalls.push(args[1]);
          // A real child process dies with the signal; mirror that here.
          controller.abort();
          const error = new Error("child aborted");
          error.name = "AbortError";
          throw error;
        },
        platform: "darwin",
      },
    ),
    (error) => error === controller.signal.reason,
    "an abort is not a check failure and must not be summarised as one",
  );

  assert.deepEqual(execCalls, ["lint"]);
});

test("runWorkspaceGuardianChecks refuses to start once its signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const execCalls = [];
  let readCalls = 0;

  await assert.rejects(
    runWorkspaceGuardianChecks(
      {
        cwd: "/repo",
        env: {},
        scripts: ["lint"],
        signal: controller.signal,
      },
      {
        readFile: async () => {
          readCalls += 1;
          return JSON.stringify({ scripts: { lint: "biome check ." } });
        },
        execFile: async (_command, args) => {
          execCalls.push(args[1]);
          return { stdout: "", stderr: "" };
        },
        platform: "darwin",
      },
    ),
    (error) => error.name === "AbortError",
  );

  assert.deepEqual(execCalls, [], "no script runs for an already-cancelled turn");
  assert.equal(readCalls, 0, "a cancelled turn does not even read the workspace manifest");
});

/** LSP checks resolve real paths, so these need a workspace on disk. */
function createLspWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "uc-guardian-lsp-"));
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: {} }));
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "a.ts"), "const a = 1;\n");
  writeFileSync(join(workspace, "src", "b.ts"), "const b = 2;\n");
  return workspace;
}

const LSP_DEPS = {
  readFile: async () => "const ok = true;\n",
  execFile: async () => ({ stdout: "", stderr: "" }),
  platform: "darwin",
};

test("the guardian signal reaches every LSP diagnostic check", async () => {
  const workspace = createLspWorkspace();
  const controller = new AbortController();
  const lspCalls = [];
  try {
    const result = await runWorkspaceGuardianChecks(
      {
        cwd: workspace,
        env: {},
        scripts: [],
        changedFiles: ["src/a.ts", "src/b.ts"],
        signal: controller.signal,
        lspBridge: {
          async checkAfterEdit(input) {
            lspCalls.push(input);
            return { status: "pass", summary: "clean" };
          },
        },
      },
      LSP_DEPS,
    );

    assert.deepEqual(lspCalls.map((call) => call.path), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(
      lspCalls.map((call) => call.options?.signal),
      [controller.signal, controller.signal],
    );
    assert.deepEqual(result.checks.map((check) => check.name), ["lsp:src/a.ts", "lsp:src/b.ts"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an aborted LSP check propagates instead of being recorded as unavailable", async () => {
  const workspace = createLspWorkspace();
  const controller = new AbortController();
  const lspCalls = [];
  try {
    await assert.rejects(
      runWorkspaceGuardianChecks(
        {
          cwd: workspace,
          env: {},
          scripts: [],
          changedFiles: ["src/a.ts", "src/b.ts"],
          signal: controller.signal,
          lspBridge: {
            async checkAfterEdit(input) {
              lspCalls.push(input.path);
              controller.abort();
              const error = new Error("lsp aborted");
              error.name = "AbortError";
              throw error;
            },
          },
        },
        LSP_DEPS,
      ),
      (error) => error === controller.signal.reason,
      "a cancelled diagnostic is not an UNAVAILABLE verdict",
    );

    assert.deepEqual(lspCalls, ["src/a.ts"], "the remaining files are never diagnosed");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a signal-deaf LSP bridge still cannot diagnose past a cancellation", async () => {
  const workspace = createLspWorkspace();
  const controller = new AbortController();
  const lspCalls = [];
  try {
    await assert.rejects(
      runWorkspaceGuardianChecks(
        {
          cwd: workspace,
          env: {},
          scripts: [],
          changedFiles: ["src/a.ts", "src/b.ts"],
          signal: controller.signal,
          lspBridge: {
            async checkAfterEdit(input) {
              lspCalls.push(input.path);
              // Ignores the signal entirely and returns a clean verdict.
              controller.abort();
              return { status: "pass", summary: "clean" };
            },
          },
        },
        LSP_DEPS,
      ),
      (error) => error.name === "AbortError",
    );

    assert.deepEqual(lspCalls, ["src/a.ts"], "the loop stops before the next file");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an already-cancelled turn runs no LSP diagnostics at all", async () => {
  const workspace = createLspWorkspace();
  const controller = new AbortController();
  controller.abort();
  const lspCalls = [];
  try {
    await assert.rejects(
      runWorkspaceGuardianChecks(
        {
          cwd: workspace,
          env: {},
          scripts: [],
          changedFiles: ["src/a.ts"],
          signal: controller.signal,
          lspBridge: {
            async checkAfterEdit(input) {
              lspCalls.push(input.path);
              return { status: "pass", summary: "clean" };
            },
          },
        },
        LSP_DEPS,
      ),
      (error) => error.name === "AbortError",
    );

    assert.deepEqual(lspCalls, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a script failure racing an abort reports the abort, not the failure", async () => {
  const controller = new AbortController();

  await assert.rejects(
    runWorkspaceGuardianChecks(
      {
        cwd: "/repo",
        env: {},
        scripts: ["lint"],
        signal: controller.signal,
      },
      {
        readFile: async () => JSON.stringify({ scripts: { lint: "biome check ." } }),
        execFile: async () => {
          controller.abort();
          const error = new Error("Command failed");
          error.stdout = "";
          error.stderr = "exit 1";
          throw error;
        },
        platform: "darwin",
      },
    ),
    (error) => error === controller.signal.reason,
    "a cancelled script is never recorded as FAIL, and never reports the racing error",
  );
});

test("an abort during changed-file prework emits no diagnostic", async () => {
  const workspace = createLspWorkspace();
  const controller = new AbortController();
  const lspCalls = [];
  try {
    await assert.rejects(
      runWorkspaceGuardianChecks(
        {
          cwd: workspace,
          env: {},
          scripts: [],
          changedFiles: ["src/a.ts"],
          signal: controller.signal,
          lspBridge: {
            async checkAfterEdit(input) {
              lspCalls.push(input.path);
              return { status: "pass", summary: "clean" };
            },
          },
        },
        {
          ...LSP_DEPS,
          readFile: async (path) => {
            if (path.endsWith("package.json")) {
              return JSON.stringify({ scripts: {} });
            }
            // The turn is cleared while the changed file itself is being read.
            controller.abort();
            return "const ok = true;\n";
          },
        },
      ),
      (error) => error === controller.signal.reason,
    );

    assert.deepEqual(lspCalls, [], "no diagnostic starts after the read boundary aborts");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a signal-deaf bridge resolving after abort on the last file records nothing", async () => {
  const workspace = createLspWorkspace();
  const controller = new AbortController();
  try {
    await assert.rejects(
      runWorkspaceGuardianChecks(
        {
          cwd: workspace,
          env: {},
          scripts: [],
          // A single file: only a post-result check can stop this.
          changedFiles: ["src/a.ts"],
          signal: controller.signal,
          lspBridge: {
            async checkAfterEdit() {
              controller.abort();
              return { status: "pass", summary: "clean" };
            },
          },
        },
        LSP_DEPS,
      ),
      (error) => error === controller.signal.reason,
      "a verdict produced after cancellation is discarded, not returned",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an abort during path resolution never starts the changed-file read", async () => {
  const workspace = createLspWorkspace();
  const controller = new AbortController();
  let readCalls = 0;
  const lspCalls = [];
  try {
    const pending = runLspGuardianChecks({
      cwd: workspace,
      readFile: async () => {
        readCalls += 1;
        return "const ok = true;\n";
      },
      changedFiles: ["src/a.ts"],
      lspBridge: {
        async checkAfterEdit(input) {
          lspCalls.push(input.path);
          return { status: "pass", summary: "clean" };
        },
      },
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(pending, (error) => error === controller.signal.reason);
    assert.equal(readCalls, 0, "a cleared turn never starts changed-file IO after path resolution");
    assert.deepEqual(lspCalls, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a real LSP failure is still reported rather than propagated", async () => {
  const workspace = createLspWorkspace();
  try {
    const result = await runWorkspaceGuardianChecks(
      {
        cwd: workspace,
        env: {},
        scripts: [],
        changedFiles: ["src/a.ts"],
        signal: new AbortController().signal,
        lspBridge: {
          async checkAfterEdit() {
            throw new Error("language server missing");
          },
        },
      },
      LSP_DEPS,
    );

    assert.equal(result.checks[0]?.status, "failed");
    assert.match(result.summary, /lsp:src\/a\.ts UNAVAILABLE · language server missing/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
