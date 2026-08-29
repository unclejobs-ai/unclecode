import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    timer.unref();
    child.once("exit", onExit);
  });
}

async function reapFailedOwnerStartup(child: ReturnType<typeof spawn>): Promise<void> {
  child.stderr?.destroy();
  if (await waitForChildExit(child, 0)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 500)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 500);
}

export async function spawnDetachedRuntimeOwner(input: {
  readonly leasePath: string;
  readonly tokenPath: string;
  readonly timeoutMs?: number | undefined;
}): Promise<RuntimeOwnerLease> {
  const [command, baseArgs] = ownerServiceCommand();
  const child = spawn(command, [
    ...baseArgs,
    "--lease-path", input.leasePath,
    "--token-path", input.tokenPath,
  ], {
    cwd: process.cwd(),
    detached: true,
    env: runtimeOwnerServiceEnvironment(),
    // The startup-only pipe is bounded and destroyed after the healthy lease;
    // the long-lived owner has no terminal handle after handoff.
    stdio: ["ignore", "ignore", "pipe"],
  });
  let startupError = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (startupError.length < 2_048) startupError += chunk.slice(0, 2_048 - startupError.length);
  });
  child.unref();

  const deadline = Date.now() + (input.timeoutMs ?? 15_000);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  while (Date.now() <= deadline) {
    const lease = await readRuntimeOwnerLease(input.leasePath);
    if (lease && lease.pid === child.pid && await probeRuntimeOwner(lease)) {
      child.stderr?.destroy();
      return lease;
    }
    if (exited) {
      child.stderr?.destroy();
      const detail = startupError.trim().replace(/[\r\n]+/g, " ").slice(0, 512);
      throw new Error(`Detached runtime owner exited before publishing a healthy lease (${exited.code ?? exited.signal ?? "unknown"})${detail ? `: ${detail}` : "."}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await reapFailedOwnerStartup(child);
  throw new Error("Timed out waiting for the detached runtime owner service.");
}
