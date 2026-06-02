import { randomUUID } from "node:crypto";

import { assertFreshContext, checkFreshness, getWorktreeFingerprint } from "./freshness.js";
import { defaultRepoMapCache } from "./repo-map-cache.js";
import { generateRepoMap, getRepoMapCacheToken } from "./repo-map.js";
import { runRustCommandSync } from "./rust-command.js";
import {
  type AssembleOptions,
  type ContextPacket,
  type PolicySignal,
  type RepoMapEntry,
  type TokenBudget,
} from "./types.js";

type ContextSelection = {
  readonly hotspots: readonly RepoMapEntry[];
  readonly changedFiles: readonly string[];
  readonly candidatePaths: readonly string[];
  readonly policySignals: readonly PolicySignal[];
  readonly includedContents: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly tokenEstimate: number;
  readonly tokenBudget: TokenBudget;
};

export function estimateTokens(text: string): number {
  return Number(runRustCommandSync(["rust", "context", "estimate-tokens"], process.cwd(), text).trim());
}

export function getTokenBudget(mode: AssembleOptions["mode"]): TokenBudget {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "token-budget", mode], process.cwd()),
  ) as unknown;

  if (!isTokenBudget(parsed)) {
    throw new Error("Rust token budget command returned an invalid payload.");
  }

  return parsed;
}

export async function assembleContextPacket(options: AssembleOptions): Promise<ContextPacket> {
  const generatedAt = new Date().toISOString();
  const repoMapCacheToken = await getRepoMapCacheToken(options.rootDir);
  const { repoMap } = await defaultRepoMapCache.load({
    rootDir: options.rootDir,
    gitHeadSha: repoMapCacheToken,
    loader: () => generateRepoMap(options.rootDir),
  });
  const selection = getContextSelection(options.rootDir, options.mode, options.sinceSha, repoMap);
  const worktreeState = await getWorktreeFingerprint(options.rootDir);

  const packetWithoutFreshness: ContextPacket = {
    id: randomUUID(),
    generatedAt,
    gitHeadSha: repoMap.gitHeadSha,
    worktreeFingerprint: worktreeState.fingerprint,
    repoMap,
    hotspots: selection.hotspots,
    changedFiles: selection.changedFiles,
    policySignals: selection.policySignals,
    includedContents: new Map(
      selection.includedContents.map((entry) => [entry.path, entry.content] as const),
    ),
    tokenEstimate: selection.tokenEstimate,
    tokenBudget: selection.tokenBudget,
    freshness: {
      status: "unknown",
      checkedAt: generatedAt,
      gitHeadSha: repoMap.gitHeadSha,
      packetSha: repoMap.gitHeadSha,
      modifiedPaths: [],
    },
    provenance: {
      mode: options.mode,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      trigger: options.trigger ?? "auto",
    },
  };

  const freshness = await checkFreshness(packetWithoutFreshness, options.rootDir);

  assertFreshContext(freshness);

  return {
    ...packetWithoutFreshness,
    freshness,
  };
}

function getContextSelection(
  rootDir: string,
  mode: AssembleOptions["mode"],
  sinceSha: string | undefined,
  repoMap: ContextPacket["repoMap"],
): ContextSelection {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "context", "selection", rootDir, mode, sinceSha ?? "-"],
      rootDir,
      JSON.stringify(repoMap),
    ),
  ) as unknown;

  if (!isContextSelection(parsed)) {
    throw new Error("Rust context selection command returned an invalid payload.");
  }

  return parsed;
}

function isContextSelection(value: unknown): value is ContextSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    hotspots?: unknown;
    changedFiles?: unknown;
    candidatePaths?: unknown;
    policySignals?: unknown;
    includedContents?: unknown;
    tokenEstimate?: unknown;
    tokenBudget?: unknown;
  };

  return (
    Array.isArray(candidate.hotspots) &&
    candidate.hotspots.every(isRepoMapEntry) &&
    Array.isArray(candidate.changedFiles) &&
    candidate.changedFiles.every((path) => typeof path === "string") &&
    Array.isArray(candidate.candidatePaths) &&
    candidate.candidatePaths.every((path) => typeof path === "string") &&
    Array.isArray(candidate.policySignals) &&
    candidate.policySignals.every(isPolicySignal) &&
    Array.isArray(candidate.includedContents) &&
    candidate.includedContents.every(isIncludedContent) &&
    typeof candidate.tokenEstimate === "number" &&
    isTokenBudget(candidate.tokenBudget)
  );
}

function isRepoMapEntry(value: unknown): value is RepoMapEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    path?: unknown;
    lastModified?: unknown;
    lineCount?: unknown;
    changeFrequency?: unknown;
    hotspotScore?: unknown;
  };

  return (
    typeof candidate.path === "string" &&
    typeof candidate.lastModified === "string" &&
    typeof candidate.lineCount === "number" &&
    typeof candidate.changeFrequency === "number" &&
    typeof candidate.hotspotScore === "number"
  );
}

function isIncludedContent(value: unknown): value is { readonly path: string; readonly content: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { path?: unknown; content?: unknown };

  return typeof candidate.path === "string" && typeof candidate.content === "string";
}

function isTokenBudget(value: unknown): value is TokenBudget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    maxTokens?: unknown;
    reservedForTools?: unknown;
    reservedForSystem?: unknown;
  };

  return (
    typeof candidate.maxTokens === "number" &&
    typeof candidate.reservedForTools === "number" &&
    typeof candidate.reservedForSystem === "number"
  );
}

function isPolicySignal(value: unknown): value is PolicySignal {
  return (
    value === "dependency-manifest-change" ||
    value === "provider-auth-surface" ||
    value === "runtime-surface" ||
    value === "mcp-surface" ||
    value === "policy-surface" ||
    value === "secret-surface"
  );
}
