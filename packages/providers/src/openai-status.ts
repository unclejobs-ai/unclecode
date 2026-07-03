import { runRustCommand } from "./rust-command.js";
import type { OpenAIAuthStatus } from "./types.js";

export async function resolveOpenAIAuthStatus(options: {
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<OpenAIAuthStatus> {
  const env = options.env ?? process.env;
  const stdout = await runRustCommand(["rust", "auth", "status"], process.cwd(), undefined, env);
  const fields = parseRustKeyValueLines(stdout);

  return {
    providerId: "openai",
    activeSource: normalizeAuthSource(fields.get("activeSource")),
    authType: normalizeAuthType(fields.get("authType")),
    runtime: normalizeRuntime(fields.get("runtime")),
    organizationId: normalizeOptionalField(fields.get("organizationId")),
    projectId: normalizeOptionalField(fields.get("projectId")),
    expiresAt: normalizeOptionalField(fields.get("expiresAt")),
    isExpired: fields.get("expired") === "yes",
    apiReady: fields.get("apiReady") === "yes",
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

function normalizeAuthSource(value: string | undefined): OpenAIAuthStatus["activeSource"] {
  return value === "api-key-env"
    || value === "api-key-file"
    || value === "oauth-env"
    || value === "oauth-file"
    ? value
    : "none";
}

function normalizeAuthType(value: string | undefined): OpenAIAuthStatus["authType"] {
  return value === "api-key" || value === "oauth" ? value : "none";
}

function normalizeRuntime(value: string | undefined): OpenAIAuthStatus["runtime"] {
  return value === "api" || value === "codex" ? value : null;
}

function normalizeOptionalField(value: string | undefined): string | null {
  return value && value !== "none" ? value : null;
}

export function formatOpenAIAuthStatus(status: OpenAIAuthStatus): string {
  return [
    `provider: ${status.providerId}`,
    `source: ${status.activeSource}`,
    `auth: ${status.authType}`,
    `organization: ${status.organizationId ?? "none"}`,
    `project: ${status.projectId ?? "none"}`,
    `runtime: ${status.runtime ?? "none"}`,
    `expiresAt: ${status.expiresAt ?? "none"}`,
    `expired: ${status.isExpired ? "yes" : "no"}`,
    `api ready: ${status.apiReady ? "yes" : "no"}`,
  ].join("\n");
}
