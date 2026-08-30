import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const binEntrypoint = path.join(workspaceRoot, "bin/unclecode.cjs");

function createLinkedLauncherFixture({
  callerWorkspace = false,
  cargoWorkspace = false,
  rustBinary = false,
} = {}) {
  const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "unclecode-linked-bin-")));
  const packageRoot = path.join(fixtureRoot, "package");
  const packageBinDirectory = path.join(packageRoot, "bin");
  const linkedBinDirectory = path.join(fixtureRoot, "global", "bin");
  const unrelatedCwd = path.join(fixtureRoot, "unrelated-project");
  const packageLauncher = path.join(packageBinDirectory, "unclecode.cjs");
  const linkedLauncher = path.join(linkedBinDirectory, "unclecode");

  mkdirSync(packageBinDirectory, { recursive: true });
  mkdirSync(linkedBinDirectory, { recursive: true });
  mkdirSync(unrelatedCwd, { recursive: true });
  copyFileSync(binEntrypoint, packageLauncher);
  symlinkSync(packageLauncher, linkedLauncher);

  if (callerWorkspace) {
    mkdirSync(path.join(unrelatedCwd, "apps", "unclecode-cli"), { recursive: true });
    mkdirSync(path.join(unrelatedCwd, "packages", "orchestrator"), { recursive: true });
    writeFileSync(path.join(unrelatedCwd, "package.json"), "{}\n", "utf8");
  }

  if (cargoWorkspace) {
    writeFileSync(path.join(packageRoot, "Cargo.toml"), "[workspace]\n", "utf8");
  }

  if (rustBinary) {
    const binaryPath = path.join(packageRoot, "target", "release", "unclecode");
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(
      binaryPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  cwd: process.cwd(),",
        "  args: process.argv.slice(2),",
        "  repoRoot: process.env.UNCLECODE_REPO_ROOT,",
        "}));",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(binaryPath, 0o755);
  }

  return { fixtureRoot, linkedLauncher, packageRoot, unrelatedCwd };
}

function runLinkedLauncher(fixture, args = [], env = {}) {
  return spawnSync(
    process.execPath,
    ["--preserve-symlinks-main", fixture.linkedLauncher, ...args],
    {
      cwd: fixture.unrelatedCwd,
      encoding: "utf8",
      env: { ...process.env, UNCLECODE_DISABLE_RUST_BRIDGE: "", ...env },
    },
  );
}

test("release surface exposes UncleCode help and version from the root bin", () => {
  const versionResult = spawnSync("node", [binEntrypoint, "--version"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const helpResult = spawnSync("node", [binEntrypoint, "--help"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(versionResult.stdout.trim(), /^0\.1\.0$/);
  assert.match(helpResult.stdout, /UncleCode workspace shell/i);
  assert.doesNotMatch(helpResult.stdout, /claw-dev/i);
});

test("linked launcher pins its real package root from another UncleCode checkout", () => {
  const fixture = createLinkedLauncherFixture({ callerWorkspace: true, rustBinary: true });

  try {
    const result = runLinkedLauncher(fixture, ["doctor", "--json"], {
      UNCLECODE_REPO_ROOT: fixture.unrelatedCwd,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: fixture.unrelatedCwd,
      args: ["doctor", "--json"],
      repoRoot: fixture.packageRoot,
    });
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("source launcher missing-binary error pins the build to its real package manifest", () => {
  const fixture = createLinkedLauncherFixture({ cargoWorkspace: true });

  try {
    const result = runLinkedLauncher(fixture);
    const manifestPath = path.join(fixture.packageRoot, "Cargo.toml");

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(escapeRegExp(fixture.packageRoot)));
    assert.match(
      result.stderr,
      new RegExp(`cargo build --manifest-path "${escapeRegExp(manifestPath)}" -p unclecode`),
    );
    assert.doesNotMatch(result.stderr, /Run `cargo build -p unclecode`/);
    assert.doesNotMatch(
      result.stderr,
      new RegExp(escapeRegExp(path.join(fixture.unrelatedCwd, "Cargo.toml"))),
    );
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installed launcher missing-binary error asks for reinstall instead of a source build", () => {
  const fixture = createLinkedLauncherFixture();

  try {
    const result = runLinkedLauncher(fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /installation is missing its Rust CLI binary/i);
    assert.match(result.stderr, /reinstall UncleCode/i);
    assert.doesNotMatch(result.stderr, /cargo build/);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
