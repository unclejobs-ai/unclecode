# TUI Render Entry Split Design (2026-04-09)

## Goal
Complete Task 12 Step 3 of the follow-up roadmap by extracting render-entry responsibilities out of `packages/tui/src/index.tsx` without changing any operator-visible behavior. This pass introduces dedicated modules for the `Dashboard` component and the render-entry helpers, shrinking the remaining hotspot and preparing for later shared-store work.

## Scope
- Applies only to the render-entry helpers and the `Dashboard` component currently living in `packages/tui/src/index.tsx`.
- No behavioral changes; caller APIs and exports remain stable.
- Documentation and contract evidence updated within the same turn after code changes.

## Architecture
### Current state
`packages/tui/src/index.tsx` still owns:
- `Dashboard` React component definition (tabs, panes, panels)
- `createDashboardElement(...)`
- `renderEmbeddedWorkShellPaneDashboard(...)`
- `renderManagedWorkShellDashboard(...)`
- `renderTui(...)`

Consumers (`apps/unclecode-cli`, tests, contracts) import those helpers via `@unclecode/tui`. Recent extractions already moved actions/navigation/render-props to their own files.

### Target state
```
packages/tui/src/
  dashboard-shell.tsx      # new: Dashboard component + local JSX helpers
  tui-entry.tsx            # new: render-entry helpers and orchestration
  index.tsx                # barrel exporting public API
```

- `dashboard-shell.tsx`
  - Default export `Dashboard` (same props as today)
  - Co-located helper components/types used only by `Dashboard`
  - Imports action/navigation/render helpers as needed
- `tui-entry.tsx`
  - `createDashboardElement`, `renderEmbeddedWorkShellPaneDashboard`, `renderManagedWorkShellDashboard`, `renderTui`
  - Imports `Dashboard` from `dashboard-shell.tsx`
  - Re-exports needed types for managed/embedded inputs
- `index.tsx`
  - Re-exports public API from the new modules plus the seams extracted previously
  - Contains no render logic beyond re-export definitions

## Data flow & integration
- External callers continue `import { renderTui } from '@unclecode/tui'`; only module boundaries change.
- `Dashboard` type signatures remain identical, so ink compatibility and runtime behavior stay fixed.
- Contract tests updated to assert presence of new modules and ensure exports stay reachable from `@unclecode/tui`.

## Risks & mitigations
- **Risk:** Missing React import in new files. **Mitigation:** Ensure `import React from 'react'` (or `import * as React`) is present per existing pattern.
- **Risk:** Export drift (e.g., forgetting to re-export `Dashboard`). **Mitigation:** Update `index.tsx` re-exports and extend contract tests to cover them.
- **Risk:** Path-based imports in docs/tests become stale. **Mitigation:** Search for direct relative imports and adjust if necessary (currently none outside TUI package).

## Testing & verification plan
1. `npm run lint`
2. `npm run check`
3. `node --conditions=source --import tsx --test tests/contracts/tui-dashboard.contract.test.mjs tests/contracts/tui-session-center.contract.test.mjs`
4. `node --conditions=source --import tsx --test tests/contracts/tui-dashboard.contract.test.mjs tests/contracts/tui-work-shell.contract.test.mjs tests/work/repl.test.mjs tests/work/work-runtime.test.mjs tests/contracts/unclecode-cli.contract.test.mjs`
5. Update `.sisyphus/evidence/2026-04-08-tui-hotspot-handoff.md` and roadmap to note Step 3 completion.

## Out of scope
- Step 4 (barrel-only exports after moving `Dashboard`), shared shell store (Task 13), or composer/focus work (Task 15).
- Any UX feature changes (busy affordances, composer multiline, etc.).

## Rollback plan
Revert the new files and restore `Dashboard` + render helpers to `packages/tui/src/index.tsx` if tests expose unexpected regressions.
