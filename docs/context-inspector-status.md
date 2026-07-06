# `/context` Redesign — Status & Roadmap

> Last updated: 2026-07-05
> Companion to: [`docs/design/context-inspector-redesign.md`](design/context-inspector-redesign.md)
> Related: `crp-context-runbook-protocol.md`

## 1. Executive Summary

`/context` was built as a **chat command** that appended a read-only snapshot
to the conversation (`user: /context` + `system: Context opened`) inside a
12-line box that vanished on any keystroke. The redesign reframes it as a
**Context Inspector** — an ephemeral overlay that reads from the CRP SQL store,
cohabits with the composer, and lets the user act on sources (pin / unpin /
forget / include / expand) rather than just look at them. Sprint 1 has landed
the foundational fixes: the builtin is silent (no history pollution), the line
cap is gone, the overlay survives typing, and the four store mutation
functions exist and are tested. What remains is the interactive layer —
keyboard navigation, cursor state, source expansion, and the adaptive token
meter — plus the full-height modal that turns the current bottom-anchored box
into a true inspector.

## 2. Audit Results — 12 Defects

The original audit (`context-inspector-redesign.md` appendix) listed twelve
defects. Status against the current tree:

| # | Defect | Status | Evidence / Notes |
|---|--------|--------|------------------|
| 1 | Read-only dump — no pin/unpin/forget/expand/scroll | **IN PROGRESS** | SQL mutations exist (`store-writes.ts:215-240`); TUI keyboard wiring PENDING |
| 2 | `/context` pollutes conversation history | **FIXED** | `work-shell-engine-builtin-runtime.ts:160-176` — `appendEntries` dropped |
| 3 | Hard 12-line cap, no scrollback | **PARTIAL** | Cap raised to 999 (`work-shell-view.tsx:291`); scroll/cursor PENDING |
| 4 | Auto-hide on any keystroke | **FIXED** | `shouldHideWorkShellOverlayForInput` always returns `false` (`work-shell-view.tsx:310-319`) |
| 5 | Two divergent data paths (compact packet vs Rust dump) | **PENDING** | Not yet unified onto `selectContextSources` |
| 6 | Collapsed state invisible (no context panel by default) | **PENDING** | Scheduled for Sprint 3 |
| 7 | Token meter hard-coded to 200k | **PENDING** | `renderRunbookLine` still uses `budgetWindow = 200_000` (`work-shell-view.tsx:845`) |
| 8 | "Held back" under-explained | **PENDING** | |
| 9 | Source previews truncated at 64 chars | **PENDING** | Expand action scheduled for Sprint 2 |
| 10 | Internal storage paths leak (`.omo/` scrub is a band-aid) | **PENDING** | |
| 11 | Refresh is destructive (re-appends history + re-runs full sync) | **FIXED** | `/context` no longer appends entries (see #2); `/reload` still does, by design |
| 12 | Section headers weak (no rules, visual containment) | **PENDING** | |

**Summary:** 3 fixed, 1 partial, 8 pending. The fixes target the *worst* pain
(history pollution, line cap, auto-hide); the interactive and polish layer is
still ahead.

## 3. Sprint 1 — Done

Sprint 1 landed the foundational fixes and the data layer. Note: the actual
implementation reordered the design doc's phasing — the store mutations
(design Sprint 2 item D) were pulled forward because they are the
prerequisite for every later keyboard action, while the full-height modal and
scroll (design Sprint 1 items B/C) were pushed right because they depend on
cursor state that does not exist yet.

### 3.1 Silent builtin — no history pollution

`/context` no longer appends `user` / `system` entries to the conversation.
The `case "context"` handler computes the panel and calls only `setState`;
`appendEntries` is gone.

**Evidence:** `packages/orchestrator/src/work-shell-engine-builtin-runtime.ts:160-176`

```ts
case "context": {
  const contextPacket = await input.refreshContextPacket?.();
  const result = createContextBuiltinResult({ ... });
  // Context Inspector redesign: /context is an inspector, not a chat
  // turn. It must NOT pollute the conversation history ...
  input.setState({ panel: result.panel });
  return;   // ← no input.appendEntries(...) call
}
```

Compare with every other builtin in the same switch (`help`, `status`,
`model`, `reload`, …) — they all call `input.appendEntries(...)`. The
`context` case is now the only one that doesn't.

### 3.2 Line limit removed (12 → 999)

The hard 12-line cap that silently hid sources with no way to see them has
been effectively removed. The constant is now `999`; the comment records that
scroll (Sprint 2 cursor state) is the intended long-term answer.

**Evidence:** `packages/tui/src/work-shell-view.tsx:287-308`

```ts
const WORK_SHELL_CONTEXT_OVERLAY_LINE_LIMIT = 999;
```

### 3.3 Auto-hide disabled (composer cohabitation)

The overlay no longer dismisses on any keystroke. `shouldHideWorkShellOverlayForInput`
unconditionally returns `false`; only Esc or `/context` toggle closes the
overlay. The user can now read context while composing a follow-up.

**Evidence:** `packages/tui/src/work-shell-view.tsx:310-319`

```ts
export function shouldHideWorkShellOverlayForInput(input: { ... }): boolean {
  void input;
  return false;
}
```

### 3.4 Store action functions added

Four SQL mutation functions landed on the CRP store, with full method
wrappers on the store class and contract tests. These are the verbs the
Sprint 2 keyboard actions will call.

**Evidence:** `packages/agentops-db/src/store-writes.ts:215-240`

| Function | SQL effect | Maps to action |
|----------|-----------|----------------|
| `pinContextSource(db, id)` | `SET salience = 1.0` | `Enter` on included source |
| `unpinContextSource(db, id)` | `SET salience = 0.5` (default) | `Enter` on pinned source |
| `forgetContextSource(db, id)` | `SET included_in_model = 0` | `f` (move to Held back) |
| `includeContextSource(db, id)` | `SET included_in_model = 1` | `i` on held-back source |

Wired into the store class at `packages/agentops-db/src/store.ts:275-288` and
declared on the interface at `store-types.ts:143-146`.

**Test count:** 4 dedicated tests in `tests/agentops-db/context-sources.test.mjs`
(`pinContextSource sets salience to 1.0`, `unpinContextSource restores default
salience`, `forgetContextSource moves source to heldBack`, `includeContextSource
restores held-back source`) — each asserts the resulting `selectContextSources`
output reflects the mutation.

## 4. Sprint 2 — Next

Sprint 2 makes the inspector *interactive*. The data layer is ready; the TUI
needs cursor state and keyboard dispatch.

| Item | What | Touches |
|------|------|---------|
| **Cursor state** | Add `contextScrollOffset` / `contextCursorIndex` to engine state so the overlay knows which row is selected. Prerequisite for navigation, pin, and expand. | `work-shell-engine.ts` (state shape), `work-shell-view.tsx` (render highlight) |
| **Keyboard navigation** | `↑/↓` (and `j/k`) move the cursor; `PgUp/PgDn` scroll. When the cursor passes the visible area, the scroll offset adjusts. | `work-shell-input.ts` (`resolveWorkShellInputAction`) |
| **Pin / unpin / forget / include actions** | Wire `Enter` → `pin/unpinContextSource`, `f` → `forgetContextSource`, `i` → `includeContextSource`. Each mutation calls `selectContextSources` and re-renders. Visual feedback: pinned sources show `◆` vs `◇`; held-back rows render dimmed. | `work-shell-engine-builtin-runtime.ts` or a new action handler; calls the Sprint 1 store functions |
| **Source detail expand** | `e` toggles an expanded view for the cursor row: full `content` field wrapped to terminal width instead of the 64-char preview. One source expanded at a time. | `work-shell-view.tsx` (`renderRunbookLine`) |

The unifying principle: **every action is a SQL mutation followed by a
re-render.** The store is the single source of truth; the overlay never holds
authoritative inclusion state.

## 5. Sprint 3 — Future

Polish items, none blocking core usability.

| Item | What | Notes |
|------|------|-------|
| **Adaptive token meter** | Read the active model's context window from provider metadata; scale the budget bar to the real window (128k / 200k / 1M). Today `renderRunbookLine` hard-codes `budgetWindow = 200_000` (`work-shell-view.tsx:845`) and labels the meter `"of 200k window"`. | Defect #7 |
| **Collapsed status enhancement** | Replace the `context 24 ready` chip with a persistent 1-line summary in the composer dock: `▤ 24 sources · ▓▓░░░░░░ 548/128k · /context to inspect`. | Defect #6 |
| **Full-height modal mode** | When the context panel is active, render it as a modal that takes the full conversation area height (design doc §B). Today the overlay is still a bottom-anchored box layered under the composer; the modal needs a new `getWorkShellPanelDisplayMode` return value (`"modal"`) and an `contextOverlayOpen` boolean in engine state. | Design §B |
| **Single data path** | Retire the Rust `context_panel` fallback for the overlay so all rendering reads from `selectContextSources`. | Defect #5 |
| **Section headers / held-back explanation / path scrubbing** | Visual containment rules, richer "Held back" copy, and replacing the `.omo/` scrub band-aid. | Defects #8, #10, #12 |

## 6. Connection to CRP

The inspector is the TUI surface of the **Context Runbook Protocol (CRP)**
SQL store. It does not maintain its own notion of what is included — it reads
and mutates `context_sources`.

```
/context (open)  ──► selectContextSources(db, { projectId, tokenBudget, turnIndex })
                         │
                         ▼
                    render overlay (Included / Held back sections)

Enter (pin)      ──► pinContextSource(db, id)        ──► SET salience = 1.0
f    (forget)    ──► forgetContextSource(db, id)     ──► SET included_in_model = 0
i    (include)   ──► includeContextSource(db, id)    ──► SET included_in_model = 1
                         │
                         ▼
                    selectContextSources(...)  ◄── re-query (single source of truth)
                         │
                         ▼
                    re-render overlay
```

Key points:

- **One selector.** `selectContextSources` (`packages/agentops-db/src/store-context-reads.ts:21`)
  ranks sources by `salience DESC, updated_at DESC`, greedily fills the token
  budget, and splits `included_in_model = 0` rows into a `heldBack` array —
  which is exactly the overlay's two-section layout.
- **Mutations are trivial UPDATEs** on top of the existing schema. No new
  tables, no new columns. The Sprint 1 functions are each a single prepared
  statement.
- **Action → SQL mutation → re-render** is the entire loop. The overlay holds
  no authoritative state; closing and reopening it always reflects the store.
- **Phase dependency.** This redesign is the TUI layer of CRP Phase 5 and
  depends on Phases 1–3 (store + providers + selector), which are done.

## 7. Test Coverage

### Store layer (`tests/agentops-db/context-sources.test.mjs`)

14 tests total. The four Sprint 1 action functions are each covered by a
dedicated test asserting the post-mutation `selectContextSources` result:

| Test | Asserts |
|------|---------|
| `pinContextSource sets salience to 1.0` | after pin, `selected[0].salience === 1.0` |
| `unpinContextSource restores default salience` | after unpin, `selected[0].salience === 0.5` |
| `forgetContextSource moves source to heldBack` | `selected.length === 0`, `heldBack.length === 1` |
| `includeContextSource restores held-back source` | `selected.length === 1`, `heldBack.length === 0` |

### TUI overlay (`tests/contracts/tui-work-shell.contract.test.mjs`)

The contract test `"getWorkShellPanelPlacement keeps long-session panels near the composer by default"`
(now the overlay-cohabitation + line-limit contract) was updated to lock in
the Sprint 1 behavior:

| Assertion | Locks in |
|-----------|----------|
| `shouldHideWorkShellOverlayForInput({ panelTitle: "Context expanded", inputValue: "plain text" }) === false` | Auto-hide disabled (defect #4) |
| `shouldHideWorkShellOverlayForInput({ ..., inputValue: "" }) === false` | Overlay stays open even with empty input |
| `shouldReportWorkShellOverlayOpen({ ..., inputValue: "plain text" }) === false` | Hidden overlays must not steal Esc from composer |
| `shouldReportWorkShellOverlayOpen({ ..., inputValue: "" }) === true` | Open overlay reports as open |
| `formatWorkShellOverlayPanelLines` passes all 14 lines unchanged | Line cap removed (defect #3) |

### Not yet covered

| Gap | Sprint |
|-----|--------|
| Keyboard action dispatch (↑/↓/Enter/f/i/e) | 2 |
| Cursor state transitions | 2 |
| Source expand rendering (full content vs 64-char preview) | 2 |
| Adaptive token meter scaling | 3 |
| Full-height modal display mode | 3 |
