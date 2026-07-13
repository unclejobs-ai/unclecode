# Task 10 Report: Persist Memory Lineage

## Status

DONE

## Commit

- `1f311de` `feat(context): persist memory provenance lineage`

## Implemented

- Added schema migration 8 and fresh-schema support for metadata-only `memory_lineage` rows.
- Added the exact planned indexes:
  - `idx_memory_lineage_state_created (state, created_at DESC)`
  - `idx_memory_lineage_source (source_id, state)`
- Added the receipt provenance foreign key with `ON DELETE RESTRICT`, predecessor self-reference with `ON DELETE SET NULL`, state CHECK, and confidence CHECK.
- Added typed AgentOps methods:
  - `recordMemoryLineage`
  - `supersedeMemoryLineage`
  - `expireMemoryLineage`
  - `getMemoryLineage`
  - `listActiveMemoryLineage`
- Replacement recording uses one `BEGIN IMMEDIATE` transaction: the predecessor must exist and be active, its transition to `superseded` must affect exactly one row, and the successor insert must succeed before commit. Any failure rolls back the predecessor transition.
- Expiry changes only active rows at or before the inclusive cutoff.
- Constrained persisted and cutoff timestamps to fixed-width UTC ISO form so SQLite TEXT ordering remains chronological.
- Active lineage reads are deterministic by `created_at ASC, memory_id ASC`.

## Tests Added

- Atomic active-predecessor replacement.
- Duplicate successor rollback preserving the active predecessor.
- Inclusive expiry while terminal rows retain their prior state.
- Missing and terminal transition rejection without mutation.
- Missing receipt, invalid state, invalid confidence, and expanded-year timestamp rejection.
- Deterministic active listing with no body/prompt/content fields.
- Version 7 to 8 migration with exact columns, foreign-key targets/delete actions, and index column/direction assertions.

## Review

- Focused SQLite lifecycle review initially found one Important index-definition mismatch and three Minor timestamp/schema/transition coverage gaps.
- All findings were corrected and covered by regressions.
- Final reviewer verdict: `No findings`.

## Verification

- Red test before implementation: 6 expected failures for missing version 8 and lineage methods.
- `node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs` -> PASS, 34/34.
- `npm run test:agentops-db` -> PASS, 37/37.
- `npm run build` -> PASS.
- `npm run check` -> PASS.
- LSP diagnostics for the new lineage store and modified AgentOps TypeScript files -> no errors.
