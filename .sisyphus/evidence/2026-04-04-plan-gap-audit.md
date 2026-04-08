# 2026-04-04 Plan Gap Audit

## Closed in this pass
- Task 15: `setup`, `doctor`, `doctor --verbose`, `sessions`, `resume`, `research status` are implemented and covered by integration tests.
- Task 17: release-surface/provenance manifest exists and is covered by `tests/release-surface/*.test.mjs`.
- Work-first TUI direction is now implemented even though it goes beyond the original plan's launcher framing.

## Improved but not fully closed
- Task 14: responsiveness is improved by opening directly into the work shell, but the older session-center TUI still exists and has not been refactored into the new work-first architecture end-to-end.
- Task 16: latency counters exist (`doctor --verbose`), but dedicated threshold evidence and explicit performance budget artifacts are still missing.

## Still open / procedural
- F1 Plan Compliance Audit — no dedicated oracle artifact yet.
- F2 Code Quality Review — no standalone reviewer artifact yet.
- F3 Agent walkthrough / manual QA artifact — no dedicated walkthrough report yet.
- F4 Scope Fidelity Check — no standalone scope-fidelity artifact yet.
- Repository cleanup/history shaping — working tree remains broad because the repo still contains large in-flight rebuild changes beyond this loop.
