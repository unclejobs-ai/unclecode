import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unlink } from "node:fs/promises";

import {
  probeRuntimeOwner,
  readRuntimeOwnerLease,
  type RuntimeOwnerLease,
} from "@unclecode/server";

const OWNER_ENV_PREFIXES = [
  "UNCLECODE_", "OPENAI_", "ANTHROPIC_", "GEMINI_", "GOOGLE_", "DEEPSEEK_", "OMP_",
] as const;
const OWNER_ENV_NAMES = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "LC_ALL",
  "LC_CTYPE", "TERM", "NO_COLOR", "FORCE_COLOR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_CACHE_HOME", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
]);

export function runtimeOwnerServiceEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) =>
    value !== undefined
    && (OWNER_ENV_NAMES.has(name) || OWNER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))));
}

function ownerServiceCommand(): readonly [string, readonly string[]] {
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(
    sourceMode ? "./runtime-owner-service.ts" : "./runtime-owner-service.js",
    import.meta.url,
  ));
  return [process.execPath, sourceMode ? ["--import", "tsx", entry] : [entry]];
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    // This timer is the only remaining handle after the detached child is
    // unref'ed. Keep it referenced so startup failure settlement cannot leave
    // a top-level await pending and make Node exit with code 13.
    child.once("exit", onExit);
  });
}

async function reapFailedOwnerStartup(child: ReturnType<typeof spawn>): Promise<void> {
  child.stderr?.destroy();
  if (await waitForChildExit(child, 0)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 500)) return;
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, 2_000)) {
    throw new Error("Detached runtime owner did not settle after SIGKILL.");
  }
}

async function removeExactChildLease(leasePath: string, childPid: number | undefined): Promise<void> {
  if (!childPid) return;
  const lease = await readRuntimeOwnerLease(leasePath);
  if (lease?.pid === childPid) await unlink(leasePath).catch(() => undefined);
}

export async function spawnDetachedRuntimeOwner(input: {
  readonly leasePath: string;
  readonly tokenPath: string;
  readonly timeoutMs?: number | undefined;
  readonly spawnProcess?: typeof spawn | undefined;
}): Promise<RuntimeOwnerLease> {
  const [command, baseArgs] = ownerServiceCommand();
  const child = (input.spawnProcess ?? spawn)(command, [
    ...baseArgs,
    "--lease-path", input.leasePath,
    "--token-path", input.tokenPath,
  ], {
    cwd: process.cwd(),
    detached: true,
    env: runtimeOwnerServiceEnvironment(),
    // The owner must not retain a terminal pipe after handoff. In particular,
    // closing a startup stderr pipe would make later Node warnings hit EPIPE
    // and kill the otherwise healthy detached owner.
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnFailure: Error | undefined;
  child.once("error", (error) => { spawnFailure = error; });
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  while (Date.now() <= deadline) {
    const lease = await readRuntimeOwnerLease(input.leasePath);
    if (lease && lease.pid === child.pid && await probeRuntimeOwner(lease)) {
      return lease;
    }
    if (exited) {
      throw new Error(`Detached runtime owner exited before publishing a healthy lease (${exited.code ?? exited.signal ?? "unknown"}).`);
    }
    if (spawnFailure) {
      await reapFailedOwnerStartup(child);
      await removeExactChildLease(input.leasePath, child.pid);
      throw new Error(`Failed to spawn detached runtime owner: ${spawnFailure.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await reapFailedOwnerStartup(child);
  await removeExactChildLease(input.leasePath, child.pid);
  throw new Error("Timed out waiting for the detached runtime owner service.");
}
