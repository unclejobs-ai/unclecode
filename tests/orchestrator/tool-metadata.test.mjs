import assert from "node:assert/strict";
import test from "node:test";

import {
  TEAM_DEFAULT_TOOLS,
  formatToolDefinitionLine,
  runRustCommandSync,
  toolDefinitions,
} from "@unclecode/orchestrator";

function byName(tools) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("runtime ACI tools declare risk and resource metadata", () => {
  const tools = byName(toolDefinitions);

  assert.equal(tools.get("read_file")?.metadata?.annotations.readOnlyHint, true);
  assert.equal(tools.get("read_file")?.metadata?.resources[0]?.template, "file:{path}");

  assert.equal(tools.get("write_file")?.metadata?.annotations.destructiveHint, true);
  assert.equal(tools.get("write_file")?.metadata?.annotations.riskLevel, "high");
  assert.equal(tools.get("write_file")?.metadata?.resources[0]?.mode, "write");

  assert.equal(tools.get("delete_file")?.metadata?.annotations.idempotentHint, false);
  assert.equal(tools.get("delete_file")?.metadata?.resources[0]?.mode, "delete");

  assert.equal(tools.get("run_shell")?.metadata?.annotations.openWorldHint, true);
  assert.equal(tools.get("run_shell")?.metadata?.resources[0]?.declared, false);
});

test("team mini-loop tools expose the same OpenHands-style metadata surface", () => {
  const tools = byName(TEAM_DEFAULT_TOOLS);

  assert.equal(tools.get("read_file")?.metadata?.resources[0]?.template, "file:{path}");
  assert.equal(tools.get("search_text")?.metadata?.resources[0]?.template, "workspace:{path:-.}");
  assert.equal(tools.get("apply_patch")?.metadata?.annotations.requiresConfirmation, true);
  assert.equal(tools.get("apply_patch")?.metadata?.resources[0]?.declared, true);
  assert.equal(tools.get("apply_patch")?.metadata?.resources[0]?.resolver, "apply-patch-files");
});

test("provider tool schema conversion strips local metadata before model API payloads", () => {
  const raw = runRustCommandSync(
    ["rust", "provider", "openai-chat-tools"],
    process.cwd(),
    JSON.stringify(toolDefinitions),
  );
  const converted = JSON.parse(raw);
  const readFile = converted.find((tool) => tool.function?.name === "read_file");

  assert.ok(readFile);
  assert.equal(readFile.function.metadata, undefined);
  assert.equal(readFile.function.parameters.metadata, undefined);
});

test("tool definition formatter surfaces risk and resource hints for /tools", () => {
  const tools = byName(toolDefinitions);
  const readLine = formatToolDefinitionLine(tools.get("read_file"));
  const shellLine = formatToolDefinitionLine(tools.get("run_shell"));

  assert.match(readLine, /risk low/);
  assert.match(readLine, /resources read file:\{path\}/);
  assert.match(shellLine, /risk unknown/);
  assert.match(shellLine, /execute shell:\* \(opaque\)/);
});
