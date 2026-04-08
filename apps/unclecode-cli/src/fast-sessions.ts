import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type SessionListItem = {
  readonly sessionId: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly taskSummary: string | null;
  readonly mode: string | null;
  readonly pendingAction: string | null;
};

function getSessionStoreRoot(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_SESSION_STORE_ROOT?.trim() || path.join(homedir(), ".unclecode", "state");
}

function toOpaqueId(value: string, prefix: string): string {
  const normalizedValue = value.normalize("NFC");
  const digest = createHash("sha256").update(normalizedValue, "utf8").digest("hex").slice(0, 20);
  return `${prefix}-${digest}`;
}

function getProjectDir(rootDir: string, projectPath: string): string {
  let canonicalProjectPath = projectPath;

  try {
    canonicalProjectPath = realpathSync(projectPath);
  } catch {
    canonicalProjectPath = projectPath;
  }

  const normalizedProjectPath = path
    .normalize(canonicalProjectPath)
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .normalize("NFC");
  return path.join(rootDir, "projects", toOpaqueId(normalizedProjectPath || "/", "project"));
}

function getSessionPaths(input: { rootDir: string; projectPath: string; sessionId: string }) {
  const projectDir = getProjectDir(input.rootDir, input.projectPath);
  const sessionDir = path.join(projectDir, "sessions");
  const sessionFileId = toOpaqueId(input.sessionId, "session");

  return {
    sessionDir,
    checkpointPath: path.join(sessionDir, `${sessionFileId}.checkpoint.json`),
  };
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
