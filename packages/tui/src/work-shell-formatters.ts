import type { ExecutionTraceEvent } from "@unclecode/contracts";

function summarizePrompt(value: string): string {
  return value.length > 52 ? `${value.slice(0, 49)}...` : value;
}

function summarizeJson(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 60 ? `${serialized.slice(0, 57)}...` : serialized;
}

function summarizeText(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

function getToolDisplayName(toolName: string): string {
  if (toolName === "read_file" || toolName === "list_files") return "read";
  if (toolName === "write_file") return "write";
  if (toolName === "search_text") return "search";
  if (toolName === "run_shell") return "bash";
  return toolName;
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if ((toolName === "read_file" || toolName === "write_file" || toolName === "list_files") && typeof input.path === "string") {
    return input.path;
  }
  if (toolName === "search_text" && typeof input.query === "string") {
    return input.query;
  }
  if (toolName === "run_shell" && typeof input.command === "string") {
    return input.command;
  }
  return summarizeJson(input);
}

function isAuthFailure(message: string): boolean {
  return /request failed with status (?:401|403)/i.test(message);
}

function isMissingOAuthClientId(message: string): boolean {
  return /OPENAI_OAUTH_CLIENT_ID is required for (?:OAuth|browser) login|Browser OAuth unavailable/i.test(message);
}

function summarizeFailureSummary(summary: string): string {
  if (/^Provider failed:/i.test(summary)) {
    return formatWorkShellError(summary.replace(/^Provider failed:\s*/i, ""));
  }

  return summarizeText(summary);
}

export function formatWorkShellError(message: string): string {
  if (/missing_scope|model\.request/i.test(message)) {
    return "OpenAI OAuth lacks model.request scope. Use API key login or proper browser OAuth.";
  }
  if (isAuthFailure(message)) {
    return "OpenAI rejected current auth (401/403). Saved auth may be stale. Run /auth status, /auth login, or /auth logout.";
  }
  if (isMissingOAuthClientId(message)) {
    return "Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID.";
  }

  return message;
}

export function formatAgentTraceLine(event: ExecutionTraceEvent): string {
  if (event.type === "turn.started") {
    return `· thinking ${summarizePrompt(event.prompt)}`;
  }

  if (event.type === "turn.completed") {
    return `✓ response ${event.durationMs}ms`;
  }

  if (event.type === "provider.calling") {
    return `→ model ${event.provider} ${event.model}`;
  }

  if (event.type === "tool.started") {
    return `→ ${getToolDisplayName(event.toolName)} ${summarizeToolInput(event.toolName, event.input)}`;
  }

  if (event.type === "tool.completed") {
    return `${event.isError ? "✖" : "✓"} ${getToolDisplayName(event.toolName)} ${event.durationMs}ms ${summarizeText(event.output)}`;
  }

  if (event.type === "orchestrator.step") {
    if (event.role === "coordinator") {
      return "";
    }
    if ((event.role === "planner" || event.role === "reviewer") && event.status === "completed") {
      return "";
    }
    if (event.role === "executor" && event.status === "running" && /^Calling /i.test(event.summary)) {
      return `→ model ${event.summary.replace(/^Calling\s+/i, "")}`;
    }
    if (event.role === "executor" && event.status === "failed") {
      const duration = typeof event.durationMs === "number" ? ` ${event.durationMs}ms` : "";
      return `✖ action${duration} ${summarizeFailureSummary(event.summary)}`.trim();
    }
    if (event.role === "executor" && event.status === "completed") {
      const duration = typeof event.durationMs === "number" ? ` ${event.durationMs}ms` : "";
      return `✓ action${duration} ${summarizeText(event.summary)}`.trim();
    }

    const prefix = event.status === "failed" ? "✖" : event.status === "completed" ? "✓" : event.status === "running" ? "→" : "·";
    const duration = typeof event.durationMs === "number" ? ` ${event.durationMs}ms` : "";
    const summary = event.status === "failed" ? summarizeFailureSummary(event.summary) : summarizeText(event.summary);
    return `${prefix} ${event.role}${duration} ${summary}`.trim();
  }

  if (event.type === "bridge.published") {
    return `↔ bridge ${event.kind} ${summarizeText(event.summary)}`;
  }

  return `★ memory ${event.scope} ${summarizeText(event.summary)}`;
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
  return `Node ${runtime.node} · ${runtime.platform}/${runtime.arch}`;
}
