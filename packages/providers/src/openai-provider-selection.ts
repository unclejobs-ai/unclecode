import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type CanonicalOpenAIProviderId = "openai-api" | "openai-codex";

export type OpenAIProviderSelection = {
  readonly providerId: CanonicalOpenAIProviderId | null;
  readonly authLabel: "api-key-env" | "api-key-file" | "oauth-env" | "oauth-file" | "none";
  readonly bearerToken?: string | undefined;
  readonly authIssueLines: readonly string[];
};

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

function hasModelRequestScope(token: string): boolean {
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

function extractAccessToken(parsed: any): string {
  return normalizeCredential(parsed?.accessToken) || normalizeCredential(parsed?.tokens?.access_token);
}

function extractApiKey(parsed: any): string {
  return parsed?.authType === "api-key" ? normalizeCredential(parsed?.apiKey) : "";
}

async function readJsonFrom(
  reader: ((authPath?: string) => Promise<string>) | undefined,
  authPath: string,
): Promise<any | null> {
  try {
    const raw = await (reader ? reader(authPath) : readFile(authPath, "utf8"));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function defaultCodexAuthPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME || homedir(), ".codex", "auth.json");
}

function defaultApiAuthPath(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim() || path.join(env.HOME || homedir(), ".unclecode", "credentials", "openai.json");
}

export function normalizeOpenAIProviderId(value: string | null | undefined): CanonicalOpenAIProviderId | null {
  if (value === "openai-api" || value === "openai-codex") {
    return value;
  }

  if (value === "openai") {
    return "openai-api";
  }

  return null;
}

export async function resolvePreferredOpenAIProvider(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly readCodexAuthFile?: ((authPath?: string) => Promise<string>) | undefined;
  readonly readApiAuthFile?: ((authPath?: string) => Promise<string>) | undefined;
  readonly codexAuthPath?: string | undefined;
  readonly apiAuthPath?: string | undefined;
} = {}): Promise<OpenAIProviderSelection> {
  const env = input.env ?? process.env;
  const envOAuthToken = normalizeCredential(env.OPENAI_AUTH_TOKEN);
  if (envOAuthToken && !isExpired(envOAuthToken)) {
    return {
      providerId: "openai-codex",
      authLabel: "oauth-env",
      bearerToken: envOAuthToken,
      authIssueLines: [],
    };
  }

  const codexAuth = await readJsonFrom(input.readCodexAuthFile, input.codexAuthPath ?? defaultCodexAuthPath(env));
  const codexAccessToken = extractAccessToken(codexAuth);
  if (codexAccessToken && !isExpired(codexAccessToken)) {
    return {
      providerId: "openai-codex",
      authLabel: "oauth-file",
      bearerToken: codexAccessToken,
      authIssueLines: [],
    };
  }

  const envApiKey = normalizeCredential(env.OPENAI_API_KEY);
  if (envApiKey) {
    return {
      providerId: "openai-api",
      authLabel: "api-key-env",
      bearerToken: envApiKey,
      authIssueLines: [],
    };
  }

  const apiAuth = await readJsonFrom(input.readApiAuthFile, input.apiAuthPath ?? defaultApiAuthPath(env));
  const storedApiKey = extractApiKey(apiAuth);
  if (storedApiKey) {
    return {
      providerId: "openai-api",
      authLabel: "api-key-file",
      bearerToken: storedApiKey,
      authIssueLines: [],
    };
  }

  const apiAccessToken = extractAccessToken(apiAuth);
  if (apiAccessToken && !isExpired(apiAccessToken) && hasModelRequestScope(apiAccessToken)) {
    return {
      providerId: "openai-api",
      authLabel: "oauth-file",
      bearerToken: apiAccessToken,
      authIssueLines: [],
    };
  }

  return {
    providerId: null,
    authLabel: "none",
    authIssueLines: [
      "OpenAI Codex: run /auth login to sign in with Codex/ChatGPT OAuth.",
      "OpenAI API: set OPENAI_API_KEY or save a key with /auth key.",
    ],
  };
}
