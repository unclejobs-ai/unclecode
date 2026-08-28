import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const CGROUP_ROOT = "/sys/fs/cgroup";
const DEFAULT_PROCESS_LIMIT = 64;
const DEFAULT_OPEN_FILE_LIMIT = 256;
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_CPU_QUOTA_MICROS = 100_000;
const CPU_PERIOD_MICROS = 100_000;
const TERMINATION_GRACE_MS = 100;
const DOMAIN_EMPTY_TIMEOUT_MS = 5_000;
const CHILD_CLOSE_TIMEOUT_MS = 5_000;

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
  readonly maxProcesses?: number;
  readonly maxMemoryBytes?: number;
}): Promise<ContainedEvolutionCommandResult> {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") {
    throw new EvolutionSandboxUnavailableError(
      "macOS evolution evaluation is unavailable: sandbox-exec has no host-enforced containment domain for detached descendants.",
    );
  }
  if (platform !== "linux") {
    throw new EvolutionSandboxUnavailableError(`No evolution sandbox is supported on ${platform}.`);
  }
  validateBounds(input.timeoutMs, input.maxOutputBytes, input.maxProcesses, input.maxMemoryBytes);
  input.signal?.throwIfAborted();

  const [cwd, workspaceRoot, command] = await Promise.all([
    realpath(input.cwd),
    realpath(input.workspaceRoot),
    resolveExecutable(input.command, input.environment.PATH),
  ]);
  if (!isContained(workspaceRoot, cwd)) {
    throw new Error("Evolution command cwd escapes its workspace root.");
  }
  const sandbox = await resolvePlatformSandbox(input.environment.PATH);
  const containment = await createLinuxContainmentDomain({
    maxProcesses: input.maxProcesses ?? DEFAULT_PROCESS_LIMIT,
    maxMemoryBytes: input.maxMemoryBytes ?? DEFAULT_MEMORY_BYTES,
  });
  let privateTemp: string | undefined;
  try {
    privateTemp = await mkdtemp(join(tmpdir(), "unclecode-evolution-sandbox-"));
    const writablePaths = await normalizeExistingPaths([privateTemp]);
    const readablePaths = await normalizeExistingPaths([
      cwd,
      command,
      dirname(dirname(command)),
      ...writablePaths,
      ...(input.readablePaths ?? []),
    ]);
    return await runSupervisedEvolutionProcess({
      ...input,
      cwd,
      command: sandbox,
      args: linuxBubblewrapArgs(cwd, command, input.args, readablePaths, writablePaths),
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
      containment,
    });
  } finally {
    try {
      // The domain implementation is idempotent. Retrying disposal here also
      // covers failures that happen before process supervision is established.
      await containment.dispose();
    } finally {
      if (privateTemp) await rm(privateTemp, { recursive: true, force: true });
    }
  }
}

export type EvolutionContainmentDomain = {
  readonly path: string;
  readonly isPopulated: () => Promise<boolean>;
  readonly kill: () => Promise<void>;
  readonly killAndWaitEmpty: () => Promise<void>;
  readonly dispose: () => Promise<void>;
};

/**
 * Supervises an already-contained process. This is separate from sandbox
 * selection so host adapters can exercise termination failures without ever
 * weakening the mandatory production sandbox entry point above.
 */
export async function runSupervisedEvolutionProcess(input: {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly containment: EvolutionContainmentDomain;
}): Promise<ContainedEvolutionCommandResult> {
  const cpuSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000) + 1);
  const limits = [
    "set -eu",
    'containment_root="$1"',
    "shift",
    'printf "%s" "$$" > "$containment_root/cgroup.procs"',
    `ulimit -t ${cpuSeconds}`,
    `ulimit -n ${DEFAULT_OPEN_FILE_LIMIT}`,
    'exec "$@"',
  ].join("; ");
  const child = spawn("/bin/sh", [
    "-c",
    limits,
    "unclecode-evolution",
    input.containment.path,
    input.command,
    ...input.args,
  ], {
    cwd: input.cwd,
    env: input.environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let outputBytes = 0;
  let terminal: "timeout" | "cancelled" | "output" | undefined;
  let resolveTerminationRequested: (() => void) | undefined;
  const terminationRequested = new Promise<void>((resolveRequested) => {
    resolveTerminationRequested = resolveRequested;
  });
  let termination: Promise<void> | undefined;
  const terminate = (cause: NonNullable<typeof terminal>): void => {
    if (terminal) return;
    terminal = cause;
    resolveTerminationRequested?.();
    const pid = child.pid;
    termination = (async () => {
      await Promise.allSettled([
        input.containment.kill(),
        attempt(() => {
          if (pid) killProcessGroup(pid, "SIGTERM");
        }),
      ]);
      await delay(TERMINATION_GRACE_MS);
      await Promise.allSettled([
        input.containment.kill(),
        attempt(() => {
          if (pid) killProcessGroup(pid, "SIGKILL");
        }),
      ]);
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
  const childClosed = new Promise<{ code: number | null; error?: Error }>((resolveResult) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => resolveResult({ code, ...(spawnError ? { error: spawnError } : {}) }));
  });
  let settled: { code: number | null; error?: Error } | undefined;
  let retainedDescendants = false;
  let primaryError: unknown;
  let result: ContainedEvolutionCommandResult | undefined;
  try {
    const first = await Promise.race([
      childClosed.then((value) => ({ kind: "closed" as const, value })),
      terminationRequested.then(() => ({ kind: "termination" as const })),
    ]);
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
    if (first.kind === "closed") settled = first.value;
    if (termination) {
      await termination;
      settled ??= await waitForSettlement(childClosed, CHILD_CLOSE_TIMEOUT_MS);
      if (!settled) {
        const pid = child.pid;
        await Promise.allSettled([
          input.containment.kill(),
          attempt(() => {
            if (pid) killProcessGroup(pid, "SIGKILL");
          }),
        ]);
        settled = await waitForSettlement(childClosed, CHILD_CLOSE_TIMEOUT_MS);
      }
      if (!settled) {
        throw new EvolutionSandboxUnavailableError(
          "Evolution process did not close within its bounded termination window.",
        );
      }
    }
    if (!settled) settled = await waitForSettlement(childClosed, CHILD_CLOSE_TIMEOUT_MS);
    if (!settled) {
      terminate("output");
      await termination;
      throw new EvolutionSandboxUnavailableError(
        "Evolution process close supervision expired.",
      );
    }
    retainedDescendants = await input.containment.isPopulated();

    const output = {
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
    };
    if (terminal === "timeout") result = { status: "timeout", ...output };
    else if (terminal === "cancelled") result = { status: "cancelled", ...output };
    else if (terminal === "output") {
      result = {
        status: "failed",
        ...output,
        stderr: `${output.stderr}\nEvolution command exceeded its output bound.`.trim(),
      };
    } else if (retainedDescendants) {
      result = {
        status: "failed",
        ...output,
        stderr: `${output.stderr}\nEvolution command left descendant processes running.`.trim(),
      };
    } else if (settled.error || settled.code !== 0) {
      result = {
        status: "failed",
        ...(settled.code === null ? {} : { exitCode: settled.code }),
        ...output,
        stderr: settled.error ? `${output.stderr}\n${settled.error.message}`.trim() : output.stderr,
      };
    } else {
      result = { status: "completed", exitCode: 0, ...output };
    }
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
    const pid = child.pid;
    if (!settled || retainedDescendants) {
      await Promise.allSettled([
        input.containment.kill(),
        attempt(() => {
          if (pid) killProcessGroup(pid, "SIGKILL");
        }),
      ]);
    }
    const drain = await Promise.allSettled([input.containment.killAndWaitEmpty()]);
    const dispose = await Promise.allSettled([input.containment.dispose()]);
    const cleanupFailure = [...drain, ...dispose].find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    if (!primaryError && cleanupFailure) primaryError = cleanupFailure.reason;
  }
  if (primaryError) throw primaryError;
  if (!result) throw new Error("Evolution process supervision produced no result.");
  return result;
}

async function createLinuxContainmentDomain(input: {
  readonly maxProcesses: number;
  readonly maxMemoryBytes: number;
}): Promise<EvolutionContainmentDomain> {
  const root = await resolveDelegatedCgroupRoot();
  const availableControllers = new Set((await readFile(join(root, "cgroup.controllers"), "utf8")).trim().split(/\s+/));
  for (const required of ["cpu", "memory", "pids"]) {
    if (!availableControllers.has(required)) {
      throw new EvolutionSandboxUnavailableError(
        `Linux evolution containment requires the delegated cgroup-v2 ${required} controller.`,
      );
    }
  }
  try {
    const enabledControllers = new Set((await readFile(join(root, "cgroup.subtree_control"), "utf8")).trim().split(/\s+/));
    const missing = ["cpu", "memory", "pids"].filter((controller) => !enabledControllers.has(controller));
    if (missing.length > 0) {
      await writeFile(join(root, "cgroup.subtree_control"), missing.map((controller) => `+${controller}`).join(" "));
    }
  } catch (error) {
    throw unavailableCgroup("cannot enable aggregate controllers", error);
  }

  let domainPath: string | undefined;
  try {
    domainPath = await mkdtemp(join(root, "unclecode-evolution-"));
    await writeFile(join(domainPath, "pids.max"), String(input.maxProcesses));
    await writeFile(join(domainPath, "memory.max"), String(input.maxMemoryBytes));
    await writeFile(join(domainPath, "cpu.max"), `${DEFAULT_CPU_QUOTA_MICROS} ${CPU_PERIOD_MICROS}`);
    try {
      await writeFile(join(domainPath, "memory.swap.max"), "0");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await access(join(domainPath, "cgroup.kill"), constants.W_OK);
    await access(join(domainPath, "cgroup.events"), constants.R_OK);
  } catch (error) {
    if (domainPath) await removeEmptyCgroup(domainPath).catch(() => undefined);
    throw unavailableCgroup("cannot create a bounded descendant domain", error);
  }
  const ownedDomainPath = domainPath;

  let disposed = false;
  const isPopulated = async (): Promise<boolean> => {
    const events = await readFile(join(ownedDomainPath, "cgroup.events"), "utf8");
    const populated = events.match(/^populated\s+([01])$/m)?.[1];
    if (populated === undefined) {
      throw new EvolutionSandboxUnavailableError("Linux evolution containment returned invalid cgroup.events data.");
    }
    return populated === "1";
  };
  const kill = async (): Promise<void> => {
    if (!(await isPopulated())) return;
    await writeFile(join(ownedDomainPath, "cgroup.kill"), "1");
  };
  const killAndWaitEmpty = async (): Promise<void> => {
    const deadline = Date.now() + DOMAIN_EMPTY_TIMEOUT_MS;
    while (await isPopulated()) {
      await writeFile(join(ownedDomainPath, "cgroup.kill"), "1");
      if (Date.now() >= deadline) {
        throw new EvolutionSandboxUnavailableError(
          "Linux evolution containment could not drain its descendant domain.",
        );
      }
      await delay(20);
    }
  };
  return {
    path: ownedDomainPath,
    isPopulated,
    kill,
    killAndWaitEmpty,
    dispose: async (): Promise<void> => {
      if (disposed) return;
      await killAndWaitEmpty();
      await removeEmptyCgroup(ownedDomainPath);
      disposed = true;
    },
  };
}

async function resolveDelegatedCgroupRoot(): Promise<string> {
  let root = process.env.UNCLECODE_EVOLUTION_CGROUP_ROOT;
  if (!root) {
    let membership: string;
    try {
      membership = await readFile("/proc/self/cgroup", "utf8");
    } catch (error) {
      throw unavailableCgroup("cannot read the process cgroup-v2 membership", error);
    }
    const relative = membership.split("\n")
      .map((line) => line.match(/^0::(\/.*)$/)?.[1])
      .find((value): value is string => value !== undefined);
    if (!relative) {
      throw new EvolutionSandboxUnavailableError("Linux evolution containment requires a unified cgroup-v2 hierarchy.");
    }
    root = join(CGROUP_ROOT, relative.replace(/^\/+/, ""));
  }
  let resolvedRoot: string;
  let resolvedCgroupRoot: string;
  try {
    [resolvedRoot, resolvedCgroupRoot] = await Promise.all([realpath(root), realpath(CGROUP_ROOT)]);
  } catch (error) {
    throw unavailableCgroup("cannot resolve its delegated cgroup-v2 root", error);
  }
  if (!isContained(resolvedCgroupRoot, resolvedRoot)) {
    throw new EvolutionSandboxUnavailableError("Linux evolution containment root escapes the cgroup-v2 hierarchy.");
  }
  try {
    await access(resolvedRoot, constants.R_OK | constants.W_OK);
  } catch (error) {
    throw unavailableCgroup("requires a writable delegated cgroup-v2 root", error);
  }
  return resolvedRoot;
}

async function removeEmptyCgroup(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unavailableCgroup(action: string, cause: unknown): EvolutionSandboxUnavailableError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new EvolutionSandboxUnavailableError(`Linux evolution containment ${action}${detail}`);
}

async function resolvePlatformSandbox(searchPath: string | undefined): Promise<string> {
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

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function validateBounds(
  timeoutMs: number,
  maxOutputBytes: number,
  maxProcesses: number | undefined,
  maxMemoryBytes: number | undefined,
): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    throw new RangeError("Evolution command timeout is invalid.");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 16 * 1024 * 1024) {
    throw new RangeError("Evolution command output bound is invalid.");
  }
  if (maxProcesses !== undefined && (!Number.isInteger(maxProcesses) || maxProcesses < 2 || maxProcesses > 4_096)) {
    throw new RangeError("Evolution command process bound is invalid.");
  }
  if (maxMemoryBytes !== undefined
    && (!Number.isInteger(maxMemoryBytes) || maxMemoryBytes < 16 * 1024 * 1024 || maxMemoryBytes > 16 * 1024 * 1024 * 1024)) {
    throw new RangeError("Evolution command memory bound is invalid.");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function attempt(operation: () => void): Promise<void> {
  return Promise.resolve().then(operation);
}

async function waitForSettlement<T>(settlement: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settlement,
      new Promise<undefined>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
