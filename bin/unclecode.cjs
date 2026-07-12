#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const rustEntrypoints = [
  path.join(repoRoot, "target", "release", "unclecode"),
  path.join(repoRoot, "target", "debug", "unclecode"),
];

const rustEntrypoint = process.env.UNCLECODE_DISABLE_RUST_BRIDGE
  ? undefined
  : newestExistingRustEntrypoint(rustEntrypoints);

function newestExistingRustEntrypoint(candidates) {
  return candidates
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .at(0)?.candidate;
}

if (rustEntrypoint) {
  const result = spawnSync(rustEntrypoint, process.argv.slice(2), {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      UNCLECODE_NODE: process.env.UNCLECODE_NODE || process.execPath,
    },
  });
  process.exit(result.status ?? 0);
}

process.stderr.write(
  "UncleCode Rust CLI is not built yet. Run `cargo build -p unclecode`.\n",
);
process.exit(1);
