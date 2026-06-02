import type { SkillMetadata } from "@unclecode/contracts";
import os from "node:os";
import path from "node:path";

import { runRustCommandSync } from "./rust-command.js";

export type WorkspaceSkillItem = {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  readonly summary: string;
};

export type LoadedWorkspaceSkill = {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly attempts: readonly {
    path: string;
    ok: boolean;
    error?: string | undefined;
  }[];
};

export type WorkspaceSkillMetadata = SkillMetadata & {
  readonly path: string;
  readonly scope: "project" | "user";
};

const HOME_DIR = os.homedir();
const skillMetadataCache = new Map<string, readonly WorkspaceSkillMetadata[]>();

function getSkillCacheKey(cwd: string, homeDir: string): string {
  return `${path.resolve(cwd)}::${path.resolve(homeDir)}`;
}

export function clearWorkspaceSkillCache(cwd?: string, homeDir = HOME_DIR): void {
  if (!cwd) {
    skillMetadataCache.clear();
    return;
  }

  skillMetadataCache.delete(getSkillCacheKey(cwd, homeDir));
}

export async function discoverSkillMetadata(
  cwd: string,
  homeDir = HOME_DIR,
): Promise<readonly WorkspaceSkillMetadata[]> {
  const cacheKey = getSkillCacheKey(cwd, homeDir);
  const cached = skillMetadataCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "skills", "metadata", cwd, homeDir], cwd),
  ) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isWorkspaceSkillMetadata)) {
    throw new Error("Rust workspace skill metadata command returned an invalid payload.");
  }

  skillMetadataCache.set(cacheKey, parsed);
  return parsed;
}

export async function listAvailableSkills(
  cwd: string,
  homeDir = HOME_DIR,
): Promise<readonly WorkspaceSkillItem[]> {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "skills", "list", cwd, homeDir], cwd),
  ) as unknown;

  if (!Array.isArray(parsed) || !parsed.every(isWorkspaceSkillItem)) {
    throw new Error("Rust workspace skill list command returned an invalid payload.");
  }

  return parsed;
}

export async function loadNamedSkill(
  name: string,
  cwd: string,
  homeDir = HOME_DIR,
): Promise<LoadedWorkspaceSkill> {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "skill-load", name, cwd, homeDir], cwd),
  ) as unknown;

  if (!isLoadedWorkspaceSkill(parsed)) {
    throw new Error("Rust workspace skill load command returned an invalid payload.");
  }

  return parsed;
}

function isWorkspaceSkillMetadata(value: unknown): value is WorkspaceSkillMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    name?: unknown;
    description?: unknown;
    source?: unknown;
    commandType?: unknown;
    paths?: unknown;
    path?: unknown;
    scope?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    candidate.source === "skills" &&
    candidate.commandType === "prompt" &&
    Array.isArray(candidate.paths) &&
    candidate.paths.every((entry) => typeof entry === "string") &&
    typeof candidate.path === "string" &&
    isWorkspaceSkillScope(candidate.scope)
  );
}

function isWorkspaceSkillItem(value: unknown): value is WorkspaceSkillItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    name?: unknown;
    path?: unknown;
    scope?: unknown;
    summary?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    typeof candidate.path === "string" &&
    isWorkspaceSkillScope(candidate.scope) &&
    typeof candidate.summary === "string"
  );
}

function isLoadedWorkspaceSkill(value: unknown): value is LoadedWorkspaceSkill {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    name?: unknown;
    path?: unknown;
    content?: unknown;
    attempts?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.content === "string" &&
    Array.isArray(candidate.attempts) &&
    candidate.attempts.every(isLoadAttempt)
  );
}

function isLoadAttempt(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { path?: unknown; ok?: unknown; error?: unknown };

  return (
    typeof candidate.path === "string" &&
    typeof candidate.ok === "boolean" &&
    (candidate.error === undefined || typeof candidate.error === "string")
  );
}

function isWorkspaceSkillScope(value: unknown): value is "project" | "user" {
  return value === "project" || value === "user";
}
