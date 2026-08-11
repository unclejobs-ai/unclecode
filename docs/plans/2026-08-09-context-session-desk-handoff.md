# Context Desk / Session Desk implementation handoff

> **Date:** 2026-08-09
> **Status:** Design complete and independently reviewed; implementation and RED tests have not started
> **Branch:** `feat/context-lifecycle-ledger`
> **Worktree:** `/Users/parkeungje/project/unclecode/.worktrees/context-lifecycle-ledger`
> **Scope:** Pure Yazi-style three-pane `/context` workspace, symmetric embedded `Ctrl+O` Session Desk, responsive terminal layout, shared-chrome cleanup, and standalone/embedded TTY proof

## Why this handoff exists

The product direction is settled. The prior pass completed the design and review work but intentionally did not change production code. The next executor should not restart discovery or redesign the surface; it should begin with the three RED test slices below and drive each to green.

This document records:

- the exact approved behavior;
- the current code seams and known traps;
- the required RED → GREEN order;
- the verification matrix and commands;
- what is deliberately out of scope.

---

## Current repository truth

At handoff creation:

- the branch tracks `origin/feat/context-lifecycle-ledger`;
- no production or test file has been changed for this redesign;
- the redesign specification is untracked and must be retained:
  - `docs/superpowers/specs/2026-08-09-context-session-desk-redesign.md`;
- this handoff is the only other new artifact;
- no dependency, schema, receipt, CRP selector, or provider-payload change is approved.

The focused baseline is green before implementation:

```text
73 tests, 73 passed, 0 failed
```

Command executed successfully on 2026-08-09:

```bash
node --disable-warning=ExperimentalWarning \
  --conditions=source \
  --import tsx \
  --test \
  tests/tui/work-shell-context-inspector-keyboard.test.mjs \
  tests/tui/work-shell-context-inspector-model.test.mjs \
  tests/tui/work-shell-context-inspector-render.test.mjs \
  tests/contracts/tui-session-center.contract.test.mjs
```

Do not treat the current stacked Context renderer as partially implemented Yazi behavior. It is the green baseline to replace through tests.

---

## Authoritative design

Primary specification:

- `docs/superpowers/specs/2026-08-09-context-session-desk-redesign.md`

Preserved lifecycle contract:

- `docs/superpowers/specs/2026-07-13-context-lifecycle-ledger-design.md`

Independent review artifact:

- `agent://DeskSpecReview`

Review result before handoff:

- Critical: 0 outstanding;
- Major: 0 outstanding.

A final consistency pass after the review explicitly authorized one additional ownership repair: the Work composer text draft must be controlled by the still-mounted Dashboard so a Work ↔ Session Desk round trip can preserve it while the Work pane subtree is unmounted. Clipboard attachments, slash-picker dismissal state, and terminal focus remain pane-local.

---

## Approved product behavior

### Context Desk

`/context` opens a dedicated workspace inside the existing Work shell. It replaces conversation/composer content but does not add a second application frame.

Required topology:

```text
┌ Sources ───────────┬ Preview ─────────────────────────┐
│ grouped source tree│ selected source summary/content │
│ one selected row   ├ Details / Actions ──────────────┤
│ bounded viewport   │ detail, receipt, warning, advice│
└────────────────────┴──────────────────────────────────┘
 path · context/token-cost statusline
```

Rules:

- Sources, Preview, and Details/Actions are simultaneously visible at 52×40, 80×30, and 120×40.
- Below `bodyWidth = 48` or `bodyRows = 17`, render only the focused pane at full size with a `1/3`, `2/3`, or `3/3` indicator.
- Below four usable body rows, render one bounded terminal-too-small line; `Esc` still closes.
- `Tab` cycles Sources → Preview → Details → Sources.
- `↑`/`↓` move the source only in Sources.
- `↑`/`↓` scroll Preview only in Preview.
- `↑`/`↓` scroll the complete Details/Actions surface in Details, even when no source detail is expanded.
- `Enter` from Sources loads/toggles detail and enters Details; from Preview it enters Details; from Details it closes the expanded reader and returns to Sources.
- `Space` toggles send/hold when callbacks permit.
- Lowercase `p` toggles pin when callbacks permit. Uppercase `P` is intentionally not added.
- `A`/`a` and `R`/`r` retain existing optimizer gating.
- Context Desk key handling occurs before composer text capture regardless of hidden draft contents.
- Global `Ctrl+O` retains precedence: it opens Session Desk without clearing the hidden draft; `Ctrl+O` back restores the same Context pane, cursor, offsets, expansion, and draft.
- `Esc` closes Context Desk and restores the same Work draft.
- No standalone Focus section remains. Selection appears once in Sources and once as Preview content.
- Existing packet proof, unknown-token honesty, grouped source identities, action receipts, warnings, advice, and mutation callbacks remain authoritative.

### Shared Work chrome

`WorkShellView` remains the sole owner of:

- `WorkShellHeaderBlock`;
- the Work status rail and model/mode/auth/busy facts;
- `formatWorkShellFooterLine` for compact path + context/token-cost status.

The Context Desk must not render:

- another `UncleCode` banner;
- another outer round frame;
- another statusline;
- a composer hint.

Existing agent-console/subagent activity must remain visible once, inside the bounded Details/Actions pane. It is not part of `formatWorkShellFooterLine`.

### Session Desk

Embedded Work and History become a symmetric toggle:

```text
Work --Ctrl+O--> Session Desk
Work <--Ctrl+O-- Session Desk
Work <---Esc---- Session Desk
```

Rules:

- Work-side `onRequestSessionsView` remains an idempotent open operation.
- Dashboard-side `Ctrl+O` returns to Work before implicit submit, letter shortcuts, `Esc`, or numeric-tab routing.
- Dashboard recognizes both Ink forms: raw `\u000f` and `key.ctrl` with value `o`.
- Repeated Work-side raw `\u000f` must not self-cancel in the existing repeat loop.
- Exactly one input handler is active. Do not keep a hidden Work pane mounted.
- The externally owned Work engine and Context Desk engine state survive the toggle.
- The Work text draft survives through a minimal Dashboard-owned controlled-value seam.
- Session selection remains `centerState.sessionIndex`.
- Session list scrolling remains derived from selected index, item count, and pane rows; do not add a second selected-session or list-offset field.
- One `Enter` resumes the selected session.
- Existing approval/detail `Esc` precedence remains intact.
- The Dashboard status text renders once, in the canonical footer status bar; remove the duplicate line below the tabs.

---

## Load-bearing code seams

### Context state and lifecycle

Primary files:

- `packages/orchestrator/src/work-shell-engine.ts`
- `packages/orchestrator/src/work-shell-engine-state.ts`
- `packages/tui/src/work-shell-hooks.ts`
- `packages/tui/src/work-shell-input.ts`
- `packages/tui/src/work-shell-pane.tsx`

Existing state to preserve:

- `contextInspectorCursor`;
- `contextInspectorExpanded`;
- `contextInspectorDetailContent`;
- `contextInspectorDetailOffset`.

Approved additions:

```ts
type ContextDeskPane = "sources" | "preview" | "details";

contextDeskPane: ContextDeskPane;
contextDeskPreviewOffset: number;
```

`contextInspectorDetailOffset` becomes the requested offset for the whole Details/Actions surface. Do not add a duplicate details offset.

Important trap:

- `moveContextInspectorDetailOffset` currently returns early when `contextInspectorExpanded === null` in `work-shell-engine.ts`.
- Remove that guard for Details-focused scrolling. The renderer, not the engine, clamps the requested offset to current wrapped-line bounds.

### Context keyboard routing

Primary files:

- `packages/tui/src/work-shell-hooks.ts`
- `packages/tui/src/work-shell-input.ts`
- `tests/tui/work-shell-context-inspector-keyboard.test.mjs`

Current trap:

- the Context gate only steals navigation keys or mutation keys while the composer is raw-empty;
- it also bails for a leading `/`;
- this lets `Tab`, `Space`, `p`, `a`, and `r` mutate an invisible non-empty draft.

Required repair:

- once `activePanel.title === "Context expanded"`, resolve every non-global key through the Context Desk resolver before composer capture;
- add `key.tab` and pane-specific actions;
- return after every handled or intentionally ignored desk key so it cannot fall through into the composer;
- preserve the earlier global `Ctrl+O` branch, but do not call `replaceValue("")` while Context Desk is open.

### Context composition and layout

Primary files:

- `packages/tui/src/work-shell-context-inspector.tsx`
- `packages/tui/src/work-shell-context-inspector-model.ts`
- `packages/tui/src/work-shell-context-inspector-sources.tsx`
- `packages/tui/src/work-shell-context-inspector-focus.tsx`
- `packages/tui/src/work-shell-context-workbench.tsx`
- `packages/tui/src/work-shell-context-inspector-header.tsx`
- `packages/tui/src/work-shell-context-inspector-warnings.tsx`
- `packages/tui/src/work-shell-context-advice.tsx`
- `packages/tui/src/work-shell-view.tsx`

Reuse:

- source grouping and source-ID cursor remapping;
- packet header/proof and receipt formatters;
- preview sanitization and display-width helpers;
- warning/advice renderers and existing callback availability;
- `formatWorkShellAgentConsoleActivityLines`.

Remove from the live desk path:

- the legacy outer `borderStyle="round" paddingX={1}` frame;
- `computeContextOverlayViewportMaxRows` (`terminalRows - 25`);
- `computeContextOverlaySectionMaxRows` (independent physical-row fractions);
- the standalone Focus composition.

Create one pure layout helper whose input is the already allocated `bodyWidth` and `bodyRows`. Pane allocations include their own border columns. All pane children receive explicit content width and row capacity; no child re-reads terminal size.

### Session toggle and draft ownership

Primary files:

- `packages/tui/src/dashboard-shell.tsx`
- `packages/tui/src/dashboard-navigation.ts`
- `packages/tui/src/dashboard-model.ts`
- `packages/tui/src/dashboard-render.tsx`
- `packages/tui/src/work-shell-dashboard.tsx`
- `packages/tui/src/work-shell-pane.tsx`
- `packages/tui/src/work-shell-hooks.ts`
- `packages/tui/src/shell-state.ts`
- `tests/contracts/tui-session-center.contract.test.mjs`

Required ownership repair:

- add a Dashboard-owned Work composer draft value;
- extend the existing `renderWorkPane` controls with controlled draft value/change fields;
- pass those fields through `EmbeddedWorkShellPane` into `WorkShellPane` / `useWorkShellPaneState`;
- keep pending clipboard attachments and picker-local state inside the pane;
- do not add an effect or mount the Work pane invisibly.

Current Dashboard input trap:

- `handleSessionCenterInput` handles ordinary History input, but no earlier symmetric `Ctrl+O` return branch exists;
- raw `\u000f` and `key.ctrl + o` must be normalized before implicit submit and shortcuts.

Current duplicate-status seam:

- `Dashboard` renders `screenStatus` immediately below `ViewTabs` and later renders the footer `StatusBar`;
- delete the below-tabs copy and keep the footer.

---

## Required RED → GREEN execution order

Do not implement first. Add each observable contract, run it to the expected failure, then make only that slice green.

### Slice 1 — Context render and layout

Tests:

- `tests/tui/work-shell-context-inspector-model.test.mjs`
- `tests/tui/work-shell-context-inspector-render.test.mjs`

Add failing coverage for:

1. 120×40, 80×30, and 52×40 all show Sources, Preview, and Details/Actions concurrently.
2. Width or height emergency mode renders only the selected pane and stays in bounds.
3. 40×12 exercises vertical emergency behavior.
4. CJK/wide labels do not exceed pane width.
5. No outer `UncleCode Context Desk` frame or standalone Focus duplicate renders.
6. Agent activity appears once and is bounded below safety-critical details.
7. Every hidden region has an explicit overflow marker.

Expected initial failure: current output is stacked, uses legacy row budgets, includes the old desk frame/focus composition, and has no pane allocation model.

Then implement only layout/composition until these tests pass.

### Slice 2 — Context focus and keyboard ownership

Tests:

- `tests/tui/work-shell-context-inspector-keyboard.test.mjs`
- `tests/orchestrator/work-shell-engine.test.mjs`

Add failing coverage for:

1. `Tab` cycles all three panes.
2. Arrow dispatch depends on pane, not on `contextInspectorExpanded`.
3. Details scrolls when no source is expanded.
4. Source movement resets preview/details offsets.
5. Non-empty and whitespace drafts cannot capture Context keys.
6. A leading `/` hidden draft cannot reactivate slash input while the desk is open.
7. Disabled mutation keys are consumed as no-ops rather than appended to the draft.
8. `Ctrl+O` from Context Desk does not clear the controlled Work draft.
9. `Ctrl+O` back restores pane, cursor, offsets, expansion, and draft.

Expected initial failure: the resolver has no Tab/pane actions, the hook has a raw-empty gate, and the engine refuses details scrolling without expansion.

Then implement only state transitions/input routing until these tests pass.

### Slice 3 — Session toggle, draft, selection, and status

Tests:

- `tests/contracts/tui-session-center.contract.test.mjs`
- add a focused Dashboard Ink behavior test only if the existing contract harness cannot exercise the mounted input path.

Add failing coverage for:

1. raw `\u000f` returns Session Desk → Work;
2. `key.ctrl + o` returns Session Desk → Work;
3. Work-side repeated raw `\u000f` remains idempotent open;
4. Work draft survives Work → Session → Work;
5. selected session and session-column focus survive reopening;
6. visible session window is derived around the preserved index;
7. one Enter resumes the selected row;
8. approval/detail Escape still wins before top-level return;
9. Dashboard status text occurs once.

Expected initial failure: Dashboard has no symmetric Ctrl+O branch, Work draft is pane-local, and status is duplicated below tabs and in the footer.

Then implement only the toggle/draft/status seams until these tests pass.

---

## Verification after all three slices are green

### Focused suite

```bash
node --disable-warning=ExperimentalWarning \
  --conditions=source \
  --import tsx \
  --test \
  tests/tui/work-shell-context-inspector-keyboard.test.mjs \
  tests/tui/work-shell-context-inspector-model.test.mjs \
  tests/tui/work-shell-context-inspector-render.test.mjs \
  tests/orchestrator/work-shell-engine.test.mjs \
  tests/contracts/tui-session-center.contract.test.mjs
```

### Node checks

Use the repository-pinned Node runtime (`>=22.18.0`; this workstation has `~/.nvm/versions/node/v22.22.2/bin`). Build before typecheck because package subpath exports resolve through `dist/`.

```bash
npm run lint
npm run build
npm run check
npm run test:tui
npm run test:orchestrator
npm run test:contracts
```

### Rust and runtime prerequisites

```bash
cargo build --workspace
npm run qa:runtime
```

Known pre-existing full-suite issues from repository instructions, not redesign regressions:

- `tests/contracts/orchestrator-multi-agent.contract.test.mjs` has an outdated ultrawork→complex name/expectation;
- `tests/work/tools.test.mjs` assumes the checkout path contains `/unclecode/`.

Do not “fix” those as part of this feature unless a changed path directly requires it.

### Actual terminal proof

Build Rust before launching the CLI. Use tmux or another real PTY; snapshot-only Ink tests are not enough.

Standalone `unclecode`:

1. open `/context` at narrow, medium, and wide sizes;
2. cycle all panes;
3. move/scroll independently;
4. exercise `Space`, lowercase `p`, `A`/`R` only when available;
5. close and reopen without context mutation;
6. verify shared chrome appears once;
7. toggle Session Desk and return.

Embedded `unclecode work`:

1. create a non-empty draft;
2. open Context Desk and verify desk keys do not alter it;
3. change pane/cursor/scroll/expansion;
4. press `Ctrl+O` to Session Desk;
5. move Session selection, return with `Ctrl+O`, and verify draft plus Context state;
6. reopen Session Desk and verify selection window;
7. resume one selected session with one Enter;
8. confirm no duplicate statusline and no overflow at target sizes.

Required terminal sizes:

- 120×40;
- 80×30;
- 52×40;
- 40×12 emergency projection.

Record pane output or screenshots for both standalone and embedded paths.

---

## Non-goals and constraints

Do not:

- change CRP selection, packet, receipt, suggestion, or memory-lineage schemas;
- invent a second context data source or mutation model;
- add dependencies;
- redesign the global statusline, composer, model picker, or conversation transcript;
- add Shift+Tab, page-wise scrolling, or new pin-key semantics;
- keep Work mounted invisibly under Session Desk;
- introduce a Session list scroll offset or duplicate selected-session field;
- use `useEffect` for derived layout, draft mirroring, or view-reset wiring;
- suppress overflow or truncate without a visible marker;
- claim attachment or terminal-focus preservation across Session Desk.

Keep the diff narrow: reuse, recompose, and repair state/input ownership at existing seams.

---

## Completion definition

The feature is complete only when all of the following are true:

- the three RED suites were observed failing for the intended reason before implementation;
- focused tests pass;
- Node build/typecheck/lint and relevant suites pass;
- Rust workspace builds;
- Context lifecycle regression tests remain green;
- standalone and embedded real-PTY paths are exercised at all required sizes;
- a focused implementation review has zero unresolved Critical/Warning findings;
- no production behavior outside the approved desk/toggle/chrome seams changed.

---

## Copy-paste continuation prompt

```text
Continue the Context Desk / Session Desk implementation in
/Users/parkeungje/project/unclecode/.worktrees/context-lifecycle-ledger.

Read first:
- docs/plans/2026-08-09-context-session-desk-handoff.md
- docs/superpowers/specs/2026-08-09-context-session-desk-redesign.md
- docs/superpowers/specs/2026-07-13-context-lifecycle-ledger-design.md

Do not redesign. Begin with Slice 1 RED render/model tests, observe the intended failure,
then implement the smallest green change. Continue through keyboard and Session slices,
run the listed verification, and prove standalone + embedded behavior in a real PTY.
```
