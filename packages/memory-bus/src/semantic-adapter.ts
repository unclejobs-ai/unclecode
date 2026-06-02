import type { Citation, MemoryQuery, Observation, Peer } from "@unclecode/contracts";

import type { MemoryQueryAdapter } from "./dialectic.js";
import { rustSha256 } from "./rust-command.js";

export type Mem0Hit = {
  readonly id: string;
  readonly memory: string;
  readonly score?: number;
  readonly userId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string | number;
  readonly updatedAt?: string | number;
};

export interface Mem0SearchClient {
  search(input: {
    readonly query: string;
    readonly about?: Peer;
    readonly limit?: number;
  }): Promise<ReadonlyArray<Mem0Hit>>;
}

export type Mem0AdapterOptions = {
  readonly limit?: number;
  readonly minScore?: number;
};

function parseTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createMem0Adapter(
  client: Mem0SearchClient,
  options: Mem0AdapterOptions = {},
): MemoryQueryAdapter {
  const limit = options.limit ?? 8;
  const minScore = options.minScore;
  return {
    category: "semantic",
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
        const versionHash = rustSha256(`${hit.id}\n${hit.memory}`);
        citations.push({
          category: "memory_observation",
          key: `mem0:${hit.id}`,
          versionHash,
          retrievedAt: Date.now(),
          snippet: hit.memory.slice(0, 240),
        });
        const recordedAt = parseTimestamp(hit.updatedAt) ?? parseTimestamp(hit.createdAt) ?? Date.now();
        observations.push({
          id: hit.id,
          peer: input.about ?? input.asker,
          category: "semantic",
          content: hit.memory,
          recordedAt,
        });
        if (topSnippet === undefined) topSnippet = hit.memory.slice(0, 240);
      }

      return {
        citations,
        rawObservations: observations,
        ...(topSnippet !== undefined ? { snippet: topSnippet } : {}),
      };
    },
  };
}
