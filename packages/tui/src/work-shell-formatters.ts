import type { ExecutionTraceEvent } from "@unclecode/contracts";
import {
  getWorkShellMessages,
  runRustCommandSync,
  type WorkShellUiLocale,
} from "@unclecode/orchestrator";

const rustTraceLineCache = new Map<string, string>();
const rustErrorMessageCache = new Map<string, string>();
const TRACE_LINE_CACHE_MAX_ENTRIES = 512;
const ERROR_MESSAGE_CACHE_MAX_ENTRIES = 64;

function cacheFormatted<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
}

export function formatWorkShellError(message: string): string {
  const cached = rustErrorMessageCache.get(message);
  if (cached !== undefined) {
    return cached;
  }
  const formatted = runRustCommandSync(["rust", "ux", "text", "error-message"], process.cwd(), message).trimEnd();
  cacheFormatted(rustErrorMessageCache, message, formatted, ERROR_MESSAGE_CACHE_MAX_ENTRIES);
  return formatted;
}

export function formatAgentTraceLine(
  event: ExecutionTraceEvent,
  uiLocale: WorkShellUiLocale = "en",
): string {
  if (event.type === "plugin.diagnostic") {
    const labels = getWorkShellMessages(uiLocale).pluginDiagnostic;
    return [
      labels.externalPlugin,
      `${labels.source} ${event.source}`,
      `${labels.trust} ${event.trustLane}`,
      `${labels.plugin} ${event.pluginName}`,
      `${labels.hook} ${event.hookName}`,
      `${labels.status} ${labels.errorStatus}`,
      ...(event.exitStatus ? [`${labels.exit} ${event.exitStatus}`] : []),
      `${labels.error} ${event.errorName}: ${event.errorMessage}`,
      `${labels.dedupe} ${event.dedupeKey}`,
    ].join(" · ");
  }
  const key = JSON.stringify(event);
  const cached = rustTraceLineCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const line = runRustCommandSync(["rust", "ux", "text", "trace-line"], process.cwd(), key).trimEnd();
  cacheFormatted(rustTraceLineCache, key, line, TRACE_LINE_CACHE_MAX_ENTRIES);
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
