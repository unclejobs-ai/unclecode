import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { detectHotspots, summarizeDiff } from "./hotspot.js";
import { assertFreshContext, checkFreshness, getWorktreeFingerprint } from "./freshness.js";
import { defaultRepoMapCache } from "./repo-map-cache.js";
import { generateRepoMap, getRepoMapCacheToken } from "./repo-map.js";
import {
  ContextBrokerError,
  type AssembleOptions,
  type ContextPacket,
  type PolicySignal,
  type RepoMap,
  type TokenBudget,
} from "./types.js";

const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  maxTokens: 60_000,
  reservedForTools: 10_000,
  reservedForSystem: 5_000,
};

const ULTRAWORK_TOKEN_BUDGET: TokenBudget = {
  maxTokens: 80_000,
  reservedForTools: 8_000,
  reservedForSystem: 4_000,
};

const SEARCH_TOKEN_BUDGET: TokenBudget = {
  maxTokens: 100_000,
  reservedForTools: 5_000,
  reservedForSystem: 5_000,
};

const ANALYZE_TOKEN_BUDGET: TokenBudget = {
  maxTokens: 80_000,
  reservedForTools: 8_000,
  reservedForSystem: 5_000,
};

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getReadableContentTokenLimit(tokenBudget: TokenBudget): number {
  return Math.max(0, tokenBudget.maxTokens - tokenBudget.reservedForTools - tokenBudget.reservedForSystem);
}

function collectCandidatePaths(repoMap: RepoMap, changedFiles: readonly string[]): string[] {
  const repoPaths = new Set(repoMap.entries.map((entry) => entry.path));
  const hotspotPaths = detectHotspots(repoMap).map((entry) => entry.path);
  const candidates = new Set<string>();

  for (const filePath of [...changedFiles, ...hotspotPaths]) {
    if (repoPaths.has(filePath)) {
      candidates.add(filePath);
    }
  }

  return [...candidates];
}

function derivePolicySignals(filePaths: readonly string[]): readonly PolicySignal[] {
  const signals = new Set<PolicySignal>();

  for (const filePath of filePaths) {
    const normalizedPath = filePath.toLowerCase();

    if (normalizedPath.endsWith("package.json") || normalizedPath.endsWith("package-lock.json")) {
      signals.add("dependency-manifest-change");
    }

    if (
      normalizedPath.includes("auth") ||
      normalizedPath.includes("provider") ||
      normalizedPath.includes("oauth")
    ) {
      signals.add("provider-auth-surface");
    }

    if (
      normalizedPath.includes("runtime") ||
      normalizedPath.includes("sandbox") ||
      normalizedPath.includes("docker")
    ) {
      signals.add("runtime-surface");
    }

    if (normalizedPath.includes("mcp")) {
      signals.add("mcp-surface");
    }

    if (normalizedPath.includes("policy") || normalizedPath.includes("approval")) {
      signals.add("policy-surface");
    }

    if (
      normalizedPath.includes("secret") ||
      normalizedPath.includes("credential") ||
      normalizedPath.includes("token") ||
      normalizedPath.includes("key") ||
      normalizedPath.includes(".env")
    ) {
      signals.add("secret-surface");
    }
  }

  return [...signals];
}

async function readIncludedContents(
  rootDir: string,
  candidatePaths: readonly string[],
  tokenLimit: number,
): Promise<{ readonly includedContents: ReadonlyMap<string, string>; readonly tokenEstimate: number }> {
  const includedContents = new Map<string, string>();
  let tokenEstimate = 0;

  for (const filePath of candidatePaths) {
    let content: string;

    try {
      content = await readFile(path.join(rootDir, filePath), "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error) && error.code === "ENOENT") {
        continue;
      }

      throw new ContextBrokerError(`Failed to read context candidate: ${filePath}`, { cause: error });
    }

    const nextTokenEstimate = tokenEstimate + estimateTokens(content);

    if (nextTokenEstimate > tokenLimit) {
      continue;
    }

    includedContents.set(filePath, content);
    tokenEstimate = nextTokenEstimate;
  }

  return { includedContents, tokenEstimate };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function getTokenBudget(mode: AssembleOptions["mode"]): TokenBudget {
  switch (mode) {
    case "ultrawork":
      return ULTRAWORK_TOKEN_BUDGET;
    case "search":
      return SEARCH_TOKEN_BUDGET;
    case "analyze":
      return ANALYZE_TOKEN_BUDGET;
    case "default":
    default:
      return DEFAULT_TOKEN_BUDGET;
  }
}

export async function assembleContextPacket(options: AssembleOptions): Promise<ContextPacket> {
  const generatedAt = new Date().toISOString();
  const repoMapCacheToken = await getRepoMapCacheToken(options.rootDir);
  const { repoMap } = await defaultRepoMapCache.load({
    rootDir: options.rootDir,
    gitHeadSha: repoMapCacheToken,
    loader: () => generateRepoMap(options.rootDir),
  });
  const hotspots = detectHotspots(repoMap);
  const changedFiles = options.sinceSha
    ? await summarizeDiff(options.rootDir, options.sinceSha)
    : repoMap.entries.map((entry) => entry.path);
  const tokenBudget = getTokenBudget(options.mode);
  const candidatePaths = collectCandidatePaths(repoMap, changedFiles);
  const policySignals = derivePolicySignals([...changedFiles, ...candidatePaths]);
  const worktreeState = await getWorktreeFingerprint(options.rootDir);
  const { includedContents, tokenEstimate } = await readIncludedContents(
    options.rootDir,
    candidatePaths,
    getReadableContentTokenLimit(tokenBudget),
  );

  const packetWithoutFreshness: ContextPacket = {
    id: randomUUID(),
    generatedAt,
    gitHeadSha: repoMap.gitHeadSha,
    worktreeFingerprint: worktreeState.fingerprint,
    repoMap,
    hotspots,
    changedFiles,
    policySignals,
    includedContents,
    tokenEstimate,
    tokenBudget,
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
