import {
  composeWebSearchQuery,
  isWebSearchRecord,
  normalizeWebSearchLimit,
  pushUniqueWebSearchSource,
  type WebSearchParsedResult,
  type WebSearchRecency,
  type WebSearchSource,
} from "./web-search-shared.js";

export function buildAnthropicWebSearchRequest(input: {
  readonly model: string;
  readonly query: string;
  readonly recency?: WebSearchRecency;
  readonly limit?: number;
}): { readonly body: Record<string, unknown> } {
  const maxUses = normalizeWebSearchLimit(input.limit) ?? 5;
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
        content: composeWebSearchQuery(input.query, input.recency),
      }],
    },
  };
}

export function parseAnthropicWebSearchResponse(payload: unknown): WebSearchParsedResult {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];

  if (!isWebSearchRecord(payload) || !Array.isArray(payload.content)) {
    return { text: "", sources };
  }

  for (const block of payload.content) {
    if (!isWebSearchRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      textParts.push(block.text.trim());
    }
    if (block.type === "web_search_tool_result") {
      const content = Array.isArray(block.content) ? block.content : [];
      for (const result of content) {
        if (isWebSearchRecord(result) && result.type === "web_search_result") {
          pushUniqueWebSearchSource(sources, seen, result.url, result.title);
        }
      }
    }
    const citations = Array.isArray(block.citations) ? block.citations : [];
    for (const citation of citations) {
      if (isWebSearchRecord(citation)) {
        pushUniqueWebSearchSource(sources, seen, citation.url, citation.title);
      }
    }
  }

  return {
    text: textParts.join("\n\n"),
    sources,
  };
}
