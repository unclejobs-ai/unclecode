import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

export type BalancedPrewalkRoute = QualityProviderRoute & {
  readonly stage: QualityHarnessStage;
  readonly route: "frontier" | "commodity" | "direct" | "fallback";
  readonly executor: "direct" | "commodity" | "reviewer";
  readonly independent: boolean;
};

function routesMatch(left: QualityProviderRoute, right: QualityProviderRoute): boolean {
  return left.provider === right.provider && left.model === right.model;
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
    && !(input.producerRoutes ?? []).some((route) => routesMatch(route, selected));
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
};

export type QualityWorkspaceManifest = {
  readonly artifactHash: `sha256:${string}`;
  readonly files: readonly QualityWorkspaceEntry[];
};

export type QualityWorkspaceEntry = {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "special" | "missing" | "unreadable";
  readonly sha256: `sha256:${string}` | null;
};

export type ParsedCriticVerdict = {
  readonly verdict: "pass" | "fail" | "unproven";
  readonly summary: string;
  readonly findings: readonly GateFinding[];
};

const CRITIC_FINDING_KINDS = new Set(["implementation", "plan", "acceptance", "policy"]);
const CRITIC_FINDING_SEVERITIES = new Set(["low", "medium", "high", "critical"]);

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

function safeFilePart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "artifact";
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
    const files = this.snapshotOwnedPaths(writePaths);
    return {
      artifactHash: sha256(stableJson({ schemaVersion: 1, kind: "workspace-manifest", files })),
      files,
    };
  }

  persistNode(input: {
    readonly nodeId: string;
    readonly attempt: number;
    readonly producerId: string;
    readonly summary: string;
    readonly writePaths: readonly string[];
    readonly completedAt: string;
    readonly status?: "completed" | "failed" | "cancelled" | "blocked" | undefined;
  }): PersistedQualityArtifact {
    const files = this.snapshotOwnedPaths(input.writePaths);
    return this.persist(
      `${safeFilePart(input.nodeId)}-attempt-${input.attempt}.json`,
      {
        schemaVersion: 1,
        kind: "worker",
        runId: this.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        producerId: input.producerId,
        summary: input.summary.slice(0, 8_000),
        status: input.status ?? "completed",
        files,
        completedAt: input.completedAt,
      },
    );
  }

  private snapshotOwnedPaths(writePaths: readonly string[]): readonly QualityWorkspaceEntry[] {
    const entries = new Map<string, QualityWorkspaceEntry>();
    const roots = [...new Set(writePaths)]
      .map((writePath) => this.resolveOwnedPath(writePath))
      .sort((left, right) => compareStablePaths(left.relativePath, right.relativePath));
    for (const root of roots) {
      this.snapshotOwnedPath(root.absolutePath, root.relativePath, entries);
    }
    return [...entries.values()].sort((left, right) => compareStablePaths(left.path, right.path));
  }

  private resolveOwnedPath(writePath: string): { readonly absolutePath: string; readonly relativePath: string } {
    const absolutePath = path.resolve(this.workspaceRoot, writePath);
    if (!isContainedPath(this.workspaceRoot, absolutePath)) {
      throw new Error(`Owned path is outside the workspace: ${writePath}`);
    }
    this.assertExistingParentContained(absolutePath, writePath);
    return {
      absolutePath,
      relativePath: portableRelativePath(this.workspaceRoot, absolutePath),
    };
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
  ): void {
    if (isContainedPath(this.runDirectory, absolutePath)) return;
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
      try {
        entries.set(relativePath, {
          path: relativePath,
          kind: "file",
          sha256: sha256(readFileSync(absolutePath)),
        });
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
    let childNames: string[];
    try {
      childNames = readdirSync(absolutePath).sort(compareStablePaths);
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
      );
    }
  }

  persistRun(input: {
    readonly graphId: string;
    readonly producerId: string;
    readonly artifacts: readonly PersistedQualityArtifact[];
    readonly completedAt: string;
    readonly workspaceManifest?: QualityWorkspaceManifest | undefined;
  }): PersistedQualityArtifact {
    return this.persist("run.json", {
      schemaVersion: 1,
      kind: "run",
      runId: this.runId,
      graphId: input.graphId,
      producerId: input.producerId,
      artifacts: input.artifacts,
      ...(input.workspaceManifest ? { workspaceManifest: input.workspaceManifest } : {}),
      completedAt: input.completedAt,
    });
  }

  persistCritic(input: {
    readonly reviewerId: string;
    readonly reviewedArtifactHash: string;
    readonly summary: string;
    readonly independent: boolean;
    readonly completedAt: string;
  }): PersistedQualityArtifact {
    return this.persist("critic.json", {
      schemaVersion: 1,
      kind: "critic",
      runId: this.runId,
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
