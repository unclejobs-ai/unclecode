import assert from "node:assert/strict";
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
