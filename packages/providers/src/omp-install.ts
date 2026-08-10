/**
 * Locates the installed Oh My Pi (`omp`) package from the `omp` executable.
 *
 * OMP ships as a Bun package. Node cannot resolve `@oh-my-pi/*` from this
 * workspace, so every OMP-backed feature has to find the install on disk and
 * hand an absolute path to a Bun child process. The home directory is never
 * hardcoded: the executable is looked up on PATH, its symlink is resolved, and
 * the package root is the nearest ancestor whose `package.json` declares an
 * `@oh-my-pi/*` name.
 *
 * Shared by the OMP auth catalog and the OMP work executor so there is exactly
 * one realpath/walk-up implementation in the tree.
 */

import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type OmpInstall = {
  /** Absolute path to the `omp` executable (symlink resolved). */
  readonly binPath: string;
  /** Absolute path to the `@oh-my-pi/pi-coding-agent` package root (contains `src/` and `package.json`). */
  readonly packageRoot: string;
  /** Absolute path to the `@oh-my-pi` scope directory that holds `pi-ai`, `pi-utils`, … */
  readonly scopeRoot: string;
};

/** Explicit override for the `omp` executable; skips the PATH lookup. */
const OMP_BIN_ENV = "UNCLECODE_OMP_BIN";
/** Explicit override for the `bun` executable used to run Bun-side helpers. */
const OMP_BUN_BIN_ENV = "UNCLECODE_OMP_BUN_BIN";

const OMP_SCOPE_PREFIX = "@oh-my-pi/";
/** Deep enough for `<scope>/<pkg>/dist/chunks/x.js`, shallow enough to stay bounded. */
const MAX_PACKAGE_WALK_UP_DEPTH = 8;

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const searchPath = env.PATH ?? env.Path ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
      return undefined;
    }
    const name: unknown = parsed.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walk up from the resolved entrypoint until a `package.json` names an
 * `@oh-my-pi/*` package. Stopping at "the first package.json" would be wrong
 * for installs that ship a `dist/package.json` type marker, and accepting any
 * package would silently point Bun at an unrelated tree.
 */
function findOmpPackageRoot(entrypoint: string): string | undefined {
  let directory = path.dirname(entrypoint);
  for (let depth = 0; depth < MAX_PACKAGE_WALK_UP_DEPTH; depth += 1) {
    const name = readPackageName(path.join(directory, "package.json"));
    if (name?.startsWith(OMP_SCOPE_PREFIX)) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  return undefined;
}

/** Returns undefined when omp is not installed / not resolvable. Never throws. */
export function findOmpInstall(env: NodeJS.ProcessEnv = process.env): OmpInstall | undefined {
  try {
    const override = env[OMP_BIN_ENV]?.trim();
    const binPath = override && override.length > 0
      ? override
      : findExecutableOnPath("omp", env);
    if (!binPath || !isExecutableFile(binPath)) {
      return undefined;
    }
    const packageRoot = findOmpPackageRoot(realpathSync(binPath));
    if (!packageRoot) {
      return undefined;
    }
    return { binPath, packageRoot, scopeRoot: path.dirname(packageRoot) };
  } catch {
    return undefined;
  }
}

/**
 * Absolute path (or bare name) of the bun executable used to run Bun-side
 * helpers. Falls back to the bare name so the spawn failure — not a guess —
 * is what surfaces when Bun is genuinely missing.
 */
export function resolveBunExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OMP_BUN_BIN_ENV]?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return findExecutableOnPath("bun", env) ?? "bun";
}
