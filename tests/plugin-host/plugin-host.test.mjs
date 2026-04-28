import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginHost, discoverPluginNames } from "@unclecode/plugin-host";

test("PluginHost dispatches lifecycle events to registered hooks", async () => {
  const host = new PluginHost();
  const calls = [];
  host.register("audit", {
    async toolExecuteBefore(event) {
      calls.push(`before:${event.toolName}`);
    },
    async toolExecuteAfter(event) {
      calls.push(`after:${event.toolName}:${event.isError ? "err" : "ok"}`);
    },
    async runCompleted(event) {
      calls.push(`done:${event.runId}:${event.status}`);
    },
  });
  await host.dispatchToolExecuteBefore({ toolName: "write_file", input: {} });
  await host.dispatchToolExecuteAfter({ toolName: "write_file", output: "ok", isError: false });
  await host.dispatchRunCompleted({ runId: "tr_x", status: "accepted" });
  assert.deepEqual(calls, ["before:write_file", "after:write_file:ok", "done:tr_x:accepted"]);
});

test("PluginHost.loadEntries instantiates plugin entries via context", async () => {
  const host = new PluginHost();
  const seen = [];
  await host.loadEntries(process.cwd(), [
    {
      name: "tracker",
      async entry(ctx) {
        seen.push(ctx.workspaceRoot);
        return {
          toolExecuteAfter: () => seen.push("after"),
        };
      },
    },
  ]);
  assert.equal(seen.length, 1);
  assert.equal(host.list().length, 1);
});

test("discoverPluginNames lists ts/mjs files in .unclecode/plugins", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-plugins-"));
  try {
    const pluginsDir = join(dir, ".unclecode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "alpha.ts"), "export default () => ({})");
    writeFileSync(join(pluginsDir, "beta.mjs"), "export default () => ({})");
    writeFileSync(join(pluginsDir, "gamma.txt"), "ignored");
    const names = discoverPluginNames(dir);
    assert.deepEqual(names.sort(), ["alpha", "beta"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
