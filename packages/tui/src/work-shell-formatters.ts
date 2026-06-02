import type { ExecutionTraceEvent } from "@unclecode/contracts";
import { runRustCommandSync } from "@unclecode/orchestrator";

const rustTraceLineCache = new Map<string, string>();
const rustErrorMessageCache = new Map<string, string>();

export function formatWorkShellError(message: string): string {
  const cached = rustErrorMessageCache.get(message);
  if (cached !== undefined) {
    return cached;
  }
  const formatted = runRustCommandSync(["rust", "ux", "text", "error-message"], process.cwd(), message).trimEnd();
  rustErrorMessageCache.set(message, formatted);
  return formatted;
}

export function formatAgentTraceLine(event: ExecutionTraceEvent): string {
  const key = JSON.stringify(event);
  const cached = rustTraceLineCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const line = runRustCommandSync(["rust", "ux", "text", "trace-line"], process.cwd(), key).trimEnd();
  rustTraceLineCache.set(key, line);
  return line;
}

export function formatToolTraceLine(
  event: Extract<ExecutionTraceEvent, { type: "tool.started" | "tool.completed" }>,
): string {
  return formatAgentTraceLine(event);
}

export function formatRuntimeLabel(runtime: {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}): string {
  return runRustCommandSync(
    ["rust", "ux", "text", "runtime-label"],
    process.cwd(),
    JSON.stringify(runtime),
  ).trimEnd();
}
