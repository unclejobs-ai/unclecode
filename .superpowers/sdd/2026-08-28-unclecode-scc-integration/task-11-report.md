# Task 11 report — held-out differentiation and integrated proof

- Date: 2026-08-30
- UncleCode snapshot: `5d91eafd`
- SCC snapshot: `8d0fa2e`
- Status: offline numeric gates pass; integrated release proof remains `unproven` pending the final immutable matrix and independent reviews

## Product claim boundary

The implemented distinction is the execution harness, not a claim that one model is intrinsically better. One persistent UncleCode owner coordinates provider routing, context, permissions, queues, sessions and artifacts; the in-process SCC Quality Engine supplies explicit PDCA stages, evidence-bound critic gates, bounded refine/pivot and isolated evolve proposals. TUI and web project that same runtime state.

A successful worker response is not a proven result. An independent critic must review the current artifact hash; a mutation invalidates the verdict. If independent-provider proof is unavailable, the state is `unproven`. `promote` prepares the handoff and never performs merge, publish, release or deployment.

## Immutable held-out suite

- Suite: `unclecode-held-out-v1`, version `1.0.0`.
- Manifest SHA-256: `sha256:10ba37dc907baca72710e44a4aa7c34a481521b2548bf204894f9305b0cf88cd`.
- Cases: 40 total; code 10, content 10, analysis 10, workflow 10.
- Supplied baseline commit: `d8027bb0d17327528a7b95ed84f50a9eb89ce5f2`.
- Protected asset hashes:
  - baseline: `sha256:1e1fce45e951157e9c645e2be825baea9e89bea46d5d002f96ea9e7980d63f06`
  - cases: `sha256:6483ece50a9b4c42d5de4acc256eb0c7270a942cd212ce3c3a091a67688c2588`
  - evaluator: `sha256:d7ee4e8dcc21e8fa3dd06252ef7937b9c04943b2c040c5406d33f9aba1fe21af`
  - thresholds: `sha256:e41d42eeb1de7b1617f0e642bdbe25588c735a6dfc721db85d73641b4b2fbe1e`

The candidate cannot edit or choose these assets. The creator runtime consumes a host-produced proof that binds suite, candidate, evaluator and attestor identities. A creator/evaluator/attestor or three-provider live proof is not inferred from the offline fixture.

## Offline comparison

Command:

```text
node scripts/held-out-benchmark.mjs --json --require-proven
```

The command returns exit code 1 because `--require-proven` rejects the deliberately unproven integrated state. The numeric comparison itself passes every frozen threshold.

| Metric | Baseline | Quality Engine candidate | Delta |
| --- | ---: | ---: | ---: |
| Overall quality | 70.45% | 79.25% | +8.8pp |
| Code | 69.9% | 79.0% | +9.1pp |
| Content | 71.4% | 79.8% | +8.4pp |
| Analysis | 68.0% | 77.4% | +9.4pp |
| Workflow | 72.5% | 80.8% | +8.3pp |
| Frontier tokens | 40,990 | 16,395 | -60.00244% |
| Total tokens | 83,570 | 68,840 | -14,730 |
| Cache hit rate | 28.5% | 69.25% | +40.75pp |
| Mean latency | 1,219.875 ms | 914.75 ms | -305.125 ms |
| p95 latency | 1,510 ms | 1,120 ms | -390 ms |
| Retained memory allocation | 580,000 B | 448,000 B | -132,000 B |

Computed gates:

- overall improvement `+8.8pp >= +5pp`: pass;
- no domain regression worse than `-2pp`: pass; every domain improved;
- frontier reduction `60.00244% >= 50%`: pass;
- critic proof `40/40`: pass.

These are deterministic offline fixture measurements. They are not described as live model quality, live provider cost or production latency.

## Honest integrated verdict

`integratedProof.status` is `unproven` with exactly these reasons:

```text
BASELINE_IS_OFFLINE_FIXTURE
CANDIDATE_IS_OFFLINE_FIXTURE
LIVE_PROVIDER_RUN_NOT_RECORDED
FULL_VERIFICATION_MATRIX_NOT_PROVEN
INDEPENDENT_FINAL_REVIEW_NOT_PROVEN
```

Therefore the current evidence proves the offline differentiation gate but does not authorize a release-quality claim, creator promotion or automatic merge.

## Architecture, security and consistency closure included in the candidate

- Single runtime ownership and monotonic projections are enforced through `5d91eaf`; dashboard/Web critic data is read from the owning session rather than a competing registry.
- Deep research traverses the SCC WorkGraph/critic/promote lifecycle; same-provider review is `unproven`.
- Plugin invocation diagnostics are sanitized at the host boundary; per-plugin snapshots and final host-owned completion validation prevent a later workspace plugin from mutating already-validated SCC state.
- Executable Git, shell callbacks, project hooks, release actions and delegated workspace tools are permission-gated/contained. Workspace plugins remain trust-gated.
- Decision buttons and typed answers bind the exact decision ID; shutdown fences queue drains and settles provider/tool children.
- Quality projections and creator proposals are monotonic, hash-bound and freshness-checked. A creator candidate cannot rewrite its evaluator, policy, corpus or threshold.
- Context Rust transport, provider subprocess environments and persistence finalization are bounded and cleaned.

## Memory/cache evidence carried from Task 10

The forced-GC runtime soak recorded heap delta `+2,536,296` bytes, handles `2 -> 2`, file descriptors `18 -> 18`, at most 256 of 768 sessions retained before owner shutdown, zero afterward, and full endpoint/lease/temp cleanup. Runtime caches expose hit/miss/eviction/invalidation/entry/byte telemetry; TUI text and markdown render caches now enforce retained-byte budgets.

This local soak is evidence for bounded behavior, not a substitute for the final cross-suite matrix. The Task 10 report also retains the missing single 100k end-to-end publication run as a limitation.

## Final verification matrix

The final matrix owner must replace the following markers with immutable-archive commands, counts and verdicts. They are intentionally not guessed from earlier focused runs.

- UncleCode full Node matrix: **AWAITING_FINAL_MATRIX_EVIDENCE**
- Rust workspace check/tests: **AWAITING_FINAL_MATRIX_EVIDENCE**
- SCC Node 20/22 suite, shared core fixture and deterministic tar/checksum: **AWAITING_FINAL_MATRIX_EVIDENCE**
- TUI 60/80/100/140, CJK/emoji/IME/prompt/Ctrl+O/scroll and built boot smoke: **AWAITING_FINAL_MATRIX_EVIDENCE**
- Server/web auth/origin/SSE/replay/races/owner lifecycle: **AWAITING_FINAL_MATRIX_EVIDENCE**
- SCC v3 dry-run importer, creator containment and cleanup paths: **AWAITING_FINAL_MATRIX_EVIDENCE**
- Exact replay/cache/memory longevity matrix: **AWAITING_FINAL_MATRIX_EVIDENCE**

## Independent review

- Architecture/hierarchy/correctness verdict: **AWAITING_FINAL_REVIEW_EVIDENCE**
- Security and plugin-boundary verdict: **AWAITING_FINAL_REVIEW_EVIDENCE**
- Memory/cache/resource verdict: **AWAITING_FINAL_REVIEW_EVIDENCE**
- SCC core/adapter/release verdict: **AWAITING_FINAL_REVIEW_EVIDENCE**

Task 11 becomes complete only after those exact results are inserted and every Critical/Important finding is closed. Until then, the correct release statement is: offline targets pass; integrated proof is unproven.
