import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  lowerBusyActivityRowPattern,
  runTmux,
  runtimeTmuxArgs,
  runtimeTmuxEnvironment,
  typedComposerLinePattern,
  waitForPane,
} from "../../scripts/runtime-qa/tmux-helpers.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("busy activity detector matches whitespace-prefixed spinner rows", () => {
  const genericPattern = lowerBusyActivityRowPattern();
  const detailedPattern = lowerBusyActivityRowPattern("thinking");

  assert.match("\n  ⠁ thinking", genericPattern);
  assert.match("\n\t⠂ thinking", detailedPattern);
  assert.doesNotMatch("\nstatus: thinking", genericPattern);
});

test("typed composer pattern waits for the actual input line instead of static command help", () => {
  const pattern = typedComposerLinePattern("/context");

  assert.doesNotMatch("Type a task, /context, or @file.", pattern);
  assert.doesNotMatch("\n  › /context  Inspect the context packet.", pattern);
  assert.match("\n  › /context▏", pattern);
});

test("runtime QA tmux children stay interactive under CI runners", () => {
  const source = { CI: "1", NO_COLOR: "1", PATH: "/bin" };

  assert.deepEqual(runtimeTmuxEnvironment(source), { PATH: "/bin" });
  assert.deepEqual(source, { CI: "1", NO_COLOR: "1", PATH: "/bin" });
});

test("runtime QA tmux commands use an isolated socket", () => {
  const args = runtimeTmuxArgs(["new-session", "-d", "-s", "qa"]);

  assert.deepEqual(args.slice(0, 4), [
    "-f",
    "/dev/null",
    "-L",
    `unclecode-runtime-qa-${process.pid}`,
  ]);
  assert.deepEqual(args.slice(4), ["new-session", "-d", "-s", "qa"]);
});

test("runtime QA tmux helper starts the requested pane command", async (context) => {
  const tmuxAvailable = await runTmux(["-V"], { allowFailure: true });
  if (tmuxAvailable.code !== 0) {
    context.skip("tmux is unavailable in this environment");
    return;
  }

  const directory = mkdtempSync(path.join(tmpdir(), "unclecode-runtime-tmux-"));
  const session = `runtime-helper-${process.pid}-${Date.now()}`;
  const preservedSession = `${session}-preserved`;
  try {
    await runTmux([
      "new-session",
      "-d",
      "-x",
      "80",
      "-y",
      "8",
      "-s",
      session,
      "printf 'tmux command ready'; sleep 30",
    ]);

    const pane = await waitForPane(session, /tmux command ready/, path.join(directory, "pane.txt"));
    assert.match(pane, /tmux command ready/);
    await runTmux([
      "new-session",
      "-d",
      "-x",
      "80",
      "-y",
      "8",
      "-s",
      preservedSession,
      "sleep 30",
    ]);
    await runTmux(["kill-session", "-t", `=${session}`], { allowFailure: true });

    const closed = await runTmux(["has-session", "-t", `=${session}`], {
      allowFailure: true,
    });
    const preserved = await runTmux(["has-session", "-t", `=${preservedSession}`], {
      allowFailure: true,
    });
    assert.notEqual(closed.code, 0);
    assert.equal(preserved.code, 0);
  } finally {
    await runTmux(["kill-session", "-t", `=${session}`], { allowFailure: true });
    await runTmux(["kill-session", "-t", `=${preservedSession}`], { allowFailure: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime QA smokes route tmux calls through the isolated helper", () => {
  const runtimeQaDirectory = path.join(workspaceRoot, "scripts", "runtime-qa");
  const smokeFiles = readdirSync(runtimeQaDirectory)
    .filter((fileName) => fileName.endsWith(".mjs") && fileName !== "tmux-helpers.mjs");

  for (const fileName of smokeFiles) {
    const source = readFileSync(path.join(runtimeQaDirectory, fileName), "utf8");
    assert.doesNotMatch(source, /run\("tmux"/, `${fileName} should use runTmux`);
  }
});

test("runtime QA smokes pin child launches to the verified Node runtime", () => {
  const runtimeQaDirectory = path.join(workspaceRoot, "scripts", "runtime-qa");
  const smokeFiles = readdirSync(runtimeQaDirectory)
    .filter((fileName) => fileName.endsWith(".mjs") && fileName !== "tmux-helpers.mjs");

  for (const fileName of smokeFiles) {
    const source = readFileSync(path.join(runtimeQaDirectory, fileName), "utf8");
    if (!source.includes("bin/unclecode.cjs")) {
      continue;
    }
    assert.match(source, /shellQuote\(process\.execPath\)/, `${fileName} should pin process.execPath`);
    assert.doesNotMatch(source, /["'`]node bin\/unclecode\.cjs/, `${fileName} should not resolve Node through PATH`);
  }
});
