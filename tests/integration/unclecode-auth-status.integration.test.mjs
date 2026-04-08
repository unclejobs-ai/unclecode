import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function buildJwtWithExp(expSeconds) {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    "base64url",
  );
  return `${header}.${payload}.sig`;
}

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);

test("built unclecode cli reports auth status without leaking secrets", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-auth-status-env-"),
  );

  try {
    const result = spawnSync("node", [builtCliEntrypoint, "auth", "status"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_AUTH_TOKEN: "",
        OPENAI_API_KEY: "sk-test-123",
        OPENAI_ORG_ID: "org_123",
        OPENAI_PROJECT_ID: "proj_456",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /provider: openai-api/i);
    assert.match(result.stdout, /api-key-env/i);
    assert.match(result.stdout, /org_123/);
    assert.match(result.stdout, /proj_456/);
    assert.doesNotMatch(result.stdout, /sk-test-123/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli reports env OAuth token as oauth-env source", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "auth", "status"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_AUTH_TOKEN: "test-token",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source: oauth-env/);
  assert.match(result.stdout, /auth: oauth/);
});

test("built unclecode cli reports expired env OAuth token honestly", () => {
  const expiredToken = buildJwtWithExp(Math.floor(Date.now() / 1000) - 3600);
  const statusResult = spawnSync(
    "node",
    [builtCliEntrypoint, "auth", "status"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_AUTH_TOKEN: expiredToken,
      },
    },
  );

  assert.equal(statusResult.status, 0, statusResult.stderr);
  assert.match(statusResult.stdout, /source: oauth-env/);
  assert.match(statusResult.stdout, /expired: yes/);

  const doctorResult = spawnSync("node", [builtCliEntrypoint, "doctor"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_AUTH_TOKEN: expiredToken,
      UNCLECODE_SESSION_STORE_ROOT: path.join(
        tmpdir(),
        "unclecode-expired-env-state",
      ),
    },
  });

  assert.equal(doctorResult.status, 0, doctorResult.stderr);
  assert.match(doctorResult.stdout, /Auth\s+WARN\s+oauth-env \(oauth\)/);
});

test("built unclecode cli reports refresh-needed auth-file state honestly", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-auth-status-"));
  const credentialPath = path.join(tempDir, "openai.json");
  const pastExp = Math.floor(Date.now() / 1000) - 3600;
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: pastExp })).toString(
    "base64url",
  );
  const token = `${header}.${payload}.sig`;

  try {
    writeFileSync(
      credentialPath,
      JSON.stringify({ accessToken: token, refreshToken: "rt_123" }),
      "utf8",
    );

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
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialPath,
        },
      },
    );

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /source: oauth-file/);
    assert.match(statusResult.stdout, /expired: yes/);
    assert.match(statusResult.stdout, /expiresAt: refresh-required/);

    const doctorResult = spawnSync("node", [builtCliEntrypoint, "doctor"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_SESSION_STORE_ROOT: path.join(tempDir, ".state"),
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialPath,
      },
    });

    assert.equal(doctorResult.status, 0, doctorResult.stderr);
    assert.match(doctorResult.stdout, /Auth\s+WARN\s+oauth-file \(oauth\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli reports api-key-file status from stored credentials", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-auth-status-apikey-file-"),
  );
  const credentialPath = path.join(tempDir, "openai.json");

  try {
    writeFileSync(
      credentialPath,
      JSON.stringify({
        authType: "api-key",
        apiKey: "sk-file-123",
        organizationId: "org_file",
        projectId: "proj_file",
      }),
      "utf8",
    );

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
          UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialPath,
        },
      },
    );

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /source: api-key-file/);
    assert.match(statusResult.stdout, /auth: api-key/);
    assert.match(statusResult.stdout, /organization: org_file/);
    assert.match(statusResult.stdout, /project: proj_file/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("built unclecode cli can reuse Codex auth.json as OpenAI Codex oauth-file auth", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-auth-status-codex-"),
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

    const statusResult = spawnSync(
      "node",
      [builtCliEntrypoint, "auth", "status"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
        },
      },
    );

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /provider: openai-codex/);
    assert.match(statusResult.stdout, /source: oauth-file/);
    assert.match(statusResult.stdout, /auth: oauth/);
    assert.match(statusResult.stdout, /expired: no/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
