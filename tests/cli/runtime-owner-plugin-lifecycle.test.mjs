import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PluginHost } from "@unclecode/plugin-host";
import * as runtimeOwnerService from "../../apps/unclecode-cli/src/runtime-owner-service.ts";
import { startPersistentRuntimeOwner } from "../../apps/unclecode-server/src/runtime-owner.ts";

const { createRuntimeOwnerSessionDisposer } = runtimeOwnerService;

function fakeEngine(label, disposed) {
  const listeners = new Set();
  return {
    getState: () => ({
      label,
      mode: "standard",
      isBusy: false,
      queuePaused: false,
      model: "test-model",
      uiLocale: "en",
      agentConsole: {},
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interruptTurn: () => false,
    getTurnLifecycle: () => ({ state: "idle" }),
    dispose() {
      disposed.push(`engine:${label}`);
    },
  };
}

test("runtime owner cache evidence covers global caches and marks session LSP telemetry unavailable", () => {
  assert.equal(typeof runtimeOwnerService.readRuntimeOwnerCacheTelemetry, "function");
  const report = runtimeOwnerService.readRuntimeOwnerCacheTelemetry();
  const cacheNames = report.caches.map(cache => cache.name);
  const sources = new Map(report.sources.map(source => [source.name, source]));

  assert.ok(cacheNames.includes("orchestrator-extension-manifests"));
  assert.ok(cacheNames.includes("orchestrator-app-reasoning-config"));
  assert.deepEqual(sources.get("extension-manifest"), {
    name: "extension-manifest",
    status: "available",
    failureCount: 0,
  });
  assert.deepEqual(sources.get("app-reasoning-config"), {
    name: "app-reasoning-config",
    status: "available",
    failureCount: 0,
  });
  assert.deepEqual(sources.get("per-session-lsp"), {
    name: "per-session-lsp",
    status: "unavailable",
    failureCount: 0,
  });
});

test("runtime owner disposes each session plugin host exactly once on release and owner stop", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-plugin-lifecycle-"));
  const projectPath = join(rootDir, "workspace");
  const disposed = [];
  let owner;
  try {
    await mkdir(projectPath);
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      async createSession(request) {
        const engine = fakeEngine(request.sessionId, disposed);
        const pluginHost = new PluginHost();
        await pluginHost.register(`lifecycle-${request.sessionId}`, {
          dispose() {
            disposed.push(`plugins:${request.sessionId}`);
          },
        });
        return {
          engine,
          projectPath: request.projectPath,
          dispose: createRuntimeOwnerSessionDisposer(engine, () => pluginHost.dispose()),
        };
      },
    });

    assert.equal((await owner.engines.create({
      sessionId: "released",
      projectPath,
      idempotencyKey: "create-released",
    })).ok, true);
    assert.equal(await owner.engines.releaseSession("released"), true);
    assert.deepEqual(disposed, ["engine:released", "plugins:released"]);

    assert.equal((await owner.engines.create({
      sessionId: "stopped",
      projectPath,
      idempotencyKey: "create-stopped",
    })).ok, true);
    await owner.stop();
    owner = undefined;

    assert.deepEqual(disposed, [
      "engine:released",
      "plugins:released",
      "engine:stopped",
      "plugins:stopped",
    ]);
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});
