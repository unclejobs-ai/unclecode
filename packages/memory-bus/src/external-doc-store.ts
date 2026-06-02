/**
 * External documentation SSOT — context7 wrapper.
 *
 * The actual MCP transport lives in apps/unclecode-cli; this module just
 * defines the Context7Client interface that callers implement, plus a
 * caching wrapper so repeated queries within a run don't refetch.
 *
 * Anti-hallucination role: every claim about external library API must
 * cite a context7 retrieval, and the retrieval hash is part of the SSOT
 * citation set (§5.6).
 */

import type { Citation } from "@unclecode/contracts";

import { rustSha256 } from "./rust-command.js";

export type Context7Doc = {
  readonly libraryId: string;
  readonly topic: string;
  readonly content: string;
};

export interface Context7Client {
  resolveLibraryId(library: string): Promise<string>;
  queryDocs(libraryId: string, topic: string): Promise<string>;
}

export type ContextDocResult = {
  readonly doc: Context7Doc;
  readonly citation: Citation;
};

export class CachingContext7Client implements Context7Client {
  private readonly upstream: Context7Client;
  private readonly libraryIds = new Map<string, string>();
  private readonly docs = new Map<string, string>();

  constructor(upstream: Context7Client) {
    this.upstream = upstream;
  }

  async resolveLibraryId(library: string): Promise<string> {
    const existing = this.libraryIds.get(library);
    if (existing) return existing;
    const resolved = await this.upstream.resolveLibraryId(library);
    this.libraryIds.set(library, resolved);
    return resolved;
  }

  async queryDocs(libraryId: string, topic: string): Promise<string> {
    const cacheKey = `${libraryId}::${topic}`;
    const existing = this.docs.get(cacheKey);
    if (existing) return existing;
    const fetched = await this.upstream.queryDocs(libraryId, topic);
    this.docs.set(cacheKey, fetched);
    return fetched;
  }
}

export async function consultDocs(
  client: Context7Client,
  input: { library: string; topic: string },
): Promise<ContextDocResult> {
  const libraryId = await client.resolveLibraryId(input.library);
  const content = await client.queryDocs(libraryId, input.topic);
  const versionHash = rustSha256(content);
  const citation: Citation = {
    category: "external_doc",
    key: `context7://${libraryId}#${input.topic}`,
    versionHash,
    retrievedAt: Date.now(),
    snippet: content.slice(0, 280),
  };
  return {
    doc: { libraryId, topic: input.topic, content },
    citation,
  };
}
