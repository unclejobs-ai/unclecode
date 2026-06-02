# Sandbox Theory `/goal` Checklist

> Goal thread: `019e8355-cd64-76b1-ad0b-3a662e980cf1`
> Objective: define and execute UncleCode sandbox-theory adoption with a
> continuation hook for context compaction.

## Context Resume Hook

If context is compacted, resume by reading these files in order:

1. `docs/specs/2026-06-01-sandbox-theory-adoption-prd.md`
2. `docs/plans/2026-06-01-sandbox-theory-goal-checklist.md`
3. `docs/proposals/2026-06-01-openshell-adapter-design.md`
4. `packages/contracts/src/policy.ts`
5. `packages/contracts/src/trace.ts`
6. `packages/contracts/src/runtime.ts`
7. `packages/contracts/src/team.ts`
8. `packages/runtime-broker/src/index.ts`
9. `packages/runtime-broker/src/openshell-adapter.ts`
10. `packages/policy-engine/src/execution-policy.ts`
11. `packages/orchestrator/src/team-mini-loop.ts`
12. `packages/orchestrator/src/team-adapters/sdk-adapter.ts`
13. `apps/unclecode-cli/src/team-worker.ts`
14. `rust/unclecode-core/src/team_runtime.rs`
15. `rust/unclecode-core/src/ux_text.rs`
16. `rust/unclecode-core/src/work_shell_trace.rs`

Then continue from the first unchecked item below. Do not ask whether to
proceed unless a destructive action or ambiguous policy decision is required.
Do not reintroduce legacy hidden `superpowers` behavior.

## Phase 0 - Contract Slice

- [x] Create PRD with goals, non-goals, policy domains, rollout phases, risks,
  and acceptance criteria.
- [x] Add this context resume hook and checklist.
- [x] Add canonical execution policy capability constants and types.
- [x] Add `policy.denied` trace event contract.
- [x] Add future `openshell` runtime mode seam that fails closed.
- [x] Mirror `openshell` in team runtime contracts and Rust team validation.
- [x] Run targeted contract, runtime-broker, policy-engine, and Rust tests.
- [x] Record verification outcome in the final response or next handoff.

## Phase 1 - Audit Instrumentation

- [x] Add policy audit observations around team `run_shell`.
- [x] Add policy audit observations around write/apply-patch ACI tools.
- [x] Add policy denial formatting in Rust UX text.
- [x] Add TUI denial display copy without transcript noise.
- [x] Record team-step policy metadata for denied mini-loop side effects.

## Phase 2 - Enforcement

- [x] Implement filesystem path rule matching.
- [x] Implement shell command rule matching.
- [x] Keep local default permissive but observable.
- [x] Add enforced mode tests for denied capabilities.
- [x] Wire a concrete execution policy profile into production team mini-loop
  callsites.

## Phase 3 - OpenShell Spike

- [x] Add adapter design doc before code.
- [x] Add `OpenShellAdapter` behind feature/config gate.
- [x] Fail closed when the `openshell` CLI/gateway is not configured.
- [x] Add policy translation notes for OpenShell YAML.
- [x] Validate command execution, file sync hooks, provider credential flags, and
  latency capture through a fake OpenShell CLI lifecycle test.

## Current Execution Note

Phase 0, Phase 1, Phase 2, and Phase 3 are complete. Production SDK-backed
team mini-loops now receive a concrete runtime policy profile: `local` stays
permissive via audit profile, while non-local runtime modes fail closed unless
a caller passes an explicit profile. Phase 3 now has an explicit
`OpenShellAdapter` behind runtime-broker config. It selects the configured
gateway, creates a sandbox, optionally uploads the workspace, executes through
`sandbox exec -n`, optionally downloads artifacts, captures stdout/stderr/exit
and latency, then deletes the sandbox. Fake CLI tests validate the command
sequence and no-local-fallback behavior. Real gateway integration remains an
external environment verification item, not a blocker for this repo slice.

Latest verification:

- `node --conditions=source --import tsx --test tests/contracts/policy-intent.contract.test.mjs tests/contracts/trace.contract.test.mjs tests/contracts/team.contract.test.mjs tests/contracts/subsystem-smoke.contract.test.mjs tests/runtime-broker/sandbox-escalation.test.mjs tests/policy-engine/matrix.test.mjs tests/contracts/policy-yolo.contract.test.mjs`
- `cargo test -p unclecode-core team_runtime::tests`
- `npm run check --silent`
- `node --conditions=source --import tsx --test tests/orchestrator/team-mini-loop.test.mjs tests/contracts/trace.contract.test.mjs`
- `node --conditions=source --import tsx --test tests/orchestrator/team-mini-loop.test.mjs`
- `cargo test -p unclecode-core ux_text::tests::formats_trace_lines_for_terminal_display`
- `cargo test -p unclecode-core work_shell_trace::tests::resolves_verbose_and_minimal_trace_entries`
- `node --conditions=source --import tsx --test tests/work/repl.test.mjs tests/orchestrator/work-shell-engine.test.mjs`
- `node --conditions=source --import tsx --test tests/policy-engine/*.test.mjs`
- `node --conditions=source --import tsx --test tests/orchestrator/run-team-mini-loop.test.mjs tests/orchestrator/team-adapters/sdk-adapter.test.mjs tests/orchestrator/team-mini-loop.test.mjs`
- `node --conditions=source --import tsx --test tests/runtime-broker/sandbox-escalation.test.mjs`
- `npm run check --silent`
