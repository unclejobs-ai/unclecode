import { createSessionStore, getSessionStoreRoot } from "@unclecode/session-store";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseScopedMemoryId, formatScopedMemoryTransparencyLines, type ScopedMemoryEntry } from "./memory-transparency.js";

export type MemoryScope = "session" | "project" | "user" | "agent";

type JsonlMemoryRecord = {
  readonly memoryId: string;
  readonly scope: Exclude<MemoryScope, "project">;
  readonly summary: string;
  readonly timestamp: string;
};

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
  record: JsonlMemoryRecord;
}): Promise<void> {
  await mkdir(path.dirname(input.path), { recursive: true });
  await appendFile(input.path, `${JSON.stringify(input.record)}\n`, "utf8");
}

async function readJsonlMemoryRecords(filePath: string): Promise<readonly JsonlMemoryRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonlMemoryRecord);
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
}): Promise<{ bridgeId: string; line: string }> {
  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(input.env) });
  const bridgeId = `bridge:${new Date().toISOString()}:${randomUUID().slice(0, 8)}`;
  const line = `[${input.kind}] ${input.source} → ${input.target}: ${input.summary}`;
  await sessionStore.writeProjectMemory({
    projectPath: input.cwd,
    memoryId: bridgeId,
    content: line,
  });
  return { bridgeId, line };
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

export async function writeScopedMemory(input: {
  scope: MemoryScope;
  cwd: string;
  summary: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  agentId?: string;
}): Promise<{ memoryId: string }> {
  const rootDir = getSessionStoreRoot(input.env);
  const timestamp = new Date().toISOString();
  const memoryId = `memory:${input.scope}:${timestamp}:${randomUUID().slice(0, 8)}`;

  if (input.scope === "project") {
    const sessionStore = createSessionStore({ rootDir });
    await sessionStore.writeProjectMemory({
      projectPath: input.cwd,
      memoryId,
      content: input.summary,
    });
    return { memoryId };
  }

  await appendJsonlMemoryRecord({
    path: getJsonlMemoryPath({
      scope: input.scope,
      rootDir,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    }),
    record: {
      memoryId,
      scope: input.scope,
      summary: input.summary,
      timestamp,
    },
  });

  return { memoryId };
}

export async function listScopedMemoryEntries(input: {
  scope: MemoryScope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  agentId?: string;
  limit?: number;
}): Promise<readonly ScopedMemoryEntry[]> {
  const rootDir = getSessionStoreRoot(input.env);
  const limit = input.limit ?? 6;

  if (input.scope === "project") {
    const sessionStore = createSessionStore({ rootDir });
    const entries = await sessionStore.listProjectMemories(input.cwd);
    return entries
      .filter((entry) => entry.memoryId.startsWith("memory:project:"))
      .slice(-limit)
      .reverse()
      .map((entry) => toProjectScopedMemoryEntry({ memoryId: entry.memoryId, summary: entry.content }));
  }

  const records = await readJsonlMemoryRecords(
    getJsonlMemoryPath({
      scope: input.scope,
      rootDir,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    }),
  );

  return records
    .slice(-limit)
    .reverse()
    .map(toScopedMemoryEntry);
}

export async function listScopedMemoryLines(input: {
  scope: MemoryScope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  agentId?: string;
}): Promise<readonly string[]> {
  const entries = await listScopedMemoryEntries(input);
  return formatScopedMemoryTransparencyLines(entries);
}
