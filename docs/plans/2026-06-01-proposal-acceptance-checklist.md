# §5.5–§5.7 Proposal Acceptance Checklist

**Source proposal:** `docs/proposals/2026-04-28-team-mode-and-mini-loop-feasibility.md` §5.5 (Persistent Bindings), §5.6 (SSOT), §5.7 (ACI)

**Generated:** 2026-06-01
**Status:** Verification snapshot — update by running `npm run provenance:check` and reading this file.

This file turns the proposal's three design sections into verifiable acceptance
criteria. Each row maps a claim to a code anchor and a verification command.
Rows marked `[done]` already have a test or runtime signal; `[partial]` have
surface code but no end-to-end check yet; `[missing]` have neither.

## §5.5 Persistent Bindings (RUN_ID 묶음)

| # | Acceptance criterion | Status | Code anchor | Verify |
|---|---|---|---|---|
| 5.5.1 | One RUN_ID binds manifest + checkpoint NDJSON + per-worker NDJSON + reviews + UDS + mmbridge session | partial | `packages/orchestrator/src/team-binding.ts`, `team-mini-loop.ts` | `npm run test:orchestrator` (smoke only) |
| 5.5.2 | `team-run-store` package owns disk persistence for run records | missing | (in `team-binding.ts` ad-hoc) | `rg -l "team-run-store" packages` → empty |
| 5.5.3 | Unix Domain Socket lane channel between conductor and worker | missing | none | `rg -l "UdsSocket\|unix.*socket" rust/unclecode-core` → empty |
| 5.5.4 | Reuses `SessionCheckpoint` from `packages/session-store` | partial | `packages/session-store/src/checkpoint.ts` | `npm run test:session-store` |
| 5.5.5 | Reuses `context-broker` for shared context snapshot | done | `packages/context-broker/src/context-packet.ts` | `npm run test:context-broker` |
| 5.5.6 | Reuses `openai-credential-store` for shared auth across lanes | done | `packages/providers/src/openai-credential-store.ts` | `npm run test:providers` |
| 5.5.7 | `disk-backed ownership registry` for file-edit arbitration across lanes | done | `packages/orchestrator/src/disk-ownership-registry.ts` | unit test in `tests/orchestrator/team-adapters/` |
| 5.5.8 | `mmbridge` session can be resumed by RUN_ID after crash | missing | (no code path) | manual: kill team run, restart, observe `mmbridge` session id reuse |

## §5.6 SSOT (Single Source of Truth, anti-silo, anti-hallucination)

| # | Acceptance criterion | Status | Code anchor | Verify |
|---|---|---|---|---|
| 5.6.1 | One owner per category; `cite = (key, versionHash)` | partial | `packages/contracts/src/ssot.ts` | contract test in `tests/contracts/ssot.test.mjs` |
| 5.6.2 | Writes require `prevTipHash` CAS | done | `packages/orchestrator/src/disk-ownership-registry.ts` (CAS chain) | `tests/orchestrator/team-adapters/disk-ownership.test.mjs` |
| 5.6.3 | Append-only log with `sha256` chain | done | `packages/orchestrator/src/team-binding.ts` (uses `sha256` from `rust/unclecode-core/src/sha256.rs`) | `cargo test --workspace sha256` |
| 5.6.4 | Code ground truth = git working tree (no duplicate truth store) | done | policy in `packages/policy-engine/src/decision-table.ts` (read-only check) | `tests/policy-engine/` |
| 5.6.5 | `citation-enforcer` rejects answers without `(key, versionHash)` | done | `packages/orchestrator/src/hooks/citation-enforcer.ts` | `tests/orchestrator/hooks/citation-enforcer.test.mjs` |

## §5.7 ACI (Agent-Computer Interface, SWE-agent NeurIPS 2024)

| # | Acceptance criterion | Status | Code anchor | Verify |
|---|---|---|---|---|
| 5.7.1 | Line-anchored edit (not character-offset) | done | `packages/orchestrator/src/aci/file-editor.ts` (TS) + `rust/unclecode-core/src/aci_edit.rs` (Rust) | `tests/orchestrator/aci/file-editor.test.mjs`, `cargo test --workspace aci_edit` |
| 5.7.2 | Linter guardrail post-edit (TypeScript / Biome) | done | `packages/orchestrator/src/aci/file-editor.ts` (runs `biome check`) | `tests/orchestrator/aci/lint-guard.test.mjs` |
| 5.7.3 | Summarized search with 50-result cap | done | `packages/orchestrator/src/aci/search.ts` + `rust/unclecode-core/src/aci_search.rs` | `tests/orchestrator/aci/search-cap.test.mjs` |
| 5.7.4 | Patch (unified diff) apply with `parse_unified_diff` validation | done | `packages/orchestrator/src/aci/apply-patch.ts` + `rust/unclecode-core/src/aci_patch.rs` | `tests/orchestrator/aci/apply-patch.test.mjs` |
| 5.7.5 | Path containment using NFC-normalised absolute paths | done | `packages/orchestrator/src/aci/path-containment.ts` | `tests/orchestrator/aci/path-containment.test.mjs` |
| 5.7.6 | File view with truncation for large files | done | `packages/orchestrator/src/aci/file-viewer.ts` | `tests/orchestrator/aci/file-viewer.test.mjs` |
| 5.7.7 | Observation collapsing for repeated tool results | partial | (no central hook; each caller collapses ad-hoc) | `rg "collapseObservations\|observation_collapse" packages` → ad-hoc only |
| 5.7.8 | Symlink-trap regression coverage for `write_file` and `apply_patch` | done | added in commit `cd804c4` | `tests/orchestrator/aci/symlink-trap.test.mjs` |

## Quick verification

```bash
# Run all orchestrator + contract tests
npm run test:orchestrator
npm run test:contracts

# Run all Rust unit tests
cargo test --workspace

# Provenance
npm run provenance:check
```

## How to update this file

When you finish a `[missing]` row:

1. Implement the change.
2. Add the verifying test path in the "Verify" column.
3. Flip status from `[missing]` to `[done]` (or `[partial]` if coverage is incomplete).
4. Commit the doc update with the implementation commit.
