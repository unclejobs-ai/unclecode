import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../scripts/health-qa/runner.mjs";

test("health runner terminates a timed-out child and marks it as failed", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10_000)"],
    { timeoutMs: 50, killGraceMs: 50 },
  );

  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.equal(result.timeoutMs, 50);
});

test("health runner does not coerce signal-terminated children to success", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "process.kill(process.pid, 'SIGTERM')"],
    { timeoutMs: 5_000, killGraceMs: 50 },
  );

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGTERM");
  assert.notEqual(result.code, 0);
});

test("health runner reports spawn failures as failed results", async () => {
  const result = await runCommand(
    "__unclecode_missing_health_command__",
    [],
    { timeoutMs: 5_000, killGraceMs: 50 },
  );

  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /__unclecode_missing_health_command__/);
});

test("health runner terminates timed-out child process descendants", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unclecode-health-runner-"));
  const markerPath = path.join(directory, "orphan-marker.txt");
  const grandchildScript = [
    "setTimeout(() => require('node:fs').writeFileSync(",
    JSON.stringify(markerPath),
    ", 'orphan'), 250);",
    "setTimeout(() => {}, 2_000);",
  ].join("");
  const parentScript = [
    "require('node:child_process').spawn(process.execPath, ['-e', ",
    JSON.stringify(grandchildScript),
    "], { stdio: 'ignore' }).unref();",
    "setTimeout(() => {}, 10_000);",
  ].join("");

  try {
    const result = await runCommand(
      process.execPath,
      ["-e", parentScript],
      { timeoutMs: 50, killGraceMs: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(result.timedOut, true);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("health runner timeout prevents detached descendants from outliving the check", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "unclecode-health-detached-runner-"));
  const controlMarkerPath = path.join(directory, "detached-control-marker.txt");
  const timeoutSpawnMarkerPath = path.join(directory, "detached-timeout-spawned.txt");
  const timeoutMarkerPath = path.join(directory, "detached-timeout-marker.txt");

  try {
    const control = await runCommand(
      process.execPath,
      ["-e", detachedChildParentScript(controlMarkerPath, 80, 150)],
      { timeoutMs: 5_000, killGraceMs: 50 },
    );
    await waitForFile(controlMarkerPath, 1_500);

    assert.equal(control.timedOut, false);
    assert.match(control.stdout, /detached child spawned/);
    assert.equal(existsSync(controlMarkerPath), true);

    const timedOut = await runCommand(
      process.execPath,
      ["-e", detachedChildParentScript(timeoutMarkerPath, 4_000, 10_000, timeoutSpawnMarkerPath)],
      { timeoutMs: 2_000, killGraceMs: 200 },
    );
    await waitForFile(timeoutSpawnMarkerPath, 2_500);
    await new Promise((resolve) => setTimeout(resolve, 4_500));

    assert.equal(timedOut.timedOut, true);
    assert.equal(existsSync(timeoutSpawnMarkerPath), true);
    assert.equal(existsSync(timeoutMarkerPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function detachedChildParentScript(markerPath, markerDelayMs, parentHoldMs, spawnMarkerPath) {
  const childScript = [
    "setTimeout(() => require('node:fs').writeFileSync(",
    JSON.stringify(markerPath),
    ", 'detached'), ",
    String(markerDelayMs),
    ");",
    "setTimeout(() => {}, 2_000);",
  ].join("");
  return [
    "require('node:child_process').spawn(process.execPath, ['-e', ",
    JSON.stringify(childScript),
    "], { detached: true, stdio: 'ignore' }).unref();",
    ...(spawnMarkerPath
      ? [
          "require('node:fs').writeFileSync(",
          JSON.stringify(spawnMarkerPath),
          ", 'spawned');",
        ]
      : []),
    "process.stdout.write('detached child spawned\\n');",
    "setTimeout(() => {}, ",
    String(parentHoldMs),
    ");",
  ].join("");
}
