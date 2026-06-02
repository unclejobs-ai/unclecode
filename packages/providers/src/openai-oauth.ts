import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { writeOpenAICredentials } from "./openai-credential-store.js";
import { runRustCommand, runRustCommandSync } from "./rust-command.js";

export function buildOpenAIAuthorizationUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly baseUrl?: string | undefined;
}): URL {
  const stdout = runRustCommandSync(
    [
      "rust",
      "auth",
      "authorization-url",
      input.clientId,
      input.redirectUri,
      input.state,
      input.codeChallenge,
      input.baseUrl ?? "-",
      ...input.scopes,
    ],
    process.cwd(),
  );
  return new URL(stdout.trim());
}

export function parseOpenAICallback(input: {
  readonly requestUrl: string;
  readonly expectedState: string;
}): string {
  const stdout = runRustCommandSync(
    ["rust", "auth", "parse-callback", input.expectedState],
    process.cwd(),
    process.env,
    input.requestUrl,
  );
  const code = parseRustKeyValueLines(stdout).get("code");
  if (!code) {
    throw new Error("Missing authorization code.");
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
  const codeChallenge = runRustCommandSync(
    ["rust", "sha256-base64url"],
    process.cwd(),
    process.env,
    codeVerifier,
  ).trim();

  return {
    state,
    codeVerifier,
    codeChallenge,
  };
}

type FetchLike = typeof fetch;
type WriteOpenAICredentialsLike = typeof writeOpenAICredentials;

const DEFAULT_OAUTH_BASE_URL = "https://auth.openai.com";

type OpenAIOAuthTokenInspection = {
  readonly clientId?: string;
  readonly hasModelRequestScope: boolean;
};

type OpenAIOAuthTokenResponse = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly error?: string;
};

type OpenAIDeviceAuthorizationResponse = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly error?: string;
};

type OpenAICodexDeviceAuthorizationResponse = {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly interval: number;
  readonly error?: string;
};

type OpenAICodexDeviceTokenResponse = {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly error?: string;
};

type RustHttpResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
};

async function writeOpenAICredentialsViaRust(input: Parameters<WriteOpenAICredentialsLike>[0]): Promise<void> {
  if ("rawContents" in input) {
    await writeOpenAICredentials(input);
    return;
  }
  if (input.credentials.authType !== "oauth") {
    await writeOpenAICredentials(input);
    return;
  }
  await runRustCommand(
    [
      "rust",
      "auth",
      "save-oauth",
      input.credentials.runtime ?? "api",
      input.credentials.organizationId ?? "-",
      input.credentials.projectId ?? "-",
      input.credentials.accountId ?? "-",
    ],
    process.cwd(),
    `${input.credentials.accessToken}\n${input.credentials.refreshToken}\n`,
    {
      ...process.env,
      UNCLECODE_OPENAI_CREDENTIALS_PATH: input.credentialsPath,
    },
  );
}

function inspectOAuthToken(token: string): OpenAIOAuthTokenInspection {
  const stdout = runRustCommandSync(
    ["rust", "auth", "inspect-oauth-token"],
    process.cwd(),
    process.env,
    token,
  );
  const fields = parseRustKeyValueLines(stdout);
  const clientId = normalizeOptionalField(fields.get("clientId"));
  return {
    ...(clientId ? { clientId } : {}),
    hasModelRequestScope: fields.get("hasModelRequestScope") !== "false",
  };
}

function parseOAuthTokenResponseBody(raw: string): OpenAIOAuthTokenResponse {
  const stdout = runRustCommandSync(
    ["rust", "auth", "parse-token-response"],
    process.cwd(),
    process.env,
    raw,
  );
  const fields = parseRustKeyValueLines(stdout);
  const error = normalizeOptionalField(fields.get("error"));
  return {
    accessToken: normalizeOptionalField(fields.get("accessToken")) ?? "",
    refreshToken: normalizeOptionalField(fields.get("refreshToken")) ?? "",
    ...(error ? { error } : {}),
  };
}

function parseDeviceAuthorizationResponseBody(raw: string): OpenAIDeviceAuthorizationResponse {
  const stdout = runRustCommandSync(
    ["rust", "auth", "parse-device-response"],
    process.cwd(),
    process.env,
    raw,
  );
  const fields = parseRustKeyValueLines(stdout);
  const error = normalizeOptionalField(fields.get("error"));
  return {
    deviceCode: normalizeOptionalField(fields.get("deviceCode")) ?? "",
    userCode: normalizeOptionalField(fields.get("userCode")) ?? "",
    verificationUri: normalizeOptionalField(fields.get("verificationUri")) ?? "",
    expiresIn: parseOptionalNumber(fields.get("expiresIn"), 0),
    interval: parseOptionalNumber(fields.get("interval"), 5),
    ...(error ? { error } : {}),
  };
}

function parseCodexDeviceAuthorizationResponseBody(raw: string): OpenAICodexDeviceAuthorizationResponse {
  const stdout = runRustCommandSync(
    ["rust", "auth", "parse-codex-device-response"],
    process.cwd(),
    process.env,
    raw,
  );
  const fields = parseRustKeyValueLines(stdout);
  const error = normalizeOptionalField(fields.get("error"));
  return {
    deviceAuthId: normalizeOptionalField(fields.get("deviceAuthId")) ?? "",
    userCode: normalizeOptionalField(fields.get("userCode")) ?? "",
    interval: parseOptionalNumber(fields.get("interval"), 5),
    ...(error ? { error } : {}),
  };
}

function parseCodexDeviceTokenResponseBody(raw: string): OpenAICodexDeviceTokenResponse {
  const stdout = runRustCommandSync(
    ["rust", "auth", "parse-codex-token-response"],
    process.cwd(),
    process.env,
    raw,
  );
  const fields = parseRustKeyValueLines(stdout);
  const error = normalizeOptionalField(fields.get("error"));
  return {
    authorizationCode: normalizeOptionalField(fields.get("authorizationCode")) ?? "",
    codeVerifier: normalizeOptionalField(fields.get("codeVerifier")) ?? "",
    ...(error ? { error } : {}),
  };
}

async function readResponseBodyForRustParsing(response: Response): Promise<string> {
  if (typeof response.text === "function") {
    return response.text();
  }
  const json = await response.json();
  return JSON.stringify(json);
}

function buildOAuthRequestSpec(kind: string, baseUrl: string | undefined): {
  readonly url: string;
  readonly contentType: string;
} {
  const stdout = runRustCommandSync(
    ["rust", "auth", "request-spec", kind, baseUrl ?? "-"],
    process.cwd(),
    process.env,
  );
  const fields = parseRustKeyValueLines(stdout);
  return {
    url: normalizeRequiredField(fields.get("url"), "url"),
    contentType: normalizeRequiredField(fields.get("contentType"), "contentType"),
  };
}

function postOAuthWithRust(kind: string, baseUrl: string | undefined, body: string): RustHttpResponse {
  const spec = buildOAuthRequestSpec(kind, baseUrl);
  const raw = runRustCommandSync(
    ["rust", "http", "post", spec.url],
    process.cwd(),
    process.env,
    `${JSON.stringify({ "content-type": spec.contentType })}\0${body}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean" || typeof parsed.status !== "number") {
    throw new Error("Rust OAuth HTTP transport returned an invalid response envelope.");
  }
  return {
    ok: parsed.ok,
    status: parsed.status,
    text: typeof parsed.text === "string"
      ? parsed.text
      : typeof parsed.body === "string"
        ? parsed.body
        : "",
  };
}

async function postOAuthRequest(input: {
  readonly kind: string;
  readonly baseUrl?: string | undefined;
  readonly body: string;
  readonly fetch?: FetchLike | undefined;
}): Promise<RustHttpResponse> {
  if (!input.fetch) {
    return postOAuthWithRust(input.kind, input.baseUrl, input.body);
  }
  const spec = buildOAuthRequestSpec(input.kind, input.baseUrl);
  const response = await input.fetch(spec.url, {
    method: "POST",
    headers: { "content-type": spec.contentType },
    body: input.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: await readResponseBodyForRustParsing(response),
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

function normalizeRequiredField(value: string | undefined, field: string): string {
  const normalized = normalizeOptionalField(value);
  if (!normalized) {
    throw new Error(`Rust OAuth command did not return ${field}.`);
  }
  return normalized;
}

function normalizeOptionalField(value: string | undefined): string | undefined {
  return value && value !== "none" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalNumber(value: string | undefined, fallback: number): number {
  if (!value || value === "none") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildOAuthRequestBody(kind: string, args: readonly string[]): string {
  return runRustCommandSync(
    ["rust", "auth", "request-body", kind, ...args],
    process.cwd(),
  ).trim();
}

function assertModelRequestScope(accessToken: string): void {
  if (!inspectOAuthToken(accessToken).hasModelRequestScope) {
    throw new Error("OAuth token lacks model.request scope. Use API key login or proper browser OAuth with OPENAI_OAUTH_CLIENT_ID.");
  }
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
      const fromId = idToken ? inspectOAuthToken(idToken).clientId : undefined;
      if (fromId) {
        return fromId;
      }
      const fromAccess = accessToken ? inspectOAuthToken(accessToken).clientId : undefined;
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
  const body = buildOAuthRequestBody("device-code", [input.clientId, ...input.scopes]);
  const response = await postOAuthRequest({
    kind: "device-code",
    baseUrl: input.baseUrl ?? DEFAULT_OAUTH_BASE_URL,
    body,
    fetch: input.fetch,
  });
  const payload = parseDeviceAuthorizationResponseBody(response.text);

  if (!response.ok) {
    throw new Error(String(payload.error ?? "Device authorization request failed."));
  }
  if (!payload.deviceCode || !payload.userCode || !payload.verificationUri) {
    throw new Error("Missing device authorization fields in OAuth response.");
  }

  return {
    deviceCode: payload.deviceCode,
    userCode: payload.userCode,
    verificationUri: payload.verificationUri,
    expiresIn: payload.expiresIn,
    interval: payload.interval,
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
  const startedAt = Date.now();
  let intervalSeconds = Math.max(0, input.intervalSeconds);

  while (true) {
    if (input.expiresInSeconds !== undefined) {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsedSeconds >= input.expiresInSeconds) {
        break;
      }
    }

    const body = buildOAuthRequestBody("device-token", [input.clientId, input.deviceCode]);
    const response = await postOAuthRequest({
      kind: "device-token",
      baseUrl: input.baseUrl ?? DEFAULT_OAUTH_BASE_URL,
      body,
      fetch: input.fetch,
    });
    const payload = parseOAuthTokenResponseBody(response.text);

    if (!response.ok && payload.error === "slow_down") {
      intervalSeconds = Math.max(intervalSeconds + 5, 5);
      if (intervalSeconds > 0) {
        await sleep(intervalSeconds * 1000);
      }
      continue;
    }

    if (!response.ok && payload.error === "authorization_pending") {
      if (input.intervalSeconds > 0) {
        await sleep(intervalSeconds * 1000);
      }
      continue;
    }

    if (!response.ok && payload.error === "expired_token") {
      break;
    }

    if (!payload.accessToken || !payload.refreshToken) {
      throw new Error("Missing access token or refresh token in device authorization response.");
    }

    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
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
  const body = buildOAuthRequestBody("authorization-code", [
    input.clientId,
    input.code,
    input.codeVerifier,
    input.redirectUri,
  ]);
  const response = await postOAuthRequest({
    kind: "authorization-code",
    baseUrl: input.baseUrl ?? DEFAULT_OAUTH_BASE_URL,
    body,
    fetch: input.fetch,
  });
  const payload = parseOAuthTokenResponseBody(response.text);

  if (!response.ok) {
    throw new Error(String(payload.error ?? "OAuth token exchange failed."));
  }
  if (!payload.accessToken || !payload.refreshToken) {
    throw new Error("Missing access token or refresh token in OAuth response.");
  }

  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
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
  const baseUrl = input.baseUrl ?? DEFAULT_OAUTH_BASE_URL;
  const response = await postOAuthRequest({
    kind: "codex-device-code",
    baseUrl,
    body: buildOAuthRequestBody("codex-device-code", [input.clientId]),
    fetch: input.fetch,
  });
  const payload = parseCodexDeviceAuthorizationResponseBody(response.text);

  if (!response.ok) {
    throw new Error(String(payload.error ?? "Codex device authorization request failed."));
  }
  if (!payload.deviceAuthId || !payload.userCode) {
    throw new Error("Missing device auth fields in Codex authorization response.");
  }

  return {
    deviceAuthId: payload.deviceAuthId,
    userCode: payload.userCode,
    verificationUri: `${baseUrl}/codex/device`,
    interval: payload.interval,
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
  const startedAt = Date.now();
  const maxWaitSeconds = 15 * 60;

  while (Math.floor((Date.now() - startedAt) / 1000) < maxWaitSeconds) {
    if (input.intervalSeconds > 0) {
      await sleep(input.intervalSeconds * 1000);
    }

    const response = await postOAuthRequest({
      kind: "codex-device-token",
      baseUrl: input.baseUrl ?? DEFAULT_OAUTH_BASE_URL,
      body: buildOAuthRequestBody("codex-device-token", [input.deviceAuthId, input.userCode]),
      fetch: input.fetch,
    });

    if (response.status === 403 || response.status === 404) {
      continue;
    }

    const payload = parseCodexDeviceTokenResponseBody(response.text);
    if (!response.ok) {
      throw new Error(String(payload.error ?? "Codex device authorization polling failed."));
    }

    if (!payload.authorizationCode || !payload.codeVerifier) {
      throw new Error("Missing authorization code or code verifier in Codex device authorization response.");
    }

    return {
      authorizationCode: payload.authorizationCode,
      codeVerifier: payload.codeVerifier,
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

  await (input.writeCredentials ?? writeOpenAICredentialsViaRust)({
    credentialsPath: input.credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: null,
      runtime: "codex",
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

  assertModelRequestScope(tokens.accessToken);

  await (input.writeCredentials ?? writeOpenAICredentialsViaRust)({
    credentialsPath: input.credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: null,
      runtime: "api",
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

  assertModelRequestScope(tokens.accessToken);

  await (input.writeCredentials ?? writeOpenAICredentialsViaRust)({
    credentialsPath: input.credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: null,
      runtime: "api",
    },
  });

  return {
    accessToken: tokens.accessToken,
  };
}
