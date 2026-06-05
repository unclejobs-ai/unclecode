# Context-Management-Optimized TUI PRD

> Date: 2026-06-04
> Status: Draft for product/design review
> Scope: UncleCode Work Shell, context surfaces, OMO/ulw-loop integration, and next model-call payload visibility

## Problem

UncleCode is currently a work-first terminal assistant: the user types in the composer, reads the conversation stream, and can open command/session surfaces. That shape is useful, but it does not yet make UncleCode's strongest differentiator explicit.

The user should not have to guess what context the model is receiving. In a long coding session, the important product question is not only "what did the assistant say?" but "what will enter the next model call, what was excluded, and why?" Current context state is distributed across workspace guidance, bridge summaries, session memory, trace lines, saved sessions, research artifacts, and now OMO/ulw-loop goals and evidence. Those sources exist, but they are not presented as one inspectable, steerable context packet.

The TUI must become context-management-optimized without becoming uncomfortable. A permanent three-pane cockpit would be too heavy for normal terminal work. Context controls should be present, trustworthy, and easy to expand, but folded by default so chat and composer flow remain natural.

## Product Thesis

UncleCode's core product object is the **next model-call packet**.

The conversation remains the main work stream, but the product differentiator is that the user can see and steer the packet that will be sent on the next turn:

- Which sources are included.
- Which sources are excluded.
- Which sources were compressed.
- How large the packet is.
- Which goal/evidence state from OMO is relevant.
- Whether the packet is stale, over-budget, or missing expected context.

OMO/ulw-loop should not be bolted on as a separate checklist. It should become a first-class context source: active goal, criteria, evidence, blockers, and quality gate state can feed the next-call packet when relevant.

## Goals

- Make UncleCode feel like a context command surface, not only a chat terminal.
- Preserve the current work-first UX: the user can type naturally without fighting extra panes.
- Add a folded-by-default context packet surface that expands only when useful.
- Keep the existing bottom command/suggestion drawer usable and uncluttered.
- Make OMO/ulw-loop state available as context without forcing every session into OMO workflow.
- Show honest packet state only. Do not invent token counts, costs, model limits, health, or inclusion reasons.
- Make context behavior testable before large visual changes.

## Non-Goals

- Do not replace the Work Shell transcript with a permanent full-screen dashboard.
- Do not make OMO mandatory for normal work sessions.
- Do not show raw `.omo/ulw-loop/ledger.jsonl` as default context.
- Do not add new dependencies for the first implementation slice.
- Do not persist global model or context settings unless explicitly requested by the user.
- Do not build a web dashboard. This is a terminal-first TUI.

## User Requirements

1. The default shell must remain comfortable for chat and coding work.
2. Context inspection must feel natural to open and close.
3. Context UI must not compete with the bottom command/suggestion drawer.
4. The user must be able to preview what will enter the next model call.
5. The user must understand why OMO goal/evidence context is included or excluded.
6. Narrow terminals must degrade cleanly to overlay mode.
7. Context details must be actionable: include, exclude, compress, pin, or inspect where supported.
8. Every displayed context claim must be backed by an actual source.

## UX Principles

### Folded By Default

The normal shell should not start as a three-pane cockpit. The user sees the work stream, composer, footer, and existing command drawer behavior. Context controls are present as a compact indicator or peek surface, not as a permanent distraction.

### Context Rail, Not Bottom Drawer

The bottom area already serves command suggestions and slash-command completion. The context packet surface should not be placed there as another competing drawer. The preferred placement is a right-side rail when width allows, or a temporary overlay when width is constrained.

### Packet Preview Is The Moment Of Control

The most important interaction is not browsing every possible context source. It is previewing the next-call packet before sending a turn. The UI should answer:

- What exactly is about to be sent?
- What changed since the last turn?
- What is missing or stale?
- What can I toggle quickly?

### Honest Compression

If a source is summarized, the UI must say so. If a source is omitted because of width, token budget, stale age, or relevance ranking, the UI must say so. If the system cannot estimate tokens honestly, show counts by source/items instead of fake token numbers.

### OMO As Context Source

OMO should provide structured context state:

- Active goal.
- Pending/pass/fail criteria.
- Evidence summaries.
- Blockers and quality gate status.
- Latest checkpoint.

The default packet should include active goal and criteria summaries, not full raw ledger content.

## Information Architecture

### Default Work View

Visible:

- Conversation transcript.
- Composer.
- Current model/mode/auth footer.
- Existing slash-command suggestion drawer when active.
- Compact context packet indicator, for example:
  `Context · 6 sources · OMO active · packet changed`

Behavior:

- `Enter` submits normally.
- Slash suggestions still render below the composer.
- Context indicator can be focused or expanded by shortcut.
- No permanent side rail if terminal width is too narrow.

### Context Peek

Purpose:

- Quick, low-friction status of the next-call packet.

Visible:

- Source count.
- OMO status if active.
- Included/excluded counts.
- Compression state.
- Warning if packet is stale or missing expected context.

Behavior:

- Opens as a slim right rail when width allows.
- Opens as a small overlay when width is constrained.
- Closes with `Esc`.
- Does not steal composer input unless explicitly focused.

### Context Inspector

Purpose:

- Full inspection and steering surface for the next-call packet.

Visible sections:

- `Sources`: workspace, changed files, session memory, bridge summaries, OMO ledger, evidence, MCP, research artifacts.
- `Included`: what will enter the next call.
- `Excluded`: what will not enter the next call and why.
- `Compression`: summarization mode and source-level compression decisions.
- `Preview`: final model-facing packet preview or structured packet summary.
- `Warnings`: stale, over-budget, missing, conflicting, or unverified context.

Behavior:

- Opens as an overlay or dedicated inspector mode.
- Supports keyboard movement across source rows.
- Supports include/exclude/compress where the source type allows it.
- Returns cleanly to the composer.

### OMO Context View

Purpose:

- Show OMO/ulw-loop state as context, not as a separate app.

Visible:

- Active OMO session if present.
- Current goal status.
- Criteria status.
- Evidence summaries.
- Latest checkpoint/quality gate status.
- Whether OMO state is included in the next packet.

Behavior:

- If no OMO plan exists, show inactive state and suggested command only when relevant.
- If multiple `.omo/ulw-loop/<session-id>` plans exist, prefer the active/latest plan but mark ambiguity.
- Full raw ledger is inspectable but excluded from default packet.

## Proposed Interaction Model

Shortcuts are provisional and must be reconciled with current Work Shell bindings:

| Action | Proposed behavior |
| --- | --- |
| `Ctrl+O` | Open command/session center as today; context actions can appear as first-class commands there. |
| `Ctrl+P` or `Alt+P` | Toggle context packet peek. |
| `Ctrl+I` or `/context` | Open full context inspector. |
| `p` inside inspector | Preview final packet. |
| `space` inside inspector | Toggle include/exclude for selected source when allowed. |
| `c` inside inspector | Cycle compression mode for selected source when allowed. |
| `Esc` | Close context overlay/peek first, then return to composer. |

The exact shortcuts should be finalized after auditing existing `useInput` behavior and avoiding conflicts with secure input, paste handling, slash completion, and session center navigation.

## Context Packet Model

The TUI should render a normalized packet model rather than directly reading many unrelated stores.

Conceptual shape:

```ts
type ContextPacket = {
  readonly version: 1;
  readonly builtAt: string;
  readonly model?: string;
  readonly mode?: string;
  readonly sources: readonly ContextSource[];
  readonly included: readonly PacketItem[];
  readonly excluded: readonly PacketExclusion[];
  readonly compression: readonly CompressionDecision[];
  readonly warnings: readonly PacketWarning[];
  readonly preview: {
    readonly available: boolean;
    readonly summary: readonly string[];
    readonly text?: string;
  };
};
```

Source categories:

- `workspace-guidance`
- `changed-files`
- `session-memory`
- `bridge-summary`
- `omo-goal`
- `omo-criteria`
- `omo-evidence`
- `research-artifact`
- `mcp-context`
- `manual-attachment`

Packet decisions must be deterministic and explainable. If model-token estimation is not available, the packet should expose item counts and byte/line estimates rather than fake token counts.

## MVP Scope

The first implementation should be deliberately small.

### MVP 1: Packet Indicator And Inspector Data Model

Deliver:

- A `ContextPacket` builder that aggregates existing Work Shell context sources.
- OMO source adapter that reads active/latest `.omo/ulw-loop` status through the OMO CLI or a safe local parser.
- Compact context indicator in the Work Shell footer/header area.
- `/context` panel or overlay showing included/excluded/compressed summaries.
- Contract tests proving packet contents and default exclusions.

Do not yet:

- Add full interactive source toggling.
- Add persistent user packet preferences.
- Redesign the entire shell layout.

### MVP 2: Foldable Right Rail

Deliver:

- Right rail when terminal width is sufficient.
- Overlay fallback when width is narrow.
- Keyboard close/focus behavior.
- No collision with bottom slash-command drawer.
- Tests for width-based layout decisions.

### MVP 3: Packet Preview And Steering

Deliver:

- Preview final packet summary before send.
- Include/exclude source toggles for safe source types.
- Compression mode controls for selected sources.
- Stale packet warning if context changed after preview.
- OMO-specific include mode: off, active goal only, goal plus criteria, goal plus evidence summaries.

## Acceptance Criteria

### Default Comfort

- Work Shell opens with the familiar transcript and composer focus.
- The bottom slash-command drawer behaves as it does today.
- Context UI does not appear as a large permanent pane by default.
- `Esc` closes context overlays before affecting work/session navigation.

### Packet Honesty

- Context packet indicator reflects real source counts.
- OMO active/inactive state is based on actual `.omo/ulw-loop` state.
- Raw OMO ledger is excluded by default.
- If token estimates are unavailable, the UI does not show token numbers.
- Every included/excluded/compressed row has a source and reason.

### Fold And Expand

- Wide terminal can show a slim right rail without hiding the composer.
- Narrow terminal uses overlay mode.
- The inspector can be opened and closed without losing composer input.
- The inspector does not consume paste/image handling unless focused.

### OMO Integration

- If an active OMO goal exists, the packet includes a concise active-goal summary by default.
- Criteria and evidence summaries can be inspected.
- Completed OMO sessions are available as historical context but not automatically included unless relevant.
- Multiple OMO sessions are handled with an ambiguity warning instead of silently choosing wrong context.

### Verification

- Unit tests cover packet builder decisions.
- Contract tests cover Work Shell layout behavior with and without context packet state.
- TUI render tests cover narrow and wide terminal modes.
- At least one tmux QA transcript demonstrates normal typing, slash suggestions, context peek, context inspector, and return-to-composer behavior.

## Current Code Surfaces

Likely implementation surfaces:

- `packages/orchestrator/src/work-shell-engine*.ts`: state, panels, submit flow, context source aggregation.
- `packages/orchestrator/src/work-shell-engine-post-turns.ts`: bridge and memory summaries after turns.
- `packages/tui/src/work-shell-view.tsx`: visible Work Shell layout.
- `packages/tui/src/work-shell-pane.tsx`: composer integration and width handling.
- `packages/tui/src/work-shell-hooks.ts`: keyboard/focus state and overlay behavior.
- `packages/tui/src/dashboard-components.tsx`: existing session center context snapshots.
- `.omo/ulw-loop/<session-id>/goals.json` and `ledger.jsonl`: OMO source data.

## Risks

- Context UI may become too noisy and reduce typing comfort.
- OMO state can be stale or ambiguous if several plans exist.
- Token counts can become misleading if not backed by real tokenizer/model data.
- Keyboard shortcuts can conflict with existing input handling.
- Context preview may create false confidence if it does not match the actual provider request.
- Reading OMO files directly may bypass CLI validation; adapter boundaries must be explicit.

## Open Questions

1. Should packet source toggles persist across turns, sessions, or only the current turn?
2. Should OMO integration call the `omo` CLI for status, or read `.omo/ulw-loop` artifacts directly for speed?
3. Which shortcut should own packet peek without conflicting with current command center behavior?
4. Should the first rail show only source status, or also include action controls?
5. Should the actual provider request builder consume `ContextPacket`, or should the packet initially be display-only until verified?

## Recommended Decision

Use this phased direction:

1. Build the packet model and `/context` inspector first.
2. Add a compact folded indicator in the default Work Shell.
3. Add foldable right rail only after the packet model is accurate.
4. Integrate OMO as a context source, not as a separate permanent pane.
5. Keep the bottom command drawer dedicated to commands and suggestions.

This keeps the default TUI comfortable while making UncleCode's differentiator concrete: visible, steerable context before every model call.
