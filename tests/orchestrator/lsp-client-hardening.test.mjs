import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LspJsonRpcClient } from "../../packages/orchestrator/src/lsp-client.ts";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = readFileSync(filePath, "utf8").trim();
      if (value) return value;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

function writeHardeningServer(root, mode) {
  const executable = path.join(root, `lsp-${mode}.mjs`);
  const pidPath = path.join(root, `lsp-${mode}.pid`);
  writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
  process.stdout.write(body);
}
function handle(message) {
  if (message.method === "initialize") {
    if (${JSON.stringify(mode)} === "oversized") {
      process.stdout.write("Content-Length: 16777217\\r\\n\\r\\n");
      return;
    }
    if (${JSON.stringify(mode)} === "oversized-buffer") {
      const chunk = Buffer.alloc(1024 * 1024, "x");
      for (let index = 0; index < 33; index += 1) process.stdout.write(chunk);
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "exercise-diagnostics") {
    for (let index = 0; index < 513; index += 1) {
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: \`file:///diagnostic-\${index}.ts\`, diagnostics: [{ message: \`d\${index}\` }] },
      });
    }
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"));
    if (!match) process.exit(2);
    const bodyStart = headerEnd + 4;
    const bodyLength = Number(match[1]);
    if (buffer.length < bodyStart + bodyLength) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8"));
    buffer = buffer.subarray(bodyStart + bodyLength);
    handle(message);
  }
});
`);
  chmodSync(executable, 0o755);
  return { executable, pidPath };
}

test("oversized LSP frames fail initialization, settle waiters, and terminate the child", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-lsp-oversized-"));
  let pid;
  let client;
  try {
    const fixture = writeHardeningServer(root, "oversized");
    client = new LspJsonRpcClient(
      { id: "oversized", command: process.execPath, args: [fixture.executable], languageId: "typescript" },
      root,
      1_000,
      undefined,
      50,
    );
    const diagnosticWaiter = client.waitForPublishedDiagnostics("file:///pending.ts", 1_000);
    const rejectedStart = assert.rejects(client.start(), /oversized LSP frame/);
    pid = Number(await waitForFile(fixture.pidPath));

    await rejectedStart;
    assert.deepEqual(await diagnosticWaiter, { received: false, items: [] });
    await client.close();
    await waitForProcessExit(pid);
  } finally {
    await client?.close().catch(() => undefined);
    if (pid && processExists(pid)) process.kill(-pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("unterminated LSP input is capped at 32 MiB and terminates the child", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-lsp-buffer-limit-"));
  let pid;
  let client;
  try {
    const fixture = writeHardeningServer(root, "oversized-buffer");
    client = new LspJsonRpcClient(
      { id: "oversized-buffer", command: process.execPath, args: [fixture.executable], languageId: "typescript" },
      root,
      10_000,
      undefined,
      50,
    );
    const rejectedStart = assert.rejects(client.start(), /32 MiB LSP input buffer limit/);
    pid = Number(await waitForFile(fixture.pidPath));

    await rejectedStart;
    assert.equal(client.buffer.length, 0, "failed input must release its retained buffer");
    await client.close();
    await waitForProcessExit(pid);
  } finally {
    await client?.close().catch(() => undefined);
    if (pid && processExists(pid)) process.kill(-pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("unterminated LSP input grows by bounded capacity steps before the hard cap", () => {
  const client = new LspJsonRpcClient(
    { id: "buffer-growth", command: process.execPath, args: [], languageId: "typescript" },
    process.cwd(),
    1_000,
  );
  const chunk = Buffer.alloc(64 * 1024, "x");
  let priorBuffer = client.buffer;
  let reallocations = 0;

  for (let index = 0; index < 512; index += 1) {
    client.consume(chunk);
    if (client.buffer !== priorBuffer) {
      priorBuffer = client.buffer;
      reallocations += 1;
    }
  }

  assert.equal(client.bufferEnd - client.bufferStart, 32 * 1024 * 1024);
  assert.ok(reallocations <= 10, `expected amortized growth, observed ${reallocations} reallocations`);
  client.consume(Buffer.from("x"));
  assert.equal(client.closed, true);
  assert.equal(client.buffer.length, 0, "overflow must release the bounded input allocation");
});

test("published LSP diagnostics evict the oldest URI after 512 retained documents", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-lsp-diagnostics-bound-"));
  let client;
  let pid;
  try {
    const fixture = writeHardeningServer(root, "diagnostics");
    client = new LspJsonRpcClient(
      { id: "diagnostics", command: process.execPath, args: [fixture.executable], languageId: "typescript" },
      root,
      1_000,
      undefined,
      50,
    );
    await client.start();
    pid = Number(await waitForFile(fixture.pidPath));
    await client.request("exercise-diagnostics", null);

    assert.deepEqual(
      await client.waitForPublishedDiagnostics("file:///diagnostic-0.ts", 5),
      { received: false, items: [] },
    );
    assert.deepEqual(
      await client.waitForPublishedDiagnostics("file:///diagnostic-512.ts", 5),
      { received: true, items: [{ message: "d512" }] },
    );
    await client.close();
  } finally {
    await client?.close().catch(() => undefined);
    if (pid && processExists(pid)) process.kill(-pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
