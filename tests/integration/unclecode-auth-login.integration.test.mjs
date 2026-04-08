import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);
const AUTH_URL_PATTERN = /https?:\/\/\S+\/oauth\/authorize\S*/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCapturedOutput(stdout, stderr) {
  return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForAuthUrl(input) {
  const match = input.stdoutRef().match(AUTH_URL_PATTERN);
  if (match) {
    return match[0];
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(
          `Timed out waiting for auth URL.\n${formatCapturedOutput(
            input.stdoutRef(),
            input.stderrRef(),
          )}`,
        ),
      );
    }, input.timeoutMs);

    const onData = () => {
      const nextMatch = input.stdoutRef().match(AUTH_URL_PATTERN);
      if (nextMatch) {
        finish(resolve, nextMatch[0]);
      }
    };

    input.child.stdout.on("data", onData);
    input.exitPromise.then(
      ({ code, signal }) => {
        finish(
          reject,
          new Error(
            `Child exited before auth URL (code=${code ?? "null"}, signal=${signal ?? "null"}).\n${formatCapturedOutput(
              input.stdoutRef(),
              input.stderrRef(),
            )}`,
          ),
        );
      },
      (error) => finish(reject, error),
    );

    function finish(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.child.stdout.off("data", onData);
      callback(value);
    }
  });
}

async function waitForListenerReady(input) {
  const redirect = new URL(input.redirectUri);
  const hostname = redirect.hostname;
  const port = Number(
    redirect.port || (redirect.protocol === "https:" ? 443 : 80),
  );
  const deadline = Date.now() + input.timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: hostname, port });

        const cleanup = () => {
          socket.off("connect", onConnect);
          socket.off("error", onError);
        };

        const onConnect = () => {
          cleanup();
          socket.end();
          socket.destroy();
          resolve(undefined);
        };

        const onError = (error) => {
          cleanup();
          socket.destroy();
          reject(error);
        };

        socket.on("connect", onConnect);
        socket.on("error", onError);
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }

  throw new Error(
    `Timed out waiting for callback listener on ${hostname}:${port}${
      lastError instanceof Error ? ` (${lastError.message})` : ""
    }`,
  );
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
}

test("waitForListenerReady resolves once a delayed callback listener binds", async () => {
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const probeAddress = portProbe.address();
  const callbackPort = probeAddress.port;
  await closeServer(portProbe);

  const delayedServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  const timer = setTimeout(() => {
    delayedServer.listen(callbackPort, "127.0.0.1");
  }, 150);

  try {
    await waitForListenerReady({
      redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      timeoutMs: 1000,
    });
  } finally {
    clearTimeout(timer);
    if (delayedServer.listening) {
      await closeServer(delayedServer);
    }
  }
});

test("built unclecode cli prints a browser oauth URL in print mode", () => {
  const result = spawnSync(
    "node",
    [builtCliEntrypoint, "auth", "login", "--browser", "--print"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_OAUTH_CLIENT_ID: "client_123",
        OPENAI_OAUTH_REDIRECT_URI: "http://localhost:7777/callback",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/auth\.openai\.com\/oauth\/authorize/);
  assert.match(result.stdout, /client_id=client_123/);
  assert.match(result.stdout, /model\.request/);
  assert.match(result.stdout, /api\.model\.read/);
});

test("built unclecode cli auth login reports existing Codex oauth when client id is absent", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-browser-login-codex-"),
  );
  const codexDir = path.join(tempDir, ".codex");
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString(
    "base64url",
  );
  const token = `${header}.${payload}.sig`;

  try {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: token, refresh_token: "rt_123" },
      }),
      "utf8",
    );

    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "auth", "login", "--browser"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Saved auth found\.$/m);
    assert.match(result.stdout, /^Provider: OpenAI Codex$/m);
    assert.match(result.stdout, /^Auth: oauth-file$/m);
    assert.match(
      result.stdout,
      /next model request will verify provider access/i,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli auth login --browser --print refuses codex-derived browser PKCE without OPENAI_OAUTH_CLIENT_ID", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-browser-relogin-codex-"),
  );
  const codexDir = path.join(tempDir, ".codex");
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const accessPayload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      scp: ["openid", "profile"],
    }),
  ).toString("base64url");
  const idPayload = Buffer.from(
    JSON.stringify({ aud: ["app_client_derived"] }),
  ).toString("base64url");
  const token = `${header}.${accessPayload}.sig`;
  const idToken = `${header}.${idPayload}.sig`;

  try {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: token,
          refresh_token: "rt_123",
          id_token: idToken,
        },
      }),
      "utf8",
    );

    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "auth", "login", "--browser", "--print"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_OAUTH_CLIENT_ID: "",
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Browser OAuth needs OPENAI_OAUTH_CLIENT_ID/i);
    assert.match(result.stderr, /auth login --device/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli auth login --device can derive client id from codex auth", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-device-login-codex-"),
  );
  const credentialsPath = path.join(tempDir, "openai-codex.json");
  const codexDir = path.join(tempDir, ".codex");
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const idPayload = Buffer.from(
    JSON.stringify({ aud: ["app_client_device"] }),
  ).toString("base64url");
  const idToken = `${header}.${idPayload}.sig`;

  const server = createServer((req, res) => {
    if (req.url === "/api/accounts/deviceauth/usercode") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        assert.equal(parsed.client_id, "app_client_device");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            device_auth_id: "device-auth-123",
            user_code: "user_123",
            interval: 0,
          }),
        );
      });
      return;
    }

    if (req.url === "/api/accounts/deviceauth/token") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        assert.equal(parsed.device_auth_id, "device-auth-123");
        assert.equal(parsed.user_code, "user_123");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            authorization_code: "code_123",
            code_verifier: "verifier_123",
          }),
        );
      });
      return;
    }

    if (req.url === "/oauth/token") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsed = new URLSearchParams(body);
        assert.equal(parsed.get("client_id"), "app_client_device");
        assert.equal(parsed.get("grant_type"), "authorization_code");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ access_token: "at_123", refresh_token: "rt_123" }),
        );
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: idToken,
        },
      }),
      "utf8",
    );

    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        "node",
        [builtCliEntrypoint, "auth", "login", "--device"],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            HOME: tempDir,
            OPENAI_OAUTH_CLIENT_ID: "",
            OPENAI_OAUTH_BASE_URL: baseUrl,
            UNCLECODE_OPENAI_CODEX_CREDENTIALS_PATH: credentialsPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /user_123/);
    assert.match(result.stdout, /OpenAI Codex/i);
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(saved.refreshToken, "rt_123");
  } finally {
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli auth login --api-key-stdin stores api key credentials", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-api-key-login-"));
  const credentialsPath = path.join(tempDir, "openai.json");

  try {
    const result = spawnSync(
      "node",
      [
        builtCliEntrypoint,
        "auth",
        "login",
        "--api-key-stdin",
        "--org",
        "org_file",
        "--project",
        "proj_file",
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        input: "sk-file-123\n",
        env: {
          ...process.env,
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /API key login saved/i);

    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(saved.authType, "api-key");
    assert.equal(saved.apiKey, "sk-file-123");
    assert.equal(saved.organizationId, "org_file");
    assert.equal(saved.projectId, "proj_file");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli rejects insecure --api-key argv login", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-api-key-argv-"));
  const credentialsPath = path.join(tempDir, "openai.json");

  try {
    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "auth", "login", "--api-key", "sk-file-123"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--api-key-stdin/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli auth logout clears stored credentials", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-auth-logout-"));
  const credentialsPath = path.join(tempDir, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "api-key",
        apiKey: "sk-file-123",
        organizationId: null,
        projectId: null,
      }),
      "utf8",
    );

    const result = spawnSync("node", [builtCliEntrypoint, "auth", "logout"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Signed out/i);

    const statusResult = spawnSync(
      "node",
      [builtCliEntrypoint, "auth", "status"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_AUTH_TOKEN: "",
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    );

    assert.match(statusResult.stdout, /source: none/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli auth logout reports remaining env auth honestly", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-auth-logout-env-"),
  );
  const credentialsPath = path.join(tempDir, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "api-key",
        apiKey: "sk-file-123",
        organizationId: null,
        projectId: null,
      }),
      "utf8",
    );

    const result = spawnSync("node", [builtCliEntrypoint, "auth", "logout"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_AUTH_TOKEN: "",
        OPENAI_API_KEY: "sk-env-456",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Local credentials cleared\./i);
    assert.match(result.stdout, /Auth: api-key-env/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli completes browser login callback flow and stores credentials", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-browser-login-"));
  const credentialsPath = path.join(tempDir, "openai.json");
  const tokenServer = createServer((req, res) => {
    if (req.url === "/oauth/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "at_browser",
          refresh_token: "rt_browser",
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  const tokenAddress = tokenServer.address();
  const tokenBaseUrl = `http://127.0.0.1:${tokenAddress.port}`;
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const probeAddress = portProbe.address();
  const callbackPort = probeAddress.port;
  await new Promise((resolve) => portProbe.close(resolve));
  const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;

  try {
    const child = spawn(
      "node",
      [builtCliEntrypoint, "auth", "login", "--browser"],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          OPENAI_OAUTH_CLIENT_ID: "client_123",
          OPENAI_OAUTH_REDIRECT_URI: redirectUri,
          OPENAI_OAUTH_BASE_URL: tokenBaseUrl,
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitPromise = waitForChildExit(child);
    const authUrlString = await waitForAuthUrl({
      child,
      exitPromise,
      stdoutRef: () => stdout,
      stderrRef: () => stderr,
      timeoutMs: 15000,
    });
    const authUrl = new URL(authUrlString);
    const state = authUrl.searchParams.get("state");

    assert.ok(state, `Missing state param in auth URL: ${authUrl}`);

    await waitForListenerReady({
      redirectUri,
      timeoutMs: 10000,
    });

    const callbackResponse = await fetch(
      `${redirectUri}?code=code_123&state=${state}`,
    );
    const callbackBody = await callbackResponse.text();

    assert.equal(callbackResponse.status, 200, callbackBody);
    assert.match(callbackBody, /return to the terminal/i);

    const exitResult = await exitPromise;

    assert.equal(exitResult.code, 0, stderr);
    assert.match(stdout, /Login successful/);

    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(credentials.accessToken, "at_browser");
    assert.equal(credentials.refreshToken, "rt_browser");
  } finally {
    await closeServer(tokenServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
