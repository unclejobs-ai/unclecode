import Database from "better-sqlite3";

import { redactSecrets } from "./redaction.js";
import type { ProjectMemoryEntry } from "./types.js";

function openProjectMemoryDatabase(dbPath: string): Database.Database {
  const database = new Database(dbPath);

  database.exec(`
    CREATE TABLE IF NOT EXISTS project_memory (
      memory_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return database;
}

export function writeProjectMemoryRecord(
  dbPath: string,
  memoryId: string,
  content: string,
): void {
  const database = openProjectMemoryDatabase(dbPath);

  try {
    database
      .prepare(
        `
          INSERT INTO project_memory (memory_id, content, updated_at)
          VALUES (@memoryId, @content, @updatedAt)
          ON CONFLICT(memory_id) DO UPDATE SET
            content = excluded.content,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        memoryId: redactSecrets(memoryId),
        content: redactSecrets(content),
        updatedAt: new Date().toISOString(),
      });
  } finally {
    database.close();
  }
}

export function deleteProjectMemoryRecord(dbPath: string, memoryId: string): void {
  const database = openProjectMemoryDatabase(dbPath);

  try {
    database.prepare(`DELETE FROM project_memory WHERE memory_id = ?`).run(memoryId);
  } finally {
    database.close();
  }
}

export function listProjectMemoryRecords(dbPath: string): ProjectMemoryEntry[] {
  const database = openProjectMemoryDatabase(dbPath);

  try {
    const rows = database
      .prepare<[], { memory_id: string; content: string }>(
        `SELECT memory_id, content FROM project_memory ORDER BY memory_id ASC`,
      )
      .all();

    return rows.map((row: { memory_id: string; content: string }) => ({
      memoryId: row.memory_id,
      content: row.content,
    }));
  } finally {
    database.close();
  }
}
