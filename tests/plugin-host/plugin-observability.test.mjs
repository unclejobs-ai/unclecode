import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PluginHost } from "@unclecode/plugin-host";

test("plugin lifecycle snapshot is bounded, hook-free, and reflects disposal", async () => {
  const host = new PluginHost();
  for (let index = 0; index < 140; index += 1) {
    await host.register(`plugin-${String(index).padStart(3, "0")}`, {
      runStarted() {},
      dispose() {},
    }, index === 0 ? "builtin" : "memory");
  }

  const active = host.getLifecycleSnapshot();
  assert.equal(active.status, "active");
  assert.equal(active.registrationCount, 140);
  assert.equal(active.registrations.length, 64);
  assert.equal(active.truncated, true);
  assert.deepEqual(active.registrations[0], {
    name: "plugin-000",
    source: "builtin",
    trustLane: "builtin-trusted",
    hookCount: 1,
  });
  assert.equal("hooks" in active.registrations[0], false);

  await host.dispose();
  assert.deepEqual(host.getLifecycleSnapshot(), {
    status: "disposed",
    registrationCount: 0,
    pendingCleanupCount: 0,
    registrations: [],
    truncated: false,
  });
});

test("repeated lifecycle snapshots never re-enter workspace plugin Proxy traps", async () => {
  let ownKeysCalls = 0;
  const hooks = new Proxy({ runStarted() {} }, {
    ownKeys(target) {
      ownKeysCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  const host = new PluginHost();
  await host.register("proxy-plugin", hooks, "workspace");
  const callsAfterRegistration = ownKeysCalls;

  host.getLifecycleSnapshot();
  host.getLifecycleSnapshot();

  assert.equal(ownKeysCalls, callsAfterRegistration);
  await host.dispose();
});

test("a partial plugin batch failure disposes every hook registered by that batch", async () => {
  const emitter = new EventEmitter();
  const host = new PluginHost();
  let disposeCalls = 0;

  await assert.rejects(host.loadEntries("/workspace", [{
    name: "listener",
    entry() {
      const listener = () => {};
      emitter.on("change", listener);
      return {
        dispose() {
          disposeCalls += 1;
          emitter.off("change", listener);
        },
      };
    },
  }, {
    name: "broken",
    entry() {
      throw new Error("batch failed");
    },
  }]), /batch failed/);

  assert.equal(disposeCalls, 1);
  assert.equal(emitter.listenerCount("change"), 0);
  assert.deepEqual(host.list(), []);
  await host.dispose();
});

test("diagnostic dedupe retention is bounded per run and never retains raw error text as a key", async () => {
  const diagnostics = [];
  const host = new PluginHost({ onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
  await host.register("failing", {
    toolExecuteBefore(event) {
      throw new Error(`failure=${event.toolName}`);
    },
  });

  for (let index = 0; index < 65; index += 1) {
    await assert.rejects(
      host.dispatchToolExecuteBefore({ runId: "one-run", toolName: `tool-${index}`, input: {} }),
      /failure=/,
    );
  }
  await assert.rejects(
    host.dispatchToolExecuteBefore({ runId: "one-run", toolName: "tool-0", input: {} }),
    /failure=/,
  );

  assert.equal(diagnostics.length, 66, "the oldest per-run key should be evicted after the bounded limit");
  assert.ok(diagnostics.every(diagnostic => /^sha256:[a-f0-9]{64}$/.test(diagnostic.dedupeKey)));
  assert.doesNotMatch(diagnostics.map(item => item.dedupeKey).join("\n"), /failure|tool-/);
  await host.dispose();
});
