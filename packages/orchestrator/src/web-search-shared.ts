export type WebSearchProviderName = "anthropic" | "gemini" | "openai";
export type WebSearchRecency = "day" | "week" | "month" | "year";
export type OpenAIWebSearchRuntime = "api" | "codex";

export type WebSearchSource = {
  readonly url: string;
  readonly title?: string;
};

export type WebSearchGroundingMetadata = {
  readonly webSearchQueries?: readonly string[];
  readonly groundingChunks?: readonly unknown[];
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

const RECENCY_HINT: Record<WebSearchRecency, string> = {
  day: "Prefer sources from the past day.",
  week: "Prefer sources from the past week.",
  month: "Prefer sources from the past month.",
  year: "Prefer sources from the past year.",
};

export function isWebSearchRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWebSearchLimit(limit: number | undefined): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return undefined;
  }
  const normalized = Math.floor(limit);
  return normalized >= 1 ? normalized : undefined;
}

export function composeWebSearchQuery(
  query: string,
  recency: WebSearchRecency | undefined,
): string {
  const trimmed = query.trim();
  if (!recency) {
    return trimmed;
  }
  return `${trimmed}\n\n${RECENCY_HINT[recency]}`;
}

export function pushUniqueWebSearchSource(
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
