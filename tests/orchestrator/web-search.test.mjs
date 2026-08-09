import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRuntime,
  createWorkShellInteractionBridge,
} from "@unclecode/orchestrator";
import {
  buildAnthropicWebSearchRequest,
  buildGeminiWebSearchRequest,
  buildOpenAIWebSearchRequest,
  createWebSearchAdapter,
  createWebSearchHandler,
  parseAnthropicWebSearchResponse,
  parseGeminiWebSearchResponse,
  parseOpenAIWebSearchResponse,
  runWebSearch,
} from "../../packages/orchestrator/src/web-search.ts";

function runtime(webSearch) {
  return createToolRuntime({
    interactionBridge: createWorkShellInteractionBridge(),
    runtimeMode: "yolo",
    ...(webSearch ? { webSearch } : {}),
  });
}

test("web_search definition and handler are registered together via createToolRuntime", () => {
  const tools = runtime({
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-5.5",
    openAIRuntime: "api",
  });
  const definition = tools.definitions.find((tool) => tool.name === "web_search");
  assert.ok(definition, "web_search definition missing");
  assert.equal(typeof tools.executor.execute, "function");
  assert.equal(definition.input_schema.type, "object");
  assert.deepEqual(definition.input_schema.required, ["query"]);
  assert.equal(definition.input_schema.properties.query.type, "string");
  assert.equal(definition.input_schema.properties.recency.type, "string");
  assert.deepEqual(definition.input_schema.properties.recency.enum, [
    "day",
    "week",
    "month",
    "year",
  ]);
  assert.equal(definition.input_schema.properties.limit.type, "integer");
  assert.equal(definition.metadata?.annotations.openWorldHint, true);
  assert.equal(definition.metadata?.annotations.readOnlyHint, true);
  // Must remain distinct from local workspace ripgrep.
  assert.ok(tools.definitions.some((tool) => tool.name === "search_text"));
  assert.notEqual(definition.description.toLowerCase().includes("ripgrep"), true);
});

test("web_search without active provider credentials returns deterministic missing-auth error", async () => {
  const tools = runtime();
  const result = await tools.executor.execute({ toolName: "web_search", input: { query: "latest typescript release" }, cwd: "/repo" });
  assert.equal(result.isError, true);
  assert.match(result.content, /api key|auth|credential|unavailable/i);
  assert.doesNotMatch(result.content, /https?:\/\//i);
});

test("OpenAI Responses web_search request uses official tools shape and parses url citations/sources", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: {
            type: "search",
            query: "TypeScript 5.8",
            sources: [{ url: "https://devblogs.microsoft.com/typescript/" }],
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "TypeScript 5.8 is available.",
            annotations: [{
              type: "url_citation",
              url: "https://www.typescriptlang.org/docs/",
              title: "TypeScript Docs",
              start_index: 0,
              end_index: 10,
            }],
          }],
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const request = buildOpenAIWebSearchRequest({
    model: "gpt-5.5",
    query: "TypeScript 5.8",
    recency: "week",
    limit: 3,
  });
  assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
  assert.ok(Array.isArray(request.body.include));
  assert.ok(request.body.include.includes("web_search_call.action.sources"));
  assert.match(request.body.input, /TypeScript 5\.8/);

  const result = await runWebSearch({
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-5.5",
    openAIRuntime: "api",
    query: "TypeScript 5.8",
    recency: "week",
    limit: 3,
    fetchImpl,
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content);
  assert.ok(payload.sources.some((source) => source.url === "https://www.typescriptlang.org/docs/"));
  assert.ok(payload.sources.some((source) => source.url === "https://devblogs.microsoft.com/typescript/"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/responses$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
});

test("OpenAI Codex runtime refuses native web_search with actionable API-auth error", async () => {
  let called = false;
  const result = await runWebSearch({
    provider: "openai",
    apiKey: "oauth-token",
    model: "gpt-5.5",
    openAIRuntime: "codex",
    query: "anything",
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /api[_ -]?key|api-ready|OPENAI_API_KEY|codex/i);
});

test("Anthropic Messages web_search_20250305 request and URL-bearing result parsing", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      content: [
        { type: "text", text: "Searching." },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{
            type: "web_search_result",
            url: "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool",
            title: "Web search tool",
            page_age: "March 1, 2026",
          }],
        },
        {
          type: "text",
          text: "Anthropic documents the web_search tool.",
          citations: [{
            type: "web_search_result_location",
            url: "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool",
            title: "Web search tool",
          }],
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const request = buildAnthropicWebSearchRequest({
    model: "claude-sonnet-4-20250514",
    query: "anthropic web search tool",
    limit: 2,
  });
  assert.deepEqual(request.body.tools, [{
    name: "web_search",
    type: "web_search_20250305",
    max_uses: 2,
  }]);

  const result = await runWebSearch({
    provider: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-20250514",
    query: "anthropic web search tool",
    limit: 2,
    fetchImpl,
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content);
  assert.ok(payload.sources.some((source) =>
    source.url === "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool"
  ));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/messages$/);
  assert.equal(calls[0].init.headers["x-api-key"], "sk-ant-test");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tools[0].type, "web_search_20250305");
});

test("Anthropic web search resumes pause_turn responses with assistant content intact", async () => {
  const requestBodies = [];
  const pausedContent = [{
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_pause",
    content: [{
      type: "web_search_result",
      url: "https://example.com/paused-source",
      title: "Paused source",
    }],
  }];
  const fetchImpl = async (_url, init = {}) => {
    requestBodies.push(JSON.parse(init.body));
    const payload = requestBodies.length === 1
      ? {
          stop_reason: "pause_turn",
          content: pausedContent,
        }
      : {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Completed after continuation." }],
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await runWebSearch({
    provider: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-20250514",
    query: "continue server-side search",
    fetchImpl,
  });

  assert.equal(result.isError, false);
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[1].messages.at(-1), {
    role: "assistant",
    content: pausedContent,
  });
  assert.match(result.content, /https:\/\/example\.com\/paused-source/);
});

test("Gemini generateContent google_search request and groundingMetadata URL parsing", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "Spain won Euro 2024." }] },
        groundingMetadata: {
          groundingChunks: [{
            web: {
              uri: "https://www.uefa.com/euro2024/",
              title: "UEFA",
            },
          }],
          webSearchQueries: ["Euro 2024 winner"],
          searchEntryPoint: { renderedContent: "<div>Search UEFA</div>" },
          groundingSupports: [{
            segment: { startIndex: 0, endIndex: 20, text: "Spain won Euro 2024." },
            groundingChunkIndices: [0],
            confidenceScores: [0.98],
          }],
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const request = buildGeminiWebSearchRequest({
    model: "gemini-2.5-flash",
    query: "Euro 2024 winner",
  });
  assert.deepEqual(request.body.tools, [{ google_search: {} }]);

  const result = await runWebSearch({
    provider: "gemini",
    apiKey: "g-test",
    model: "gemini-2.5-flash",
    query: "Euro 2024 winner",
    fetchImpl,
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content);
  assert.ok(payload.sources.some((source) => source.url === "https://www.uefa.com/euro2024/"));
  assert.deepEqual(payload.grounding, {
    groundingChunks: [{
      web: {
        uri: "https://www.uefa.com/euro2024/",
        title: "UEFA",
      },
    }],
    webSearchQueries: ["Euro 2024 winner"],
    searchEntryPoint: "<div>Search UEFA</div>",
    groundingSupports: [{
      segment: { startIndex: 0, endIndex: 20, text: "Spain won Euro 2024." },
      groundingChunkIndices: [0],
      confidenceScores: [0.98],
    }],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-test");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
});

test("Gemini parser keeps one candidate citation graph internally consistent", () => {
  const result = parseGeminiWebSearchResponse({
    candidates: [
      {
        content: { parts: [{ text: "First grounded answer." }] },
        groundingMetadata: {
          groundingChunks: [{
            web: { uri: "https://example.com/first", title: "First" },
          }],
          groundingSupports: [{
            segment: { startIndex: 0, endIndex: 22, text: "First grounded answer." },
            groundingChunkIndices: [0],
          }],
        },
      },
      {
        content: { parts: [{ text: "Second candidate answer." }] },
        groundingMetadata: {
          groundingChunks: [{
            web: { uri: "https://example.com/second", title: "Second" },
          }],
          groundingSupports: [{
            segment: { startIndex: 0, endIndex: 24, text: "Second candidate answer." },
            groundingChunkIndices: [0],
          }],
        },
      },
    ],
  });

  assert.equal(result.text, "First grounded answer.");
  assert.deepEqual(result.sources, [{
    url: "https://example.com/first",
    title: "First",
  }]);
  assert.deepEqual(result.grounding, {
    groundingChunks: [{
      web: { uri: "https://example.com/first", title: "First" },
    }],
    groundingSupports: [{
      segment: { startIndex: 0, endIndex: 22, text: "First grounded answer." },
      groundingChunkIndices: [0],
    }],
  });
});

test("source-less provider responses never claim success", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    output: [{
      type: "message",
      content: [{ type: "output_text", text: "No sources here.", annotations: [] }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  const result = await runWebSearch({
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-5.5",
    openAIRuntime: "api",
    query: "obscure topic",
    fetchImpl,
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /source|url|citation/i);
  assert.equal(parseOpenAIWebSearchResponse({
    output: [{ type: "message", content: [{ type: "output_text", text: "x", annotations: [] }] }],
  }).sources.length, 0);
  assert.equal(parseAnthropicWebSearchResponse({
    content: [{ type: "text", text: "x" }],
  }).sources.length, 0);
  assert.equal(parseGeminiWebSearchResponse({
    candidates: [{ content: { parts: [{ text: "x" }] } }],
  }).sources.length, 0);
});

test("web_search aborts in-flight fetch when signal aborts", async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init = {}) => {
    assert.ok(init.signal, "abort signal must be forwarded");
    return await new Promise((resolve, reject) => {
      let timeout;
      const onAbort = () => {
        clearTimeout(timeout);
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        init.signal.removeEventListener("abort", onAbort);
        resolve(new Response(JSON.stringify({
          output: [{
            type: "web_search_call",
            action: { type: "search", sources: [{ url: "https://example.com" }] },
          }],
        }), { status: 200 }));
      }, 5000);
    });
  };

  const pending = runWebSearch({
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-5.5",
    openAIRuntime: "api",
    query: "slow query",
    fetchImpl,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("createWebSearchAdapter/handler uses the active provider only", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(String(url));
    return new Response(JSON.stringify({
      content: [{
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", url: "https://example.com/a", title: "A" }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = createWebSearchAdapter({
    provider: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-20250514",
    fetchImpl,
  });
  const handler = createWebSearchHandler({
    provider: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-20250514",
    fetchImpl,
  });
  const tools = runtime({
    provider: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-20250514",
    fetchImpl,
  });

  assert.equal(adapter.provider, "anthropic");
  const viaAdapter = await adapter.search({ query: "one provider" });
  const viaHandler = await handler({ query: "one provider" }, "/repo");
  const viaRuntime = await tools.executor.execute({ toolName: "web_search", input: { query: "one provider" }, cwd: "/repo" });
  assert.equal(viaAdapter.isError, false);
  assert.equal(viaHandler.isError, false);
  assert.equal(viaRuntime.isError, false);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((url) => /anthropic\.com|\/messages$/.test(url)));
  assert.ok(seen.every((url) => !/openai\.com|generativelanguage/.test(url)));
});
