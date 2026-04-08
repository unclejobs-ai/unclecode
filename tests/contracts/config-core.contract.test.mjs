import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIG_CORE_DEFAULT_MODE_PROFILE,
  CONFIG_SOURCE_ORDER,
  explainUncleCodeConfig,
  formatUncleCodeConfigExplanation,
} from "@unclecode/config-core";
import { MODE_PROFILES } from "@unclecode/contracts";

function createWorkspaceFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-config-core-"));
  const workspaceRoot = path.join(root, "workspace");
  const userHomeDir = path.join(root, "home");

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHomeDir, { recursive: true });

  return { workspaceRoot, userHomeDir };
}

function writeConfigFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeRawFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

test("config-core explains precedence in the documented source order", () => {
  const { workspaceRoot, userHomeDir } = createWorkspaceFixture();

  writeConfigFile(path.join(workspaceRoot, ".unclecode", "config.json"), {
    model: "project-model",
  });
  writeConfigFile(path.join(userHomeDir, ".unclecode", "config.json"), {
    model: "user-model",
  });

  const explanation = explainUncleCodeConfig({
    workspaceRoot,
    userHomeDir,
    pluginOverlays: [
      { name: "example-plugin", config: { model: "plugin-model" } },
    ],
    env: { UNCLECODE_MODEL: "env-model" },
    cliFlags: { model: "flag-model" },
    sessionOverrides: { model: "session-model" },
  });

  assert.equal(CONFIG_CORE_DEFAULT_MODE_PROFILE, MODE_PROFILES.default.id);
  assert.deepEqual(
    CONFIG_SOURCE_ORDER.map((source) => source.id),
    [
      "built-in-defaults",
      "built-in-mode-profile",
      "plugin-overlay",
      "project-config",
      "user-config",
      "environment",
      "cli-flags",
      "session-overrides",
    ],
  );
  assert.equal(explanation.settings.model.value, "session-model");
  assert.equal(explanation.settings.model.winner.sourceId, "session-overrides");
  assert.deepEqual(
    explanation.settings.model.contributors.map(
      (contributor) => contributor.sourceId,
    ),
    [
      "built-in-defaults",
      "plugin-overlay",
      "project-config",
      "user-config",
      "environment",
      "cli-flags",
      "session-overrides",
    ],
  );
});

test("config-core exposes the active mode and mode-derived setting contributions", () => {
  const { workspaceRoot, userHomeDir } = createWorkspaceFixture();

  const explanation = explainUncleCodeConfig({
    workspaceRoot,
    userHomeDir,
    env: { UNCLECODE_MODE: "search" },
  });

  assert.equal(explanation.activeMode.id, "search");
  assert.equal(explanation.settings.mode.value, "search");
  assert.equal(explanation.settings.mode.winner.sourceId, "environment");
  assert.equal(
    explanation.settings.editing.value,
    MODE_PROFILES.search.editing,
  );
  assert.equal(
    explanation.settings.editing.winner.sourceId,
    "built-in-mode-profile",
  );
  assert.equal(
    explanation.settings.searchDepth.value,
    MODE_PROFILES.search.searchDepth,
  );

  const activeModeSection = explanation.prompt.sections.find(
    (section) => section.id === "active-mode",
  );

  assert.ok(activeModeSection);
  assert.equal(activeModeSection.winner.sourceId, "built-in-mode-profile");
  assert.match(activeModeSection.body, /Search/);
});

test("config-core assembles the effective prompt and injects mode overlays declaratively", () => {
  const { workspaceRoot, userHomeDir } = createWorkspaceFixture();

  writeConfigFile(path.join(workspaceRoot, ".unclecode", "config.json"), {
    prompt: {
      sections: {
        "project-note": {
          title: "Project Note",
          body: "Respect repository conventions.",
        },
      },
    },
  });
  writeConfigFile(path.join(userHomeDir, ".unclecode", "config.json"), {
    prompt: {
      sections: {
        identity: {
          title: "Identity",
          body: "User override identity.",
        },
      },
    },
  });

  const explanation = explainUncleCodeConfig({
    workspaceRoot,
    userHomeDir,
    pluginOverlays: [
      {
        name: "example-plugin",
        config: {
          prompt: {
            sections: {
              "plugin-note": {
                title: "Plugin Note",
                body: "Plugin overlay note.",
              },
            },
          },
        },
      },
    ],
    cliFlags: { mode: "ultrawork" },
  });

  assert.deepEqual(
    explanation.prompt.sections.map((section) => section.id),
    ["identity", "execution", "plugin-note", "project-note", "active-mode"],
  );
  assert.equal(explanation.prompt.sections[0]?.winner.sourceId, "user-config");
  assert.equal(
    explanation.prompt.sections[2]?.winner.sourceId,
    "plugin-overlay",
  );
  assert.equal(
    explanation.prompt.sections[3]?.winner.sourceId,
    "project-config",
  );
  assert.equal(
    explanation.prompt.sections[4]?.winner.sourceId,
    "built-in-mode-profile",
  );
  assert.match(explanation.prompt.rendered, /User override identity\./);
  assert.match(explanation.prompt.rendered, /Plugin overlay note\./);
  assert.match(explanation.prompt.rendered, /Respect repository conventions\./);
  assert.match(explanation.prompt.rendered, /Ultra Work/);
  assert.match(explanation.prompt.rendered, /background tasks: preferred/i);
});

test("config-core explains when a file-backed source is broken instead of treating it as silent no-op", () => {
  const { workspaceRoot, userHomeDir } = createWorkspaceFixture();

  writeRawFile(
    path.join(workspaceRoot, ".unclecode", "config.json"),
    '{\n  "model": "broken",\n',
  );

  const explanation = explainUncleCodeConfig({
    workspaceRoot,
    userHomeDir,
  });
  const formatted = formatUncleCodeConfigExplanation(explanation);

  assert.ok(
    explanation.sourceIssues.some(
      (issue) => issue.sourceId === "project-config",
    ),
  );
  assert.match(formatted, /Broken sources:/);
  assert.match(formatted, /project config/i);
  assert.match(formatted, /invalid json|unexpected end/i);
});

test("config-core preserves null prompt-section deletion provenance in the explanation surface", () => {
  const { workspaceRoot, userHomeDir } = createWorkspaceFixture();

  writeConfigFile(path.join(workspaceRoot, ".unclecode", "config.json"), {
    prompt: {
      sections: {
        "project-note": {
          title: "Project Note",
          body: "This note was deleted upstream.",
        },
      },
    },
  });
  writeConfigFile(path.join(userHomeDir, ".unclecode", "config.json"), {
    prompt: {
      sections: {
        "project-note": null,
      },
    },
  });

  const explanation = explainUncleCodeConfig({
    workspaceRoot,
    userHomeDir,
  });
  const deletedSection = explanation.prompt.sections.find(
    (section) => section.id === "project-note",
  );
  const formatted = formatUncleCodeConfigExplanation(explanation);

  assert.ok(deletedSection);
  assert.equal(deletedSection.deleted, true);
  assert.equal(deletedSection.winner.sourceId, "user-config");
  assert.equal(deletedSection.winner.value, null);
  assert.deepEqual(
    deletedSection.contributors.map((contributor) => contributor.sourceId),
    ["project-config", "user-config"],
  );
  assert.doesNotMatch(
    explanation.prompt.rendered,
    /This note was deleted upstream\./,
  );
  assert.match(formatted, /project-note \(deleted\)/i);
  assert.match(formatted, /user config=null/i);
});
