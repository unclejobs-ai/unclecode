#!/usr/bin/env node
/**
 * Hermes operator entry — accepts a JSON payload (matching
 * references/hermes/examples/team-{coder,builder}.json) and dispatches to
 * `unclecode team run`. Hermes uses this script as a thin wrapper so its
 * Operations log + skill metadata stay consistent across hosts.
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

function usage() {
  process.stderr.write("usage: hermes-team-run.mjs run <json-payload>\n");
  process.exitCode = 2;
}

async function main() {
  const [command, payloadRaw] = process.argv.slice(2);
  if (command !== "run" || !payloadRaw) {
    usage();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (error) {
    process.stderr.write(`Invalid JSON payload: ${(error && error.message) || error}\n`);
    process.exitCode = 2;
    return;
  }

  const task = typeof payload.task === "string" ? payload.task.trim() : "";
  const persona = typeof payload.persona === "string" ? payload.persona : "coder";
  const lanes = String(payload.lanes ?? 1);
  const gate = typeof payload.gate === "string" ? payload.gate : "strict";
  const runtime = typeof payload.runtime === "string" ? payload.runtime : "local";

  if (!task) {
    process.stderr.write("Payload missing required `task` field.\n");
    process.exitCode = 2;
    return;
  }

  const repoRoot = resolve(import.meta.dirname ?? ".", "..");
  const cliBin = join(repoRoot, "bin", "unclecode.cjs");
  if (!existsSync(cliBin)) {
    process.stderr.write(`Could not locate unclecode binary at ${cliBin}\n`);
    process.exitCode = 1;
    return;
  }

  const args = [
    "team",
    "run",
    task,
    "--persona",
    persona,
    "--lanes",
    lanes,
    "--gate",
    gate,
    "--runtime",
    runtime,
  ];

  const child = spawn(cliBin, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      HERMES_PAYLOAD: payloadRaw,
    },
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  process.stderr.write(`hermes-team-run failed: ${(error && error.message) || error}\n`);
  process.exitCode = 1;
});
