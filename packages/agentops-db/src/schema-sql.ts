export type AgentOpsMigration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

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
  id            TEXT NOT NULL,
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
  expires_at    TEXT,
  badges_json   TEXT,
  metadata_json TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_context_sources_project_model
  ON context_sources(project_id, included_in_model);
CREATE INDEX IF NOT EXISTS idx_context_sources_project_salience
  ON context_sources(project_id, salience DESC);

CREATE TABLE IF NOT EXISTS context_packet_receipts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  packet_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('previewed', 'submitted', 'invalidated')),
  replaces_receipt_id TEXT REFERENCES context_packet_receipts(id) ON DELETE SET NULL,
  profile TEXT NOT NULL,
  token_estimate INTEGER,
  token_estimate_state TEXT NOT NULL CHECK (token_estimate_state IN ('exact', 'estimated', 'unknown')),
  source_count INTEGER NOT NULL,
  source_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_packet_receipts_project_session_state
  ON context_packet_receipts(project_id, session_id, state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_packet_receipts_submitted_turn
  ON context_packet_receipts(project_id, session_id, turn_id)
  WHERE state = 'submitted' AND turn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS context_policy_suggestions (
  id TEXT PRIMARY KEY,
  packet_receipt_id TEXT NOT NULL REFERENCES context_packet_receipts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('keep', 'summarize', 'hold-back', 'refresh')),
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  estimated_token_saving INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'stale')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_policy_suggestions_receipt_status
  ON context_policy_suggestions(packet_receipt_id, status, created_at);
`;

export const AGENTOPS_INCREMENTAL_MIGRATIONS: readonly AgentOpsMigration[] = [
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
  {
    version: 3,
    name: "scope_context_sources_by_project",
    sql: `
DROP INDEX IF EXISTS idx_context_sources_project_model;
DROP INDEX IF EXISTS idx_context_sources_project_salience;

CREATE TABLE IF NOT EXISTS context_sources_v3 (
  id            TEXT NOT NULL,
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
  expires_at    TEXT,
  PRIMARY KEY (project_id, id)
);

INSERT OR REPLACE INTO context_sources_v3 (
  id, project_id, category, label, content, reason, sha256,
  salience, token_estimate, included_in_model, turn_last_seen,
  created_at, updated_at, expires_at
)
SELECT
  id,
  project_id,
  category,
  '[REDACTED_MIGRATED_CONTEXT]' AS label,
  NULL AS content,
  '[REDACTED_MIGRATED_CONTEXT]' AS reason,
  sha256,
  salience, token_estimate, included_in_model, turn_last_seen,
  created_at, updated_at, expires_at
FROM context_sources;

DROP TABLE context_sources;
ALTER TABLE context_sources_v3 RENAME TO context_sources;

CREATE INDEX IF NOT EXISTS idx_context_sources_project_model
  ON context_sources(project_id, included_in_model);
CREATE INDEX IF NOT EXISTS idx_context_sources_project_salience
  ON context_sources(project_id, salience DESC);
`,
  },
  {
    version: 4,
    name: "add_context_source_badges",
    sql: `
ALTER TABLE context_sources ADD COLUMN badges_json TEXT;
`,
  },
  {
    version: 5,
    name: "add_context_source_metadata",
    sql: `
ALTER TABLE context_sources ADD COLUMN metadata_json TEXT;
`,
  },
  {
    version: 6,
    name: "add_context_packet_receipts",
    sql: `
CREATE TABLE IF NOT EXISTS context_packet_receipts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  packet_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('previewed', 'submitted', 'invalidated')),
  replaces_receipt_id TEXT REFERENCES context_packet_receipts(id) ON DELETE SET NULL,
  profile TEXT NOT NULL,
  token_estimate INTEGER,
  token_estimate_state TEXT NOT NULL CHECK (token_estimate_state IN ('exact', 'estimated', 'unknown')),
  source_count INTEGER NOT NULL,
  source_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_packet_receipts_project_session_state
  ON context_packet_receipts(project_id, session_id, state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_packet_receipts_submitted_turn
  ON context_packet_receipts(project_id, session_id, turn_id)
  WHERE state = 'submitted' AND turn_id IS NOT NULL;
`,
  },
  {
    version: 7,
    name: "add_context_policy_suggestions",
    sql: `
CREATE TABLE IF NOT EXISTS context_policy_suggestions (
  id TEXT PRIMARY KEY,
  packet_receipt_id TEXT NOT NULL REFERENCES context_packet_receipts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('keep', 'summarize', 'hold-back', 'refresh')),
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  estimated_token_saving INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'stale')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_policy_suggestions_receipt_status
  ON context_policy_suggestions(packet_receipt_id, status, created_at);
`,
  },
];
