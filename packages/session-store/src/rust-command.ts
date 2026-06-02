import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
let cachedRustEntrypoint: { command: string; argsPrefix: string[]; runCwd?: string } | undefined;

function findWorkspaceRoot(start: string): string | undefined {
  let cursor = path.resolve(start);
  while (true) {
    if (existsSync(path.join(cursor, "Cargo.toml")) && existsSync(path.join(cursor, "rust"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

function resolveExplicitRustCommand(explicit: string): string {
  if (path.isAbsolute(explicit)) {
    return explicit;
  }

  for (const start of [path.dirname(modulePath), process.cwd()]) {
    const root = findWorkspaceRoot(start);
    if (!root) {
      continue;
    }
    const candidate = path.resolve(root, explicit);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), explicit);
}

function findRustEntrypoint(): { command: string; argsPrefix: string[]; runCwd?: string } {
  if (cachedRustEntrypoint) {
    return cachedRustEntrypoint;
  }

  const explicit = process.env.UNCLECODE_RUST_BIN;
  if (explicit) {
    cachedRustEntrypoint = { command: resolveExplicitRustCommand(explicit), argsPrefix: [] };
    return cachedRustEntrypoint;
  }

  for (const start of [path.dirname(modulePath), process.cwd()]) {
    let cursor = path.resolve(start);
    while (true) {
      for (const candidate of [
        path.join(cursor, "target", "release", "unclecode"),
        path.join(cursor, "target", "debug", "unclecode"),
      ]) {
        if (existsSync(candidate)) {
          cachedRustEntrypoint = { command: candidate, argsPrefix: [] };
          return cachedRustEntrypoint;
        }
      }
      if (existsSync(path.join(cursor, "Cargo.toml")) && existsSync(path.join(cursor, "rust"))) {
        cachedRustEntrypoint = {
          command: "cargo",
          argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
          runCwd: cursor,
        };
        return cachedRustEntrypoint;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }

  cachedRustEntrypoint = {
    command: "cargo",
    argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
    runCwd: process.cwd(),
  };
  return cachedRustEntrypoint;
}

export function runRustCommandSync(args: readonly string[], cwd: string, stdin?: string): string {
  const rust = findRustEntrypoint();
  try {
    return execFileSync(rust.command, [...rust.argsPrefix, ...args], {
      cwd: rust.runCwd ?? cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, UNCLECODE_WORK_CWD: cwd },
      encoding: "utf8",
      input: stdin,
    });
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
    throw new Error(output || (error instanceof Error ? error.message : String(error)));
  }
}
