import {
  composeWebSearchQuery,
  isWebSearchRecord,
  pushUniqueWebSearchSource,
  type WebSearchParsedResult,
  type WebSearchRecency,
  type WebSearchSource,
} from "./web-search-shared.js";

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
      input: composeWebSearchQuery(input.query, input.recency),
    },
  };
}

export function parseOpenAIWebSearchResponse(payload: unknown): WebSearchParsedResult {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];

  if (!isWebSearchRecord(payload)) {
    return { text: "", sources };
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isWebSearchRecord(item)) {
      continue;
    }
    if (item.type === "web_search_call" && isWebSearchRecord(item.action)) {
      const actionSources = Array.isArray(item.action.sources) ? item.action.sources : [];
      for (const source of actionSources) {
        if (isWebSearchRecord(source)) {
          pushUniqueWebSearchSource(sources, seen, source.url, source.title);
        }
      }
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!isWebSearchRecord(block)) {
          continue;
        }
        if (typeof block.text === "string" && block.text.trim()) {
          textParts.push(block.text.trim());
        }
        const annotations = Array.isArray(block.annotations) ? block.annotations : [];
        for (const annotation of annotations) {
          if (isWebSearchRecord(annotation) && annotation.type === "url_citation") {
            pushUniqueWebSearchSource(sources, seen, annotation.url, annotation.title);
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
