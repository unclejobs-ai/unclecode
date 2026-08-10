import { test } from "node:test";
import assert from "node:assert/strict";

import { LspBridge, formatLspCheckEvidence, spawnLspClientStub } from "@unclecode/lsp-bridge";

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

test("LspBridge.checkAfterEdit stops an in-flight check when its signal aborts", async () => {
  const bridge = new LspBridge();
  bridge.register(makeHangingClient("ts", [".ts"]));
  const controller = new AbortController();
  const startedAt = Date.now();

  const pending = bridge.checkAfterEdit({
    path: "src/a.ts",
    content: "let x = 1;",
    // A timeout far beyond the test budget: only the abort can end this.
    options: { timeoutMs: 60_000, signal: controller.signal },
  });
  controller.abort();

  await assert.rejects(pending, (error) => error === controller.signal.reason);
  assert.ok(Date.now() - startedAt < 5_000, "the abort ends the check without waiting out the timeout");
});

test("LspBridge.checkAfterEdit refuses to poll a client once its signal is aborted", async () => {
  const polled = [];
  const bridge = new LspBridge();
  bridge.register({
    id: "ts",
    handlesExtension: (ext) => ext === ".ts",
    async notifyDidChange() {},
    async pollDiagnostics() {
      polled.push("ts");
      return [];
    },
    async shutdown() {},
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    bridge.checkAfterEdit({
      path: "src/a.ts",
      content: "let x = 1;",
      options: { signal: controller.signal },
    }),
    (error) => error === controller.signal.reason,
  );
  assert.deepEqual(polled, [], "a cancelled check never reaches a client");
});

test("LspBridge.checkAfterEdit hands the signal to the underlying client", async () => {
  const seen = [];
  const bridge = new LspBridge();
  bridge.register({
    id: "ts",
    handlesExtension: (ext) => ext === ".ts",
    async notifyDidChange(input) {
      seen.push(["notifyDidChange", input.signal]);
    },
    async pollDiagnostics(input) {
      seen.push(["pollDiagnostics", input.signal]);
      return [];
    },
    async shutdown() {},
  });
  const controller = new AbortController();

  await bridge.checkAfterEdit({
    path: "src/a.ts",
    content: "let x = 1;",
    options: { signal: controller.signal },
  });

  assert.deepEqual(seen, [
    ["notifyDidChange", controller.signal],
    ["pollDiagnostics", controller.signal],
  ]);
});

test("a client that observes its signal stops the underlying diagnostic work", async () => {
  const observed = [];
  const polling = Promise.withResolvers();
  const controller = new AbortController();
  const bridge = new LspBridge();
  bridge.register({
    id: "ts",
    handlesExtension: (ext) => ext === ".ts",
    async notifyDidChange() {},
    async pollDiagnostics(input) {
      // The real transport cancels its own work; nothing outside it can.
      const { promise, reject } = Promise.withResolvers();
      input.signal?.addEventListener("abort", () => {
        observed.push("client saw the abort");
        reject(input.signal?.reason);
      }, { once: true });
      polling.resolve();
      return await promise;
    },
    async shutdown() {},
  });

  const pending = bridge.checkAfterEdit({
    path: "src/a.ts",
    content: "let x = 1;",
    options: { timeoutMs: 60_000, signal: controller.signal },
  });
  // Abort only once the client is genuinely inside its diagnostic call.
  await polling.promise;
  controller.abort();

  await assert.rejects(pending, (error) => error === controller.signal.reason);
  assert.deepEqual(observed, ["client saw the abort"]);
});

test("an abort raised inside notifyDidChange never polls the client", async () => {
  const polled = [];
  const controller = new AbortController();
  const bridge = new LspBridge();
  bridge.register({
    id: "ts",
    handlesExtension: (ext) => ext === ".ts",
    async notifyDidChange() {
      // Signal-deaf: aborts and then resolves normally.
      controller.abort();
    },
    async pollDiagnostics() {
      polled.push("ts");
      return [];
    },
    async shutdown() {},
  });
  const startedAt = Date.now();

  await assert.rejects(
    bridge.checkAfterEdit({
      path: "src/a.ts",
      content: "let x = 1;",
      // A pre-aborted wrapper must reject outright, never arm this timer.
      options: { timeoutMs: 60_000, signal: controller.signal },
    }),
    (error) => error === controller.signal.reason,
  );
  assert.deepEqual(polled, []);
  assert.ok(Date.now() - startedAt < 5_000, "the pre-aborted wrapper does not wait out its timeout");
});

test("a client failure racing an abort reports the abort, not the failure", async () => {
  const controller = new AbortController();
  const bridge = new LspBridge();
  bridge.register({
    id: "ts",
    handlesExtension: (ext) => ext === ".ts",
    async notifyDidChange() {},
    async pollDiagnostics() {
      controller.abort();
      throw new Error("language server crashed");
    },
    async shutdown() {},
  });

  await assert.rejects(
    bridge.checkAfterEdit({
      path: "src/a.ts",
      content: "let x = 1;",
      options: { signal: controller.signal },
    }),
    (error) => error === controller.signal.reason,
    "a cancelled check reports cancellation, never the error that raced it",
  );
});

test("spawnLspClientStub honours a cancelled signal instead of spawning", async () => {
  const client = spawnLspClientStub({
    id: "ts",
    // Deliberately unrunnable: a compliant client rejects before it ever spawns.
    command: "definitely-not-a-real-language-server",
    extensions: [".ts"],
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.notifyDidChange({ path: "src/a.ts", content: "let x = 1;", signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  await assert.rejects(
    client.pollDiagnostics({ path: "src/a.ts", timeoutMs: 10, signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  await client.shutdown();
});

test("LspBridge.checkAfterEdit rejects a pre-aborted no-client check", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    new LspBridge().checkAfterEdit({
      path: "src/a.ts",
      content: "let x = 1;",
      options: { signal: controller.signal },
    }),
    (error) => error === controller.signal.reason,
  );
});

test("LspBridge.checkAfterEdit rejects a pre-aborted unmatched check", async () => {
  const bridge = new LspBridge();
  bridge.register(makeStubClient("python", [".py"]));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    bridge.checkAfterEdit({
      path: "src/a.ts",
      content: "let x = 1;",
      options: { signal: controller.signal },
    }),
    (error) => error === controller.signal.reason,
  );
});

test("an abort after didChange settles never starts diagnostics", async () => {
  const controller = new AbortController();
  const polled = [];
  const bridge = new LspBridge();
  bridge.register({
    id: "ts",
    handlesExtension: (ext) => ext === ".ts",
    notifyDidChange() {
      return {
        then(resolve) {
          resolve();
          controller.abort();
        },
      };
    },
    async pollDiagnostics() {
      polled.push("ts");
      return [];
    },
    async shutdown() {},
  });

  await assert.rejects(
    bridge.checkAfterEdit({
      path: "src/a.ts",
      content: "let x = 1;",
      options: { signal: controller.signal },
    }),
    (error) => error === controller.signal.reason,
  );
  assert.deepEqual(polled, [], "diagnostics never start after the didChange boundary aborts");
});

test("an abort after diagnostics settle discards the stale result", async () => {
  const controller = new AbortController();
  const bridge = new LspBridge();
  bridge.register({
    id: "ts",
    handlesExtension: (ext) => ext === ".ts",
    async notifyDidChange() {},
    pollDiagnostics() {
      return {
        then(resolve) {
          resolve([]);
          controller.abort();
        },
      };
    },
    async shutdown() {},
  });

  await assert.rejects(
    bridge.checkAfterEdit({
      path: "src/a.ts",
      content: "let x = 1;",
      options: { signal: controller.signal },
    }),
    (error) => error === controller.signal.reason,
  );
});
