import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, OpenAIProvider } from "@unclecode/orchestrator";

function buildJwtWithExp(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function createWorkspaceWithMode(mode) {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-config-"));
  mkdirSync(path.join(workspaceRoot, ".unclecode"), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, ".unclecode", "config.json"),
    `${JSON.stringify({ mode }, null, 2)}\n`,
    "utf8",
  );
  return workspaceRoot;
}

test("loadConfig supports openai provider selection", async () => {
  const originalEnv = { ...process.env };

  try {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-123";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    const config = await loadConfig();
    assert.equal(config.provider, "openai");
    assert.equal(config.apiKey, "sk-test-123");
    assert.equal(config.model, "gpt-4.1-mini");
    assert.equal(config.reasoning.effort, "unsupported");
  } finally {
    process.env = originalEnv;
  }
});


test("loadConfig uses gpt-5.5 and mode-default reasoning for openai work sessions", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = createWorkspaceWithMode("analyze");

  try {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-123";
    delete process.env.OPENAI_MODEL;

    const config = await loadConfig({ cwd: workspaceRoot });
    assert.equal(config.provider, "openai");
    assert.equal(config.model, "gpt-5.5");
    assert.equal(config.mode, "analyze");
    assert.equal(config.reasoning.effort, "high");
    assert.equal(config.reasoning.source, "mode-default");
    assert.equal(config.reasoning.support.status, "supported");
  } finally {
    process.env = originalEnv;
  }
});


test("loadConfig lets explicit reasoning overrides beat mode defaults", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = createWorkspaceWithMode("ultrawork");

  try {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-123";
    process.env.OPENAI_MODEL = "gpt-5.4";

    const config = await loadConfig({ cwd: workspaceRoot, reasoning: "low" });
    assert.equal(config.reasoning.effort, "low");
    assert.equal(config.reasoning.source, "override");
  } finally {
    process.env = originalEnv;
  }
});

test("loadConfig can reuse openai auth file when api key env is missing", async () => {
  const originalEnv = { ...process.env };

  try {
    process.env.LLM_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    const config = await loadConfig({
      readOpenAiAuthFile: async () =>
        JSON.stringify({
          accessToken: "oauth-access-token",
          refreshToken: "oauth-refresh-token",
        }),
    });

    assert.equal(config.provider, "openai");
    assert.equal(config.apiKey, "oauth-access-token");
  } finally {
    process.env = originalEnv;
  }
});

test("loadConfig ignores placeholder OPENAI_API_KEY values and reuses oauth auth", async () => {
  const originalEnv = { ...process.env };

  try {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "your_openai_api_key_here";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    const config = await loadConfig({
      readOpenAiAuthFile: async () =>
        JSON.stringify({
          accessToken: "oauth-access-token",
          refreshToken: "oauth-refresh-token",
        }),
    });

    assert.equal(config.provider, "openai");
    assert.equal(config.apiKey, "oauth-access-token");
    assert.equal(config.authLabel, "oauth-file");
  } finally {
    process.env = originalEnv;
  }
});

test("loadConfig can reuse codex auth file without model.request scope", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-config-codex-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access", "api.connectors.read"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;

  try {
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: token,
          account_id: "acct_123",
        },
      }),
      "utf8",
    );

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTH_TOKEN;
    delete process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH;

    const config = await loadConfig({ cwd: workspaceRoot });

    assert.equal(config.provider, "openai");
    assert.equal(config.authLabel, "oauth-file");
    assert.equal(config.openAIRuntime, "codex");
    assert.equal(config.openAIAccountId, "acct_123");
    assert.equal(config.apiKey, token);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadConfig points users to UncleCode auth flow when oauth file needs refresh", async () => {
  const originalEnv = { ...process.env };

  try {
    process.env.LLM_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    await assert.rejects(
      () =>
        loadConfig({
          readOpenAiAuthFile: async () =>
            JSON.stringify({
              accessToken: buildJwtWithExp(Math.floor(Date.now() / 1000) - 3600),
              refreshToken: "rt_123",
            }),
        }),
      /unclecode auth login --browser|OPENAI_AUTH_TOKEN/,
    );
  } finally {
    process.env = originalEnv;
  }
});

test("loadConfig can degrade into shell-safe openai config when oauth lacks required scope", async () => {
  const originalEnv = { ...process.env };
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-config-problematic-"));
  const credentialsPath = path.join(workspaceRoot, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "oauth",
        accessToken: token,
        refreshToken: "rt_123",
      }),
      "utf8",
    );

    process.env.LLM_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_MODEL = "gpt-5.4";
    process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH = credentialsPath;

    const config = await loadConfig({
      allowProblematicOpenAIAuth: true,
    });

    assert.equal(config.provider, "openai");
    assert.equal(config.apiKey, "");
    assert.equal(config.authLabel, "oauth-file");
    assert.match(config.authIssueMessage ?? "", /model\.request scope/i);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadConfig reuses stored codex runtime oauth without model.request scope", async () => {
  const originalEnv = { ...process.env };
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-config-stored-codex-"));
  const credentialsPath = path.join(workspaceRoot, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "oauth",
        accessToken: token,
        refreshToken: "rt_123",
        runtime: "codex",
      }),
      "utf8",
    );

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTH_TOKEN;

    const config = await loadConfig({ cwd: workspaceRoot });

    assert.equal(config.provider, "openai");
    assert.equal(config.authLabel, "oauth-file");
    assert.equal(config.openAIRuntime, "codex");
    assert.equal(config.apiKey, token);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("OpenAIProvider can return a plain text response without tools", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    reasoning: { effort: "unsupported", source: "model-capability", support: { status: "unsupported", supportedEfforts: [] } },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "hello from openai",
              },
            },
          ],
        };
      },
    }),
  });

  const result = await provider.runTurn("say hello");
  assert.equal(result.text, "hello from openai");
});


test("OpenAIProvider includes supported reasoning effort in request payloads", async () => {
  let capturedBody;
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: {
      effort: "high",
      source: "override",
      support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
    },
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: "reasoned" } }],
          };
        },
      };
    },
  });

  await provider.runTurn("think hard");
  assert.deepEqual(capturedBody.reasoning, { effort: "high" });
});

test("OpenAIProvider uses the Codex backend for codex oauth runtime", async () => {
  let capturedUrl;
  let capturedHeaders;
  let capturedBody;
  const provider = new OpenAIProvider({
    apiKey: "header.eyJzY3AiOlsib3BlbmlkIl19.sig",
    model: "gpt-5.4",
    cwd: process.cwd(),
    runtime: "codex",
    openAIAccountId: "acct_123",
    reasoning: {
      effort: "high",
      source: "override",
      support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
    },
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async text() {
          return [
            'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"OK"}',
            '',
            'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"OK"}]}}',
            '',
            'data: {"type":"response.completed","response":{"id":"resp_1"}}',
            '',
          ].join("\n");
        },
      };
    },
  });

  const result = await provider.runTurn("say ok");

  assert.equal(result.text, "OK");
  assert.equal(capturedUrl, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.stream, true);
  // Supported reasoning surfaces effort + summary so Codex streams the
  // reasoning trace; the "effort=none" hardcode was intentionally
  // removed in 87759e7 (fix: surface reasoning).
  assert.equal(capturedBody.reasoning.effort, "high");
  assert.equal(capturedBody.reasoning.summary, "auto");
  assert.deepEqual(capturedBody.include, ["reasoning.encrypted_content"]);
  assert.equal(capturedBody.instructions.includes("MyClaudeCode"), true);
  assert.equal(capturedHeaders["ChatGPT-Account-Id"], "acct_123");
});

test("OpenAIProvider keeps codex reasoning effort=none when reasoning support is unavailable", async () => {
  let capturedBody;
  const provider = new OpenAIProvider({
    apiKey: "header.eyJzY3AiOlsib3BlbmlkIl19.sig",
    model: "gpt-4.1-mini",
    cwd: process.cwd(),
    runtime: "codex",
    openAIAccountId: "acct_123",
    reasoning: {
      effort: "unsupported",
      source: "model-capability",
      support: { status: "unsupported", supportedEfforts: [] },
    },
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async text() {
          return [
            'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"OK"}]}}',
            '',
            'data: {"type":"response.completed","response":{"id":"resp_1"}}',
            '',
          ].join("\n");
        },
      };
    },
  });

  await provider.runTurn("hello");

  assert.equal(capturedBody.reasoning.effort, "none");
  assert.deepEqual(capturedBody.include, []);
});

test("OpenAIProvider sends pasted image attachments as multimodal user content", async () => {
  let capturedBody;
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: {
      effort: "medium",
      source: "mode-default",
      support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
    },
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: "saw image" } }],
          };
        },
      };
    },
  });

  const result = await provider.runTurn("inspect this", [
    {
      type: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      path: "/tmp/clipboard.png",
      displayName: "clipboard.png",
    },
  ]);

  assert.equal(result.text, "saw image");
  assert.equal(capturedBody.messages[1].role, "user");
  assert.equal(Array.isArray(capturedBody.messages[1].content), true);
  assert.deepEqual(capturedBody.messages[1].content[0], { type: "text", text: "inspect this" });
  assert.deepEqual(capturedBody.messages[1].content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAA" },
  });
});

test("OpenAIProvider emits tool trace events for visible tool use", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-openai-trace-"));
  writeFileSync(path.join(workspaceRoot, "hello.txt"), "hello trace\n", "utf8");

  const traces = [];
  let callCount = 0;
  const provider = new OpenAIProvider({
    apiKey: "sk-test-123",
    model: "gpt-5.4",
    cwd: workspaceRoot,
    reasoning: {
      effort: "medium",
      source: "mode-default",
      support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        callCount += 1;
        if (callCount === 1) {
          return {
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call-1",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({ path: "hello.txt" }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }

        return {
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        };
      },
    }),
  });

  provider.setTraceListener((event) => traces.push(event));
  const result = await provider.runTurn("read the file");

  assert.equal(result.text, "done");
  assert.equal(traces[0]?.type, "tool.started");
  assert.equal(traces[0]?.toolName, "read_file");
  assert.equal(typeof traces[0]?.startedAt, "number");
  assert.equal(traces[1]?.type, "tool.completed");
  assert.equal(traces[1]?.isError, false);
  assert.equal(typeof traces[1]?.durationMs, "number");
  assert.match(traces[1]?.output ?? "", /hello trace/);
});
