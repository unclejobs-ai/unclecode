import { runRustCommand } from "@unclecode/orchestrator";

export type WorkRuntimeAuthIssueInput = {
  authStatus?: Pick<RustOpenAIAuthStatus, "expiresAt">;
  authIssueMessage?: string | undefined;
};

export type RustOpenAIAuthStatus = {
  readonly activeSource: string;
  readonly authType: string;
  readonly expiresAt: string | null;
  readonly isExpired: boolean;
};

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
  return input.authStatus?.expiresAt === "insufficient-scope"
    ? ["Auth issue: saved OAuth lacks model.request scope. Use /auth key, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."]
    : input.authStatus?.expiresAt === "refresh-required"
      ? ["Auth issue: saved OAuth needs refresh. Use /auth login or /auth logout before asking the model to work."]
      : input.authIssueMessage
        ? [input.authIssueMessage]
        : [];
}

export async function loadResumedWorkSession(input: {
  cwd: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  sessionId: string;
  initialTraceMode?: "minimal" | "verbose";
  reasoningEffort?: "low" | "medium" | "high";
  contextLine: string;
}> {
  const stdout = await runRustCommand(
    ["rust", "session", "resume", input.sessionId],
    input.cwd,
    undefined,
    input.env ?? process.env,
  );
  const resumed = parseRustResumedWorkSession(stdout);

  return {
    sessionId: resumed.sessionId,
    ...(resumed.traceMode
      ? { initialTraceMode: resumed.traceMode }
      : {}),
    ...(resumed.reasoningEffort
      ? { reasoningEffort: resumed.reasoningEffort }
      : {}),
    contextLine: resumed.contextLine,
  };
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
    expiresAt: normalizeAuthExpiry(fields.get("expiresAt")),
    isExpired: fields.get("expired") === "yes",
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
  readonly reasoningEffort?: "low" | "medium" | "high";
  readonly contextLine: string;
} {
  const fields = parseRustKeyValueLines(stdout);
  const sessionId = fields.get("sessionId");
  if (!sessionId) {
    throw new Error("Rust session resume returned no session id.");
  }
  const traceMode = fields.get("traceMode");
  const reasoningEffort = fields.get("reasoningEffort");
  return {
    sessionId,
    ...(traceMode === "minimal" || traceMode === "verbose" ? { traceMode } : {}),
    ...(reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high"
      ? { reasoningEffort }
      : {}),
    contextLine: fields.get("contextLine") ?? `Resumed session: ${sessionId}`,
  };
}

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
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
