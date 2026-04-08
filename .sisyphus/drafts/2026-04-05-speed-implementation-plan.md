# UncleCode Speed Implementation Plan

## Goal
Make `unclecode` feel closer to pi on the hot path:
- fastest possible default work launch
- minimal synchronous startup before the composer appears
- no heavy optional surfaces on the work-first path unless requested

## Current findings
### Hot path issue observed
`apps/unclecode-cli/src/index.ts` previously imported `program.ts` eagerly.
That pulled in:
- commander
- TUI rendering
- auth/provider helpers
- operational/reporting surfaces
- other non-work startup code

This meant the default no-arg interactive path paid initialization cost for features it was not using.

### Immediate fix now implemented
- added `apps/unclecode-cli/src/work-launcher.ts`
- moved `launchWorkEntrypoint`, `withWorkCwd`, and `shouldLaunchDefaultWorkSession` there
- updated `apps/unclecode-cli/src/index.ts` to:
  - check the no-arg interactive work path first
  - launch work immediately on that path
  - only `import("./program.js")` when non-work CLI routing is actually needed

This keeps the work-first startup thinner.

## Next speed phases
### Phase 1 — keep work startup thin
1. audit `dist-work` entrypoint imports for provider/config work that can be deferred until first prompt submit
2. avoid loading session-center/TUI-only code on the default work path
3. defer expensive workspace probes until after first frame when possible

### Phase 2 — lazy non-critical surfaces
1. lazy-load MCP inventory for views that actually render MCP data
2. lazy-load auth refresh/status details outside explicit auth surfaces
3. avoid building doctor/research/session summaries unless their commands are invoked

### Phase 3 — reduce optional overhead
1. keep trace/diagnostic hooks fully pay-for-play
2. coalesce non-critical shell events aggressively under bursty output
3. ensure perf JSON/report generation does not add overhead to default interactive work
4. stop unsafe live terminal-image preview writes from corrupting the active Ink surface; move preview to a safe rendering path
5. make slash-command discovery pay-for-play and local: cached command catalogs, inline suggestions, and no accidental provider round-trip for partial slash input

### Phase 4 — measure and lock budgets
1. add startup-adjacent timing harness for default `unclecode` launch
2. record before/after timings for:
   - `unclecode` interactive boot
   - `unclecode auth status`
   - `unclecode doctor --verbose`
3. set guardrail budgets only after variance is characterized

## Priority order
1. default work startup import slimming
2. dist-work lazy loading audit
3. slash-command catalog + inline suggestion path
4. safe image preview path without terminal ghosting
5. startup timing harness
6. optional trace/MCP/auth pay-for-play cleanup

## Notes from competitive analysis
Borrow from Open Multi-Agent selectively:
- small, explicit orchestration boundaries
- optional trace callbacks rather than always-on instrumentation
- bounded concurrency and low-overhead scheduling concepts

Do not borrow its non-goals:
- no persistence
- no UI shell
- no MCP governance

UncleCode should stay product-first and durable, while taking the lean-path execution ideas.
