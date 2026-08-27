import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  ProviderId,
  QualityHarnessStage,
} from "@unclecode/contracts";

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

export class QualityArtifactStore {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly runDirectory: string;

  constructor(workspaceRoot: string, runId: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.runId = safeFilePart(runId);
    this.runDirectory = path.join(
      this.workspaceRoot,
      ".unclecode",
      "artifacts",
      this.runId,
    );
  }

  persistNode(input: {
    readonly nodeId: string;
    readonly attempt: number;
    readonly producerId: string;
    readonly summary: string;
    readonly writePaths: readonly string[];
    readonly completedAt: string;
  }): PersistedQualityArtifact {
    const files = input.writePaths.flatMap((relativePath) => {
      const absolutePath = path.resolve(this.workspaceRoot, relativePath);
      const relative = path.relative(this.workspaceRoot, absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(absolutePath)) {
        return [];
      }
      try {
        if (!statSync(absolutePath).isFile()) return [];
        return [{ path: relative, sha256: sha256(readFileSync(absolutePath)) }];
      } catch {
        return [];
      }
    });
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
        files,
        completedAt: input.completedAt,
      },
    );
  }

  persistRun(input: {
    readonly graphId: string;
    readonly producerId: string;
    readonly artifacts: readonly PersistedQualityArtifact[];
    readonly completedAt: string;
  }): PersistedQualityArtifact {
    return this.persist("run.json", {
      schemaVersion: 1,
      kind: "run",
      runId: this.runId,
      graphId: input.graphId,
      producerId: input.producerId,
      artifacts: input.artifacts,
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
