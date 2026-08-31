# SDD ledger — UncleCode × SCC integration

- Plan: `docs/plans/2026-08-28-unclecode-scc-integration.md`
- Snapshot date: 2026-08-30
- UncleCode implementation snapshot: `5d91eafd`
- SCC implementation snapshot: `8d0fa2e`

## Release invariant

The implementation has one runtime hierarchy:

```text
persistent UncleCode runtime owner
  -> session / orchestrator / policy
    -> in-process SCC Quality Engine lifecycle + WorkGraph
      -> TUI and web read projections
```

UncleCode owns providers, context, permissions, sessions, artifacts, queues, execution and lifecycle. SCC contributes host-neutral PDCA, standards, evidence-bound review, refine/pivot and evolve contracts through the pinned `@second-claude/core`. UncleCode does not launch an SCC daemon, SCC MCP process or SCC event/session store.

Security approvals, SCC quality gates and user/product decisions are different types and routes. A worker cannot pass its own result. A reviewer verdict is bound to the reviewed artifact hash and becomes stale after mutation. `promote` is handoff/synthesis, never merge, publish, release or deployment.

## Workspace and preservation

- UncleCode: `/Users/parkeungje/project/unclecode/.worktrees/unclecode-scc-integration`, branch `feat/unclecode-scc-integration`.
- SCC: `/Users/parkeungje/project/second-claude-core-v4`, branch `feat/scc-core-v4`.
- User-owned dirty files and the earlier 2026-08-18 UX plans remain preserved; unrelated generated files are not presented as integration work.
- This ledger coordinates both repositories because UncleCode is the sole runtime/product owner.

## Task status

### Tasks 1–3 — baseline, SCC core and runtime contracts: complete

- Baselines were captured before changes: SCC 562 tests with one expected skip; UncleCode Node/Rust and copied TUI/runtime focus suites passed after the documented scroll expectation correction.
- SCC now publishes strict host-neutral `@second-claude/core` contracts for profiles, stages, PDCA, evidence, gates, projections and evolution proposals with checked ESM/declarations and no install-time build.
- UncleCode added typed lifecycle decisions, quality WorkGraph/trace fields, in-process built-in SCC registration, artifact-hash evidence, independent critic/promote stages, balanced-prewalk routing and DeepSeek provider/catalog support.
- Final SCC snapshot is `8d0fa2e`. UncleCode pins the prebuilt 4.0.0 tarball at SHA-256 `ec2449e6eb87da1b1d286b86b4c686079d616cadfe2e1b4f07365e9b83c97647` (`70886f92`).
- SCC hardening rejects forged reviewer identity, unsigned external review evidence, symlinked crash/StopFailure targets and artifact mutation at completion. Native/external provenance is broker-attested; terminal state is committed before projections.

### Tasks 4–6 — TUI, web and migration: complete, subject to final matrix

- Prompt input works through the actual `bin -> Rust -> Node -> Ink` chain for printable ASCII and committed Korean text; draft editing/submission, busy follow-up input and overlay ownership are covered.
- `Ctrl+O` only toggles tool execution history between compact/detailed presentation. It is not a work-mode or plan menu and does not submit, clear or replace the composer draft.
- Product chrome follows the current user turn: English request/guidance stays English and Korean request/guidance stays Korean. User/model/artifact/plugin text is not translated. Incidental Hangul in code or paths does not switch locale.
- Scroll anchoring, display-cell/grapheme handling, queue/plan/jobs separation, one quiet status line, read-only `/review`, canonical `/policy`, and progressively disclosed quality evidence are implemented. No UncleCode X/Tweet/embed surface remains.
- The built-in Quality Engine does not invoke Claude/Codex Stop hooks. External hook failures retain source identity, bounded/redacted reason and dedupe key rather than being attributed to SCC.
- The HTTP+SSE control room reads and controls the same owner state as the TUI; bearer/origin checks, replay, lifecycle controls, conflicts and reconnection are fenced. Web external state uses `useSyncExternalStore`; locale updates include document metadata.
- The SCC v3 importer is dry-run/containment oriented and does not modify the source `.data` tree (`6ce543c`).

### Tasks 7–8 — executable quality loops and creator: complete, live proof still unproven

- `refine` reruns affected work with new attempt identity, new artifact hash and a fresh independent critic. `pivot` replans/revalidates an explicit DAG within the same quality run. Limits, cancellation, failure propagation and no-promote-before-fresh-review are enforced.
- `creator` operates only in an isolated worktree/branch, protects policy/evaluator/corpus/threshold assets, confines tools/network/process descendants, persists acquisition/cleanup state and stops at a pending-human proposal.
- Creator, evaluator and attestor identities must be independent. Production consumes host-generated held-out proof and invalidates replayed/stale proposals. A live independent-provider proof has not been recorded; missing proof remains `unproven`, never silently promoted.

### Task 9 — persistent owner and lifecycle controls: complete

- A detached authenticated UncleCode owner holds engines, session/policy/queue/AgentOps/SCC state, revision clock, mutation receipts and HTTP/SSE. TUI/server clients are attach-only.
- Pause is a durable cooperative safe-boundary suspension; resume continues the same turn. Cancel and steer remain separate and can preempt pending/long work.
- Exact idempotency keys, canonical fingerprints, revision admission, crash recovery and typed decision IDs prevent delayed or changed requests from settling replacement decisions.
- Shutdown fences queue drains, waits for active provider/tool/process-group settlement, retains final persistence failures and cleans exact leases/listeners. Attachment clients do not construct duplicate plugin/context/runtime owners.

### Task 10 — exact replay, cache bounds and memory: implemented

- SQLite-backed runtime ledgers own exact mutation, event and usage identities. Hot journal/cache eviction never decides correctness; a miss consults durable state. Changed payload reuse fails closed.
- Durable SSE sequence/replay survives restart; the bounded hot journal reports cursor expiry and releases reconnect subscriptions.
- Runtime/context/provider/TUI/extension/LSP caches expose bounded hit/miss/eviction/invalidation/entry/retained-byte telemetry. Later hardening added byte budgets and oversized bypass for work-shell text and markdown React-tree caches (`a7ae07b0`, `f2c5296a`).
- Forced-GC runtime soak evidence: heap delta `+2,536,296` bytes; active handles `2 -> 2`; file descriptors `18 -> 18`; owner retained at most `256` of `768` created sessions and retained `0` after stop; cleanup flags were all true.
- Exact scale evidence includes 10k usage identities across restart with a projection below 4 KiB, 10.5k durable receipts, 20k durable SSE events with a 64-entry hot view, 50k hot-journal overwrites, 100 reconnects and the production-shaped owner/cache/plugin soak.
- The final production-shaped soak recorded 100,000 exact usage publications in one run: 17.7 seconds, 12,439,552-byte SQLite database, heap `+2,511,800`, handles `2 -> 2`, file descriptors `13 -> 13`, 768/768 sessions disposed, 128 SSE reconnects with zero subscribers, and 512/512 plugin registrations disposed.

### Task 11 — offline differentiation implemented; final integrated proof awaiting

- Immutable held-out manifest: `sha256:10ba37dc907baca72710e44a4aa7c34a481521b2548bf204894f9305b0cf88cd`.
- Corpus: 40 cases, exactly 10 each for code, content, analysis and workflow; critic proof is 40/40.
- Supplied baseline commit: `d8027bb0d17327528a7b95ed84f50a9eb89ce5f2`.
- Offline results: quality `70.45% -> 79.25%` (`+8.8pp`); domains code `+9.1pp`, content `+8.4pp`, analysis `+9.4pp`, workflow `+8.3pp`; frontier tokens `40,990 -> 16,395` (`-60.00244%`). Numeric thresholds pass.
- `node scripts/held-out-benchmark.mjs --json --require-proven` exits 1 by design. `integratedProof.status` is `unproven` because baseline and candidate are offline fixtures, no live-provider run is recorded, and the final full verification matrix and independent final review are not yet proven.
- Final immutable-archive Node/Rust/SCC/TUI/web/security/migration/cleanup matrix: **AWAITING_FINAL_MATRIX_EVIDENCE**.
- Independent final architecture/security/memory/SCC review verdicts: **AWAITING_FINAL_REVIEW_EVIDENCE**.

### Task 12 — Herdr/Aside acceptance: passed at frozen `5d91eafd`

- Herdr HOST runtime QA passed 35/35 from `06:06:13Z` to `06:08:28Z` through the actual `bin -> Rust -> Node -> Ink` path.
- It covered prompt entry, Gemini/OpenAI/Anthropic gates, EN/KO/IME, Ctrl+O history-only/draft retention, queue/spinner/PageUp/Escape, 60/80/100/140-column hierarchy and absence of Stop-hook/X/Twitter chrome.
- Detach/reattach kept one owner PID `78004`, session `work-c3eb`, and monotonic revision `7 -> 11`.
- Aside used one REPL and one tab. Invalid token was rejected; valid auth exposed all control-room views. KO/EN language/title, pause/resume, System plugin/memory/cache telemetry (`12` hits, `3` misses, `80%`), origin `403`, `Last-Event-ID` replay of event `2`, subscriptions `1 -> 0`, and zero iframe/X/Twitter surfaces passed.
- No `official.browser` pane was opened. Cleanup restored the exact original panes `w1A:p14`, `w22:pN`, `w2J:pC`, `w2J:pG`; test-owned processes and temporary resources were gone.

## Security and correctness hardening through `5d91eafd`

- Executable Git operations and ambient shell callbacks cannot bypass `project-code` policy through saved rules, yolo mode, Git config hooks/viewers, shell functions or inherited callback variables (`dad8cff`, `740d25e`).
- Workspace writes are dirfd/no-follow anchored; delegated OMP tools, Git hooks/filters, archive callbacks and release actions are constrained or approval-gated.
- Raw plugin failures are bounded/redacted at the plugin-host boundary. Each plugin receives an isolated immutable lifecycle snapshot and host-owned completion validation runs after aggregation (`2cacddb`). Workspace plugins remain trust-gated; SCC is the signed built-in integration.
- Decision answering is bound to the exact decision ID for button and typed-text paths, with Promise-aware TUI failure restoration (`0f68e91`, `26c7123`).
- Quality/run proposals and projections are monotonic; stale control-room requests/responses and SSE generations cannot regress current state (`10d2e33`, `54d8190`, `7f6a262`, `5d91eaf`).
- Context Rust payload transport uses a bounded private `0600` file with no-follow identity checks and exact cleanup (`a2c155b`). Provider/explicit command environments are sanitized (`ad05fa4`).

## Remaining release gates

1. Patch this ledger and Task 11 with the exact immutable-archive full matrix and independent review verdicts.
2. Preserve the offline benchmark's honest `unproven` result unless a real live-provider run, full matrix and independent review all provide bound proof.
3. Do not auto-merge, release, publish or deploy. Human approval remains mandatory.
