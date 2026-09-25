import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as orchestrator from "@unclecode/orchestrator";
import { PluginHost, registerBuiltInSccQualityEngine } from "@unclecode/plugin-host";

const supportedReasoning = {
  effort: "medium",
  source: "mode-default",
  support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
};

// Runs one direct turn whose agent reports `calls` as tool traces; returns the quality status.
async function directTurnStatus(calls) {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-direct-readonly-"));
  let listener;
  try {
    writeFileSync(path.join(workspace, ".gitignore"), ".unclecode/\n");
    writeFileSync(path.join(workspace, "a.txt"), "one\ntwo\n");
    execFileSync("git", ["init", "--initial-branch=main", workspace], { stdio: "ignore" });
    execFileSync("git", ["-C", workspace, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", workspace, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-m", "base"], { stdio: "ignore" });
    const host = new PluginHost();
    await registerBuiltInSccQualityEngine(host, { workspaceRoot: workspace });
    const agent = new orchestrator.WorkAgent({
      directAgent: {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener(next) { listener = next; },
        async runTurn() {
          for (const [toolName, input] of calls) {
            listener?.({ type: "tool.started", toolName, input });
            listener?.({ type: "tool.completed", toolName, input });
          }
          return { text: "answer" };
        },
      },
      mode: "default",
      reasoning: supportedReasoning,
      model: "gpt-5.4",
      workspaceRoot: workspace,
      pluginHost: host,
    });
    return (await agent.runTurn("hello")).qualityStatus;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const shell = (command) => [["run_shell", { command }]];

test("read-only inspection commands keep the direct evidence path", async () => {
  for (const command of [
    "wc -l a.txt",
    "wc -l data-*.txt",
    "cat a.txt",
    "head -n 5 a.txt",
    "tail -3 a.txt",
    "ls -la",
    "rg -n one .",
    "grep -c one a.txt",
    "find . -name '*.txt'",
  ]) {
    assert.equal(await directTurnStatus(shell(command)), "proceed", command);
  }
});

test("mutating or command-running forms still need a baseline", async () => {
  for (const command of [
    "wc -l a.txt | tail -1",
    "cat a.txt > b.txt",
    "find . -name '*.txt' -delete",
    "find . -type f -fprint out.txt",
    "rg --pre=./script one .",
    "sort -o a.txt a.txt",
    "ls $(pwd)",
  ]) {
    assert.equal(await directTurnStatus(shell(command)), "block", command);
  }
});

test("run_code is judged by the calls it makes", async () => {
  assert.equal(await directTurnStatus([["run_code", { code: "…" }], ["read_file", { path: "a.txt" }]]), "proceed");
  assert.equal(await directTurnStatus([["run_code", { code: "…" }], ["write_file", { path: "a.txt" }]]), "block");
});
