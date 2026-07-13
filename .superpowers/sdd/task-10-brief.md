# Task 10: Persist Memory Lineage

**Files:**
- Modify: `packages/agentops-db/src/schema-sql.ts`
- Create: `packages/agentops-db/src/store-memory-lineage.ts`
- Modify: `packages/agentops-db/src/store-types.ts`
- Modify: `packages/agentops-db/src/store.ts`
- Modify: `packages/agentops-db/src/index.ts`
- Test: `tests/agentops-db/context-sources.test.mjs`

**Contract:**
- Consume `MemoryLineageRecord` and `RecordMemoryLineageInput` from `@unclecode/contracts`.
- Expose through `AgentOpsStore`:
  - `recordMemoryLineage(input): MemoryLineageRecord`
  - `supersedeMemoryLineage(memoryId): MemoryLineageRecord`
  - `expireMemoryLineage(now?: Date): number`
  - `getMemoryLineage(memoryId): MemoryLineageRecord | undefined`
  - `listActiveMemoryLineage(): readonly MemoryLineageRecord[]`
- Migration 8 creates `memory_lineage` exactly as the plan specifies, including the receipt and predecessor foreign keys plus state/confidence checks and state/source indexes.
- Bump `AGENTOPS_SCHEMA_VERSION` to 8 and preserve clean upgrade from version 7.

**Behavior:**
- A normal record inserts one lineage row after validating required IDs, state, confidence, and optional expiry.
- A record with `supersedesMemoryId` runs one `BEGIN IMMEDIATE` transaction: verify the predecessor exists and is `active`, mark it `superseded`, insert the new row, then commit. Any failure rolls back both changes.
- `supersedeMemoryLineage` changes exactly one active row and rejects missing/already-terminal rows.
- `expireMemoryLineage(now)` changes only active rows whose non-null `expires_at <= now`, returning the affected count.
- `listActiveMemoryLineage` returns deterministic `created_at ASC, memory_id ASC` order.
- Persist metadata only. No memory body, prompt, or source content columns.

**Tests first:**
1. Add a failing atomic predecessor transition test from the plan.
2. Add rollback coverage: a replacement insert that fails must leave the predecessor active.
3. Add expiry boundary coverage and prove superseded rows stay superseded.
4. Add get/list deterministic behavior and migration 7→8 coverage.
5. Run only `node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs`.

**Non-goals:**
- Do not modify context-broker promotion yet; that is Task 11.
- Do not add dependencies, compatibility shims, raw-memory persistence, or unrelated cleanup.
- Do not run formatters, linters, workspace-wide tests, build, or check; the parent agent owns final verification.
