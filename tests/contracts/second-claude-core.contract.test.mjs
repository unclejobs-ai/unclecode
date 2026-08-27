import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vendorTarball = path.join(
  workspaceRoot,
  "vendor/second-claude/second-claude-core-4.0.0.tgz",
);
const expectedSha256 =
  "607e335bfdb24ef11068088b23e927488bfd7c09ee2fde37a8b38dd9ce64c3a1";

test("the installed SCC core is the reviewed vendored release and passes its shared fixture", async () => {
  assert.equal(
    existsSync(vendorTarball),
    true,
    "the reviewed SCC core release must be vendored before it can be installed",
  );
  assert.equal(
    createHash("sha256").update(readFileSync(vendorTarball)).digest("hex"),
    expectedSha256,
  );

  const packageJson = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.dependencies?.["@second-claude/core"],
    "file:vendor/second-claude/second-claude-core-4.0.0.tgz",
  );

  const core = await import("@second-claude/core");
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../node_modules/@second-claude/core/fixtures/quality-contract.json", import.meta.url),
      "utf8",
    ),
  );
  const operations = {
    evaluateGate: (input) => core.evaluateGate(input),
    validateEvidence: (input) => core.validateEvidence(input.evidence, input.context),
    validateEvolutionProposal: (input) =>
      core.validateEvolutionProposal(input.proposal, input.context),
    validatePlan: (input) => core.validatePlan(input),
    validateRunCompletion: (input) =>
      core.validateRunCompletion(input.run, input.evidence, input.context),
  };

  for (const fixtureCase of fixture.cases) {
    const operation = operations[fixtureCase.operation];
    assert.equal(typeof operation, "function", `unknown fixture operation ${fixtureCase.operation}`);
    const actual = operation(fixtureCase.input);
    assert.deepEqual(
      typeof actual === "object" && actual !== null && "issues" in actual
        ? actual.issues.map((issue) => issue.code)
        : actual,
      fixtureCase.expected,
      fixtureCase.id,
    );
  }
});
