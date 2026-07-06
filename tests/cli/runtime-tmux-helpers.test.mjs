import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { lowerBusyActivityRowPattern, runtimeTmuxArgs } from "../../scripts/runtime-qa/tmux-helpers.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("busy activity detector matches whitespace-prefixed spinner rows", () => {
  const genericPattern = lowerBusyActivityRowPattern();
  const detailedPattern = lowerBusyActivityRowPattern("thinking");

  assert.match("\n  ◜ thinking", genericPattern);
  assert.match("\n\t◠ thinking", detailedPattern);
  assert.doesNotMatch("\nstatus: thinking", genericPattern);
});

test("runtime QA tmux commands use an isolated socket", () => {
  const args = runtimeTmuxArgs(["new-session", "-d", "-s", "qa"]);

  assert.deepEqual(args.slice(0, 2), ["-L", `unclecode-runtime-qa-${process.pid}`]);
  assert.deepEqual(args.slice(2), ["new-session", "-d", "-s", "qa"]);
});

test("runtime QA smokes route tmux calls through the isolated helper", () => {
  const runtimeQaDirectory = path.join(workspaceRoot, "scripts", "runtime-qa");
  const smokeFiles = readdirSync(runtimeQaDirectory)
    .filter((fileName) => fileName.endsWith(".mjs") && fileName !== "tmux-helpers.mjs");

  for (const fileName of smokeFiles) {
    const source = readFileSync(path.join(runtimeQaDirectory, fileName), "utf8");
    assert.doesNotMatch(source, /run\("tmux"/, `${fileName} should use runTmux`);
  }
});
