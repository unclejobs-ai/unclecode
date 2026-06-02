import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SessionListItem = {
  readonly sessionId: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly taskSummary: string | null;
  readonly mode: string | null;
  readonly pendingAction: string | null;
};

const modulePath = fileURLToPath(import.meta.url);

function getSessionStoreRoot(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_SESSION_STORE_ROOT?.trim() || path.join(homedir(), ".unclecode", "state");
}

function findWorkspaceRoot(start: string): string | undefined {
  let cursor = path.resolve(start);
  while (true) {
    if (existsSync(path.join(cursor, "Cargo.toml")) && existsSync(path.join(cursor, "rust"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

function resolveExplicitRustCommand(explicit: string): string {
  if (path.isAbsolute(explicit)) {
    return explicit;
  }

  for (const start of [path.dirname(modulePath), process.cwd()]) {
    const root = findWorkspaceRoot(start);
    if (!root) {
      continue;
    }
    const candidate = path.resolve(root, explicit);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), explicit);
}

function findRustEntrypoint(): { command: string; argsPrefix: string[]; runCwd?: string } {
  const explicit = process.env.UNCLECODE_RUST_BIN;
  if (explicit) {
    return { command: resolveExplicitRustCommand(explicit), argsPrefix: [] };
  }

  for (const start of [path.dirname(modulePath), process.cwd()]) {
    let cursor = path.resolve(start);
    while (true) {
      for (const candidate of [
        path.join(cursor, "target", "release", "unclecode"),
        path.join(cursor, "target", "debug", "unclecode"),
      ]) {
        if (existsSync(candidate)) {
          return { command: candidate, argsPrefix: [] };
        }
      }
      if (existsSync(path.join(cursor, "Cargo.toml")) && existsSync(path.join(cursor, "rust"))) {
        return {
          command: "cargo",
          argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
          runCwd: cursor,
        };
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }

  return {
    command: "cargo",
    argsPrefix: ["run", "--quiet", "--bin", "unclecode", "--"],
    runCwd: process.cwd(),
  };
}

function getSessionPaths(input: { rootDir: string; projectPath: string; sessionId: string }) {
  const rust = findRustEntrypoint();
  const stdout = execFileSync(
    rust.command,
    [...rust.argsPrefix, "rust", "session", "paths", input.rootDir, input.projectPath, input.sessionId],
    {
      cwd: rust.runCwd ?? input.projectPath,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, UNCLECODE_WORK_CWD: input.projectPath },
      encoding: "utf8",
    },
  );
  const parsed = JSON.parse(stdout) as { sessionDir?: unknown; checkpointPath?: unknown };
  if (typeof parsed.sessionDir !== "string" || typeof parsed.checkpointPath !== "string") {
    throw new Error("Rust session paths returned invalid fast-session paths");
  }
  return { sessionDir: parsed.sessionDir, checkpointPath: parsed.checkpointPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readCheckpointFile(pathToFile: string): Promise<SessionListItem | null> {
  try {
    const raw = await readFile(pathToFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.sessionId !== "string" || typeof parsed.updatedAt !== "string") {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      state: typeof parsed.state === "string" ? parsed.state : "unknown",
      updatedAt: parsed.updatedAt,
      model:
        isRecord(parsed.metadata) && typeof parsed.metadata.model === "string"
          ? parsed.metadata.model
          : null,
      taskSummary:
        isRecord(parsed.taskSummary) && typeof parsed.taskSummary.summary === "string"
          ? parsed.taskSummary.summary
          : null,
      mode: parsed.mode === "coordinator" || parsed.mode === "normal" ? parsed.mode : null,
      pendingAction:
        isRecord(parsed.pendingAction) && typeof parsed.pendingAction.toolName === "string"
          ? parsed.pendingAction.toolName
          : null,
    };
  } catch {
    return null;
  }
}

export async function listFastSessions(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<readonly SessionListItem[]> {
  const probePaths = getSessionPaths({
    rootDir: getSessionStoreRoot(input.env),
    projectPath: input.workspaceRoot,
    sessionId: "session-list-probe",
  });

  try {
    const entries = await readdir(probePaths.sessionDir, { withFileTypes: true });
    const checkpoints = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".checkpoint.json"))
        .map((entry) => readCheckpointFile(path.join(probePaths.sessionDir, entry.name))),
    );

    return checkpoints
      .filter((item): item is SessionListItem => item !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function formatFastSessionsReport(items: readonly SessionListItem[]): string {
  if (items.length === 0) {
    return "No resumable sessions found.";
  }

  return [
    "Sessions",
    ...items.map((item) =>
      [
        `${item.sessionId}`,
        `state=${item.state}`,
        `model=${item.model ?? "none"}`,
        `mode=${item.mode ?? "none"}`,
        `pending=${item.pendingAction ?? "none"}`,
        `updated=${item.updatedAt}`,
        ...(item.taskSummary ? [`summary=${item.taskSummary}`] : []),
      ].join(" | "),
    ),
  ].join("\n");
}
