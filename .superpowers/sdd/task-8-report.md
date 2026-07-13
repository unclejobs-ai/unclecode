# Task 8 Report: Implement the Deterministic Optimizer

## Status
DONE

## Commits
- `8968956` feat(context): add deterministic packet optimizer
- `7cf417c` fix(context): canonicalize mandatory policy sources
- `bf49531` fix(context): prune guidance sources safely

## Implemented
- Added `evaluateContextPolicy({ receipt, packet })` for metadata-only evaluation of a submitted packet receipt against current packet item metadata.
- Enforced receipt state `submitted` and exact receipt/packet ID agreement before evaluation.
- Implemented the specified per-source precedence:
  1. mandatory guidance → `keep` / `mandatory-guidance`
  2. expired source → `refresh` / `expired-source`
  3. stale condensed history → `summarize` / `stale-condensed-history`
  4. duplicate SHA after the first included ordered occurrence → `hold-back` / `duplicate-fingerprint`
  5. explicitly classified external/runtime source above the strict 20% packet-token threshold → `hold-back` / `low-trust-token-hotspot`
- Evaluated included receipt refs only; held-back sources do not influence duplicate or hotspot advice.
- Disabled percentage advice when the submitted receipt token total is unknown.
- Derived mandatory IDs from the packet's persisted prompt-manifest policy.
- Canonicalized configured-prompt and workspace-guidance source IDs at packet/policy production boundaries; provider-owned cleanup removes obsolete positional/canonical rows while preserving metadata-missing fallback rows.
- Compared the 20% threshold with exact safe-integer `BigInt` arithmetic rather than floating multiplication.
- Generated stable collision-resistant IDs from receipt/source/action SHA-256 input; no random UUIDs.
- Used the receipt creation timestamp, so identical input produces deep-equal output.
- Sorted by action priority `refresh`, `summarize`, `hold-back`, `keep`, then known savings descending, unknown savings after known, then source ID and ID.
- Kept savings undefined for `keep`, `refresh`, and unknown source estimates; used item token estimates for summarize/hold-back advice.
- Used fixed reason text and metadata-only fields; packet labels, reasons, and previews never enter suggestions.
- Exported the evaluator through the orchestrator package barrel.

## TDD Evidence

### RED
```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/context-policy-evaluator.test.mjs
```

Observed before implementation:
```text
ERR_MODULE_NOT_FOUND: context-policy-evaluator.ts
# tests 1
# pass 0
# fail 1
```

### GREEN
```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/context-policy-evaluator.test.mjs
```

```text
# tests 17
# pass 17
# fail 0
```

### GREEN — classifier and production ID regressions
```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/context-policy-evaluator.test.mjs tests/orchestrator/context-packet-change.test.mjs
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-name-pattern="returns prompt plus|represents configured" tests/work/work-runtime.test.mjs
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/context-broker/crp-providers.test.mjs
```

```text
# classifier/evaluator tests 30 · pass 30 · fail 0
# production bootstrap tests 2 · pass 2 · fail 0
# context provider tests 16 · pass 16 · fail 0
```

### Diagnostics
- `context-policy-evaluator.ts`: LSP `OK`.
- `packages/orchestrator/src/index.ts`: LSP `OK`.
- `apps/unclecode-cli/src/work-runtime-bootstrap.ts`: LSP `OK`.
- `apps/unclecode-cli/src/work-runtime-crp.ts`: LSP `OK`.
- `packages/context-broker/src/crp-workspace-provider.ts`: LSP `OK`.

## Files changed
- `apps/unclecode-cli/src/work-runtime-bootstrap.ts`
- `apps/unclecode-cli/src/work-runtime-crp.ts`
- `packages/context-broker/src/crp-workspace-provider.ts`
- `packages/orchestrator/src/context-policy-evaluator.ts`
- `packages/orchestrator/src/index.ts`
- `tests/orchestrator/context-policy-evaluator.test.mjs`
- `tests/context-broker/crp-providers.test.mjs`
- `tests/work/work-runtime.test.mjs`

## Self-review
- Every required rule has a table-driven assertion.
- A combined fixture proves each higher-priority rule wins over duplicate-SHA eligibility.
- Strict threshold equality, held sources, and unknown packet totals produce no hotspot suggestion.
- Safe-integer boundary coverage proves exact `sourceTokens * 5 > packetTokens` semantics without floating-point rounding.
- All five trust tiers are table-covered; `external` and `runtime` are explicitly low-trust while `builtin`, `project`, and `user` are not.
- Production bootstrap tests prove mandatory manifest IDs equal configured-prompt and workspace-guidance packet source IDs.
- Provider regressions prove fallback guidance survives without source metadata and removed `workspace-guidance-`, `guidance:`, and `skill:` rows are pruned after subsequent syncs.
- Sorting tests discriminate action priority, descending known savings, known-before-unknown, and source-ID tie-breaking.
- Repeated evaluation is deep-equal; IDs have deterministic digest form and differ across inputs.
- Submitted-state and receipt/packet identity mismatches fail closed.
- A raw packet-content sentinel in label, reason, and preview is absent from serialized suggestions.
- No dependencies, model calls, random values, or raw content fields were added.

## Concerns
- Workspace-wide build/check are reserved for Task 13 by the approved execution workflow; Task 8 ran its focused evaluator suite.
- Delegated implementation endpoints remained unavailable with `401 invalid x-api-key`, so Task 8 was completed directly in the parent session after the Task 7 retries established the environment failure.
