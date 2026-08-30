#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const launcherPath = fs.realpathSync(__filename);
const repoRoot = path.resolve(path.dirname(launcherPath), "..");
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

const cargoManifest = path.join(repoRoot, "Cargo.toml");
if (fs.existsSync(cargoManifest)) {
  process.stderr.write(
    `UncleCode Rust CLI binary was not found under "${repoRoot}".\n`
      + `Build it with \`cargo build --manifest-path "${cargoManifest}" -p unclecode\`.\n`,
  );
} else {
  process.stderr.write(
    `This UncleCode installation is missing its Rust CLI binary under "${repoRoot}". `
      + "Reinstall UncleCode.\n",
  );
}
process.exit(1);
