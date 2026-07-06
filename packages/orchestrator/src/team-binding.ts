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

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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

import { runRustCommandSync } from "./rust-command.js";

export const RUN_ID_ENV = "UNCLECODE_TEAM_RUN_ID";
export const RUN_ROOT_ENV = "UNCLECODE_TEAM_RUN_ROOT";

export type TeamRole = "coordinator" | "worker" | "reviewer" | "observer";

export type TeamBindingArgs = {
  readonly runId: string;
  readonly runRoot: string;
  readonly role: TeamRole;
  readonly workspaceRoot: string;
};

export type CitationVerificationStatus = "valid" | "stale" | "missing" | "unsupported";

export type CitationVerificationDetail = {
  readonly ref: VersionedRef;
  readonly status: CitationVerificationStatus;
  readonly summary: string;
  readonly expectedHash?: string;
  readonly actualHash?: string;
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
    const absPath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    if (!existsSync(absPath)) {
      throw new Error(`readCode: path does not exist: ${absPath}`);
    }
    const content = readFileSync(absPath, "utf8");
    const sha256 = runRustCommandSync(["rust", "sha256"], this.workspaceRoot, content).trim();
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
        const index = parseCheckpointIndex(key);
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
    return this.verifyCitationDetail(ref).status === "valid";
  }

  verifyCitationDetail(ref: VersionedRef): CitationVerificationDetail {
    if (ref.category === "code") {
      try {
        const actualHash = this.readCode(ref.key).sha256;
        if (actualHash === ref.versionHash && ref.versionHash.length > 0) {
          return {
            ref,
            status: "valid",
            summary: `valid code citation: ${ref.key}`,
            expectedHash: ref.versionHash,
            actualHash,
          };
        }
        return {
          ref,
          status: "stale",
          summary: `stale code citation: ${ref.key}`,
          expectedHash: ref.versionHash,
          actualHash,
        };
      } catch {
        return {
          ref,
          status: "missing",
          summary: `missing code citation target: ${ref.key}`,
          expectedHash: ref.versionHash,
        };
      }
    }
    if (ref.category === "checkpoint") {
      const checkpoints = this.readCheckpoints();
      const index = parseCheckpointIndex(ref.key);
      const entry = checkpoints[index] as { lineHash?: string } | undefined;
      const actualHash = entry?.lineHash;
      if (!actualHash) {
        return {
          ref,
          status: "missing",
          summary: `missing checkpoint citation target: ${ref.key}`,
          expectedHash: ref.versionHash,
        };
      }
      if (actualHash === ref.versionHash && ref.versionHash.length > 0) {
        return {
          ref,
          status: "valid",
          summary: `valid checkpoint citation: ${ref.key}`,
          expectedHash: ref.versionHash,
          actualHash,
        };
      }
      return {
        ref,
        status: "stale",
        summary: `stale checkpoint citation: ${ref.key}`,
        expectedHash: ref.versionHash,
        actualHash,
      };
    }
    return {
      ref,
      status: "unsupported",
      summary: `unsupported citation category: ${ref.category}`,
      expectedHash: ref.versionHash,
    };
  }

  attachCitation(claim: string, refs: ReadonlyArray<VersionedRef>): {
    readonly claim: string;
    readonly citations: ReadonlyArray<Citation>;
  } {
    const invalid = refs.map((ref) => this.verifyCitationDetail(ref)).find((detail) => detail.status !== "valid");
    if (invalid) {
      throw new Error(`Cannot attach invalid citation: ${invalid.summary}`);
    }
    return {
      claim,
      citations: refs.map((ref) => ({ ...ref })),
    };
  }
}

function parseCheckpointIndex(key: string): number {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return -1;
  }
  return Number.isSafeInteger(Number(key)) ? Number(key) : -1;
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

function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  if (isAbsolute(requestedPath)) {
    throw new Error(`readCode: absolute paths are not allowed: ${requestedPath}`);
  }
  const root = resolve(workspaceRoot);
  const absPath = resolve(root, requestedPath);
  const rel = relative(root, absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`readCode: path escapes working directory: ${requestedPath}`);
  }
  const realRoot = realpathSync(root);
  const realPath = realpathSync(absPath);
  const realRel = relative(realRoot, realPath);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`readCode: path escapes working directory: ${requestedPath}`);
  }
  return absPath;
}
