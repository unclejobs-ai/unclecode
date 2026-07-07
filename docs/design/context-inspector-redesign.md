# `/context` Redesign — Context Inspector

> Status: **Proposed** · Date: 2026-07-06
> Related: `crp-context-runbook-protocol.md`, `work-queue-board-t15.md`

## Problem

`/context` was built as a **chat command** that dumps a read-only snapshot.
Twelve concrete defects were identified in audit (see appendix). The root
cause is a category error: `/context` should be an **inspector/controller**,
not a chat turn.

## Design principles

1. **Inspector, not message.** `/context` opens a modal view. It does NOT
   append `user: /context` or `system: Context opened` to the conversation.
   The overlay is ephemeral UI state, not persisted history.

2. **Act, don't just show.** The user can pin/unpin a source (force-include
   or force-exclude), expand a source to see full content, and scroll the
   full list. The SQL store makes these natural — `UPDATE context_sources
   SET salience = 1.0 WHERE id = ?`.

3. **One data path.** All rendering reads from the CRP SQL store via
   `selectContextSources`. The Rust `context_panel` fallback path is
   retired for the overlay (kept only for the collapsed status chip).

4. **Cohabit with the composer.** The overlay and the input box coexist.
   Typing does NOT dismiss the overlay; only Esc or `/context` toggle does.

5. **Adaptive budget.** The token meter reads the active model's context
   window, not a hard-coded 200k.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Context Inspector (full-height modal overlay)   │
│  ────────────────────────────────────────────    │
│  ▤ Context Runbook          24 sources · Esc     │
│  budget ▓▓▓░░░░░ 548 / 128k tokens               │
│  ────────────────────────────────────────────    │
│  ↓ Included (reaches model)               24     │
│    ▣ workspace  158  ◇ pin  Auth issue: saved…   │
│    ↔ bridge       6  ◇ pin  [summary] work-she…  │
│    ✦ memory       6  ◇ pin  project · Bootstrap  │
│    ⋉ loop trail   4  ◇ pin  happy path for: …    │
│    ⚙ system       2  ◇ pin  Auth issue: saved…   │
│  ────────────────────────────────────────────    │
│  ⊘ Held back (local only)                 105    │
│    ⋉ loop trail 105  ◆ include  session loop…    │
│  ────────────────────────────────────────────    │
│  ↑/↓ navigate · Enter pin/unpin · e expand · Esc │
└─────────────────────────────────────────────────┘
```

### Layout zones

| Zone | Content | Behavior |
|------|---------|----------|
| **Header** | `▤ Context Runbook` · source count · Esc hint | Static |
| **Budget bar** | `▓▓▓░░░░░` filled/total · token count · model window | Auto-scales to model |
| **Included** | Sources sorted by salience, each with category icon, count, pin toggle, preview | Scrollable, cursor-navigable |
| **Held back** | Sources with `included_in_model = 0` | "Include" action flips the flag |
| **Footer** | Key hints: `↑/↓ navigate · Enter pin · e expand · f forget · Esc close` | Context-sensitive |

### Interaction model

```
User action           → SQL mutation                              → Re-render
─────────────────────────────────────────────────────────────────────────
/context              → (no SQL change, open overlay)             → render from store
↑ / ↓                 → (cursor move, no SQL)                     → highlight row
Enter (on included)   → SET salience = 1.0 (pin)                  → re-select + render
Enter (on pinned)     → SET salience = original (unpin)           → re-select + render
e (expand)            → (no SQL, toggle preview full/truncated)   → render full content
f (forget)            → SET included_in_model = 0                 → re-select + render
i (include held)      → SET included_in_model = 1                 → re-select + render
Esc                   → (close overlay)                           → conversation view
```

Every mutation calls `selectContextSources` again and re-renders the
overlay — the SQL store is the single source of truth.

## Implementation tasks

### A. Silent builtin — no history pollution (HIGH)

**Problem:** `rust/unclecode-core/src/context_command.rs:22-28` always emits
`user: "/context"` + `system: "Context opened"` entries.

**Fix:** Add a `silent: true` flag to `ContextBuiltinResult`. When set,
`appendEntries` is skipped. The Rust command still emits entries (for
backwards compat), but the TS handler drops them when `silent` is true.

- [ ] Add `silent?: boolean` to `ContextBuiltinResult` type
- [ ] `work-shell-engine-builtin-runtime.ts:160-172` — when `kind === "context"`, set `silent: true` and skip `appendEntries`
- [ ] Verify `/context` no longer adds entries to conversation
- [ ] Test: conversation history is unchanged after `/context`

### B. Full-height modal overlay (HIGH)

**Problem:** The overlay is a bottom-anchored box capped at 12 lines.

**Fix:** When the context panel is active, render it as a **modal** that
takes the full conversation area height (like a focused view). The
conversation is hidden behind it while open.

- [ ] Add `contextOverlayOpen` boolean to engine state
- [ ] `getWorkShellPanelDisplayMode` — when `contextOverlayOpen`, return `"modal"` (new mode)
- [ ] Render the modal at full conversation height, not capped at 12 lines
- [ ] Remove `WORK_SHELL_CONTEXT_OVERLAY_LINE_LIMIT` — modal shows all sources
- [ ] Esc closes the modal and restores conversation

### C. Scroll + cursor navigation (HIGH)

**Problem:** No scroll, no cursor, no way to see hidden sources.

**Fix:** Add scroll state to the overlay:

- [ ] `contextScrollOffset: number` in engine state
- [ ] `↑/↓` keys move the cursor within the source list
- [ ] When cursor moves past the visible area, scroll offset adjusts
- [ ] Vim-style `j/k` aliases for `↑/↓`
- [ ] `PgUp/PgDn` for page scroll

### D. Pin/unpin/forget/include actions (HIGH)

**Problem:** Read-only — can't change source inclusion.

**Fix:** Wire keyboard actions to SQL mutations:

- [ ] `Enter` on an included source → pin (`salience = 1.0`)
- [ ] `Enter` on a pinned source → unpin (restore original salience)
- [ ] `f` → forget (`included_in_model = 0`) — moves to "Held back"
- [ ] `i` on a held-back source → include (`included_in_model = 1`)
- [ ] Each mutation triggers `selectContextSources` + re-render
- [ ] Visual feedback: pinned sources show `◆` instead of `◇`; held-back show dimmed

### E. Source expand (MEDIUM)

**Problem:** Previews truncated at 64 chars — can't see full content.

**Fix:**

- [ ] `e` key toggles expanded view for the cursor row
- [ ] Expanded view shows full `content` field (wrapped to terminal width)
- [ ] Collapsed view shows 1-line preview (as today)
- [ ] Only one source expanded at a time (toggle)

### F. Composer cohabitation (MEDIUM)

**Problem:** Typing dismisses the overlay.

**Fix:**

- [ ] Remove `shouldHideWorkShellOverlayForInput` for the context modal
- [ ] When the modal is open, the composer stays visible at the bottom
- [ ] Typing in the composer does NOT close the modal
- [ ] Only Esc or `/context` toggle closes it
- [ ] The user can read context while composing a follow-up

### G. Adaptive token meter (MEDIUM)

**Problem:** Hard-coded 200k window.

**Fix:**

- [ ] Read the active model's context window from provider metadata
- [ ] Scale the budget bar to the real window (128k, 200k, 1M, etc.)
- [ ] Show `548 / 128k tokens` not `548 / 200k tokens`

### H. Collapsed status enhancement (LOW)

**Problem:** Default state has no visible context panel.

**Fix:**

- [ ] Show a persistent 1-line context summary in the composer dock:
    `▤ 24 sources · ▓▓░░░░░░ 548/128k · /context to inspect`
- [ ] This replaces the current `context 24 ready` chip

## Phased delivery

### Sprint 1 — Silent + modal + scroll (fixes the worst pain)
- A (silent builtin)
- B (full-height modal)
- C (scroll + cursor)

### Sprint 2 — Actions (makes it useful)
- D (pin/unpin/forget/include)
- E (source expand)

### Sprint 3 — Polish
- F (composer cohabitation)
- G (adaptive meter)
- H (collapsed status)

## Connection to CRP Phase 4/5

This redesign is the **TUI layer of Phase 5** (Runbook TUI enhancements).
It depends on:

- Phase 1-3 (CRP SQL store + providers + selector) — ✅ done
- Phase 4a (`unclecode work` path integration) — needed so actions work
  in both `tui` and `work` commands

The actions (pin/unpin/forget) are SQL mutations on `context_sources` —
they reuse the store functions already built in Phase 1. No new store
functions needed except:

- `updateContextSourceSalience(db, id, salience)` — for pin/unpin
- `updateContextSourceIncluded(db, id, included)` — for forget/include

These are trivial `UPDATE` statements on top of the existing schema.

## Appendix: Audit findings (12 defects)

1. Read-only dump — no pin/unpin/forget/expand/scroll
2. `/context` pollutes conversation history (user + system entries)
3. Hard 12-line cap, no scrollback
4. Auto-hide on any keystroke
5. Two divergent data paths (compact packet vs Rust dump)
6. Collapsed state invisible (no context panel by default)
7. Token meter hard-coded to 200k
8. "Held back" under-explained
9. Source previews truncated at 64 chars
10. Internal storage paths leak (`.omo/` scrub is a band-aid)
11. Refresh is destructive (re-appends history + re-runs full sync)
12. Section headers weak (no rules, visual containment)
