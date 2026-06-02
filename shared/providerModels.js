import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);

export function providerLabel(provider) {
  return parseRustKeyValueLines(runRustModelCommand(["label", provider])).get("label") ?? provider;
}

export function providerModelCatalog(provider, env = process.env) {
  return runRustModelCommand(["catalog", provider], env)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("model="))
    .map((line) => line.slice("model=".length).trim())
    .filter((model) => model.length > 0);
}

export function providerPromptSuggestions(provider, env = process.env) {
  return providerModelCatalog(provider, env);
}

export function providerAdditionalModelOptions(provider, env = process.env) {
  const label = providerLabel(provider);
  return providerModelCatalog(provider, env).map((model) => ({
    value: model,
    label: model,
    description: `${label} model`,
  }));
}

function parseRustKeyValueLines(stdout) {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts) => parts.length === 2),
  );
}

function runRustModelCommand(args, env = process.env) {
  const rust = findRustEntrypoint();
  return execFileSync(rust.command, [...rust.argsPrefix, "rust", "model", ...args], {
    cwd: rust.runCwd ?? process.cwd(),
    env: { ...process.env, ...env, UNCLECODE_WORK_CWD: process.cwd() },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

function findRustEntrypoint() {
  if (process.env.UNCLECODE_RUST_BIN) {
    return { command: process.env.UNCLECODE_RUST_BIN, argsPrefix: [] };
  }
  for (const start of [path.dirname(modulePath), process.cwd()]) {
    let cursor = path.resolve(start);
    while (true) {
      for (const candidate of [
        path.join(cursor, "target", "release", "unclecode"),
        path.join(cursor, "target", "debug", "unclecode"),
      ]) {
        if (existsSync(candidate)) {
          return { command: candidate, argsPrefix: [] };
        }
      }
      if (existsSync(path.join(cursor, "Cargo.toml")) && existsSync(path.join(cursor, "rust"))) {
        return {
          command: "cargo",
          argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
          runCwd: cursor,
        };
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }
  return {
    command: "cargo",
    argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
    runCwd: process.cwd(),
  };
}
