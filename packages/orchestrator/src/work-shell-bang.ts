import { spawn } from "node:child_process";

/**
 * `! <command>` in the composer: the operator's own shell command, run in the
 * session's cwd without a provider turn. The result is shown like a model's
 * `run_shell` call; it does not enter the model's context.
 */
export type WorkShellBangResult = {
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs: number;
};

const BANG_TIMEOUT_MS = 120_000;
/** Output kept for the transcript excerpt and its line count; the rest is dropped. */
const BANG_OUTPUT_MAX_BYTES = 1_000_000;

export function parseWorkShellBangCommand(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("!")) return undefined;
  const command = trimmed.slice(1).trim();
  return command.length > 0 ? command : undefined;
}

export function runWorkShellBangCommand(input: {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}): Promise<WorkShellBangResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (chunk: Buffer) => {
      if (bytes >= BANG_OUTPUT_MAX_BYTES) return;
      chunks.push(chunk.subarray(0, BANG_OUTPUT_MAX_BYTES - bytes));
      bytes += chunk.length;
    };
    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      signal: input.signal,
      timeout: BANG_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (isError: boolean, trailer?: string) => {
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({
        output: trailer ? `${output}${output.endsWith("\n") || output.length === 0 ? "" : "\n"}${trailer}` : output,
        isError,
        durationMs: Date.now() - startedAt,
      });
    };
    child.on("error", (error) => {
      finish(true, error.name === "AbortError" ? "interrupted" : error.message);
    });
    child.on("close", (code, signal) => {
      if (code === 0) finish(false);
      else finish(true, signal ? `killed by ${signal}` : `exit ${code}`);
    });
  });
}
