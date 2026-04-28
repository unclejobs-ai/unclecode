/**
 * Quick tools — glob, todowrite, stats. Small additions to the agent toolkit
 * that compose with the existing ACI surface.
 *
 * - glob: ripgrep --files --glob filter, capped same way as search.
 * - todowrite: in-conversation TODO list persisted to a per-session file so
 *   the agent's plan survives observation collapsing.
 * - stats: token / step / cost counter the runner can hand back to the user.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DEFAULT_SEARCH_CAP, type SearchResult } from "./search.js";

const execFileAsync = promisify(execFile);

export type GlobInput = {
  readonly cwd: string;
  readonly pattern: string;
  readonly cap?: number;
};

export async function glob(input: GlobInput): Promise<SearchResult> {
  const cap = input.cap ?? DEFAULT_SEARCH_CAP;
  const args = ["--files", "--hidden", "--glob", input.pattern, "--glob", "!node_modules", "--glob", "!dist", resolve(input.cwd)];
  let stdout = "";
  try {
    const result = await execFileAsync("rg", args, { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
    stdout = result.stdout;
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const files = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const truncated = files.length > cap;
  const hits = files.slice(0, cap).map((path) => ({ path }));
  return {
    truncated,
    totalHits: files.length,
    hits,
    ...(truncated
      ? { suggestion: `Glob matched ${files.length} files; first ${cap} returned. Tighten the pattern.` }
      : {}),
  };
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly updatedAt: string;
};

export type TodoFileShape = {
  readonly sessionId: string;
  readonly items: ReadonlyArray<TodoItem>;
};

export type TodoWriteInput = {
  readonly cwd: string;
  readonly sessionId: string;
  readonly items: ReadonlyArray<Omit<TodoItem, "updatedAt">>;
};

export function todoWrite(input: TodoWriteInput): TodoFileShape {
  const path = todoFilePath(input.cwd, input.sessionId);
  const now = new Date().toISOString();
  const items = input.items.map((item) => ({ ...item, updatedAt: now }));
  const payload: TodoFileShape = { sessionId: input.sessionId, items };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return payload;
}

export function todoRead(input: { cwd: string; sessionId: string }): TodoFileShape | undefined {
  const path = todoFilePath(input.cwd, input.sessionId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as TodoFileShape;
}

function todoFilePath(cwd: string, sessionId: string): string {
  return resolve(cwd, ".unclecode", "todos", `${sessionId}.json`);
}

export type SessionStats = {
  readonly sessionId: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly lastTool?: string;
};

export function formatStats(stats: SessionStats): string {
  const seconds = (stats.durationMs / 1000).toFixed(1);
  const dollars = stats.costUsd.toFixed(3);
  return [
    `Session: ${stats.sessionId}`,
    `Steps:   ${stats.steps}`,
    `Tools:   ${stats.toolCalls}${stats.lastTool ? ` (last: ${stats.lastTool})` : ""}`,
    `Cost:    $${dollars}`,
    `Time:    ${seconds}s`,
  ].join("\n");
}
