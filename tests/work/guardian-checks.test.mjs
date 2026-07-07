import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runWorkspaceGuardianChecks } from "../../apps/unclecode-cli/src/guardian-checks.ts";

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
