import type { Citation, MemoryQuery, Observation, Peer } from "@unclecode/contracts";

import type { MemoryQueryAdapter } from "./dialectic.js";
import { rustSha256 } from "./rust-command.js";

export type ClaudeMemHit = {
  readonly id: string;
  readonly content: string;
  readonly recordedAt?: number;
  readonly score?: number;
  readonly tags?: ReadonlyArray<string>;
  readonly source?: string;
};

export interface ClaudeMemSearchClient {
  search(input: {
    readonly query: string;
    readonly about?: Peer;
    readonly limit?: number;
  }): Promise<ReadonlyArray<ClaudeMemHit>>;
}

export type ClaudeMemAdapterOptions = {
  readonly limit?: number;
  readonly minScore?: number;
};

export function createClaudeMemAdapter(
  client: ClaudeMemSearchClient,
  options: ClaudeMemAdapterOptions = {},
): MemoryQueryAdapter {
  const limit = options.limit ?? 8;
  const minScore = options.minScore;
  return {
    category: "episodic",
    async query(input: MemoryQuery) {
      const hits = await client.search({
        query: input.query,
        ...(input.about !== undefined ? { about: input.about } : {}),
        limit,
      });
      const citations: Citation[] = [];
      const observations: Observation[] = [];
      let topSnippet: string | undefined;

      for (const hit of hits) {
        if (minScore !== undefined && hit.score !== undefined && hit.score < minScore) continue;
        const versionHash = rustSha256(`${hit.id}\n${hit.content}`);
        citations.push({
          category: "memory_observation",
          key: `claude-mem:${hit.id}`,
          versionHash,
          retrievedAt: Date.now(),
          snippet: hit.content.slice(0, 240),
        });
        observations.push({
          id: hit.id,
          peer: input.about ?? input.asker,
          category: "episodic",
          content: hit.content,
          recordedAt: hit.recordedAt ?? Date.now(),
          ...(hit.tags !== undefined ? { tags: hit.tags } : {}),
        });
        if (topSnippet === undefined) topSnippet = hit.content.slice(0, 240);
      }

      return {
        citations,
        rawObservations: observations,
        ...(topSnippet !== undefined ? { snippet: topSnippet } : {}),
      };
    },
  };
}
