import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  writeSync,
} from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_RESULTS = 200;

type OmpSchemaFactory = (definition: Readonly<Record<string, unknown>>) => unknown;

type OmpWorkspaceTool = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly strict: true;
  readonly loadMode: "essential";
  readonly approval: "read" | "write";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    onUpdate?: unknown,
    context?: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly content: readonly [{ readonly type: "text"; readonly text: string }] }>;
};

type OmpWorkspaceToolOptions = {
  /** Test seam that can widen the validation/open race without weakening the secure open itself. */
  readonly beforeAnchoredWriteOpen?: () => void | Promise<void>;
};

type AnchoredOpenBackend = {
  openAt(directoryFd: number, name: string, flags: number, mode: number): number;
};

const BUN_FFI_SPECIFIER = "bun:ffi";
let anchoredOpenBackendPromise: Promise<AnchoredOpenBackend> | undefined;

export class OmpWorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpWorkspacePathError";
  }
}

export async function canonicalizeOmpWorkspaceRoot(cwd: string): Promise<string> {
  const canonical = await realpath(cwd);
  if (!(await stat(canonical)).isDirectory()) {
    throw new OmpWorkspacePathError("OMP workspace root must be a directory.");
  }
  return canonical;
}

/**
 * Build replacements for OMP's ambient file tools. Every path is validated by
 * UncleCode before direct filesystem I/O; none of these tools spawns a process
 * or opens a network connection.
 */
export function createOmpWorkspaceTools(
  workspaceRoot: string,
  schema: OmpSchemaFactory,
  options: OmpWorkspaceToolOptions = {},
): readonly OmpWorkspaceTool[] {
  const result = (text: string) => ({ content: [{ type: "text" as const, text }] as const });
  const tools: OmpWorkspaceTool[] = [
    {
      name: "read",
      label: "Read",
      description: "Read a UTF-8 file or list a directory inside the workspace. Paths must be relative.",
      parameters: schema({ path: "string" }),
      strict: true,
      loadMode: "essential",
      approval: "read",
      async execute(_id, params, _update, _context, signal) {
        throwIfAborted(signal);
        const target = await resolveContainedExistingPath(workspaceRoot, requireString(params.path, "path"));
        const targetStat = await lstat(target);
        if (targetStat.isSymbolicLink()) throw new OmpWorkspacePathError("Symbolic-link file targets are not allowed.");
        if (targetStat.isDirectory()) {
          const entries = (await readdir(target, { withFileTypes: true }))
            .slice(0, MAX_SEARCH_RESULTS)
            .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
            .sort();
          return result(entries.join("\n"));
        }
        if (!targetStat.isFile()) throw new OmpWorkspacePathError("Read target must be a regular file or directory.");
        return result(await readBoundedUtf8File(target, signal));
      },
    },
    {
      name: "write",
      label: "Write",
      description: "Create or overwrite a UTF-8 file inside the workspace. Paths must be relative.",
      parameters: schema({ path: "string", content: "string" }),
      strict: true,
      loadMode: "essential",
      approval: "write",
      async execute(_id, params, _update, _context, signal) {
        throwIfAborted(signal);
        const content = requireString(params.content, "content");
        const target = await resolveContainedWritablePath(workspaceRoot, requireString(params.path, "path"));
        await options.beforeAnchoredWriteOpen?.();
        await writeNoFollow(workspaceRoot, target, content, signal);
        await assertExistingPathContained(workspaceRoot, target);
        return result(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${displayPath(workspaceRoot, target)}.`);
      },
    },
    {
      name: "edit",
      label: "Edit",
      description: "Replace one exact text occurrence in a UTF-8 workspace file. Paths must be relative.",
      parameters: schema({ path: "string", old_string: "string", new_string: "string" }),
      strict: true,
      loadMode: "essential",
      approval: "write",
      async execute(_id, params, _update, _context, signal) {
        throwIfAborted(signal);
        const oldString = requireString(params.old_string, "old_string");
        const newString = requireString(params.new_string, "new_string");
        if (oldString.length === 0) throw new Error("old_string must not be empty.");
        const target = await resolveContainedExistingPath(workspaceRoot, requireString(params.path, "path"));
        const original = await readBoundedUtf8File(target, signal);
        const first = original.indexOf(oldString);
        if (first < 0) throw new Error("old_string was not found in the target file.");
        if (original.indexOf(oldString, first + oldString.length) >= 0) {
          throw new Error("old_string is not unique in the target file.");
        }
        await options.beforeAnchoredWriteOpen?.();
        await writeNoFollow(
          workspaceRoot,
          target,
          `${original.slice(0, first)}${newString}${original.slice(first + oldString.length)}`,
          signal,
        );
        await assertExistingPathContained(workspaceRoot, target);
        return result(`Edited ${displayPath(workspaceRoot, target)}.`);
      },
    },
    {
      name: "grep",
      label: "Grep",
      description: "Search UTF-8 workspace files with a JavaScript regular expression. Paths must be relative.",
      parameters: schema({ pattern: "string", "path?": "string", "case?": "boolean" }),
      strict: true,
      loadMode: "essential",
      approval: "read",
      async execute(_id, params, _update, _context, signal) {
        throwIfAborted(signal);
        const pattern = requireString(params.pattern, "pattern");
        if (pattern.length === 0) throw new Error("pattern must not be empty.");
        const target = await resolveContainedExistingPath(
          workspaceRoot,
          optionalString(params.path, "path") ?? ".",
        );
        let expression: RegExp;
        try {
          expression = new RegExp(pattern, params.case === true ? "g" : "gi");
        } catch (error) {
          throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
        }
        const matches: string[] = [];
        for (const file of await collectWorkspaceFiles(target, signal)) {
          if (matches.length >= MAX_SEARCH_RESULTS) break;
          let text: string;
          try {
            text = await readBoundedUtf8File(file, signal);
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_RESULTS; index += 1) {
            expression.lastIndex = 0;
            if (expression.test(lines[index]!)) {
              matches.push(`${displayPath(workspaceRoot, file)}:${index + 1}:${lines[index]}`);
            }
          }
        }
        return result(matches.length > 0 ? matches.join("\n") : "No matches found.");
      },
    },
    {
      name: "glob",
      label: "Glob",
      description: "Find workspace files using a relative glob. Absolute paths and parent traversal are rejected.",
      parameters: schema({ "path?": "string", "limit?": "number" }),
      strict: true,
      loadMode: "essential",
      approval: "read",
      async execute(_id, params, _update, _context, signal) {
        throwIfAborted(signal);
        const pattern = optionalString(params.path, "path") ?? "**/*";
        validateRelativePath(pattern);
        await assertFindPatternContained(workspaceRoot, pattern);
        const requestedLimit = typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.floor(params.limit)
          : MAX_SEARCH_RESULTS;
        const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, requestedLimit));
        const matcher = globToRegExp(pattern.replaceAll("\\", "/"));
        const files = await collectWorkspaceFiles(workspaceRoot, signal);
        return result(files
          .map((file) => displayPath(workspaceRoot, file))
          .filter((relative) => matcher.test(relative))
          .slice(0, limit)
          .join("\n"));
      },
    },
  ];
  // OMP 17 normalizes the legacy `find` request name to `glob`. Register the
  // current name plus a compatibility alias so either SDK generation reaches
  // UncleCode's contained implementation rather than an ambient built-in.
  const glob = tools.at(-1)!;
  return [...tools, { ...glob, name: "find", label: "Find" }];
}

async function assertFindPatternContained(workspaceRoot: string, pattern: string): Promise<void> {
  const wildcard = pattern.search(/[?*\[]/);
  const staticPrefix = (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/[\\/]+$/, "");
  if (!staticPrefix || staticPrefix === ".") return;
  const candidate = path.resolve(workspaceRoot, staticPrefix);
  assertLexicallyContained(workspaceRoot, candidate);
  try {
    await assertExistingPathContained(workspaceRoot, candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function validateOmpWorkspaceRelativePath(rawPath: string): void {
  validateRelativePath(rawPath);
}

function validateRelativePath(rawPath: string): void {
  if (rawPath.length === 0 || rawPath.includes("\0")) {
    throw new OmpWorkspacePathError("Workspace path must be a non-empty relative path.");
  }
  if (rawPath.startsWith("~") || path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath) || /^\\\\/.test(rawPath)) {
    throw new OmpWorkspacePathError("Absolute and home-relative paths are not allowed.");
  }
  const segments = rawPath.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new OmpWorkspacePathError("Parent path traversal is not allowed.");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawPath)) {
    throw new OmpWorkspacePathError("URI paths are not allowed.");
  }
}

async function resolveContainedExistingPath(workspaceRoot: string, rawPath: string): Promise<string> {
  validateRelativePath(rawPath);
  const candidate = path.resolve(workspaceRoot, rawPath);
  assertLexicallyContained(workspaceRoot, candidate);
  return assertExistingPathContained(workspaceRoot, candidate);
}

async function resolveContainedWritablePath(workspaceRoot: string, rawPath: string): Promise<string> {
  validateRelativePath(rawPath);
  const candidate = path.resolve(workspaceRoot, rawPath);
  assertLexicallyContained(workspaceRoot, candidate);
  if (candidate === workspaceRoot) throw new OmpWorkspacePathError("Workspace root is not a writable file target.");

  let ancestor = candidate;
  while (true) {
    try {
      const entry = await lstat(ancestor);
      if (entry.isSymbolicLink()) {
        throw new OmpWorkspacePathError("Symbolic-link write targets are not allowed.");
      }
      const canonical = await realpath(ancestor);
      assertLexicallyContained(workspaceRoot, canonical);
      if (ancestor === candidate && !entry.isFile()) {
        throw new OmpWorkspacePathError("Write target must be a regular file.");
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new OmpWorkspacePathError("Cannot resolve a contained write parent.");
      ancestor = parent;
    }
  }
}

async function assertExistingPathContained(workspaceRoot: string, candidate: string): Promise<string> {
  const canonical = await realpath(candidate);
  assertLexicallyContained(workspaceRoot, canonical);
  return canonical;
}

function assertLexicallyContained(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new OmpWorkspacePathError("Path resolves outside the workspace.");
}

async function readBoundedUtf8File(target: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const handle = await open(target, constants.O_RDONLY | noFollowFlag());
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new OmpWorkspacePathError("Target must be a regular file.");
    if (metadata.size > MAX_TEXT_BYTES) throw new Error(`File exceeds the ${MAX_TEXT_BYTES}-byte OMP boundary.`);
    const content = await handle.readFile("utf8");
    if (content.includes("\0")) throw new Error("Binary files are not supported by the OMP workspace tools.");
    return content;
  } finally {
    await handle.close();
  }
}

async function writeNoFollow(
  workspaceRoot: string,
  target: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Content exceeds the ${MAX_TEXT_BYTES}-byte OMP boundary.`);
  }
  const descriptor = await openAnchoredWorkspaceFile(
    workspaceRoot,
    target,
    constants.O_WRONLY | constants.O_CREAT | nonBlockingFlag(),
    0o644,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new OmpWorkspacePathError("Write target must be a regular file.");
    ftruncateSync(descriptor, 0);
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfAborted(signal);
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (written <= 0) throw new Error("OMP workspace write made no progress.");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Open a workspace file relative to directory descriptors, never by reopening
 * a pathname that was validated earlier. OMP's worker is Bun, whose FFI gives
 * us POSIX openat(2); Node and platforms without O_NOFOLLOW fail closed for
 * writes because their pathname-only APIs cannot close the parent-symlink
 * validation/open race.
 */
async function openAnchoredWorkspaceFile(
  workspaceRoot: string,
  target: string,
  flags: number,
  mode: number,
): Promise<number> {
  const noFollow = noFollowFlag();
  const directory = directoryFlag();
  if (noFollow === 0 || directory === 0) {
    throw new OmpWorkspacePathError("Secure anchored workspace writes are unavailable on this platform.");
  }

  const relative = path.relative(workspaceRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new OmpWorkspacePathError("Write target must remain below the workspace root.");
  }
  const segments = relative.split(path.sep);
  const fileName = segments.pop();
  if (!fileName || fileName === "." || fileName === "..") {
    throw new OmpWorkspacePathError("Write target must name a workspace file.");
  }

  const backend = await loadAnchoredOpenBackend();
  const rootHandle = await open(workspaceRoot, constants.O_RDONLY | directory | noFollow);
  let ownedDirectoryFd: number | undefined;
  try {
    let directoryFd = rootHandle.fd;
    for (const segment of segments) {
      const nextFd = backend.openAt(
        directoryFd,
        segment,
        constants.O_RDONLY | directory | noFollow | closeOnExecFlag(),
        0,
      );
      if (nextFd < 0) {
        throw new OmpWorkspacePathError("Workspace write parent changed or contains a symbolic link.");
      }
      if (ownedDirectoryFd !== undefined) closeSync(ownedDirectoryFd);
      ownedDirectoryFd = nextFd;
      directoryFd = nextFd;
    }

    const existingFlags = flags & ~constants.O_CREAT;
    let descriptor = backend.openAt(
      directoryFd,
      fileName,
      existingFlags | noFollow | closeOnExecFlag(),
      0,
    );
    if (descriptor < 0 && (flags & constants.O_CREAT) !== 0) {
      // Bun FFI cannot express openat's variadic mode argument. A restrictive
      // umask makes the just-created inode inaccessible until fchmod below,
      // regardless of the ABI's unused register contents.
      const previousUmask = process.umask(0o777);
      try {
        descriptor = backend.openAt(
          directoryFd,
          fileName,
          existingFlags | constants.O_CREAT | constants.O_EXCL | noFollow | closeOnExecFlag(),
          mode,
        );
      } finally {
        process.umask(previousUmask);
      }
      if (descriptor >= 0) {
        // openat is variadic when O_CREAT is present, which Bun FFI cannot
        // describe portably. O_EXCL proves this call created the file, so it is
        // safe to set the intended mode on the returned descriptor immediately.
        fchmodSync(descriptor, mode);
      } else {
        // A contained peer may have won the create race. Reopen only through
        // the same pinned parent descriptor; symlinks still fail O_NOFOLLOW.
        descriptor = backend.openAt(
          directoryFd,
          fileName,
          existingFlags | noFollow | closeOnExecFlag(),
          0,
        );
      }
    }
    if (descriptor < 0) {
      throw new OmpWorkspacePathError("Workspace write target changed or is a symbolic link.");
    }
    return descriptor;
  } finally {
    if (ownedDirectoryFd !== undefined) closeSync(ownedDirectoryFd);
    await rootHandle.close();
  }
}

async function loadAnchoredOpenBackend(): Promise<AnchoredOpenBackend> {
  if (anchoredOpenBackendPromise) return anchoredOpenBackendPromise;
  anchoredOpenBackendPromise = (async () => {
    if (!process.versions.bun) {
      throw new OmpWorkspacePathError("Secure anchored workspace writes require the isolated Bun worker.");
    }
    const libraryPath = process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : process.platform === "freebsd"
          ? "libc.so.7"
          : undefined;
    if (!libraryPath) {
      throw new OmpWorkspacePathError("Secure anchored workspace writes are unavailable on this platform.");
    }
    try {
      const ffi = await import(BUN_FFI_SPECIFIER) as unknown as {
        dlopen(
          library: string,
          symbols: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
        ): { readonly symbols: { readonly openat: (...args: unknown[]) => number } };
        ptr(buffer: Uint8Array): number | bigint;
      };
      const library = ffi.dlopen(libraryPath, {
        openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
      });
      return {
        openAt(directoryFd, name, openFlags, mode) {
          const nulTerminatedName = Buffer.from(`${name}\0`, "utf8");
          return Number(library.symbols.openat(directoryFd, ffi.ptr(nulTerminatedName), openFlags, mode));
        },
      };
    } catch (error) {
      throw new OmpWorkspacePathError(
        `Secure anchored workspace writes could not initialize: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  return anchoredOpenBackendPromise;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
}

function closeOnExecFlag(): number {
  const value = (constants as unknown as Readonly<Record<string, unknown>>).O_CLOEXEC;
  return typeof value === "number" ? value : 0;
}

function nonBlockingFlag(): number {
  return typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
}

async function collectWorkspaceFiles(target: string, signal?: AbortSignal): Promise<string[]> {
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) throw new OmpWorkspacePathError("Symbolic-link search roots are not allowed.");
  if (targetStat.isFile()) return [target];
  if (!targetStat.isDirectory()) return [];

  const files: string[] = [];
  const directories = [target];
  while (directories.length > 0 && files.length < MAX_SEARCH_FILES) {
    throwIfAborted(signal);
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) directories.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files.sort();
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      source += pattern[index + 1] === "/" ? "(?:.*/)?" : ".*";
      if (pattern[index + 1] === "/") index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function displayPath(workspaceRoot: string, target: string): string {
  return path.relative(workspaceRoot, target).split(path.sep).join("/") || ".";
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("OMP workspace operation aborted.");
}
