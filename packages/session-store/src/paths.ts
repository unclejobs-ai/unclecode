import { join } from "node:path";

import { runRustCommandSync } from "./rust-command.js";
import type { SessionStoreOptions, SessionStorePaths, SessionStoreSessionRef } from "./types.js";

const MEMORY_DIRNAME = "memory";
const PROJECT_MEMORY_DB_NAME = "project-memory.sqlite";
const PROJECT_DIR_PROBE_SESSION_ID = "project-dir-probe";

function readRustSessionPaths(
  options: SessionStoreOptions,
  ref: SessionStoreSessionRef,
): SessionStorePaths {
  const stdout = runRustCommandSync(
    ["rust", "session", "paths", options.rootDir, ref.projectPath, ref.sessionId],
    ref.projectPath,
  );
  const parsed = JSON.parse(stdout) as Partial<Record<keyof SessionStorePaths, unknown>>;
  const paths = {
    projectDir: parsed.projectDir,
    sessionDir: parsed.sessionDir,
    eventLogPath: parsed.eventLogPath,
    checkpointPath: parsed.checkpointPath,
    projectMemoryDir: parsed.projectMemoryDir,
    projectMemoryDbPath: parsed.projectMemoryDbPath,
    researchArtifactsDir: parsed.researchArtifactsDir,
  };
  for (const [key, value] of Object.entries(paths)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Rust session paths returned invalid ${key}`);
    }
  }
  return paths as SessionStorePaths;
}

export function getProjectDir(rootDir: string, projectPath: string): string {
  return readRustSessionPaths(
    { rootDir },
    { projectPath, sessionId: PROJECT_DIR_PROBE_SESSION_ID },
  ).projectDir;
}

export function getSessionPaths(
  options: SessionStoreOptions,
  ref: SessionStoreSessionRef,
): SessionStorePaths {
  return readRustSessionPaths(options, ref);
}

export function getProjectMemoryPath(
  options: SessionStoreOptions,
  projectPath: string,
): string {
  return join(getProjectDir(options.rootDir, projectPath), MEMORY_DIRNAME, PROJECT_MEMORY_DB_NAME);
}
