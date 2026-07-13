# Task 7 Report: Persist Context Optimizer Suggestions

## Status
DONE

## Commits
- `ccb5d64` feat(context): persist optimizer suggestions
- `768e009` fix(context): gate stale advice on invalidation

## Implemented
- Added schema migration 7 and fresh-schema parity for `context_policy_suggestions`.
- Added the receipt/status/creation index specified by the plan.
- Added typed AgentOps DB methods:
  - `addContextPolicySuggestion`
  - `resolveContextPolicySuggestion`
  - `markContextPolicySuggestionsStale`
  - `listContextPolicySuggestions`
- Restricted explicit resolution to `accepted` and `rejected` and guarded all transitions from `proposed` only.
- Implemented receipt-wide stale transition as one SQL `UPDATE` that touches only proposed rows whose receipt is already invalidated.
- Preserved nullable `estimated_token_saving` as `undefined` in the TypeScript contract.
- Ordered lists deterministically by `created_at ASC, id ASC`.
- Kept suggestions tied to valid packet receipts through the foreign key and persisted only declared metadata columns.
- Wired the method factory into `createAgentOpsStore`, the `AgentOpsStore` interface, and the package barrel.

## TDD Evidence

### RED
```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs
```

Observed before implementation:
```text
# tests 26
# pass 23
# fail 3
6 !== 7
store.addContextPolicySuggestion is not a function
```

### GREEN — focused lifecycle suite
```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs
```

```text
# tests 26
# pass 26
# fail 0
```

### GREEN — AgentOps DB package suite
```bash
npm run test:agentops-db
```

```text
# tests 29
# pass 29
# fail 0
```

### Diagnostics
- `store-context-suggestions.ts`: LSP `OK`.
- `store.ts`: LSP `OK`.
- `store-types.ts`: LSP `OK`.
- `schema-sql.ts`: LSP `OK`.
- `index.ts`: LSP `OK`.

## Files changed
- `packages/agentops-db/src/schema-sql.ts`
- `packages/agentops-db/src/store-context-suggestions.ts`
- `packages/agentops-db/src/store-types.ts`
- `packages/agentops-db/src/store.ts`
- `packages/agentops-db/src/index.ts`
- `tests/agentops-db/context-sources.test.mjs`

## Self-review
- Tests cover fresh schema version 7, direct v6→v7 upgrade, and v5→latest migration chaining.
- Both accepted and rejected transitions are covered; a second resolution fails closed.
- Bulk stale is a no-op for active receipts, then updates only still-proposed rows after receipt invalidation; resolved and unrelated-receipt rows remain unchanged, and retries are idempotent.
- Nullable savings round-trip without becoming zero.
- Equal creation timestamps inserted in reverse lexical order prove deterministic ID tie-breaking.
- A raw-context sentinel passed as an undeclared input field is absent from the SQLite row.
- Missing receipt IDs fail the foreign-key constraint.
- No dependencies or raw context content fields were added.

## Concerns
- Workspace-wide build/check are intentionally deferred to Task 13: the approved execution workflow overrides per-task broad commands and reserves broad verification for the final task. Task 7 ran its focused file and full `test:agentops-db` package suite.
- Two delegated implementation attempts failed before editing because their external model endpoint returned `401 invalid x-api-key`; Task 7 was completed directly in the parent session.
