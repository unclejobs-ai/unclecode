#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const entrypoint = path.join(repoRoot, "apps/unclecode-cli/dist/index.js");
const workEntrypoint = path.join(
  repoRoot,
  "dist-work/apps/unclecode-cli/src/work-entry.js",
);

if (!fs.existsSync(entrypoint) || !fs.existsSync(workEntrypoint)) {
  process.stderr.write("UncleCode is not built yet. Run `npm run build` first.\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, [entrypoint, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 0);
