import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const DEFAULT_PROCESS_LIMIT = 1_024;
const DEFAULT_OPEN_FILE_LIMIT = 256;
const DEFAULT_MEMORY_KIB = 8 * 1024 * 1024;
const TERMINATION_GRACE_MS = 100;

export type ContainedEvolutionCommandResult = {
  readonly status: "completed" | "failed" | "timeout" | "cancelled";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
};

export class EvolutionSandboxUnavailableError extends Error {
  readonly code = "EVOLUTION_SANDBOX_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "EvolutionSandboxUnavailableError";
  }
}

/**
 * Runs an evaluator command in a mandatory OS sandbox and an owned process
 * group. The command never falls back to an ordinary child process.
 */
export async function runContainedEvolutionCommand(input: {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly readablePaths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
}): Promise<ContainedEvolutionCommandResult> {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new EvolutionSandboxUnavailableError(`No evolution sandbox is supported on ${platform}.`);
  }
  validateBounds(input.timeoutMs, input.maxOutputBytes);
  input.signal?.throwIfAborted();

  const [cwd, workspaceRoot, command] = await Promise.all([
    realpath(input.cwd),
    realpath(input.workspaceRoot),
    resolveExecutable(input.command, input.environment.PATH),
  ]);
  if (!isContained(workspaceRoot, cwd)) {
    throw new Error("Evolution command cwd escapes its workspace root.");
  }
  const sandbox = await resolvePlatformSandbox(platform, input.environment.PATH);
  const privateTemp = await mkdtemp(join(tmpdir(), "unclecode-evolution-sandbox-"));
  try {
    const readablePaths = await normalizeExistingPaths([
      cwd,
      command,
      dirname(dirname(command)),
      ...(input.readablePaths ?? []),
    ]);
    const writablePaths = await normalizeExistingPaths([privateTemp]);
    const sandboxCommand = platform === "darwin"
      ? {
          command: sandbox,
          args: ["-p", darwinProfile(readablePaths, writablePaths), command, ...input.args],
        }
      : {
          command: sandbox,
          args: linuxBubblewrapArgs(cwd, command, input.args, readablePaths, writablePaths),
        };
    return await spawnOwnedProcessGroup({
      ...input,
      cwd,
      command: sandboxCommand.command,
      args: sandboxCommand.args,
      environment: {
        ...input.environment,
        HOME: privateTemp,
        TMPDIR: privateTemp,
        TMP: privateTemp,
        TEMP: privateTemp,
        NO_PROXY: "",
        no_proxy: "",
        HTTP_PROXY: "",
        http_proxy: "",
        HTTPS_PROXY: "",
        https_proxy: "",
        ALL_PROXY: "",
        all_proxy: "",
      },
      platform,
    });
  } finally {
    await rm(privateTemp, { recursive: true, force: true });
  }
}

async function spawnOwnedProcessGroup(input: {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly platform: "darwin" | "linux";
}): Promise<ContainedEvolutionCommandResult> {
  const cpuSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000) + 1);
  const memoryLimit = input.platform === "linux" ? `ulimit -v ${DEFAULT_MEMORY_KIB}; ` : "";
  const processLimit = input.platform === "linux" ? `ulimit -u ${DEFAULT_PROCESS_LIMIT}` : "";
  const limits = [
    `ulimit -t ${cpuSeconds}`,
    `ulimit -n ${DEFAULT_OPEN_FILE_LIMIT}`,
    processLimit,
    `${memoryLimit}exec \"$@\"`,
  ].filter(Boolean).join("; ");
  const child = spawn("/bin/sh", ["-c", limits, "unclecode-evolution", input.command, ...input.args], {
    cwd: input.cwd,
    env: input.environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let outputBytes = 0;
  let terminal: "timeout" | "cancelled" | "output" | undefined;
  let termination: Promise<void> | undefined;
  const terminate = (cause: NonNullable<typeof terminal>): void => {
    if (terminal) return;
    terminal = cause;
    const pid = child.pid;
    if (!pid) return;
    termination = (async () => {
      killProcessGroup(pid, "SIGTERM");
      await delay(TERMINATION_GRACE_MS);
      killProcessGroup(pid, "SIGKILL");
    })();
  };
  const append = (current: Buffer, chunk: Buffer): Buffer => {
    const remaining = input.maxOutputBytes - outputBytes;
    if (remaining <= 0) {
      terminate("output");
      return current;
    }
    if (chunk.byteLength > remaining) {
      terminate("output");
      outputBytes += remaining;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    }
    outputBytes += chunk.byteLength;
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });

  const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
  timeout.unref?.();
  const onAbort = (): void => terminate("cancelled");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const settled = await new Promise<{ code: number | null; error?: Error }>((resolveResult) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => resolveResult({ code, ...(spawnError ? { error: spawnError } : {}) }));
  });
  clearTimeout(timeout);
  input.signal?.removeEventListener("abort", onAbort);
  await termination;

  const output = {
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
  if (terminal === "timeout") return { status: "timeout", ...output };
  if (terminal === "cancelled") return { status: "cancelled", ...output };
  if (terminal === "output") {
    return { status: "failed", ...output, stderr: `${output.stderr}\nEvolution command exceeded its output bound.`.trim() };
  }
  if (settled.error || settled.code !== 0) {
    return {
      status: "failed",
      ...(settled.code === null ? {} : { exitCode: settled.code }),
      ...output,
      stderr: settled.error ? `${output.stderr}\n${settled.error.message}`.trim() : output.stderr,
    };
  }
  return { status: "completed", exitCode: 0, ...output };
}

async function resolvePlatformSandbox(platform: "darwin" | "linux", searchPath: string | undefined): Promise<string> {
  if (platform === "darwin") return requireExecutable("/usr/bin/sandbox-exec");
  for (const name of ["bwrap", "bubblewrap"]) {
    const executable = await findExecutable(name, searchPath);
    if (executable) return executable;
  }
  throw new EvolutionSandboxUnavailableError("Linux evolution evaluation requires bwrap/bubblewrap.");
}

async function resolveExecutable(command: string, searchPath: string | undefined): Promise<string> {
  if (isAbsolute(command)) return requireExecutable(command);
  const resolved = await findExecutable(command, searchPath);
  if (!resolved) throw new Error(`Evolution command is unavailable: ${command}`);
  return resolved;
}

async function requireExecutable(value: string): Promise<string> {
  const absolute = resolve(value);
  try {
    await access(absolute, constants.X_OK);
    return await realpath(absolute);
  } catch {
    throw new EvolutionSandboxUnavailableError(`Evolution sandbox is unavailable: ${absolute}`);
  }
}

async function findExecutable(name: string, searchPath: string | undefined): Promise<string | undefined> {
  for (const directory of (searchPath ?? "").split(":").filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue looking; absence never permits an unsandboxed fallback.
    }
  }
  return undefined;
}

function darwinProfile(readablePaths: readonly string[], writablePaths: readonly string[]): string {
  const readRules = [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/private/var/db/dyld",
    ...readablePaths,
  ].map((path) => `(subpath ${sandboxString(path)})`).join(" ");
  const writeRules = writablePaths.map((path) => `(subpath ${sandboxString(path)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    `(allow file-read* (literal \"/\") (literal \"/dev/null\") (literal \"/dev/urandom\") ${readRules})`,
    `(allow file-write* (literal \"/dev/null\") ${writeRules})`,
  ].join("\n");
}

function linuxBubblewrapArgs(
  cwd: string,
  command: string,
  args: readonly string[],
  readablePaths: readonly string[],
  writablePaths: readonly string[],
): string[] {
  const output = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-net",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    output.push("--ro-bind-try", path, path);
  }
  for (const path of readablePaths) output.push("--ro-bind", path, path);
  for (const path of writablePaths) output.push("--bind", path, path);
  output.push("--chdir", cwd, "--", command, ...args);
  return output;
}

async function normalizeExistingPaths(paths: readonly string[]): Promise<string[]> {
  const output = new Set<string>();
  for (const path of paths) output.add(await realpath(path));
  return [...output].sort();
}

function isContained(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function sandboxString(value: string): string {
  return JSON.stringify(value);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function validateBounds(timeoutMs: number, maxOutputBytes: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    throw new RangeError("Evolution command timeout is invalid.");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 16 * 1024 * 1024) {
    throw new RangeError("Evolution command output bound is invalid.");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
