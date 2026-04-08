import { readOpenAICredentials } from "./openai-credential-store.js";
import { resolveOpenAIAuth } from "./openai-auth.js";
import type { OpenAIAuthStatus } from "./types.js";

export async function resolveOpenAIAuthStatus(options: {
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<OpenAIAuthStatus> {
  const env = options.env ?? process.env;
  const credentialsPath = env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim();
  const auth = await resolveOpenAIAuth({
    env,
    ...(credentialsPath ? { fallbackAuthPath: credentialsPath } : {}),
  });
  const refreshRequired = auth.status !== "ok" && auth.reason === "auth-refresh-required";
  const insufficientScope = auth.status !== "ok" && auth.reason === "auth-insufficient-scope";
  const storedCredentials = credentialsPath ? await readOpenAICredentials({ credentialsPath }) : null;

  return {
    providerId: "openai-api",
    activeSource:
      auth.source === "env-openai-api-key"
        ? "api-key-env"
        : auth.source === "env-openai-auth-token"
          ? "oauth-env"
        : auth.source === "unclecode-auth-file" || auth.source === "codex-auth-file"
          ? auth.authType === "api-key"
            ? "api-key-file"
            : "oauth-file"
          : "none",
    authType: auth.authType,
    organizationId:
      String(env.OPENAI_ORG_ID ?? "").trim() ||
      (auth.status === "ok" ? auth.organizationId ?? null : storedCredentials?.organizationId ?? null),
    projectId:
      String(env.OPENAI_PROJECT_ID ?? "").trim() ||
      (auth.status === "ok" ? auth.projectId ?? null : storedCredentials?.projectId ?? null),
    expiresAt: refreshRequired ? "refresh-required" : insufficientScope ? "insufficient-scope" : null,
    isExpired: auth.status === "expired" || refreshRequired || insufficientScope,
  };
}

export function formatOpenAIAuthStatus(status: OpenAIAuthStatus): string {
  return [
    `provider: ${status.providerId}`,
    `source: ${status.activeSource}`,
    `auth: ${status.authType}`,
    `organization: ${status.organizationId ?? "none"}`,
    `project: ${status.projectId ?? "none"}`,
    `expiresAt: ${status.expiresAt ?? "none"}`,
    `expired: ${status.isExpired ? "yes" : "no"}`,
  ].join("\n");
}
