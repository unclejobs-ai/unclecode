import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isRustEntrypointStale } from "../../packages/orchestrator/src/index.ts";

test("isRustEntrypointStale detects source changes newer than target binary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-rust-entrypoint-"));
  const rustSource = path.join(root, "rust", "unclecode-core", "src");
  const targetDir = path.join(root, "target", "debug");
  mkdirSync(rustSource, { recursive: true });
  mkdirSync(targetDir, { recursive: true });

  const binary = path.join(targetDir, "unclecode");
  writeFileSync(path.join(root, "Cargo.toml"), "[workspace]\n");
  writeFileSync(path.join(root, "Cargo.lock"), "# lock\n");
  writeFileSync(path.join(rustSource, "lib.rs"), "pub fn old() {}\n");
  writeFileSync(binary, "#!/bin/sh\n");

  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const newTime = new Date("2026-01-02T00:00:00.000Z");
  utimesSync(binary, oldTime, oldTime);
  utimesSync(path.join(rustSource, "lib.rs"), newTime, newTime);

  assert.equal(isRustEntrypointStale(root, binary), true);
});
