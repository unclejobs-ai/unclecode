import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearExtensionRegistryCache,
  getExtensionRegistryCacheTelemetrySnapshot,
  getWorkShellSlashSuggestions,
  loadExtensionConfigOverlays,
  loadExtensionManifestSummaries,
  loadExtensionSlashCommands,
} from "@unclecode/orchestrator";

function writeManifest(workspaceRoot, fileName, value) {
  mkdirSync(path.join(workspaceRoot, ".unclecode", "extensions"), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, ".unclecode", "extensions", fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

test("extension registry loads plugin commands, config overlays, and summaries from manifests", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-extension-registry-"));
  writeManifest(cwd, "focus.json", {
    name: "focus-tools",
    commands: [
      {
        command: "/focus",
        routeTo: ["doctor"],
        description: "Run doctor from a plugin command.",
      },
    ],
    config: {
      model: "plugin-model",
      prompt: {
        sections: {
          "focus-note": {
            title: "Focus Note",
            body: "Stay locked on the highest-value task.",
          },
        },
      },
    },
    status: {
      label: "focus-tools",
      lines: ["/focus ready", "plugin-model overlay active"],
    },
  });

  const commands = loadExtensionSlashCommands({ workspaceRoot: cwd });
  const overlays = loadExtensionConfigOverlays({ workspaceRoot: cwd });
  const summaries = loadExtensionManifestSummaries({ workspaceRoot: cwd });

  assert.deepEqual(commands[0]?.routeTo, ["doctor"]);
  assert.equal(commands[0]?.metadata.source, "plugin");
  assert.equal(overlays[0]?.name, "focus-tools");
  assert.equal(overlays[0]?.config.model, "plugin-model");
  assert.match(overlays[0]?.config.prompt?.sections?.["focus-note"]?.body ?? "", /highest-value task/);
  assert.equal(summaries[0]?.name, "focus-tools");
  assert.deepEqual(summaries[0]?.statusLines, ["/focus ready", "plugin-model overlay active"]);
});

test("clearExtensionRegistryCache lets /reload pick up changed extension summaries", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-extension-registry-cache-"));
  writeManifest(cwd, "focus.json", {
    name: "focus-tools",
    status: {
      lines: ["v1"],
    },
  });

  const first = loadExtensionManifestSummaries({ workspaceRoot: cwd });
  writeManifest(cwd, "focus.json", {
    name: "focus-tools",
    status: {
      lines: ["v2"],
    },
  });

  const cached = loadExtensionManifestSummaries({ workspaceRoot: cwd });
  assert.deepEqual(first[0]?.statusLines, ["v1"]);
  assert.deepEqual(cached[0]?.statusLines, ["v1"]);

  clearExtensionRegistryCache({ workspaceRoot: cwd });
  const refreshed = loadExtensionManifestSummaries({ workspaceRoot: cwd });
  assert.deepEqual(refreshed[0]?.statusLines, ["v2"]);
});

test("clearExtensionRegistryCache refreshes cached extension slash suggestions", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-extension-slash-cache-"));
  writeManifest(cwd, "focus.json", {
    name: "focus-tools",
    commands: [
      {
        command: "/focus",
        routeTo: ["doctor"],
        description: "Run doctor from a plugin command.",
      },
    ],
  });

  const first = getWorkShellSlashSuggestions("/focus", { workspaceRoot: cwd }).map((item) => item.command);
  assert.ok(first.includes("/focus"));

  writeManifest(cwd, "focus.json", {
    name: "focus-tools",
    commands: [
      {
        command: "/focus2",
        routeTo: ["doctor"],
        description: "Run refreshed doctor command.",
      },
    ],
  });

  const staleBeforeReload = getWorkShellSlashSuggestions("/focus", { workspaceRoot: cwd }).map((item) => item.command);
  assert.ok(staleBeforeReload.includes("/focus"));
  assert.ok(!staleBeforeReload.includes("/focus2"));

  clearExtensionRegistryCache({ workspaceRoot: cwd });
  const refreshed = getWorkShellSlashSuggestions("/focus", { workspaceRoot: cwd }).map((item) => item.command);
  assert.ok(!refreshed.includes("/focus"));
  assert.ok(refreshed.includes("/focus2"));
});

test("extension manifest cache evicts the least-recent workspace and reports bounded retention", () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-extension-cache-bound-"));
  clearExtensionRegistryCache();
  const before = getExtensionRegistryCacheTelemetrySnapshot();

  try {
    const workspaces = Array.from({ length: 33 }, (_, index) => path.join(root, `workspace-${index}`));
    for (const [index, workspaceRoot] of workspaces.entries()) {
      writeManifest(workspaceRoot, "focus.json", {
        name: "focus-tools",
        status: { lines: [`v${index}`] },
      });
      loadExtensionManifestSummaries({ workspaceRoot });
    }

    writeManifest(workspaces[0], "focus.json", {
      name: "focus-tools",
      status: { lines: ["reloaded-after-eviction"] },
    });
    const reloaded = loadExtensionManifestSummaries({ workspaceRoot: workspaces[0] });
    const after = getExtensionRegistryCacheTelemetrySnapshot();

    assert.deepEqual(reloaded[0]?.statusLines, ["reloaded-after-eviction"]);
    assert.ok(after.currentSize <= 32, "manifest retention must stay within 32 workspaces");
    assert.ok(after.evictions > before.evictions, "workspace churn must be visible as an eviction");
    assert.ok(after.retainedBytesEstimate <= after.maxRetainedBytes);
  } finally {
    clearExtensionRegistryCache();
    rmSync(root, { recursive: true, force: true });
  }
});
