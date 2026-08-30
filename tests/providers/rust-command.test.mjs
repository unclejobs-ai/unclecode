import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("an explicit env preserves launcher variables needed for Cargo fallback", {
  skip: process.platform === "win32" ? "requires a real cargo.exe fixture" : false,
}, (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "unclecode-rust-command-path-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, "rust"));
  writeFileSync(path.join(workspace, "Cargo.toml"), "[workspace]\n", "utf8");
  const copiedRustCommand = path.join(workspace, "rust-command.ts");
  copyFileSync(
    path.join(repoRoot, "packages", "providers", "src", "rust-command.ts"),
    copiedRustCommand,
  );

  const commandName = "cargo";
  const probeDir = path.join(workspace, "bin");
  mkdirSync(probeDir);
  const commandPath = path.join(probeDir, commandName);
  writeFileSync(commandPath, "#!/bin/sh\nprintf 'path-ok\\n'\n", "utf8");
  chmodSync(commandPath, 0o755);

  const rustCommandUrl = pathToFileURL(copiedRustCommand).href;
  const probe = [
    `import { runRustCommandSync } from ${JSON.stringify(rustCommandUrl)};`,
    "process.stdout.write(runRustCommandSync([], process.cwd(), {}).trim());",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      probe,
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: probeDir,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "path-ok");
});

test("caller launcher variables override inherited values", () => {
  const rustCommandUrl = pathToFileURL(
    path.join(repoRoot, "packages", "providers", "src", "rust-command.ts"),
  ).href;
  const requestedPathKey = process.platform === "win32" ? "Path" : "PATH";
  const childProbe = "process.stdout.write(process.env.PATH ?? process.env.Path ?? '')";
  const probe = [
    `process.env.UNCLECODE_RUST_BIN = process.execPath;`,
    `const { runRustCommandSync } = await import(${JSON.stringify(rustCommandUrl)});`,
    `const output = runRustCommandSync(["--input-type=module", "--eval", ${JSON.stringify(childProbe)}], process.cwd(), { [${JSON.stringify(requestedPathKey)}]: "caller-path" });`,
    "process.stdout.write(output);",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      probe,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "caller-path");
});
