import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const RUST_COMMAND_INPUT_FILE_ENV = "UNCLECODE_RUST_INPUT_FILE";
const RUST_COMMAND_TIMEOUT_ENV = "UNCLECODE_RUST_COMMAND_TIMEOUT_MS";
const MAX_RUST_COMMAND_INPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_RUST_COMMAND_TIMEOUT_MS = 120_000;
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

function rustCommandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const configured = env[RUST_COMMAND_TIMEOUT_ENV];
  if (configured === undefined) {
    return DEFAULT_RUST_COMMAND_TIMEOUT_MS;
  }

  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_RUST_COMMAND_TIMEOUT_MS) {
    throw new Error(
      `${RUST_COMMAND_TIMEOUT_ENV} must be an integer from 1 to ${DEFAULT_RUST_COMMAND_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export function runRustCommandSync(
  args: readonly string[],
  cwd: string,
  stdin?: string | Buffer,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rust = findRustEntrypoint();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, UNCLECODE_WORK_CWD: cwd };
  delete childEnv[RUST_COMMAND_INPUT_FILE_ENV];

  let inputDirectory: string | undefined;
  try {
    if (stdin !== undefined) {
      const byteLength = typeof stdin === "string" ? Buffer.byteLength(stdin) : stdin.byteLength;
      if (byteLength > MAX_RUST_COMMAND_INPUT_BYTES) {
        throw new Error(
          `Rust command input is ${byteLength} bytes, which exceeds the ${MAX_RUST_COMMAND_INPUT_BYTES}-byte limit`,
        );
      }

      inputDirectory = mkdtempSync(path.join(os.tmpdir(), "unclecode-rust-input-"));
      chmodSync(inputDirectory, 0o700);
      const inputPath = path.join(inputDirectory, "input");
      writeFileSync(inputPath, stdin, { flag: "wx", mode: 0o600 });
      childEnv[RUST_COMMAND_INPUT_FILE_ENV] = inputPath;
    }

    return execFileSync(rust.command, [...rust.argsPrefix, ...args], {
      cwd: rust.runCwd ?? cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: rustCommandTimeoutMs(childEnv),
      killSignal: "SIGKILL",
      env: childEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
    throw new Error(output || (error instanceof Error ? error.message : String(error)));
  } finally {
    if (inputDirectory) {
      rmSync(inputDirectory, { recursive: true, force: true });
    }
  }
}
