import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenAIAuthorizationUrl,
  completeOpenAICodexDeviceLogin,
  completeOpenAIDeviceLogin,
  completeOpenAIBrowserLogin,
  exchangeOpenAIAuthorizationCode,
  parseOpenAICallback,
  requestOpenAIDeviceAuthorization,
  resolveReusableOpenAIOAuthClientId,
} from "@unclecode/providers";

test("buildOpenAIAuthorizationUrl includes PKCE and oauth context", () => {
  const url = buildOpenAIAuthorizationUrl({
    clientId: "client_123",
    redirectUri: "http://localhost:7777/callback",
    state: "state_123",
    codeChallenge: "challenge_123",
    scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
  });

  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.searchParams.get("client_id"), "client_123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge_123");
  assert.equal(url.searchParams.get("state"), "state_123");
  assert.equal(url.searchParams.get("scope"), "openid profile offline_access model.request api.model.read");
});

test("buildOpenAIAuthorizationUrl supports a custom oauth host", () => {
  const url = buildOpenAIAuthorizationUrl({
    clientId: "client_123",
    redirectUri: "http://localhost:7777/callback",
    state: "state_123",
    codeChallenge: "challenge_123",
    scopes: ["openid", "profile"],
    baseUrl: "http://fake-oauth.local",
  });

  assert.equal(url.origin, "http://fake-oauth.local");
});

test("resolveReusableOpenAIOAuthClientId can derive a client id from codex auth", async () => {
  const idPayload = Buffer.from(JSON.stringify({ aud: ["app_client_123"] })).toString("base64url");
  const token = `header.${idPayload}.sig`;
  const clientId = await resolveReusableOpenAIOAuthClientId({
    env: { HOME: "/tmp/home-x" },
    authPaths: ["/tmp/home-x/.codex/auth.json"],
    readAuthFile: async () => JSON.stringify({ tokens: { id_token: token } }),
  });

  assert.equal(clientId, "app_client_123");
});

test("parseOpenAICallback validates state before returning auth code", () => {
  const code = parseOpenAICallback({
    requestUrl: "http://localhost:7777/callback?code=code_123&state=state_123",
    expectedState: "state_123",
  });

  assert.equal(code, "code_123");
  assert.throws(
    () =>
      parseOpenAICallback({
        requestUrl: "http://localhost:7777/callback?code=code_123&state=wrong",
        expectedState: "state_123",
      }),
  );
});

test("requestOpenAIDeviceAuthorization normalizes the device flow payload", async () => {
  let seenScope = "";
  let seenClientId = "";
  let seenContentType = "";
  const result = await requestOpenAIDeviceAuthorization({
    clientId: "client_123",
    scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
    fetch: async (_url, init) => {
      const parsedBody = new URLSearchParams(String(init?.body ?? ""));
      seenScope = String(parsedBody.get("scope") ?? "");
      seenClientId = String(parsedBody.get("client_id") ?? "");
      seenContentType = String((init?.headers ?? {})["content-type"] ?? "");
      return new Response(
        JSON.stringify({
          device_code: "device_123",
          user_code: "user_123",
          verification_uri: "https://auth.openai.com/activate",
          expires_in: 900,
          interval: 5,
        }),
      );
    },
  });

  assert.equal(result.deviceCode, "device_123");
  assert.equal(result.userCode, "user_123");
  assert.equal(seenClientId, "client_123");
  assert.equal(seenScope, "openid profile offline_access model.request api.model.read");
  assert.equal(seenContentType, "application/x-www-form-urlencoded");
});

test("pollOpenAIDeviceAuthorization is exercised via completeOpenAIDeviceLogin with retries", async () => {
  let calls = 0;

  const result = await completeOpenAIDeviceLogin({
    clientId: "client_123",
    scopes: ["openid", "profile"],
    credentialsPath: "/tmp/openai-poll-test.json",
    fetch: async (url) => {
      if (String(url).includes("device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "device_123",
            user_code: "user_poll",
            verification_uri: "https://auth.openai.com/activate",
            expires_in: 900,
            interval: 0,
          }),
        );
      }

      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: "at_poll", refresh_token: "rt_poll" }));
    },
    writeCredentials: async () => {},
  });

  assert.equal(result.userCode, "user_poll");
  assert.ok(calls >= 2, "poll should have retried at least once before succeeding");
});

test("completeOpenAIDeviceLogin tolerates slow_down responses before succeeding", async () => {
  let calls = 0;

  const result = await completeOpenAIDeviceLogin({
    clientId: "client_123",
    scopes: ["openid", "profile"],
    credentialsPath: "/tmp/openai-slow-down.json",
    fetch: async (url) => {
      if (String(url).includes("device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "device_123",
            user_code: "user_slow",
            verification_uri: "https://auth.openai.com/activate",
            expires_in: 60,
            interval: 0,
          }),
        );
      }

      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "slow_down" }), { status: 400 });
      }
      if (calls === 2) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: "at_slow", refresh_token: "rt_slow" }));
    },
    writeCredentials: async () => {},
  });

  assert.equal(result.userCode, "user_slow");
  assert.ok(calls >= 3);
});

test("exchangeOpenAIAuthorizationCode returns normalized tokens", async () => {
  let seenContentType = "";
  let seenGrantType = "";
  const result = await exchangeOpenAIAuthorizationCode({
    clientId: "client_123",
    code: "code_123",
    codeVerifier: "verifier_123",
    redirectUri: "http://localhost:7777/callback",
    baseUrl: "http://fake-oauth.local",
    fetch: async (_url, init) => {
      const parsedBody = new URLSearchParams(String(init?.body ?? ""));
      seenContentType = String((init?.headers ?? {})["content-type"] ?? "");
      seenGrantType = String(parsedBody.get("grant_type") ?? "");
      return new Response(JSON.stringify({ access_token: "at_123", refresh_token: "rt_123" }));
    },
  });

  assert.equal(result.accessToken, "at_123");
  assert.equal(result.refreshToken, "rt_123");
  assert.equal(seenContentType, "application/x-www-form-urlencoded");
  assert.equal(seenGrantType, "authorization_code");
});

test("exchangeOpenAIAuthorizationCode rejects invalid token payloads", async () => {
  await assert.rejects(
    () =>
      exchangeOpenAIAuthorizationCode({
        clientId: "client_123",
        code: "code_123",
        codeVerifier: "verifier_123",
        redirectUri: "http://localhost:7777/callback",
        fetch: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      }),
    /invalid_grant|Missing access token/i,
  );
});

test("completeOpenAIDeviceLogin stores returned oauth credentials", async () => {
  const writes = [];

  const result = await completeOpenAIDeviceLogin({
    clientId: "client_123",
    scopes: ["openid", "profile"],
    credentialsPath: "/tmp/openai.json",
    fetch: async (url) => {
      if (String(url).includes("device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "device_123",
            user_code: "user_123",
            verification_uri: "https://auth.openai.com/activate",
            expires_in: 900,
            interval: 0,
          }),
        );
      }

      return new Response(JSON.stringify({ access_token: "at_123", refresh_token: "rt_123" }));
    },
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  assert.equal(result.userCode, "user_123");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].credentials.refreshToken, "rt_123");
});

test("completeOpenAICodexDeviceLogin completes the codex device flow end-to-end", async () => {
  const writes = [];
  const seenUrls = [];

  const result = await completeOpenAICodexDeviceLogin({
    clientId: "client_123",
    credentialsPath: "/tmp/openai-codex.json",
    baseUrl: "http://fake-oauth.local",
    fetch: async (url, init) => {
      seenUrls.push(String(url));
      if (String(url).endsWith("/api/accounts/deviceauth/usercode")) {
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        assert.equal(parsed.client_id, "client_123");
        return new Response(JSON.stringify({ device_auth_id: "device-auth-123", user_code: "user_123", interval: 0 }));
      }
      if (String(url).endsWith("/api/accounts/deviceauth/token")) {
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        assert.equal(parsed.device_auth_id, "device-auth-123");
        assert.equal(parsed.user_code, "user_123");
        return new Response(JSON.stringify({ authorization_code: "code_123", code_verifier: "verifier_123" }));
      }
      if (String(url).endsWith("/oauth/token")) {
        const parsed = new URLSearchParams(String(init?.body ?? ""));
        assert.equal(parsed.get("grant_type"), "authorization_code");
        assert.equal(parsed.get("client_id"), "client_123");
        return new Response(JSON.stringify({ access_token: "at_123", refresh_token: "rt_123" }));
      }
      return new Response("not found", { status: 404 });
    },
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  assert.equal(result.userCode, "user_123");
  assert.equal(result.verificationUri, "http://fake-oauth.local/codex/device");
  assert.equal(writes[0].credentials.accessToken, "at_123");
  assert.ok(seenUrls.some((value) => value.endsWith("/api/accounts/deviceauth/usercode")));
  assert.ok(seenUrls.some((value) => value.endsWith("/api/accounts/deviceauth/token")));
  assert.ok(seenUrls.some((value) => value.endsWith("/oauth/token")));
});

test("completeOpenAIDeviceLogin exposes the device code before polling", async () => {
  const seen = [];

  await completeOpenAIDeviceLogin({
    clientId: "client_123",
    scopes: ["openid", "profile"],
    credentialsPath: "/tmp/openai.json",
    fetch: async (url) => {
      if (String(url).includes("device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "device_123",
            user_code: "user_123",
            verification_uri: "https://auth.openai.com/activate",
            expires_in: 900,
            interval: 0,
          }),
        );
      }

      return new Response(JSON.stringify({ access_token: "at_123", refresh_token: "rt_123" }));
    },
    writeCredentials: async () => {},
    onDeviceCode: async (info) => {
      seen.push(info.userCode, info.verificationUri);
    },
  });

  assert.deepEqual(seen, ["user_123", "https://auth.openai.com/activate"]);
});

test("completeOpenAIBrowserLogin exchanges callback code and stores oauth credentials", async () => {
  const writes = [];

  const result = await completeOpenAIBrowserLogin({
    clientId: "client_123",
    redirectUri: "http://localhost:7777/callback",
    callbackUrl: "http://localhost:7777/callback?code=code_123&state=state_123",
    expectedState: "state_123",
    codeVerifier: "verifier_123",
    credentialsPath: "/tmp/openai.json",
    baseUrl: "http://fake-oauth.local",
    fetch: async () => new Response(JSON.stringify({ access_token: "at_123", refresh_token: "rt_123" })),
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  assert.equal(result.accessToken, "at_123");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].credentials.refreshToken, "rt_123");
});
