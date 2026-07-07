import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { explainUncleCodeConfig } from "@unclecode/config-core";

const tempDirs = [];

function makeFixture(prefix) {
  const root = join(tmpdir(), `unclecode-crp-resolver-${prefix}-${process.pid}-${tempDirs.length}`);
  const workspaceRoot = join(root, "workspace");
  const userHomeDir = join(root, "home");
  tempDirs.push(root);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHomeDir, { recursive: true });
  return { root, workspaceRoot, userHomeDir };
}

function writeConfig(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CRP config defaults to enabled with the default budget", () => {
  const { workspaceRoot, userHomeDir } = makeFixture("default");
  const explanation = explainUncleCodeConfig({ workspaceRoot, userHomeDir });

  assert.equal(explanation.settings.crp.value, true);
  assert.equal(explanation.settings.crpBudget.value, 32000);
  assert.equal(explanation.settings.crp.winner.sourceId, "built-in-defaults");
  assert.equal(explanation.settings.crpBudget.winner.sourceId, "built-in-defaults");
});

test("CRP config follows user-over-project precedence from config-core", () => {
  const { workspaceRoot, userHomeDir } = makeFixture("config");
  writeConfig(join(workspaceRoot, ".unclecode", "config.json"), {
    context: {
      crp: false,
      crpBudget: 8000,
    },
  });
  writeConfig(join(userHomeDir, ".unclecode", "config.json"), {
    context: {
      crp: true,
      crpBudget: 16000,
    },
  });

  const explanation = explainUncleCodeConfig({ workspaceRoot, userHomeDir });

  assert.equal(explanation.settings.crp.value, true);
  assert.equal(explanation.settings.crp.winner.sourceId, "user-config");
  assert.equal(explanation.settings.crpBudget.value, 16000);
  assert.equal(explanation.settings.crpBudget.winner.sourceId, "user-config");
});

test("CRP config lets environment override file config", () => {
  const { workspaceRoot, userHomeDir } = makeFixture("env");
  writeConfig(join(userHomeDir, ".unclecode", "config.json"), {
    context: {
      crp: true,
      crpBudget: 16000,
    },
  });

  const explanation = explainUncleCodeConfig({
    workspaceRoot,
    userHomeDir,
    env: {
      UNCLECODE_CRP: "0",
      UNCLECODE_CRP_BUDGET: "24000",
    },
  });

  assert.equal(explanation.settings.crp.value, false);
  assert.equal(explanation.settings.crp.winner.sourceId, "environment");
  assert.equal(explanation.settings.crpBudget.value, 24000);
  assert.equal(explanation.settings.crpBudget.winner.sourceId, "environment");
});

test("CRP config reports invalid context values and falls back to defaults", () => {
  const { workspaceRoot, userHomeDir } = makeFixture("invalid");
  writeConfig(join(workspaceRoot, ".unclecode", "config.json"), {
    context: {
      crp: "no",
      crpBudget: -1,
    },
  });

  const explanation = explainUncleCodeConfig({ workspaceRoot, userHomeDir });

  assert.equal(explanation.settings.crp.value, true);
  assert.equal(explanation.settings.crpBudget.value, 32000);
  assert.ok(explanation.sourceIssues.some((issue) => issue.message === "Invalid context.crp value."));
  assert.ok(explanation.sourceIssues.some((issue) => issue.message === "Invalid context.crpBudget value."));
});
