#!/usr/bin/env node

import { resolve } from "node:path";

import { planSccV3Import } from "@unclecode/orchestrator";

function usage() {
  return [
    "Usage: node scripts/scc-v3-import-dry-run.mjs [options]",
    "",
    "Options:",
    "  --source <path>     SCC v3 .data directory (default: <cwd>/.data)",
    "  --workspace <path>  UncleCode workspace target (default: cwd)",
    "  --json              Print the complete machine-readable plan",
    "  --help              Show this help",
    "",
    "This command is dry-run only. It never writes session, agentops, artifact, or source files.",
  ].join("\n");
}

function parseArgs(argv) {
  let sourceRoot = resolve(".data");
  let workspaceRoot = resolve(".");
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--apply") {
      throw new Error(
        "--apply is not supported. SCC v3 migration is intentionally dry-run only.",
      );
    }
    if (argument === "--source" || argument === "--workspace") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a path.`);
      index += 1;
      if (argument === "--source") sourceRoot = resolve(value);
      else workspaceRoot = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, sourceRoot, workspaceRoot, json };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const report = await planSccV3Import({
      sourceRoot: options.sourceRoot,
      workspaceRoot: options.workspaceRoot,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${[
          "SCC v3 → UncleCode migration plan (dry-run)",
          `Source unchanged: ${report.sourceUnchanged ? "yes" : "NO"}`,
          `Receipt: ${report.receipt.idempotencyKey}`,
          `Scanned: ${report.scanned.files} files, ${report.scanned.bytes} bytes`,
          `Runs: ${report.runs.length}`,
          `Artifacts planned: ${report.runs.reduce((total, run) => total + run.artifacts.length, 0)}`,
          `Warnings: ${report.warnings.length}`,
          "No files or database records were written.",
        ].join("\n")}\n`,
      );
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`SCC v3 dry-run failed: ${message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
