import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const worktreeDir = fileURLToPath(new URL("../../", import.meta.url));
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-rust-command-test-"));
const fakeRustPath = path.join(fixtureDir, "fake-rust.mjs");
const runnerPath = path.join(fixtureDir, "runner.mjs");
let runRustCommandSync;

function runChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runnerPath, ...args], {
      cwd: worktreeDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`runner exited ${code ?? signal}: ${stderr}`));
      }
    });
  });
}

before(async () => {
  writeFileSync(
    fakeRustPath,
    `#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";

const mode = process.argv.at(-1);
const inputPath = process.env.UNCLECODE_RUST_INPUT_FILE;
if (!inputPath) {
  process.stderr.write("missing UNCLECODE_RUST_INPUT_FILE");
  process.exit(40);
}
if (process.env.UNCLECODE_TEST_OBSERVATION_PATH) {
  writeFileSync(process.env.UNCLECODE_TEST_OBSERVATION_PATH, inputPath, "utf8");
}
if (mode === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
}
if (mode === "failure") {
  process.stderr.write("intentional fixture failure");
  process.exit(41);
}
const content = readFileSync(inputPath);
process.stdout.write(JSON.stringify({
  content: content.toString("utf8"),
  inputPath,
  mode: statSync(inputPath).mode & 0o777,
}));
`,
    { mode: 0o700 },
  );
  chmodSync(fakeRustPath, 0o700);
  process.env.UNCLECODE_RUST_BIN = fakeRustPath;
  ({ runRustCommandSync } = await import(
    `../../packages/context-broker/src/rust-command.ts?temp-input=${Date.now()}`
  ));

  const rustCommandUrl = pathToFileURL(
    path.join(worktreeDir, "packages/context-broker/src/rust-command.ts"),
  ).href;
  writeFileSync(
    runnerPath,
    `const [rustCommandUrl, cwd, size] = process.argv.slice(2);
const { runRustCommandSync } = await import(rustCommandUrl);
const result = runRustCommandSync(["rust", "context", "selection", cwd, "default", "-", "success"], cwd, "x".repeat(Number(size)));
process.stdout.write(result);
`,
    "utf8",
  );
  process.env.UNCLECODE_TEST_RUST_COMMAND_URL = rustCommandUrl;
});

after(() => {
  delete process.env.UNCLECODE_RUST_BIN;
  delete process.env.UNCLECODE_TEST_RUST_COMMAND_URL;
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("runRustCommandSync payload transport", () => {
  it("uses a private temporary input file and removes it after success", () => {
    const result = JSON.parse(runRustCommandSync(["success"], worktreeDir, "payload"));

    assert.equal(result.content, "payload");
    assert.equal(result.mode, 0o600);
    assert.ok(result.inputPath.startsWith(`${os.tmpdir()}${path.sep}`));
    assert.ok(!result.inputPath.startsWith(`${worktreeDir}${path.sep}`));
    assert.equal(existsSync(result.inputPath), false);
    assert.equal(existsSync(path.dirname(result.inputPath)), false);
  });

  it("removes the temporary input after a Rust command failure", () => {
    const observationPath = path.join(fixtureDir, "failure-path.txt");

    assert.throws(
      () =>
        runRustCommandSync(["failure"], worktreeDir, "payload", {
          ...process.env,
          UNCLECODE_TEST_OBSERVATION_PATH: observationPath,
        }),
      /intentional fixture failure/,
    );

    const inputPath = readFileSync(observationPath, "utf8");
    assert.equal(existsSync(inputPath), false);
    assert.equal(existsSync(path.dirname(inputPath)), false);
  });

  it("times out a stuck Rust command and removes its temporary input", () => {
    const observationPath = path.join(fixtureDir, "timeout-path.txt");

    assert.throws(() =>
      runRustCommandSync(["timeout"], worktreeDir, "payload", {
        ...process.env,
        UNCLECODE_RUST_COMMAND_TIMEOUT_MS: "500",
        UNCLECODE_TEST_OBSERVATION_PATH: observationPath,
      }),
    );

    const inputPath = readFileSync(observationPath, "utf8");
    assert.equal(existsSync(inputPath), false);
    assert.equal(existsSync(path.dirname(inputPath)), false);
  });

  it("rejects payloads larger than the bounded transport limit", () => {
    assert.throws(
      () => runRustCommandSync(["success"], worktreeDir, Buffer.alloc(8 * 1024 * 1024 + 1)),
      /exceeds the 8388608-byte limit/,
    );
  });

  it("completes selection-heavy payloads in parallel processes", async () => {
    const env = {
      ...process.env,
      UNCLECODE_RUST_BIN: fakeRustPath,
    };
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runChild([process.env.UNCLECODE_TEST_RUST_COMMAND_URL, worktreeDir, String(1024 * 1024)], env),
      ),
    );

    for (const output of outputs) {
      const result = JSON.parse(output);
      assert.equal(result.content.length, 1024 * 1024);
      assert.equal(existsSync(result.inputPath), false);
    }
  });
});
