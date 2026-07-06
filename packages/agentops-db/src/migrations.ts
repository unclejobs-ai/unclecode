import type { DatabaseSync } from "node:sqlite";

export const AGENTOPS_SCHEMA_VERSION = 2;

export const AGENTOPS_INITIAL_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  config_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  source_type TEXT,
  source_url TEXT,
  status TEXT NOT NULL,
  priority INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_key TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  next_action TEXT
);

CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  output_path TEXT,
  exit_code INTEGER,
  started_at TEXT,
  finished_at TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  lane_id TEXT REFERENCES lanes(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  lane_id TEXT REFERENCES lanes(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path_or_url TEXT NOT NULL,
  sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  output_path TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  summary_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_lanes_run ON lanes(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_verifications_run ON verifications(run_id);
CREATE INDEX IF NOT EXISTS idx_summaries_project_type ON summaries(project_id, summary_type);

-- Context Runbook Protocol (CRP) — typed, queryable context source store.
-- Providers upsert rows here; the per-turn selector queries and ranks them
-- under a token budget (see docs/design/crp-context-runbook-protocol.md).
CREATE TABLE IF NOT EXISTS context_sources (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  label         TEXT NOT NULL,
  content       TEXT,
  reason        TEXT NOT NULL,
  sha256        TEXT,
  salience      REAL NOT NULL DEFAULT 0.5,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  included_in_model INTEGER NOT NULL DEFAULT 1,
  turn_last_seen INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_context_sources_project_model
  ON context_sources(project_id, included_in_model);
CREATE INDEX IF NOT EXISTS idx_context_sources_project_salience
  ON context_sources(project_id, salience DESC);
`;

// Incremental migrations for existing databases. Each entry targets a
// specific version boundary and must be idempotent (uses IF NOT EXISTS).
// A fresh DB runs AGENTOPS_INITIAL_SCHEMA_SQL (which already includes all
// tables up to the current version) then records every version as applied.
// An existing DB at version N runs only migrations for N+1..current.
const AGENTOPS_INCREMENTAL_MIGRATIONS: ReadonlyArray<{
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}> = [
  {
    version: 2,
    name: "add_context_sources",
    sql: `
CREATE TABLE IF NOT EXISTS context_sources (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  label         TEXT NOT NULL,
  content       TEXT,
  reason        TEXT NOT NULL,
  sha256        TEXT,
  salience      REAL NOT NULL DEFAULT 0.5,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  included_in_model INTEGER NOT NULL DEFAULT 1,
  turn_last_seen INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_context_sources_project_model
  ON context_sources(project_id, included_in_model);
CREATE INDEX IF NOT EXISTS idx_context_sources_project_salience
  ON context_sources(project_id, salience DESC);
`,
  },
];

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
      // Fresh database — apply the full schema, then record every version
      // so incremental migrations don't re-run on the next open.
      db.exec(AGENTOPS_INITIAL_SCHEMA_SQL);
      for (let v = 1; v <= AGENTOPS_SCHEMA_VERSION; v += 1) {
        db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          v,
          v === 1 ? "initial_schema" : `migration_v${v}`,
          new Date().toISOString(),
        );
      }
    } else {
      // Existing database — apply only the incremental migrations for
      // versions greater than the last applied one.
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
