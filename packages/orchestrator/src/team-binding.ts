/**
 * TeamBinding — uniform publish/subscribe surface over the team-run-store cold
 * NDJSON log. Same interface for coordinator (Layer A) and worker (Layer B).
 *
 * Env propagation: workers join a run via UNCLECODE_TEAM_RUN_ID +
 * UNCLECODE_TEAM_RUN_ROOT; nothing else needs to be wired.
 *
 * Cite helpers (readCode, cite, verifyCitation) anchor SSOT claims to git
 * working tree content + checkpoint indices so multi-agent claims stay
 * grounded (§5.6).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Citation, SsotCategory, VersionedRef } from "@unclecode/contracts";
import {
  appendTeamCheckpoint,
  type AppendableTeamCheckpoint,
  getRunStatusFromCheckpoints,
  getTeamRunRoot,
  readTeamCheckpoints,
  readTeamRunManifest,
  type TeamCheckpoint,
} from "@unclecode/session-store";

export const RUN_ID_ENV = "UNCLECODE_TEAM_RUN_ID";
export const RUN_ROOT_ENV = "UNCLECODE_TEAM_RUN_ROOT";

export type TeamRole = "coordinator" | "worker" | "reviewer" | "observer";

export type TeamBindingArgs = {
  readonly runId: string;
  readonly runRoot: string;
  readonly role: TeamRole;
  readonly workspaceRoot: string;
};

export class TeamBinding {
  readonly runId: string;
  readonly runRoot: string;
  readonly role: TeamRole;
  readonly workspaceRoot: string;

  constructor(args: TeamBindingArgs) {
    this.runId = args.runId;
    this.runRoot = args.runRoot;
    this.role = args.role;
    this.workspaceRoot = args.workspaceRoot;
  }

  publish(checkpoint: AppendableTeamCheckpoint): TeamCheckpoint {
    return appendTeamCheckpoint(this.runRoot, checkpoint);
  }

  readCheckpoints(): ReadonlyArray<TeamCheckpoint> {
    return readTeamCheckpoints(this.runRoot);
  }

  manifest() {
    return readTeamRunManifest(this.runRoot);
  }

  status() {
    return getRunStatusFromCheckpoints(this.readCheckpoints());
  }

  envForChild(): Readonly<Record<string, string>> {
    return {
      [RUN_ID_ENV]: this.runId,
      [RUN_ROOT_ENV]: this.runRoot,
    };
  }

  readCode(relativePath: string): { content: string; sha256: string; mtime: number } {
    const absPath = relativePath.startsWith("/")
      ? relativePath
      : join(this.workspaceRoot, relativePath);
    if (!existsSync(absPath)) {
      throw new Error(`readCode: path does not exist: ${absPath}`);
    }
    const content = readFileSync(absPath, "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const mtime = statSync(absPath).mtimeMs;
    return { content, sha256, mtime };
  }

  cite(category: SsotCategory, key: string): VersionedRef {
    let versionHash = "";
    switch (category) {
      case "code":
        try {
          versionHash = this.readCode(key).sha256;
        } catch {
          versionHash = "";
        }
        break;
      case "checkpoint": {
        const checkpoints = this.readCheckpoints();
        const index = Number.parseInt(key, 10);
        const entry = checkpoints[index];
        if (entry && (entry as { lineHash?: string }).lineHash) {
          versionHash = (entry as { lineHash: string }).lineHash;
        }
        break;
      }
      case "worker_message":
      case "context_packet":
      case "review":
      case "credential":
      case "policy_decision":
      case "workspace_guidance":
      case "session_metadata":
      case "mmbridge_session":
      case "memory_observation":
      case "external_doc":
        throw new Error(
          `Not implemented: TeamBinding.cite for category="${category}". Caller must produce versionHash directly via the canonical owner store.`,
        );
      default: {
        const exhaustive: never = category;
        throw new Error(`Unhandled SsotCategory: ${exhaustive as string}`);
      }
    }
    return {
      category,
      key,
      versionHash,
      retrievedAt: Date.now(),
    };
  }

  verifyCitation(ref: VersionedRef): boolean {
    if (ref.versionHash.length === 0) {
      return false;
    }
    if (ref.category === "code") {
      try {
        return this.readCode(ref.key).sha256 === ref.versionHash;
      } catch {
        return false;
      }
    }
    if (ref.category === "checkpoint") {
      const checkpoints = this.readCheckpoints();
      const index = Number.parseInt(ref.key, 10);
      const entry = checkpoints[index] as { lineHash?: string } | undefined;
      return entry?.lineHash === ref.versionHash;
    }
    return false;
  }

  attachCitation(claim: string, refs: ReadonlyArray<VersionedRef>): {
    readonly claim: string;
    readonly citations: ReadonlyArray<Citation>;
  } {
    return {
      claim,
      citations: refs.map((ref) => ({ ...ref })),
    };
  }
}

export function bindToRun(args: TeamBindingArgs): TeamBinding {
  return new TeamBinding(args);
}

export function readBindingFromEnv(env: NodeJS.ProcessEnv = process.env): TeamBindingArgs | undefined {
  const runId = env[RUN_ID_ENV];
  const runRoot = env[RUN_ROOT_ENV];
  if (!runId || !runRoot) {
    return undefined;
  }
  return {
    runId,
    runRoot,
    role: "worker",
    workspaceRoot: env.PWD ?? process.cwd(),
  };
}

export function resolveRunRoot(dataRoot: string, runId: string): string {
  return getTeamRunRoot(dataRoot, runId);
}
