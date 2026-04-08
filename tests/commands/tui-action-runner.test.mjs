import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildTuiHomeState,
  createTuiActivityEntry,
  runTuiSessionCenterAction,
  runWorkShellInlineAction,
  persistProjectMode,
} from "../../apps/unclecode-cli/src/operational.ts";

function makeTempWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "unclecode-tui-action-"));
}

async function initializeGitRepo(cwd) {
  const { spawnSync } = await import("node:child_process");

  let result = spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync("git", ["config", "user.name", "Test User"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync(
    "node",
    ["--eval", "require('node:fs').writeFileSync('README.md', '# temp\\n')"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync("git", ["add", "README.md"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync("git", ["commit", "-m", "init"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("runWorkShellInlineAction maps work-shell slash commands to direct operational actions", async () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");
  const progress = [];

  try {
    const lines = await runWorkShellInlineAction({
      args: ["doctor"],
      workspaceRoot: cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test-123",
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
      onProgress: (line) => progress.push(line),
    });

    assert.match(lines.join("\n"), /Doctor report/);
    assert.deepEqual(progress, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction executes doctor inline", async () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "doctor",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test-123",
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.match(lines.join("\n"), /Doctor report/);
    assert.match(lines.join("\n"), /Runtime\s+PASS/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction executes mode status inline", async () => {
  const cwd = makeTempWorkspace();

  try {
    await persistProjectMode(cwd, "analyze");

    const lines = await runTuiSessionCenterAction({
      actionId: "mode-status",
      workspaceRoot: cwd,
      env: process.env,
    });

    assert.match(lines.join("\n"), /Active mode:\s+analyze/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction can cycle and persist the next mode inline", async () => {
  const cwd = makeTempWorkspace();

  try {
    await persistProjectMode(cwd, "default");

    const lines = await runTuiSessionCenterAction({
      actionId: "mode-cycle",
      workspaceRoot: cwd,
      env: process.env,
    });

    assert.match(lines.join("\n"), /Active mode saved: ultrawork/);

    const homeState = await buildTuiHomeState({
      workspaceRoot: cwd,
      env: process.env,
    });

    assert.equal(homeState.modeLabel, "ultrawork");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction executes auth status inline", async () => {
  const cwd = makeTempWorkspace();

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "auth-status",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        OPENAI_API_KEY: "sk-test-123",
      },
    });

    assert.match(lines.join("\n"), /provider: openai-api/);
    assert.match(lines.join("\n"), /source: api-key-env/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction can save api-key auth inline", async () => {
  const cwd = makeTempWorkspace();
  const credentialsPath = path.join(cwd, "openai.json");

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "api-key-login",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
      prompt: "sk-file-123",
    });

    assert.deepEqual(lines, ["API key login saved.", "Auth: api-key-file"]);

    const homeState = await buildTuiHomeState({
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(homeState.authLabel, "api-key-file");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction can clear stored auth inline", async () => {
  const cwd = makeTempWorkspace();
  const credentialsPath = path.join(cwd, "openai.json");
  writeFileSync(credentialsPath, JSON.stringify({ authType: "api-key", apiKey: "sk-file-123", organizationId: null, projectId: null }), "utf8");

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "auth-logout",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.deepEqual(lines, ["Signed out.", "Auth: none"]);

    const homeState = await buildTuiHomeState({
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(homeState.authLabel, "none");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction auth logout reports remaining env auth honestly", async () => {
  const cwd = makeTempWorkspace();
  const credentialsPath = path.join(cwd, "openai.json");
  writeFileSync(credentialsPath, JSON.stringify({ authType: "api-key", apiKey: "sk-file-123", organizationId: null, projectId: null }), "utf8");

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "auth-logout",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        OPENAI_API_KEY: "sk-env-456",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.deepEqual(lines, ["Local credentials cleared.", "Auth: api-key-env"]);

    const homeState = await buildTuiHomeState({
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        OPENAI_API_KEY: "sk-env-456",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(homeState.authLabel, "api-key-env");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction completes browser login inline and writes credentials", async () => {
  const cwd = makeTempWorkspace();
  const credentialsPath = path.join(cwd, "openai.json");
  const progress = [];

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "browser-login",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        OPENAI_OAUTH_CLIENT_ID: "client-123",
        OPENAI_OAUTH_REDIRECT_URI: "http://127.0.0.1:8787/callback",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
      fetch: async () => ({
        ok: true,
        async json() {
          return {
            access_token: "at_browser",
            refresh_token: "rt_browser",
          };
        },
      }),
      waitForBrowserCallback: async ({ url }) => `${url}&code=browser-code`,
      openExternalUrl: async () => undefined,
      onProgress: (line) => progress.push(line),
    });

    assert.deepEqual(progress, [
      "Opening browser…",
      "Waiting for callback…",
      "Saving auth…",
      "Auth ready.",
    ]);
    assert.deepEqual(lines, [
      "OAuth login complete.",
      "Provider: OpenAI API",
      "Auth: oauth-file",
      "Route: browser-oauth",
    ]);

    const homeState = await buildTuiHomeState({
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(homeState.authLabel, "oauth-file");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction falls back to device oauth when reusable codex client context exists", async () => {
  const cwd = makeTempWorkspace();
  const fakeHome = path.join(cwd, "home");

  try {
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    const idPayload = Buffer.from(JSON.stringify({ aud: ["client-derived-123"] })).toString("base64url");
    writeFileSync(
      path.join(fakeHome, ".codex", "auth.json"),
      JSON.stringify({ tokens: { id_token: `header.${idPayload}.sig` } }),
      "utf8",
    );

    const credentialsPath = path.join(cwd, "openai-codex.json");
    const lines = await runTuiSessionCenterAction({
      actionId: "browser-login",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: fakeHome,
        OPENAI_OAUTH_CLIENT_ID: "",
        UNCLECODE_OPENAI_CODEX_CREDENTIALS_PATH: credentialsPath,
      },
      openExternalUrl: async () => undefined,
      fetch: async (url, init) => {
        if (/\/api\/accounts\/deviceauth\/usercode$/.test(String(url))) {
          const parsed = JSON.parse(String(init?.body ?? "{}"));
          assert.equal(parsed.client_id, "client-derived-123");
          return {
            ok: true,
            async json() {
              return {
                device_auth_id: "device-auth-1",
                user_code: "ABCD-EFGH",
                interval: 0,
              };
            },
          };
        }

        if (/\/api\/accounts\/deviceauth\/token$/.test(String(url))) {
          const parsed = JSON.parse(String(init?.body ?? "{}"));
          assert.equal(parsed.device_auth_id, "device-auth-1");
          assert.equal(parsed.user_code, "ABCD-EFGH");
          return {
            ok: true,
            async json() {
              return {
                authorization_code: "oauth-code-1",
                code_verifier: "oauth-verifier-1",
              };
            },
          };
        }

        assert.match(String(url), /\/oauth\/token$/);
        const parsed = new URLSearchParams(String(init?.body ?? ""));
        assert.equal(parsed.get("client_id"), "client-derived-123");
        assert.equal(parsed.get("code"), "oauth-code-1");
        assert.equal(parsed.get("code_verifier"), "oauth-verifier-1");
        return {
          ok: true,
          async json() {
            return {
              access_token: "at_device",
              refresh_token: "rt_device",
            };
          },
        };
      },
    });

    assert.equal(lines[0], "OAuth login complete.");
    assert.equal(lines[1], "Provider: OpenAI Codex");
    assert.equal(lines[2], "Auth: oauth-file");
    assert.match(lines.join("\n"), /ABCD-EFGH/);
    assert.match(lines.join("\n"), /auth\.openai\.com\/codex\/device/);
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(saved.refreshToken, "rt_device");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction reports existing oauth auth when browser client id is absent", async () => {
  const cwd = makeTempWorkspace();
  const credentialsPath = path.join(cwd, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "oauth",
        accessToken: "header.payload.sig",
        refreshToken: "rt_existing",
      }),
      "utf8",
    );

    const lines = await runTuiSessionCenterAction({
      actionId: "browser-login",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_OAUTH_CLIENT_ID: "",
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.deepEqual(lines, [
      "Saved auth found.",
      "Provider: OpenAI API",
      "Auth: oauth-file",
      "Use `unclecode auth status` to inspect it. The next model request will verify provider access.",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction can derive browser client id from codex auth for device login", async () => {
  const cwd = makeTempWorkspace();
  const fakeHome = path.join(cwd, "home");

  try {
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    const idPayload = Buffer.from(JSON.stringify({ aud: ["client-derived-456"] })).toString("base64url");
    writeFileSync(
      path.join(fakeHome, ".codex", "auth.json"),
      JSON.stringify({ tokens: { id_token: `header.${idPayload}.sig` } }),
      "utf8",
    );

    const lines = await runTuiSessionCenterAction({
      actionId: "device-login",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: fakeHome,
        OPENAI_OAUTH_CLIENT_ID: "",
      },
      fetch: async (url, init) => {
        assert.match(String(url), /\/api\/accounts\/deviceauth\/usercode$/);
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        assert.equal(parsed.client_id, "client-derived-456");
        return {
          ok: true,
          async json() {
            return {
              device_auth_id: "device-auth-1",
              user_code: "ABCD-EFGH",
              interval: 5,
            };
          },
        };
      },
    });

    assert.match(lines.join("\n"), /ABCD-EFGH/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction reports missing credentials for device login inline", async () => {
  const cwd = makeTempWorkspace();

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "device-login",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_OAUTH_CLIENT_ID: "",
      },
    });

    assert.match(lines.join("\n"), /OPENAI_OAUTH_CLIENT_ID is required for device login/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction can start device authorization and show user code", async () => {
  const cwd = makeTempWorkspace();

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "device-login",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        OPENAI_OAUTH_CLIENT_ID: "client-123",
      },
      fetch: async () => ({
        ok: true,
        async json() {
          return {
            device_code: "device-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://auth.openai.com/activate",
            expires_in: 600,
            interval: 5,
          };
        },
      }),
    });

    assert.match(lines.join("\n"), /ABCD-EFGH/);
    assert.match(lines.join("\n"), /https:\/\/auth\.openai\.com\/activate/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction executes mcp list inline", async () => {
  const cwd = makeTempWorkspace();
  const fakeHome = path.join(cwd, "fake-home");

  try {
    mkdirSync(path.join(fakeHome, ".unclecode"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".unclecode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          memory: {
            type: "stdio",
            command: "node",
            args: ["memory.js"],
          },
        },
      }),
      "utf8",
    );

    const lines = await runTuiSessionCenterAction({
      actionId: "mcp-list",
      workspaceRoot: cwd,
      env: process.env,
      userHomeDir: fakeHome,
    });

    assert.match(lines.join("\n"), /MCP servers/);
    assert.match(lines.join("\n"), /memory \| stdio \| user \| user config/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction gives a short prompt hint for research without a prompt", async () => {
  const cwd = makeTempWorkspace();

  try {
    const lines = await runTuiSessionCenterAction({
      actionId: "new-research",
      workspaceRoot: cwd,
      env: process.env,
    });

    assert.deepEqual(lines, ["Type a research prompt and press Enter."]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTuiSessionCenterAction can execute research when a prompt is provided", async () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    await initializeGitRepo(cwd);

    const lines = await runTuiSessionCenterAction({
      actionId: "new-research",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
      prompt: "summarize current workspace",
    });

    assert.match(lines.join("\n"), /Research completed/);
    assert.match(lines.join("\n"), /Artifact:/);

    const homeState = await buildTuiHomeState({
      workspaceRoot: cwd,
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.ok(homeState.sessions.some((session) => session.sessionId.startsWith("research-")));
    assert.equal(homeState.sessionCount, 1);
    assert.ok(homeState.latestResearchSessionId?.startsWith("research-"));
    assert.equal(homeState.latestResearchSummary, homeState.sessions[0]?.taskSummary ?? null);
    assert.equal(homeState.researchRunCount, 1);
    assert.match(homeState.latestResearchTimestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runWorkShellInlineAction can execute research topics from slash arguments", async () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    await initializeGitRepo(cwd);

    const lines = await runWorkShellInlineAction({
      args: ["research", "run", "summarize", "current", "workspace"],
      workspaceRoot: cwd,
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.match(lines.join("\n"), /Research completed/);
    assert.match(lines.join("\n"), /Artifact:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildTuiHomeState reports MCP count and latest research summary", async () => {
  const cwd = makeTempWorkspace();
  const fakeHome = path.join(cwd, "fake-home");
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    await initializeGitRepo(cwd);

    mkdirSync(path.join(fakeHome, ".unclecode"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".unclecode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          memory: {
            type: "stdio",
            command: "node",
            args: ["memory.js"],
          },
        },
      }),
      "utf8",
    );

    const lines = await runTuiSessionCenterAction({
      actionId: "new-research",
      workspaceRoot: cwd,
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
      userHomeDir: fakeHome,
      prompt: "summarize current workspace",
    });
    assert.match(lines.join("\n"), /Research completed/);

    const homeState = await buildTuiHomeState({
      workspaceRoot: cwd,
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
      userHomeDir: fakeHome,
    });

    assert.equal(homeState.mcpServerCount, 1);
    assert.equal(homeState.mcpServers[0]?.name, "memory");
    assert.equal(homeState.mcpServers[0]?.transport, "stdio");
    assert.equal(homeState.mcpServers[0]?.trustTier, "user");
    assert.equal(homeState.mcpServers[0]?.originLabel, "user config");
    assert.match(homeState.latestResearchSummary ?? "", /Prepared a local research bundle/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("createTuiActivityEntry formats action output into transcript-ready shape", () => {
  const entry = createTuiActivityEntry({
    actionId: "doctor",
    lines: ["Doctor report", "Runtime PASS local available"],
    status: "completed",
  });

  assert.equal(entry.title, "Doctor");
  assert.equal(entry.tone, "success");
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(entry.lines, ["Doctor report", "Runtime PASS local available"]);
});
