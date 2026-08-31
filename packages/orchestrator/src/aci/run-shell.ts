/**
 * run_shell — bounded child-process shell runner for the team-worker
 * MiniLoop. The model emits a `run_shell` action with `{command}`; we
 * spawn `/bin/sh -c <command>` pinned to the worker cwd, capture stdout
 * and stderr up to `outputCap`, and return a MiniLoopObservation.
 *
 * Caller controls cwd (worker enforces workspace pinning before this is
 * reached). Timeout and output cap are soft guardrails — the model's
 * cost / step budget is the hard one.
 */

import { spawn } from "node:child_process";
import { createOwnedProcessGroupController } from "../process-group-settlement.js";

export type RunShellInput = {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly outputCap?: number;
  readonly forceKillDelayMs?: number;
  readonly signal?: AbortSignal;
};

export type RunShellResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_CAP = 64 * 1024;

export async function runShell(input: RunShellInput): Promise<RunShellResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputCap = input.outputCap ?? DEFAULT_OUTPUT_CAP;

  if (typeof input.command !== "string" || input.command.trim().length === 0) {
    return { stdout: "", stderr: "run_shell: empty command", exitCode: -1, truncated: false };
  }

  return await new Promise<RunShellResult>((resolvePromise) => {
    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const processGroup = createOwnedProcessGroupController({
      child,
      label: "run_shell",
      ...(input.forceKillDelayMs === undefined ? {} : { forceKillDelayMs: input.forceKillDelayMs }),
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let terminationCause: "timeout" | "abort" | undefined;
    let spawnError: Error | undefined;

    const settle = (result: RunShellResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };

    const onChunk = (
      kind: "stdout" | "stderr",
      data: Buffer,
    ): void => {
      const text = data.toString("utf8");
      if (kind === "stdout") {
        if (stdout.length + text.length > outputCap) {
          stdout = `${stdout}${text}`.slice(0, outputCap);
          truncated = true;
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length + text.length > outputCap) {
          stderr = `${stderr}${text}`.slice(0, outputCap);
          truncated = true;
        } else {
          stderr += text;
        }
      }
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      terminationCause ??= "timeout";
      void processGroup.terminate().catch(() => undefined);
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      terminationCause ??= "abort";
      void processGroup.terminate().catch(() => undefined);
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (data: Buffer) => onChunk("stdout", data));
    child.stderr.on("data", (data: Buffer) => onChunk("stderr", data));

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", async (code, signal) => {
      let settlementError: unknown;
      try {
        await (terminationCause ? processGroup.terminate() : processGroup.settle());
      } catch (error) {
        settlementError = error;
      }
      const suffix = terminationCause === "timeout"
        ? `run_shell: timed out after ${timeoutMs}ms`
        : terminationCause === "abort"
          ? "run_shell: aborted"
          : spawnError?.message ?? (settlementError instanceof Error ? settlementError.message : undefined);
      const exitCode = typeof code === "number"
        ? code
        : signal != null ? -1 : 0;
      settle({
        stdout,
        stderr: suffix ? `${stderr}\n${suffix}`.trim() : stderr,
        exitCode: terminationCause || spawnError || settlementError ? -1 : exitCode,
        truncated,
      });
    });
  });
}
