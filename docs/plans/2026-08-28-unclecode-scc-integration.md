# UncleCode × SCC integration implementation plan

Source of truth: the user-supplied "UncleCode × SCC 통합 하네스 계획" from 2026-08-28.

## Global constraints

- UncleCode is the only runtime. SCC contributes host-neutral quality logic through `@second-claude/core`; UncleCode must not start a second SCC daemon, MCP server, or event store.
- Preserve the user's existing dirty UncleCode TUI changes and UX plans.
- Keep Claude and Codex SCC adapters working, with no install-time compilation.
- Keep external workspace plugins trust-gated. Register SCC as a built-in integration.
- A worker cannot approve its own output. Review evidence is bound to artifact hashes and becomes stale after changes.
- `promote` means handoff and release communication, never automatic deployment.
- Main merge, release, publish, and external writes remain human-approved.
- TUI and web use the same runtime state and policy engine. Queue, jobs/agents, plan/quality, security approvals, and user decisions remain distinct.
- Preserve the architectural hierarchy `persistent UncleCode runtime owner → session/orchestrator/policy → SCC lifecycle and WorkGraph → TUI/web projections`. Presentation layers may issue typed commands but may not own or infer runtime truth.
- Preserve the information hierarchy `current task → remaining stage → blocking reason → optional detail` across widths and locales. Extra quality/plugin/memory data must remain progressively disclosed instead of flattening the main workspace.

## Task 1: Baselines and regression stabilization

- Preserve and inventory dirty UncleCode changes.
- Stabilize SCC test glob, MCP handshake, and Stop-hook hot-upgrade regressions.
- Capture current targeted Node/Rust/SCC test baselines.

## Task 2: Extract `@second-claude/core`

- Add a strict TypeScript package exporting `QualityProfile`, `HarnessStage`, `PdcaPhase`, `GateDecision`, `GateEvidence`, `QualityRunProjection`, and `EvolutionProposal`.
- Implement host-neutral classification, WorkGraph validation, gate evaluation, stale-evidence invalidation, refine/pivot bounds, and creator isolation rules.
- Keep plugin-specific file/environment persistence in adapters.
- Produce a prebuilt release tarball/checksum workflow; do not build at install time.
- Run the same core contract fixtures from SCC and UncleCode.

## Task 3: Extend UncleCode runtime contracts

- Add typed lifecycle decision hooks: `runClassified`, `planCreated`, `beforeNodeDispatch`, `afterNodeCompleted`, `beforeRunComplete`, `contextContribute`, and `evolutionProposed`.
- Extend WorkGraph graph/node fields and trace events for quality stages and gates.
- Pin the SCC core dependency with a local-development override.
- Register a built-in SCC quality integration, connect guardian output to the critic gate, and add a promote stage.
- Add balanced-prewalk routing and a first-class DeepSeek provider/catalog entry.
- Persist quality state only through UncleCode session/agentops/artifact ownership.

## Task 4: TUI P0 and quiet workspace

- Complete scroll anchoring, PageUp/PageDown/Fn navigation, CJK/emoji display-cell wrapping/cursor/IME handling, approval scope consistency, duplicate-row/spinner removal, and queue separation.
- Show at most three nearby progress rows and one status line; provide Ctrl+T, Ctrl+O, Ctrl+X and `/queue`, `/agents`, `/context`, `/review`, `/policy` disclosure surfaces.
- Keep security approvals, quality gates, and user decisions distinct in types and UI.
- Verify 60/80/100/140-column and Korean/emoji/IME/scroll cases.

## Task 5: Server and web control room

- Connect the existing HTTP+SSE server to real runtime/session/orchestrator state.
- Support replay and `Last-Event-ID`, pause/resume/cancel/approve/steer/follow-up APIs, loopback and bearer-token checks, origin rejection, and approval-race handling.
- Replace the empty `godness-web` Vite surface with `unclecode-web` Runs, Run Detail, Quality, Context, Agents & Jobs, Artifacts, Evolve, and System views.
- Use `useSyncExternalStore` for external state and avoid derived-state effects.

## Task 6: Migration, compatibility, and verification

- Add a dry-run importer from SCC v3 `.data` into UncleCode session/agentops/artifact structures without modifying originals.
- Add compatibility documentation for UncleCode integration and SCC 4 core/adapters.
- Run SCC tests, UncleCode Node/Rust tests, shared fixtures, quality gate tests, routing trace tests, TUI goldens/smokes, server security/replay tests, and cleanup tests.
- Record any verification that cannot run because credentials, external providers, release authorization, or benchmark infrastructure are unavailable.

## Task 7: Execute bounded refine and pivot loops

- Replace terminal-only `refine` and `pivot` projections with real, bounded same-run control flow.
- A `refine` decision reruns the affected work with incremented attempts, fresh artifact hashes, stale-verdict invalidation, and a fresh independent critic review.
- A `pivot` decision creates and revalidates a replacement explicit DAG in the same quality run, preserving trace history while keeping resolved findings out of the active failure set.
- Use unique persisted job/run identities per attempt and iteration without changing stable WorkGraph node identity.
- Prove refine/pivot limits, cancellation, failure propagation, crash/resume projection, reviewer independence, and no promote before a fresh passing critic.

## Task 8: Implement creator evolve lifecycle

- Add a real `creator` lifecycle owned by UncleCode that creates candidates only in isolated worktrees/branches, runs immutable held-out benchmarks, and records attested `EvolutionProposal` objects through `evolutionProposed`.
- Prevent a candidate from modifying or selecting its evaluator, permission policy, benchmark corpus, or acceptance thresholds; fail closed when isolation or attestation cannot be proven.
- Project benchmark comparison, artifact hashes, isolation evidence, and PR-ready status into the existing runtime/control-room model without implying merge, publish, or release.
- Keep main merge, release, publish, and all external writes human-approved.

## Task 9: Unify the persistent runtime and lifecycle controls

- Make the persistent UncleCode runtime the single owner of live sessions, policy decisions, queues, AgentOps state, and quality state; TUI and web attach to that owner instead of maintaining independent in-process registries.
- Starting a second TUI or control-room client must reuse the runtime endpoint instead of silently disabling control-room behavior on port collision.
- Implement true pause/resume semantics that suspend and continue eligible work without translating pause into cancel/interrupt; retain explicit cancel and steer behavior separately.
- Verify TUI and web observe and control the same session revisions, approvals, quality gates, follow-ups, jobs, and artifacts under reconnect and concurrent-client races.

## Task 10: Bound exact replay memory and instrument caches

- Replace the unbounded per-run `eventIds` array and quadratic membership scans with an exact, durable, indexed replay/idempotency ledger whose hot in-memory view is bounded.
- Preserve exact duplicate suppression across restart/resume and 10k+ event identities; do not trade correctness for an unsafe cap or probabilistic false positives.
- Add bounded cache telemetry for hit, miss, eviction, invalidation, size, and retained-byte estimates on the runtime caches that materially affect responsiveness.
- Add deterministic complexity tests and long-running production-shaped memory/latency soak tests covering event publication/replay, idempotent controls, attachment previews, SSE reconnects, cache churn, and cleanup.

## Task 11: Held-out differentiation and final integrated proof

- Add a versioned, immutable offline held-out harness with 10 cases each for code, content, analysis, and workflow, keeping evaluator and thresholds outside candidate-editable paths.
- Compare the integrated UncleCode Quality Engine against the recorded UncleCode baseline and report quality delta, per-domain regression, frontier-route use, cache hit rate, latency, and retained memory from trace-derived measurements.
- Gate the integration report on the target of at least +5 percentage points overall quality, no domain regressing more than 2 points, and at least 50% frontier-use reduction; report a failed gate honestly instead of manufacturing a pass.
- Run the complete Node, Rust, SCC, TUI boot-path, web/SSE/security, migration, cleanup, soak, and shared-contract verification matrix and subject the whole branch to an independent final review.

## Task 12: Herdr host and Aside web acceptance

- Verify the built UncleCode and SCC integration in the Herdr host environment without auto-opening or retaining an `official.browser` pane as a product/runtime side effect.
- Verify the web control room through `aside` CLI and a persistent `aside repl` session, using accessibility snapshots as primary evidence and exact interaction checks for Runs, Quality, Context, Agents & Jobs, Artifacts, Evolve, System, controls, locale, reconnect, and responsive layout.
- Prove that verification sessions close cleanly and do not leak browser tabs, panes, CLI children, sockets, plugin hosts, worktrees, or retained runtime subscriptions.
- Audit built-in and workspace plugin loading, trust boundaries, lifecycle cleanup, memory/cache telemetry, and repeated attach/detach behavior in the actual host path; keep improving until the acceptance and soak gates pass.
- Do not install or launch a second SCC runtime. Do not add Browser-pane auto-launch behavior to UncleCode.

## Implementation status snapshot — 2026-08-30

This plan remains the architectural source of truth. The implementation snapshot used by the final integration reports is UncleCode `5d91eafd` with SCC `8d0fa2e`; the reviewed SCC core tarball is pinned in UncleCode with SHA-256 `ec2449e6eb87da1b1d286b86b4c686079d616cadfe2e1b4f07365e9b83c97647`.

The integration preserves one ownership hierarchy:

```text
persistent UncleCode runtime owner
  -> session / orchestrator / policy
    -> in-process SCC Quality Engine lifecycle + WorkGraph
      -> read-only TUI and web projections
```

There is no SCC daemon, SCC MCP runtime, or parallel SCC session/event store in the UncleCode execution path. SCC remains independently usable through its Claude/Codex adapters, while UncleCode consumes the same host-neutral core as a pinned, prebuilt artifact.

Tasks 1–10 are implemented and hardened through the snapshot above. This includes typed SCC decisions, bounded refine/pivot, isolated creator proposals, persistent runtime ownership, exact durable mutation/usage identity, durable bounded SSE replay, cache telemetry, cache byte caps, runtime shutdown fencing, typed decision identity, plugin completion boundaries, TUI input/locale/Ctrl+O behavior, and control-room lifecycle fencing.

Task 11's deterministic 40-case offline comparison currently records `70.45% -> 79.25%` quality (`+8.8pp`), positive domain deltas of `+9.1/+8.4/+9.4/+8.3pp`, and frontier-token use `40,990 -> 16,395` (`-60.00244%`). Those numeric gates pass, but the integrated result is deliberately `unproven`: both sides are offline fixtures, no live-provider comparison is recorded, and the final full verification matrix and independent final review are not yet proven.

Task 12 passed at frozen `5d91eafd`: Herdr HOST runtime QA passed 35/35 through the built path, and one Aside REPL/one tab verified the shared control room. No `official.browser` pane was opened. Cleanup restored the original Herdr pane inventory and removed test-owned processes and temporary resources. Exact acceptance evidence is recorded in `task-12-report.md`.

Main merge, release, publish, deployment, and external writes remain outside automatic promotion. `promote` still means a verified handoff only.
