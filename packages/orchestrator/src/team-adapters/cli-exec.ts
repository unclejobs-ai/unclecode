/**
 * Shared CLI exec primitive for spawn-based lane adapters (codex, opencode,
 * hermes/acpx). Wraps node:child_process with a small abortable promise so
 * adapters get the same timeout + stdout/stderr capture behavior. Tests
 * inject their own `CliExecutor` to avoid touching real binaries.
 */

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { createOwnedProcessGroupController } from "../process-group-settlement.js";

export type CliExecOptions = {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly stdin?: string;
  readonly forceKillDelayMs?: number;
  readonly signal?: AbortSignal;
  readonly outputCap?: number;
};

export type CliExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
};

export type CliExecutor = (
  command: string,
  args: readonly string[],
  options: CliExecOptions,
) => Promise<CliExecResult>;

export const defaultCliExecutor: CliExecutor = async (command, args, options) => {
  return new Promise((resolve, reject) => {
    const outputCap = Math.max(1, options.outputCap ?? 1024 * 1024);
    const child = spawn(command, args as string[], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const processGroup = createOwnedProcessGroupController({
      child,
      label: `team CLI ${command}`,
      ...(options.forceKillDelayMs === undefined ? {} : { forceKillDelayMs: options.forceKillDelayMs }),
    });

    let stdout = "";
    let stderr = "";
    let terminationCause: "timeout" | "abort" | undefined;
    let spawnError: Error | undefined;
    let timer: NodeJS.Timeout | null = null;

    const appendCapped = (current: string, chunk: Buffer): string => {
      if (current.length >= outputCap) return current;
      return `${current}${chunk.toString("utf8")}`.slice(0, outputCap);
    };

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        terminationCause ??= "timeout";
        void processGroup.terminate().catch(() => undefined);
      }, options.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    const onAbort = () => {
      terminationCause ??= "abort";
      void processGroup.terminate().catch(() => undefined);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => { spawnError = err; });
    child.on("close", async (code) => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      try {
        await (terminationCause ? processGroup.terminate() : processGroup.settle());
      } catch (error) {
        reject(error);
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        stdout,
        stderr: terminationCause === "abort" ? `${stderr}\nteam CLI request aborted`.trim() : stderr,
        exitCode: typeof code === "number" ? code : -1,
        timedOut: terminationCause === "timeout",
      });
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }
  });
};

export type WhichFn = (binary: string) => string | null;

export const defaultWhich: WhichFn = (binary) => {
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${binary}${ext}`;
      try {
        // Require executable bit on Unix; on Windows F_OK is enough because
        // PATHEXT entries are themselves executables-by-convention.
        const mode = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
        accessSync(candidate, mode);
        return candidate;
      } catch {
        // not present or not executable — try next
      }
    }
  }
  return null;
};
