import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  ProviderId,
  QualityHarnessStage,
} from "@unclecode/contracts";
import type { GateFinding } from "@second-claude/core";

export type QualityProviderRoute = {
  readonly provider: ProviderId | "unknown";
  readonly model: string;
};

export type QualityRouteObservation = QualityProviderRoute & {
  readonly source: "provider.route" | "usage.recorded";
};

export type QualityReviewRouteEvidence = {
  readonly status: "matched" | "missing" | "mismatched";
  readonly source?: QualityRouteObservation["source"] | "declared" | undefined;
};

export type BalancedPrewalkRoute = QualityProviderRoute & {
  readonly stage: QualityHarnessStage;
  readonly route: "frontier" | "commodity" | "direct" | "fallback";
  readonly executor: "direct" | "commodity" | "reviewer";
  readonly independent: boolean;
};

function providersMatch(left: QualityProviderRoute, right: QualityProviderRoute): boolean {
  return left.provider === right.provider;
}

/** Extracts only provider/model evidence emitted by a real provider turn. */
export function readQualityRouteObservation(
  event: { readonly type: string },
): QualityRouteObservation | undefined {
  if (event.type !== "provider.route" && event.type !== "usage.recorded") return undefined;
  const record = event as unknown as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.model !== "string") return undefined;
  const provider = record.provider.trim();
  const model = record.model.trim();
  if (!provider || !model) return undefined;
  return {
    provider: provider as ProviderId | "unknown",
    model,
    source: event.type,
  };
}

/** Binds a configured review route to provider telemetry, with an explicit fixture escape hatch. */
export function resolveQualityReviewRouteEvidence(input: {
  readonly declaredRoute: QualityProviderRoute;
  readonly observations: readonly QualityRouteObservation[];
  readonly allowDeclaredEvidence?: boolean | undefined;
}): QualityReviewRouteEvidence {
  if (input.observations.length === 0) {
    return input.allowDeclaredEvidence
      ? { status: "matched", source: "declared" }
      : { status: "missing" };
  }
  const matches = input.observations.every((observation) =>
    observation.provider === input.declaredRoute.provider
    && observation.model === input.declaredRoute.model);
  return matches
    ? { status: "matched", source: input.observations[0]?.source }
    : { status: "mismatched" };
}

/** A deterministic routing plan; callers trace this only once the matching call begins. */
export function resolveBalancedPrewalkRoute(input: {
  readonly stage: QualityHarnessStage;
  readonly workerIndex?: number;
  readonly directRoute: QualityProviderRoute;
  readonly commodityRoute?: QualityProviderRoute;
  readonly reviewRoute?: QualityProviderRoute;
  readonly producerRoutes?: readonly QualityProviderRoute[];
}): BalancedPrewalkRoute {
  if (input.stage === "explore" || input.stage === "plan") {
    return {
      stage: input.stage,
      route: "frontier",
      executor: "direct",
      ...input.directRoute,
      independent: false,
    };
  }

  if (input.stage === "work") {
    if ((input.workerIndex ?? 0) === 0) {
      return {
        stage: "work",
        route: "frontier",
        executor: "direct",
        ...input.directRoute,
        independent: false,
      };
    }
    if (input.commodityRoute) {
      return {
        stage: "work",
        route: "commodity",
        executor: "commodity",
        ...input.commodityRoute,
        independent: false,
      };
    }
    return {
      stage: "work",
      route: "fallback",
      executor: "direct",
      ...input.directRoute,
      independent: false,
    };
  }

  const selected = input.reviewRoute ?? input.directRoute;
  const independent = input.reviewRoute !== undefined
    && !(input.producerRoutes ?? []).some((route) => providersMatch(route, selected));
  return {
    stage: input.stage,
    route: "direct",
    executor: input.reviewRoute ? "reviewer" : "direct",
    ...selected,
    independent,
  };
}

export type PersistedQualityArtifact = {
  readonly path: string;
  readonly artifactHash: `sha256:${string}`;
  readonly evidenceStatus?: QualityWorkspaceEvidenceStatus | undefined;
  readonly unsupportedEntries?: readonly QualityWorkspaceEntry[] | undefined;
};

export type QualityWorkspaceManifest = {
  readonly artifactHash: `sha256:${string}`;
  readonly evidenceStatus: QualityWorkspaceEvidenceStatus;
  readonly unsupportedEntries: readonly QualityWorkspaceEntry[];
  readonly files: readonly QualityWorkspaceEntry[];
};

export type QualityWorkspaceEvidenceStatus = "supported" | "unsupported";

export type QualityWorkspaceEntry = {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "special" | "missing" | "unreadable";
  readonly sha256: `sha256:${string}` | null;
};

export type QualityWorkspaceInventory = {
  readonly files: readonly QualityWorkspaceEntry[];
  readonly materialInputs: readonly QualityMaterialInput[];
};

export type QualityWorkspaceInventoryManifest = {
  readonly artifactHash: `sha256:${string}`;
  readonly evidenceStatus: QualityWorkspaceEvidenceStatus;
  readonly unsupportedEntries: readonly QualityWorkspaceEntry[];
  readonly files: readonly QualityWorkspaceEntry[];
  readonly materialInputs: readonly QualityMaterialInput[];
};

export type QualityMaterialInput = QualityWorkspaceEntry & {
  readonly entries: number;
};

export type QualityReviewPacket = PersistedQualityArtifact & {
  readonly canonicalContent: string;
  readonly evidenceStatus: QualityWorkspaceEvidenceStatus;
  readonly changedPaths: readonly string[];
  readonly undeclaredPaths: readonly string[];
};

export type QualityReviewPacketInput = {
  readonly graphId: string;
  readonly iteration: number;
  readonly baseline: QualityWorkspaceInventory;
  readonly request: string;
  readonly tasks: readonly {
    readonly id: string;
    readonly acceptanceCriteria: readonly string[];
    readonly writePaths: readonly string[];
  }[];
  readonly results: readonly {
    readonly id: string;
    readonly status: string;
    readonly summary: string;
  }[];
  readonly workerArtifacts: readonly PersistedQualityArtifact[];
  readonly executableChecks: readonly {
    readonly name: string;
    readonly status: string;
    readonly summary: string;
  }[];
};

type QualityWorkspaceSnapshot = Omit<QualityWorkspaceManifest, "artifactHash">;

type GitWorkspaceEntry = {
  readonly kind: QualityWorkspaceEntry["kind"];
  readonly sha256: QualityWorkspaceEntry["sha256"];
};

type GitWorkspaceSnapshot = {
  readonly entries: ReadonlyMap<string, GitWorkspaceEntry>;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly untrackedPaths: ReadonlySet<string>;
  readonly fingerprint: string;
};

type QualityWorkspaceInventoryOptions = {
  readonly scope?: "review" | "direct" | undefined;
};

export type QualityWorkspaceInventoryTelemetry = {
  readonly scanCount: number;
  readonly indexEntryHits: number;
  readonly contentHashMisses: number;
  readonly fallbackScans: number;
  readonly concurrentMutationFailures: number;
  readonly lastScanMs: number;
  readonly maxScanMs: number;
};

export type QualityArtifactPersistenceTelemetry = {
  readonly artifactsWritten: number;
  readonly bytesWritten: number;
  readonly deduplicatedArtifacts: number;
  readonly oversizedArtifactsRejected: number;
};

export type ParsedCriticVerdict = {
  readonly verdict: "pass" | "fail" | "unproven";
  readonly summary: string;
  readonly findings: readonly GateFinding[];
};

const CRITIC_FINDING_KINDS = new Set(["implementation", "plan", "acceptance", "policy"]);
const CRITIC_FINDING_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
export const QUALITY_MANIFEST_MAX_ENTRIES = 10_000;
export const QUALITY_MANIFEST_MAX_DEPTH = 64;
export const QUALITY_MANIFEST_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const QUALITY_MANIFEST_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const QUALITY_REVIEW_PACKET_MAX_BYTES = 1024 * 1024;
export const QUALITY_REVIEW_PACKET_MAX_FILE_BYTES = 256 * 1024;
export const QUALITY_MATERIAL_INPUT_MAX_ENTRIES = 100_000;
const QUALITY_REVIEW_PACKET_CONTENT_BUDGET = 768 * 1024;
export const QUALITY_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const QUALITY_REVIEW_SCOPE_SENTINEL = "[inventory-scope-review]";
const QUALITY_HASH_BUFFER_BYTES = 64 * 1024;
const QUALITY_INVENTORY_IGNORED_ROOTS = new Set([".git", ".unclecode", "node_modules", "target"]);
const isGeneratedInventoryPath = (relativePath: string): boolean =>
  relativePath === "node_modules"
  || relativePath.startsWith("node_modules/")
  || relativePath === "target"
  || relativePath.startsWith("target/");
const QUALITY_MATERIAL_INPUT_ROOTS = [
  ".git",
  ".unclecode/config.json",
  ".unclecode/context/pinned-skills.json",
  ".unclecode/extensions",
  ".unclecode/plugins",
  "node_modules",
  "target",
] as const;

/** Strict critic wire contract: prose can never be mistaken for a passing review. */
export function parseCriticVerdict(raw: string): ParsedCriticVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    record.verdict !== "pass"
    && record.verdict !== "fail"
    && record.verdict !== "unproven"
  ) return undefined;
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) return undefined;
  if (!Array.isArray(record.findings) || record.findings.length > 100) return undefined;

  const findings: GateFinding[] = [];
  for (const finding of record.findings) {
    if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return undefined;
    const item = finding as Record<string, unknown>;
    if (
      typeof item.kind !== "string"
      || !CRITIC_FINDING_KINDS.has(item.kind)
      || typeof item.severity !== "string"
      || !CRITIC_FINDING_SEVERITIES.has(item.severity)
      || typeof item.correctable !== "boolean"
      || (item.direction !== undefined && typeof item.direction !== "string")
    ) return undefined;
    findings.push({
      kind: item.kind as GateFinding["kind"],
      severity: item.severity as GateFinding["severity"],
      correctable: item.correctable,
      ...(typeof item.direction === "string" && item.direction.trim()
        ? { direction: item.direction.trim().slice(0, 2_000) }
        : {}),
    });
  }

  return {
    verdict: record.verdict,
    summary: record.summary.trim().slice(0, 8_000),
    findings,
  };
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(pathname: string): `sha256:${string}` {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(QUALITY_HASH_BUFFER_BYTES);
  const descriptor = openSync(pathname, "r");
  try {
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function safeFilePart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "artifact";
}

function identitySuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareStablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isOwnedPath(candidate: string, ownedRoots: readonly string[]): boolean {
  return ownedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function inventoryEntryChanged(
  before: QualityWorkspaceEntry | undefined,
  after: QualityWorkspaceEntry | undefined,
): boolean {
  return before?.kind !== after?.kind || before?.sha256 !== after?.sha256;
}

function materialInputChanged(
  before: QualityMaterialInput | undefined,
  after: QualityMaterialInput | undefined,
): boolean {
  return inventoryEntryChanged(before, after) || before?.entries !== after?.entries;
}

export class QualityArtifactStore {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly runDirectory: string;
  private readonly workspaceRealRoot: string;
  private inventoryConcurrentMutationDetections = 0;
  private inventoryTelemetry: QualityWorkspaceInventoryTelemetry = {
    scanCount: 0,
    indexEntryHits: 0,
    contentHashMisses: 0,
    fallbackScans: 0,
    concurrentMutationFailures: 0,
    lastScanMs: 0,
    maxScanMs: 0,
  };
  private artifactPersistenceTelemetry: QualityArtifactPersistenceTelemetry = {
    artifactsWritten: 0,
    bytesWritten: 0,
    deduplicatedArtifacts: 0,
    oversizedArtifactsRejected: 0,
  };

  constructor(workspaceRoot: string, runId: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.workspaceRealRoot = realpathSync.native(this.workspaceRoot);
    this.runId = safeFilePart(runId);
    this.runDirectory = path.join(
      this.workspaceRoot,
      ".unclecode",
      "artifacts",
      this.runId,
    );
  }

  /**
   * Snapshots declared files and directory trees without following symlinks.
   * Missing and unreadable paths remain explicit evidence; escaping paths fail closed.
   */
  captureWorkspaceManifest(writePaths: readonly string[]): QualityWorkspaceManifest {
    const snapshot = this.snapshotOwnedPaths(writePaths);
    return {
      artifactHash: sha256(stableJson({
        schemaVersion: 1,
        kind: "workspace-manifest",
        ...snapshot,
      })),
      ...snapshot,
    };
  }

  /**
   * Capture the review baseline without trusting worker summaries. Git provides
   * the bounded source-file inventory when available; small non-git workspaces
   * use the same no-symlink filesystem walker as artifact manifests.
   */
  captureWorkspaceInventory(
    declaredPaths: readonly string[] = [],
    options: QualityWorkspaceInventoryOptions = {},
  ): QualityWorkspaceInventory {
    const scanStartedAt = performance.now();
    const mutationDetectionsBefore = this.inventoryConcurrentMutationDetections;
    const gitBefore = this.readGitWorkspaceSnapshot();
    const ownershipScopedGitInventory = options.scope !== undefined && gitBefore !== undefined;
    const declaredSnapshot = this.snapshotOwnedPaths(declaredPaths);
    const declaredEntries = new Map(
      declaredSnapshot.files
        .filter((entry) => entry.kind !== "directory")
        .map((entry) => [entry.path, entry] as const),
    );
    const candidatePaths = ownershipScopedGitInventory
      ? new Set([
          ...gitBefore.dirtyPaths,
          ...gitBefore.untrackedPaths,
          ...[...gitBefore.entries]
            .filter(([, entry]) => entry.kind !== "file")
            .map(([relativePath]) => relativePath),
        ].filter((relativePath) => !isGeneratedInventoryPath(relativePath)))
      : this.workspaceInventoryPaths(gitBefore);
    for (const entry of declaredSnapshot.files) {
      if (entry.kind !== "directory") candidatePaths.add(entry.path);
    }
    let indexEntryHits = 0;
    let contentHashMisses = 0;
    const contentBudget = { bytes: 0 };
    const files: QualityWorkspaceEntry[] = [
      ...(options.scope === "review"
        ? [{
            path: QUALITY_REVIEW_SCOPE_SENTINEL,
            kind: "file" as const,
            sha256: sha256("unclecode-quality-review-scope-v1"),
          }]
        : []),
      ...(ownershipScopedGitInventory
        ? [{ path: "[git-index-worktree]", kind: "file" as const, sha256: gitBefore.fingerprint as `sha256:${string}` }]
        : []),
    ];
    files.push(...[...candidatePaths]
      .sort(compareStablePaths)
      .slice(0, QUALITY_MANIFEST_MAX_ENTRIES)
      .map((relativePath) => {
        const indexed = gitBefore?.entries.get(relativePath);
        const declared = declaredEntries.get(relativePath);
        // Review evidence owns exact bytes for every declared path. Index
        // identities are only the cheap global undeclared-mutation sentinel.
        if (declared) {
          contentHashMisses += 1;
          return this.snapshotInventoryEntryStable(relativePath, contentBudget);
        }
        // A gitlink is unsupported ownership evidence by definition. Preserve
        // that index type even when its worktree flag asks us not to inspect a
        // nested checkout; representing it as merely missing would fail open.
        if (indexed?.kind === "special") return { path: relativePath, ...indexed };
        if (indexed && !gitBefore?.dirtyPaths.has(relativePath)) {
          if (!ownershipScopedGitInventory) indexEntryHits += 1;
          return { path: relativePath, ...indexed };
        }
        contentHashMisses += 1;
        return options.scope === "review"
          ? this.snapshotInventoryMetadataStable(relativePath)
          : this.snapshotInventoryEntryStable(relativePath, contentBudget);
      }));
    if (ownershipScopedGitInventory) {
      indexEntryHits += [...gitBefore.entries.keys()]
        .filter((relativePath) => !gitBefore.dirtyPaths.has(relativePath)).length;
    }
    if (candidatePaths.size > QUALITY_MANIFEST_MAX_ENTRIES) {
      files.push({ path: "[inventory-entry-limit]", kind: "unreadable", sha256: null });
    }
    let concurrentMutationFailures = 0;
    if (gitBefore) {
      const gitAfter = this.readGitWorkspaceSnapshot();
      if (!gitAfter || gitAfter.fingerprint !== gitBefore.fingerprint) {
        concurrentMutationFailures += 1;
        files.push({
          path: "[git-workspace-changed-during-inventory]",
          kind: "unreadable",
          sha256: null,
        });
      }
    }
    concurrentMutationFailures +=
      this.inventoryConcurrentMutationDetections - mutationDetectionsBefore;
    const scanMs = Math.max(0, performance.now() - scanStartedAt);
    this.inventoryTelemetry = {
      scanCount: this.inventoryTelemetry.scanCount + 1,
      indexEntryHits: this.inventoryTelemetry.indexEntryHits + indexEntryHits,
      contentHashMisses: this.inventoryTelemetry.contentHashMisses + contentHashMisses,
      fallbackScans: this.inventoryTelemetry.fallbackScans + (gitBefore ? 0 : 1),
      concurrentMutationFailures:
        this.inventoryTelemetry.concurrentMutationFailures + concurrentMutationFailures,
      lastScanMs: scanMs,
      maxScanMs: Math.max(this.inventoryTelemetry.maxScanMs, scanMs),
    };
    return {
      files,
      materialInputs: (options.scope !== undefined
        ? QUALITY_MATERIAL_INPUT_ROOTS.filter((relativePath) =>
            relativePath !== ".git" && relativePath !== "node_modules" && relativePath !== "target")
        : QUALITY_MATERIAL_INPUT_ROOTS).map((relativePath) =>
        this.snapshotMaterialInput(relativePath)),
    };
  }


  getWorkspaceInventoryTelemetry(): QualityWorkspaceInventoryTelemetry {
    return { ...this.inventoryTelemetry };
  }

  getArtifactPersistenceTelemetry(): QualityArtifactPersistenceTelemetry {
    return { ...this.artifactPersistenceTelemetry };
  }

  /** A bounded whole-workspace fingerprint suitable for direct tool turns. */
  captureWorkspaceInventoryManifest(
    options: QualityWorkspaceInventoryOptions = {},
  ): QualityWorkspaceInventoryManifest {
    const inventory = this.captureWorkspaceInventory([], options);
    const allEntries: readonly QualityWorkspaceEntry[] = [
      ...inventory.files,
      ...inventory.materialInputs,
    ];
    const unsupportedEntries = allEntries.filter((entry) =>
      entry.kind === "unreadable" || entry.kind === "symlink" || entry.kind === "special");
    const body = {
      schemaVersion: 1,
      kind: "workspace-inventory-manifest",
      files: inventory.files,
      materialInputs: inventory.materialInputs,
    } as const;
    return {
      artifactHash: sha256(stableJson(body)),
      evidenceStatus: unsupportedEntries.length === 0 ? "supported" : "unsupported",
      unsupportedEntries,
      ...inventory,
    };
  }

  /** Persist a content-addressed immutable packet whose exact canonical body is reviewed. */
  persistReviewPacket(input: QualityReviewPacketInput): QualityReviewPacket {
    const declaredPaths = [...new Set(input.tasks.flatMap((task) => task.writePaths))]
      .map((writePath) => this.resolveOwnedPath(writePath).relativePath)
      .sort(compareStablePaths);
    const ownershipScopedBaseline = input.baseline.files.some((entry) =>
      entry.path === QUALITY_REVIEW_SCOPE_SENTINEL || entry.path === "[git-index-worktree]");
    const current = this.captureWorkspaceInventory(
      declaredPaths,
      ownershipScopedBaseline ? { scope: "review" } : {},
    );
    const beforeByPath = new Map(input.baseline.files.map((entry) => [entry.path, entry] as const));
    const afterByPath = new Map(current.files.map((entry) => [entry.path, entry] as const));
    const baselineMaterialInputs = input.baseline.materialInputs ?? [];
    const currentMaterialInputs = current.materialInputs ?? [];
    const beforeMaterialByPath = new Map(baselineMaterialInputs.map((entry) => [entry.path, entry] as const));
    const afterMaterialByPath = new Map(currentMaterialInputs.map((entry) => [entry.path, entry] as const));
    const materialInputUnsupportedEntries: QualityWorkspaceEntry[] = [];
    const reviewedMaterialRoots = new Set([
      ...baselineMaterialInputs.map((entry) => entry.path),
      ...currentMaterialInputs.map((entry) => entry.path),
    ]);
    for (const relativePath of reviewedMaterialRoots) {
      const before = beforeMaterialByPath.get(relativePath);
      const after = afterMaterialByPath.get(relativePath);
      if (!before || !after) {
        materialInputUnsupportedEntries.push({
          path: `[material-input-inventory-missing]:${relativePath}`,
          kind: "unreadable",
          sha256: null,
        });
        continue;
      }
      if (
        before.kind === "unreadable"
        || before.kind === "symlink"
        || before.kind === "special"
        || after.kind === "unreadable"
        || after.kind === "symlink"
        || after.kind === "special"
      ) {
        materialInputUnsupportedEntries.push({
          path: `[material-input-unsupported]:${relativePath}`,
          kind: "unreadable",
          sha256: null,
        });
      }
      if (materialInputChanged(before, after)) {
        materialInputUnsupportedEntries.push({
          path: `[material-input-changed]:${relativePath}`,
          kind: "unreadable",
          sha256: null,
        });
      }
    }
    const inventoryUnsupportedEntries = [...new Map(
      [...input.baseline.files, ...current.files]
        .filter((entry) => entry.kind === "unreadable")
        .map((entry) => [entry.path, entry] as const),
    ).values()];
    const changedPaths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
      .filter((candidate) => inventoryEntryChanged(beforeByPath.get(candidate), afterByPath.get(candidate)))
      .sort(compareStablePaths);
    const undeclaredPaths = changedPaths.filter((candidate) => !isOwnedPath(candidate, declaredPaths));
    const declaredManifest = this.snapshotOwnedPaths(declaredPaths);
    const packetPaths = [...new Set([
      ...declaredManifest.files.filter((entry) => entry.kind !== "directory").map((entry) => entry.path),
      ...changedPaths,
    ])].sort(compareStablePaths);
    const contentBudget = { bytes: 0 };
    const inventoryBudget = { bytes: 0 };
    const packetFiles = packetPaths.map((relativePath) => {
      const before = beforeByPath.get(relativePath);
      const after = afterByPath.get(relativePath) ?? this.snapshotInventoryEntry(relativePath, inventoryBudget);
      const content = after.kind === "file" ? this.readReviewPacketContent(relativePath, contentBudget) : undefined;
      return {
        path: relativePath,
        declared: isOwnedPath(relativePath, declaredPaths),
        change: inventoryEntryChanged(before, after)
          ? before === undefined || before.kind === "missing"
            ? "added"
            : after.kind === "missing"
              ? "deleted"
              : "modified"
          : "unchanged",
        before: before ? { kind: before.kind, sha256: before.sha256 } : null,
        after: { kind: after.kind, sha256: after.sha256 },
        ...(content ?? {}),
      };
    });
    const unsupportedPacketPaths = packetFiles
      .filter((entry) => entry.after.kind === "symlink"
        || entry.after.kind === "special"
        || entry.after.kind === "unreadable"
        || ("contentOmitted" in entry && entry.contentOmitted === true))
      .map((entry) => entry.path);
    const requestTruncated = input.request.length > 32_000;
    const body = {
      schemaVersion: 1,
      kind: "quality-review-packet",
      runId: this.runId,
      graphId: input.graphId,
      iteration: input.iteration,
      request: input.request.slice(0, 32_000),
      ...(requestTruncated ? { requestTruncated: true } : {}),
      ownership: input.tasks.map((task) => ({
        nodeId: task.id,
        acceptanceCriteria: task.acceptanceCriteria.map((criterion) => criterion.slice(0, 2_000)),
        writePaths: [...task.writePaths].sort(compareStablePaths),
      })),
      changedPaths,
      undeclaredPaths,
      materialInputs: currentMaterialInputs,
      files: packetFiles,
      workerArtifacts: input.workerArtifacts.map((artifact) => ({
        path: artifact.path,
        artifactHash: artifact.artifactHash,
      })),
      results: input.results.map((result) => ({
        id: result.id,
        status: result.status,
        untrustedWorkerSummary: result.summary.slice(0, 2_000),
      })),
      executableChecks: input.executableChecks.map((check) => ({
        name: check.name.slice(0, 200),
        status: check.status,
        summary: check.summary.slice(0, 2_000),
      })),
    };
    const fullCanonicalContent = stableJson(body);
    const oversized = Buffer.byteLength(fullCanonicalContent) > QUALITY_REVIEW_PACKET_MAX_BYTES;
    const packetBody = oversized
      ? {
          schemaVersion: 1,
          kind: "quality-review-packet",
          runId: this.runId,
          graphId: input.graphId,
          iteration: input.iteration,
          changedPaths: changedPaths.slice(0, 256),
          undeclaredPaths: undeclaredPaths.slice(0, 256),
          materialInputs: currentMaterialInputs,
          packetError: "QUALITY_REVIEW_PACKET_LIMIT_EXCEEDED",
        }
      : body;
    const canonicalContent = stableJson(packetBody);
    const evidenceStatus = undeclaredPaths.length === 0
      && unsupportedPacketPaths.length === 0
      && inventoryUnsupportedEntries.length === 0
      && materialInputUnsupportedEntries.length === 0
      && !requestTruncated
      && !oversized
      && declaredManifest.evidenceStatus === "supported"
      ? "supported"
      : "unsupported";
    const artifactHash = sha256(canonicalContent);
    mkdirSync(this.runDirectory, { recursive: true });
    const fileName = `review-packet-iteration-${input.iteration}-${artifactHash.slice("sha256:".length)}.json`;
    const outputPath = path.join(this.runDirectory, fileName);
    const persistedContent = stableJson({ ...packetBody, artifactHash, evidenceStatus });
    const persistedBytes = Buffer.byteLength(persistedContent, "utf8");
    if (persistedBytes > QUALITY_ARTIFACT_MAX_BYTES) {
      this.artifactPersistenceTelemetry = {
        ...this.artifactPersistenceTelemetry,
        oversizedArtifactsRejected:
          this.artifactPersistenceTelemetry.oversizedArtifactsRejected + 1,
      };
      throw new Error(
        `Quality review packet exceeds the ${QUALITY_ARTIFACT_MAX_BYTES}-byte persistence limit.`,
      );
    }
    let createdArtifact = false;
    try {
      writeFileSync(outputPath, persistedContent, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      createdArtifact = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingContent: string;
      try {
        existingContent = readFileSync(outputPath, "utf8");
      } catch {
        throw new Error(`Immutable review packet artifact is unreadable: ${outputPath}`);
      }
      if (existingContent !== persistedContent) {
        throw new Error(`Immutable review packet artifact was replaced: ${outputPath}`);
      }
    }
    this.artifactPersistenceTelemetry = createdArtifact
      ? {
          artifactsWritten: this.artifactPersistenceTelemetry.artifactsWritten + 1,
          bytesWritten: this.artifactPersistenceTelemetry.bytesWritten + persistedBytes,
          deduplicatedArtifacts: this.artifactPersistenceTelemetry.deduplicatedArtifacts,
          oversizedArtifactsRejected: this.artifactPersistenceTelemetry.oversizedArtifactsRejected,
        }
      : {
          ...this.artifactPersistenceTelemetry,
          deduplicatedArtifacts: this.artifactPersistenceTelemetry.deduplicatedArtifacts + 1,
        };
    return {
      path: path.relative(this.workspaceRoot, outputPath),
      artifactHash,
      canonicalContent,
      evidenceStatus,
      changedPaths,
      undeclaredPaths,
      unsupportedEntries: [
        ...inventoryUnsupportedEntries,
        ...materialInputUnsupportedEntries,
        ...declaredManifest.unsupportedEntries,
        ...unsupportedPacketPaths.map((entryPath) => ({
          path: entryPath,
          kind: "unreadable" as const,
          sha256: null,
        })),
        ...(requestTruncated
          ? [{
              path: "[review-request-limit]",
              kind: "unreadable" as const,
              sha256: null,
            }]
          : []),
        ...(oversized
          ? [{
              path: "[review-packet-limit]",
              kind: "unreadable" as const,
              sha256: null,
            }]
          : []),
      ],
    };
  }

  private workspaceInventoryPaths(gitSnapshot?: GitWorkspaceSnapshot | undefined): Set<string> {
    const paths = new Set<string>();
    if (gitSnapshot) {
      for (const relativePath of gitSnapshot.entries.keys()) paths.add(relativePath);
    } else try {
      const output = execFileSync(
        "git",
        ["-C", this.workspaceRoot, "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
      );
      for (const candidate of output.toString("utf8").split("\0").filter(Boolean)) {
        paths.add(candidate);
      }
    } catch {
      // The filesystem inventory below is authoritative when git is absent.
    }
    // Include ignored-but-material workspace files as well as git's source view;
    // root exclusions bound generated/vendor state and the artifact store itself.
    this.collectWorkspaceInventoryPaths(this.workspaceRoot, "", paths, 0);
    return paths;
  }

  /**
   * Git already owns a content-addressed identity for every clean tracked
   * path. Reusing that identity avoids synchronously opening and hashing every
   * source file before a minimal chat can reach its provider. Dirty/untracked
   * paths still go through the bounded filesystem hasher below.
   */
  private readGitWorkspaceSnapshot(): GitWorkspaceSnapshot | undefined {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    };
    for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete environment[key];
    try {
      const stagedAndFlags = execFileSync(
        "git",
        ["-C", this.workspaceRoot, "-c", "core.fsmonitor=false", "ls-files", "--stage", "-v", "-z"],
        { encoding: "buffer", env: environment, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
      );
      const statusOutput = execFileSync(
        "git",
        ["-C", this.workspaceRoot, "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none", "--no-renames"],
        { encoding: "buffer", env: environment, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
      );
      const entries = new Map<string, GitWorkspaceEntry>();
      const dirtyPaths = new Set<string>();
      const untrackedPaths = new Set<string>();
      for (const record of statusOutput.toString("utf8").split("\0").filter(Boolean)) {
        if (record.length < 4 || record[2] !== " ") throw new Error("Malformed git status record.");
        const status = record.slice(0, 2);
        const relativePath = record.slice(3);
        if (!relativePath) throw new Error("Malformed git status path.");
        if (status === "??") untrackedPaths.add(relativePath);
        // The index object already binds staged-only bytes. Re-open only when
        // the worktree column is dirty; this preserves staged/worktree
        // identity without turning every staged path into a content-hash miss.
        else if (status[1] !== " ") dirtyPaths.add(relativePath);
      }
      // `diff-files` intentionally trusts assume-unchanged/skip-worktree bits.
      // Fast inventory cannot: such paths must be read from the worktree (or
      // recorded missing) instead of borrowing the index object's identity.
      for (const record of stagedAndFlags.toString("utf8").split("\0").filter(Boolean)) {
        if (record.length < 3 || record[1] !== " ") throw new Error("Malformed git worktree flag record.");
        const tag = record[0];
        const stagedRecord = record.slice(2);
        if (!tag) throw new Error("Malformed git worktree flag identity.");
        const separator = stagedRecord.indexOf("\t");
        if (separator < 0) throw new Error("Malformed git index record.");
        const [mode, objectId, stage] = stagedRecord.slice(0, separator).split(" ");
        const relativePath = stagedRecord.slice(separator + 1);
        if (tag !== "H") dirtyPaths.add(relativePath);
        if (!mode || !objectId || !stage || !relativePath) throw new Error("Malformed git index identity.");
        if (stage !== "0" || /^0+$/u.test(objectId) || entries.has(relativePath)) {
          dirtyPaths.add(relativePath);
          continue;
        }
        const kind: QualityWorkspaceEntry["kind"] = mode === "120000"
          ? "symlink"
          : mode === "160000"
            ? "special"
            : mode.startsWith("100")
              ? "file"
              : "unreadable";
        entries.set(relativePath, {
          kind,
          sha256: kind === "unreadable"
            ? null
            : sha256(stableJson({ source: "git-index", mode, objectId })),
        });
      }
      const fingerprint = sha256(stableJson({
        entries: [...entries.entries()].sort(([left], [right]) => compareStablePaths(left, right)),
        dirtyPaths: [...dirtyPaths].sort(compareStablePaths),
        untrackedPaths: [...untrackedPaths].sort(compareStablePaths),
      }));
      return { entries, dirtyPaths, untrackedPaths, fingerprint };
    } catch {
      return undefined;
    }
  }

  /**
   * Fingerprint ignored dependency/build roots without reading their potentially
   * huge contents. File identity, size, and nanosecond change timestamps make a
   * post-baseline mutation observable; unsafe links and bounded-walk failures
   * fail closed instead of becoming reviewer evidence.
   */
  private snapshotMaterialInput(relativeRoot: string): QualityMaterialInput {
    const absoluteRoot = path.resolve(this.workspaceRoot, relativeRoot);
    if (!isContainedPath(this.workspaceRoot, absoluteRoot)) {
      return { path: relativeRoot, kind: "unreadable", sha256: null, entries: 0 };
    }
    let rootStats: ReturnType<typeof lstatSync>;
    try {
      rootStats = lstatSync(absoluteRoot);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { path: relativeRoot, kind: "missing", sha256: null, entries: 0 }
        : { path: relativeRoot, kind: "unreadable", sha256: null, entries: 0 };
    }

    const rootKind: QualityWorkspaceEntry["kind"] = rootStats.isDirectory()
      ? "directory"
      : rootStats.isFile()
        ? "file"
        : rootStats.isSymbolicLink()
          ? "symlink"
          : "special";
    const hash = createHash("sha256");
    if (relativeRoot === ".git") {
      if ((rootKind !== "file" && rootKind !== "directory") || !this.hashRepositoryGitState(hash)) {
        return { path: relativeRoot, kind: "unreadable", sha256: null, entries: 1 };
      }
      return {
        path: relativeRoot,
        kind: rootKind,
        sha256: `sha256:${hash.digest("hex")}`,
        entries: 1,
      };
    }
    const state = { entries: 0, unsupported: false };
    try {
      this.hashMaterialInputMetadata(absoluteRoot, relativeRoot, hash, state, 0);
    } catch {
      return { path: relativeRoot, kind: "unreadable", sha256: null, entries: state.entries };
    }
    if (state.unsupported) {
      return { path: relativeRoot, kind: "unreadable", sha256: null, entries: state.entries };
    }
    return {
      path: relativeRoot,
      kind: rootKind,
      sha256: `sha256:${hash.digest("hex")}`,
      entries: state.entries,
    };
  }

  private hashRepositoryGitState(hash: ReturnType<typeof createHash>): boolean {
    const commands = [
      ["rev-parse", "--verify", "HEAD"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["diff", "--cached", "--raw", "-z", "--no-ext-diff"],
      ["config", "--local", "--null", "--list"],
    ] as const;
    try {
      for (const command of commands) {
        const output = execFileSync("git", [
          "-C",
          this.workspaceRoot,
          "-c",
          "core.fsmonitor=false",
          ...command,
        ], {
          encoding: "buffer",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        hash.update(stableJson({ command }));
        hash.update(output);
      }
      return true;
    } catch {
      return false;
    }
  }

  private hashMaterialInputMetadata(
    absolutePath: string,
    relativePath: string,
    hash: ReturnType<typeof createHash>,
    state: { entries: number; unsupported: boolean },
    depth: number,
  ): void {
    if (depth > QUALITY_MANIFEST_MAX_DEPTH || state.entries >= QUALITY_MATERIAL_INPUT_MAX_ENTRIES) {
      throw new Error("Material input fingerprint limit exceeded");
    }
    const stats = lstatSync(absolutePath, { bigint: true });
    state.entries += 1;
    const kind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : "special";
    let linkTarget: string | undefined;
    if (kind === "symlink") {
      linkTarget = readlinkSync(absolutePath);
      let resolvedTarget: string;
      try {
        resolvedTarget = realpathSync.native(absolutePath);
      } catch {
        state.unsupported = true;
        return;
      }
      if (!isContainedPath(this.workspaceRealRoot, resolvedTarget)) state.unsupported = true;
    } else if (kind === "special") {
      state.unsupported = true;
    }
    hash.update(stableJson({
      path: relativePath,
      kind,
      device: String(stats.dev),
      inode: String(stats.ino),
      mode: String(stats.mode),
      links: String(stats.nlink),
      size: String(stats.size),
      modifiedNs: String(stats.mtimeNs),
      changedNs: String(stats.ctimeNs),
      ...(linkTarget === undefined ? {} : { linkTarget }),
    }));
    if (kind !== "directory") return;

    const directory = opendirSync(absolutePath);
    const childNames: string[] = [];
    try {
      while (true) {
        const child = directory.readSync();
        if (!child) break;
        childNames.push(child.name);
        if (state.entries + childNames.length > QUALITY_MATERIAL_INPUT_MAX_ENTRIES) {
          throw new Error("Material input fingerprint limit exceeded");
        }
      }
    } finally {
      directory.closeSync();
    }
    childNames.sort(compareStablePaths);
    for (const childName of childNames) {
      this.hashMaterialInputMetadata(
        path.join(absolutePath, childName),
        `${relativePath}/${childName}`,
        hash,
        state,
        depth + 1,
      );
    }
  }

  private collectWorkspaceInventoryPaths(
    absoluteDirectory: string,
    relativeDirectory: string,
    output: Set<string>,
    depth: number,
  ): void {
    if (depth > QUALITY_MANIFEST_MAX_DEPTH || output.size > QUALITY_MANIFEST_MAX_ENTRIES) return;
    let directory;
    try {
      directory = opendirSync(absoluteDirectory);
    } catch {
      output.add(relativeDirectory || "[workspace-unreadable]");
      return;
    }
    try {
      while (output.size <= QUALITY_MANIFEST_MAX_ENTRIES) {
        const child = directory.readSync();
        if (!child) break;
        if (depth === 0 && QUALITY_INVENTORY_IGNORED_ROOTS.has(child.name)) continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const absolutePath = path.join(absoluteDirectory, child.name);
        if (child.isDirectory()) {
          this.collectWorkspaceInventoryPaths(absolutePath, relativePath, output, depth + 1);
        } else {
          output.add(relativePath);
        }
      }
    } finally {
      directory.closeSync();
    }
  }

  private snapshotInventoryEntry(
    relativePath: string,
    budget: { bytes: number } = { bytes: 0 },
  ): QualityWorkspaceEntry {
    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    if (!isContainedPath(this.workspaceRoot, absolutePath)) {
      return { path: relativePath, kind: "unreadable", sha256: null };
    }
    const entries = new Map<string, QualityWorkspaceEntry>();
    this.snapshotOwnedPath(absolutePath, relativePath, entries, budget, 0);
    return entries.get(relativePath) ?? { path: relativePath, kind: "missing", sha256: null };
  }

  /** Fail closed if a dirty/untracked path changes while its bytes are read. */
  private snapshotInventoryEntryStable(
    relativePath: string,
    budget: { bytes: number } = { bytes: 0 },
  ): QualityWorkspaceEntry {
    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    const before = this.inventoryStatIdentity(absolutePath);
    const entry = this.snapshotInventoryEntry(relativePath, budget);
    const after = this.inventoryStatIdentity(absolutePath);
    if (before !== after) {
      this.inventoryConcurrentMutationDetections += 1;
      return { path: relativePath, kind: "unreadable", sha256: null };
    }
    return entry;
  }

  /**
   * Undeclared dirty/untracked paths are mutation sentinels, not review
   * content. Device/inode/mode/size plus ctime/mtime catches replacement and
   * byte changes without synchronously reading every pre-existing dirty file;
   * declared paths still take the content-hash path above.
   */
  private snapshotInventoryMetadataStable(relativePath: string): QualityWorkspaceEntry {
    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    if (!isContainedPath(this.workspaceRoot, absolutePath)) {
      return { path: relativePath, kind: "unreadable", sha256: null };
    }
    const before = this.inventoryStatIdentity(absolutePath);
    let entry: QualityWorkspaceEntry;
    try {
      const stats = lstatSync(absolutePath);
      const kind: QualityWorkspaceEntry["kind"] = stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : stats.isSymbolicLink()
            ? "symlink"
            : "special";
      entry = {
        path: relativePath,
        kind,
        sha256: kind === "file" || kind === "directory"
          ? sha256(stableJson({ source: "worktree-metadata", identity: before }))
          : null,
      };
    } catch (error) {
      entry = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { path: relativePath, kind: "missing", sha256: null }
        : { path: relativePath, kind: "unreadable", sha256: null };
    }
    const after = this.inventoryStatIdentity(absolutePath);
    if (before !== after) {
      this.inventoryConcurrentMutationDetections += 1;
      return { path: relativePath, kind: "unreadable", sha256: null };
    }
    return entry;
  }

  private inventoryStatIdentity(absolutePath: string): string {
    try {
      const stats = lstatSync(absolutePath, { bigint: true });
      return stableJson({
        device: String(stats.dev),
        inode: String(stats.ino),
        mode: String(stats.mode),
        size: String(stats.size),
        modifiedNs: String(stats.mtimeNs),
        changedNs: String(stats.ctimeNs),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? "missing" : `error:${code ?? "unknown"}`;
    }
  }

  private readReviewPacketContent(
    relativePath: string,
    budget: { bytes: number },
  ): { readonly encoding: "utf8" | "base64"; readonly content: string } | { readonly contentOmitted: true } {
    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(absolutePath);
    } catch {
      return { contentOmitted: true };
    }
    if (
      !stats.isFile()
      || stats.size > QUALITY_REVIEW_PACKET_MAX_FILE_BYTES
      || budget.bytes + stats.size > QUALITY_REVIEW_PACKET_CONTENT_BUDGET
    ) return { contentOmitted: true };
    const content = readFileSync(absolutePath);
    budget.bytes += content.byteLength;
    const utf8 = content.toString("utf8");
    return !utf8.includes("\0") && Buffer.from(utf8, "utf8").equals(content)
      ? { encoding: "utf8", content: utf8 }
      : { encoding: "base64", content: content.toString("base64") };
  }

  persistNode(input: {
    readonly nodeId: string;
    readonly attempt: number;
    readonly iteration?: number | undefined;
    readonly producerId: string;
    readonly summary: string;
    readonly writePaths: readonly string[];
    readonly completedAt: string;
    readonly status?: "completed" | "failed" | "cancelled" | "blocked" | undefined;
  }): PersistedQualityArtifact {
    const snapshot = this.snapshotOwnedPaths(input.writePaths);
    const iteration = input.iteration ?? 0;
    const artifact = this.persist(
      `${safeFilePart(input.nodeId)}-${identitySuffix(input.nodeId)}-iteration-${iteration}-attempt-${input.attempt}.json`,
      {
        schemaVersion: 1,
        kind: "worker",
        runId: this.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        iteration,
        producerId: input.producerId,
        summary: input.summary.slice(0, 8_000),
        status: input.status ?? "completed",
        ...snapshot,
        completedAt: input.completedAt,
      },
    );
    return {
      ...artifact,
      evidenceStatus: snapshot.evidenceStatus,
      unsupportedEntries: snapshot.unsupportedEntries,
    };
  }

  persistDirectTurn(input: {
    readonly intent: "simple" | "research";
    readonly iteration?: number | undefined;
    readonly producerId: string;
    readonly summary: string;
    readonly completedAt: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly workspaceManifest: QualityWorkspaceInventoryManifest;
  }): PersistedQualityArtifact {
    const iteration = input.iteration ?? 0;
    const fileName = iteration === 0
      ? "direct-turn.json"
      : `direct-turn-iteration-${iteration}.json`;
    return this.persist(fileName, {
      schemaVersion: 1,
      kind: "direct-turn",
      runId: this.runId,
      intent: input.intent,
      iteration,
      producerId: input.producerId,
      summary: input.summary.slice(0, 8_000),
      status: input.status,
      workspaceManifest: input.workspaceManifest,
      completedAt: input.completedAt,
    });
  }

  private snapshotOwnedPaths(writePaths: readonly string[]): QualityWorkspaceSnapshot {
    const entries = new Map<string, QualityWorkspaceEntry>();
    const budget = { bytes: 0 };
    const roots = [...new Set(writePaths)]
      .map((writePath) => this.resolveOwnedPath(writePath))
      .sort((left, right) => compareStablePaths(left.relativePath, right.relativePath));
    for (const root of roots) {
      this.snapshotOwnedPath(root.absolutePath, root.relativePath, entries, budget, 0);
    }
    const files = [...entries.values()].sort((left, right) => compareStablePaths(left.path, right.path));
    const unsupportedEntries = files.filter((entry) =>
      entry.kind === "symlink" || entry.kind === "special" || entry.kind === "unreadable");
    return {
      evidenceStatus: unsupportedEntries.length === 0 ? "supported" : "unsupported",
      unsupportedEntries,
      files,
    };
  }

  private resolveOwnedPath(writePath: string): { readonly absolutePath: string; readonly relativePath: string } {
    const absolutePath = path.resolve(this.workspaceRoot, writePath);
    if (!isContainedPath(this.workspaceRoot, absolutePath)) {
      throw new Error(`Owned path is outside the workspace: ${writePath}`);
    }
    const unsupportedAncestor = this.findUnsupportedPathComponent(absolutePath);
    if (unsupportedAncestor) return unsupportedAncestor;
    this.assertExistingParentContained(absolutePath, writePath);
    return {
      absolutePath,
      relativePath: portableRelativePath(this.workspaceRoot, absolutePath),
    };
  }

  /** Returns the first symlink/special path component without traversing beyond it. */
  private findUnsupportedPathComponent(
    absolutePath: string,
  ): { readonly absolutePath: string; readonly relativePath: string } | undefined {
    const relative = path.relative(this.workspaceRoot, absolutePath);
    if (!relative) return undefined;
    let candidate = this.workspaceRoot;
    for (const component of relative.split(path.sep)) {
      candidate = path.join(candidate, component);
      try {
        const stats = lstatSync(candidate);
        if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
          return {
            absolutePath: candidate,
            relativePath: portableRelativePath(this.workspaceRoot, candidate),
          };
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        return {
          absolutePath: candidate,
          relativePath: portableRelativePath(this.workspaceRoot, candidate),
        };
      }
    }
    return undefined;
  }

  private assertExistingParentContained(absolutePath: string, writePath: string): void {
    let ancestor = path.dirname(absolutePath);
    while (isContainedPath(this.workspaceRoot, ancestor)) {
      try {
        const realAncestor = realpathSync.native(ancestor);
        if (!isContainedPath(this.workspaceRealRoot, realAncestor)) {
          throw new Error(`Owned path resolves outside the workspace: ${writePath}`);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (ancestor === this.workspaceRoot) return;
      ancestor = path.dirname(ancestor);
    }
  }

  private snapshotOwnedPath(
    absolutePath: string,
    relativePath: string,
    entries: Map<string, QualityWorkspaceEntry>,
    budget: { bytes: number },
    depth: number,
  ): void {
    if (isContainedPath(this.runDirectory, absolutePath)) return;
    if (entries.size >= QUALITY_MANIFEST_MAX_ENTRIES - 1) {
      entries.set(`${relativePath}/[manifest-entry-limit]`, {
        path: `${relativePath}/[manifest-entry-limit]`,
        kind: "unreadable",
        sha256: null,
      });
      return;
    }
    if (depth > QUALITY_MANIFEST_MAX_DEPTH) {
      entries.set(relativePath, { path: relativePath, kind: "unreadable", sha256: null });
      return;
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(absolutePath);
    } catch (error) {
      entries.set(relativePath, {
        path: relativePath,
        kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable",
        sha256: null,
      });
      return;
    }

    if (stats.isSymbolicLink()) {
      try {
        entries.set(relativePath, {
          path: relativePath,
          kind: "symlink",
          sha256: sha256(readlinkSync(absolutePath)),
        });
      } catch {
        entries.set(relativePath, { path: relativePath, kind: "unreadable", sha256: null });
      }
      return;
    }
    if (stats.isFile()) {
      if (
        stats.size > QUALITY_MANIFEST_MAX_FILE_BYTES
        || budget.bytes + stats.size > QUALITY_MANIFEST_MAX_TOTAL_BYTES
      ) {
        entries.set(relativePath, { path: relativePath, kind: "unreadable", sha256: null });
        return;
      }
      try {
        entries.set(relativePath, {
          path: relativePath,
          kind: "file",
          sha256: sha256File(absolutePath),
        });
        budget.bytes += stats.size;
      } catch {
        entries.set(relativePath, { path: relativePath, kind: "unreadable", sha256: null });
      }
      return;
    }
    if (!stats.isDirectory()) {
      entries.set(relativePath, { path: relativePath, kind: "special", sha256: null });
      return;
    }

    entries.set(relativePath, { path: relativePath, kind: "directory", sha256: null });
    const childNames: string[] = [];
    try {
      const directory = opendirSync(absolutePath);
      try {
        while (childNames.length < QUALITY_MANIFEST_MAX_ENTRIES) {
          const child = directory.readSync();
          if (!child) break;
          childNames.push(child.name);
        }
      } finally {
        directory.closeSync();
      }
      childNames.sort(compareStablePaths);
    } catch {
      entries.set(relativePath, { path: relativePath, kind: "unreadable", sha256: null });
      return;
    }
    for (const childName of childNames) {
      const childAbsolutePath = path.join(absolutePath, childName);
      if (!isContainedPath(this.workspaceRoot, childAbsolutePath)) {
        throw new Error(`Owned directory entry is outside the workspace: ${relativePath}/${childName}`);
      }
      this.snapshotOwnedPath(
        childAbsolutePath,
        portableRelativePath(this.workspaceRoot, childAbsolutePath),
        entries,
        budget,
        depth + 1,
      );
    }
  }

  persistRun(input: {
    readonly graphId: string;
    readonly iteration?: number | undefined;
    readonly producerId: string;
    readonly artifacts: readonly PersistedQualityArtifact[];
    readonly completedAt: string;
    readonly workspaceManifest?: QualityWorkspaceManifest | undefined;
  }): PersistedQualityArtifact {
    const iteration = input.iteration ?? 0;
    return this.persist(iteration === 0 ? "run.json" : `run-iteration-${iteration}.json`, {
      schemaVersion: 1,
      kind: "run",
      runId: this.runId,
      graphId: input.graphId,
      iteration,
      producerId: input.producerId,
      artifacts: input.artifacts,
      ...(input.workspaceManifest ? { workspaceManifest: input.workspaceManifest } : {}),
      completedAt: input.completedAt,
    });
  }

  persistCritic(input: {
    readonly reviewerId: string;
    readonly iteration?: number | undefined;
    readonly reviewedArtifactHash: string;
    readonly summary: string;
    readonly independent: boolean;
    readonly completedAt: string;
  }): PersistedQualityArtifact {
    const iteration = input.iteration ?? 0;
    return this.persist(iteration === 0 ? "critic.json" : `critic-iteration-${iteration}.json`, {
      schemaVersion: 1,
      kind: "critic",
      runId: this.runId,
      iteration,
      reviewerId: input.reviewerId,
      reviewedArtifactHash: input.reviewedArtifactHash,
      summary: input.summary.slice(0, 8_000),
      independent: input.independent,
      completedAt: input.completedAt,
    });
  }

  private persist(fileName: string, body: Record<string, unknown>): PersistedQualityArtifact {
    mkdirSync(this.runDirectory, { recursive: true });
    const artifactHash = sha256(stableJson(body));
    const outputPath = path.join(this.runDirectory, fileName);
    const persistedContent = stableJson({ ...body, artifactHash });
    const persistedBytes = Buffer.byteLength(persistedContent, "utf8");
    if (persistedBytes > QUALITY_ARTIFACT_MAX_BYTES) {
      this.artifactPersistenceTelemetry = {
        ...this.artifactPersistenceTelemetry,
        oversizedArtifactsRejected:
          this.artifactPersistenceTelemetry.oversizedArtifactsRejected + 1,
      };
      throw new Error(
        `Quality artifact exceeds the ${QUALITY_ARTIFACT_MAX_BYTES}-byte persistence limit.`,
      );
    }
    writeFileSync(outputPath, persistedContent, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.artifactPersistenceTelemetry = {
      artifactsWritten: this.artifactPersistenceTelemetry.artifactsWritten + 1,
      bytesWritten: this.artifactPersistenceTelemetry.bytesWritten + persistedBytes,
      deduplicatedArtifacts: this.artifactPersistenceTelemetry.deduplicatedArtifacts,
      oversizedArtifactsRejected: this.artifactPersistenceTelemetry.oversizedArtifactsRejected,
    };
    return {
      path: path.relative(this.workspaceRoot, outputPath),
      artifactHash,
    };
  }
}
