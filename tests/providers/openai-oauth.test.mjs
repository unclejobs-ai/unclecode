import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  buildOpenAIAuthorizationUrl,
  completeOpenAICodexDeviceLogin,
  completeOpenAIDeviceLogin,
  completeOpenAIBrowserLogin,
  createOpenAIPkcePair,
  exchangeOpenAIAuthorizationCode,
  parseOpenAICallback,
  requestOpenAIDeviceAuthorization,
  resolveReusableOpenAIOAuthClientId,
} from "@unclecode/providers";

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

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

test("createOpenAIPkcePair returns browser PKCE S256 material", () => {
  const pair = createOpenAIPkcePair();

  assert.match(pair.state, /^[0-9a-f-]{36}$/);
  assert.match(pair.codeVerifier, /^[0-9a-f]{32}$/);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.codeChallenge.includes("="), false);
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

test("resolveReusableOpenAIOAuthClientId prefers the explicit client_id claim", async () => {
  const token = jwt({ client_id: "browser_client_123", aud: ["aud_client_123"] });
  const clientId = await resolveReusableOpenAIOAuthClientId({
    env: { HOME: "/tmp/home-client-id" },
    authPaths: ["/tmp/home-client-id/.codex/auth.json"],
    readAuthFile: async () => JSON.stringify({ accessToken: token }),
  });

  assert.equal(clientId, "browser_client_123");
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

test("requestOpenAIDeviceAuthorization trims response fields through Rust parsing", async () => {
  const result = await requestOpenAIDeviceAuthorization({
    clientId: "client_123",
    scopes: ["openid", "profile"],
    fetch: async () =>
      new Response(
        JSON.stringify({
          device_code: " device_trim ",
          user_code: " user_trim ",
          verification_uri: " https://auth.openai.com/activate ",
          expires_in: 60,
          interval: 0,
        }),
      ),
  });

  assert.equal(result.deviceCode, "device_trim");
  assert.equal(result.userCode, "user_trim");
  assert.equal(result.verificationUri, "https://auth.openai.com/activate");
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

test("exchangeOpenAIAuthorizationCode trims token response fields through Rust parsing", async () => {
  const result = await exchangeOpenAIAuthorizationCode({
    clientId: "client_123",
    code: "code_123",
    codeVerifier: "verifier_123",
    redirectUri: "http://localhost:7777/callback",
    fetch: async () => new Response(JSON.stringify({ access_token: " at_trimmed ", refresh_token: " rt_trimmed " })),
  });

  assert.equal(result.accessToken, "at_trimmed");
  assert.equal(result.refreshToken, "rt_trimmed");
});

test("exchangeOpenAIAuthorizationCode uses Rust HTTP transport when no fetch is injected", async () => {
  const originalNoProxy = process.env.NO_PROXY;
  const worker = new Worker(`
    const http = require("node:http");
    const { parentPort } = require("node:worker_threads");
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        parentPort.postMessage({
          type: "request",
          request: {
            method: req.method,
            url: req.url,
            contentType: req.headers["content-type"],
            body,
          },
        });
        const responseBody = JSON.stringify({
          access_token: " at_rust ",
          refresh_token: " rt_rust ",
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(responseBody),
          connection: "close",
        });
        res.end(responseBody);
      });
    });
    parentPort.on("message", (message) => {
      if (message === "close") server.close(() => parentPort.postMessage({ type: "closed" }));
    });
    server.listen(0, "127.0.0.1", () => {
      parentPort.postMessage({ type: "listening", port: server.address().port });
    });
  `, { eval: true });

  try {
    const port = await waitForWorkerMessage(worker, "listening").then((message) => message.port);
    process.env.NO_PROXY = [originalNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    const requestPromise = waitForWorkerMessage(worker, "request").then((message) => message.request);
    const result = await exchangeOpenAIAuthorizationCode({
      clientId: "client_123",
      code: "code_123",
      codeVerifier: "verifier_123",
      redirectUri: "http://localhost:7777/callback",
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const request = await requestPromise;
    const parsedBody = new URLSearchParams(request.body);

    assert.equal(result.accessToken, "at_rust");
    assert.equal(result.refreshToken, "rt_rust");
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/oauth/token");
    assert.equal(request.contentType, "application/x-www-form-urlencoded");
    assert.equal(parsedBody.get("grant_type"), "authorization_code");
    assert.equal(parsedBody.get("client_id"), "client_123");
  } finally {
    if (originalNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = originalNoProxy;
    }
    worker.postMessage("close");
    await waitForWorkerMessage(worker, "closed");
    await worker.terminate();
  }
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
  assert.equal(writes[0].credentials.runtime, "api");
});

test("completeOpenAIDeviceLogin rejects API oauth tokens without model.request scope", async () => {
  const missingScopeToken = jwt({ scp: ["openid", "profile", "offline_access"] });

  await assert.rejects(
    () =>
      completeOpenAIDeviceLogin({
        clientId: "client_123",
        scopes: ["openid", "profile"],
        credentialsPath: "/tmp/openai-missing-scope.json",
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

          return new Response(JSON.stringify({ access_token: missingScopeToken, refresh_token: "rt_123" }));
        },
        writeCredentials: async () => {
          throw new Error("should not write insufficient-scope credentials");
        },
      }),
    /model\.request scope/,
  );
});

test("completeOpenAICodexDeviceLogin completes the codex device flow end-to-end", async () => {
  const writes = [];
  const seenUrls = [];
  const scopedToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ scp: ["openid", "profile", "offline_access"] })).toString("base64url"),
    "sig",
  ].join(".");

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
        return new Response(JSON.stringify({ access_token: scopedToken, refresh_token: "rt_123" }));
      }
      return new Response("not found", { status: 404 });
    },
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  assert.equal(result.userCode, "user_123");
  assert.equal(result.verificationUri, "http://fake-oauth.local/codex/device");
  assert.equal(writes[0].credentials.accessToken, scopedToken);
  assert.equal(writes[0].credentials.runtime, "codex");
  assert.ok(seenUrls.some((value) => value.endsWith("/api/accounts/deviceauth/usercode")));
  assert.ok(seenUrls.some((value) => value.endsWith("/api/accounts/deviceauth/token")));
  assert.ok(seenUrls.some((value) => value.endsWith("/oauth/token")));
});

test("completeOpenAICodexDeviceLogin trims device auth fields through Rust parsing", async () => {
  const writes = [];

  const result = await completeOpenAICodexDeviceLogin({
    clientId: "client_123",
    credentialsPath: "/tmp/openai-codex-trim.json",
    baseUrl: "http://fake-oauth.local",
    fetch: async (url) => {
      if (String(url).endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(JSON.stringify({ device_auth_id: " device-auth-trim ", user_code: " user_trim ", interval: 0 }));
      }
      if (String(url).endsWith("/api/accounts/deviceauth/token")) {
        return new Response(JSON.stringify({ authorization_code: " code_trim ", code_verifier: " verifier_trim " }));
      }
      return new Response(JSON.stringify({ access_token: "at_trim", refresh_token: "rt_trim" }));
    },
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  assert.equal(result.userCode, "user_trim");
  assert.equal(writes[0].credentials.accessToken, "at_trim");
});

test("completeOpenAICodexDeviceLogin stores codex runtime credentials even without model.request scope", async () => {
  const writes = [];
  const missingScopeToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ scp: ["openid", "profile", "offline_access"] })).toString("base64url"),
    "sig",
  ].join(".");

  const result = await completeOpenAICodexDeviceLogin({
    clientId: "client_123",
    credentialsPath: "/tmp/openai-codex.json",
    baseUrl: "http://fake-oauth.local",
    fetch: async (url) => {
      if (String(url).endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(JSON.stringify({ device_auth_id: "device-auth-123", user_code: "user_123", interval: 0 }));
      }
      if (String(url).endsWith("/api/accounts/deviceauth/token")) {
        return new Response(JSON.stringify({ authorization_code: "code_123", code_verifier: "verifier_123" }));
      }
      return new Response(JSON.stringify({ access_token: missingScopeToken, refresh_token: "rt_123" }));
    },
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  assert.equal(result.userCode, "user_123");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].credentials.runtime, "codex");
  assert.equal(writes[0].credentials.accessToken, missingScopeToken);
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
  assert.equal(writes[0].credentials.runtime, "api");
});
