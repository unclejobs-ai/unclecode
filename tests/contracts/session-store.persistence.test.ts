import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SESSION_STATES } from "@unclecode/contracts";
import * as sessionStoreModule from "@unclecode/session-store";

type SessionRef = {
  readonly projectPath: string;
  readonly sessionId: string;
};

type SessionStoreRecord = {
  readonly kind: "engine_event" | "checkpoint";
  readonly sessionId: string;
  readonly timestamp: string;
  readonly event?: {
    readonly type: string;
    readonly description?: string;
    readonly state?: string;
  };
  readonly checkpoint?: {
    readonly type: string;
    readonly summary?: string;
    readonly metadata?: {
      readonly taskSummary?: string | null;
    };
  };
};

type SessionCheckpointSnapshot = {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly eventCount: number;
  readonly state: string;
  readonly metadata: {
    readonly taskSummary?: string | null;
  };
  readonly forkedFromSessionId?: string;
};

type SessionResumeResult = {
  readonly sessionId: string;
  readonly records: readonly SessionStoreRecord[];
  readonly checkpoint: SessionCheckpointSnapshot | null;
  readonly state: string;
  readonly metadata: {
    readonly taskSummary?: string | null;
  };
  readonly pendingAction?: {
    readonly toolName: string;
    readonly actionDescription: string;
    readonly toolUseId: string;
    readonly requestId: string;
  };
  readonly forkedFromSessionId?: string;
};

type ProjectMemoryRecord = {
  readonly memoryId: string;
  readonly content: string;
};

type SessionStore = {
  appendEvent(ref: SessionRef, event: Record<string, unknown>): Promise<void>;
  appendCheckpoint(
    ref: SessionRef,
    checkpoint: Record<string, unknown>,
  ): Promise<void>;
  resumeSession(ref: SessionRef): Promise<SessionResumeResult>;
  forkSession(options: {
    readonly projectPath: string;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
  }): Promise<void>;
  writeProjectMemory(entry: {
    readonly projectPath: string;
    readonly memoryId: string;
    readonly content: string;
  }): Promise<void>;
  listProjectMemories(
    projectPath: string,
  ): Promise<readonly ProjectMemoryRecord[]>;
  getSessionPaths(ref: SessionRef): {
    readonly eventLogPath: string;
    readonly checkpointPath: string;
    readonly projectMemoryDir: string;
    readonly projectMemoryDbPath: string;
    readonly researchArtifactsDir: string;
  };
};

type SessionStoreModule = {
  readonly createSessionStore?: (options: {
    readonly rootDir: string;
  }) => SessionStore;
  readonly getSessionStoreRoot?: (env?: NodeJS.ProcessEnv) => string;
};

const SECRET = "ghp_123456789012345678901234567890123456";

function getStore(rootDir: string): SessionStore {
  const moduleView: SessionStoreModule = sessionStoreModule;
  const factory = moduleView.createSessionStore;
  assert.equal(typeof factory, "function");
  if (!factory) {
    throw new Error("createSessionStore is unavailable");
  }
  return factory({ rootDir });
}

async function createRootDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "unclecode-session-store-"));
}

test("session-store exports the canonical session-store root helper", () => {
  const moduleView: SessionStoreModule = sessionStoreModule;
  assert.equal(typeof moduleView.getSessionStoreRoot, "function");
  assert.equal(
    moduleView.getSessionStoreRoot?.({
      UNCLECODE_SESSION_STORE_ROOT: "/tmp/custom-root",
    } as NodeJS.ProcessEnv),
    "/tmp/custom-root",
  );
});

test("session-store resumes append-only event logs without a checkpoint", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const ref = {
      projectPath: "/workspace/alpha",
      sessionId: "session-alpha",
    } satisfies SessionRef;

    await store.appendEvent(ref, {
      type: "task.started",
      taskId: "task-1",
      description: "Boot the task",
    });
    await store.appendEvent(ref, {
      type: "session.state_changed",
      state: "running",
    });

    const resumed = await store.resumeSession(ref);
    const paths = store.getSessionPaths(ref);
    const eventLog = await readFile(paths.eventLogPath, "utf8");

    assert.equal(resumed.records.length, 2);
    assert.equal(resumed.records[0]?.kind, "engine_event");
    assert.equal(resumed.records[1]?.event?.type, "session.state_changed");
    assert.equal(resumed.state, "running");
    assert.equal(eventLog.trim().split("\n").length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store writes resumable checkpoints and replays newer records on resume", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const ref = {
      projectPath: "/workspace/beta",
      sessionId: "session-beta",
    } satisfies SessionRef;

    await store.appendEvent(ref, {
      type: "task.started",
      taskId: "task-2",
      description: "Prepare checkpoint",
    });
    await store.appendCheckpoint(ref, {
      type: "state",
      state: "running",
    });
    await store.appendEvent(ref, {
      type: "session.state_changed",
      state: "requires_action",
      details: {
        toolName: "bash",
        actionDescription: "Need approval",
        toolUseId: "tool-2",
        requestId: "request-2",
      },
    });

    const resumed = await store.resumeSession(ref);
    const checkpointOnDisk = JSON.parse(
      await readFile(store.getSessionPaths(ref).checkpointPath, "utf8"),
    ) as SessionCheckpointSnapshot;

    assert.equal(checkpointOnDisk.eventCount, 2);
    assert.equal(checkpointOnDisk.state, "running");
    assert.equal(resumed.checkpoint?.eventCount, 2);
    assert.equal(resumed.state, "requires_action");
    assert.equal(resumed.records.at(-1)?.event?.type, "session.state_changed");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store forks a session into an independent resumable branch", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const sourceRef = {
      projectPath: "/workspace/gamma",
      sessionId: "session-source",
    } satisfies SessionRef;
    const forkRef = {
      projectPath: "/workspace/gamma",
      sessionId: "session-fork",
    } satisfies SessionRef;

    await store.appendEvent(sourceRef, {
      type: "task.started",
      taskId: "task-3",
      description: "Seed the source session",
    });
    await store.appendCheckpoint(sourceRef, {
      type: "metadata",
      metadata: {
        taskSummary: "Source branch work",
      },
    });

    await store.forkSession({
      projectPath: sourceRef.projectPath,
      sourceSessionId: sourceRef.sessionId,
      targetSessionId: forkRef.sessionId,
    });
    await store.appendEvent(forkRef, {
      type: "task.progress",
      taskId: "task-3",
      description: "Fork-specific progress",
      usage: {
        totalTokens: 10,
        toolUses: 1,
        durationMs: 50,
      },
    });

    const source = await store.resumeSession(sourceRef);
    const fork = await store.resumeSession(forkRef);

    assert.equal(source.records.length, 2);
    assert.equal(fork.records.length, 3);
    assert.equal(fork.forkedFromSessionId, sourceRef.sessionId);
    assert.equal(fork.checkpoint?.forkedFromSessionId, sourceRef.sessionId);
    assert.equal(source.records[0]?.event?.type, "task.started");
    assert.equal(fork.records.at(-1)?.event?.type, "task.progress");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store redacts secrets before writing events checkpoints and memory to disk", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const ref = {
      projectPath: "/workspace/delta",
      sessionId: "session-delta",
    } satisfies SessionRef;

    await store.appendEvent(ref, {
      type: "task.started",
      taskId: "task-4",
      description: `Persist ${SECRET}`,
    });
    await store.appendCheckpoint(ref, {
      type: "metadata",
      metadata: {
        taskSummary: `Checkpoint ${SECRET}`,
      },
    });
    await store.writeProjectMemory({
      projectPath: ref.projectPath,
      memoryId: "note-1",
      content: `Remember ${SECRET}`,
    });

    const paths = store.getSessionPaths(ref);
    const eventLog = await readFile(paths.eventLogPath, "utf8");
    const checkpoint = await readFile(paths.checkpointPath, "utf8");
    const memoryFile = await readFile(paths.projectMemoryDbPath);
    const projectMemoryEntries = await readdir(paths.projectMemoryDir);
    const resumed = await store.resumeSession(ref);

    assert.doesNotMatch(eventLog, new RegExp(SECRET));
    assert.doesNotMatch(checkpoint, new RegExp(SECRET));
    assert.doesNotMatch(memoryFile.toString("utf8"), new RegExp(SECRET));
    assert.match(eventLog, /\[REDACTED\]/);
    assert.match(checkpoint, /\[REDACTED\]/);
    assert.equal(
      memoryFile.subarray(0, 15).toString("utf8"),
      "SQLite format 3",
    );
    assert.deepEqual(projectMemoryEntries, ["project-memory.sqlite"]);
    assert.equal(resumed.metadata.taskSummary, "Checkpoint [REDACTED]");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store clears stale pendingAction when replay sees a later state change without details", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const ref = {
      projectPath: "/workspace/eta",
      sessionId: "session-eta",
    } satisfies SessionRef;

    await store.appendEvent(ref, {
      type: "session.state_changed",
      state: "requires_action",
      details: {
        toolName: "bash",
        actionDescription: "Approve this",
        toolUseId: "tool-eta",
        requestId: "request-eta",
      },
    });
    await store.appendEvent(ref, {
      type: "session.state_changed",
      state: "running",
    });

    const resumed = await store.resumeSession(ref);

    assert.equal(resumed.state, "running");
    assert.equal(resumed.pendingAction, undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store uses non-sensitive persistence paths and exposes a research artifacts directory", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const ref = {
      projectPath: `/workspace/${SECRET}`,
      sessionId: SECRET,
    } satisfies SessionRef;

    const paths = store.getSessionPaths(ref);

    await store.appendEvent(ref, {
      type: "task.started",
      taskId: "task-paths",
      description: "Create path scaffolding",
    });

    assert.doesNotMatch(paths.eventLogPath, new RegExp(SECRET));
    assert.doesNotMatch(paths.checkpointPath, new RegExp(SECRET));
    assert.doesNotMatch(paths.projectMemoryDbPath, new RegExp(SECRET));
    assert.doesNotMatch(paths.researchArtifactsDir, new RegExp(SECRET));
    assert.match(paths.researchArtifactsDir, /research-artifacts/);
    assert.deepEqual(await readdir(paths.researchArtifactsDir), []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store keeps project memory isolated per project path", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);

    await store.writeProjectMemory({
      projectPath: "/workspace/epsilon-a",
      memoryId: "shared-id",
      content: "alpha memory",
    });
    await store.writeProjectMemory({
      projectPath: "/workspace/epsilon-b",
      memoryId: "shared-id",
      content: "beta memory",
    });

    const projectAMemory = await store.listProjectMemories(
      "/workspace/epsilon-a",
    );
    const projectBMemory = await store.listProjectMemories(
      "/workspace/epsilon-b",
    );

    assert.deepEqual(projectAMemory, [
      {
        memoryId: "shared-id",
        content: "alpha memory",
      },
    ]);
    assert.deepEqual(projectBMemory, [
      {
        memoryId: "shared-id",
        content: "beta memory",
      },
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store can replay from the canonical log when the checkpoint file is missing", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const ref = {
      projectPath: "/workspace/zeta",
      sessionId: "session-zeta",
    } satisfies SessionRef;

    await store.appendEvent(ref, {
      type: "task.started",
      taskId: "task-5",
      description: "Replay from log",
    });
    await store.appendCheckpoint(ref, {
      type: "state",
      state: SESSION_STATES[1],
    });
    await store.appendCheckpoint(ref, {
      type: "metadata",
      metadata: {
        taskSummary: "Still recoverable",
      },
    });

    await unlink(store.getSessionPaths(ref).checkpointPath);

    const resumed = await store.resumeSession(ref);

    assert.equal(resumed.checkpoint, null);
    assert.equal(resumed.records.length, 3);
    assert.equal(resumed.state, SESSION_STATES[1]);
    assert.equal(resumed.metadata.taskSummary, "Still recoverable");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("session-store recovers the valid JSONL prefix when trailing lines are malformed", async () => {
  const rootDir = await createRootDir();
  try {
    const store = getStore(rootDir);
    const ref = {
      projectPath: "/workspace/theta",
      sessionId: "session-theta",
    } satisfies SessionRef;

    await store.appendEvent(ref, {
      type: "task.started",
      taskId: "task-theta",
      description: "First valid line",
    });
    await store.appendEvent(ref, {
      type: "task.progress",
      taskId: "task-theta",
      description: "Second valid line",
      usage: {
        totalTokens: 3,
        toolUses: 1,
        durationMs: 10,
      },
    });
    await appendFile(
      store.getSessionPaths(ref).eventLogPath,
      '{"kind":"engine_event",bad-json\n',
      "utf8",
    );

    const resumed = await store.resumeSession(ref);

    assert.equal(resumed.records.length, 2);
    assert.equal(resumed.records[0]?.event?.type, "task.started");
    assert.equal(resumed.records[1]?.event?.type, "task.progress");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
