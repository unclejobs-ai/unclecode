import { test } from "node:test";
import assert from "node:assert/strict";

import { LspBridge, formatLspCheckEvidence } from "@unclecode/lsp-bridge";

function makeStubClient(id, exts, diagnostics = []) {
  return {
    id,
    handlesExtension(ext) {
      return exts.includes(ext.toLowerCase());
    },
    async notifyDidChange() {},
    async pollDiagnostics() {
      return diagnostics;
    },
    async shutdown() {},
  };
}

function makeThrowingClient(id, exts, message) {
  return {
    id,
    handlesExtension(ext) {
      return exts.includes(ext.toLowerCase());
    },
    async notifyDidChange() {
      throw new Error(message);
    },
    async pollDiagnostics() {
      return [];
    },
    async shutdown() {},
  };
}

function makeHangingClient(id, exts) {
  return {
    id,
    handlesExtension(ext) {
      return exts.includes(ext.toLowerCase());
    },
    async notifyDidChange() {
      await new Promise(() => {});
    },
    async pollDiagnostics() {
      return [];
    },
    async shutdown() {},
  };
}

test("LspBridge.pollAfterEdit dispatches to clients matching extension", async () => {
  const bridge = new LspBridge();
  bridge.register(
    makeStubClient(
      "ts",
      [".ts"],
      [
        {
          path: "src/a.ts",
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          severity: "error",
          message: "missing semicolon",
        },
      ],
    ),
  );
  bridge.register(makeStubClient("py", [".py"], []));
  const diagnostics = await bridge.pollAfterEdit({ path: "src/a.ts", content: "let x = 1\n" });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "error");
});

test("LspBridge.pollAfterEdit returns empty when no client matches the extension", async () => {
  const bridge = new LspBridge();
  bridge.register(makeStubClient("ts", [".ts"], []));
  const diagnostics = await bridge.pollAfterEdit({ path: "src/a.go", content: "package main" });
  assert.equal(diagnostics.length, 0);
});

test("LspBridge.checkAfterEdit reports unavailable evidence when no clients are registered", async () => {
  const bridge = new LspBridge();
  const result = await bridge.checkAfterEdit({ path: "src/a.ts", content: "let x = 1;" });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.matchedClientIds, []);
  assert.match(formatLspCheckEvidence(result), /unavailable: no LSP clients registered/);
});

test("LspBridge.checkAfterEdit reports skipped evidence when no client matches the extension", async () => {
  const bridge = new LspBridge();
  bridge.register(makeStubClient("ts", [".ts"], []));
  const result = await bridge.checkAfterEdit({ path: "src/a.go", content: "package main" });
  assert.equal(result.status, "skipped");
  assert.deepEqual(result.matchedClientIds, []);
  assert.match(result.summary, /no registered LSP client handles ".go"/);
});

test("LspBridge.checkAfterEdit distinguishes passing and failing matched checks", async () => {
  const bridge = new LspBridge();
  bridge.register(makeStubClient("ts", [".ts"], []));
  const pass = await bridge.checkAfterEdit({ path: "src/a.ts", content: "let x = 1;" });
  assert.equal(pass.status, "pass");
  assert.deepEqual(pass.matchedClientIds, ["ts"]);
  assert.equal(pass.diagnostics.length, 0);

  const failingBridge = new LspBridge();
  failingBridge.register(
    makeStubClient("ts", [".ts"], [
      {
        path: "src/a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: "error",
        message: "Cannot find name 'oops'",
      },
    ]),
  );
  const fail = await failingBridge.checkAfterEdit({ path: "src/a.ts", content: "oops" });
  assert.equal(fail.status, "fail");
  assert.equal(fail.diagnostics.length, 1);
  assert.match(formatLspCheckEvidence(fail), /fail: 1 diagnostic/);
});

test("LspBridge.checkAfterEdit marks throwing clients as unavailable", async () => {
  const bridge = new LspBridge();
  bridge.register(makeThrowingClient("ts", [".ts"], "language server missing"));

  const result = await bridge.checkAfterEdit({ path: "src/a.ts", content: "let x = 1;" });

  assert.equal(result.status, "unavailable");
  assert.match(result.clientResults[0]?.summary ?? "", /language server missing/);
  assert.match(formatLspCheckEvidence(result), /unavailable/);
});

test("LspBridge.checkAfterEdit bounds notifyDidChange hangs by timeout", async () => {
  const bridge = new LspBridge();
  bridge.register(makeHangingClient("ts", [".ts"]));
  const startedAt = Date.now();

  const result = await bridge.checkAfterEdit({
    path: "src/a.ts",
    content: "let x = 1;",
    options: { timeoutMs: 20 },
  });

  assert.equal(result.status, "unavailable");
  assert.ok(Date.now() - startedAt < 500, "hanging notifyDidChange should not pin the loop");
  assert.match(result.summary, /timed out/);
});

test("LspBridge.pollAfterEdit caps diagnostics by maxDiagnostics", async () => {
  const bridge = new LspBridge();
  const dx = Array.from({ length: 30 }, (_, i) => ({
    path: "src/a.ts",
    range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
    severity: "warning",
    message: `warn ${i}`,
  }));
  bridge.register(makeStubClient("ts", [".ts"], dx));
  const diagnostics = await bridge.pollAfterEdit({
    path: "src/a.ts",
    content: "x",
    options: { maxDiagnostics: 5 },
  });
  assert.equal(diagnostics.length, 5);
});

test("LspBridge.shutdownAll empties the registered list", async () => {
  const bridge = new LspBridge();
  bridge.register(makeStubClient("ts", [".ts"]));
  bridge.register(makeStubClient("py", [".py"]));
  await bridge.shutdownAll();
  assert.equal(bridge.list().length, 0);
});
