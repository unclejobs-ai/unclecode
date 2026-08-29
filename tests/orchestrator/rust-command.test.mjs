import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isRustEntrypointStale } from "../../packages/orchestrator/src/index.ts";

test("isRustEntrypointStale detects source changes newer than target binary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-rust-entrypoint-"));
  const rustSource = path.join(root, "rust", "unclecode-core", "src");
  const targetDir = path.join(root, "target", "debug");
  mkdirSync(rustSource, { recursive: true });
  mkdirSync(targetDir, { recursive: true });

  const binary = path.join(targetDir, "unclecode");
  writeFileSync(path.join(root, "Cargo.toml"), "[workspace]\n");
  writeFileSync(path.join(root, "Cargo.lock"), "# lock\n");
  writeFileSync(path.join(rustSource, "lib.rs"), "pub fn old() {}\n");
  writeFileSync(binary, "#!/bin/sh\n");

  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const newTime = new Date("2026-01-02T00:00:00.000Z");
  utimesSync(binary, oldTime, oldTime);
  utimesSync(path.join(rustSource, "lib.rs"), newTime, newTime);

  assert.equal(isRustEntrypointStale(root, binary), true);
});

test("aborting a Rust tool command waits for TERM to bounded KILL process-group settlement", {
  skip: process.platform === "win32" ? "process-group settlement is POSIX-only" : false,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-rust-abort-settlement-"));
  const command = path.join(root, "stubborn-rust-command");
  const pidPath = path.join(root, "child.pid");
  const termPath = path.join(root, "child.term");
  writeFileSync(command, [
    "#!/bin/sh",
    'trap \'printf TERM > "$TERM_PATH"\' TERM',
    'printf "%s" "$$" > "$PID_PATH"',
    "while :; do sleep 1; done",
    "",
  ].join("\n"), "utf8");
  chmodSync(command, 0o700);
  const previous = process.env.UNCLECODE_RUST_BIN;
  process.env.UNCLECODE_RUST_BIN = command;
  let pid;

  try {
    const { runRustCommand } = await import(`../../packages/orchestrator/src/rust-command.ts?abort-settlement=${Date.now()}`);
    const controller = new AbortController();
    const pending = runRustCommand(
      ["ignored"],
      root,
      "",
      { ...process.env, PID_PATH: pidPath, TERM_PATH: termPath },
      { signal: controller.signal, forceKillDelayMs: 50 },
    );
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(pidPath), true);
    pid = Number(readFileSync(pidPath, "utf8"));

    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });

    assert.equal(readFileSync(termPath, "utf8"), "TERM");
    assert.throws(() => process.kill(pid, 0), error => error?.code === "ESRCH");
  } finally {
    if (previous === undefined) delete process.env.UNCLECODE_RUST_BIN;
    else process.env.UNCLECODE_RUST_BIN = previous;
    if (Number.isInteger(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});
