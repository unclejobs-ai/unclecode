import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAstToolRegistry,
  createLspToolRegistry,
  createToolRuntime,
  createWorkShellInteractionBridge,
} from "@unclecode/orchestrator";
import { LspJsonRpcClient } from "../../packages/orchestrator/src/lsp-client.ts";
import { waitForOwnedProcessGroupExit } from "../../packages/orchestrator/src/process-group-settlement.ts";

function writeFakeLanguageServer(root) {
  const serverPath = path.join(root, "fake-lsp.mjs");
  writeFileSync(serverPath, `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
  process.stdout.write(body);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { diagnosticProvider: true } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "textDocument/diagnostic") {
    send({ jsonrpc: "2.0", id: message.id, result: { kind: "full", items: [{
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
      severity: 2,
      source: "fake-lsp",
      code: "FAKE001",
      message: "oldName should be renamed",
    }] } });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({ jsonrpc: "2.0", id: message.id, result: [{
      uri: message.params.textDocument.uri,
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
    }] });
    return;
  }
  if (message.method === "textDocument/references") {
    send({ jsonrpc: "2.0", id: message.id, result: [{
      uri: message.params.textDocument.uri,
      range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } },
    }] });
    return;
  }
  if (message.method === "textDocument/hover") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: "const oldName: 1" } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({ jsonrpc: "2.0", id: message.id, result: [{
      name: "oldName",
      kind: 13,
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
    }] });
    return;
  }
  if (message.method === "textDocument/rename") {
    const uri = message.params.textDocument.uri;
    const edits = [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: message.params.newName },
      { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } }, newText: message.params.newName },
    ];
    send({ jsonrpc: "2.0", id: message.id, result: {
      changes: { [uri]: [{ range: edits[0].range, newText: "ignoredChangesField" }] },
      documentChanges: [
        { textDocument: { uri, version: 1 }, edits: [edits[0]] },
        { textDocument: { uri: uri.replace("example.ts", "%65xample.ts"), version: 1 }, edits: [edits[1]] },
      ],
    } });
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
`);
  chmodSync(serverPath, 0o755);
  return serverPath;
}

function fakeServerResolver(serverPath) {
  return (_path, extension) => extension === ".ts"
    ? { id: "fake-typescript", command: process.execPath, args: [serverPath], languageId: "typescript" }
    : undefined;
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(filePath, "utf8").trim();
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function writeStubbornTool(root, name) {
  const executable = path.join(root, `${name}.mjs`);
  const descendantExecutable = path.join(root, `${name}-descendant.mjs`);
  const pidPath = path.join(root, `${name}.pid`);
  const descendantPidPath = path.join(root, `${name}-descendant.pid`);
  const descendantReadyPath = path.join(root, `${name}-descendant.ready`);
  const termPath = path.join(root, `${name}.term`);
  const readyPath = path.join(root, `${name}.ready`);
  writeFileSync(descendantExecutable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");
setInterval(() => {}, 1000);
`);
  chmodSync(descendantExecutable, 0o755);
  writeFileSync(executable, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termPath)}, "term"));
process.stdin.resume();
const descendant = spawn(process.execPath, [${JSON.stringify(descendantExecutable)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
const readyTimer = setInterval(() => {
  if (existsSync(${JSON.stringify(descendantReadyPath)})) {
    writeFileSync(${JSON.stringify(readyPath)}, "ready", { flag: "wx" });
    clearInterval(readyTimer);
  }
}, 10);
setInterval(() => {}, 1000);
`);
  chmodSync(executable, 0o755);
  return { executable, pidPath, descendantPidPath, descendantReadyPath, termPath, readyPath };
}

test("process-group settlement treats EPERM as pending until ESRCH", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
}, async () => {
  const probes = ["EPERM", "EPERM", "ESRCH"];
  let waits = 0;
  await waitForOwnedProcessGroupExit({
    processGroupId: 4242,
    timeoutMs: 1_000,
    label: "injected",
    probe() {
      const error = new Error("injected probe");
      error.code = probes.shift();
      throw error;
    },
    wait: async () => { waits += 1; },
  });
  assert.equal(waits, 2);
  assert.deepEqual(probes, []);
});

test("native LSP and AST tools register definitions and risk metadata", () => {
  const runtime = createToolRuntime({ interactionBridge: createWorkShellInteractionBridge() });
  const definitions = new Map(runtime.definitions.map((definition) => [definition.name, definition]));

  assert.equal(runtime.handlers, undefined, "the public runtime never exposes raw handlers");
  assert.ok(definitions.has("lsp_query"));
  assert.ok(definitions.has("lsp_rename"));
  assert.ok(definitions.has("ast_search"));
  assert.ok(definitions.has("ast_rewrite"));
  assert.equal(definitions.get("lsp_query")?.metadata?.annotations.readOnlyHint, true);
  assert.equal(definitions.get("ast_search")?.metadata?.annotations.readOnlyHint, true);
  assert.equal(definitions.get("lsp_rename")?.metadata?.annotations.requiresConfirmation, true);
  assert.equal(definitions.get("ast_rewrite")?.metadata?.annotations.requiresConfirmation, true);
  assert.deepEqual(definitions.get("lsp_query")?.input_schema.properties.action.enum, [
    "diagnostics",
    "definition",
    "references",
    "hover",
    "symbols",
  ]);
});

test("ast_search and ast_rewrite invoke ast-grep without a shell", async () => {
  const calls = [];
  const ast = createAstToolRegistry({
    run: async (args, cwd) => {
      calls.push({ args, cwd });
      return JSON.stringify([{
        file: "src/example.ts",
        text: "console.log(value)",
        range: { start: { line: 2, column: 0 }, end: { line: 2, column: 18 } },
        replacement: "logger.info(value)",
      }]);
    },
  });

  const search = JSON.parse((await ast.handlers.ast_search(
    { pattern: "console.log($A)", lang: "ts", path: "packages", limit: 10 },
    process.cwd(),
  )).content);
  assert.equal(search.matches.length, 1);
  assert.deepEqual(calls[0].args, ["run", "--pattern", "console.log($A)", "--json", "--lang", "ts", "packages"]);

  const preview = JSON.parse((await ast.handlers.ast_rewrite(
    { pattern: "console.log($A)", rewrite: "logger.info($A)", lang: "ts", path: "packages" },
    process.cwd(),
  )).content);
  assert.equal(preview.applied, false);
  assert.equal(calls[1].args.includes("--update-all"), false);

  const applied = JSON.parse((await ast.handlers.ast_rewrite(
    { pattern: "console.log($A)", rewrite: "logger.info($A)", lang: "ts", path: "packages", apply: true },
    process.cwd(),
  )).content);
  assert.equal(applied.applied, true);
  assert.equal(calls[2].args.includes("--update-all"), false);
  assert.equal(calls[3].args.includes("--update-all"), true);
  assert.equal(calls[3].args.includes("--json"), false);
});

test("ast_rewrite refuses to apply more matches than its safety limit", async () => {
  const calls = [];
  const ast = createAstToolRegistry({
    run: async (args) => {
      calls.push(args);
      return JSON.stringify([{ file: "a.ts" }, { file: "b.ts" }]);
    },
  });

  await assert.rejects(
    () => ast.handlers.ast_rewrite(
      { pattern: "$A", rewrite: "$A", path: "packages", limit: 1, apply: true },
      process.cwd(),
    ),
    /exceeding the apply limit/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("--update-all"), false);
});

test("native code tools reject paths that escape the workspace", async () => {
  let called = false;
  const ast = createAstToolRegistry({
    run: async () => {
      called = true;
      return "[]";
    },
  });

  await assert.rejects(
    () => ast.handlers.ast_search({ pattern: "$A", path: "../outside" }, process.cwd()),
    /Path escapes working directory/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () => ast.handlers.ast_search({ pattern: "$A", path: "missing-native-tool-path" }, process.cwd()),
    /Path does not exist or is not accessible in the workspace/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () => ast.handlers.ast_search({ pattern: "$A", path: 123 }, process.cwd()),
    /path must be a non-empty string/,
  );
  assert.equal(called, false);
});

test("ast_search abort waits for its SIGTERM-ignoring process group to be killed", {
  skip: process.platform === "win32" ? "process-group settlement is POSIX-only" : false,
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-ast-settle-"));
  let pid;
  let descendantPid;
  try {
    const stubborn = writeStubbornTool(root, "stubborn-ast");
    const ast = createAstToolRegistry({ executable: stubborn.executable, forceKillDelayMs: 300 });
    const abortController = new AbortController();
    const invocation = ast.handlers.ast_search(
      { pattern: "$A", path: "." },
      root,
      { signal: abortController.signal },
    );
    pid = Number(await waitForFile(stubborn.pidPath));
    await waitForFile(stubborn.readyPath);
    descendantPid = Number(await waitForFile(stubborn.descendantPidPath));
    abortController.abort();
    await assert.rejects(invocation, error => error?.name === "AbortError");
    assert.equal(readFileSync(stubborn.termPath, "utf8"), "term");
    assert.equal(processExists(pid), false, "the AST handler must await process-group exit");
    assert.equal(processExists(descendantPid), false, "the AST process-group descendant must also exit");
  } finally {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("lsp_query abort waits for its SIGTERM-ignoring server process group to be killed", {
  skip: process.platform === "win32" ? "process-group settlement is POSIX-only" : false,
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-lsp-settle-"));
  let pid;
  let descendantPid;
  try {
    const stubborn = writeStubbornTool(root, "stubborn-lsp");
    writeFileSync(path.join(root, "example.ts"), "const value = 1;\n");
    const lsp = createLspToolRegistry({
      resolveServer: fakeServerResolver(stubborn.executable),
      forceKillDelayMs: 300,
    });
    const abortController = new AbortController();
    const invocation = lsp.handlers.lsp_query(
      { action: "symbols", path: "example.ts" },
      root,
      { signal: abortController.signal },
    );
    pid = Number(await waitForFile(stubborn.pidPath));
    await waitForFile(stubborn.readyPath);
    descendantPid = Number(await waitForFile(stubborn.descendantPidPath));
    abortController.abort();
    await assert.rejects(invocation, error => error?.name === "AbortError");
    assert.equal(readFileSync(stubborn.termPath, "utf8"), "term");
    assert.equal(processExists(pid), false, "the LSP handler must await process-group exit");
    assert.equal(processExists(descendantPid), false, "the LSP process-group descendant must also exit");
  } finally {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent LSP close calls join one abort-vs-exit settlement", {
  skip: process.platform === "win32" ? "process-group settlement is POSIX-only" : false,
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-lsp-double-close-"));
  let pid;
  let descendantPid;
  try {
    const stubborn = writeStubbornTool(root, "stubborn-lsp-close");
    const abortController = new AbortController();
    const client = new LspJsonRpcClient(
      { id: "stubborn", command: process.execPath, args: [stubborn.executable], languageId: "typescript" },
      root,
      2_000,
      abortController.signal,
      300,
    );
    const start = client.start();
    pid = Number(await waitForFile(stubborn.pidPath));
    await waitForFile(stubborn.readyPath);
    descendantPid = Number(await waitForFile(stubborn.descendantPidPath));
    abortController.abort();
    const firstClose = client.close();
    const secondClose = client.close();
    assert.equal(secondClose, firstClose, "concurrent close calls must join the same settlement promise");
    await assert.rejects(start, error => error?.name === "AbortError");
    await Promise.all([firstClose, secondClose]);
    assert.equal(readFileSync(stubborn.termPath, "utf8"), "term");
    assert.equal(processExists(pid), false);
    assert.equal(processExists(descendantPid), false);
  } finally {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("lsp_query speaks JSON-RPC and normalizes diagnostics and definitions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-lsp-tool-"));
  try {
    const serverPath = writeFakeLanguageServer(root);
    writeFileSync(path.join(root, "example.ts"), "const oldName = 1;\nconsole.log(oldName);\n");
    const lsp = createLspToolRegistry({ resolveServer: fakeServerResolver(serverPath) });

    const diagnostics = JSON.parse((await lsp.handlers.lsp_query(
      { action: "diagnostics", path: "example.ts" },
      root,
    )).content);
    assert.equal(diagnostics.server, "fake-typescript");
    assert.equal(diagnostics.diagnostics[0].range.start.line, 1);
    assert.equal(diagnostics.diagnostics[0].range.start.column, 7);
    assert.equal(diagnostics.diagnostics[0].message, "oldName should be renamed");

    const definition = JSON.parse((await lsp.handlers.lsp_query(
      { action: "definition", path: "example.ts", line: 2, symbol: "oldName" },
      root,
    )).content);
    assert.deepEqual(definition.locations, [{
      path: "example.ts",
      range: {
        start: { line: 1, column: 7 },
        end: { line: 1, column: 14 },
      },
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lsp_rename applies every workspace edit atomically per file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-lsp-rename-"));
  try {
    const serverPath = writeFakeLanguageServer(root);
    const sourcePath = path.join(root, "example.ts");
    writeFileSync(sourcePath, "const oldName = 1;\nconsole.log(oldName);\n");
    const lsp = createLspToolRegistry({ resolveServer: fakeServerResolver(serverPath) });

    const result = JSON.parse((await lsp.handlers.lsp_rename(
      { path: "example.ts", line: 1, symbol: "oldName", new_name: "nextName" },
      root,
    )).content);

    assert.deepEqual(result, { server: "fake-typescript", changedFiles: ["example.ts"], editCount: 2 });
    assert.equal(readFileSync(sourcePath, "utf8"), "const nextName = 1;\nconsole.log(nextName);\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
