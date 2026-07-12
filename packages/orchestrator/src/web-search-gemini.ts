import {
  composeWebSearchQuery,
  isWebSearchRecord,
  pushUniqueWebSearchSource,
  type WebSearchParsedResult,
  type WebSearchRecency,
  type WebSearchSource,
} from "./web-search-shared.js";

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
        parts: [{ text: composeWebSearchQuery(input.query, input.recency) }],
      }],
      tools: [{ google_search: {} }],
    },
  };
}

export function parseGeminiWebSearchResponse(payload: unknown): WebSearchParsedResult {
  const sources: WebSearchSource[] = [];
  if (!isWebSearchRecord(payload) || !Array.isArray(payload.candidates)) {
    return { text: "", sources };
  }

  const candidate = payload.candidates.find(isWebSearchRecord);
  if (!candidate) {
    return { text: "", sources };
  }

  const content = isWebSearchRecord(candidate.content) ? candidate.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .filter(isWebSearchRecord)
    .map((part) => typeof part.text === "string" ? part.text.trim() : "")
    .filter(Boolean)
    .join("\n\n");
  const grounding = isWebSearchRecord(candidate.groundingMetadata)
    ? candidate.groundingMetadata
    : undefined;
  const groundingChunks = grounding && Array.isArray(grounding.groundingChunks)
    ? grounding.groundingChunks
    : [];
  const seen = new Set<string>();
  for (const chunk of groundingChunks) {
    if (!isWebSearchRecord(chunk) || !isWebSearchRecord(chunk.web)) {
      continue;
    }
    pushUniqueWebSearchSource(sources, seen, chunk.web.uri ?? chunk.web.url, chunk.web.title);
  }
  const webSearchQueries = grounding && Array.isArray(grounding.webSearchQueries)
    ? [...new Set(
        grounding.webSearchQueries
          .filter((query): query is string => typeof query === "string")
          .map((query) => query.trim())
          .filter(Boolean),
      )]
    : [];
  const entryPoint = grounding && isWebSearchRecord(grounding.searchEntryPoint)
    ? grounding.searchEntryPoint
    : undefined;
  const searchEntryPoint = entryPoint
    && typeof entryPoint.renderedContent === "string"
    && entryPoint.renderedContent.trim()
    ? entryPoint.renderedContent.trim()
    : undefined;
  const groundingSupports = grounding && Array.isArray(grounding.groundingSupports)
    ? grounding.groundingSupports
    : [];
  const groundingMetadata = groundingChunks.length > 0
    || webSearchQueries.length > 0
    || searchEntryPoint !== undefined
    || groundingSupports.length > 0
    ? {
        ...(groundingChunks.length > 0 ? { groundingChunks } : {}),
        ...(webSearchQueries.length > 0 ? { webSearchQueries } : {}),
        ...(searchEntryPoint !== undefined ? { searchEntryPoint } : {}),
        ...(groundingSupports.length > 0 ? { groundingSupports } : {}),
      }
    : undefined;

  return {
    text,
    sources,
    ...(groundingMetadata ? { grounding: groundingMetadata } : {}),
  };
}
