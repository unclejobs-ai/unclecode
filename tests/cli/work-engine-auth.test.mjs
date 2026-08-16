import assert from "node:assert/strict";
import test from "node:test";
import { createUncleCodeProgram } from "../../apps/unclecode-cli/src/program.ts";
import { buildWorkCommandArgs } from "../../apps/unclecode-cli/src/work-bootstrap.ts";

import {
  resolveDefaultWorkEngine,
  resolveWorkShellAuthLabel,
} from "../../apps/unclecode-cli/src/work-engine-auth.ts";

test("pi is the default engine unless native is requested explicitly", () => {
  assert.equal(resolveDefaultWorkEngine({}), "pi");
  assert.equal(resolveDefaultWorkEngine({ UNCLECODE_WORK_ENGINE: "pi" }), "pi");
  assert.equal(resolveDefaultWorkEngine({ UNCLECODE_WORK_ENGINE: "anything" }), "pi");
  assert.equal(resolveDefaultWorkEngine({ UNCLECODE_WORK_ENGINE: "native" }), "native");
});

test("the pi engine reports API-blocked OAuth as usable only with Codex credentials", () => {
  assert.equal(
    resolveWorkShellAuthLabel({
      engine: "pi",
      configuredLabel: "oauth-file-api-blocked",
      codexOAuthAvailable: true,
    }),
    "oauth-pi",
  );
  assert.equal(
    resolveWorkShellAuthLabel({
      engine: "pi",
      configuredLabel: "oauth-env-api-blocked",
      codexOAuthAvailable: true,
    }),
    "oauth-pi",
  );
});

test("the pi engine keeps UncleCode OAuth file and env credentials API-blocked", () => {
  assert.equal(
    resolveWorkShellAuthLabel({
      engine: "pi",
      configuredLabel: "oauth-file-api-blocked",
      codexOAuthAvailable: false,
    }),
    "oauth-file-api-blocked",
  );
  assert.equal(
    resolveWorkShellAuthLabel({
      engine: "pi",
      configuredLabel: "oauth-env-api-blocked",
    }),
    "oauth-env-api-blocked",
  );
});

test("the native engine keeps the API-blocked warning and other labels pass through", () => {
  assert.equal(
    resolveWorkShellAuthLabel({ engine: "native", configuredLabel: "oauth-file-api-blocked" }),
    "oauth-file-api-blocked",
  );
  assert.equal(
    resolveWorkShellAuthLabel({ engine: "native", configuredLabel: "API key · file" }),
    "API key · file",
  );
  assert.equal(
    resolveWorkShellAuthLabel({ engine: "native", configuredLabel: "Not signed in" }),
    "Not signed in",
  );
});

test("the TUI command exposes the explicit engine override", () => {
  const program = createUncleCodeProgram();
  const tui = program.commands.find((command) => command.name() === "tui");
  assert.ok(tui);
  assert.equal(tui.options.some((option) => option.long === "--engine"), true);
});

test("work command arguments preserve the TUI smoke engine override", () => {
  assert.deepEqual(buildWorkCommandArgs([], { engine: "native" }), ["--engine", "native"]);
});
