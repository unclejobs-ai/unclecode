export type WebSearchProviderName = "anthropic" | "gemini" | "openai";
export type WebSearchRecency = "day" | "week" | "month" | "year";
export type OpenAIWebSearchRuntime = "api" | "codex";

export type WebSearchSource = {
  readonly url: string;
  readonly title?: string;
};

export type WebSearchGroundingMetadata = {
  readonly webSearchQueries?: readonly string[];
  readonly searchEntryPoint?: string;
  readonly groundingSupports?: readonly unknown[];
};

export type WebSearchParsedResult = {
  readonly text: string;
  readonly sources: readonly WebSearchSource[];
  readonly grounding?: WebSearchGroundingMetadata;
};

export type WebSearchToolResult = {
  readonly isError?: boolean;
  readonly content: string;
};

export type WebSearchFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type WebSearchActiveProvider = {
  readonly provider: WebSearchProviderName;
  readonly apiKey: string;
  readonly model: string;
  readonly openAIRuntime?: OpenAIWebSearchRuntime;
  readonly fetchImpl?: WebSearchFetch;
};

export type WebSearchInput = {
  readonly query: string;
  readonly recency?: WebSearchRecency;
  readonly limit?: number;
};

export type RunWebSearchArgs = WebSearchActiveProvider & WebSearchInput & {
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const RECENCY_HINT: Record<WebSearchRecency, string> = {
  day: "Prefer sources from the past day.",
  week: "Prefer sources from the past week.",
  month: "Prefer sources from the past month.",
  year: "Prefer sources from the past year.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    firstEnv(env, ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL"]) ?? DEFAULT_ANTHROPIC_BASE_URL,
  );
}

export function resolveGeminiWebSearchBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return trimBaseUrl(
    firstEnv(env, ["GEMINI_BASE_URL", "GEMINI_API_BASE_URL"]) ?? DEFAULT_GEMINI_BASE_URL,
  );
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return undefined;
  }
  const normalized = Math.floor(limit);
  return normalized >= 1 ? normalized : undefined;
}

function composeQuery(query: string, recency: WebSearchRecency | undefined): string {
  const trimmed = query.trim();
  if (!recency) {
    return trimmed;
  }
  return `${trimmed}\n\n${RECENCY_HINT[recency]}`;
}

function pushUniqueSource(
  sources: WebSearchSource[],
  seen: Set<string>,
  url: unknown,
  title?: unknown,
): void {
  if (typeof url !== "string") {
    return;
  }
  const normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized) || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  sources.push({
    url: normalized,
    ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
  });
}

function truncateSources(
  sources: readonly WebSearchSource[],
  limit: number | undefined,
): readonly WebSearchSource[] {
  const normalized = normalizeLimit(limit);
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

export function buildOpenAIWebSearchRequest(input: {
  readonly model: string;
  readonly query: string;
  readonly recency?: WebSearchRecency;
  readonly limit?: number;
}): { readonly body: Record<string, unknown> } {
  return {
    body: {
      model: input.model,
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      input: composeQuery(input.query, input.recency),
    },
  };
}

export function buildAnthropicWebSearchRequest(input: {
  readonly model: string;
  readonly query: string;
  readonly recency?: WebSearchRecency;
  readonly limit?: number;
}): { readonly body: Record<string, unknown> } {
  const maxUses = normalizeLimit(input.limit) ?? 5;
  return {
    body: {
      model: input.model,
      max_tokens: 4096,
      tools: [{
        name: "web_search",
        type: "web_search_20250305",
        max_uses: maxUses,
      }],
      messages: [{
        role: "user",
        content: composeQuery(input.query, input.recency),
      }],
    },
  };
}

export function buildGeminiWebSearchRequest(input: {
  readonly model: string;
  readonly query: string;
  readonly recency?: WebSearchRecency;
  readonly limit?: number;
}): { readonly body: Record<string, unknown> } {
  return {
    body: {
      contents: [{
        role: "user",
        parts: [{ text: composeQuery(input.query, input.recency) }],
      }],
      tools: [{ google_search: {} }],
    },
  };
}

export function parseOpenAIWebSearchResponse(payload: unknown): WebSearchParsedResult {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];

  if (!isRecord(payload)) {
    return { text: "", sources };
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "web_search_call" && isRecord(item.action)) {
      const actionSources = Array.isArray(item.action.sources) ? item.action.sources : [];
      for (const source of actionSources) {
        if (isRecord(source)) {
          pushUniqueSource(sources, seen, source.url, source.title);
        }
      }
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!isRecord(block)) {
          continue;
        }
        if (typeof block.text === "string" && block.text.trim()) {
          textParts.push(block.text.trim());
        }
        const annotations = Array.isArray(block.annotations) ? block.annotations : [];
        for (const annotation of annotations) {
          if (isRecord(annotation) && annotation.type === "url_citation") {
            pushUniqueSource(sources, seen, annotation.url, annotation.title);
          }
        }
      }
    }
  }

  return {
    text: textParts.join("\n\n"),
    sources,
  };
}

export function parseAnthropicWebSearchResponse(payload: unknown): WebSearchParsedResult {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];

  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    return { text: "", sources };
  }

  for (const block of payload.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      textParts.push(block.text.trim());
    }
    if (block.type === "web_search_tool_result") {
      const content = Array.isArray(block.content) ? block.content : [];
      for (const result of content) {
        if (isRecord(result) && result.type === "web_search_result") {
          pushUniqueSource(sources, seen, result.url, result.title);
        }
      }
    }
    const citations = Array.isArray(block.citations) ? block.citations : [];
    for (const citation of citations) {
      if (isRecord(citation)) {
        pushUniqueSource(sources, seen, citation.url, citation.title);
      }
    }
  }

  return {
    text: textParts.join("\n\n"),
    sources,
  };
}

export function parseGeminiWebSearchResponse(payload: unknown): WebSearchParsedResult {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];
  const webSearchQueries: string[] = [];
  const groundingSupports: unknown[] = [];
  let searchEntryPoint: string | undefined;

  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    return { text: "", sources };
  }

  for (const candidate of payload.candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const content = isRecord(candidate.content) ? candidate.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (isRecord(part) && typeof part.text === "string" && part.text.trim()) {
        textParts.push(part.text.trim());
      }
    }
    const grounding = isRecord(candidate.groundingMetadata) ? candidate.groundingMetadata : undefined;
    const chunks = grounding && Array.isArray(grounding.groundingChunks)
      ? grounding.groundingChunks
      : [];
    for (const chunk of chunks) {
      if (!isRecord(chunk) || !isRecord(chunk.web)) {
        continue;
      }
      pushUniqueSource(sources, seen, chunk.web.uri ?? chunk.web.url, chunk.web.title);
    }
    const queries = grounding && Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries
      : [];
    for (const query of queries) {
      if (typeof query === "string" && query.trim() && !webSearchQueries.includes(query.trim())) {
        webSearchQueries.push(query.trim());
      }
    }
    const entryPoint = grounding && isRecord(grounding.searchEntryPoint)
      ? grounding.searchEntryPoint
      : undefined;
    if (
      searchEntryPoint === undefined
      && entryPoint
      && typeof entryPoint.renderedContent === "string"
      && entryPoint.renderedContent.trim()
    ) {
      searchEntryPoint = entryPoint.renderedContent.trim();
    }
    if (grounding && Array.isArray(grounding.groundingSupports)) {
      groundingSupports.push(...grounding.groundingSupports);
    }
  }

  const grounding = webSearchQueries.length > 0
    || searchEntryPoint !== undefined
    || groundingSupports.length > 0
    ? {
        ...(webSearchQueries.length > 0 ? { webSearchQueries } : {}),
        ...(searchEntryPoint !== undefined ? { searchEntryPoint } : {}),
        ...(groundingSupports.length > 0 ? { groundingSupports } : {}),
      }
    : undefined;
  return {
    text: textParts.join("\n\n"),
    sources,
    ...(grounding ? { grounding } : {}),
  };
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
  const limit = normalizeLimit(args.limit);

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
        if (!isRecord(payload) || payload.stop_reason !== "pause_turn") {
          const completedPayload = isRecord(payload) && Array.isArray(payload.content)
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
