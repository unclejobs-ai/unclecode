import type { DatabaseSync } from "node:sqlite";

import {
  AGENTOPS_INCREMENTAL_MIGRATIONS,
  AGENTOPS_INITIAL_SCHEMA_SQL,
} from "./schema-sql.js";

export { AGENTOPS_INITIAL_SCHEMA_SQL } from "./schema-sql.js";

export const AGENTOPS_SCHEMA_VERSION = latestSchemaVersion();

export function applyAgentOpsMigrations(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const current = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
  const currentVersion = isMigrationRow(current) ? current.version : 0;
  if (currentVersion >= AGENTOPS_SCHEMA_VERSION) return;

  db.exec("BEGIN");
  try {
    if (currentVersion === 0) {
      db.exec(AGENTOPS_INITIAL_SCHEMA_SQL);
      for (let version = 1; version <= AGENTOPS_SCHEMA_VERSION; version += 1) {
        db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          version,
          migrationName(version),
          new Date().toISOString(),
        );
      }
    } else {
      for (const migration of AGENTOPS_INCREMENTAL_MIGRATIONS) {
        if (migration.version > currentVersion) {
          db.exec(migration.sql);
          db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
            migration.version,
            migration.name,
            new Date().toISOString(),
          );
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isMigrationRow(value: unknown): value is { readonly version: number } {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "number";
}

function latestSchemaVersion(): number {
  let version = 1;
  for (const migration of AGENTOPS_INCREMENTAL_MIGRATIONS) {
    version = Math.max(version, migration.version);
  }
  return version;
}

function migrationName(version: number): string {
  if (version === 1) {
    return "initial_schema";
  }
  for (const migration of AGENTOPS_INCREMENTAL_MIGRATIONS) {
    if (migration.version === version) {
      return migration.name;
    }
  }
  return `migration_v${version}`;
}
