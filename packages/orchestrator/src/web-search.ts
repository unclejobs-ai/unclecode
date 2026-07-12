import {
  buildAnthropicWebSearchRequest,
  parseAnthropicWebSearchResponse,
} from "./web-search-anthropic.js";
import {
  buildGeminiWebSearchRequest,
  parseGeminiWebSearchResponse,
} from "./web-search-gemini.js";
import {
  buildOpenAIWebSearchRequest,
  parseOpenAIWebSearchResponse,
} from "./web-search-openai.js";
import {
  isWebSearchRecord,
  normalizeWebSearchLimit,
  type RunWebSearchArgs,
  type WebSearchActiveProvider,
  type WebSearchFetch,
  type WebSearchInput,
  type WebSearchParsedResult,
  type WebSearchProviderName,
  type WebSearchSource,
  type WebSearchToolResult,
} from "./web-search-shared.js";

export {
  buildAnthropicWebSearchRequest,
  buildGeminiWebSearchRequest,
  buildOpenAIWebSearchRequest,
  parseAnthropicWebSearchResponse,
  parseGeminiWebSearchResponse,
  parseOpenAIWebSearchResponse,
};
export type {
  OpenAIWebSearchRuntime,
  RunWebSearchArgs,
  WebSearchActiveProvider,
  WebSearchFetch,
  WebSearchGroundingMetadata,
  WebSearchInput,
  WebSearchParsedResult,
  WebSearchProviderName,
  WebSearchRecency,
  WebSearchSource,
  WebSearchToolResult,
} from "./web-search-shared.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveOpenAIWebSearchBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return trimBaseUrl(
    firstEnv(env, ["OPENAI_BASE_URL", "OPENAI_API_BASE_URL"]) ?? DEFAULT_OPENAI_BASE_URL,
  );
}

export function resolveAnthropicWebSearchBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return trimBaseUrl(
    firstEnv(env, ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL"])
      ?? DEFAULT_ANTHROPIC_BASE_URL,
  );
}

export function resolveGeminiWebSearchBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return trimBaseUrl(
    firstEnv(env, ["GEMINI_BASE_URL", "GEMINI_API_BASE_URL"]) ?? DEFAULT_GEMINI_BASE_URL,
  );
}

function truncateSources(
  sources: readonly WebSearchSource[],
  limit: number | undefined,
): readonly WebSearchSource[] {
  const normalized = normalizeWebSearchLimit(limit);
  if (!normalized) {
    return sources;
  }
  return sources.slice(0, normalized);
}

function errorResult(message: string): WebSearchToolResult {
  return { isError: true, content: message };
}

function successResult(parsed: WebSearchParsedResult, limit?: number): WebSearchToolResult {
  const sources = truncateSources(parsed.sources, limit);
  if (sources.length === 0) {
    return errorResult(
      "Web search returned no URL-bearing sources or citations. Refusing to claim success without a source URL.",
    );
  }
  return {
    isError: false,
    content: JSON.stringify({
      text: parsed.text,
      sources,
      ...(parsed.grounding ? { grounding: parsed.grounding } : {}),
    }),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function postJson(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly fetchImpl: WebSearchFetch;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const response = await input.fetchImpl(input.url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(input.body),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Web search HTTP ${response.status}: ${raw.slice(0, 400)}`);
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Web search returned non-JSON body: ${raw.slice(0, 200)}`);
  }
}

export async function runWebSearch(args: RunWebSearchArgs): Promise<WebSearchToolResult> {
  const query = args.query?.trim();
  if (!query) {
    return errorResult("web_search requires a non-empty query.");
  }
  const apiKey = args.apiKey?.trim();
  if (!apiKey) {
    return errorResult(
      "Web search credentials unavailable. Provide an API key for the active provider.",
    );
  }

  const env = args.env ?? process.env;
  const fetchImpl = args.fetchImpl ?? fetch;
  const limit = normalizeWebSearchLimit(args.limit);

  try {
    if (args.provider === "openai") {
      if (args.openAIRuntime === "codex") {
        return errorResult(
          "OpenAI native web_search requires API auth (openAIRuntime=api / OPENAI_API_KEY). Codex OAuth tokens must not be sent to api.openai.com.",
        );
      }
      const request = buildOpenAIWebSearchRequest({
        model: args.model,
        query,
        ...(args.recency ? { recency: args.recency } : {}),
        ...(limit ? { limit } : {}),
      });
      const payload = await postJson({
        url: `${resolveOpenAIWebSearchBaseUrl(env)}/responses`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: request.body,
        fetchImpl,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return successResult(parseOpenAIWebSearchResponse(payload), limit);
    }

    if (args.provider === "anthropic") {
      const request = buildAnthropicWebSearchRequest({
        model: args.model,
        query,
        ...(args.recency ? { recency: args.recency } : {}),
        ...(limit ? { limit } : {}),
      });
      const pausedContent: unknown[] = [];
      let body = request.body;
      for (let continuationCount = 0; continuationCount <= 3; continuationCount += 1) {
        const payload = await postJson({
          url: `${resolveAnthropicWebSearchBaseUrl(env)}/messages`,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body,
          fetchImpl,
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (!isWebSearchRecord(payload) || payload.stop_reason !== "pause_turn") {
          const completedPayload = isWebSearchRecord(payload) && Array.isArray(payload.content)
            ? { ...payload, content: [...pausedContent, ...payload.content] }
            : payload;
          return successResult(parseAnthropicWebSearchResponse(completedPayload), limit);
        }
        if (!Array.isArray(payload.content)) {
          return errorResult("Anthropic web search paused without resumable assistant content.");
        }
        if (continuationCount === 3) {
          return errorResult("Anthropic web search exceeded the continuation limit.");
        }
        pausedContent.push(...payload.content);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        body = {
          ...body,
          messages: [...messages, { role: "assistant", content: payload.content }],
        };
      }
      return errorResult("Anthropic web search exceeded the continuation limit.");
    }

    if (args.provider === "gemini") {
      const request = buildGeminiWebSearchRequest({
        model: args.model,
        query,
        ...(args.recency ? { recency: args.recency } : {}),
        ...(limit ? { limit } : {}),
      });
      const modelPath = encodeURIComponent(args.model.trim());
      const payload = await postJson({
        url: `${resolveGeminiWebSearchBaseUrl(env)}/models/${modelPath}:generateContent`,
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: request.body,
        fetchImpl,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return successResult(parseGeminiWebSearchResponse(payload), limit);
    }

    return errorResult(`Unsupported web search provider: ${String(args.provider)}`);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Web search failed: ${message}`);
  }
}

export function parseWebSearchToolInput(input: Record<string, unknown>): WebSearchInput {
  const query = typeof input.query === "string" ? input.query : "";
  const recency = input.recency;
  const limitValue = input.limit;
  const limit = typeof limitValue === "number"
    ? limitValue
    : typeof limitValue === "string" && limitValue.trim()
      ? Number(limitValue)
      : undefined;

  return {
    query,
    ...(recency === "day" || recency === "week" || recency === "month" || recency === "year"
      ? { recency }
      : {}),
    ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {}),
  };
}

export type WebSearchAdapter = {
  readonly provider: WebSearchProviderName;
  search(
    input: WebSearchInput & { readonly signal?: AbortSignal },
  ): Promise<WebSearchToolResult>;
};

export function createWebSearchAdapter(config: WebSearchActiveProvider): WebSearchAdapter {
  return {
    provider: config.provider,
    async search(input) {
      return await runWebSearch({
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        ...(config.openAIRuntime ? { openAIRuntime: config.openAIRuntime } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        query: input.query,
        ...(input.recency ? { recency: input.recency } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
  };
}

export function createWebSearchHandler(
  config?: WebSearchActiveProvider,
): (
  input: Record<string, unknown>,
  cwd: string,
  options?: { readonly signal?: AbortSignal | undefined },
) => Promise<WebSearchToolResult> {
  return async (input, _cwd, options = {}) => {
    if (!config || !config.apiKey.trim()) {
      return errorResult(
        "Web search credentials unavailable. Provide an API key for the active provider.",
      );
    }
    const adapter = createWebSearchAdapter(config);
    const parsed = parseWebSearchToolInput(input);
    return await adapter.search({
      query: parsed.query,
      ...(parsed.recency ? { recency: parsed.recency } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };
}
