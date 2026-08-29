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
const QUALITY_REVIEW_PACKET_CONTENT_BUDGET = 768 * 1024;
const QUALITY_HASH_BUFFER_BYTES = 64 * 1024;
const QUALITY_INVENTORY_IGNORED_ROOTS = new Set([".git", ".unclecode", "node_modules", "target"]);

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

export class QualityArtifactStore {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly runDirectory: string;
  private readonly workspaceRealRoot: string;

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
  captureWorkspaceInventory(declaredPaths: readonly string[] = []): QualityWorkspaceInventory {
    const candidatePaths = this.workspaceInventoryPaths();
    for (const entry of this.snapshotOwnedPaths(declaredPaths).files) {
      if (entry.kind !== "directory") candidatePaths.add(entry.path);
    }
    const files = [...candidatePaths]
      .sort(compareStablePaths)
      .slice(0, QUALITY_MANIFEST_MAX_ENTRIES)
      .map((relativePath) => this.snapshotInventoryEntry(relativePath));
    if (candidatePaths.size > QUALITY_MANIFEST_MAX_ENTRIES) {
      files.push({ path: "[inventory-entry-limit]", kind: "unreadable", sha256: null });
    }
    return { files };
  }

  /** Persist a content-addressed immutable packet whose exact canonical body is reviewed. */
  persistReviewPacket(input: QualityReviewPacketInput): QualityReviewPacket {
    const declaredPaths = [...new Set(input.tasks.flatMap((task) => task.writePaths))]
      .map((writePath) => this.resolveOwnedPath(writePath).relativePath)
      .sort(compareStablePaths);
    const current = this.captureWorkspaceInventory(declaredPaths);
    const beforeByPath = new Map(input.baseline.files.map((entry) => [entry.path, entry] as const));
    const afterByPath = new Map(current.files.map((entry) => [entry.path, entry] as const));
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
    const packetFiles = packetPaths.map((relativePath) => {
      const before = beforeByPath.get(relativePath);
      const after = afterByPath.get(relativePath) ?? this.snapshotInventoryEntry(relativePath);
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
          packetError: "QUALITY_REVIEW_PACKET_LIMIT_EXCEEDED",
        }
      : body;
    const canonicalContent = stableJson(packetBody);
    const evidenceStatus = undeclaredPaths.length === 0
      && unsupportedPacketPaths.length === 0
      && inventoryUnsupportedEntries.length === 0
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
    try {
      writeFileSync(outputPath, persistedContent, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
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
    return {
      path: path.relative(this.workspaceRoot, outputPath),
      artifactHash,
      canonicalContent,
      evidenceStatus,
      changedPaths,
      undeclaredPaths,
      unsupportedEntries: [
        ...inventoryUnsupportedEntries,
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

  private workspaceInventoryPaths(): Set<string> {
    const paths = new Set<string>();
    try {
      const output = execFileSync(
        "git",
        ["-C", this.workspaceRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
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

  private snapshotInventoryEntry(relativePath: string): QualityWorkspaceEntry {
    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    if (!isContainedPath(this.workspaceRoot, absolutePath)) {
      return { path: relativePath, kind: "unreadable", sha256: null };
    }
    const entries = new Map<string, QualityWorkspaceEntry>();
    this.snapshotOwnedPath(absolutePath, relativePath, entries, { bytes: 0 }, 0);
    return entries.get(relativePath) ?? { path: relativePath, kind: "missing", sha256: null };
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
    writeFileSync(outputPath, stableJson({ ...body, artifactHash }), {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      path: path.relative(this.workspaceRoot, outputPath),
      artifactHash,
    };
  }
}
