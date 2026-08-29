import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const vendorTarball = path.join(
  workspaceRoot,
  "vendor/second-claude/second-claude-core-4.0.0.tgz",
);
const expectedSha256 =
  "a541566920e0326d66dd2204cb3331d717e73f64da60608b879bfd5f9c8673d7";

function readTarballEntry(tarball, expectedPath) {
  const archive = gunzipSync(readFileSync(tarball));
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name.length === 0) break;
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/s, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    assert.equal(
      Number.isSafeInteger(size),
      true,
      `invalid tar entry size for ${name}`,
    );
    const contentOffset = offset + 512;
    if (name === expectedPath) {
      return archive.subarray(contentOffset, contentOffset + size);
    }
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  assert.fail(`vendored release is missing ${expectedPath}`);
}

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

  const packageJson = JSON.parse(
    readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.dependencies?.["@second-claude/core"],
    "file:vendor/second-claude/second-claude-core-4.0.0.tgz",
  );

  const installedRoot = path.join(
    workspaceRoot,
    "node_modules/@second-claude/core",
  );
  for (const relativePath of [
    "dist/index.js",
    "fixtures/quality-contract.json",
  ]) {
    assert.deepEqual(
      readFileSync(path.join(installedRoot, relativePath)),
      readTarballEntry(vendorTarball, `package/${relativePath}`),
      `installed @second-claude/core ${relativePath} must match the vendored release`,
    );
  }

  const core = await import("@second-claude/core");
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../node_modules/@second-claude/core/fixtures/quality-contract.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const warningGate = fixture.cases.find(
    (fixtureCase) => fixtureCase.id === "warning-reviewer-does-not-prove-gate",
  );
  assert.ok(warningGate, "installed-warning-gate fixture must be present");
  assert.equal(
    core.evaluateGate(warningGate.input),
    "unproven",
    "installed-warning-gate must not proceed",
  );
  const operations = {
    evaluateGate: (input) => core.evaluateGate(input),
    validateEvidence: (input) =>
      core.validateEvidence(input.evidence, input.context),
    validateEvolutionProposal: (input) =>
      core.validateEvolutionProposal(input.proposal, input.context),
    validatePlan: (input) => core.validatePlan(input),
    validateRunCompletion: (input) =>
      core.validateRunCompletion(input.run, input.evidence, input.context),
  };

  for (const fixtureCase of fixture.cases) {
    const operation = operations[fixtureCase.operation];
    assert.equal(
      typeof operation,
      "function",
      `unknown fixture operation ${fixtureCase.operation}`,
    );
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
