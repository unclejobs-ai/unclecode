# 2026-04-06 Screenshot Regression Fixes

## Scope
Resolved the three remaining screenshot-driven product regressions from the final polish loop:

1. Embedded `Work` pane stacked dashboard chrome instead of taking the primary/fullscreen surface.
2. Inline auth actions could update visible auth copy without refreshing the live provider runtime, allowing `Already signed in` / `Auth: oauth-file` to drift into a later `401`.
3. Transcript role blocks (`You / Answer / Step / Note`) were still too visually similar for fast scanning.

## Changes

### 1. Fullscreen embedded work pane
- File: `packages/tui/src/index.tsx`
- Added `shouldRenderEmbeddedWorkPaneFullscreen(view, hasEmbeddedWorkPane)`.
- When the unified dashboard is in `view === "work"` with an embedded work pane, the dashboard now returns the work pane directly instead of rendering launcher chrome around it.

### 2. Runtime auth refresh after inline auth commands
- Files:
  - `packages/orchestrator/src/work-shell-engine.ts`
  - `packages/orchestrator/src/work-shell-engine-factory.ts`
  - `apps/unclecode-cli/src/work-runtime.ts`
  - `src/providers.ts`
  - `src/agent.ts`
  - `src/cli.tsx`
- Added `refreshAuthState()` wiring for work-shell inline auth commands.
- After `auth ...` inline commands, the engine now re-resolves auth, refreshes the visible `authLabel`, and pushes the refreshed bearer token into the live provider runtime.
- Added in-place provider token refresh support via `OpenAIProvider.updateAuthToken()` and `CodingAgent.refreshAuthToken()`.

### 3. Stronger transcript hierarchy
- File: `packages/tui/src/work-shell-view.tsx`
- Added role badges:
  - `You` = `◉`
  - `Answer` = `✦`
  - `Step` = `→`
  - `Note` = `·`
- Upgraded user / assistant / tool entries to rounded bordered blocks for faster role separation.

## Verification

### Targeted regression batch
```bash
node --conditions=source --import tsx --test \
  tests/work/agent.test.mjs \
  tests/contracts/tui-dashboard.contract.test.mjs \
  tests/contracts/tui-work-shell.contract.test.mjs \
  tests/orchestrator/work-shell-engine.test.mjs
```
- Result: `49 / 49 pass`

### Wider affected-surface batch
```bash
npm run build --silent && \
node --conditions=source --import tsx --test \
  tests/contracts/tui-dashboard.contract.test.mjs \
  tests/contracts/tui-work-shell.contract.test.mjs \
  tests/contracts/unclecode-cli.contract.test.mjs \
  tests/orchestrator/work-shell-engine.test.mjs \
  tests/commands/tui-action-runner.test.mjs \
  tests/integration/unclecode-auth-login.integration.test.mjs \
  tests/integration/unclecode-work.integration.test.mjs \
  tests/work/repl.test.mjs
```
- Result: `145 / 145 pass`

## Outcome
The final screenshot blockers are now addressed at the product seams rather than with copy-only workarounds:
- embedded work view is primary/fullscreen,
- auth UI and provider runtime re-sync after inline auth actions,
- transcript roles are visibly distinct at a glance.
