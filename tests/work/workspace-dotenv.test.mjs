import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig } from "@unclecode/orchestrator";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const orchestratorEntry = pathToFileURL(path.join(repoRoot, "packages/orchestrator/src/index.ts")).href;

test("importing the orchestrator does not load the cwd .env into process.env", () => {
  // The module used to call dotenv at import: a `work` launched in one repo put
  // that repo's (stale) keys into process.env, the runtime owner inherited them,
  // and every later session in any directory resolved three review providers
  // and crashed on a held-out suite that only exists in that repo.
  const workspace = mkdtempSync(path.join(tmpdir(), "unclecode-dotenv-import-"));
  try {
    writeFileSync(path.join(workspace, ".env"), "UNCLECODE_DOTENV_PROBE_API_KEY=from-dotenv\n");
    const seen = execFileSync(process.execPath, [
      "--conditions=source",
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(orchestratorEntry)}); process.stdout.write(String(process.env.UNCLECODE_DOTENV_PROBE_API_KEY));`,
    ], { cwd: workspace, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8" });
    assert.equal(seen, "undefined");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a workspace .env key still configures that workspace's provider, without touching process.env", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "unclecode-dotenv-config-"));
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    writeFileSync(path.join(workspace, ".env"), "DEEPSEEK_API_KEY=\"workspace-secret\"\n");
    const config = await loadConfig({ cwd: workspace, provider: "deepseek", model: "deepseek-chat" });
    assert.equal(config.apiKey, "workspace-secret");
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  } finally {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
    rmSync(workspace, { recursive: true, force: true });
  }
});
