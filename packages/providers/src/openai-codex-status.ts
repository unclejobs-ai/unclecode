import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { readOpenAICodexCredentials } from "./openai-codex-credential-store.js";

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isExpired(token: string): boolean {
  const payload = parseJwtPayload(token);
  const exp = typeof payload?.exp === "number" ? payload.exp : null;
  if (exp === null) {
    return false;
  }
  return exp <= Math.floor(Date.now() / 1000) + 60;
}

function normalizeCredential(value: string | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "";
}

function getCredentialsPath(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_OPENAI_CODEX_CREDENTIALS_PATH?.trim() || path.join(env.HOME || homedir(), ".unclecode", "credentials", "openai-codex.json");
}

function getReusableCodexAuthPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME || homedir(), ".codex", "auth.json");
}

async function readReusableCodexAuth(env: NodeJS.ProcessEnv): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(getReusableCodexAuthPath(env), "utf8"));
    const accessToken = normalizeCredential(parsed?.accessToken) || normalizeCredential(parsed?.tokens?.access_token);
    const refreshToken = normalizeCredential(parsed?.refreshToken) || normalizeCredential(parsed?.tokens?.refresh_token);
    if (!accessToken) {
      return null;
    }
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}

export async function resolveOpenAICodexAuthStatus(options: {
  readonly env?: NodeJS.ProcessEnv;
} = {}) {
  const env = options.env ?? process.env;
  const envToken = normalizeCredential(env.OPENAI_AUTH_TOKEN);

  if (envToken) {
    return {
      providerId: "openai-codex" as const,
      activeSource: "oauth-env" as const,
      authType: "oauth" as const,
      organizationId: String(env.OPENAI_ORG_ID ?? "").trim() || null,
      projectId: String(env.OPENAI_PROJECT_ID ?? "").trim() || null,
      expiresAt: isExpired(envToken) ? "refresh-required" : null,
      isExpired: isExpired(envToken),
    };
  }

  const storedCredentials = await readOpenAICodexCredentials({ credentialsPath: getCredentialsPath(env) });
  const reusableCodexAuth = storedCredentials?.accessToken ? null : await readReusableCodexAuth(env);
  const accessToken = storedCredentials?.accessToken ?? reusableCodexAuth?.accessToken ?? "";
  const refreshToken = storedCredentials?.refreshToken ?? reusableCodexAuth?.refreshToken ?? "";

  if (!accessToken) {
    return {
      providerId: "openai-codex" as const,
      activeSource: "none" as const,
      authType: "none" as const,
      organizationId: null,
      projectId: null,
      expiresAt: null,
      isExpired: false,
    };
  }

  const expired = isExpired(accessToken);
  const refreshRequired = expired && refreshToken.trim().length > 0;

  return {
    providerId: "openai-codex" as const,
    activeSource: "oauth-file" as const,
    authType: "oauth" as const,
    organizationId: storedCredentials?.organizationId ?? null,
    projectId: storedCredentials?.projectId ?? null,
    expiresAt: refreshRequired ? "refresh-required" : null,
    isExpired: expired,
  };
}

export function formatOpenAICodexAuthStatus(status: {
  readonly providerId: "openai-codex";
  readonly activeSource: "oauth-env" | "oauth-file" | "none";
  readonly authType: "oauth" | "none";
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly expiresAt: string | null;
  readonly isExpired: boolean;
}): string {
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
