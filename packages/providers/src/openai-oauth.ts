import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { writeOpenAICredentials } from "./openai-credential-store.js";

export function buildOpenAIAuthorizationUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly baseUrl?: string | undefined;
}): URL {
  const url = new URL(`${input.baseUrl ?? DEFAULT_OAUTH_BASE_URL}/oauth/authorize`);

  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", input.scopes.join(" "));

  return url;
}

export function parseOpenAICallback(input: {
  readonly requestUrl: string;
  readonly expectedState: string;
}): string {
  const url = new URL(input.requestUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    throw new Error("Missing authorization code.");
  }

  if (state !== input.expectedState) {
    throw new Error("Invalid OAuth state.");
  }

  return code;
}

export function createOpenAIPkcePair(): {
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
} {
  const state = randomUUID();
  const codeVerifier = randomUUID().replaceAll("-", "");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  return {
    state,
    codeVerifier,
    codeChallenge,
  };
}

type FetchLike = typeof fetch;
type WriteOpenAICredentialsLike = typeof writeOpenAICredentials;

const DEFAULT_OAUTH_BASE_URL = "https://auth.openai.com";

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

function extractOAuthClientIdFromPayload(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) {
    return undefined;
  }
  if (typeof payload.client_id === "string" && payload.client_id.trim()) {
    return payload.client_id.trim();
  }
  if (Array.isArray(payload.aud)) {
    const value = payload.aud.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return value?.trim();
  }
  if (typeof payload.aud === "string" && payload.aud.trim()) {
    return payload.aud.trim();
  }
  return undefined;
}

export async function resolveReusableOpenAIOAuthClientId(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly authPaths?: readonly string[];
  readonly readAuthFile?: ((authPath: string) => Promise<string>) | undefined;
} = {}): Promise<string | undefined> {
  const env = input.env ?? process.env;
  const resolvedHomeDir = env.HOME?.trim() || homedir();
  const authPaths = input.authPaths ?? [path.join(resolvedHomeDir, ".codex", "auth.json")];
  const readAuthFile = input.readAuthFile ?? ((authPath: string) => readFile(authPath, "utf8"));

  for (const authPath of authPaths) {
    try {
      const parsed = JSON.parse(await readAuthFile(authPath));
      const idToken = String(parsed?.idToken ?? parsed?.tokens?.id_token ?? "").trim();
      const accessToken = String(parsed?.accessToken ?? parsed?.tokens?.access_token ?? "").trim();
      const fromId = extractOAuthClientIdFromPayload(parseJwtPayload(idToken));
      if (fromId) {
        return fromId;
      }
      const fromAccess = extractOAuthClientIdFromPayload(parseJwtPayload(accessToken));
      if (fromAccess) {
        return fromAccess;
      }
    } catch {
      continue;
    }
  }

  return typeof env.OPENAI_OAUTH_CLIENT_ID === "string" && env.OPENAI_OAUTH_CLIENT_ID.trim()
    ? env.OPENAI_OAUTH_CLIENT_ID.trim()
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestOpenAIDeviceAuthorization(input: {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}): Promise<{
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}> {
  const executeFetch = input.fetch ?? fetch;
  const endpoint = `${input.baseUrl ?? DEFAULT_OAUTH_BASE_URL}/oauth/device/code`;
  const body = new URLSearchParams({
    client_id: input.clientId,
    scope: input.scopes.join(" "),
  });
  const response = await executeFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = await response.json();
  const deviceCode = String(payload.device_code ?? "").trim();
  const userCode = String(payload.user_code ?? "").trim();
  const verificationUri = String(payload.verification_uri ?? "").trim();

  if (!response.ok) {
    throw new Error(String(payload.error ?? "Device authorization request failed."));
  }
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("Missing device authorization fields in OAuth response.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: Number(payload.expires_in ?? 0),
    interval: Number(payload.interval ?? 5),
  };
}

export async function pollOpenAIDeviceAuthorization(input: {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds?: number | undefined;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}): Promise<{
  readonly accessToken: string;
  readonly refreshToken: string;
}> {
  const executeFetch = input.fetch ?? fetch;
  const endpoint = `${input.baseUrl ?? DEFAULT_OAUTH_BASE_URL}/oauth/token`;
  const startedAt = Date.now();
  let intervalSeconds = Math.max(0, input.intervalSeconds);

  while (true) {
    if (input.expiresInSeconds !== undefined) {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsedSeconds >= input.expiresInSeconds) {
        break;
      }
    }

    const body = new URLSearchParams({
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const response = await executeFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = await response.json();

    if (!response.ok && payload?.error === "slow_down") {
      intervalSeconds = Math.max(intervalSeconds + 5, 5);
      if (intervalSeconds > 0) {
        await sleep(intervalSeconds * 1000);
      }
      continue;
    }

    if (!response.ok && payload?.error === "authorization_pending") {
      if (input.intervalSeconds > 0) {
        await sleep(intervalSeconds * 1000);
      }
      continue;
    }

    if (!response.ok && payload?.error === "expired_token") {
      break;
    }

    const accessToken = String(payload.access_token ?? "").trim();
    const refreshToken = String(payload.refresh_token ?? "").trim();

    if (!accessToken || !refreshToken) {
      throw new Error("Missing access token or refresh token in device authorization response.");
    }

    return {
      accessToken,
      refreshToken,
    };
  }

  throw new Error("Device authorization did not complete in time.");
}

export async function exchangeOpenAIAuthorizationCode(input: {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}): Promise<{
  readonly accessToken: string;
  readonly refreshToken: string;
}> {
  const executeFetch = input.fetch ?? fetch;
  const endpoint = `${input.baseUrl ?? DEFAULT_OAUTH_BASE_URL}/oauth/token`;
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await executeFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = await response.json();

  const accessToken = String(payload.access_token ?? "").trim();
  const refreshToken = String(payload.refresh_token ?? "").trim();

  if (!response.ok) {
    throw new Error(String(payload.error ?? "OAuth token exchange failed."));
  }
  if (!accessToken || !refreshToken) {
    throw new Error("Missing access token or refresh token in OAuth response.");
  }

  return {
    accessToken,
    refreshToken,
  };
}

export async function requestOpenAICodexDeviceAuthorization(input: {
  readonly clientId: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}): Promise<{
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly interval: number;
}> {
  const executeFetch = input.fetch ?? fetch;
  const baseUrl = input.baseUrl ?? DEFAULT_OAUTH_BASE_URL;
  const response = await executeFetch(`${baseUrl}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: input.clientId }),
  });
  const payload = await response.json();
  const deviceAuthId = String(payload.device_auth_id ?? "").trim();
  const userCode = String(payload.user_code ?? "").trim();

  if (!response.ok) {
    throw new Error(String(payload.error ?? "Codex device authorization request failed."));
  }
  if (!deviceAuthId || !userCode) {
    throw new Error("Missing device auth fields in Codex authorization response.");
  }

  return {
    deviceAuthId,
    userCode,
    verificationUri: `${baseUrl}/codex/device`,
    interval: Number(payload.interval ?? 5),
  };
}

export async function pollOpenAICodexDeviceAuthorization(input: {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly intervalSeconds: number;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}): Promise<{
  readonly authorizationCode: string;
  readonly codeVerifier: string;
}> {
  const executeFetch = input.fetch ?? fetch;
  const endpoint = `${input.baseUrl ?? DEFAULT_OAUTH_BASE_URL}/api/accounts/deviceauth/token`;
  const startedAt = Date.now();
  const maxWaitSeconds = 15 * 60;

  while (Math.floor((Date.now() - startedAt) / 1000) < maxWaitSeconds) {
    if (input.intervalSeconds > 0) {
      await sleep(input.intervalSeconds * 1000);
    }

    const response = await executeFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
    });

    if (response.status === 403 || response.status === 404) {
      continue;
    }

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(String(payload.error ?? "Codex device authorization polling failed."));
    }

    const authorizationCode = String(payload.authorization_code ?? "").trim();
    const codeVerifier = String(payload.code_verifier ?? "").trim();
    if (!authorizationCode || !codeVerifier) {
      throw new Error("Missing authorization code or code verifier in Codex device authorization response.");
    }

    return {
      authorizationCode,
      codeVerifier,
    };
  }

  throw new Error("Codex device authorization did not complete in time.");
}

export async function completeOpenAICodexDeviceLogin(input: {
  readonly clientId: string;
  readonly credentialsPath: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly writeCredentials?: WriteOpenAICredentialsLike | undefined;
  readonly onDeviceCode?: ((info: { userCode: string; verificationUri: string }) => Promise<void> | void) | undefined;
}): Promise<{
  readonly userCode: string;
  readonly verificationUri: string;
}> {
  const baseUrl = input.baseUrl ?? DEFAULT_OAUTH_BASE_URL;
  const deviceAuthorization = await requestOpenAICodexDeviceAuthorization({
    clientId: input.clientId,
    baseUrl,
    fetch: input.fetch,
  });
  await input.onDeviceCode?.({
    userCode: deviceAuthorization.userCode,
    verificationUri: deviceAuthorization.verificationUri,
  });
  const exchange = await pollOpenAICodexDeviceAuthorization({
    deviceAuthId: deviceAuthorization.deviceAuthId,
    userCode: deviceAuthorization.userCode,
    intervalSeconds: deviceAuthorization.interval,
    baseUrl,
    fetch: input.fetch,
  });
  const tokens = await exchangeOpenAIAuthorizationCode({
    clientId: input.clientId,
    code: exchange.authorizationCode,
    codeVerifier: exchange.codeVerifier,
    redirectUri: `${baseUrl}/deviceauth/callback`,
    baseUrl,
    fetch: input.fetch,
  });

  await (input.writeCredentials ?? writeOpenAICredentials)({
    credentialsPath: input.credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: null,
    } as const,
  });

  return {
    userCode: deviceAuthorization.userCode,
    verificationUri: deviceAuthorization.verificationUri,
  };
}

export async function completeOpenAIDeviceLogin(input: {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly credentialsPath: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly writeCredentials?: WriteOpenAICredentialsLike | undefined;
  readonly onDeviceCode?: ((info: { userCode: string; verificationUri: string }) => Promise<void> | void) | undefined;
}): Promise<{
  readonly userCode: string;
  readonly verificationUri: string;
}> {
  const deviceAuthorization = await requestOpenAIDeviceAuthorization({
    clientId: input.clientId,
    scopes: input.scopes,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });
  await input.onDeviceCode?.({
    userCode: deviceAuthorization.userCode,
    verificationUri: deviceAuthorization.verificationUri,
  });
  const tokens = await pollOpenAIDeviceAuthorization({
    clientId: input.clientId,
    deviceCode: deviceAuthorization.deviceCode,
    intervalSeconds: deviceAuthorization.interval,
    expiresInSeconds: deviceAuthorization.expiresIn,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });

  await (input.writeCredentials ?? writeOpenAICredentials)({
    credentialsPath: input.credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: null,
    },
  });

  return {
    userCode: deviceAuthorization.userCode,
    verificationUri: deviceAuthorization.verificationUri,
  };
}

export async function completeOpenAIBrowserLogin(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly callbackUrl: string;
  readonly expectedState: string;
  readonly codeVerifier: string;
  readonly credentialsPath: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly writeCredentials?: WriteOpenAICredentialsLike | undefined;
}): Promise<{
  readonly accessToken: string;
}> {
  const code = parseOpenAICallback({
    requestUrl: input.callbackUrl,
    expectedState: input.expectedState,
  });
  const tokens = await exchangeOpenAIAuthorizationCode({
    clientId: input.clientId,
    code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });

  await (input.writeCredentials ?? writeOpenAICredentials)({
    credentialsPath: input.credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: null,
    },
  });

  return {
    accessToken: tokens.accessToken,
  };
}
