import { createSessionStore, getSessionStoreRoot } from "@unclecode/session-store";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryLineageRecord } from "@unclecode/contracts";

import { parseScopedMemoryId, formatScopedMemoryTransparencyLines, type ScopedMemoryEntry } from "./memory-transparency.js";

export type MemoryScope = "session" | "project" | "user" | "agent";

export type MemoryLineageAdapter = {
  record(input: Omit<MemoryLineageRecord, "createdAt">): MemoryLineageRecord;
  invalidate(memoryId: string): MemoryLineageRecord;
  rollbackPromotion(memoryId: string): void;
  expire(): number;
  get(memoryId: string): MemoryLineageRecord | undefined;
  isActive(memoryId: string): boolean;
};

type JsonlMemoryRecord = {
  readonly memoryId: string;
  readonly scope: Exclude<MemoryScope, "project">;
  readonly summary: string;
  readonly timestamp: string;
};

type JsonlMemoryTombstone = {
  readonly memoryId: string;
  readonly deleted: true;
};

type JsonlMemoryEntry = JsonlMemoryRecord | JsonlMemoryTombstone;

function getJsonlMemoryPath(input: {
  scope: Exclude<MemoryScope, "project">;
  rootDir: string;
  sessionId?: string;
  agentId?: string;
}): string {
  if (input.scope === "user") {
    return path.join(input.rootDir, "memory", "user.jsonl");
  }

  if (input.scope === "agent") {
    return path.join(
      input.rootDir,
      "memory",
      "agents",
      `${input.agentId ?? "work-shell"}.jsonl`,
    );
  }

  return path.join(
    input.rootDir,
    "memory",
    "sessions",
    `${input.sessionId ?? "default"}.jsonl`,
  );
}

async function appendJsonlMemoryRecord(input: {
  path: string;
  record: JsonlMemoryEntry;
}): Promise<void> {
  await mkdir(path.dirname(input.path), { recursive: true });
  await appendFile(input.path, `${JSON.stringify(input.record)}\n`, "utf8");
}

async function readJsonlMemoryRecords(filePath: string): Promise<readonly JsonlMemoryRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const records = new Map<string, JsonlMemoryRecord>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed) as JsonlMemoryEntry;
      if ("deleted" in entry) {
        records.delete(entry.memoryId);
      } else {
        records.set(entry.memoryId, entry);
      }
    }
    return [...records.values()];
  } catch {
    return [];
  }
}

function toScopedMemoryEntry(record: JsonlMemoryRecord): ScopedMemoryEntry {
  return {
    scope: record.scope,
    memoryId: record.memoryId,
    summary: record.summary,
    timestamp: record.timestamp,
  };
}

function toProjectScopedMemoryEntry(input: {
  readonly memoryId: string;
  readonly summary: string;
}): ScopedMemoryEntry {
  const parsed = parseScopedMemoryId(input.memoryId);
  return {
    scope: "project",
    memoryId: input.memoryId,
    summary: input.summary,
    timestamp: parsed.timestamp ?? new Date(0).toISOString(),
  };
}

export async function publishContextBridge(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  summary: string;
  source: string;
  target: string;
  kind:
    | "summary"
    | "decision"
    | "fact"
    | "file-change"
    | "task-state"
    | "warning";
}): Promise<{ bridgeId: string; line: string; rollback: () => Promise<void> }> {
  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(input.env) });
  const bridgeId = `bridge:${new Date().toISOString()}:${randomUUID().slice(0, 8)}`;
  const line = `[${input.kind}] ${input.source} → ${input.target}: ${input.summary}`;
  await sessionStore.writeProjectMemory({
    projectPath: input.cwd,
    memoryId: bridgeId,
    content: line,
  });
  return {
    bridgeId,
    line,
    rollback: () => sessionStore.deleteProjectMemory({
      projectPath: input.cwd,
      memoryId: bridgeId,
    }),
  };
}

export async function listProjectBridgeLines(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(env) });
  const entries = await sessionStore.listProjectMemories(cwd);
  return entries
    .filter((entry) => entry.memoryId.startsWith("bridge:"))
    .map((entry) => entry.content)
    .slice(-6)
    .reverse();
}

type ScopedMemoryWriteInput = {
  scope: MemoryScope;
  cwd: string;
  summary: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  agentId?: string;
};

async function persistScopedMemory(input: ScopedMemoryWriteInput & {
  readonly memoryId: string;
  readonly timestamp: string;
}): Promise<void> {
  const rootDir = getSessionStoreRoot(input.env);
  if (input.scope === "project") {
    const sessionStore = createSessionStore({ rootDir });
    await sessionStore.writeProjectMemory({
      projectPath: input.cwd,
      memoryId: input.memoryId,
      content: input.summary,
    });
    return;
  }

  await appendJsonlMemoryRecord({
    path: getJsonlMemoryPath({
      scope: input.scope,
      rootDir,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    }),
    record: {
      memoryId: input.memoryId,
      scope: input.scope,
      summary: input.summary,
      timestamp: input.timestamp,
    },
  });
}

async function removePersistedScopedMemory(
  input: ScopedMemoryWriteInput & { readonly memoryId: string },
): Promise<void> {
  const rootDir = getSessionStoreRoot(input.env);
  if (input.scope === "project") {
    const sessionStore = createSessionStore({ rootDir });
    await sessionStore.deleteProjectMemory({
      projectPath: input.cwd,
      memoryId: input.memoryId,
    });
    return;
  }

  await appendJsonlMemoryRecord({
    path: getJsonlMemoryPath({
      scope: input.scope,
      rootDir,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    }),
    record: {
      memoryId: input.memoryId,
      deleted: true,
    },
  });
}

export async function writeScopedMemory(
  input: ScopedMemoryWriteInput,
): Promise<{ memoryId: string; rollback: () => Promise<void> }> {
  const timestamp = new Date().toISOString();
  const memoryId = `memory:${input.scope}:${timestamp}:${randomUUID().slice(0, 8)}`;
  await persistScopedMemory({ ...input, memoryId, timestamp });
  return {
    memoryId,
    rollback: () => removePersistedScopedMemory({ ...input, memoryId }),
  };
}

export type PromoteScopedMemoryInput = ScopedMemoryWriteInput & {
  readonly sourceId: string;
  readonly turnId?: string | undefined;
  readonly packetReceiptId?: string | undefined;
  readonly confidence: number;
  readonly supersedesMemoryId?: string | undefined;
  readonly lineage: MemoryLineageAdapter;
};

export async function promoteScopedMemory(
  input: PromoteScopedMemoryInput,
): Promise<{ memoryId: string; rollback: () => Promise<void> }> {
  if (!input.packetReceiptId?.trim()) {
    throw new Error("Submitted packet receipt required for memory promotion.");
  }
  if (!input.turnId?.trim()) {
    throw new Error("Turn ID required for memory promotion.");
  }
  const timestamp = new Date().toISOString();
  const memoryId = `memory:${input.scope}:${timestamp}:${randomUUID().slice(0, 8)}`;
  input.lineage.record({
    memoryId,
    sourceId: input.sourceId,
    originTurnId: input.turnId,
    originPacketReceiptId: input.packetReceiptId,
    ...(input.supersedesMemoryId === undefined
      ? {}
      : { supersedesMemoryId: input.supersedesMemoryId }),
    state: "active",
    confidence: input.confidence,
  });

  try {
    await persistScopedMemory({ ...input, memoryId, timestamp });
  } catch (error) {
    try {
      input.lineage.rollbackPromotion(memoryId);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Scoped memory persistence failed and lineage rollback failed.",
      );
    }
    throw error;
  }
  return {
    memoryId,
    rollback: async () => {
      let persistenceError: unknown;
      try {
        await removePersistedScopedMemory({ ...input, memoryId });
      } catch (error) {
        persistenceError = error;
      }
      try {
        input.lineage.rollbackPromotion(memoryId);
      } catch (lineageError) {
        throw new AggregateError(
          persistenceError === undefined
            ? [lineageError]
            : [persistenceError, lineageError],
          "Scoped memory rollback failed.",
        );
      }
      if (persistenceError !== undefined) {
        throw persistenceError;
      }
    },
  };
}

function filterActiveMemoryEntries(
  entries: readonly ScopedMemoryEntry[],
  lineage: MemoryLineageAdapter | undefined,
): readonly ScopedMemoryEntry[] {
  return lineage === undefined
    ? entries
    : entries.filter((entry) => lineage.isActive(entry.memoryId));
}

export async function listScopedMemoryEntries(input: {
  scope: MemoryScope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  agentId?: string;
  limit?: number;
  lineage?: MemoryLineageAdapter;
}): Promise<readonly ScopedMemoryEntry[]> {
  const rootDir = getSessionStoreRoot(input.env);
  const limit = input.limit ?? 6;
  input.lineage?.expire();

  if (input.scope === "project") {
    const sessionStore = createSessionStore({ rootDir });
    const entries = (await sessionStore.listProjectMemories(input.cwd))
      .filter((entry) => entry.memoryId.startsWith("memory:project:"))
      .map((entry) => toProjectScopedMemoryEntry({
        memoryId: entry.memoryId,
        summary: entry.content,
      }));
    return filterActiveMemoryEntries(entries, input.lineage)
      .slice(-limit)
      .reverse();
  }

  const records = await readJsonlMemoryRecords(
    getJsonlMemoryPath({
      scope: input.scope,
      rootDir,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    }),
  );

  return filterActiveMemoryEntries(records.map(toScopedMemoryEntry), input.lineage)
    .slice(-limit)
    .reverse();
}

export async function listScopedMemoryLines(input: {
  scope: MemoryScope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  agentId?: string;
  lineage?: MemoryLineageAdapter;
}): Promise<readonly string[]> {
  const entries = await listScopedMemoryEntries(input);
  return formatScopedMemoryTransparencyLines(entries);
}
