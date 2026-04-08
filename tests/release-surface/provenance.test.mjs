import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_PROVENANCE_SUBSYSTEMS,
  validateProvenanceManifest,
} from "../../apps/unclecode-cli/src/provenance.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const manifestPath = path.join(workspaceRoot, "docs", "provenance", "manifest.json");

test("release provenance manifest covers every required subsystem", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const validated = validateProvenanceManifest(manifest);

  assert.deepEqual(
    Object.keys(validated.subsystems).sort(),
    [...REQUIRED_PROVENANCE_SUBSYSTEMS].sort(),
  );
  assert.equal(validated.product.name, "UncleCode");
});

test("release provenance validation rejects omitted subsystem entries", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const brokenSubsystems = { ...manifest.subsystems };
  delete brokenSubsystems.tui;

  assert.throws(
    () =>
      validateProvenanceManifest({
        ...manifest,
        subsystems: brokenSubsystems,
      }),
    /Missing provenance entries: tui/i,
  );
});
