# T15 · Context Runbook Protocol (CRP)

> Status: **Proposed** · Owner: workspace · Date: 2026-07-06
> Predecessors: `context-bootstrap-pipeline.md`, `work-queue-board-t15.md`

## Problem

The Runbook today is a **passive view**: an in-memory resolver merges
ad-hoc string arrays (bridge lines, memory lines, trace lines, OMO snapshot)
on every turn and hands the result to the TUI. There is no persistence,
no queryability, no selection logic, and no protocol.

Concrete gaps:

1. **No memory across turns.** The resolver recomputes from scratch each
   turn; if a source was relevant two turns ago it may vanish silently.
2. **No ranking.** Sources are concatenated in arrival order. Token budget
   is consumed by whatever came first, not what matters most.
3. **No query interface.** The Runbook can show "what reached the model"
   but cannot answer "what *should* reach the model if I asked about X".
4. **MCP is the wrong shape.** MCP pushes tool schemas wholesale into the
   context window; it is a "dumb pipe" (cf. Shrivu 2025, RAG-MCP). We need
   a **selection layer**, not another transport.
5. **The `BootstrapSourceRecord` already has the right fields** but lives
   in a single JSON blob (`.unclecode/context/bootstrap.json`), not a
   queryable table.

## Research basis (why this is white space)

- **Aider's repo-map** (tree-sitter + PageRank + token budget) is the
  closest precedent but is **in-memory, ephemeral**.
- **Sourcegraph Cody's own paper** names the gap: *"decentralized" sources,
  no "centralized source of data ahead of time"* (arXiv 2408.05344).
- **Anthropic / LangChain "context engineering"** (2025) names the
  operations we need: **write → select → compress → isolate**.
- **LongLLMLingua** proves a budget controller + ranking lifts accuracy
  ~21% at ¼ the tokens.
- No major tool persists a typed, queryable SQL context store with
  per-turn selection. This is the differentiator.

## Design

### Architecture

```
            ┌──────────────────────────────────┐
            │  Work-shell turn boundary         │
            │  (refreshContextPacket)           │
            └───────────────┬──────────────────┘
                            │  selectContextPacket(turn, budget)
                            ▼
            ┌──────────────────────────────────┐
            │  ContextSelector                 │
            │  ─ SQL query + salience ranking   │
            │  ─ token budget controller        │
            │  ─ returns ContextPacketView      │
            └───────────────┬──────────────────┘
                            │  reads
                            ▼
            ┌──────────────────────────────────┐
            │  context_sources (SQLite)         │
            │  agentops-db, schema v2           │
            └───────────────▲──────────────────┘
                            │  writes (upsert)
            ┌───────────────┴──────────────────┐
            │  ContextProviders (CRP)          │
            │  ─ workspace-guidance  (auto-scan)│
            │  ─ bridge             (Q&A trail) │
            │  ─ loop-trail         (sessions)  │
            │  ─ memory             (project-db)│
            │  ─ runtime            (live trace)│
            └──────────────────────────────────┘
```

### 1. SQL schema (`agentops-db` v2)

New table in the existing `agentops.db` (WAL, foreign keys, migration
framework already in place at `migrations.ts:122`).

```sql
CREATE TABLE IF NOT EXISTS context_sources (
  id            TEXT PRIMARY KEY,           -- stable provider-assigned id
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,              -- workspace | bridge | loop-trail | memory | runtime | ...
  label         TEXT NOT NULL,              -- user-facing summary
  content       TEXT,                       -- full text (nullable for pointer-only sources)
  reason        TEXT NOT NULL,              -- why this source exists
  sha256        TEXT,                       -- content hash for change detection
  salience      REAL NOT NULL DEFAULT 0.5,  -- 0.0..1.0, provider-assigned
  token_estimate INTEGER NOT NULL DEFAULT 0,
  included_in_model INTEGER NOT NULL DEFAULT 1,  -- 0/1
  turn_last_seen INTEGER,                   -- turn index when last selected
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT                        -- nullable; TTL-based pruning
);

CREATE INDEX IF NOT EXISTS idx_context_sources_project_model
  ON context_sources(project_id, included_in_model);
CREATE INDEX IF NOT EXISTS idx_context_sources_project_salience
  ON context_sources(project_id, salience DESC);
```

`AGENTOPS_SCHEMA_VERSION` bumps 1 → 2. Migration is additive (new table +
indexes); existing tables untouched.

### 2. Contracts (`packages/contracts/src/`)

New file `context-source.ts`:

```ts
export type ContextSourceCategory =
  | "workspace"
  | "workspace-guidance"
  | "bridge"
  | "loop-trail"
  | "memory"
  | "runtime"
  | "attachment"
  | "system";

export type ContextSourceRecord = {
  readonly id: string;                       // provider-scoped, stable
  readonly projectId: string;
  readonly category: ContextSourceCategory;
  readonly label: string;
  readonly content: string | null;
  readonly reason: string;
  readonly sha256: string | null;
  readonly salience: number;                 // 0..1
  readonly tokenEstimate: number;
  readonly includedInModel: boolean;
  readonly turnLastSeen: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
};

export type UpsertContextSourceInput = {
  readonly id: string;
  readonly projectId: string;
  readonly category: ContextSourceCategory;
  readonly label: string;
  readonly content?: string | null;
  readonly reason: string;
  readonly sha256?: string | null;
  readonly salience?: number;
  readonly tokenEstimate?: number;
  readonly includedInModel?: boolean;
  readonly expiresAt?: string | null;
};

export type SelectContextSourcesInput = {
  readonly projectId: string;
  readonly tokenBudget: number;
  readonly turnIndex: number;
  readonly categoryFilter?: readonly ContextSourceCategory[];
  readonly minSalience?: number;
};
```

`ContextSourceCategory` is intentionally narrower than the current
`ContextPacketSourceCategory` — the model-facing projection keeps
`provider-system-prompt` and `user` as synthetic categories added at
select time, not stored.

### 3. Store layer (`packages/agentops-db/src/`)

- `store-writes.ts`: `upsertContextSource(db, input)`,
  `markContextSourceTurnSeen(db, ids, turn)`,
  `pruneExpiredContextSources(db)`.
- `store-reads.ts`: `selectContextSources(db, input)`,
  `countContextSourcesByCategory(db, projectId)`.
- `types.ts`: `AgentOpsContextSourceRecord` (DB row shape).
- `store-mappers.ts`: `mapContextSourceRow(row): ContextSourceRecord`.

Selection query (the core primitive):

```sql
SELECT * FROM context_sources
WHERE project_id = ?
  AND included_in_model = 1
  AND (expires_at IS NULL OR expires_at > ?)
  AND (? IS NULL OR category IN (...))
  AND salience >= ?
ORDER BY salience DESC, updated_at DESC
```

Result is then iterated in TypeScript to fit `tokenBudget` — a greedy
budget controller (cf. LongLLMLingua): keep adding rows until the
cumulative `token_estimate` exceeds budget; if a single row exceeds the
remaining budget it is kept anyway (never silently drop the top-ranked
source).

### 4. Context Runbook Protocol (CRP)

LSP-inspired capability handshake over the **existing dormant RPC layer**
(`packages/contracts/src/rpc.ts`). Three new capabilities:

```ts
type UnclecodeRpcCapability =
  | ...existing...
  | "context.register"   // provider declares its sources
  | "context.select"     // selector queries for a turn
  | "context.invalidate"; // provider signals staleness
```

New RPC commands:

```ts
| { name: "context.register"; input: ContextProviderManifest }
| { name: "context.select";   input: SelectContextSourcesInput }
| { name: "context.invalidate"; input: { projectId: string; category?: string } }
```

`ContextProviderManifest` (mirrors LSP `ServerCapabilities`):

```ts
type ContextProviderManifest = {
  readonly providerId: string;              // "workspace-guidance", "bridge", ...
  readonly categories: readonly ContextSourceCategory[];
  readonly refresh: "on-turn" | "on-change" | "manual";
  readonly trustTier: "builtin" | "project" | "user";
};
```

### 5. Providers

Each provider is a thin adapter that knows how to **scan its source** and
**upsert** rows. They run at turn boundaries (or on file change for
workspace-guidance):

| Provider | Source | Refresh | Salience heuristic |
|----------|--------|---------|-------------------|
| `workspace-guidance` | `.cursor/rules`, `AGENTS.md`, skills | on-change | recency × scope weight |
| `bridge` | context-broker Q&A trail | on-turn | turn proximity |
| `loop-trail` | `.omo/` session artifacts | on-turn | goal status (active > done) |
| `memory` | `project-memory-db` | on-turn | scoped memory rank |
| `runtime` | live work-shell trace | on-turn | last-N-turns window |

Salience is a 0..1 score; the selector sorts by it. Providers can also
set `included_in_model = 0` to hold a source back locally (the Runbook's
"Held back" section) without deleting it.

### 6. Selector → ContextPacketView bridge

`selectContextSources` returns `ContextSourceRecord[]`. A mapper converts
these to the existing `ContextPacketViewItem[]` shape so the TUI Runbook
and the model prompt composition (`composeWorkShellTurnPromptFromPacket`)
need **no changes** — the SQL layer slots in below the current
`ContextPacketView` boundary.

```ts
function contextSourceToPacketItem(src: ContextSourceRecord): ContextPacketViewItem {
  return {
    id: src.id,
    category: src.category as ContextPacketSourceCategory,
    label: src.label,
    reason: src.reason,
    preview: src.content ?? undefined,
    tokenEstimate: src.tokenEstimate,
  };
}
```

### 7. Fallback / migration path ✅

CRP is the **default** context path, controlled by three sources in
precedence order:

1. **Env var** `UNCLECODE_CRP` (highest — overrides config)
2. **Config file** `.unclecode/config.json` → `{"context":{"crp":false}}`
3. **Default**: ON

- **No opt-in flag needed.** `./target/debug/unclecode tui` uses CRP by
  default, picking up `.unclecode/config.json` automatically.
- **Config-file control:** `{"context":{"crp":false,"crpBudget":16000}}`
  in project or user config. File precedence follows `config-core`:
  user config overrides project config, and environment overrides both.
- **Rollback:** `UNCLECODE_CRP=0` or config `crp:false` forces the legacy
  in-memory resolver (kept as `legacyResolveContextPacket`).
- **Runtime fallback:** if the SQL store throws on any turn, the wrapper
  catches and falls back to the legacy resolver for that turn — the user
  never sees a hard failure.
- **Runbook TUI:** unchanged — it already consumes `ContextPacketView`.

### GAP fixes (post-audit)

- **GAP 3a (fixed):** `turnIndex` is now tracked across turns (incremented
  per refresh) so `turn_last_seen` records the real turn number, not a
  constant 0. The "memory across turns" goal is realized end-to-end.
- **GAP 3b (fixed):** Bootstrap-supplied context (auth-issue lines,
  resumed-session context, extension summaries) is now folded into the
  SQL store as high-salience `system` rows, so CRP no longer drops
  information the legacy path carried.
- **GAP 3c (fixed):** Resolver logic (`isCrpEnabled`, `resolveCrpBudget`,
  config precedence) has contract tests (`tests/crp-resolver.test.mjs`).

### Phase 4 — `unclecode` command integration + CRP protocol surface

**Problem:** `unclecode work` (Rust-native mini-loop) has no CRP code at
all — it's a separate runtime from the TS TUI. This splits the user
experience: CRP works for `unclecode tui` but not `unclecode work`.

**Approach:** Two tracks, decoupled.

#### 4a — Route `unclecode work` through the TS runtime (HIGH)
- [ ] Audit `rust/unclecode/src/cli_work.rs:run_top_level_work_command` —
  the mini-loop that bypasses Node entirely.
- [ ] Decision: either (A) port CRP to Rust (heavy), or (B) re-point
  `unclecode work` to launch the TS work entrypoint (like `tui` does).
  Option B is recommended — one runtime, one context path.
- [ ] If B: add a Rust dispatch that spawns the TS work runtime with
  `UNCLECODE_FORCE_TS_WORK=1` sentinel (mirrors the existing
  `UNCLECODE_FORCE_TS_TUI` pattern at `main.rs:515`).
- [ ] Verify CRP reaches `unclecode work` end-to-end.

#### 4b — CRP RPC protocol (MEDIUM — for external providers)
- [ ] Add `context.register` / `context.select` / `context.invalidate`
  to `packages/contracts/src/rpc.ts`.
- [ ] `ContextProviderManifest` handshake at session start (LSP-style
  capability negotiation).
- [ ] External providers (plugins, MCP bridges) can register via RPC.
- [ ] Tests: manifest handshake, invalidation triggers re-scan.
- [ ] This is additive — the in-process providers (Phase 2) keep working
  without RPC.

### Phase 5 — Runbook TUI enhancements

- [ ] **Salience visualization** — subtle bar (▏▎▍▌▋) next to each source
  in the Runbook so the user sees WHY sources are ranked this way.
- [ ] **`/context pin <id>`** — set `salience = 1.0` (always included).
- [ ] **`/context unpin <id>`** — restore provider-assigned salience.
- [ ] **`/context forget <id>`** — set `included_in_model = 0` (held back).
- [ ] **`/context budget <n>k`** — live-adjust token budget (writes to
  session state, not config file).
- [ ] **`/context refresh`** — force re-sync all providers immediately.
- [ ] Tests: each command updates the SQL store and re-renders the Runbook.

## Verification status (post-audit)

| Suite | Tests | Status |
|-------|-------|--------|
| `npm run test:contracts` | 211 | ✅ pass |
| `npm run test:agentops-db` | 13 | ✅ pass (incl. 10 CRP) |
| `npm run test:tui` | 88 | ✅ pass |
| CRP providers (`crp-providers.test.mjs`) | 12 | ✅ pass |
| CRP resolver (`crp-resolver.test.mjs`) | 4 | ✅ pass |
| **Total CRP-specific** | **26** | ✅ pass |
| Live TUI (default) | — | ✅ 24 included (SQL-ranked) |
| Live TUI (`crp:false`) | — | ✅ 181 included (legacy) |
| Live TUI (`crpBudget:8000`) | — | ✅ budget applied |

## What this is NOT

- Not a vector DB. Selection is deterministic SQL + salience, not
  embedding similarity. (Vector recall is a future Phase 6 for fuzzy
  "find relevant past context" — orthogonal to this design.)
- Not MCP. CRP is a tighter, capability-negotiated protocol over the
  existing RPC frame. MCP servers can be bridged as providers later.
- Not a rewrite. The `ContextPacketView` boundary is preserved; SQL slots
  below it.
- **Not yet on `unclecode work`** — only `unclecode tui` reaches CRP today.
  Phase 4a closes this gap.
