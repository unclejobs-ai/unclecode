import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkShellCommandRegistry,
  getWorkShellSlashSuggestions,
  isAgentConsoleTab,
  listWorkShellSlashSuggestionEntries,
  resolveWorkShellBuiltinCommand,
  resolveWorkShellSlashCommand,
} from "@unclecode/orchestrator";
import { resolveWorkShellSubmitRoute } from "../../packages/orchestrator/src/work-shell-engine-submit.ts";

const AGENT_CONSOLE_COMMANDS = [
  ["/agents", "agents"],
  ["/jobs", "jobs"],
  ["/todo", "plan"],
];

const AGENT_CONSOLE_DESCRIPTIONS = {
  "/agents": "에이전트 실행 상태와 transcript를 엽니다",
  "/jobs": "백그라운드 job 상태를 엽니다",
  "/todo": "현재 WorkGraph 진행 상태를 엽니다",
};

test("Rust resolves every agent console command to the single builtin shape", () => {
  for (const [line, tab] of AGENT_CONSOLE_COMMANDS) {
    assert.deepEqual(resolveWorkShellBuiltinCommand(line), { kind: "agent-console", tab });
  }
});

test("agent console commands submit as builtins instead of chat or inline commands", () => {
  for (const [line, tab] of AGENT_CONSOLE_COMMANDS) {
    assert.deepEqual(
      resolveWorkShellSubmitRoute({
        value: line,
        isBusy: false,
        composerMode: "default",
        resolveWorkShellSlashCommand: () => undefined,
        hasInlineCommandRunner: true,
      }),
      { kind: "builtin", line, command: { kind: "agent-console", tab } },
    );
  }
});

test("agent console tab validation fails closed on missing and unknown tabs", () => {
  assert.equal(isAgentConsoleTab("agents"), true);
  assert.equal(isAgentConsoleTab("jobs"), true);
  assert.equal(isAgentConsoleTab("plan"), true);

  assert.equal(isAgentConsoleTab("todo"), false);
  assert.equal(isAgentConsoleTab(""), false);
  assert.equal(isAgentConsoleTab(undefined), false);
  assert.equal(isAgentConsoleTab(null), false);
  assert.equal(isAgentConsoleTab(0), false);
  assert.equal(isAgentConsoleTab(["agents"]), false);
});

test("agent console commands route to their console subcommand through the work shell slash map", () => {
  assert.deepEqual(resolveWorkShellSlashCommand("/agents"), ["agents"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/jobs"), ["jobs"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/todo"), ["todo"]);
});

test("console command prefixes never resolve to a route in either canonical registry", () => {
  for (const prefix of ["/agent", "/agen", "/job", "/tod"]) {
    assert.equal(
      resolveWorkShellSlashCommand(prefix),
      undefined,
      `${prefix} must not prefix-resolve to a console route`,
    );
    assert.equal(
      createWorkShellCommandRegistry().resolve(prefix),
      undefined,
      `${prefix} must not prefix-resolve inside the TS registry`,
    );
  }
});

test("argument-bearing console lines resolve to nothing instead of an inline command", () => {
  for (const line of ["/agents extra", "/jobs 1", "/todo now"]) {
    assert.equal(resolveWorkShellSlashCommand(line), undefined);
    assert.equal(createWorkShellCommandRegistry().resolve(line), undefined);
    assert.equal(resolveWorkShellBuiltinCommand(line), undefined);
  }
});

test("every console-like invalid form routes to a Rust-marked silent no-op", () => {
  for (const line of [
    "/agent",
    "/agen",
    "/age",
    "/job",
    "/tod",
    "/agents extra",
    "/jobs extra",
    "/todo extra",
  ]) {
    const route = resolveWorkShellSubmitRoute({
      value: line,
      isBusy: false,
      composerMode: "default",
      resolveWorkShellSlashCommand,
      hasInlineCommandRunner: true,
    });

    assert.equal(route?.kind, "builtin", `${line} must not route to chat or an inline command`);
    assert.equal(route?.command.kind, "unknown-slash");
    assert.equal(route?.command.consoleInvalid, true, `${line} must carry the Rust silent marker`);
    assert.equal(route?.command.suggestion, undefined, `${line} must not carry guidance copy`);
  }
});

test("an ordinary unknown slash command is never marked console-invalid", () => {
  const route = resolveWorkShellSubmitRoute({
    value: "/definitely-unknown",
    isBusy: false,
    composerMode: "default",
    resolveWorkShellSlashCommand,
    hasInlineCommandRunner: true,
  });

  assert.equal(route?.kind, "builtin");
  assert.equal(route?.command.kind, "unknown-slash");
  assert.equal(route?.command.consoleInvalid, undefined);
});

test("agent console commands are discoverable once with their registry copy", () => {
  const entries = listWorkShellSlashSuggestionEntries();

  for (const [command, description] of Object.entries(AGENT_CONSOLE_DESCRIPTIONS)) {
    const matches = entries.filter((entry) => entry.command === command);
    assert.equal(matches.length, 1, `${command} must be registered exactly once`);
    assert.equal(matches[0]?.description, description);

    const suggestions = getWorkShellSlashSuggestions(command);
    const suggested = suggestions.filter((entry) => entry.command === command);
    assert.equal(suggested.length, 1, `${command} must be suggested exactly once`);
    assert.equal(suggested[0]?.description, description);
  }
});

test("agent console commands stay in the bare-slash quick picks", () => {
  const commands = getWorkShellSlashSuggestions("/").map((entry) => entry.command);

  assert.ok(commands.includes("/agents"));
  assert.ok(commands.includes("/jobs"));
  assert.ok(commands.includes("/todo"));
});
