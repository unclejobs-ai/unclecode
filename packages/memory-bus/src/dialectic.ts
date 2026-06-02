/**
 * Dialectic — Honcho-style query synthesizer. Composes a single answer + a
 * citation set from N memory stores. Today the wired stores are procedural
 * (filesystem) + external_doc (context7); episodic + semantic plug in via
 * MemoryQueryAdapter and arrive in Phase I.2.
 */

import type {
  Citation,
  MemoryQuery,
  MemoryResult,
  Observation,
} from "@unclecode/contracts";

import type { Context7Client } from "./external-doc-store.js";
import { consultDocs } from "./external-doc-store.js";
import { listSops } from "./procedural-store.js";
import { rustSha256 } from "./rust-command.js";

export interface MemoryQueryAdapter {
  readonly category: MemoryQuery["category"];
  query(input: MemoryQuery): Promise<{
    citations: ReadonlyArray<Citation>;
    rawObservations?: ReadonlyArray<Observation>;
    snippet?: string;
  }>;
}

export type DialecticOptions = {
  readonly workspaceRoot: string;
  readonly context7Client?: Context7Client;
  readonly adapters?: ReadonlyArray<MemoryQueryAdapter>;
};

export async function dialectic(
  query: MemoryQuery,
  options: DialecticOptions,
): Promise<MemoryResult> {
  const citations: Citation[] = [];
  const observations: Observation[] = [];
  const snippets: string[] = [];

  if (query.category === "procedural") {
    const target = query.about ?? query.asker;
    for (const sop of listSops({ workspaceRoot: options.workspaceRoot, peer: target })) {
      if (sop.content.toLowerCase().includes(query.query.toLowerCase())) {
        const versionHash = rustSha256(sop.content, options.workspaceRoot);
        citations.push({
          category: "memory_observation",
          key: sop.path,
          versionHash,
          retrievedAt: Date.now(),
          snippet: sop.content.slice(0, 240),
        });
        snippets.push(sop.content.slice(0, 240));
      }
    }
  }

  if (query.category === "external_doc" && options.context7Client) {
    const probe = await consultDocs(options.context7Client, {
      library: query.query,
      topic: query.query,
    });
    citations.push(probe.citation);
    snippets.push(probe.doc.content.slice(0, 240));
  }

  for (const adapter of options.adapters ?? []) {
    if (adapter.category !== query.category) continue;
    const result = await adapter.query(query);
    citations.push(...result.citations);
    if (result.snippet) snippets.push(result.snippet);
    if (result.rawObservations) observations.push(...result.rawObservations);
  }

  const synthesized = snippets.length > 0 ? snippets.join("\n\n---\n\n") : undefined;
  const retrievalHash = rustSha256(`${JSON.stringify(citations)}${synthesized ?? ""}`, options.workspaceRoot);

  return {
    citations,
    ...(synthesized !== undefined ? { synthesized } : {}),
    rawObservations: observations,
    retrievalHash,
  };
}
