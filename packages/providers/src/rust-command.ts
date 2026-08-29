import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
let cachedRustEntrypoint: { command: string; argsPrefix: string[]; runCwd?: string } | undefined;

export type RunRustCommandOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly forceKillDelayMs?: number | undefined;
};

function signalChildProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child if process-group signalling is unavailable.
    }
  }
  child.kill(signal);
}

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

export async function runRustCommand(
  args: readonly string[],
  cwd: string,
  stdin?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: RunRustCommandOptions = {},
): Promise<string> {
  const rust = findRustEntrypoint();
  const childEnv = { ...process.env, ...env, UNCLECODE_WORK_CWD: cwd };
  if (stdin !== undefined) {
    return await new Promise((resolvePromise, reject) => {
      if (options.signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const child = spawn(rust.command, [...rust.argsPrefix, ...args], {
        cwd: rust.runCwd ?? cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let aborted = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let stdout = "";
      let stderr = "";
      const settle = (kind: "resolve" | "reject", value: string | Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (kind === "resolve") {
          resolvePromise(String(value));
          return;
        }
        reject(value);
      };
      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        signalChildProcess(child, "SIGTERM");
        forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            signalChildProcess(child, "SIGKILL");
          }
        }, Math.max(0, options.forceKillDelayMs ?? 2_000));
        forceTimer.unref();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => settle("reject", error));
      child.on("close", (code) => {
        if (aborted) {
          settle("reject", createAbortError());
          return;
        }
        if (code === 0) {
          settle("resolve", stdout);
          return;
        }
        settle("reject", new Error(`${stdout}${stderr}`.trim() || `Rust command exited ${code}`));
      });
      child.stdin.end(stdin);
    });
  }
  try {
    const result = await execFileAsync(rust.command, [...rust.argsPrefix, ...args], {
      cwd: rust.runCwd ?? cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: childEnv,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return result.stdout;
  } catch (error) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
    throw new Error(output || (error instanceof Error ? error.message : String(error)));
  }
}

function createAbortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

export function runRustCommandSync(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  stdin?: string,
): string {
  const rust = findRustEntrypoint();
  const childEnv = { ...process.env, ...env, UNCLECODE_WORK_CWD: cwd };
  try {
    return execFileSync(rust.command, [...rust.argsPrefix, ...args], {
      cwd: rust.runCwd ?? cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: childEnv,
      encoding: "utf8",
      input: stdin,
    });
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
    throw new Error(output || (error instanceof Error ? error.message : String(error)));
  }
}
