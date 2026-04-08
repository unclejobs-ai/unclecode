# UncleCode Post-Plan Follow-up Refactor Roadmap

> **Status:** Proposed follow-up roadmap after `docs/plans/2026-04-05-unclecode-tui-orchestration-redesign.md` completion
> **Intent:** Capture the remaining structural refactors, convergence work, and feature-completion tasks that were intentionally left outside the original cutover checklist.

## Why this plan exists

The original TUI/orchestration redesign plan is now complete and green, but the codebase still has several **large owner seams** and **unfinished vision items** that deserve a deliberate second pass rather than ad-hoc cleanup.

This roadmap focuses on the remaining work that is still valuable after the migration succeeded:
- further thinning large owner files
- finishing unified shell/runtime convergence
- completing plugin/skill runtime behavior beyond metadata + slash registration
- hardening guardian/orchestrator safety beyond path heuristics
- improving context interoperability and diagnostics
- aligning docs/evidence with the codebase’s actual post-cutover topology

## Current hotspots (measured)

These are the largest remaining owner files and therefore the highest-likelihood follow-up refactor targets:

| File | Lines | Main risk |
|------|------:|-----------|
| `packages/tui/src/index.tsx` | 1971 | Too many shell/dashboard responsibilities concentrated in one module |
| `packages/orchestrator/src/work-shell-engine.ts` | 1198 | Engine state, command routing, turn execution, trace handling, and persistence are still tightly packed |
| `apps/unclecode-cli/src/program.ts` | 685 | Command registration is cleaner, but auth/login orchestration + registration density are still high |
| `apps/unclecode-cli/src/work-runtime.ts` | 639 | Runtime bootstrap, arg parsing, dashboard state assembly, and REPL startup remain coupled |
| `packages/tui/src/work-shell-hooks.ts` | 434 | Hook cluster may still be too broad for long-term maintainability |
| `packages/orchestrator/src/work-agent.ts` | 250 | Guardian/orchestrator integration groundwork exists, but contract depth is still shallow |

## Global constraints

- Preserve current `unclecode` semantics while refactoring.
- No new dependencies unless explicitly required.
- Prefer extraction, deletion, and owner-seam clarity over new abstraction layers.
- TDD for any behavior change; source/contract tests first for structure-only changes.
- Keep `exactOptionalPropertyTypes` happy via conditional spreads rather than widening types.
- Respect TS project references when introducing new cross-package imports.
- Keep guarded verification honest: no claiming narrower tests when heuristics are uncertain.
- Distinguish **behavior-preserving refactor**, **architectural convergence**, and **net-new feature completion** in every phase.

## Success criteria for this roadmap

### Structural
- [ ] No single app/package owner file remains a multi-thousand-line mixed-responsibility hotspot.
- [ ] `program.ts` is mostly command registration plus named command handlers.
- [ ] `work-runtime.ts` is mostly runtime orchestration plus imports from dedicated bootstrap helpers.
- [ ] `work-shell-engine.ts` is split into smaller seams with explicit boundaries for state, command handling, turn execution, and persistence.
- [ ] `packages/tui/src/index.tsx` no longer owns unrelated dashboard/render/store/controller concerns in one file.
- [ ] Embedded work and session-center state move through one shared runtime/store model instead of a mutable bridge pattern.

### Feature / vision
- [ ] Plugin/skill runtime loading goes beyond metadata discovery and slash registration.
- [ ] Context interop covers `.local.md`, `GEMINI.md`, `UNCLECODE.md`, and richer conflict diagnostics end-to-end.
- [ ] Guardian narrowing uses richer impact inference than path-only heuristics where practical.
- [ ] Orchestrator workers declare and honor concrete read/write ownership with verification wired into review.

### Verification
- [ ] Each phase has targeted tests first, then lint/check/build, then focused integration coverage.
- [ ] Final follow-up sweep includes contracts, work, tui, orchestrator, commands, and targeted integrations.

---

## Phase 0 — Truth maintenance and guardrails

### Task 0: Refresh evidence/docs to match the real post-cutover topology
**Why:** The historical evidence file still contains stale bullets from earlier cutover phases. The next cleanup pass needs truthful documentation before further refactors.

**Files:**
- Modify: `.sisyphus/evidence/2026-04-05-single-process-cutover.md`
- Modify: `docs/specs/2026-04-05-unclecode-tui-orchestration-redesign.md` (only where the current implementation already diverged and the spec should record it)
- Modify: `docs/plans/2026-04-05-unclecode-tui-orchestration-redesign.md` (only if completion notes need a follow-up pointer)

- [x] Step 1: Remove or rewrite stale bullets that still refer to deleted root `src/*` ownership.
- [x] Step 2: Add a short “completed vs follow-up” summary so future passes do not reopen finished migration work.
- [x] Step 3: Record the current real owner hotspots: `program.ts`, `work-runtime.ts`, `work-shell-engine.ts`, and `packages/tui/src/index.tsx`.
- [x] Step 4: Re-run only docs/contracts checks touched by this truth-maintenance pass.

### Task 1: Add hotspot ownership contracts before large follow-up refactors
**Why:** The next passes will split large files. Lock intended ownership boundaries first so future cleanup does not regress back into monoliths.

**Files:**
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`
- Modify: `tests/contracts/tui-dashboard.contract.test.mjs`
- Modify: `tests/contracts/tui-work-shell.contract.test.mjs`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`

- [ ] Step 1: Add source contracts for the new target seams introduced by this roadmap.
- [ ] Step 2: Prefer ownership assertions and file-presence checks over brittle formatting assumptions where possible.
- [ ] Step 3: Keep regex assertions narrow to architecture, not incidental formatting.
- [ ] Step 4: Run targeted contract coverage before implementation work in each downstream phase.

---

## Phase 1 — Finish thinning `apps/unclecode-cli/src/program.ts`

### Task 2: Split auth-login orchestration into smaller named phases
**Why:** `program.ts` is cleaner than before, but `auth login` is still the densest remaining command path and mixes preflight, saved-auth short-circuiting, method selection, and execution.

**Files:**
- Modify: `apps/unclecode-cli/src/program.ts`
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`
- Add/Modify: command/auth-focused tests if behavior expectations need protection

- [x] Step 1: Add failing contracts for smaller auth-login phases, e.g. preflight validation, saved-auth short-circuit, method selection, and execution dispatch.
- [x] Step 2: Extract a method-selection helper that returns `api-key-stdin | device | browser | saved-auth | error` intent without changing behavior.
- [x] Step 3: Extract saved-auth reuse / insufficient-scope handling into a dedicated helper so the command body stops open-coding auth-state branching.
- [x] Step 4: Keep `auth login` action body as thin orchestration over named helpers.
- [x] Step 5: Re-run targeted contracts/auth tests before full verification.

### Task 3: Split command registration clusters out of `program.ts`
**Why:** The file still registers every command inline. Moving registration clusters behind named helpers will make the owner seam explicit and reduce cognitive load.

**Files:**
- Modify: `apps/unclecode-cli/src/program.ts`
- Potentially add: `apps/unclecode-cli/src/program-commands.ts` or small command-cluster modules
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`

- [x] Step 1: Add failing contracts requiring grouped registration helpers for auth/config/mode/research/work/root commands.
- [x] Step 2: Extract registration helpers without moving behavior out of the existing command handlers.
- [x] Step 3: Keep `createUncleCodeProgram()` focused on root program assembly plus cluster registration calls.
- [x] Step 4: Re-run targeted contract/command coverage.

### Task 4: Decide whether `program.ts` should keep work-mode argv knowledge
**Why:** `program.ts` still knows how to build work argv. That may remain acceptable, or it may belong closer to `work-bootstrap.ts`.

**Files:**
- Modify: `apps/unclecode-cli/src/program.ts`
- Modify: `apps/unclecode-cli/src/work-bootstrap.ts`
- Modify: `tests/commands/work-forwarding.test.mjs`
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`

- [x] Step 1: Evaluate whether `buildWorkCommandArgs(...)` should remain in `program.ts` or move to `work-bootstrap.ts`.
- [x] Step 2: If moved, keep the API command-oriented rather than leaking Commander concerns into work bootstrap.
- [x] Step 3: Preserve existing work/tui forwarding semantics exactly.
- [x] Step 4: Re-run targeted forwarding/contracts coverage.

---

## Phase 2 — Decompose `apps/unclecode-cli/src/work-runtime.ts`

### Task 5: Extract work-runtime argv/help parsing into dedicated seams
**Why:** `work-runtime.ts` still owns parsing, help/tool printing, runtime provider resolution, bootstrap, and dashboard assembly together.

**Files:**
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Add: `apps/unclecode-cli/src/work-runtime-args.ts` (or equivalent)
- Modify: `tests/work/work-runtime.test.mjs`
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`

- [ ] Step 1: Add failing tests for owner seams around `parseArgs(...)`, `printHelp()`, `printTools()`, and runtime-provider parsing.
- [ ] Step 2: Move pure argv/help logic behind a dedicated app helper module.
- [ ] Step 3: Keep `work-runtime.ts` focused on runtime orchestration rather than CLI parsing minutiae.
- [ ] Step 4: Re-run targeted work-runtime/contracts coverage.

### Task 6: Extract session-restore and dashboard-prop loading from `work-runtime.ts`
**Why:** runtime bootstrap, session restore, auth refresh, dashboard home-state loading, and REPL startup are still tightly coupled.

**Files:**
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Add: one or more of
  - `apps/unclecode-cli/src/work-runtime-bootstrap.ts`
  - `apps/unclecode-cli/src/work-runtime-session.ts`
  - `apps/unclecode-cli/src/work-runtime-dashboard.ts`
- Modify: `tests/work/work-runtime.test.mjs`
- Modify: `tests/work/work-cli-resume.test.mjs`
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`

- [ ] Step 1: Lock owner seams for session restore, dashboard prop loading, and auth/home refresh helpers.
- [ ] Step 2: Move pure/mostly-pure bootstrap helpers first.
- [ ] Step 3: Isolate the imperative startup sequence into a thin top-level orchestration path.
- [ ] Step 4: Re-run targeted work-runtime/resume/contracts coverage.

### Task 7: Separate runtime bootstrap from interactive REPL startup
**Why:** `work-runtime.ts` currently mixes “prepare runtime dependencies” and “start the interactive shell.” A narrower bootstrap surface will make future unified-store work easier.

**Files:**
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Add: app-local bootstrap helper module(s)
- Modify: `tests/work/work-runtime.test.mjs`
- Modify: `tests/commands/work-forwarding.test.mjs`

- [ ] Step 1: Introduce an explicit bootstrap result type for everything required to call `startRepl(...)`.
- [ ] Step 2: Cut `runWorkCli(...)` over to that bootstrap result.
- [ ] Step 3: Preserve current packaged entry behavior and session resume semantics.
- [ ] Step 4: Re-run targeted work/command coverage.

---

## Phase 3 — Decompose `packages/orchestrator/src/work-shell-engine.ts`

### Task 8: Extract engine state transitions and panel mutations into pure helpers
**Why:** the engine file is still the largest orchestrator hotspot and likely mixes state mutation, command execution, and persistence side effects.

**Files:**
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Add: one or more of
  - `packages/orchestrator/src/work-shell-engine-state.ts`
  - `packages/orchestrator/src/work-shell-engine-panels.ts`
  - `packages/orchestrator/src/work-shell-engine-trace.ts`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`

- [ ] Step 1: Add failing tests for pure state/panel transitions currently hidden inside the engine class.
- [ ] Step 2: Move deterministic transitions first: entry append, panel replacement, trace mode updates, auth label updates, busy-state transitions.
- [ ] Step 3: Keep the class as the imperative coordinator over extracted pure helpers.
- [ ] Step 4: Re-run targeted engine coverage.

### Task 9: Extract local/slash/inline command handling out of the engine class
**Why:** command handling is a second large responsibility inside the engine and should be easier to reason about separately from turn execution.

**Files:**
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Add: `packages/orchestrator/src/work-shell-engine-commands.ts` (or equivalent)
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`
- Modify: `tests/work/repl.test.mjs`

- [ ] Step 1: Lock command-routing seams with failing tests.
- [ ] Step 2: Extract reasoning/model/help/context/tools/memory/skills/inline-command branches behind named command handlers.
- [ ] Step 3: Keep prompt-style commands and normal submit flow unchanged.
- [ ] Step 4: Re-run targeted engine/repl coverage.

### Task 10: Extract submit/turn execution pipeline out of the engine class
**Why:** submitting a prompt currently touches composer resolution, agent execution, error handling, trace updates, bridge writes, memory writes, and session persistence in one owner file.

**Files:**
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Add: `packages/orchestrator/src/work-shell-engine-turns.ts` (or equivalent)
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`
- Modify: `tests/work/repl.test.mjs`

- [ ] Step 1: Lock normal-turn and prompt-command behavior with focused tests.
- [ ] Step 2: Extract a named turn-execution helper or controller that owns composer resolution → agent turn → post-turn persistence.
- [ ] Step 3: Keep the permission-stall mitigation inside the same seam, but make it explicit and testable.
- [ ] Step 4: Re-run targeted engine/repl coverage.

### Task 11: Extract session snapshot / bridge / memory side effects into post-turn seams
**Why:** persistence side effects are currently intertwined with runtime control flow and are strong candidates for dedicated post-turn hooks.

**Files:**
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Add: `packages/orchestrator/src/work-shell-engine-effects.ts` (or equivalent)
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`
- Modify: `tests/context-broker/context-memory.test.mjs`
- Modify: `tests/contracts/session-checkpoint.contract.test.mjs`

- [ ] Step 1: Add failing tests around bridge publish, scoped memory writes, and session snapshot persistence boundaries.
- [ ] Step 2: Extract post-turn effect helpers without changing observable transcript behavior.
- [ ] Step 3: Keep effect ordering explicit and documented.
- [ ] Step 4: Re-run targeted engine/context/session tests.

---

## Phase 4 — Split `packages/tui/src/index.tsx` and formalize a shared shell store

### Task 12: Break `packages/tui/src/index.tsx` into dashboard/view/navigation modules
**Why:** the TUI package still has one giant owner file even after many extractions. This is now the biggest remaining UI maintainability risk.

**Files:**
- Modify: `packages/tui/src/index.tsx`
- Add: likely modules such as
  - `packages/tui/src/dashboard-actions.ts`
  - `packages/tui/src/dashboard-navigation.ts`
  - `packages/tui/src/dashboard-render.tsx`
  - `packages/tui/src/tui-entry.tsx`
- Modify: `packages/tui/src/index.tsx` exports only
- Modify: `tests/contracts/tui-dashboard.contract.test.mjs`
- Modify: `tests/tui/shell-state.test.mjs`

- [ ] Step 1: Add failing contracts for the new TUI owner seams.
- [ ] Step 2: Move pure action catalogs and navigation logic first.
- [ ] Step 3: Move render-entry and Dashboard assembly second.
- [ ] Step 4: Keep public exports stable while shrinking `index.tsx` into a barrel/assembly layer.
- [ ] Step 5: Re-run targeted TUI/contracts coverage.

### Task 13: Introduce a shared shell runtime/store model
**Why:** same-tree embedded work currently depends on a mutable controller bridge and patch/refresh choreography. The next major architectural gain is a shared store/reducer model.

**Files:**
- Add: likely `packages/tui/src/shell-store.ts` and/or contract/store helpers
- Modify: `packages/tui/src/shell-state.ts`
- Modify: `packages/tui/src/index.tsx`
- Modify: `apps/unclecode-cli/src/session-center-launcher.ts`
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Modify: `packages/contracts/src/tui.ts` if shared store contracts are exported
- Modify: `tests/contracts/tui-dashboard.contract.test.mjs`
- Modify: `tests/tui/shell-state.test.mjs`
- Modify: `tests/work/work-runtime.test.mjs`

- [ ] Step 1: Define the minimum shared store contract: selected view, selected session, auth label, home state, context lines, embedded work snapshot, trace mode.
- [ ] Step 2: Keep store updates reducer-like and serializable where possible.
- [ ] Step 3: Convert the embedded work controller bridge into store actions/selectors.
- [ ] Step 4: Keep a compatibility adapter during cutover so the app bootstrap does not have to rewrite everything at once.
- [ ] Step 5: Re-run targeted TUI/work/contracts coverage.

### Task 14: Eliminate patch-vs-refresh drift in embedded work synchronization
**Why:** current same-tree synchronization works, but the architecture still treats patch and full refresh as separate lanes. A shared store should converge them.

**Files:**
- Modify: `packages/tui/src/work-shell-dashboard-sync.ts`
- Modify: `packages/tui/src/index.tsx`
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Modify: `tests/contracts/tui-dashboard.contract.test.mjs`
- Modify: `tests/work/work-runtime.test.mjs`

- [ ] Step 1: Add tests that lock expected behavior when patch updates and full refresh overlap.
- [ ] Step 2: Move sync logic to store-driven state reconciliation rather than ad-hoc patch plumbing.
- [ ] Step 3: Ensure selected-session identity, context, auth, and home-state fields cannot diverge after resume/switch.
- [ ] Step 4: Re-run targeted TUI/work coverage.

### Task 15: Unify focus/composer behavior across views under one controller contract
**Why:** unified shell convergence is not finished until Work / Sessions / MCP / Research use one consistent focus and key-routing model.

**Files:**
- Modify: `packages/tui/src/index.tsx`
- Modify: `packages/tui/src/work-shell-hooks.ts`
- Modify: `packages/contracts/src/tui.ts`
- Modify: `tests/contracts/tui-dashboard.contract.test.mjs`
- Modify: `tests/work/repl.test.mjs`

- [ ] Step 1: Add contracts for per-view composer availability and navigation-key precedence.
- [ ] Step 2: Move focus/input policy to a shared controller seam instead of implicit component behavior.
- [ ] Step 3: Preserve operator-visible navigation and slash behavior.
- [ ] Step 4: Re-run targeted TUI/repl/contracts coverage.

---

## Phase 5 — Complete plugin + skill runtime behavior

### Task 16: Finish plugin manifest runtime loading
**Why:** metadata discovery and slash registration exist, but the runtime story for plugin-owned commands/skills/hooks/agents is still incomplete.

**Files:**
- Modify: `packages/orchestrator/src/extension-registry.ts`
- Modify: `packages/orchestrator/src/command-registry.ts`
- Modify: `packages/contracts/src/commands.ts`
- Modify: `packages/context-broker/src/workspace-skills.ts`
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: relevant integration/tests under `tests/commands`, `tests/context-broker`, `tests/integration`

- [ ] Step 1: Add failing tests for manifest-backed command/skill discovery beyond builtin registration.
- [ ] Step 2: Formalize command + skill + hook + agent registration inputs from plugin manifests.
- [ ] Step 3: Keep load order deterministic: builtin → user → project.
- [ ] Step 4: Surface plugin load failures honestly in doctor/status output.
- [ ] Step 5: Re-run targeted registry/integration coverage.

### Task 17: Wire skill matching and full skill-content injection into work turns
**Why:** metadata exists, but the runtime still needs a complete “match → load → inject into prompt” path for skills.

**Files:**
- Modify: `packages/context-broker/src/workspace-skills.ts`
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Modify: `packages/orchestrator/src/work-agent.ts`
- Modify: `tests/work/workspace-skills.test.mjs`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`
- Modify: `tests/work/repl.test.mjs`

- [ ] Step 1: Add failing tests for frontmatter scan, match selection, and lazy full-content loading on use.
- [ ] Step 2: Decide whether skill injection belongs in the engine, the work agent, or a dedicated prompt-assembly seam.
- [ ] Step 3: Preserve current `/skills` UX while adding real runtime effect.
- [ ] Step 4: Re-run targeted skills/engine/repl coverage.

### Task 18: Add doctor/reporting surfaces for plugin and skill runtime state
**Why:** once runtime loading exists, operators need an honest way to inspect what loaded, failed, and was skipped.

**Files:**
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: `apps/unclecode-cli/src/program.ts`
- Modify: tests around doctor/setup/commands/integration

- [ ] Step 1: Add failing tests for plugin/skill diagnostics in doctor/setup/reporting surfaces.
- [ ] Step 2: Expose loaded plugins, matched skills, skipped plugins, and manifest errors in a bounded report.
- [ ] Step 3: Keep non-interactive CLI output concise but actionable.
- [ ] Step 4: Re-run targeted command/integration coverage.

---

## Phase 6 — Complete context interoperability and diagnostics

### Task 19: Add `.claude/settings.json` and richer directive parsing
**Why:** markdown guidance loading is broader now, but machine-readable settings interop is still incomplete.

**Files:**
- Modify: `packages/context-broker/src/workspace-guidance.ts`
- Modify: `packages/context-broker/src/types.ts`
- Modify: `packages/context-broker/src/index.ts`
- Modify: `tests/context-broker/workspace-guidance.test.mjs`
- Modify: `tests/work/workspace-guidance.test.mjs`

- [ ] Step 1: Add failing tests for `.claude/settings.json` discovery and precedence relative to markdown guidance.
- [ ] Step 2: Decide what subset of settings UncleCode will actually honor versus report only.
- [ ] Step 3: Keep conflict resolution deterministic and visible.
- [ ] Step 4: Re-run targeted guidance/context coverage.

### Task 20: Add conflict-attribution and diagnostics surfaces for `/context`
**Why:** the spec called for per-directive source attribution and conflict explanation; current behavior may still be mostly summary-line based.

**Files:**
- Modify: `packages/context-broker/src/workspace-guidance.ts`
- Modify: `packages/tui/src/work-shell-panels.ts`
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Modify: `tests/work/repl.test.mjs`
- Modify: `tests/context-broker/workspace-guidance.test.mjs`

- [ ] Step 1: Add failing tests for conflict summaries and per-source diagnostics.
- [ ] Step 2: Introduce a structured guidance-report shape instead of only flattened appendix text.
- [ ] Step 3: Keep existing prompt-assembly behavior intact while expanding operator diagnostics.
- [ ] Step 4: Re-run targeted context/repl coverage.

---

## Phase 7 — Harden guardian narrowing and verification contracts

### Task 21: Move guardian impact inference beyond raw path heuristics where practical
**Why:** current guardian narrowing is better than before but still primarily file-path driven. Public boundary changes deserve richer inference.

**Files:**
- Modify: `apps/unclecode-cli/src/guardian-checks.ts`
- Modify: `packages/orchestrator/src/file-ownership-registry.ts`
- Modify: `packages/orchestrator/src/work-agent.ts`
- Modify: `tests/work/guardian-checks.test.mjs`

- [ ] Step 1: Add failing tests for package-boundary, barrel, and contract-shape changes that should broaden or redirect verification.
- [ ] Step 2: Introduce a small impact map / dependency map instead of relying only on path prefixes.
- [ ] Step 3: Keep the system honest: broaden when uncertain rather than under-testing.
- [ ] Step 4: Re-run targeted guardian coverage.

### Task 22: Require richer write/read ownership in orchestrator tasks
**Why:** file ownership groundwork exists, but safety depends on executor tasks actually declaring their intended read/write surface.

**Files:**
- Modify: `packages/orchestrator/src/turn-orchestrator.ts`
- Modify: `packages/orchestrator/src/work-agent.ts`
- Modify: `packages/orchestrator/src/file-ownership-registry.ts`
- Modify: `tests/orchestrator/turn-orchestrator.test.mjs`
- Modify: `tests/work/work-agent.test.mjs`

- [ ] Step 1: Add failing tests that require executor tasks to carry declared write claims when planning/modifying files.
- [ ] Step 2: Thread write claims through planner → executor → guardian summaries.
- [ ] Step 3: Keep single-turn/simple paths cheap; only complex work should pay the extra orchestration cost.
- [ ] Step 4: Re-run targeted orchestrator/work coverage.

### Task 23: Expand guardian executable checks into structured review results
**Why:** executable checks run, but richer structured summaries would make review traces and final operator guidance more useful.

**Files:**
- Modify: `apps/unclecode-cli/src/guardian-checks.ts`
- Modify: `packages/orchestrator/src/work-agent.ts`
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Modify: `tests/work/guardian-checks.test.mjs`
- Modify: `tests/work/work-agent.test.mjs`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`

- [ ] Step 1: Add failing tests for structured guardian outputs: script name, scope, pass/fail, skipped reason, duration.
- [ ] Step 2: Carry that structure into reviewer traces and final synthesis inputs.
- [ ] Step 3: Preserve bounded execution and avoid expanding the default verification budget silently.
- [ ] Step 4: Re-run targeted guardian/work/engine coverage.

---

## Phase 8 — Deepen real orchestrator capabilities

### Task 24: Finish planner task-graph and executor-pool contracts
**Why:** orchestrator groundwork exists, but the “real orchestrator” story is still partial relative to the spec vision.

**Files:**
- Modify: `packages/orchestrator/src/turn-orchestrator.ts`
- Modify: `packages/orchestrator/src/work-agent.ts`
- Modify: `packages/contracts/src/trace.ts`
- Modify: `tests/orchestrator/turn-orchestrator.test.mjs`
- Modify: `tests/performance/backpressure.test.mjs`

- [ ] Step 1: Add failing tests for explicit task dependencies, bounded worker count, and deterministic event ordering.
- [ ] Step 2: Make planner output explicit task graphs with dependencies/read-write hints.
- [ ] Step 3: Tighten event backpressure contracts so verbose traces stay usable under parallel execution.
- [ ] Step 4: Re-run targeted orchestrator/performance/contracts coverage.

### Task 25: Complete real verbose-mode orchestration traces
**Why:** verbose mode should increasingly reflect actual planner/executor/guardian phases rather than a mostly single-agent abstraction.

**Files:**
- Modify: `packages/orchestrator/src/turn-orchestrator.ts`
- Modify: `packages/orchestrator/src/work-agent.ts`
- Modify: `packages/tui/src/work-shell-formatters.ts`
- Modify: `tests/orchestrator/turn-orchestrator.test.mjs`
- Modify: `tests/work/repl.test.mjs`

- [ ] Step 1: Add failing tests for real planner/executor/reviewer traces under complex work.
- [ ] Step 2: Keep minimal mode quiet; only verbose surfaces should grow.
- [ ] Step 3: Preserve truthful tracing: no synthetic steps without real execution behind them.
- [ ] Step 4: Re-run targeted orchestrator/repl coverage.

---

## Phase 9 — Performance, startup, and operator polish

### Task 26: Reconcile fast-path CLI surfaces with richer runtime ownership
**Why:** the codebase now has both fast CLI shortcuts and richer runtime paths. Follow-up cleanup should ensure they stay intentionally aligned.

**Files:**
- Modify: `apps/unclecode-cli/src/fast-cli.ts`
- Modify: `apps/unclecode-cli/src/fast-doctor.ts`
- Modify: `apps/unclecode-cli/src/fast-mode.ts`
- Modify: `apps/unclecode-cli/src/fast-sessions.ts`
- Modify: `apps/unclecode-cli/src/fast-setup.ts`
- Modify: related command/integration tests

- [ ] Step 1: Add failing tests that lock parity between fast surfaces and full operational output for overlapping commands.
- [ ] Step 2: Make the ownership split explicit: which commands are fast-path, which intentionally go through richer runtime logic.
- [ ] Step 3: Preserve startup latency benefits for the fast path.
- [ ] Step 4: Re-run targeted command/integration/performance coverage.

### Task 27: Add a measured startup/resume latency budget suite for the new topology
**Why:** now that the biggest migration is complete, the next regressions are more likely to be accidental startup/resume slowdowns rather than topology bugs.

**Files:**
- Modify: `tests/integration/unclecode-performance.integration.test.mjs`
- Modify: `tests/commands/startup-paths.test.mjs`
- Modify: any runtime/performance helper touched by the budget work

- [ ] Step 1: Add measurable budgets for no-arg startup, `work` startup, `center` startup, and session resume.
- [ ] Step 2: Distinguish warm-cache vs cold-cache expectations where necessary.
- [ ] Step 3: Keep thresholds honest; relax only when architecture truly justifies it.
- [ ] Step 4: Re-run targeted performance/integration coverage.

### Task 28: Polish auth + session operator UX on the unified shell path
**Why:** device login visibility improved, but auth/session/operator polish still benefits from a dedicated follow-up pass once the store/runtime convergence work lands.

**Files:**
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Modify: `packages/tui/src/work-shell-panels.ts`
- Modify: `packages/tui/src/index.tsx`
- Modify: auth/session integration tests

- [ ] Step 1: Audit auth, resume, sessions, and same-tree work navigation for redundant refreshes or stale labels.
- [ ] Step 2: Add regression tests for the specific operator-visible edge cases uncovered during that audit.
- [ ] Step 3: Keep UX changes incremental and contract-backed.
- [ ] Step 4: Re-run targeted work/TUI/integration coverage.

---

## Phase 10 — Finalization and release-readiness

### Task 29: Write a final convergence evidence pass
**Files:**
- Modify: `.sisyphus/evidence/2026-04-05-single-process-cutover.md`
- Add/Modify: follow-up evidence note if needed

- [ ] Step 1: Summarize what architectural debt remains after this roadmap.
- [ ] Step 2: Distinguish “intentionally permanent seam” from “still transitional.”
- [ ] Step 3: Keep the evidence short and trustworthy.

### Task 30: Run the final broad sweep for the follow-up roadmap
**Files:**
- Workspace-wide verification only

- [ ] Step 1: `npm run lint`
- [ ] Step 2: `npm run check`
- [ ] Step 3: `npm run build`
- [ ] Step 4: `node --conditions=source --import tsx --test tests/contracts/contracts-typecheck.test.ts`
- [ ] Step 5: `node --conditions=source --import tsx --test tests/contracts/unclecode-cli.contract.test.mjs tests/contracts/tui-dashboard.contract.test.mjs tests/contracts/tui-work-shell.contract.test.mjs`
- [ ] Step 6: `node --conditions=source --import tsx --test tests/work/guardian-checks.test.mjs tests/work/work-runtime.test.mjs tests/work/repl.test.mjs tests/work/work-agent.test.mjs`
- [ ] Step 7: `node --conditions=source --import tsx --test tests/orchestrator/turn-orchestrator.test.mjs tests/orchestrator/work-shell-engine.test.mjs`
- [ ] Step 8: `node --conditions=source --import tsx --test tests/commands/work-forwarding.test.mjs tests/commands/startup-paths.test.mjs`
- [ ] Step 9: run the smallest necessary integration/performance suites touched by the final phase

---

## Recommended execution order

If this roadmap is executed incrementally, use this order:

1. **Phase 0** — truth + guardrails
2. **Phase 1** — finish `program.ts`
3. **Phase 2** — thin `work-runtime.ts`
4. **Phase 3** — split `work-shell-engine.ts`
5. **Phase 4** — split TUI monolith + shared store
6. **Phase 5** — plugin/skill runtime completion
7. **Phase 6** — context interop completion
8. **Phase 7** — guardian hardening
9. **Phase 8** — orchestrator depth
10. **Phase 9/10** — performance polish + release sweep

## Recommended checkpoints

- **Checkpoint A:** after Phases 1-2, verify app bootstrap and command topology are stable.
- **Checkpoint B:** after Phases 3-4, verify the work shell and session center converge on one shared state model.
- **Checkpoint C:** after Phases 5-8, verify feature-completeness and safety claims with targeted integration/performance coverage.

## What this roadmap intentionally does NOT assume

- It does **not** assume a greenfield shell rewrite.
- It does **not** assume plugin hooks or multi-agent orchestration should ship all at once.
- It does **not** assume every large file must become tiny; only that each should have one clear owner responsibility.
- It does **not** assume path-based guardian narrowing is sufficient forever.

## Handoff note

This roadmap supersedes open-ended “keep cleaning” work. Future implementation passes should attach themselves to a concrete task above, update this file, and keep evidence/docs synchronized with reality.
