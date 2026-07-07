# CRP Implementation Guide

A practical developer reference for the **Context Runbook Protocol (CRP)** — how it
actually works in the codebase today. This is the "how to use and extend it" guide.
For motivation, design trade-offs, and the protocol spec, see
[`docs/design/crp-context-runbook-protocol.md`](./design/crp-context-runbook-protocol.md).

---

## 1. Overview

CRP is a typed, queryable context store that sits between the things that *produce*
context (guidance files, bridge trail, memory, loop trail, runtime trace) and the
things that *consume* it (the model prompt + the TUI Runbook). On every turn,
**providers** upsert rows into a SQLite table; a **selector** then ranks those rows by
salience and greedily fits them under a token budget, producing the same
`ContextPacketView` the rest of the engine already consumes.

---

## 2. Architecture

```
                         ┌──────────────────────────────────────────┐
                         │              Providers (5)               │
                         │  workspace-guidance · bridge · loop-trail │
                         │       memory · runtime (trace)           │
                         └──────────────────┬───────────────────────┘
                                            │  upsertContextSource()
                                            ▼
                         ┌──────────────────────────────────────────┐
                         │        context_sources (SQLite)          │
                         │  salience · token_estimate · included_   │
                         │  in_model · expires_at · turn_last_seen  │
                         └──────────────────┬───────────────────────┘
                                            │  selectContextSources()
                                            │   (salience DESC, greedy budget fit)
                                            ▼
                         ┌──────────────────────────────────────────┐
                         │   selectContextPacketFromStore()         │
                         │   → ContextPacketView                    │
                         │   (included[] + excluded[] + warnings[]) │
                         └──────────────────┬───────────────────────┘
                                            │
                          ┌─────────────────┴──────────────────┐
                          ▼                                     ▼
              composeWorkShellTurnPromptFromPacket        TUI Runbook
              (model prompt composition)                  (operator view)
```

**Packages involved:**

| Package | Role |
|---|---|
| `@unclecode/contracts` | Types: `ContextSourceCategory`, `ContextSourceRecord`, input shapes |
| `@unclecode/agentops-db` | SQLite store — schema, writes, reads |
| `@unclecode/context-broker` | Providers, selector, registry |
| `@unclecode/config-core` | CRP settings (`crp`, `crpBudget`) + resolution |
| `unclecode-cli` | Wiring: `createCrpAwareContextPacketResolver` |

---

## 3. SQL Schema

Defined in `packages/agentops-db/src/migrations.ts`. The table ships in schema
version **2** (the v2 incremental migration `add_context_sources` adds it to existing
DBs; fresh DBs get it from `AGENTOPS_INITIAL_SCHEMA_SQL`).

```sql
CREATE TABLE IF NOT EXISTS context_sources (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  label             TEXT NOT NULL,
  content           TEXT,
  reason            TEXT NOT NULL,
  sha256            TEXT,
  salience          REAL NOT NULL DEFAULT 0.5,
  token_estimate    INTEGER NOT NULL DEFAULT 0,
  included_in_model INTEGER NOT NULL DEFAULT 1,
  turn_last_seen    INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_context_sources_project_model
  ON context_sources(project_id, included_in_model);
CREATE INDEX IF NOT EXISTS idx_context_sources_project_salience
  ON context_sources(project_id, salience DESC);
```

### Column reference

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PK | Stable provider-assigned ID (e.g. `runtime-trace-3`). Same ID = upsert, not insert. |
| `project_id` | TEXT FK → `projects` | Scopes rows to a workspace. Cascades on project delete. |
| `category` | TEXT | One of `ContextSourceCategory` (see §4). |
| `label` | TEXT | Short human label (TUI Runbook). Providers cap at ~120 chars. |
| `content` | TEXT nullable | Full text sent to the model. `null` = metadata-only row. |
| `reason` | TEXT | Why this source exists (shown in Runbook). Non-null. |
| `sha256` | TEXT nullable | Optional content hash for dedup/audit. Not yet used by selectors. |
| `salience` | REAL | Rank weight in `[0, 1]`. Default `0.5`. Pinning sets `1.0`. |
| `token_estimate` | INTEGER | Approx tokens (`ceil(len/4)`). Drives budget fit. Default `0`. |
| `included_in_model` | INTEGER | `1` = selectable; `0` = held back locally (visible in Runbook, never sent). |
| `turn_last_seen` | INTEGER nullable | Last turn index this source was selected. Set by `markContextSourceTurnSeen`. |
| `created_at` / `updated_at` | TEXT | ISO timestamps. |
| `expires_at` | TEXT nullable | When to prune. `NULL` = never expires. |

---

## 4. Store API

All functions live in `@unclecode/agentops-db` and are surfaced through the
`AgentOpsStore` interface (`packages/agentops-db/src/store-types.ts`).

### Types (`packages/contracts/src/context-source.ts`)

```ts
export type ContextSourceCategory =
  | "workspace" | "workspace-guidance" | "bridge" | "loop-trail"
  | "memory" | "runtime" | "attachment" | "system";

export const CONTEXT_SOURCE_DEFAULT_SALIENCE = 0.5;

// Result shape returned by selectContextSources
export type SelectedContextSources = {
  readonly selected: readonly ContextSourceRecord[];   // within budget, included
  readonly heldBack:  readonly ContextSourceRecord[];  // over-budget OR included_in_model=0
  readonly totalTokens: number;
  readonly budget: number;
};
```

> **Note on categories:** the stored categories are real provider sources. The
> synthetic categories `provider-system-prompt` and `user` are added at select time
> when projecting to `ContextPacketView` — they map to the stored `system` category.

### Writes (`packages/agentops-db/src/store-writes.ts`)

#### `upsertContextSource(input)` — insert or update by `id`

```ts
function upsertContextSource(db, input: UpsertContextSourceInput): AgentOpsContextSourceRow;
```

Inserts a new row, or — if `id` already exists — updates every field except
`turn_last_seen` and `created_at`. Throws if `projectId` is unknown.

```ts
store.upsertContextSource({
  id: "workspace-guidance-1",
  projectId: project.id,
  category: "workspace-guidance",
  label: "AGENTS.md guidance",
  content: "Use rg for search.",
  reason: "workspace guidance summary",
  salience: 0.8,            // optional, default 0.5
  tokenEstimate: 50,        // optional, default 0
  // includedInModel defaults to true; expiresAt defaults to null
});
```

#### `markContextSourceTurnSeen(ids, turnIndex)`

```ts
function markContextSourceTurnSeen(db, ids: readonly string[], turnIndex: number): void;
```

Sets `turn_last_seen = turnIndex` for the given IDs. Called by the selector after a
successful selection. No-op on empty `ids`.

#### `pruneExpiredContextSources(now?)`

```ts
function pruneExpiredContextSources(db, now?: Date): number; // returns rows deleted
```

Deletes every row where `expires_at <= now`. Defaults to `new Date()`.

#### Inspector actions: `pin` / `unpin` / `forget` / `include`

These back the TUI Context Inspector and are all single-row updates by `id`:

```ts
function pinContextSource(db, id: string): void;       // salience = 1.0 → always selected
function unpinContextSource(db, id: string): void;     // salience = 0.5 (provider can re-rank later)
function forgetContextSource(db, id: string): void;    // included_in_model = 0 → held back locally
function includeContextSource(db, id: string): void;   // included_in_model = 1 → selectable again
```

### Reads (`packages/agentops-db/src/store-context-reads.ts`)

#### `selectContextSources(input)` — the heart of CRP

```ts
function selectContextSources(db, input: SelectContextSourcesInput): SelectedContextSources;

type SelectContextSourcesInput = {
  readonly projectId: string;
  readonly tokenBudget: number;
  readonly turnIndex: number;
  readonly categoryFilter?: readonly ContextSourceCategory[];
  readonly minSalience?: number;   // default 0
};
```

See §6 for the ranking + budget algorithm.

#### `countContextSourcesByCategory(projectId)` → `Map<string, number>`

Grouped count for Runbook headers / diagnostics.

#### `getContextSourceById(id)` → `ContextSourceRecord | undefined`

Single-row lookup (used by Inspector actions to read current state).

---

## 5. Providers

All built-in providers live in `packages/context-broker/src/`. Each implements the
`ContextProvider` interface from `crp-provider-utils.ts`:

```ts
interface ContextProvider {
  readonly providerId: string;
  readonly categories: readonly ContextSourceCategory[];
  readonly refresh: "on-turn" | "on-change" | "manual";
  readonly trustTier: "builtin" | "project" | "user";
  readonly sync: (input: ProviderSyncInput) => Promise<readonly string[]>; // returns touched IDs
}
```

### Salience heuristic (`deriveSalience`)

Shared by all providers (`crp-provider-utils.ts`):

```ts
function deriveSalience({ base, ageTurns, length }): number {
  const recencyDecay = ageTurns !== undefined ? Math.max(0, 1 - ageTurns * 0.15) : 1;
  const lengthSignal = Math.min(0.2, length / 2000);
  return clamp(base * recencyDecay + lengthSignal, 0, 1);
}
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

Older entries (`ageTurns`) decay by 15%/step; longer content gets a small bump up to
+0.2. Each provider picks a different `base` depending on how authoritative its
source is.

### The 5 providers

| # | Provider | File | Scans | Category | `base` salience | Notes |
|---|---|---|---|---|---|---|
| 1 | `workspace-guidance` | `crp-workspace-provider.ts` | Cached guidance summary lines (`AGENTS.md`, `CLAUDE.md`, etc.) | `workspace-guidance` | `0.7` | `refresh: on-change`. Raw guidance text never leaks into the packet — label is generic, content is a safe placeholder. |
| 2 | `bridge` | `crp-providers.ts` | `listProjectBridgeLines(cwd)` | `bridge` | `0.65` | Lines arrive newest-first; earlier index → higher salience. |
| 3 | `loop-trail` | `crp-providers.ts` | `loadOmoContextSnapshot(cwd)` — goals + criteria (included); excluded artifacts (held back) | `loop-trail` | `0.75` | Excluded artifacts upserted with `includedInModel: false`; labels never reveal raw `.omo/` paths. |
| 4 | `memory` | `crp-providers.ts` | `listScopedMemoryLines` for `session` + `project` scopes | `memory` | `0.6` | Injected as a constructor dependency (pure-TS, testable). |
| 5 | `runtime` | `crp-providers.ts` | In-memory trace buffer (`pushTraceLine`) | `runtime` | `0.55` | Caps at last 12 lines (`MAX_TRACE`). Newest line ranks highest (`ageTurns = total - 1 - i`). |

### Registry

`ContextProviderRegistry` runs all registered providers sequentially and returns the
concatenated touched IDs:

```ts
class ContextProviderRegistry {
  constructor(store: AgentOpsStore, projectId: string);
  register(provider: ContextProvider): void;
  async syncAll(input: Omit<ProviderSyncInput, "store" | "projectId">): Promise<readonly string[]>;
  listProviders(): readonly ContextProvider[];
}
```

`createBuiltinProviderRegistry(store, projectId, listScopedMemoryLines)` wires all 5
built-ins and exposes the runtime provider for `pushTraceLine`:

```ts
const registry = createBuiltinProviderRegistry(store, projectId, listScopedMemoryLines);
registry.runtime.pushTraceLine("some trace event");
await registry.syncAll({ cwd, sessionId });
```

---

## 6. Selector

`selectContextSources` (`packages/agentops-db/src/store-context-reads.ts`) is a
two-stage pipeline: **rank**, then **greedy budget fit**.

### Stage 1 — Rank (SQL)

```sql
SELECT * FROM context_sources
WHERE project_id = ?
  AND (expires_at IS NULL OR expires_at > ?)   -- not expired
  AND salience >= ?                              -- minSalience (default 0)
  AND category IN (?, ?, ...)                   -- optional categoryFilter
ORDER BY salience DESC, updated_at DESC;
```

Ties in salience break by recency (`updated_at` desc).

### Stage 2 — Greedy budget fit (TypeScript)

Walk the ranked list, partitioning into `selected` vs `heldBack`:

```ts
for (const record of allRecords) {
  if (!record.includedInModel) {          // (a) held back locally → excluded
    heldBack.push(record); continue;
  }
  if (selected.length > 0                 // (b) the top source is ALWAYS included,
      && totalTokens + record.tokenEstimate > tokenBudget) {  // even if it alone exceeds budget
    heldBack.push(record); continue;
  }
  selected.push(record);
  totalTokens += record.tokenEstimate;
}
```

**Key rule:** the single highest-ranked eligible source is never silently dropped,
even if its `token_estimate` alone exceeds the budget. This guarantees the most
relevant context always reaches the model.

### Projecting to `ContextPacketView` (`packages/context-broker/src/crp-selector.ts`)

`selectContextPacketFromStore(options)` wraps `selectContextSources` and maps the
result into the existing `ContextPacketView` shape so downstream consumers need no
changes:

```ts
function selectContextPacketFromStore(options: {
  store: AgentOpsStore;
  projectId: string;
  tokenBudget: number;
  turnIndex: number;
  warnings?: readonly ContextPacketViewWarning[];
  preview?: readonly string[];
  title?: string;
}): ContextPacketView;
```

It also:
- Calls `markContextSourceTurnSeen` on every included item (so `turn_last_seen` advances).
- Runs `compactHeldBackItems` on the excluded list: if there are more than 8 loop-trail
  held-back items, evidence transcripts are summarized into a single count item rather
  than listed individually.

`contextSourceToPacketItem(record)` does the field mapping — note the synthetic
category rewrite: `system` + id prefix `provider-system-prompt-` →
`provider-system-prompt`; everything else passes through.

---

## 7. Configuration

CRP is controlled by two settings resolved through the standard config-core chain.

### The two settings

| Setting | Type | Default | Env var |
|---|---|---|---|
| `context.crp` | boolean | `true` (`CONFIG_CORE_DEFAULT_CONTEXT_CRP`) | `UNCLECODE_CRP` |
| `context.crpBudget` | number (tokens) | `32000` (`CONFIG_CORE_DEFAULT_CONTEXT_CRP_BUDGET`) | `UNCLECODE_CRP_BUDGET` |

### Three ways to set them

1. **Environment variables** — `UNCLECODE_CRP` (`0` / `false` / `off` disables; anything
   else enables) and `UNCLECODE_CRP_BUDGET` (positive integer). Folded into the env
   config layer in `packages/config-core/src/resolver.ts` (`buildEnvironmentLayer`).
2. **Config file** (`config.json`) — `~/.unclecode/config.json` (user) or
   `<workspace>/.unclecode/config.json` (project):
   ```json
   {
     "context": {
       "crp": false,
       "crpBudget": 16000
     }
   }
   ```
3. **Built-in default** — `crp: true`, `crpBudget: 32000`.

### Precedence (low → high)

Resolved in `collectModeSources` (`packages/config-core/src/resolver.ts`); later
sources override earlier:

```
built-in defaults  →  plugin overlays  →  project config  →  user config
                  →  environment (UNCLECODE_*)  →  CLI flags
```

So `UNCLECODE_CRP=0` overrides `~/.unclecode/config.json`, which overrides the default.

### How the bootstrap reads it

`apps/unclecode-cli/src/work-runtime-crp.ts`:

```ts
export function resolveWorkShellCrpConfig(explanation: UncleCodeConfigExplanation) {
  return {
    enabled: explanation.settings.crp.value,
    tokenBudget: explanation.settings.crpBudget.value,
  };
}
```

The values come from the fully-resolved `UncleCodeConfigExplanation` (built in
`loadWorkCliBootstrap` via `explainUncleCodeConfig`), so the precedence above is
already applied.

---

## 8. Integration

CRP slots into the engine as a **wrapper** around the legacy in-memory resolver.
The bootstrap never calls CRP directly — it wraps the legacy resolver with
`createCrpAwareContextPacketResolver`.

### `createCrpAwareContextPacketResolver` (`work-runtime-crp.ts`)

```ts
function createCrpAwareContextPacketResolver(
  legacy: WorkShellContextPacketResolver,
  bootstrap: {
    sourceMetadata: readonly ContextPacketViewItem[];
    bootstrapPacketItems?: readonly ContextPacketViewItem[];
    bootstrapPacketWarnings?: readonly ContextPacketViewWarning[];
    crpConfig: WorkShellCrpConfig;        // { enabled, tokenBudget }
    env?: NodeJS.ProcessEnv;
    userHomeDir?: string;
  },
): WorkShellContextPacketResolver;
```

Per-turn behavior:

1. **Gate.** If `crpConfig.enabled === false`, immediately delegate to `legacy(input)`.
   CRP is off → zero behavior change.
2. **Lazy init.** First call creates a fresh `AgentOpsStore`, derives a stable
   `projectId` (`sha256(cwd)[:16]`), registers a `projectId` row, and builds the
   builtin provider registry. This state is cached across turns.
3. **Push trace.** Forwards every `input.traceLines` entry to
   `registry.runtime.pushTraceLine`.
4. **Sync providers.** `await registry.syncAll({ cwd, sessionId, env, userHomeDir })`
   upserts all 5 providers' rows.
5. **Upsert packet metadata as sources.** Three fixed-salience buckets are pushed
   directly into the store (these are the sources the legacy resolver would have
   inlined): `sourceMetadata` @ `0.95`, context summary items @ `0.9`, bootstrap
   packet items @ `0.8`.
6. **Select + project.** `selectContextPacketFromStore({ store, projectId,
   tokenBudget, turnIndex, warnings })` returns the final `ContextPacketView`.
7. **Fallback.** Any thrown error is caught, logged to stderr as
   `[crp] fallback to legacy resolver: <message>`, and `legacy(input)` is returned.
   CRP failures never break the session.

### Where it's wired (`loadWorkCliBootstrap`, `work-runtime-bootstrap.ts`)

```ts
resolveContextPacket: createCrpAwareContextPacketResolver(
  createWorkShellContextPacketResolver({        // ← the legacy fallback
    sourceMetadata: contextPacketSourceMetadata,
    bootstrapPacketItems: bootstrapContext.packetItems,
    bootstrapPacketWarnings: bootstrapContext.packetWarnings,
  }),
  {
    sourceMetadata: contextPacketSourceMetadata,
    crpConfig: resolveWorkShellCrpConfig(configExplanation),
    env,
    ...(userHomeDir ? { userHomeDir } : {}),
    ...bootstrapContext.packetItems  ? { bootstrapPacketItems:  ... } : {},
    ...bootstrapContext.packetWarnings ? { bootstrapPacketWarnings: ... } : {},
  },
),
```

The returned resolver is handed to the work agent as `options.resolveContextPacket`,
called once per turn. The TUI Runbook and `composeWorkShellTurnPromptFromPacket`
consume the resulting `ContextPacketView` unchanged — the SQL layer slots below the
existing boundary.

---

## 9. Testing

Tests use the Node built-in test runner (`node:test`) with `tsx`.

### Store tests — `tests/agentops-db/context-sources.test.mjs`

Run:

```bash
npm run test:agentops-db
# or directly:
node --disable-warning=ExperimentalWarning --conditions=source --import tsx \
  --test tests/agentops-db/context-sources.test.mjs
```

Covers:
- Schema version is 2
- `upsertContextSource` round-trips through `selectContextSources`
- Upsert idempotency (same `id` updates, no duplicates)
- Salience-desc ranking, with recency tiebreak
- Budget controller holds back sources that exceed remaining budget
- Top-ranked source always included even if it alone exceeds budget
- `included_in_model = false` → `heldBack`
- Expired sources pruned and excluded
- `markContextSourceTurnSeen` updates `turn_last_seen`
- `categoryFilter` narrows selection
- Inspector actions: `pin` (→ `1.0`), `unpin` (→ `0.5`), `forget` (→ held back),
  `include` (→ restored)

### Provider + selector tests — `tests/context-broker/crp-providers.test.mjs`

Run:

```bash
npm run test:context-broker
# or directly:
node --disable-warning=ExperimentalWarning --conditions=source --import tsx \
  --test tests/context-broker/crp-providers.test.mjs
```

Covers:
- `RuntimeProvider`: recency-based salience, `MAX_TRACE` cap (last 12), `clearTrace`
- `MemoryProvider`: upserts scoped memory lines (uses a fake `listScopedMemoryLines`)
- `LoopTrailProvider`: empty `.omo` dir handled gracefully; goals upserted + excluded
  artifacts held back (and labels never leak `.omo/` paths)
- `createBuiltinProviderRegistry` registers all 5 providers
- `registry.syncAll` runs memory + runtime (deterministic subset; workspace-guidance
  is skipped because it shells out to the Rust binary)
- `selectContextPacketFromStore`: produces a `ContextPacketView`, respects token
  budget, marks `turn_last_seen`
- `contextSourceToPacketItem`: field mapping

Run everything CRP touches:

```bash
npm run test:agentops-db && npm run test:context-broker
```

---

## 10. Troubleshooting

### CRP doesn't seem to be active / packets look like the old behavior

- Check `crp` is enabled: the Runbook prints `- crp = <value>` and the winning source.
  Or run the bootstrap with `UNCLECODE_CRP=1` to force it on.
- `createCrpAwareContextPacketResolver` falls back to legacy silently on any thrown
  error. Look for `[crp] fallback to legacy resolver: <message>` on **stderr** — that's
  the smoking gun.
- CRP is off by default only if a config layer set `context.crp: false`. Remember the
  precedence chain (§7): env beats user config beats project config.

### `Unknown project: <id>` error

`upsertContextSource` throws if `projectId` isn't in the `projects` table. The
bootstrap creates the project row on first turn
(`store.addProject({ id: projectId, ... })` with `projectId = sha256(cwd)[:16]`).
If you're calling the store directly in a test, seed a project first:

```ts
store.addProject({ id: "proj_test", name: "Test", repoPath: "/repos/test" });
```

### Sources never get selected (always held back)

Common causes:
- `included_in_model = 0` — someone called `forgetContextSource(id)`, or a provider
  (e.g. loop-trail for excluded artifacts) upserted with `includedInModel: false`.
  Call `includeContextSource(id)` to restore.
- `salience < minSalience` — `selectContextSources` defaults `minSalience` to `0`,
  but a caller may pass a higher floor.
- `expires_at` in the past — run `pruneExpiredContextSources()` or fix the expiry.

### The top source exceeds budget and crowds out everything else

By design the highest-ranked eligible source is **always** included even if its
`token_estimate` alone exceeds the budget (§6). If a single giant source is starving
out the rest, either lower its `salience`, raise `crpBudget`, or split the content
into smaller rows. Pinning (`pinContextSource` → salience `1.0`) makes a source the
guaranteed top — use it deliberately.

### SQL errors on a fresh database

The `context_sources` table is created by schema version 2. If you see "no such
table", the migration didn't apply — check `schema_migrations`:

```sql
SELECT version, name FROM schema_migrations ORDER BY version;
```

A fresh DB records versions 1 and 2 immediately. An existing DB at version 1 runs the
`add_context_sources` incremental migration. The migration is idempotent
(`CREATE TABLE IF NOT EXISTS`), so re-running is safe.

### Provider sync is slow / shells out

Only `workspace-guidance` shells out (to the Rust guidance binary). The provider
tests skip it for this reason. If sync latency is a problem in dev, register a subset
registry manually instead of `createBuiltinProviderRegistry`.

### Loop-trail held-back list is huge

`selectContextPacketFromStore` already collapses loop-trail held-back items beyond the
`OMO_EXCLUDED_DETAIL_LIMIT` (8) into count summaries (§6). If you're calling
`selectContextSources` directly you bypass that compaction — call
`compactHeldBackItems` (or use `selectContextPacketFromStore`) for the operator view.
