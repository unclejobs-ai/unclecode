import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
let cachedRustEntrypoint: RustEntrypoint | undefined;

type RustEntrypoint = {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly runCwd?: string;
  readonly fallback?: RustEntrypoint;
};

function cargoEntrypoint(root: string): RustEntrypoint {
  return {
    command: "cargo",
    argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
    runCwd: root,
  };
}

function newestMtimeMs(root: string): number {
  let newest = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(entryPath));
      continue;
    }
    if (entry.isFile()) {
      newest = Math.max(newest, statSync(entryPath).mtimeMs);
    }
  }
  return newest;
}

export function isRustEntrypointStale(root: string, binaryPath: string): boolean {
  const binaryMtime = statSync(binaryPath).mtimeMs;
  return newestMtimeMs(path.join(root, "rust")) > binaryMtime
    || statSync(path.join(root, "Cargo.toml")).mtimeMs > binaryMtime
    || statSync(path.join(root, "Cargo.lock")).mtimeMs > binaryMtime;
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

function resolveExplicitRustEntrypoint(explicit: string): RustEntrypoint {
  if (path.isAbsolute(explicit)) {
    return { command: explicit, argsPrefix: [] };
  }

  for (const start of [path.dirname(modulePath), process.cwd()]) {
    const root = findWorkspaceRoot(start);
    if (!root) {
      continue;
    }
    const candidate = path.resolve(root, explicit);
    if (existsSync(candidate)) {
      return { command: candidate, argsPrefix: [] };
    }
  }

  return { command: path.resolve(process.cwd(), explicit), argsPrefix: [] };
}

function findRustEntrypoint(): RustEntrypoint {
  if (cachedRustEntrypoint) {
    return cachedRustEntrypoint;
  }

  const explicit = process.env.UNCLECODE_RUST_BIN;
  if (explicit) {
    cachedRustEntrypoint = resolveExplicitRustEntrypoint(explicit);
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
          const cargo = cargoEntrypoint(cursor);
          cachedRustEntrypoint = isRustEntrypointStale(cursor, candidate)
            ? cargo
            : { command: candidate, argsPrefix: [], fallback: cargo };
          return cachedRustEntrypoint;
        }
      }
      if (existsSync(path.join(cursor, "Cargo.toml")) && existsSync(path.join(cursor, "rust"))) {
        cachedRustEntrypoint = cargoEntrypoint(cursor);
        return cachedRustEntrypoint;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }

  cachedRustEntrypoint = cargoEntrypoint(process.cwd());
  return cachedRustEntrypoint;
}

function isMissingEntrypoint(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function runRustCommandWithStdin(
  rust: RustEntrypoint,
  args: readonly string[],
  cwd: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(rust.command, [...rust.argsPrefix, ...args], {
      cwd: rust.runCwd ?? cwd,
      windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`${stdout}${stderr}`.trim() || `Rust command exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}

export async function runRustCommand(
  args: readonly string[],
  cwd: string,
  stdin?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const rust = findRustEntrypoint();
  const finalArgs = [...rust.argsPrefix, ...args];
  const childEnv = { ...process.env, ...env, UNCLECODE_WORK_CWD: cwd };
  const runCwd = rust.runCwd ?? cwd;
  if (stdin === undefined) {
    try {
      const result = await execFileAsync(
        rust.command,
        finalArgs,
        {
          cwd: runCwd,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: childEnv,
        },
      );
      return result.stdout;
    } catch (error) {
      if (rust.fallback && isMissingEntrypoint(error)) {
        const fallbackResult = await execFileAsync(
          rust.fallback.command,
          [...rust.fallback.argsPrefix, ...args],
          {
            cwd: rust.fallback.runCwd ?? cwd,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            env: childEnv,
          },
        );
        return fallbackResult.stdout;
      }
      const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
      throw new Error(output || (error instanceof Error ? error.message : String(error)));
    }
  }

  try {
    return await runRustCommandWithStdin(rust, args, cwd, stdin, childEnv);
  } catch (error) {
    if (rust.fallback && isMissingEntrypoint(error)) {
      return await runRustCommandWithStdin(rust.fallback, args, cwd, stdin, childEnv);
    }
    throw error;
  }
}

function spawnRustPassthrough(
  rust: RustEntrypoint,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(rust.command, [...rust.argsPrefix, ...args], {
      cwd: rust.runCwd ?? cwd,
      windowsHide: true,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise(code ?? 0);
    });
  });
}

export async function runRustCommandPassthrough(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const rust = findRustEntrypoint();
  const childEnv = { ...process.env, ...env, UNCLECODE_WORK_CWD: cwd };
  try {
    return await spawnRustPassthrough(rust, args, cwd, childEnv);
  } catch (error) {
    if (rust.fallback && isMissingEntrypoint(error)) {
      return await spawnRustPassthrough(rust.fallback, args, cwd, childEnv);
    }
    throw error;
  }
}

export function runRustCommandSync(args: readonly string[], cwd: string, stdin?: string, env: NodeJS.ProcessEnv = process.env): string {
  const rust = findRustEntrypoint();
  const finalArgs = [...rust.argsPrefix, ...args];
  const childEnv = { ...process.env, ...env, UNCLECODE_WORK_CWD: cwd };
  try {
    return execFileSync(rust.command, finalArgs, {
      cwd: rust.runCwd ?? cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: childEnv,
      encoding: "utf8",
      input: stdin,
    });
  } catch (error) {
    if (rust.fallback && isMissingEntrypoint(error)) {
      return execFileSync(rust.fallback.command, [...rust.fallback.argsPrefix, ...args], {
        cwd: rust.fallback.runCwd ?? cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: childEnv,
        encoding: "utf8",
        input: stdin,
      });
    }
    const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
    throw new Error(output || (error instanceof Error ? error.message : String(error)));
  }
}
