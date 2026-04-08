import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

test("loadConfig supports openai-api provider selection", async () => {
  const originalEnv = { ...process.env };

  try {
    process.env.LLM_PROVIDER = "openai-api";
    process.env.OPENAI_API_KEY = "sk-test-123";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    const config = await loadConfig();
    assert.equal(config.provider, "openai-api");
    assert.equal(config.apiKey, "sk-test-123");
    assert.equal(config.model, "gpt-4.1-mini");
    assert.equal(config.reasoning.effort, "unsupported");
  } finally {
    process.env = originalEnv;
  }
});


test("loadConfig normalizes legacy openai provider selection to openai-api", async () => {
  const originalEnv = { ...process.env };

  try {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-123";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    const config = await loadConfig();
    assert.equal(config.provider, "openai-api");
    assert.equal(config.apiKey, "sk-test-123");
  } finally {
    process.env = originalEnv;
  }
});


test("loadConfig auto-selects openai-codex when reusable Codex auth exists even if an API key is also present", async () => {
  const originalEnv = { ...process.env };
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-openai-codex-"));
  const futureExp = Math.floor(Date.now() / 1000) + 3600;

  try {
    mkdirSync(path.join(root, ".codex"), { recursive: true });
    writeFileSync(
      path.join(root, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: buildJwtWithExp(futureExp),
          refresh_token: "rt_123",
        },
      }),
      "utf8",
    );

    delete process.env.LLM_PROVIDER;
    process.env.OPENAI_API_KEY = "sk-test-123";
    process.env.OPENAI_MODEL = "gpt-5.4";
    process.env.HOME = root;

    const config = await loadConfig();
    assert.equal(config.provider, "openai-codex");
    assert.equal(config.apiKey, buildJwtWithExp(futureExp));
    assert.equal(config.authLabel, "oauth-file");
  } finally {
    process.env = originalEnv;
  }
});


test("loadConfig uses gpt-5.4 and mode-default reasoning for openai work sessions", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = createWorkspaceWithMode("analyze");

  try {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-123";
    delete process.env.OPENAI_MODEL;

    const config = await loadConfig({ cwd: workspaceRoot });
    assert.equal(config.provider, "openai-api");
    assert.equal(config.model, "gpt-5.4");
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

    assert.equal(config.provider, "openai-api");
    assert.equal(config.apiKey, "oauth-access-token");
  } finally {
    process.env = originalEnv;
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

  try {
    process.env.LLM_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_MODEL = "gpt-5.4";

    const config = await loadConfig({
      allowProblematicOpenAIAuth: true,
      readOpenAiAuthFile: async () =>
        JSON.stringify({
          authType: "oauth",
          accessToken: token,
          refreshToken: "rt_123",
        }),
    });

    assert.equal(config.provider, "openai-api");
    assert.equal(config.apiKey, "");
    assert.equal(config.authLabel, "oauth-file");
    assert.match(config.authIssueMessage ?? "", /model\.request scope/i);
  } finally {
    process.env = originalEnv;
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
