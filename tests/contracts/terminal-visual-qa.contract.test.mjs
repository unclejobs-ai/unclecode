import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

test("terminal visual QA helper writes transcript, HTML, and metadata bundle", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-terminal-qa-"));
  const sourceFile = path.join(tempDir, "frame.txt");
  const evidenceDir = path.join(tempDir, "evidence");
  writeFileSync(
    sourceFile,
    "\u001b[32mRun activity\u001b[39m\nNo saved sessions yet\nPress W\n",
  );

  const { stdout } = await execFileAsync(process.execPath, [
    path.join(workspaceRoot, "scripts/qa/web-terminal-visual-qa.mjs"),
    "--title",
    "dashboard-empty-states",
    "--from-file",
    sourceFile,
    "--evidence-dir",
    evidenceDir,
  ]);
  const result = JSON.parse(stdout);

  assert.equal(result.title, "dashboard-empty-states");
  assert.ok(existsSync(path.join(evidenceDir, "metadata.json")));
  assert.ok(existsSync(path.join(evidenceDir, "terminal.txt")));
  assert.ok(existsSync(path.join(evidenceDir, "terminal.html")));
  assert.equal(
    readFileSync(path.join(evidenceDir, "terminal.txt"), "utf8"),
    "Run activity\nNo saved sessions yet\nPress W\n",
  );
  assert.match(
    readFileSync(path.join(evidenceDir, "terminal.html"), "utf8"),
    /UncleCode terminal visual QA/,
  );
});
