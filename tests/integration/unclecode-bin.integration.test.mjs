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
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const binEntrypoint = path.join(workspaceRoot, "bin/unclecode.cjs");

function runNodeAsync(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", args, {
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(options.input ?? "");
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function reservePort() {
  const server = createServer();
  await listen(server);
  const address = server.address();
  assert.equal(typeof address, "object");
  const { port } = address;
  await closeServer(server);
  return port;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildUnsignedJwt(payload) {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw lastError;
}

test("root bin wrapper exposes unclecode version", () => {
  const result = spawnSync("node", [binEntrypoint, "--version"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^0\.1\.0$/);
});

test("root bin wrapper handles native command help without error", () => {
  const commands = [
    ["center", "--help"],
    ["config", "--help"],
    ["mcp", "--help"],
    ["mode", "--help"],
    ["harness", "--help"],
    ["sessions", "--help"],
    ["setup", "--help"],
    ["doctor", "--help"],
    ["work", "--help"],
    ["tui", "--help"],
  ];

  for (const args of commands) {
    const result = spawnSync("node", [binEntrypoint, ...args], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
});

test("root bin wrapper runs work prompt on the Rust provider loop", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-work-prompt-"),
  );
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "native work prompt ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });

  try {
    await listen(server);
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await runNodeAsync(
      [
        binEntrypoint,
        "work",
        "--engine",
        "native",
        "--provider",
        "openai",
        "say",
        "ok",
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "sk-work-test",
          OPENAI_AUTH_TOKEN: "",
          OPENAI_MODEL: "gpt-5.5",
          OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "native work prompt ok");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer sk-work-test");
    const body = JSON.parse(requests[0].body);
    assert.equal(body.model, "gpt-5.5");
    assert.match(JSON.stringify(body.messages), /say ok/);
    assert.match(JSON.stringify(body.messages), /You are UncleCode/);
    assert.doesNotMatch(JSON.stringify(body.tools), /apply_patch/);
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper runs empty work as a Rust line session with CJK prompt text", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-work-repl-"));
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "native work repl ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });

  try {
    await listen(server);
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await runNodeAsync(
      [binEntrypoint, "work", "--engine", "native"],
      {
        cwd: tempDir,
        input: "하이 🙂\n/exit\n",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "sk-work-repl-test",
          OPENAI_AUTH_TOKEN: "",
          OPENAI_MODEL: "gpt-5.5",
          OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UncleCode · OpenAI/);
    assert.match(result.stdout, /native work repl ok/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.match(
      JSON.stringify(JSON.parse(requests[0].body).messages),
      /하이 🙂/,
    );
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin work session treats nested unclecode as REPL guidance, not a prompt", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-work-reentry-"),
  );
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }),
      );
    });
  });

  try {
    await listen(server);
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await runNodeAsync(
      [binEntrypoint, "work", "--engine", "native"],
      {
        cwd: tempDir,
        input: "unclecode\nunclecode auth status\n/auth login\n/exit\n",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "sk-work-reentry-test",
          OPENAI_AUTH_TOKEN: "",
          OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Already inside UncleCode/);
    assert.match(result.stdout, /Use \/auth status here/);
    assert.match(
      result.stdout,
      /OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser/,
    );
    assert.match(result.stdout, /unclecode auth login --api-key-stdin/);
    assert.equal(requests.length, 0);
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin work session collapses OpenAI missing-scope JSON into guidance", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-work-scope-error-"),
  );
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "You have insufficient permissions for this operation. Missing scopes: model.request.",
            type: "invalid_request_error",
            code: "missing_scope",
          },
        }),
      );
    });
  });

  try {
    await listen(server);
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await runNodeAsync(
      [binEntrypoint, "work", "--engine", "native"],
      {
        cwd: tempDir,
        input: "하이\n/exit\n",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "sk-work-scope-test",
          OPENAI_AUTH_TOKEN: "",
          OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenAI OAuth lacks model\.request scope/);
    assert.doesNotMatch(result.stdout, /"error"/);
    assert.doesNotMatch(result.stdout, /missing_scope/);
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper opens Rust work help without provider credentials", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-work-offline-"),
  );

  try {
    const result = await runNodeAsync(
      [binEntrypoint, "work", "--engine", "native"],
      {
        cwd: tempDir,
        input: "/help\n/status\n/exit\n",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "",
          OPENAI_AUTH_TOKEN: "",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UncleCode · OpenAI/);
    assert.match(result.stdout, /\/model <id>/);
    assert.match(result.stdout, /auth: missing/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper opens default Rust work session with no args", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-default-work-"),
  );

  try {
    const result = await runNodeAsync([binEntrypoint], {
      cwd: tempDir,
      input: "/status\n/exit\n",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_API_KEY: "",
        OPENAI_AUTH_TOKEN: "",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UncleCode · OpenAI/);
    assert.match(result.stdout, /auth: missing/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles center on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-center-"));
  const sessionStoreRoot = path.join(tempDir, ".state");

  try {
    const seedScript = `
      import { createSessionStore } from '@unclecode/session-store';
      const store = createSessionStore({ rootDir: ${JSON.stringify(sessionStoreRoot)} });
      const ref = { projectPath: ${JSON.stringify(tempDir)}, sessionId: 'session-center-rust-bin' };
      await store.appendCheckpoint(ref, { type: 'state', state: 'idle' });
      await store.appendCheckpoint(ref, { type: 'metadata', metadata: { model: 'gpt-5.4' } });
      await store.appendCheckpoint(ref, { type: 'task_summary', summary: 'Review center routing', timestamp: '2026-04-02T00:00:00.000Z' });
      await store.appendCheckpoint(ref, { type: 'mode', mode: 'coordinator' });
      await store.appendCheckpoint(ref, { type: 'approval', pendingAction: { toolName: 'mcp.list', actionDescription: 'List MCP servers', toolUseId: 'tool-1', requestId: 'req-1' } });
    `;

    const seed = spawnSync(
      "node",
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        seedScript,
      ],
      { cwd: workspaceRoot, encoding: "utf8" },
    );
    assert.equal(seed.status, 0, seed.stderr);

    const result = spawnSync("node", [binEntrypoint, "center"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UncleCode Center/);
    assert.match(result.stdout, /runtime: rust-native/);
    assert.match(result.stdout, /session-center-rust-bin/);
    assert.match(result.stdout, /state=idle/);
    assert.match(result.stdout, /model=gpt-5\.4/);
    assert.match(result.stdout, /pending=mcp\.list/);
    assert.match(result.stdout, /Review center routing/);
    assert.match(result.stdout, /unclecode resume session-center-rust-bin/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles empty center on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-center-empty-"),
  );

  try {
    const result = spawnSync("node", [binEntrypoint, "/center"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: path.join(tempDir, ".state"),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UncleCode Center/);
    assert.match(result.stdout, /No resumable sessions found\./);
    assert.match(result.stdout, /start: unclecode work/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles auth status on the Rust path", () => {
  const result = spawnSync("node", [binEntrypoint, "auth", "status"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-bin-test",
      OPENAI_AUTH_TOKEN: "",
      OPENAI_ORG_ID: "org_bin",
      OPENAI_PROJECT_ID: "proj_bin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /provider: openai/);
  assert.match(result.stdout, /source: api-key-env/);
  assert.match(result.stdout, /auth: api-key/);
  assert.match(result.stdout, /organization: org_bin/);
  assert.match(result.stdout, /project: proj_bin/);
  assert.doesNotMatch(result.stdout, /sk-bin-test/);
});

test("root bin wrapper handles auth status json on the Rust path", () => {
  const result = spawnSync(
    "node",
    [binEntrypoint, "auth", "status", "--json"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-bin-json-test",
        OPENAI_AUTH_TOKEN: "",
        OPENAI_ORG_ID: "org_bin_json",
        OPENAI_PROJECT_ID: "proj_bin_json",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, {
    provider: "openai",
    source: "api-key-env",
    type: "api-key",
    organizationId: "org_bin_json",
    projectId: "proj_bin_json",
    runtime: null,
    expiresAt: null,
    expired: false,
    apiReady: true,
    recovery: null,
  });
  assert.doesNotMatch(result.stdout, /sk-bin-json-test/);
});

test("root bin wrapper reports actionable recovery for Codex OAuth auth status", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-auth-status-codex-"),
  );
  const codexDir = path.join(tempDir, ".codex");
  const token = buildUnsignedJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: ["codex_client_saved"],
  });

  try {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: token, refresh_token: "rt-bin-status" },
      }),
      "utf8",
    );

    const humanResult = spawnSync("node", [binEntrypoint, "auth", "status"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_API_KEY: "",
        OPENAI_AUTH_TOKEN: "",
      },
    });

    assert.equal(humanResult.status, 0, humanResult.stderr);
    assert.match(humanResult.stdout, /runtime: codex/);
    assert.match(humanResult.stdout, /api ready: no/);
    assert.match(
      humanResult.stdout,
      /recovery: openai-oauth-codex-runtime-not-api-ready/,
    );
    assert.match(
      humanResult.stdout,
      /next: OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser/,
    );
    assert.match(
      humanResult.stdout,
      /next: unclecode auth login --api-key-stdin/,
    );
    assert.match(humanResult.stdout, /verify: npm run qa:live/);

    const jsonResult = spawnSync(
      "node",
      [binEntrypoint, "auth", "status", "--json"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "",
          OPENAI_AUTH_TOKEN: "",
        },
      },
    );

    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const payload = JSON.parse(jsonResult.stdout);
    assert.equal(payload.apiReady, false);
    assert.equal(payload.runtime, "codex");
    assert.equal(
      payload.recovery.reason,
      "openai-oauth-codex-runtime-not-api-ready",
    );
    assert.deepEqual(payload.recovery.commands, [
      "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
      "unclecode auth login --api-key-stdin",
      "OPENAI_API_KEY=<key> npm run qa:live",
      "npm run qa:live",
    ]);
    assert.equal(payload.recovery.verify, "npm run qa:live");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles slash auth status on the Rust path", () => {
  const result = spawnSync("node", [binEntrypoint, "/auth status"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-bin-slash-test",
      OPENAI_AUTH_TOKEN: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source: api-key-env/);
  assert.doesNotMatch(result.stdout, /sk-bin-slash-test/);
});

test("root bin wrapper handles auth logout on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-auth-"));
  const credentialsPath = path.join(tempDir, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "api-key",
        apiKey: "sk-file-bin-test",
        organizationId: null,
        projectId: null,
      }),
      "utf8",
    );

    const result = spawnSync("node", [binEntrypoint, "auth", "logout"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Signed out\./);
    assert.match(result.stdout, /Auth: none/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles API key stdin login on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-auth-key-"));
  const credentialsPath = path.join(tempDir, "openai.json");

  try {
    const result = spawnSync(
      "node",
      [
        binEntrypoint,
        "auth",
        "login",
        "--api-key-stdin",
        "--org",
        "org_bin",
        "--project",
        "proj_bin",
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
        input: "sk-bin-login-test\n",
        env: {
          ...process.env,
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /API key login saved\./);
    assert.match(result.stdout, /Source: api-key-file/);
    assert.doesNotMatch(result.stdout, /sk-bin-login-test/);

    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(saved.authType, "api-key");
    assert.equal(saved.apiKey, "sk-bin-login-test");
    assert.equal(saved.organizationId, "org_bin");
    assert.equal(saved.projectId, "proj_bin");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper prints browser OAuth URL on the Rust path", () => {
  const result = spawnSync(
    "node",
    [binEntrypoint, "auth", "login", "--print"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_OAUTH_CLIENT_ID: "client_bin",
        OPENAI_OAUTH_REDIRECT_URI: "http://localhost:7777/callback",
        OPENAI_OAUTH_BASE_URL: "https://auth.example.test",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const url = new URL(result.stdout.trim());
  assert.equal(url.origin, "https://auth.example.test");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client_bin");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:7777/callback",
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    url.searchParams.get("code_challenge") ?? "",
    /^[A-Za-z0-9_-]+$/,
  );
  assert.match(url.searchParams.get("scope") ?? "", /model\.request/);
});

test("root bin wrapper reports missing browser OAuth client id on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-auth-browser-"),
  );

  try {
    const result = spawnSync(
      "node",
      [binEntrypoint, "auth", "login", "--browser"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "",
          OPENAI_AUTH_TOKEN: "",
          OPENAI_OAUTH_CLIENT_ID: "",
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /OPENAI_OAUTH_CLIENT_ID is required|Browser OAuth needs OPENAI_OAUTH_CLIENT_ID/,
    );
    assert.doesNotMatch(
      result.stderr,
      /Usage: unclecode auth <login\|status\|logout>/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper completes device OAuth on the Rust path", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-auth-device-"),
  );
  const credentialsPath = path.join(tempDir, "openai.json");
  const seenPaths = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seenPaths.push(`${req.method} ${req.url} ${body}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/oauth/device/code") {
        res.end(
          JSON.stringify({
            device_code: "device-bin",
            user_code: "USER-BIN",
            verification_uri: "http://auth.example.test/device",
            expires_in: 30,
            interval: 0,
          }),
        );
        return;
      }
      if (req.url === "/oauth/token") {
        res.end(
          JSON.stringify({
            access_token: "at-device-bin",
            refresh_token: "rt-device-bin",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  try {
    await listen(server);
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await runNodeAsync(
      [binEntrypoint, "auth", "login", "--device"],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "",
          OPENAI_AUTH_TOKEN: "",
          OPENAI_OAUTH_CLIENT_ID: "client-device-bin",
          OPENAI_OAUTH_BASE_URL: baseUrl,
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Please visit http:\/\/auth\.example\.test\/device/,
    );
    assert.match(result.stdout, /USER-BIN/);
    assert.match(result.stdout, /Login successful\./);
    assert.ok(seenPaths.some((line) => line.includes("/oauth/device/code")));
    assert.ok(seenPaths.some((line) => line.includes("/oauth/token")));

    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(saved.authType, "oauth");
    assert.equal(saved.accessToken, "at-device-bin");
    assert.equal(saved.refreshToken, "rt-device-bin");
    assert.equal(saved.runtime, "api");
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper reports API-ready recovery for existing Codex auth on default Rust login path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-auth-login-codex-"),
  );
  const codexDir = path.join(tempDir, ".codex");
  const payload = Buffer.from(
    JSON.stringify({ aud: ["codex_client_saved"] }),
  ).toString("base64url");
  const accessToken = `x.${payload}.y`;

  try {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "rt-codex-saved",
        },
      }),
      "utf8",
    );

    const result = spawnSync("node", [binEntrypoint, "auth", "login"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_API_KEY: "",
        OPENAI_AUTH_TOKEN: "",
        OPENAI_OAUTH_CLIENT_ID: "",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not API-ready for OpenAI API tool calling/);
    assert.match(
      result.stderr,
      /OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser/,
    );
    assert.match(result.stderr, /unclecode auth login --api-key-stdin/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper requires explicit device flag for Codex-derived device OAuth", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-auth-codex-plain-device-"),
  );
  const codexDir = path.join(tempDir, ".codex");
  const idPayload = Buffer.from(
    JSON.stringify({ aud: ["app_client_plain_device_bin"] }),
  ).toString("base64url");
  const idToken = `x.${idPayload}.y`;

  try {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { id_token: idToken },
      }),
      "utf8",
    );

    const result = spawnSync("node", [binEntrypoint, "auth", "login"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_API_KEY: "",
        OPENAI_AUTH_TOKEN: "",
        OPENAI_OAUTH_CLIENT_ID: "",
        OPENAI_OAUTH_BASE_URL: "http://127.0.0.1:9",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /auth login --device/i);
    assert.match(result.stderr, /may not be API-ready for model calls/i);
    assert.doesNotMatch(
      result.stderr,
      /ECONNREFUSED|fetch failed|HTTP POST failed/i,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper completes Codex-derived device OAuth on the Rust path", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-auth-codex-device-"),
  );
  const credentialsPath = path.join(tempDir, "openai.json");
  const codexDir = path.join(tempDir, ".codex");
  const idPayload = Buffer.from(
    JSON.stringify({ aud: ["app_client_device_bin"] }),
  ).toString("base64url");
  const idToken = `x.${idPayload}.y`;
  const seenPaths = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seenPaths.push(`${req.method} ${req.url} ${body}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/accounts/deviceauth/usercode") {
        assert.equal(JSON.parse(body).client_id, "app_client_device_bin");
        res.end(
          JSON.stringify({
            device_auth_id: "device-auth-bin",
            user_code: "USER-CODEX-BIN",
            interval: 0,
          }),
        );
        return;
      }
      if (req.url === "/api/accounts/deviceauth/token") {
        const parsed = JSON.parse(body);
        assert.equal(parsed.device_auth_id, "device-auth-bin");
        assert.equal(parsed.user_code, "USER-CODEX-BIN");
        res.end(
          JSON.stringify({
            authorization_code: "code-codex-bin",
            code_verifier: "verifier-codex-bin",
          }),
        );
        return;
      }
      if (req.url === "/oauth/token") {
        const parsed = new URLSearchParams(body);
        assert.equal(parsed.get("client_id"), "app_client_device_bin");
        assert.equal(parsed.get("code"), "code-codex-bin");
        assert.equal(parsed.get("code_verifier"), "verifier-codex-bin");
        assert.equal(
          parsed.get("redirect_uri"),
          `http://127.0.0.1:${server.address().port}/deviceauth/callback`,
        );
        res.end(
          JSON.stringify({
            access_token: "at-codex-device-bin",
            refresh_token: "rt-codex-device-bin",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

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
    await listen(server);
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await runNodeAsync(
      [binEntrypoint, "auth", "login", "--device"],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENAI_API_KEY: "",
          OPENAI_AUTH_TOKEN: "",
          OPENAI_OAUTH_CLIENT_ID: "",
          OPENAI_OAUTH_BASE_URL: baseUrl,
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /USER-CODEX-BIN/);
    assert.ok(
      seenPaths.some((line) =>
        line.includes("/api/accounts/deviceauth/usercode"),
      ),
    );
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(saved.accessToken, "at-codex-device-bin");
    assert.equal(saved.refreshToken, "rt-codex-device-bin");
    assert.equal(saved.runtime, "codex");
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper completes browser OAuth callback on the Rust path", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-auth-browser-ok-"),
  );
  const credentialsPath = path.join(tempDir, "openai.json");
  const callbackPort = await reservePort();
  const seenBodies = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seenBodies.push(body);
      res.setHeader("content-type", "application/json");
      if (req.url === "/oauth/token") {
        res.end(
          JSON.stringify({
            access_token: "at-browser-bin",
            refresh_token: "rt-browser-bin",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  try {
    await listen(server);
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;

    const result = await new Promise((resolve) => {
      const child = spawn(
        "node",
        [binEntrypoint, "auth", "login", "--browser"],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            HOME: tempDir,
            OPENAI_API_KEY: "",
            OPENAI_AUTH_TOKEN: "",
            OPENAI_OAUTH_CLIENT_ID: "client-browser-bin",
            OPENAI_OAUTH_BASE_URL: baseUrl,
            OPENAI_OAUTH_REDIRECT_URI: redirectUri,
            UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let callbackSent = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const authorizeMatch = stdout.match(
          /^http:\/\/[^\n]+\/oauth\/authorize\?[^\n]+/m,
        );
        if (
          !callbackSent &&
          authorizeMatch &&
          stdout.includes("Waiting for OAuth callback")
        ) {
          callbackSent = true;
          const state = new URL(authorizeMatch[0]).searchParams.get("state");
          void fetchWithRetry(
            `${redirectUri}?code=code-browser-bin&state=${encodeURIComponent(state)}`,
          ).catch((error) => {
            stderr += String(error);
          });
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => {
        resolve({ status, stdout, stderr });
      });
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Waiting for OAuth callback/);
    assert.match(result.stdout, /Login successful\./);
    assert.ok(seenBodies.some((body) => body.includes("code-browser-bin")));

    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(saved.authType, "oauth");
    assert.equal(saved.accessToken, "at-browser-bin");
    assert.equal(saved.refreshToken, "rt-browser-bin");
    assert.equal(saved.runtime, "api");
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles harness status on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-harness-"));

  try {
    mkdirSync(path.join(tempDir, ".codex"), { recursive: true });
    writeFileSync(
      path.join(tempDir, ".codex", "config.toml"),
      [
        'model = "gpt-5.4"',
        'model_reasoning_effort = "high"',
        'approvals_reviewer = "user"',
        "",
        "[features]",
        "multi_agent = true",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync("node", [binEntrypoint, "harness", "status"], {
      cwd: tempDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Config: .*\.codex\/config\.toml/);
    assert.match(result.stdout, /Model: gpt-5\.4/);
    assert.match(result.stdout, /Reasoning: high/);
    assert.match(result.stdout, /Multi-agent: enabled/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles slash harness status on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-harness-slash-"),
  );

  try {
    const result = spawnSync("node", [binEntrypoint, "/harness status"], {
      cwd: tempDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No \.codex\/config\.toml found\./);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles harness apply on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-harness-apply-"),
  );

  try {
    mkdirSync(path.join(tempDir, ".codex"), { recursive: true });
    writeFileSync(
      path.join(tempDir, ".codex", "config.toml"),
      [
        'model = "gpt-5.4"',
        'model_reasoning_effort = "high"',
        'approvals_reviewer = "user"',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      "node",
      [binEntrypoint, "harness", "apply", "yolo"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /model_reasoning_effort -> "medium"/);
    assert.match(result.stdout, /approvals_reviewer -> "auto-edit"/);
    assert.match(result.stdout, /yolo preset applied/);
    assert.match(result.stdout, /Reasoning: medium/);
    assert.match(result.stdout, /Approvals: auto-edit/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles mode set and status on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-mode-"));

  try {
    const setResult = spawnSync(
      "node",
      [binEntrypoint, "mode", "set", "yolo"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "en_US.UTF-8",
          LC_MESSAGES: "ko_KR.UTF-8",
          LANGUAGE: "ko_KR:en_US",
          LANG: "ko_KR.UTF-8",
        },
      },
    );

    assert.equal(setResult.status, 0, setResult.stderr);
    assert.match(setResult.stdout, /Active mode saved: yolo/);
    assert.match(setResult.stdout, /Label: YOLO mode/);

    const savedConfig = JSON.parse(
      readFileSync(path.join(tempDir, ".unclecode", "config.json"), "utf8"),
    );
    assert.equal(savedConfig.mode, "yolo");

    const statusResult = spawnSync(
      "node",
      [binEntrypoint, "mode", "status"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "en_US.UTF-8",
          LC_MESSAGES: "ko_KR.UTF-8",
          LANGUAGE: "ko_KR:en_US",
          LANG: "ko_KR.UTF-8",
        },
      },
    );

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /Active mode: yolo/);
    assert.match(statusResult.stdout, /Label: YOLO mode/);
    assert.match(statusResult.stdout, /Source: project config/);
    assert.match(statusResult.stdout, /Background tasks: preferred/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper localizes mode labels for an explicit Korean locale", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-mode-korean-"),
  );

  try {
    const result = spawnSync(
      "node",
      [binEntrypoint, "mode", "set", "yolo"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "ko_KR.UTF-8",
          LC_MESSAGES: "en_US.UTF-8",
          LANGUAGE: "en_US",
          LANG: "en_US.UTF-8",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Active mode saved: yolo/);
    assert.match(result.stdout, /Label: YOLO 모드/);

    const statusResult = spawnSync(
      "node",
      [binEntrypoint, "mode", "status"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "ko_KR.UTF-8",
          LC_MESSAGES: "en_US.UTF-8",
          LANGUAGE: "en_US",
          LANG: "en_US.UTF-8",
        },
      },
    );

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /Active mode: yolo/);
    assert.match(statusResult.stdout, /Label: YOLO 모드/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles slash mode status on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-mode-slash-"));

  try {
    const result = spawnSync("node", [binEntrypoint, "/mode status"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_MODE: "plan",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Active mode: plan/);
    assert.match(result.stdout, /Source: environment/);
    assert.match(result.stdout, /Editing: forbidden/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles model catalog on the Rust path", () => {
  const result = spawnSync("node", [binEntrypoint, "model", "list", "openai"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_MODEL: "gpt-5.4",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Provider: OpenAI/);
  assert.match(result.stdout, /Default model: gpt-5\.6-sol/);
  assert.match(result.stdout, /Active model: gpt-5\.4/);
  assert.match(result.stdout, /gpt-5\.6-sol · reasoning medium/);
  assert.match(result.stdout, /gpt-5\.6-terra · reasoning medium/);
  assert.match(result.stdout, /gpt-5\.6-luna · reasoning medium/);
});

test("root bin wrapper handles slash model route on the Rust path without leaking proxy credentials", () => {
  const result = spawnSync(
    "node",
    [binEntrypoint, "/model route auto gpt-5.5"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HTTPS_PROXY: "http://user:secret@proxy.local:8080",
        NO_PROXY: "",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Provider: OpenAI \(openai\)/);
  assert.match(result.stdout, /Transport: native/);
  assert.match(
    result.stdout,
    /Endpoint: https:\/\/api\.openai\.com\/v1\/responses/,
  );
  assert.match(result.stdout, /Proxy: http:\/\/redacted@proxy\.local:8080\//);
  assert.doesNotMatch(result.stdout, /secret/);
});

test("root bin wrapper handles queue commands on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-queue-"));

  try {
    const helpResult = spawnSync("node", [binEntrypoint, "queue", "--help"], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(helpResult.status, 0, helpResult.stderr);
    assert.match(helpResult.stdout, /Rust-native queue commands/);

    const pushResult = spawnSync(
      "node",
      [binEntrypoint, "queue", "push", "session-1", "follow", "up"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(pushResult.status, 0, pushResult.stderr);
    assert.match(pushResult.stdout, /Queued #1: follow up/);

    const listResult = spawnSync(
      "node",
      [binEntrypoint, "queue", "list", "session-1"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(listResult.status, 0, listResult.stderr);
    assert.match(listResult.stdout, /#1 follow up/);

    const lenResult = spawnSync(
      "node",
      [binEntrypoint, "queue", "len", "session-1"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(lenResult.status, 0, lenResult.stderr);
    assert.match(lenResult.stdout, /^1\s*$/);

    const popResult = spawnSync(
      "node",
      [binEntrypoint, "queue", "pop", "session-1"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(popResult.status, 0, popResult.stderr);
    assert.match(popResult.stdout, /Dequeued #1: follow up/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles team list and status on the Rust path", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-team-"));
  let openaiServer;
  let anthropicServer;
  let geminiServer;
  let glmServer;

  try {
    const runRoot = path.join(tempDir, ".data", "team-runs", "tr_bin_1");
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(
      path.join(runRoot, "manifest.json"),
      JSON.stringify({
        runId: "tr_bin_1",
        objective: "inspect native team status",
        persona: "coder",
        lanes: 2,
        gate: "strict",
        runtime: "local",
        createdAt: 1,
        createdBy: "test",
        workspaceRoot: tempDir,
      }),
      "utf8",
    );
    writeFileSync(
      path.join(runRoot, "checkpoints.ndjson"),
      [
        JSON.stringify({
          type: "team_run",
          runId: "tr_bin_1",
          status: "started",
        }),
        JSON.stringify({
          type: "team_step",
          runId: "tr_bin_1",
          workerId: "w1",
          status: "completed",
        }),
        JSON.stringify({
          type: "team_run",
          runId: "tr_bin_1",
          status: "completed",
        }),
      ].join("\n"),
      "utf8",
    );

    const helpResult = spawnSync("node", [binEntrypoint, "team", "--help"], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(helpResult.status, 0, helpResult.stderr);
    assert.match(helpResult.stdout, /Rust-native team commands/);

    const listResult = spawnSync("node", [binEntrypoint, "team", "ls"], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(listResult.status, 0, listResult.stderr);
    assert.match(listResult.stdout, /tr_bin_1\s+coder\s+completed/);
    assert.match(listResult.stdout, /inspect native team status/);

    const statusResult = spawnSync("node", [binEntrypoint, "team", "status"], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /RUN_ID:\s+tr_bin_1/);
    assert.match(statusResult.stdout, /Status:\s+completed/);
    assert.match(statusResult.stdout, /Steps:\s+1/);

    const runResult = spawnSync(
      "node",
      [
        binEntrypoint,
        "team",
        "run",
        "--record",
        "tr_run_native",
        "--lanes",
        "codex,opencode",
        "--gate",
        "warn",
        "record",
        "native",
        "team",
        "run",
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /RUN_ID=tr_run_native/);
    assert.match(
      runResult.stdout,
      /persona=coder lanes=2 \[codex,opencode\] gate=warn runtime=local/,
    );

    const runInspectResult = spawnSync(
      "node",
      [binEntrypoint, "team", "inspect", "--verify", "tr_run_native"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(runInspectResult.status, 0, runInspectResult.stderr);
    assert.match(runInspectResult.stdout, /Status:\s+started/);
    assert.match(runInspectResult.stdout, /Chain: VERIFIED \(1 entries\)/);

    const dispatchResult = spawnSync(
      "node",
      [
        binEntrypoint,
        "team",
        "run",
        "--dispatch",
        "--record",
        "tr_dispatch_native",
        "--lanes",
        "codex,opencode",
        "--gate",
        "warn",
        "dispatch",
        "native",
        "team",
        "run",
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_TEAM_WORKER_LIVE: "0",
        },
      },
    );
    assert.equal(dispatchResult.status, 0, dispatchResult.stderr);
    assert.match(dispatchResult.stdout, /RUN_ID=tr_dispatch_native/);
    assert.match(dispatchResult.stdout, /Dispatching 2 worker/);
    assert.match(dispatchResult.stdout, /Final status: accepted/);
    assert.match(dispatchResult.stdout, /SUBMISSION:dispatch native team run/);

    const dispatchInspectResult = spawnSync(
      "node",
      [binEntrypoint, "team", "inspect", "--verify", "tr_dispatch_native"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(dispatchInspectResult.status, 0, dispatchInspectResult.stderr);
    assert.match(dispatchInspectResult.stdout, /Status:\s+accepted/);
    assert.match(dispatchInspectResult.stdout, /Chain: VERIFIED \(3 entries\)/);

    const fakeBin = path.join(tempDir, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const codexArgsPath = path.join(tempDir, "codex-args.txt");
    const cursorArgsPath = path.join(tempDir, "cursor-args.txt");
    writeFileSync(
      path.join(fakeBin, "codex"),
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CODEX_ARGS_PATH, process.argv.slice(2).join("\\n"));
process.stdout.write(JSON.stringify({ type: "agent_message", content: "native codex live ok" }) + "\\n");
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(fakeBin, "cursor-agent"),
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CURSOR_ARGS_PATH, process.argv.slice(2).join("\\n"));
process.stdout.write(JSON.stringify({ status: "finished", result: "native cursor live ok" }) + "\\n");
`,
      { mode: 0o755 },
    );
    const {
      UNCLECODE_TEAM_WORKER_LIVE: _liveWorkerOverride,
      ...baseLiveWorkerEnv
    } = process.env;
    const liveWorkerEnv = {
      ...baseLiveWorkerEnv,
      CODEX_ARGS_PATH: codexArgsPath,
      CURSOR_ARGS_PATH: cursorArgsPath,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const liveDispatchResult = spawnSync(
      "node",
      [
        binEntrypoint,
        "team",
        "run",
        "--dispatch",
        "--record",
        "tr_dispatch_codex_live",
        "--lanes",
        "codex:gpt-5.5",
        "dispatch",
        "native",
        "codex",
        "adapter",
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: liveWorkerEnv,
      },
    );
    assert.equal(liveDispatchResult.status, 0, liveDispatchResult.stderr);
    assert.match(liveDispatchResult.stdout, /Final status: accepted/);
    assert.match(liveDispatchResult.stdout, /SUBMISSION:native codex live ok/);
    assert.match(
      readFileSync(codexArgsPath, "utf8"),
      /exec\n--json\n--model\ngpt-5\.5/,
    );

    const liveDispatchInspectResult = spawnSync(
      "node",
      [binEntrypoint, "team", "inspect", "--verify", "tr_dispatch_codex_live"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(
      liveDispatchInspectResult.status,
      0,
      liveDispatchInspectResult.stderr,
    );
    assert.match(liveDispatchInspectResult.stdout, /Status:\s+accepted/);
    assert.match(liveDispatchInspectResult.stdout, /Steps:\s+1/);
    assert.match(
      liveDispatchInspectResult.stdout,
      /Chain: VERIFIED \(4 entries\)/,
    );

    const cursorDispatchResult = spawnSync(
      "node",
      [
        binEntrypoint,
        "team",
        "run",
        "--dispatch",
        "--record",
        "tr_dispatch_cursor_live",
        "--lanes",
        "cursor:composer-2.5",
        "dispatch",
        "native",
        "cursor",
        "adapter",
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...liveWorkerEnv,
          CURSOR_API_KEY: "cursor-test-key",
        },
      },
    );
    assert.equal(cursorDispatchResult.status, 0, cursorDispatchResult.stderr);
    assert.match(cursorDispatchResult.stdout, /Final status: accepted/);
    assert.match(
      cursorDispatchResult.stdout,
      /SUBMISSION:native cursor live ok/,
    );
    assert.match(
      readFileSync(cursorArgsPath, "utf8"),
      /--print\n--output-format\njson\n--model\ncomposer-2\.5\n--force/,
    );

    const cursorDispatchInspectResult = spawnSync(
      "node",
      [binEntrypoint, "team", "inspect", "--verify", "tr_dispatch_cursor_live"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(
      cursorDispatchInspectResult.status,
      0,
      cursorDispatchInspectResult.stderr,
    );
    assert.match(cursorDispatchInspectResult.stdout, /Status:\s+accepted/);
    assert.match(cursorDispatchInspectResult.stdout, /Steps:\s+1/);
    assert.match(
      cursorDispatchInspectResult.stdout,
      /Chain: VERIFIED \(4 entries\)/,
    );

    const openaiRequests = [];
    openaiServer = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        openaiRequests.push({
          url: req.url,
          authorization: req.headers.authorization,
          body,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (openaiRequests.length === 1) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "running shell",
                    tool_calls: [
                      {
                        id: "call_1",
                        function: {
                          name: "run_shell",
                          arguments: JSON.stringify({
                            command: "printf first",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "native openai mini-loop ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        }
      });
    });
    await new Promise((resolve) => {
      openaiServer.listen(0, "127.0.0.1", resolve);
    });
    const openaiAddress = openaiServer.address();
    assert.equal(typeof openaiAddress, "object");
    const openaiDispatchResult = await runNodeAsync(
      [
        binEntrypoint,
        "team",
        "run",
        "--dispatch",
        "--record",
        "tr_dispatch_openai_live",
        "--lanes",
        "openai:gpt-5.5",
        "dispatch",
        "native",
        "openai",
        "mini",
        "loop",
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          OPENAI_API_KEY: "sk-openai-test",
          OPENAI_BASE_URL: `http://127.0.0.1:${openaiAddress.port}/v1`,
        },
      },
    );
    assert.equal(openaiDispatchResult.status, 0, openaiDispatchResult.stderr);
    assert.match(openaiDispatchResult.stdout, /Final status: accepted/);
    assert.match(
      openaiDispatchResult.stdout,
      /SUBMISSION:native openai mini-loop ok/,
    );
    assert.equal(openaiRequests.length, 2);
    assert.equal(openaiRequests[0].url, "/v1/chat/completions");
    assert.equal(openaiRequests[0].authorization, "Bearer sk-openai-test");
    assert.equal(JSON.parse(openaiRequests[0].body).model, "gpt-5.5");
    assert.match(openaiRequests[1].body, /first/);

    const openaiDispatchInspectResult = spawnSync(
      "node",
      [binEntrypoint, "team", "inspect", "--verify", "tr_dispatch_openai_live"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(
      openaiDispatchInspectResult.status,
      0,
      openaiDispatchInspectResult.stderr,
    );
    assert.match(openaiDispatchInspectResult.stdout, /Status:\s+accepted/);
    assert.match(openaiDispatchInspectResult.stdout, /Steps:\s+2/);
    assert.match(
      openaiDispatchInspectResult.stdout,
      /Chain: VERIFIED \(5 entries\)/,
    );

    const anthropicRequests = [];
    anthropicServer = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        anthropicRequests.push({
          url: req.url,
          apiKey: req.headers["x-api-key"],
          body,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: "native anthropic mini-loop ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise((resolve) => {
      anthropicServer.listen(0, "127.0.0.1", resolve);
    });
    const anthropicAddress = anthropicServer.address();
    assert.equal(typeof anthropicAddress, "object");
    const anthropicDispatchResult = await runNodeAsync(
      [
        binEntrypoint,
        "team",
        "run",
        "--dispatch",
        "--record",
        "tr_dispatch_anthropic_live",
        "--lanes",
        "anthropic:claude-sonnet-4-6",
        "dispatch",
        "native",
        "anthropic",
        "mini",
        "loop",
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "sk-ant-test",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicAddress.port}/v1`,
        },
      },
    );
    assert.equal(
      anthropicDispatchResult.status,
      0,
      anthropicDispatchResult.stderr,
    );
    assert.match(anthropicDispatchResult.stdout, /Final status: accepted/);
    assert.match(
      anthropicDispatchResult.stdout,
      /SUBMISSION:native anthropic mini-loop ok/,
    );
    assert.equal(anthropicRequests.length, 1);
    assert.equal(anthropicRequests[0].url, "/v1/messages");
    assert.equal(anthropicRequests[0].apiKey, "sk-ant-test");
    assert.equal(
      JSON.parse(anthropicRequests[0].body).model,
      "claude-sonnet-4-6",
    );

    const geminiRequests = [];
    geminiServer = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        geminiRequests.push({
          url: req.url,
          apiKey: req.headers["x-goog-api-key"],
          body,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "native gemini mini-loop ok" }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
        );
      });
    });
    await new Promise((resolve) => {
      geminiServer.listen(0, "127.0.0.1", resolve);
    });
    const geminiAddress = geminiServer.address();
    assert.equal(typeof geminiAddress, "object");
    const geminiDispatchResult = await runNodeAsync(
      [
        binEntrypoint,
        "team",
        "run",
        "--dispatch",
        "--record",
        "tr_dispatch_gemini_live",
        "--lanes",
        "gemini:gemini-2.5-pro",
        "dispatch",
        "native",
        "gemini",
        "mini",
        "loop",
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          GEMINI_API_KEY: "gemini-test-key",
          GEMINI_BASE_URL: `http://127.0.0.1:${geminiAddress.port}/v1beta`,
        },
      },
    );
    assert.equal(geminiDispatchResult.status, 0, geminiDispatchResult.stderr);
    assert.match(geminiDispatchResult.stdout, /Final status: accepted/);
    assert.match(
      geminiDispatchResult.stdout,
      /SUBMISSION:native gemini mini-loop ok/,
    );
    assert.equal(geminiRequests.length, 1);
    assert.equal(
      geminiRequests[0].url,
      "/v1beta/models/gemini-2.5-pro:generateContent",
    );
    assert.equal(geminiRequests[0].apiKey, "gemini-test-key");
    const geminiBody = JSON.parse(geminiRequests[0].body);
    assert.equal(Object.hasOwn(geminiBody, "model"), false);
    assert.equal(
      geminiBody.contents[0].parts[0].text,
      "dispatch native gemini mini loop",
    );

    const glmRequests = [];
    glmServer = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        glmRequests.push({
          url: req.url,
          authorization: req.headers.authorization,
          body,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "native glm live ok" } }],
          }),
        );
      });
    });
    await new Promise((resolve) => {
      glmServer.listen(0, "127.0.0.1", resolve);
    });
    const glmAddress = glmServer.address();
    assert.equal(typeof glmAddress, "object");
    const glmBaseUrl = `http://127.0.0.1:${glmAddress.port}/v4`;
    const glmDispatchResult = await runNodeAsync(
      [
        binEntrypoint,
        "team",
        "run",
        "--dispatch",
        "--record",
        "tr_dispatch_glm_live",
        "--lanes",
        "glm:glm-5.1",
        "dispatch",
        "native",
        "glm",
        "adapter",
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          GLM_API_KEY: "glm-test-key",
          GLM_BASE_URL: glmBaseUrl,
        },
      },
    );
    assert.equal(glmDispatchResult.status, 0, glmDispatchResult.stderr);
    assert.match(glmDispatchResult.stdout, /Final status: accepted/);
    assert.match(glmDispatchResult.stdout, /SUBMISSION:native glm live ok/);
    assert.equal(glmRequests.length, 1);
    assert.equal(glmRequests[0].url, "/v4/chat/completions");
    assert.equal(glmRequests[0].authorization, "Bearer glm-test-key");
    assert.equal(JSON.parse(glmRequests[0].body).model, "glm-5.1");

    const glmDispatchInspectResult = spawnSync(
      "node",
      [binEntrypoint, "team", "inspect", "--verify", "tr_dispatch_glm_live"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(
      glmDispatchInspectResult.status,
      0,
      glmDispatchInspectResult.stderr,
    );
    assert.match(glmDispatchInspectResult.stdout, /Status:\s+accepted/);
    assert.match(glmDispatchInspectResult.stdout, /Steps:\s+1/);
    assert.match(
      glmDispatchInspectResult.stdout,
      /Chain: VERIFIED \(4 entries\)/,
    );

    const abortRunRoot = path.join(tempDir, ".data", "team-runs", "tr_abort_1");
    mkdirSync(abortRunRoot, { recursive: true });
    writeFileSync(
      path.join(abortRunRoot, "manifest.json"),
      JSON.stringify({
        runId: "tr_abort_1",
        objective: "abort native team run",
        persona: "coder",
        lanes: 1,
        gate: "strict",
        runtime: "local",
        createdAt: 1,
        createdBy: "test",
        workspaceRoot: tempDir,
      }),
      "utf8",
    );
    writeFileSync(path.join(abortRunRoot, "checkpoints.ndjson"), "", "utf8");

    const abortResult = spawnSync(
      "node",
      [binEntrypoint, "team", "abort", "tr_abort_1"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(abortResult.status, 0, abortResult.stderr);
    assert.match(abortResult.stdout, /Aborted tr_abort_1/);
    const abortLog = readFileSync(
      path.join(abortRunRoot, "checkpoints.ndjson"),
      "utf8",
    );
    assert.match(abortLog, /"status":"aborted"/);
    assert.match(abortLog, /"prevTipHash":"0{64}"/);
    assert.match(abortLog, /"lineHash":"[0-9a-f]{64}"/);

    const inspectResult = spawnSync(
      "node",
      [binEntrypoint, "team", "inspect", "--verify", "tr_abort_1"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    );
    assert.equal(inspectResult.status, 0, inspectResult.stderr);
    assert.match(inspectResult.stdout, /RUN_ID:\s+tr_abort_1/);
    assert.match(inspectResult.stdout, /Status:\s+aborted/);
    assert.match(inspectResult.stdout, /Chain: VERIFIED \(1 entries\)/);

    const doctorResult = spawnSync(
      process.execPath,
      [binEntrypoint, "team", "doctor"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENAI_API_KEY: "sk-test",
          ANTHROPIC_API_KEY: "",
          GEMINI_API_KEY: "",
          CURSOR_API_KEY: "",
          GLM_API_KEY: "",
          PATH: "",
        },
      },
    );
    assert.equal(doctorResult.status, 0, doctorResult.stderr);
    assert.match(doctorResult.stdout, /OK\s+openai/);
    assert.match(doctorResult.stdout, /MISS\s+anthropic/);
    assert.match(doctorResult.stdout, /Ready: 1\/8\s+Missing: 7/);
  } finally {
    for (const server of [
      openaiServer,
      anthropicServer,
      geminiServer,
      glmServer,
    ]) {
      if (server) {
        await new Promise((resolve) => {
          server.close(resolve);
        });
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles research run help on the Rust path", () => {
  const result = spawnSync(
    "node",
    [binEntrypoint, "research", "run", "--help"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Usage: unclecode research run <prompt\.\.\.> \[--json\]/,
  );
});

test("root bin wrapper handles sessions on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-sessions-"));
  const sessionStoreRoot = path.join(tempDir, ".state");

  try {
    const seedScript = `
      import { createSessionStore } from '@unclecode/session-store';
      const store = createSessionStore({ rootDir: ${JSON.stringify(sessionStoreRoot)} });
      const ref = { projectPath: ${JSON.stringify(tempDir)}, sessionId: 'session-rust-bin' };
      await store.appendCheckpoint(ref, { type: 'state', state: 'idle' });
      await store.appendCheckpoint(ref, { type: 'metadata', metadata: { model: 'gpt-5.4' } });
      await store.appendCheckpoint(ref, { type: 'task_summary', summary: 'Review current repo health', timestamp: '2026-04-02T00:00:00.000Z' });
      await store.appendCheckpoint(ref, { type: 'mode', mode: 'coordinator' });
      await store.appendCheckpoint(ref, { type: 'approval', pendingAction: { toolName: 'mcp.list', actionDescription: 'List MCP servers', toolUseId: 'tool-1', requestId: 'req-1' } });
    `;

    const seed = spawnSync(
      "node",
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        seedScript,
      ],
      { cwd: workspaceRoot, encoding: "utf8" },
    );
    assert.equal(seed.status, 0, seed.stderr);

    const result = spawnSync("node", [binEntrypoint, "sessions"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Sessions/);
    assert.match(result.stdout, /session-rust-bin/);
    assert.match(result.stdout, /state=idle/);
    assert.match(result.stdout, /model=gpt-5\.4/);
    assert.match(result.stdout, /mode=coordinator/);
    assert.match(result.stdout, /pending=mcp\.list/);
    assert.match(result.stdout, /summary=Review current repo health/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles slash sessions on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-sessions-empty-"),
  );

  try {
    const result = spawnSync("node", [binEntrypoint, "/sessions"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: path.join(tempDir, ".state"),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No resumable sessions found\./);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles resume on the Rust path", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-bin-resume-"));
  const sessionStoreRoot = path.join(tempDir, ".state");

  try {
    const seedScript = `
      import { createSessionStore } from '@unclecode/session-store';
      const store = createSessionStore({ rootDir: ${JSON.stringify(sessionStoreRoot)} });
      const ref = { projectPath: ${JSON.stringify(tempDir)}, sessionId: 'session-resume-rust-bin' };
      await store.appendCheckpoint(ref, { type: 'state', state: 'idle' });
      await store.appendCheckpoint(ref, { type: 'metadata', metadata: { model: 'gpt-5.4', traceMode: 'verbose' } });
      await store.appendCheckpoint(ref, { type: 'task_summary', summary: 'Review current repo health', timestamp: '2026-04-02T00:00:00.000Z' });
      await store.appendCheckpoint(ref, { type: 'mode', mode: 'coordinator' });
      await store.appendCheckpoint(ref, { type: 'approval', pendingAction: { toolName: 'mcp.list', actionDescription: 'List MCP servers', toolUseId: 'tool-1', requestId: 'req-1' } });
      await store.appendCheckpoint(ref, { type: 'worktree', worktree: { originalCwd: ${JSON.stringify(tempDir)}, worktreePath: ${JSON.stringify(tempDir)}, worktreeName: 'main-workspace', sessionId: 'session-resume-rust-bin', worktreeBranch: 'main' } });
    `;

    const seed = spawnSync(
      "node",
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        seedScript,
      ],
      { cwd: workspaceRoot, encoding: "utf8" },
    );
    assert.equal(seed.status, 0, seed.stderr);

    const result = spawnSync(
      "node",
      [binEntrypoint, "resume", "session-resume-rust-bin"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Resuming session: session-resume-rust-bin/);
    assert.match(result.stdout, /State: idle/);
    assert.match(result.stdout, /Model: gpt-5\.4/);
    assert.match(result.stdout, /Trace mode: verbose/);
    assert.match(result.stdout, /Mode: coordinator/);
    assert.match(result.stdout, /Pending action: List MCP servers/);
    assert.match(result.stdout, /Worktree branch: main/);
    assert.match(result.stdout, /Task summary: Review current repo health/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles resume json on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-resume-json-"),
  );
  const sessionStoreRoot = path.join(tempDir, ".state");

  try {
    const seedScript = `
      import { createSessionStore } from '@unclecode/session-store';
      const store = createSessionStore({ rootDir: ${JSON.stringify(sessionStoreRoot)} });
      const ref = { projectPath: ${JSON.stringify(tempDir)}, sessionId: 'session-resume-json-rust-bin' };
      await store.appendCheckpoint(ref, { type: 'state', state: 'idle' });
      await store.appendCheckpoint(ref, { type: 'metadata', metadata: { model: 'gpt-5.4' } });
    `;
    const seed = spawnSync(
      "node",
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        seedScript,
      ],
      { cwd: workspaceRoot, encoding: "utf8" },
    );
    assert.equal(seed.status, 0, seed.stderr);

    const result = spawnSync(
      "node",
      [binEntrypoint, "resume", "session-resume-json-rust-bin", "--json"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "resume");
    assert.equal(report.sessionId, "session-resume-json-rust-bin");
    assert.equal(report.status, "idle");
    assert.equal(report.model, "gpt-5.4");
    assert.ok(report.metrics.resumeMs <= report.thresholds.resumeMsBudget);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
