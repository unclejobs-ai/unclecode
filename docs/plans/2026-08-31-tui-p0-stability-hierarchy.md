# UncleCode TUI P0 — stable dock, readable history, actionable quality

Status: merge blocker  
Scope: Work Shell TUI and the in-process SCC Quality Engine projection  
Non-goal: a second SCC runtime, daemon, store, or browser surface

## Problem statement

The current TUI has four coupled failures:

1. The Composer dock can be taller than the terminal at small busy heights. A
   long CJK draft can paint four value rows plus two overflow markers while the
   dock also paints activity, hints, margins, divider, and footer. The fixed
   frame clips or overlaps the result, so the visible text row and terminal
   cursor can diverge and the screen appears to shake.
2. Transcript scrolling exists as a React state path, but it is not a reliable
   user capability in the actual Herdr/Kaku/macOS input path. The user cannot
   depend on PageUp/PageDown or Fn+Up/Fn+Down to read an older answer.
3. `/scc` opens the generic Agents/Jobs/Plan/Quality console. With no review
   history it renders three contradictory non-actions: no active run, no
   history, and “select a row”. It explains neither that SCC is armed nor what
   the next task will gain.
4. Status, quality, usage, cache, cost, queue, and tool information are spread
   across the header, HUD, transcript, overlays, hints, and footer. The main
   screen does not have a clear hierarchy.

## Product invariant

The default screen answers only four questions, in this order:

1. What is UncleCode doing now?
2. What remains or what is blocking it?
3. Is the result proven by SCC?
4. Where do I type?

Everything else is progressive disclosure. Security approval, SCC quality
gate, and a product-direction decision remain separate data types and separate
interactions.

## Ownership model

### 1. `FrameBudget` owns every physical row

Introduce one pure layout projection used by both the renderer and tests:

```ts
type WorkShellFrameBudget = {
  bodyRows: number;
  dockRows: number;
  composerValueRows: number;
  showActivity: boolean;
  showTrace: boolean;
  showHint: boolean;
  showHeader: boolean;
};
```

Mandatory dock rows are divider, at least one Composer value row, and footer.
Optional rows are admitted in this priority order: activity, one live trace,
hint, top margin. `dockRows` must never exceed `terminalRows - 1`; body receives
the remainder and clips only its own content.

- 8–10 rows: divider + up to two Composer rows + footer. No margin, hint,
  trace, ASCII wordmark, or duplicated status.
- 11–17 rows: one activity row when busy, otherwise one hint. Never both.
- 18–23 rows: activity plus at most one trace; hint only while idle.
- 24+ rows: the same hierarchy with more transcript rows, not more permanent
  chrome.

Empty-state admission is all-or-nothing so a split can never show a cropped
wordmark:

- 8 rows: identity plus one compact hint; no art, starters, or opener.
- 12 rows: identity plus one merged suggestion line; no art.
- 18 rows: text identity, explanation, starters, and opener; no art.
- 24+ rows and at least 80 columns: the complete six-row wordmark is allowed.

At the latest transcript position, short content is bottom-aligned against the
dock. Empty welcome content remains top-aligned. Neither layout inserts blank
rows between the last answer and the Composer.

Responsive width contract:

- 60 columns: one column, abbreviated status/receipt, no boxes or side panes.
- 80 columns: one column; complete art only at 24+ rows.
- 100 columns: one column by default; a requested SCC evidence detail may use
  a 64/30 split only when a real selected row exists and height is at least 18.
- 140 columns: one column by default; requested detail may use a 96/38 split.

Passive side panes are never rendered solely because width is available.

### 2. `ComposerCursor` owns one measured terminal position

The visible Composer layout and the cursor use the same `FrameBudget` and
grapheme projection. Remove unexplained magic placement from the pane boundary.
The cursor anchor is derived from:

- the real frame padding,
- the prompt prefix display width,
- the exact footer row count,
- the exact visible Composer rows and overflow markers.

Ink's `useCursor` remains the commit mechanism, but a cursor position is
published only from the same render projection that paints the corresponding
text. A resize epoch invalidates the previous anchor until the new dimensions
are projected. The hardware cursor must never target a divider or footer row.

Required cases: Hangul syllables, decomposed Jamo, CJK, emoji ZWJ sequences,
combining marks, middle-of-draft cursor, paste, busy streaming, and resize while
the draft is four rows tall.

### 3. `TranscriptScroll` owns history navigation

The transcript is a clipped viewport independent from the Composer. Its
content-addressed anchor is preserved while new streaming/output rows arrive.
Only an explicit latest action or a newly submitted user turn restores
bottom-follow.

Accepted input paths:

- PageUp/PageDown
- macOS Fn+Up/Fn+Down raw escape equivalents
- `End` to return to latest
- `Esc` as a secondary latest return only when no overlay, draft, decision, or
  running turn owns it
- mouse/trackpad wheel when the renderer reports mouse capability

When scrolled, one compact receipt replaces hidden chrome:

```text
↑ 38 older rows · 12 newer rows · End latest
```

New output never moves this anchor. A small `+N new` marker is shown instead.
Overlay navigation and transcript navigation never share the same key event.

### 4. `QualityProjection` owns all SCC presentation

SCC remains an in-process Quality Engine. `/scc` and `/review` open a focused
current-state Quality Cockpit, not the generic Agent Console tab strip. One
pure projection is shared by the TUI and control-room server so the desktop and
web cannot independently invent different blocker or next-action logic.

```ts
type QualityFocus = {
  state: "inactive" | "active" | "needs-action" | "complete";
  profile?: QualityProfile;
  stage?: HarnessStage;
  gate?: GateDecision;
  iteration?: number;
  now: string;
  blocker?: string;
  nextAction: string;
  evidence: "missing" | "stale" | "dependent" | "fresh-independent";
};
```

The main screen shows at most one quality line:

```text
SCC · deep · critic 2/5 · unproven — independent review pending
```

The focused view has three states:

#### Armed, no run

```text
SCC Quality Engine · ready
No quality run is recorded for this session.
Start a task, or /scc review <target> for an explicit review.
Esc close
```

There is no empty roster, inspector prompt, fake selection, or unusable Enter
hint.

#### Active

```text
SCC · deep · critic · iteration 1
Gate      unproven
Now       independent review
Blocked   reviewer evidence missing
Next      proceed to handoff after fresh evidence

History   2 gates · 1 refine · 0 pivot
Enter evidence · Esc close
```

#### Complete or blocked

Show final decision, the single highest-priority reason, artifact freshness,
review independence, and next action. Failure lists, hashes, route details,
and full history live behind the selected evidence row. Summary rows are
bounded regardless of the 32-entry history cap. When history opens, selection
starts at the latest event; the current summary must never describe a newer
gate while the inspector silently selects the oldest one.

Next-action precedence is deterministic: pending user/security decision,
`block`, `refine`, `pivot`, `unproven`/missing independent evidence, active
work, then completed handoff. A graph with no history says “active; awaiting
first gate evidence”, not “review unavailable”.

## Quiet workspace hierarchy

Default idle:

```text
UncleCode · OpenAI                         gpt-5.6-sol

Ready · last 12s
SCC · minimal · proceed

assistant answer or latest work around the viewport

────────────────────────────────────────────────────
› Describe a task · / commands
repo · branch +2 ?1                    71% ctx · $0.04
```

Default busy:

```text
● Implementing 2/5 · 28s · 2 agents
SCC · standard · work · gate pending

conversation / current task

────────────────────────────────────────────────────
› Queue a follow-up…
```

Do not render the same spinner, stage, queue count, model, or cost twice.

## Performance receipt

Cache and speed are useful, but they do not get a new panel on the default
screen. The last completed provider turn contributes one bounded runtime
receipt:

```text
✓ 96 tok/s · TTFT 0.7s · cache HIT · read 32k · write 4k · $0.04
```

Rules:

- Cache is `HIT` only when provider usage reports positive cache-read tokens,
  `MISS` only when known usage reports zero, and `n/a` when usage is absent.
  Local cache-ledger entries never imply a provider prompt-cache hit.
- `tok/s` is output tokens divided by generation duration, not wall-clock task
  duration.
- `TTFT` requires an explicit first-token timestamp. Do not estimate it from
  total duration.
- The main screen uses one line and abbreviates at narrow widths. `/usage` or
  `/cache` owns the full provider/route breakdown.
- Performance evidence and SCC quality evidence are never combined into one
  gate or label.

This requires a bounded per-turn usage projection with `startedAt`, optional
`firstTokenAt`, `completedAt`, disjoint input/cache buckets, output tokens, and
cost. Session totals remain separate.

## Keep, merge, move, remove

| Surface | Decision | Owner |
|---|---|---|
| Composer | Keep, rebuild row budget | `FrameBudget` + `ComposerCursor` |
| Transcript PageUp/PageDown | Keep, repair actual input path | `TranscriptScroll` |
| Ctrl+O | Keep only as tool-history compact/verbose toggle | transcript presentation |
| Quality HUD | Keep as one bounded line | `QualityProjection` |
| `/scc`, `/review` | Merge into focused quality view | `QualityProjection` |
| Quality tab inside generic Agent Console | Remove as primary entry; optional deep link only | focused quality view |
| Agents and Jobs | Keep, no quality data duplication | Agent Console |
| Plan | Keep full DAG behind Ctrl+T/Plan | WorkGraph |
| Queue | Keep only user follow-ups | Queue |
| Cache telemetry | Move full detail to `/usage` or `/cache` | runtime receipt |
| ASCII wordmark in small panes | Remove | empty state |
| Repeated key legends | Merge into contextual one-line hint | active surface |
| Multiple spinners | Remove; exactly one busy activity row | dock |

## P0 implementation sequence

1. Add the pure `FrameBudget` projection and failing 8/9/10/12/18-row cases.
2. Bind Composer rendering, parent transcript capacity, and cursor anchor to the
   same projection.
3. Add raw Page/Fn/End decoding and content-anchor tests; then verify in a real
   Herdr terminal split.
4. Replace `/scc` empty generic console with the focused quality states; cap
   active summary and move detailed evidence into the inspector.
5. Add bounded latest-turn runtime usage projection and the compact performance
   receipt.
6. Remove duplicate welcome, status, spinner, hint, and quality rows.
7. Run screenshot acceptance at 60/80/100/140 columns and 8/10/12/18/24 rows,
   plus a long-session scroll test.

## Acceptance gates

- Every rendered frame contains at most `terminalRows` physical rows.
- Footer and Composer remain visible for a busy long CJK draft at 9 and 10
  rows, including a middle cursor with both overflow markers.
- The cursor target always lands inside the visible Composer value rectangle.
- Older history is reachable in Herdr with PageUp and macOS Fn+Up; new output
  preserves the reading anchor; End returns to latest.
- `/scc` with no active run says SCC is armed and what it will do. It renders
  no empty roster, no “select a row”, and no dead Enter action.
- A 32-failure quality history cannot increase the summary height beyond its
  fixed budget.
- The main view contains one activity row, one SCC row, one Composer, and at
  most one compact runtime receipt.
- English shell chrome stays English and Korean shell chrome stays Korean;
  user input alone never flips chrome locale.
- The actual `unclecode` launcher is captured and inspected inside a Herdr
  terminal pane. Text snapshots alone are not sufficient evidence.

## Separate merge blockers outside visual P0

Before merge, `QualityArtifactStore` must also reject symlinked artifact roots,
prevent overwrite of immutable evidence, and enforce an aggregate bounded
artifact budget. This is an SCC trust-boundary blocker, not a TUI layout item,
and must be reviewed independently because the relevant files currently have
uncommitted user changes.
