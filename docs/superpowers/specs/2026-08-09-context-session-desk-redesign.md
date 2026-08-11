# Context Desk and Session Desk Redesign

Date: 2026-08-09
Status: Approved direction; ready for implementation
Supersedes: the layout and composer-cohabitation portions of `docs/design/context-inspector-redesign.md`
Preserves: `docs/superpowers/specs/2026-07-13-context-lifecycle-ledger-design.md`

## 1. Decision

UncleCode will render `/context` as a dedicated **Pure Yazi-style Context Desk** and will make `Ctrl+O` a symmetric toggle between Work and the existing History-based **Session Desk**.

The Context Desk is one responsive two-column workspace with three panes:

```text
shared Work Shell header
shared Work Shell status rail
┌──────────────────────┬──────────────────────────────────────────┐
│ Sources              │ Preview                                  │
│ grouped context tree │ selected source + packet proof           │
│                      ├──────────────────────────────────────────┤
│                      │ Details / Actions                        │
│                      │ content, receipts, warnings, advice      │
└──────────────────────┴──────────────────────────────────────────┘
```

This is a composition-boundary repair, not a second Context subsystem. Existing CRP selection, packet receipts, policy suggestions, source mutations, detail loading, and Session Center state remain authoritative.

## 2. Goals

1. Keep grouped context navigation, selected-source preview, and detail/actions visible at the same time.
2. Give each Context pane explicit keyboard focus and bounded scrolling.
3. Derive pane width and height from actual terminal dimensions instead of fixed stacked-section costs.
4. Keep packet proof, unknown estimates, warnings, action receipts, and optimizer advice honest and visible without unbounded output.
5. Make `Ctrl+O` toggle Work → Session Desk → Work while preserving the active Work session and the selected Session Desk row.
6. Reuse the existing Work Shell and Dashboard chrome exactly once.
7. Behave the same in standalone `unclecode` and embedded `unclecode work` terminal paths.

## 3. Non-goals

- Changing `context_sources`, CRP selection, packet formatting, packet receipt, action receipt, policy suggestion, or memory-lineage schemas.
- Changing provider payloads or submission revalidation.
- Redesigning the global statusline, context/cost/subagent indicators, Work conversation, composer, or model picker.
- Creating a second Context store, duplicate Session selection state, or a new Dashboard implementation.
- Adding dependencies, browser UI, mouse interaction, group-collapse persistence, or new source mutation semantics.
- Changing `Space`, `P`, optimizer acceptance/rejection, or session resume data contracts.

## 4. Existing Contracts That Remain Authoritative

The following invariants from the Context Lifecycle Ledger remain unchanged:

1. `context_sources` and the CRP selector are the source of truth for inclusion state.
2. Only the packet sent to the provider may become `submitted`.
3. Meaning-changing packet replacements stop submission for review.
4. Optimizer suggestions never mutate CRP directly; accepted suggestions use the existing mutation path.
5. Missing token estimates render as `unknown`, never zero.
6. Receipts expose IDs and aggregates, not duplicated raw source content.
7. Source mutation still re-resolves the packet, invalidates the prior preview when required, and emits the existing action/replacement receipts.
8. `centerState.sessionIndex` remains the selected Session Desk session. No second selected-session field is introduced.

## 5. Shared Chrome Ownership

### 5.1 Context Desk

`WorkShellView` remains the only owner of:

- `WorkShellHeaderBlock`;
- the current Work status rail and its model/mode/auth/busy facts;
- the existing `formatWorkShellFooterLine` contract, which carries the compacted workspace path and context/token-cost chip.

The Context Desk renderer owns only the three-pane body and its pane-sensitive controls. `WorkShellView` renders the existing footer statusline below that body even though the composer itself is hidden. Existing agent-console/subagent activity lines are passed into the bounded Details/Actions pane; they are not falsely attributed to the footer. The desk renders without the legacy outer `borderStyle="round" paddingX={1}` frame and must not add another `UncleCode` banner, application frame, duplicate statusline, or composer hint.

Opening the desk replaces the conversation, queue activity region, and composer with the desk body without unmounting the Work pane. The pane-owned conversation, draft, queue, cursor, and session therefore remain intact. While open, the desk resolves every key ahead of composer text capture; no key appends to the hidden draft. Global control keys retain their existing precedence ahead of desk resolution: `Ctrl+O` opens the Session Desk with the Context Desk still open, and returning via `Ctrl+O` restores the desk unchanged. The `Ctrl+O` handler must not clear the composer draft while the desk is open. `Esc` restores the same Work screen and draft. This dedicated-workspace behavior supersedes the composer-cohabitation rule in the 2026-07-06 inspector proposal.

The model picker and any higher-priority Work overlay retain their existing precedence. Opening one must not be hidden merely because a context packet exists.

### 5.2 Session Desk

The existing Dashboard header and tabs remain canonical. The History body remains the Session Desk; no new Session component tree is added.

The same Dashboard status text must render once. The canonical location is the footer status bar. The duplicate copy currently rendered beneath the tabs is removed. Context/cost/subagent facts supplied to the statusline remain unchanged.

## 6. Context Desk Topology

### 6.1 Sources Pane — Left, Full Height

The Sources pane contains:

- a `Sources` pane header with included/held/source counts;
- the adaptive token budget state;
- existing human source groups in `CONTEXT_INSPECTOR_GROUP_ORDER`;
- source rows with current sent/held, pinned, freshness, token, and packet badges;
- bounded `… N more above/below` overflow rows.

Group headers are visual tree nodes. The navigable cursor remains on source rows, so no group-collapse state is added. Changing the selected source updates both right panes immediately.

The old standalone `Focus` section is removed. Cursor highlighting plus the Preview header is the single selected-source representation.

### 6.2 Preview Pane — Right, Upper

The Preview pane always shows the selected source's safe preview and packet relationship:

- selected source identity, human category, delivery/pin state, freshness, and token state;
- sanitized existing preview text;
- `NEXT REQUEST …` or `PACKET CHANGED …` proof;
- the submitted receipt summary when one exists.

It never duplicates the full raw source. Unknown categories use existing fallback metadata; raw unknown category names do not leak into the UI.

### 6.3 Details / Actions Pane — Right, Lower

The lower pane is one bounded scroll surface containing, in priority order:

1. expanded detail content for the selected source, when loaded;
2. selected-source contextual actions and the latest action receipt;
3. meaning-changing packet review reason;
4. warnings;
5. optimizer advice or its bounded unavailable state.

When rows are scarce, selected-source state and safety-critical packet-change/warning information win over ordinary advice and agent activity. Advice and activity are truncated/windowed before source navigation or packet proof disappears. Every overflow is explicit; content is never silently allowed past the terminal row budget.

Existing context-sensitive optimizer keys (`A` accept and `R` reject) remain available when a selected suggestion and callbacks exist. Suggestion selection continues to follow the selected Sources cursor; scrolling Details does not change it. These keys are not added to the default footer when unavailable.

## 7. Responsive Layout

All calculations use display width, not JavaScript string length. CJK and wide glyphs must stay within the terminal.

Let:

- `bodyWidth` be the exact width passed by `WorkShellView` after outer shell padding; the desk has no additional outer frame;
- `bodyRows` be the physical `terminalRows` minus the rows actually reserved by the shared Work header, status rail, and footer statusline;
- `gutter` be one column between pane borders.

Width allocations include each pane's own two border columns. Pane content width is therefore its allocation minus borders and padding. No renderer may infer terminal size independently after these values are passed.

### 7.1 Width Classes

| Class | Terminal/body behavior |
|---|---|
| Wide (`bodyWidth >= 88`) | Sources receives 34–38% of width, clamped to 32–44 columns. Right pane receives the remainder. |
| Medium (`64 <= bodyWidth < 88`) | Sources receives 30–34%, clamped to 24–31 columns. Right pane receives the remainder. |
| Narrow (`48 <= bodyWidth < 64`) | Preserve two columns. Sources receives 18–21 columns; compact pane headers and badges; right pane receives the remainder. A 52-column terminal with four columns of shell inset remains in this class. |
| Emergency (`bodyWidth < 48` or `bodyRows < 17`) | Render only the focused pane at full `bodyWidth` and `bodyRows` with a `1/3`, `2/3`, or `3/3` pane indicator. `Tab` keeps the same logical three-pane cycle. |

Pane-local truncation widths are derived from the allocated pane width. Existing literals such as headline `28`, model `12`, session ID `18`, or detail `34–42` must not determine layout.

### 7.2 Height Budget

For split terminals (`bodyRows >= 17`):

- Sources uses all `bodyRows`.
- The right column splits available inner rows approximately 45% Preview / 55% Details, after the separator.
- Preview receives at least 7 rows.
- Details receives at least 9 rows.
- Pane borders, headers, controls, and both overflow markers are included in each pane's budget.

Emergency mode has independent width and height triggers. A focused pane renders in as few as 4 rows: two border rows, one header, and one content or overflow row. Below 4 usable rows the desk renders one bounded `Terminal too small · Esc close` line. `Tab` still updates logical focus whenever a focused pane can render.

The pure layout helper retires both legacy row-budget helpers: `computeContextOverlayViewportMaxRows` (`terminalRows - 25`) and `computeContextOverlaySectionMaxRows` (fractions of physical rows). Neither remains reachable from the desk render path; every capacity derives from `bodyRows`. Render/model tests cover 40×12, 52×40, 80×30, and 120×40 terminals.

## 8. Context Focus and Keyboard State Machine

The desk owns one logical focus value:

```ts
type ContextDeskPane = "sources" | "preview" | "details";
```

`contextDeskPane` and `contextDeskPreviewOffset` are added beside the existing `contextInspectorCursor`, `contextInspectorExpanded`, and `contextInspectorDetailOffset` engine UI state. The existing detail offset becomes the requested scroll position for the whole Details/Actions surface, including expanded content; it is not duplicated. The engine's detail-offset mover no longer early-returns when no source is expanded: it moves whenever the Details/Actions pane is focused, and the renderer clamps the requested offset to the wrapped-line bounds of whatever the pane currently shows. These are engine state, not React-mirrored state. Opening `/context` initializes pane focus to `sources` and both offsets to zero; source changes reset both offsets; closing the desk clears transient expansion and offsets through the existing close-overlay path.

### 8.1 Keys

| Key | Sources focused | Preview focused | Details focused |
|---|---|---|---|
| `Tab` | focus Preview | focus Details | focus Sources |
| `↑` / `↓` | move selected source | scroll preview when overflow exists | scroll detail/actions within bounds |
| `Enter` | load/toggle selected source detail and enter Details | enter Details | return to Sources and close the expanded reader |
| `Space` | toggle send/hold for selected source | same selected source action | same selected source action |
| `p` | toggle pin for selected source | same selected source action | same selected source action |
| `Esc` | close Context Desk | close Context Desk | close Context Desk |
| `Ctrl+O` | open Session Desk, preserving Context Desk | same | same |

Rules:

- `Tab` is newly owned by the Context Desk. The inspector action resolver accepts `key.tab`, emits a pane-focus action, and prevents `Tab` from reaching the ordinary Rust Work input action while the desk is open.
- Arrow routing is decided solely by `contextDeskPane`; an expanded source does not imply detail scrolling.
- Source movement wraps using the existing cursor behavior and resets right-pane scroll offsets for the newly selected source.
- Preview/detail rendering clamps requested scrolling at valid wrapped-line bounds; scrolling never changes source selection.
- While the desk is open, desk input resolution runs regardless of draft contents. The raw-empty-composer gate and leading-`/` inspector bail-out do not apply; slash-command entry requires closing the desk first.
- Mutations are dispatched only when existing callbacks say actions are enabled. Disabled mutation keys are no-ops and are omitted from controls.
- `Space` and lowercase `p` preserve the selected source identity across packet reordering using the existing source-ID remapping path.
- `Enter` with no selected source is a no-op.
- `A`/`a` and `R`/`r` retain their existing advice gating.
- Footer controls are pane-sensitive and rendered once.
- Reverse focus cycling and page-wise scrolling are not introduced in this change.

## 9. Session Desk State Machine

The existing shell views remain `work | sessions | mcp`; `sessions` is the Session Desk.

```text
Work --Ctrl+O--> Session Desk
Work <--Ctrl+O-- Session Desk
Work <---Esc---- Session Desk
```

### 9.1 Toggle Contract

- In embedded Work, `Ctrl+O` dispatches `view.changed("sessions")` through the existing `onRequestSessionsView` seam. That callback remains an idempotent open operation, not a symmetric toggle, so the existing per-`\u000f` repeat loop cannot self-cancel.
- While Session Desk is active, a new Dashboard branch ahead of implicit submit, letter shortcuts, `Esc`, and numeric tabs recognizes both Ink delivery forms—raw `\u000f`, and `key.ctrl` with value `o`—then dispatches `view.changed("work")`.
- `Esc` continues to return to Work only when no approval or detail-close action has higher precedence.
- Repeated `Ctrl+O` is deterministic and does not resume a session, reset the Work engine, or launch a second Work pane. Exactly one of the Work-pane and Dashboard input handlers is active at a time; `shouldCaptureDashboardInput` remains the arbiter.

### 9.2 Preserved State

Switching views preserves:

- the externally owned embedded Work engine and conversation state;
- the Work composer text draft through a minimal Dashboard-owned controlled-value seam;
- `centerState.sessionIndex` and the History session-column focus;
- list scroll derived from the preserved selected index and current pane height.

The embedded Work pane subtree unmounts while Session Desk is active, so the text draft is lifted to the still-mounted `Dashboard` and passed through the existing `renderWorkPane` controls into `WorkShellPane`. Pending clipboard attachments, slash-picker dismissal state, and DOM/terminal focus remain pane-local and are not claimed as preserved. Keeping the Work pane mounted but hidden is forbidden because it would activate competing `useInput` handlers.

`detailOpen` continues to follow the existing `createSessionCenterFocusForView` reset contract when leaving History. No separate scroll offset is stored for the Session list: its visible window is a pure function of selected index, session count, and pane rows. If refresh removes the selected session, the existing ID-aware/clamped selection behavior chooses the nearest valid row.

### 9.3 Session Keys

- `↑` / `↓`: select previous/next session using existing bounds.
- `Enter`: resume the selected session through the existing command.
- `Ctrl+O`: return to the original Work screen.
- `Esc`: close detail/approval first; otherwise return to Work.

## 10. Empty, Unknown, Busy, and Overflow States

### Empty Context

- Sources: `No context sources`.
- Preview: `No source selected` plus packet proof if a packet receipt exists.
- Details: mutation controls hidden; advice/unavailable state remains bounded.

### Unknown Values

- Unknown token estimates display `unknown` and use the existing hollow meter.
- Unknown categories use human fallback metadata.
- Missing preview/detail content displays a neutral unavailable line; it never fabricates source content.

### Busy and Mutating

- Provider busy state remains owned by the shared Work status rail.
- Context actions use existing callback availability and receipts. No optimistic duplicate inclusion/pin state is created in React.
- Mutation keys remain callback-gated. The renderer shows the authoritative replacement packet and latest receipt when delivered; it does not invent a second local pending model.
- Optimizer failure is non-fatal and bounded.

### Overflow

- Sources, Preview, Details/Actions, Session list, and conversation detail each have independent row capacities.
- Overflow markers consume budgeted rows.
- Safety-critical packet-change text and the selected source never disappear behind advice or warning volume.

## 11. Component and State Reuse

Implementation must reuse and recompose:

- `renderContextInspectorOverlay` as the Context Desk body entry point;
- grouping, preview, detail, warning, advice, packet proof, receipt, and agent-activity formatters already under `packages/tui/src/work-shell-context-*`;
- Work Shell engine state/callbacks for cursor, expansion, offsets, pin, and delivery;
- `DashboardShell`, `SessionList`, `handleSessionCenterInput`, and existing shell `view`/`focus` state;
- the existing `renderWorkPane` control boundary, extended only with controlled composer draft value/change fields.

Permitted new code is limited to the engine-owned pane/offset fields, the minimal Dashboard-owned Work draft state, pure layout/focus/window helpers, and small pane renderers that remove responsibility from existing oversized composition functions. It must not duplicate data resolution or mutation logic.

No new `useEffect` is required beyond the existing terminal-resize subscription. Pane dimensions and list windows are render-time calculations; desk key actions extend the existing input handler; state changes use engine/shell events or the controlled draft setter.

## 12. Acceptance Criteria

### Context Desk

- At 120×40, 80×30, and 52×40, Sources, Preview, and Details/Actions are simultaneously identifiable and output stays within display columns/rows.
- At `bodyWidth < 48` or `bodyRows < 17`, only the focused pane renders and `Tab` cycles all three logical panes without row/column overflow.
- At fewer than 4 usable body rows, one bounded terminal-too-small line renders and `Esc` still closes.
- The selected source appears once in the tree and once as Preview content; no standalone Focus duplicate exists.
- Packet proof, honest unknown tokens, unknown-category fallback, grouped viewport markers, action receipts, warnings, optimizer states, and bounded agent activity keep their existing contracts.
- `Tab`, arrows, `Enter`, `Space`, lowercase `p`, `A`/`a` and `R`/`r` when enabled, and `Esc` follow the state machine.
- Closing and reopening does not mutate context merely because the desk was viewed.
- Work header, status rail, and existing path + context/token-cost footer statusline each render once; existing agent-console activity is visible once in Details/Actions; the Context Desk does not render a second UncleCode frame.
- From an open Context Desk, `Ctrl+O` opens Session Desk without clearing the hidden Work draft; `Ctrl+O` back restores the same Context Desk pane, cursor, offsets, expansion, and draft.

### Session Desk

- Embedded Work `Ctrl+O` opens Session Desk.
- `Ctrl+O` round trips preserve the Work composer text draft; pending clipboard attachments and terminal focus are explicitly pane-local.
- Session Desk `Ctrl+O` and top-level `Esc` return to the same Work engine.
- Reopening Session Desk preserves selected session and derives a visible list window around it.
- `↑`/`↓` select; one `Enter` resumes the selected session.
- The Dashboard status text renders once.

### Data and Regression

- Existing context lifecycle contract and end-to-end tests remain green.
- No dependency or schema change is introduced.
- Model picker precedence and submitted receipt rendering remain green.

## 13. Verification Matrix

| Surface | Dimensions | Required scenarios |
|---|---:|---|
| Pure render/model tests | 40×12, 52×40, 80×30, 120×40 | pane allocation, vertical emergency mode, CJK width, row bounds, overflow, empty/unknown states |
| Context keyboard tests | n/a | focus cycle, pane-local arrows, details scrolling without expansion, detail enter/back, mutations, advice gates, Ctrl+O desk/draft preservation, Esc |
| Session contract tests | n/a | Work→Session, Session→Work via `Ctrl+O`, Esc precedence, selection preservation, one-Enter resume |
| TTY smoke | repository runtime QA sizes | no crash, no overflow, shared chrome exactly once |
| Standalone `unclecode` in tmux | narrow/medium/wide | `/context`, pane focus, mutation callbacks when available, pin, close, Session Desk toggle |
| Embedded `unclecode work` in tmux | narrow/medium/wide | Work↔Session round trip, selection preservation, resume, Context Desk parity |

The Node build must precede `npm run check`; the Rust workspace must be built before runtime CLI verification. Live provider turns are not required when no real provider key is available; local `/context`, slash-command, Dashboard, and session-navigation paths remain verifiable offline.

## 14. Review Record

### 14.1 Self-review — 2026-08-09

Compared against `2026-07-13-context-lifecycle-ledger-design.md`, the current engine/shell state owners, and the existing 52×40 render contract.

- **Data contracts:** no schema, selector, provider-payload, receipt, suggestion, or mutation-path change.
- **State ownership:** pane focus and preview offset join existing engine UI state; the existing detail offset owns the whole Details/Actions scroll surface; Session selection remains `centerState.sessionIndex`; Session scrolling stays derived.
- **Narrow/short terminals:** corrected the 52-column body threshold, removed the legacy outer desk frame, and added width/height emergency triggers plus a sub-four-row fallback.
- **Composer/input ownership:** Context Desk input owns composer-capturable keys while its hidden Work draft remains mounted; a minimal Dashboard-controlled draft seam preserves text across the Session Desk unmount without mounting two input handlers.
- **Status ownership:** the footer is correctly limited to path + context/token cost; existing agent-console/subagent activity is rendered once in bounded Details/Actions.
- **Detail reset:** aligned Session Desk behavior with the existing `createSessionCenterFocusForView` detail-reset contract.
- **Unbounded sections:** Sources, Preview, Details/Actions, warnings, advice, agent activity, Session list, and conversation detail all receive explicit pane-local row budgets.
- **Legacy budgets:** both independent stacked-layout row helpers are retired from the desk path.

No unresolved lifecycle-contract conflict remains after these corrections.

### 14.2 Independent review — 2026-08-09

Read-only review artifact: `agent://DeskSpecReview`.

The reviewer found three Critical and nine Major issues at the input, state, and dimension seams. The spec now:

- assigns `Tab` and composer-capturable keys to Context Desk resolution while preserving global `Ctrl+O` precedence without draft clearing;
- documents Session Desk unmount behavior and lifts only the Work text draft to Dashboard ownership rather than falsely preserving all pane-local state;
- defines pane-driven arrow routing and engine-owned preview/detail scroll state;
- allows the existing detail-offset mover to scroll the whole Details/Actions surface even without expanded source content;
- removes the legacy outer frame and retires both legacy row-budget helpers;
- recognizes both raw `\u000f` and `key.ctrl + o` Session Desk input forms while keeping Work-side open idempotent;
- adds independent width/height emergency triggers;
- corrects footer ownership and preserves bounded agent-console activity in Details/Actions.

The reviewer confirmed the lifecycle ledger mapping and Dashboard duplicate-status diagnosis. A follow-up found no remaining Critical issue; its two remaining Major seam issues were incorporated before implementation planning.

A final consistency pass found that Context Desk → Session Desk is still a Work-pane unmount. The spec therefore explicitly authorizes the minimal controlled draft lift required by its `Ctrl+O` draft-preservation acceptance criterion; it does not preserve attachments or mount hidden input handlers.

## 15. Rollback

The change is reversible at the two existing composition seams:

1. restore the prior `renderContextInspectorOverlay` stacked composition while leaving CRP and lifecycle data untouched;
2. remove the Session Desk `Ctrl+O` return branch while retaining the existing `Esc` return path.

No rollback requires data migration because the redesign introduces no storage or protocol changes.
