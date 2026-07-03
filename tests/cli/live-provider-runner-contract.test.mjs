import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

test("live provider QA uses the shared bounded command runner", () => {
  const script = readFileSync(
    path.join(workspaceRoot, "scripts", "unclecode-live-provider-qa.mjs"),
    "utf8",
  );

  assert.match(script, /from "\.\/health-qa\/runner\.mjs"/);
  assert.match(script, /runCommand\(process\.execPath/);
  assert.doesNotMatch(script, /node:child_process/);
  assert.doesNotMatch(script, /child\.on\("error"/);
});
