import { createSessionStore, getSessionStoreRoot } from "@unclecode/session-store";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function listSessionLines(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(env) });
  const probePaths = sessionStore.getSessionPaths({
    projectPath: workspaceRoot,
    sessionId: "work-shell-session-list-probe",
  });

  try {
    const entries = await readdir(probePaths.sessionDir, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".checkpoint.json"),
        )
        .map(async (entry) => {
          const raw = await readFile(
            path.join(probePaths.sessionDir, entry.name),
            "utf8",
          );
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.sessionId !== "string") {
            return null;
          }
          const summary =
            parsed.taskSummary &&
            typeof parsed.taskSummary === "object" &&
            typeof (parsed.taskSummary as Record<string, unknown>).summary ===
              "string"
              ? String(
                  (parsed.taskSummary as Record<string, unknown>).summary,
                )
              : "no summary";
          return {
            sessionId: parsed.sessionId,
            updatedAt:
              typeof parsed.updatedAt === "string"
                ? parsed.updatedAt
                : "unknown",
            state: typeof parsed.state === "string" ? parsed.state : "unknown",
            summary,
          };
        }),
    );

    const visible = sessions
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 6);

    if (visible.length === 0) {
      return ["No resumable sessions.", "Run work, doctor, or research to create one."];
    }

    return visible.map(
      (session, index) =>
        `${index + 1}. ${session.sessionId} · ${session.state} · ${session.summary}`,
    );
  } catch {
    return ["No resumable sessions.", "Run work, doctor, or research to create one."];
  }
}

export async function persistWorkShellSessionSnapshot(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId: string;
  readonly model: string;
  readonly mode: string;
  readonly state: "running" | "idle" | "requires_action";
  readonly summary: string;
  readonly traceMode?: "minimal" | "verbose" | undefined;
}): Promise<void> {
  const sessionStore = createSessionStore({
    rootDir: getSessionStoreRoot(input.env),
  });
  const ref = {
    projectPath: input.cwd,
    sessionId: input.sessionId,
  } as const;

  await sessionStore.appendCheckpoint(ref, { type: "state", state: input.state });
  await sessionStore.appendCheckpoint(ref, {
    type: "metadata",
    metadata: {
      model: input.model,
      taskSummary: input.summary,
      isUltraworkMode: input.mode === "ultrawork",
      ...(input.traceMode ? { traceMode: input.traceMode } : {}),
    },
  });
  await sessionStore.appendCheckpoint(ref, {
    type: "task_summary",
    summary: input.summary,
    timestamp: new Date().toISOString(),
  });
  await sessionStore.appendCheckpoint(ref, { type: "mode", mode: "normal" });
}
