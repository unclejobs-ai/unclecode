import { runRustCommand } from "@unclecode/orchestrator";
import { getSessionStoreRoot } from "@unclecode/session-store";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  isModeReasoningEffort,
  markUnrecoverableAgentConsoleWorkInterrupted,
  parseAgentConsoleSnapshot,
  type AgentConsoleSnapshot,
  type ModeReasoningEffort,
} from "@unclecode/contracts";

export type WorkRuntimeAuthIssueInput = {
  authStatus?: Pick<RustOpenAIAuthStatus, "authType" | "runtime" | "expiresAt" | "apiReady">;
  authIssueMessage?: string | undefined;
};

export type RustOpenAIAuthStatus = {
  readonly activeSource: string;
  readonly authType: string;
  readonly runtime: "api" | "codex" | null;
  readonly expiresAt: string | null;
  readonly isExpired: boolean;
  readonly apiReady: boolean;
};

export function workShellAuthLabelWithApiBlocked(
  authLabel: string,
  authStatus?: Pick<RustOpenAIAuthStatus, "authType" | "apiReady" | "activeSource"> | undefined,
): string {
  if (
    authStatus?.authType === "oauth"
    && authStatus.apiReady === false
    && authStatus.activeSource.startsWith("oauth-")
  ) {
    return `${authStatus.activeSource}-api-blocked`;
  }
  return authLabel;
}

export type RustResolvedOpenAIAuth = {
  readonly status: "ok" | "missing" | "expired";
  readonly authType: "api-key" | "oauth" | "none";
  readonly source: string;
  readonly bearerToken: string;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly accountId: string | null;
  readonly runtime: "api" | "codex" | null;
  readonly reason: string | null;
};

export function deriveAuthIssueLines(input: WorkRuntimeAuthIssueInput): readonly string[] {
  if (input.authStatus?.expiresAt === "insufficient-scope") {
    return ["Auth issue: saved OAuth lacks model.request scope. Use /auth key, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."];
  }
  if (input.authStatus?.expiresAt === "refresh-required") {
    return ["Auth issue: saved OAuth needs refresh. Use /auth login or /auth logout before asking the model to work."];
  }
  if (input.authStatus?.authType === "oauth" && input.authStatus.apiReady === false) {
    return input.authStatus.runtime === "codex"
      ? ["Auth issue: saved Codex OAuth is not API-ready for OpenAI API tool calling. Use /auth key, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."]
      : ["Auth issue: saved OAuth is not API-ready for OpenAI API tool calling. Use /auth key, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."];
  }
  return input.authIssueMessage ? [input.authIssueMessage] : [];
}

export async function loadResumedWorkSession(input: {
  cwd: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  sessionId: string;
  initialTraceMode?: "minimal" | "verbose";
  reasoningEffort?: ModeReasoningEffort;
  lastSubmittedContextReceiptId?: string;
  contextLine: string;
  initialEntries: readonly { readonly role: "system" | "user" | "assistant" | "tool"; readonly text: string }[];
  initialAgentConsole?: AgentConsoleSnapshot;
  initialSessionSummary?: string;
}> {
  const stdout = await runRustCommand(
    ["rust", "session", "resume-json", input.sessionId],
    input.cwd,
    undefined,
    input.env ?? process.env,
  );
  const resumed = parseRustResumedWorkSession(stdout);

  const initialEntries = resumed.initialEntries.length > 0
    ? resumed.initialEntries
    : await loadLegacySessionSummaryEntries({
        sessionId: resumed.sessionId,
        env: input.env ?? process.env,
      });

  return {
    sessionId: resumed.sessionId,
    ...(resumed.traceMode
      ? { initialTraceMode: resumed.traceMode }
      : {}),
    ...(resumed.reasoningEffort
      ? { reasoningEffort: resumed.reasoningEffort }
      : {}),
    ...(resumed.lastSubmittedContextReceiptId
      ? { lastSubmittedContextReceiptId: resumed.lastSubmittedContextReceiptId }
      : {}),
    contextLine: resumed.contextLine,
    initialEntries,
    ...(resumed.initialSessionSummary
      ? { initialSessionSummary: resumed.initialSessionSummary }
      : {}),
    ...(resumed.initialAgentConsole
      ? { initialAgentConsole: resumed.initialAgentConsole }
      : {}),
  };
}

async function loadLegacySessionSummaryEntries(input: {
  sessionId: string;
  env: NodeJS.ProcessEnv;
}): Promise<readonly { readonly role: "system" | "user" | "assistant" | "tool"; readonly text: string }[]> {
  const memoryPath = path.join(
    getSessionStoreRoot(input.env),
    "memory",
    "sessions",
    `${input.sessionId}.jsonl`,
  );
  try {
    const raw = await readFile(memoryPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { summary?: unknown })
      .map((record) => typeof record.summary === "string" ? parseLegacySessionSummary(record.summary) : [])
      .flat()
      .slice(-12);
  } catch {
    return [];
  }
}

function parseLegacySessionSummary(summary: string): readonly {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
}[] {
  const matched = /^Q:\s*(.*?)\s*·\s*A:\s*(.*)$/s.exec(summary);
  if (!matched) {
    return [];
  }
  const question = matched[1] ?? "";
  const answer = matched[2] ?? "";
  const entries = [] as {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly text: string;
  }[];
  if (question.trim().length > 0) {
    entries.push({ role: "user", text: question.trim() });
  }
  if (answer.trim().length > 0) {
    entries.push({ role: "assistant", text: answer.trim() });
  }
  return entries;
}

export async function resolveRustOpenAIAuthStatus(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RustOpenAIAuthStatus> {
  const stdout = await runRustCommand(
    ["rust", "auth", "status"],
    input.cwd,
    undefined,
    input.env ?? process.env,
  );
  const fields = parseRustKeyValueLines(stdout);
  return {
    activeSource: fields.get("activeSource") ?? "none",
    authType: fields.get("authType") ?? "none",
    runtime: normalizeRuntime(fields.get("runtime")),
    expiresAt: normalizeAuthExpiry(fields.get("expiresAt")),
    isExpired: fields.get("expired") === "yes",
    apiReady: fields.get("apiReady") === "yes",
  };
}

export async function resolveRustOpenAIAuth(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RustResolvedOpenAIAuth> {
  const stdout = await runRustCommand(
    ["rust", "auth", "resolve"],
    input.cwd,
    undefined,
    input.env ?? process.env,
  );
  const fields = parseRustKeyValueLines(stdout);
  const status = fields.get("status");
  const authType = fields.get("authType");
  const runtime = normalizeRuntime(fields.get("runtime"));
  return {
    status: status === "ok" || status === "expired" ? status : "missing",
    authType: authType === "api-key" || authType === "oauth" ? authType : "none",
    source: fields.get("source") ?? "none",
    bearerToken: normalizeOptionalField(fields.get("bearerToken")) ?? "",
    organizationId: normalizeOptionalField(fields.get("organizationId")),
    projectId: normalizeOptionalField(fields.get("projectId")),
    accountId: normalizeOptionalField(fields.get("accountId")),
    runtime,
    reason: normalizeOptionalField(fields.get("reason")),
  };
}

function parseRustResumedWorkSession(stdout: string): {
  readonly sessionId: string;
  readonly traceMode?: "minimal" | "verbose";
  readonly reasoningEffort?: ModeReasoningEffort;
  readonly lastSubmittedContextReceiptId?: string;
  readonly contextLine: string;
  readonly initialEntries: readonly { readonly role: "system" | "user" | "assistant" | "tool"; readonly text: string }[];
  readonly initialAgentConsole?: AgentConsoleSnapshot;
  readonly initialSessionSummary?: string;
} {
  const parsed = JSON.parse(stdout) as {
    sessionId?: unknown;
    traceMode?: unknown;
    reasoningEffort?: unknown;
    lastSubmittedContextReceiptId?: unknown;
    contextLine?: unknown;
    initialEntries?: unknown;
    initialSessionSummary?: unknown;
    agentConsole?: unknown;
  };
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
  if (!sessionId) {
    throw new Error("Rust session resume returned no session id.");
  }
  const traceMode = parsed.traceMode;
  const reasoningEffort = parsed.reasoningEffort;
  const lastSubmittedContextReceiptId = parsed.lastSubmittedContextReceiptId;
  const initialEntries = Array.isArray(parsed.initialEntries)
    ? parsed.initialEntries.filter((entry): entry is { readonly role: "system" | "user" | "assistant" | "tool"; readonly text: string } =>
        Boolean(entry)
        && typeof entry === "object"
        && (((entry as { role?: unknown }).role === "system")
          || ((entry as { role?: unknown }).role === "user")
          || ((entry as { role?: unknown }).role === "assistant")
          || ((entry as { role?: unknown }).role === "tool"))
        && typeof (entry as { text?: unknown }).text === "string")
    : [];
  // The resume boundary is the only place unrecoverable work settles: the
  // parser gate rebuilds the safe projection, then a run or job that was still
  // active when the process died becomes `interrupted` exactly once, before the
  // snapshot reaches engine state.
  const parsedAgentConsole = parseAgentConsoleSnapshot(parsed.agentConsole);
  const initialAgentConsole = parsedAgentConsole
    ? markUnrecoverableAgentConsoleWorkInterrupted(parsedAgentConsole)
    : undefined;
  return {
    sessionId,
    ...(traceMode === "minimal" || traceMode === "verbose" ? { traceMode } : {}),
    ...(isModeReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
    ...(typeof lastSubmittedContextReceiptId === "string" && lastSubmittedContextReceiptId.trim()
      ? { lastSubmittedContextReceiptId }
      : {}),
    contextLine: typeof parsed.contextLine === "string" ? parsed.contextLine : `Resumed session: ${sessionId}`,
    initialEntries,
    ...(typeof parsed.initialSessionSummary === "string"
      ? { initialSessionSummary: parsed.initialSessionSummary }
      : {}),
    ...(initialAgentConsole ? { initialAgentConsole } : {}),
  };
}

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return separatorIndex === -1
          ? undefined
          : [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)] as const;
      })
      .filter((parts): parts is readonly [string, string] => parts !== undefined),
  );
}

function normalizeAuthExpiry(value: string | undefined): string | null {
  return value && value !== "none" ? value : null;
}

function normalizeOptionalField(value: string | undefined): string | null {
  return value && value !== "none" ? value : null;
}

function normalizeRuntime(value: string | undefined): "api" | "codex" | null {
  return value === "api" || value === "codex" ? value : null;
}
