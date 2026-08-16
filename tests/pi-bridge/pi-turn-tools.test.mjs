import assert from "node:assert/strict";
import test from "node:test";

import { buildPiTurnToolRuntime } from "../../apps/unclecode-cli/src/pi-turn.ts";
import { resolvePiProviderBaseUrl } from "@unclecode/pi-bridge";

test("tool runtime keeps only the allowed tools and exposes a single executor", () => {
  const runtime = buildPiTurnToolRuntime({
    allowedTools: ["list_files", "read_file", "write_file", "search_text", "run_shell"],
    allowRunShell: false,
  });

  const names = runtime.definitions.map((tool) => tool.name);
  assert.deepEqual(names, ["list_files", "read_file", "write_file", "search_text"]);
  assert.equal(runtime.handlers, undefined, "the public runtime never exposes raw handlers");
  assert.equal(typeof runtime.executor.execute, "function");
});

test("run_shell is included only when the request-scoped shell gate is open", async () => {
  const gated = buildPiTurnToolRuntime({ allowedTools: ["run_shell"], allowRunShell: false });
  assert.deepEqual(gated.definitions, []);
  const refused = await gated.executor.execute({
    toolName: "run_shell",
    input: { command: "pwd" },
    cwd: process.cwd(),
  });
  assert.equal(refused.isError, true);

  const opened = buildPiTurnToolRuntime({ allowedTools: ["run_shell"], allowRunShell: true });
  assert.deepEqual(
    opened.definitions.map((tool) => tool.name),
    ["run_shell"],
  );
  const allowed = await opened.executor.execute({
    toolName: "run_shell",
    input: { command: "pwd" },
    cwd: process.cwd(),
  });
  assert.equal(allowed.isError ?? false, false);
});

test("omitting allowedTools exposes every non-interactive tool except the gated shell", () => {
  const runtime = buildPiTurnToolRuntime({ allowRunShell: false });
  const names = runtime.definitions.map((tool) => tool.name);

  assert.ok(names.includes("list_files"));
  assert.ok(names.includes("delete_file"));
  assert.ok(names.includes("lsp_query"));
  assert.ok(names.includes("lsp_rename"));
  assert.ok(names.includes("ast_search"));
  assert.ok(names.includes("ast_rewrite"));
  assert.ok(!names.includes("run_shell"));
  assert.ok(!names.includes("ask_user"));
});

test("Pi turns use the same provider base URL aliases as the native runtime", () => {
  assert.equal(
    resolvePiProviderBaseUrl("gemini", {
      GEMINI_API_BASE_URL: "http://127.0.0.1:43123/v1beta/",
    }),
    "http://127.0.0.1:43123/v1beta",
  );
  assert.equal(
    resolvePiProviderBaseUrl("openai", {
      OPENAI_BASE_URL: "http://127.0.0.1:43124/v1",
      OPENAI_API_BASE_URL: "http://ignored.invalid/v1",
    }),
    "http://127.0.0.1:43124/v1",
  );
  assert.equal(resolvePiProviderBaseUrl("anthropic", {}), undefined);
});
