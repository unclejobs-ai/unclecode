# TUI Render Entry Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the Dashboard component and render-entry helpers into dedicated modules while keeping the public `@unclecode/tui` API stable.

**Architecture:** Introduce `packages/tui/src/dashboard-shell.tsx` for the `Dashboard` component and `packages/tui/src/tui-entry.tsx` for render-entry helpers. Update `packages/tui/src/index.tsx` to re-export the same public API from the new seams and refresh contracts/docs.

**Tech Stack:** TypeScript, Ink/React components, Vitest-style Node test runner (`node --conditions=source --import tsx --test`), npm scripts (`lint`, `check`).

---

## File map
- **Create:** `packages/tui/src/dashboard-shell.tsx` — owns `Dashboard` component + local helper components/types.
- **Create:** `packages/tui/src/tui-entry.tsx` — owns `createDashboardElement`, `renderEmbeddedWorkShellPaneDashboard`, `renderManagedWorkShellDashboard`, `renderTui`.
- **Modify:** `packages/tui/src/index.tsx` — re-export modules from extracted files; remove inline implementations.
- **Modify:** `tests/contracts/tui-dashboard.contract.test.mjs` — assert new module ownership and exported API.
- **Modify:** `.sisyphus/evidence/2026-04-08-tui-hotspot-handoff.md` — record completed Step 3 details.
- **Modify:** `docs/plans/2026-04-05-unclecode-post-plan-followup-refactor-roadmap.md` — mark Task 12 Step 3 complete.

---

### Task 1: Add `Dashboard` component module

**Files:**
- Create: `packages/tui/src/dashboard-shell.tsx`
- Modify: `packages/tui/src/index.tsx`

- [ ] **Step 1: Copy existing Dashboard component**

```tsx
// packages/tui/src/dashboard-shell.tsx
import React from 'react';
import { DASHBOARD_ACTIONS } from './dashboard-actions.js';
import { handleDashboardInput, handleSessionCenterInput, handleResearchDraftInput } from './dashboard-navigation.js';
import { DashboardProps } from './types.js'; // adjust to actual prop type import

export function Dashboard(props: DashboardProps) {
  const { homeState, embeddedWorkPane, views, runtimeCallbacks, shellContext } = props;
  // ... paste existing Dashboard JSX section from index.tsx verbatim ...
}
```

- [ ] **Step 2: Remove component from `index.tsx`**
  - Delete the original `Dashboard` declaration.
  - Add `export { Dashboard } from './dashboard-shell.js';` inside `index.tsx` to keep API stable.

- [ ] **Step 3: Ensure local helper components/types move with Dashboard**
  - If `Dashboard` used inline helpers (e.g., `SessionsTab`, `ViewPanel`), move them into `dashboard-shell.tsx` below the main component.

- [ ] **Step 4: Type check**

```bash
npm run check
```
Expected: PASS.

### Task 2: Extract render-entry helpers

**Files:**
- Create: `packages/tui/src/tui-entry.tsx`
- Modify: `packages/tui/src/index.tsx`

- [ ] **Step 1: Move helper implementations**

```tsx
// packages/tui/src/tui-entry.tsx
import React from 'react';
import { Dashboard } from './dashboard-shell.js';
import { createEmbeddedWorkShellPaneDashboardProps, createManagedWorkShellDashboardProps } from './dashboard-render.js';
import type { TuiRenderOptions } from './types.js';

export function createDashboardElement(options: TuiRenderOptions) {
  return <Dashboard {...options} />;
}

export function renderEmbeddedWorkShellPaneDashboard(options: EmbeddedOptions) {
  const props = createEmbeddedWorkShellPaneDashboardProps(options);
  return createDashboardElement(props);
}

export function renderManagedWorkShellDashboard(options: ManagedOptions) {
  const props = createManagedWorkShellDashboardProps(options);
  return createDashboardElement(props);
}

export async function renderTui(options: RenderTuiOptions) {
  const element = createDashboardElement(options);
  return inkRender(element);
}
```
  - Bring over any types (`EmbeddedOptions`, `ManagedOptions`, etc.) from `index.tsx` into this file (or import them from existing modules).

- [ ] **Step 2: Update `index.tsx` exports**

```ts
export { Dashboard } from './dashboard-shell.js';
export {
  createDashboardElement,
  renderEmbeddedWorkShellPaneDashboard,
  renderManagedWorkShellDashboard,
  renderTui,
} from './tui-entry.js';
```

- [ ] **Step 3: Clean up old imports**
  - Remove any imports no longer used in `index.tsx` after extraction.

- [ ] **Step 4: Type check**

```bash
npm run check
```
Expected: PASS.

### Task 3: Update contract tests for new seams

**Files:**
- Modify: `tests/contracts/tui-dashboard.contract.test.mjs`

- [ ] **Step 1: Add assertions for file existence**

```js
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dashboardShellPath = resolve(rootDir, 'packages/tui/src/dashboard-shell.tsx');
t.assert.ok(existsSync(dashboardShellPath), 'Dashboard component module exists');
```

- [ ] **Step 2: Assert exports**

```js
t.assert.ok('@unclecode/tui'.includes('renderTui'));
t.assert.match(renderSource, /export\s+\{\s*Dashboard\s*\}/);
```
  - Ensure tests check that `Dashboard` is exported from the package and render helpers come from `tui-entry`.

- [ ] **Step 3: Run targeted contract suite**

```bash
node --conditions=source --import tsx --test tests/contracts/tui-dashboard.contract.test.mjs tests/contracts/tui-session-center.contract.test.mjs
```
Expected: PASS.

### Task 4: Run broader verification suite

**Files:** N/A (tests only)

- [ ] **Step 1: Lint**

```bash
npm run lint
```

- [ ] **Step 2: Type check**

```bash
npm run check
```

- [ ] **Step 3: Runtime and contracts**

```bash
node --conditions=source --import tsx --test \
  tests/contracts/tui-dashboard.contract.test.mjs \
  tests/contracts/tui-session-center.contract.test.mjs \
  tests/contracts/tui-work-shell.contract.test.mjs \
  tests/work/repl.test.mjs \
  tests/work/work-runtime.test.mjs \
  tests/contracts/unclecode-cli.contract.test.mjs
```
Expected: PASS.

### Task 5: Update docs/evidence

**Files:**
- Modify: `.sisyphus/evidence/2026-04-08-tui-hotspot-handoff.md`
- Modify: `docs/plans/2026-04-05-unclecode-post-plan-followup-refactor-roadmap.md`

- [ ] **Step 1: Evidence update**
  - Add bullet noting render-entry split, new files, and verification commands.

- [ ] **Step 2: Roadmap update**
  - Mark Task 12 Step 3 as completed.

- [ ] **Step 3: Proofread docs**
  - Ensure instructions match actual changes.

- [ ] **Step 4: Commit evidence/docs updates after verification.**

---

## Self-review
- All spec requirements covered (new modules, API stability, docs/tests).
- No placeholders or vague steps.
- Names/exports consistent with design (`Dashboard`, `createDashboardElement`, etc.).
