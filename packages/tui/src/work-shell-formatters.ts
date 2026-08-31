import { createInstrumentedLruCache, type ExecutionTraceEvent } from "@unclecode/contracts";
import {
  getWorkShellMessages,
  runRustCommandSync,
  type WorkShellUiLocale,
} from "@unclecode/orchestrator";

const TRACE_LINE_CACHE_MAX_ENTRIES = 512;
const ERROR_MESSAGE_CACHE_MAX_ENTRIES = 64;
const TRACE_LINE_CACHE_MAX_RETAINED_BYTES = 512 * 1024;
const ERROR_MESSAGE_CACHE_MAX_RETAINED_BYTES = 128 * 1024;
const rustTraceLineCache = createInstrumentedLruCache<string, string>({
  name: "tui-rust-trace-lines",
  maxEntries: TRACE_LINE_CACHE_MAX_ENTRIES,
  maxRetainedBytes: TRACE_LINE_CACHE_MAX_RETAINED_BYTES,
});
const rustErrorMessageCache = createInstrumentedLruCache<string, string>({
  name: "tui-rust-error-messages",
  maxEntries: ERROR_MESSAGE_CACHE_MAX_ENTRIES,
  maxRetainedBytes: ERROR_MESSAGE_CACHE_MAX_RETAINED_BYTES,
});

export function formatWorkShellError(message: string): string {
  const cached = rustErrorMessageCache.lookup(message);
  if (cached.hit) {
    return cached.value;
  }
  const formatted = runRustCommandSync(["rust", "ux", "text", "error-message"], process.cwd(), message).trimEnd();
  rustErrorMessageCache.set(message, formatted);
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
  const cached = rustTraceLineCache.lookup(key);
  if (cached.hit) {
    return cached.value;
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
