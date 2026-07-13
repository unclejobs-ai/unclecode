import { createHash } from "node:crypto";

import { createAgentOpsStore, redactAgentOpsSecrets } from "@unclecode/agentops-db";
import type { AgentOpsStore } from "@unclecode/agentops-db";

export interface AgentOpsRecorder {
  readonly healthy: boolean;
  readonly dbPath: string | undefined;
  recordTurn(input: {
    prompt: string;
    status: string;
    summary?: string;
    turnId?: string;
    contextReceiptId?: string;
    packetId?: string;
  }): void;
  finish(status: string): void;
}

export interface CreateAgentOpsRecorderInput {
  readonly workspaceRoot: string;
  readonly sessionId?: string | undefined;
  readonly command?: string | undefined;
  /** Override the agentops home dir — used by tests to point at a temp dir. */
  readonly home?: string | undefined;
}

function deriveProjectId(workspaceRoot: string): string {
  const hash = createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 20);
  return `project-${hash}`;
}

function coerceFinishStatus(
  status: string,
): "completed" | "failed" | "blocked" | "cancelled" {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled"
  ) {
    return status;
  }
  return status.toLowerCase().includes("fail") ||
    status.toLowerCase().includes("error")
    ? "failed"
    : "completed";
}

function createNoOpRecorder(dbPath: string | undefined): AgentOpsRecorder {
  return {
    healthy: false,
    dbPath,
    recordTurn() {
      /* no-op */
    },
    finish() {
      /* no-op */
    },
  };
}

export function createAgentOpsRecorder(
  input: CreateAgentOpsRecorderInput,
): AgentOpsRecorder {
  let store: AgentOpsStore | undefined;
  let runId: string | undefined;
  let projectId: string | undefined;
  let dbPath: string | undefined;

  try {
    store = createAgentOpsStore(
      input.home !== undefined ? { home: input.home } : {},
    );
    dbPath = store.paths.dbPath;

    projectId = deriveProjectId(input.workspaceRoot);

    const existing = store.getProject(projectId);
    if (existing === undefined) {
      store.addProject({
        id: projectId,
        name: input.workspaceRoot.split("/").pop() ?? input.workspaceRoot,
        repoPath: input.workspaceRoot,
      });
    }

    const run = store.startRun({
      projectId,
      workerKind: "work-shell",
      command: input.command ?? "unclecode work",
      cwd: input.workspaceRoot,
      ...(input.sessionId !== undefined ? { runKey: input.sessionId } : {}),
    });
    runId = run.id;

    store.addEvent({
      runId,
      projectId,
      eventType: "run.started",
      message: `Work shell session started in ${input.workspaceRoot}`,
    });
  } catch {
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        /* ignore */
      }
    }
    return createNoOpRecorder(dbPath);
  }

  return {
    healthy: true,
    dbPath,
    recordTurn({ prompt, status, summary, turnId, contextReceiptId, packetId }) {
      if (store === undefined || runId === undefined || projectId === undefined) {
        return;
      }
      try {
        const safePrompt = redactAgentOpsSecrets(prompt).slice(0, 200);
        store.addEvent({
          runId,
          projectId,
          eventType: "prompt.turn",
          message: safePrompt,
          metadataJson: JSON.stringify({
            status,
            ...(summary !== undefined ? { summary } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
            ...(contextReceiptId !== undefined ? { contextReceiptId } : {}),
            ...(packetId !== undefined ? { packetId } : {}),
          }),
        });
      } catch {
        /* non-blocking: never throw */
      }
    },
    finish(status) {
      if (store === undefined || runId === undefined) {
        return;
      }
      try {
        const finishStatus = coerceFinishStatus(status);
        store.finishRun({
          id: runId,
          status: finishStatus,
          exitCode: finishStatus === "completed" ? 0 : 1,
        });
      } catch {
        /* non-blocking: never throw */
      } finally {
        try {
          store.close();
        } catch {
          /* ignore */
        }
        store = undefined;
      }
    },
  };
}
