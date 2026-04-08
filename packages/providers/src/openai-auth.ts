import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ResolveOpenAIAuthInput, ResolvedOpenAIAuth } from "./types.js";

function normalizeCredential(value: string | undefined): string {
  const trimmed = String(value ?? "").trim();
  const normalized = trimmed.toLowerCase();

  if (
    trimmed.length === 0 ||
    normalized === "changeme" ||
    normalized.startsWith("your_") ||
    normalized.startsWith("example_") ||
    normalized.includes("api_key_here") ||
    normalized.includes("token_here")
  ) {
    return "";
  }

  return trimmed;
}

function defaultFallbackAuthPath(): string {
  return path.join(homedir(), ".unclecode", "credentials", "openai.json");
}

function defaultCodexAuthPath(): string {
  return path.join(homedir(), ".codex", "auth.json");
}

function defaultFallbackAuthPaths(): readonly string[] {
  return [defaultFallbackAuthPath(), defaultCodexAuthPath()];
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payloadPart = parts[1];

  if (parts.length < 2 || payloadPart === undefined) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getJwtExpiry(token: string): number | null {
  const payload = parseJwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp : null;
}

function isExpired(token: string): boolean {
  const exp = getJwtExpiry(token);

  if (exp === null) {
    return false;
  }

  return exp <= Math.floor(Date.now() / 1000) + 60;
}

function getAuthFileSource(authPath: string | undefined): "unclecode-auth-file" | "codex-auth-file" {
  return authPath?.includes(`${path.sep}.codex${path.sep}`) ? "codex-auth-file" : "unclecode-auth-file";
}

function hasRequiredModelRequestScope(token: string): boolean {
  const payload = parseJwtPayload(token);
  if (!payload) {
    return true;
  }

  const scopeValue = payload.scp ?? payload.scope;
  const scopes = Array.isArray(scopeValue)
    ? scopeValue.filter((value): value is string => typeof value === "string")
    : typeof scopeValue === "string"
      ? scopeValue.split(/\s+/).filter(Boolean)
      : [];

  return scopes.length === 0 || scopes.includes("model.request");
}

function rankFailure(result: ResolvedOpenAIAuth): number {
  if (result.status === "missing" && result.reason === "auth-insufficient-scope") return 4;
  if (result.status === "missing" && result.reason === "auth-refresh-required") return 3;
  if (result.status === "expired") return 2;
  if (result.status === "missing" && result.reason === "auth-token-missing") return 1;
  return 0;
}

export async function resolveOpenAIAuth(
  input: ResolveOpenAIAuthInput = {},
): Promise<ResolvedOpenAIAuth> {
  const env = input.env ?? process.env;
  const authToken = normalizeCredential(env.OPENAI_AUTH_TOKEN);

  if (authToken) {
    if (isExpired(authToken)) {
      return {
        status: "expired",
        authType: "oauth",
        source: "env-openai-auth-token",
        reason: "auth-token-expired",
      };
    }

    return {
      status: "ok",
      authType: "oauth",
      source: "env-openai-auth-token",
      bearerToken: authToken,
    };
  }

  const apiKey = normalizeCredential(env.OPENAI_API_KEY);

  if (apiKey) {
    return {
      status: "ok",
      authType: "api-key",
      source: "env-openai-api-key",
      bearerToken: apiKey,
    };
  }

  const candidatePaths =
    input.fallbackAuthPaths && input.fallbackAuthPaths.length > 0
      ? [...input.fallbackAuthPaths]
      : input.fallbackAuthPath
        ? [input.fallbackAuthPath]
        : [...defaultFallbackAuthPaths()];
  const readFallbackFile =
    input.readFallbackFile ?? ((authPath?: string) => readFile(authPath ?? defaultFallbackAuthPath(), "utf8"));

  let bestFailure: ResolvedOpenAIAuth | undefined;

  const rememberFailure = (candidate: ResolvedOpenAIAuth): void => {
    if (!bestFailure || rankFailure(candidate) > rankFailure(bestFailure)) {
      bestFailure = candidate;
    }
  };

  for (const authPath of candidatePaths) {
    try {
      const source = getAuthFileSource(authPath);
      const parsed = JSON.parse(await readFallbackFile(authPath));
      const apiKey = parsed?.authType === "api-key" ? normalizeCredential(parsed?.apiKey) : "";
      if (apiKey) {
        return {
          status: "ok",
          authType: "api-key",
          source: "unclecode-auth-file",
          bearerToken: apiKey,
          organizationId: normalizeCredential(parsed?.organizationId) || null,
          projectId: normalizeCredential(parsed?.projectId) || null,
        };
      }

      const accessToken = normalizeCredential(parsed?.accessToken) || normalizeCredential(parsed?.tokens?.access_token);
      const refreshToken = normalizeCredential(parsed?.refreshToken) || normalizeCredential(parsed?.tokens?.refresh_token);

      if (!accessToken) {
        rememberFailure({
          status: "missing",
          authType: "none",
          source: "none",
          reason: "auth-token-missing",
        });
        continue;
      }

      if (isExpired(accessToken)) {
        rememberFailure(
          refreshToken
            ? {
                status: "missing",
                authType: "oauth",
                source,
                reason: "auth-refresh-required",
              }
            : {
                status: "expired",
                authType: "oauth",
                source,
                reason: "auth-token-expired",
              },
        );
        continue;
      }

      if (!hasRequiredModelRequestScope(accessToken)) {
        rememberFailure({
          status: "missing",
          authType: "oauth",
          source,
          reason: "auth-insufficient-scope",
        });
        continue;
      }

      return {
        status: "ok",
        authType: "oauth",
        source,
        bearerToken: accessToken,
        organizationId: normalizeCredential(parsed?.organizationId) || null,
        projectId: normalizeCredential(parsed?.projectId) || null,
      };
    } catch {
      rememberFailure({
        status: "missing",
        authType: "none",
        source: "none",
        reason: "auth-file-missing",
      });
    }
  }

  return bestFailure ?? {
    status: "missing",
    authType: "none",
    source: "none",
    reason: "auth-file-missing",
  };
}
