import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, normalize } from "node:path";

import type { SessionStoreOptions, SessionStorePaths, SessionStoreSessionRef } from "./types.js";

const PROJECTS_DIRNAME = "projects";
const SESSIONS_DIRNAME = "sessions";
const MEMORY_DIRNAME = "memory";
const PROJECT_MEMORY_DB_NAME = "project-memory.sqlite";
const RESEARCH_ARTIFACTS_DIRNAME = "research-artifacts";

function toOpaqueId(value: string, prefix: string): string {
  const normalizedValue = value.normalize("NFC");
  const digest = createHash("sha256").update(normalizedValue, "utf8").digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

function toProjectBucket(projectPath: string): string {
  let canonicalProjectPath = projectPath;

  try {
    canonicalProjectPath = realpathSync(projectPath);
  } catch {
    canonicalProjectPath = projectPath;
  }

  const normalizedProjectPath = normalize(canonicalProjectPath)
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .normalize("NFC");
  return toOpaqueId(normalizedProjectPath || "/", "project");
}

export function getProjectDir(rootDir: string, projectPath: string): string {
  return join(rootDir, PROJECTS_DIRNAME, toProjectBucket(projectPath));
}

export function getSessionPaths(
  options: SessionStoreOptions,
  ref: SessionStoreSessionRef,
): SessionStorePaths {
  const projectDir = getProjectDir(options.rootDir, ref.projectPath);
  const sessionDir = join(projectDir, SESSIONS_DIRNAME);
  const sessionFileId = toOpaqueId(ref.sessionId, "session");
  const researchArtifactsDir = join(projectDir, RESEARCH_ARTIFACTS_DIRNAME, sessionFileId);

  return {
    projectDir,
    sessionDir,
    eventLogPath: join(sessionDir, `${sessionFileId}.events.jsonl`),
    checkpointPath: join(sessionDir, `${sessionFileId}.checkpoint.json`),
    projectMemoryDir: join(projectDir, MEMORY_DIRNAME),
    projectMemoryDbPath: join(projectDir, MEMORY_DIRNAME, PROJECT_MEMORY_DB_NAME),
    researchArtifactsDir,
  };
}

export function getProjectMemoryPath(
  options: SessionStoreOptions,
  projectPath: string,
): string {
  return join(getProjectDir(options.rootDir, projectPath), MEMORY_DIRNAME, PROJECT_MEMORY_DB_NAME);
}
