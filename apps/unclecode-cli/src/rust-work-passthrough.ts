import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type RustEntrypoint = {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly runCwd?: string;
};

const modulePath = fileURLToPath(import.meta.url);

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

function cargoEntrypoint(root: string): RustEntrypoint {
  return {
    command: "cargo",
    argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
    runCwd: root,
  };
}

function explicitRustEntrypoint(value: string, cwd: string): RustEntrypoint {
  return {
    command: path.isAbsolute(value) ? value : path.resolve(cwd, value),
    argsPrefix: [],
  };
}

export function resolveDefaultWorkRustEntrypoint(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): RustEntrypoint {
  const explicit = env.UNCLECODE_RUST_BIN?.trim();
  if (explicit) {
    return explicitRustEntrypoint(explicit, cwd);
  }

  for (const start of [path.dirname(modulePath), cwd]) {
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

      const root = findWorkspaceRoot(cursor);
      if (root === cursor) {
        return cargoEntrypoint(root);
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }

  return cargoEntrypoint(cwd);
}

export async function runDefaultWorkRustPassthrough(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const entrypoint = resolveDefaultWorkRustEntrypoint(cwd, env);
  const child = spawn(entrypoint.command, [...entrypoint.argsPrefix, "work"], {
    cwd: entrypoint.runCwd ?? cwd,
    env,
    stdio: "inherit",
  });

  return await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.on("close", (status, signal) => {
      if (typeof status === "number") {
        resolve(status);
        return;
      }
      process.stderr.write(`unclecode work exited from signal ${signal ?? "unknown"}\n`);
      resolve(1);
    });
  });
}
