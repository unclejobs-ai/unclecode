import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../../scripts/runtime-qa/cli-helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

test("runtime QA helper uses the shared bounded command runner", () => {
  const helper = readFileSync(
    path.join(workspaceRoot, "scripts", "runtime-qa", "cli-helpers.mjs"),
    "utf8",
  );

  assert.match(helper, /from "\.\.\/health-qa\/runner\.mjs"/);
  assert.doesNotMatch(helper, /node:child_process/);
  assert.doesNotMatch(helper, /child\.on\("error"/);
});

test("runtime QA helper reports spawn failures as failed results when allowed", async () => {
  const result = await run(
    "__unclecode_missing_runtime_command__",
    [],
    process.env,
    { allowFailure: true, timeoutMs: 1_000, killGraceMs: 50 },
  );

  assert.notEqual(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /__unclecode_missing_runtime_command__/);
});

test("runtime QA helper terminates timed-out children when failure is allowed", async () => {
  const result = await run(
    process.execPath,
    ["-e", "setTimeout(() => {}, 250)"],
    process.env,
    { allowFailure: true, timeoutMs: 30, killGraceMs: 30 },
  );

  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.equal(result.timeoutMs, 30);
});
