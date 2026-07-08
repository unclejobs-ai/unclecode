import type { ContextPacketViewBadge } from "./context-packet-view.js";
import type { ContextSourceMetadata } from "./context-source-metadata.js";

/**
 * Context Runbook Protocol (CRP) — typed context source records.
 *
 * Providers upsert these into the `context_sources` SQLite table; the
 * per-turn selector queries and ranks them under a token budget. See
 * docs/design/crp-context-runbook-protocol.md.
 *
 * This is intentionally narrower than ContextPacketSourceCategory: the
 * stored categories are real provider sources. Synthetic categories
 * (`provider-system-prompt`, `user`) are added at select time when
 * projecting to ContextPacketView, not stored.
 */
export type ContextSourceCategory =
  | "workspace"
  | "workspace-guidance"
  | "bridge"
  | "loop-trail"
  | "condensed-history"
  | "memory"
  | "runtime"
  | "attachment"
  | "system";

export type ContextSourceRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly category: ContextSourceCategory;
  readonly label: string;
  readonly content: string | null;
  readonly reason: string;
  readonly sha256: string | null;
  readonly salience: number;
  readonly tokenEstimate: number;
  readonly includedInModel: boolean;
  readonly turnLastSeen: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly badges?: readonly ContextPacketViewBadge[] | undefined;
  readonly metadata?: ContextSourceMetadata | undefined;
};

export type UpsertContextSourceInput = {
  readonly id: string;
  readonly projectId: string;
  readonly category: ContextSourceCategory;
  readonly label: string;
  readonly content?: string | null;
  readonly reason: string;
  readonly sha256?: string | null;
  readonly salience?: number;
  readonly tokenEstimate?: number;
  readonly includedInModel?: boolean;
  readonly expiresAt?: string | null;
  readonly badges?: readonly ContextPacketViewBadge[] | undefined;
  readonly metadata?: ContextSourceMetadata | undefined;
};

export type SelectContextSourcesInput = {
  readonly projectId: string;
  readonly tokenBudget: number;
  readonly turnIndex: number;
  readonly categoryFilter?: readonly ContextSourceCategory[];
  readonly minSalience?: number;
};

export type ContextProviderManifest = {
  readonly providerId: string;
  readonly categories: readonly ContextSourceCategory[];
  readonly refresh: "on-turn" | "on-change" | "manual";
  readonly trustTier: "builtin" | "project" | "user";
};

export const CONTEXT_SOURCE_DEFAULT_SALIENCE = 0.5;
