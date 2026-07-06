# Context Inspector — Live, Adaptive UI/UX

> Plan: `docs/glm-hammer/plans/2026-07-07-context-inspector-live-ux.md`
> Skill: `forge` → `hammer`
> Scope: full-face redesign of the `/context` inspector + footer chip, finishing inspector-redesign Sprints 2 & 3.

## Goal

Turn the `/context` overlay from a static, string-rendered snapshot into a **live, adaptive inspector**: actions (pin/forget/include/expand) render instantly, cursor state is structurally correct, the layout adapts to source/token volume, the visual hierarchy is scannable, and the footer chip is a live mini-dashboard.

## Architecture

The overlay today renders from a `readonly string[]` produced by `buildWorkShellCompactContextPacketPreviewLines`. Cursor highlight matches against *line indices*, but the engine's navigable source list (`resolveInspectorSourceList`) is a *flat list of sources*. These two coordinate systems never agreed, so the cursor lands on headers/summary lines instead of source rows, and `pinned` is always `false` because `ContextPacketViewItem` carries no flags.

The fix introduces a **structured view model** (`ContextInspectorViewModel`) that both the engine (cursor/actions) and the renderer read from — eliminating the string-roundtrip. `ContextPacketViewItem` gains optional `salience`/`pinned`/`includedInModel` fields so the glyph/dim state is authoritative. A new config field (`context.modelWindow`) + env (`UNCLECODE_CONTEXT_WINDOW`, already read) feeds the adaptive token meter. Footer indicator gains a freshness/salience signal.

## Tech Stack

- TypeScript + React (Ink) — TUI in `packages/tui/`
- `@unclecode/contracts` — `ContextPacketViewItem` type extension
- `@unclecode/context-broker` — view model builder + indicator formatter
- `@unclecode/config-core` — `context.modelWindow` config + env
- `@unclecode/orchestrator` — engine state shape, inspector source list
- Node `>=22.18.0`, Rust `>=1.85` (no Rust changes in this plan)
- Test runner: `mocha` via `npm run test:contracts` / `test:context-broker` / `test:orchestrator` / `test:tui`

## Work Scope

**In:**
- Structured view model replacing string-roundtrip rendering
- Authoritative pin/hold flags on `ContextPacketViewItem`
- Adaptive token meter (config + env driven)
- Adaptive layout (condensed when few sources, full when many)
- Live footer chip (freshness pulse, salience hint)
- Cursor ↔ source index consistency
- Config + env for model window

**Out:**
- Rust `context_panel` retirement (defect #5) — separate effort, needs Rust changes, explicitly deferred
- Full-height *modal* mode (design §B) — the current overlay already cohabits; modal is cosmetic and deferred to avoid a large panel-layout rewrite in the same PR
- `.omo/` path scrub replacement (defect #10) — band-aid retained; structural fix deferred
- New dependencies

## Verification Strategy

**Level:** test-suite + build-only.
**Command:** `npm run build && npm run check && npm run test:contracts && npm run test:context-broker && npm run test:orchestrator && npm run test:tui`
**What passing proves:** the structured view model, extended contract type, config field, adaptive meter math, and indicator formatter all typecheck under the workspace's composite projects refs and their unit/contract tests pass. (The interactive overlay cannot be driven headlessly; its rendering is locked by a contract test on the view-model → line projection, not a live TUI harness.)
**Prerequisite note:** `npm run build` is required before `npm run check` (per AGENTS.md — `@unclecode/*` subpath exports resolve to `dist/`). Task 7 (Final Verification) runs the full chain.

---

## File Structure Mapping

**Modify:**
- `packages/contracts/src/context-packet-view.ts` — extend `ContextPacketViewItem` (anchor: `ContextPacketViewItem` type, line ~13)
- `packages/config-core/src/types.ts` — add `context.modelWindow` (anchor: `context` block, line ~39)
- `packages/config-core/src/defaults.ts` — add `CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW` (anchor: context defaults, line ~50)
- `packages/config-core/src/resolver.ts` — validate `context.modelWindow` + read `UNCLECODE_CONTEXT_WINDOW` env (anchor: context validation block, line ~214; env block, line ~283)
- `packages/context-broker/src/crp-selector.ts` — propagate `salience`/`includedInModel` into packet items (anchor: `contextSourceToPacketItem`, line ~40)
- `packages/context-broker/src/context-packet-view.ts` — new `ContextInspectorViewModel` + builder + adaptive `formatContextPacketIndicator` (anchor: end of file, after `composeWorkShellTurnPromptFromPacket`)
- `packages/context-broker/src/index.ts` — export new symbols (anchor: CRP exports, line ~90)
- `packages/orchestrator/src/work-shell-engine.ts` — inspector source list reads authoritative flags; `resolveInspectorSourceList` simplification (anchor: line ~872)
- `packages/orchestrator/src/work-shell-engine-builtins.ts` — `/context` builds view model lines (anchor: `createContextBuiltinResult`, line ~305)
- `packages/orchestrator/src/work-shell-context-packet.ts` — re-export new builder (anchor: line ~9)
- `packages/tui/src/work-shell-view.tsx` — `renderRunbookLine` consumes structured rows; adaptive meter from props; dimmed held-back rows (anchor: `renderRunbookLine`, line ~825; `CONTEXT_SOURCE_META`, line ~813)
- `packages/tui/src/work-shell-pane.tsx` — pass `modelWindow` + inspector rows through props (anchor: inspector props wiring, line ~166)
- `apps/unclecode-cli/src/work-runtime-crp.ts` — pass `modelWindow` into resolver (anchor: `WorkShellCrpConfig`, line ~32)

**Create (tests):**
- `tests/contracts/context-inspector-view-model.contract.test.mjs`
- `tests/context-broker/context-packet-view-model.test.mjs` (if a context-broker test dir exists; else `tests/contracts/`)

---

## Task 1: Extend contract type with authoritative source flags

**Goal:** Add optional `salience`, `pinned`, and `includedInModel` fields to `ContextPacketViewItem` so the inspector can render glyph/dim state from authoritative data instead of approximating `pinned = false`.

**Dependencies:** None (foundation — all other tasks consume this).

**Files:**
- Modify: `packages/contracts/src/context-packet-view.ts` (anchor: `ContextPacketViewItem`, line 13)
- Test: `tests/contracts/context-packet-view-type.contract.test.mjs` (create)

**Acceptance Criteria:**
- [ ] `ContextPacketViewItem` type includes optional `salience?: number`, `pinned?: boolean`, `includedInModel?: boolean` fields, documented with a JSDoc comment explaining they carry authoritative CRP store state for the inspector
- [ ] `npm run build && npm run check` passes (the type addition is backward-compatible — all existing constructions omit these fields)
- [ ] A contract test asserts the type is importable and an item constructed *without* the new fields still satisfies the type (backward compat), and an item *with* the fields also satisfies it

**Steps:**
1. Read `packages/contracts/src/context-packet-view.ts:13-21`.
2. Add to `ContextPacketViewItem`, after `sourceCount?`:
   ```ts
   /** Authoritative CRP salience (0–1) at select time. Inspector-only; not emitted in the model prompt. */
   readonly salience?: number | undefined;
   /** True when salience was pinned to 1.0 by the operator. Drives the ◆ glyph. */
   readonly pinned?: boolean | undefined;
   /** True when the source is included in the model-ready packet; false when held back locally. */
   readonly includedInModel?: boolean | undefined;
   ```
3. Create `tests/contracts/context-packet-view-type.contract.test.mjs` with two assertions: (a) a minimal item `{id,category,label,reason}` typechecks via a `.d.ts`-style `satisfies` check at runtime is not possible — instead assert the module exports the type symbol path; (b) an enriched item with all three new fields is accepted. Use a runtime shape test: import a constructor that accepts the type and call it both ways, asserting no throw.
4. Run `npm run build` then `npm run check`. Both must pass.

---

## Task 2: Propagate authoritative flags through the CRP selector

**Goal:** `contextSourceToPacketItem` in `crp-selector.ts` sets `salience`, `pinned` (= `salience === 1.0`), and `includedInModel` on every projected item so the inspector renders truth instead of `pinned = false`.

**Dependencies:** Task 1.

**Files:**
- Modify: `packages/context-broker/src/crp-selector.ts` (anchor: `contextSourceToPacketItem`, line 40)
- Modify: `apps/unclecode-cli/src/work-runtime-crp.ts` (anchor: `upsertPacketItemsAsContextSources`, line 48 — ensure non-CRP items get a sensible default `includedInModel: true`)
- Test: `tests/agentops-db/context-sources.test.mjs` (extend) OR `tests/context-broker/` (create)

**Acceptance Criteria:**
- [ ] `contextSourceToPacketItem` sets `salience: src.salience`, `pinned: src.salience >= 1.0`, and `includedInModel: src.includedInModel` on the returned item
- [ ] `selectContextPacketFromStore` output: every item in `included` has `includedInModel === true`; every item in `excluded` has `includedInModel === false`
- [ ] A pinned source (`pinContextSource`) projected through `selectContextPacketFromStore` yields an item with `pinned === true` and `salience === 1.0`
- [ ] `npm run build && npm run check` passes
- [ ] A test asserts the three flag propagations (one assertion each)

**Steps:**
1. Read `packages/context-broker/src/crp-selector.ts:40-49`.
2. In `contextSourceToPacketItem`, add after `tokenEstimate`:
   ```ts
   salience: src.salience,
   pinned: src.salience >= 1.0,
   includedInModel: src.includedInModel,
   ```
3. In `apps/unclecode-cli/src/work-runtime-crp.ts:48-67`, `upsertPacketItemsAsContextSources` items are upserted but the *resolver return* path also builds items — verify the bootstrap/summary items built in `work-runtime-context-items.ts` get `includedInModel: true` by default since they are model-included. Check that file; if it constructs `ContextPacketViewItem` without the flag, add `includedInModel: true`.
4. Add a test in the context-broker or agentops-db suite: seed a source, pin it, call `selectContextPacketFromStore`, assert item `pinned === true && salience === 1.0 && includedInModel === true`.
5. Run `npm run build && npm run check && npm run test:context-broker`. All must pass.

---

## Task 3: Add `context.modelWindow` config + env wiring

**Goal:** Provide a configurable, env-overridable model context window (default 200000) that replaces the hard-coded `200_000` in the TUI meter, feeding both the meter and the view model.

**Dependencies:** None (parallelizable with Tasks 1–2).

**Files:**
- Modify: `packages/config-core/src/types.ts` (anchor: `context` block, line 39)
- Modify: `packages/config-core/src/defaults.ts` (anchor: line 50)
- Modify: `packages/config-core/src/resolver.ts` (anchor: context validation ~214; env ~283)
- Test: `tests/config-core/` (find existing config test, extend)

**Acceptance Criteria:**
- [ ] `UncleCodeConfig['context']` includes `readonly modelWindow?: number` with JSDoc "Model context window in tokens, used by the /context budget meter. Defaults to 200000. Override via UNCLECODE_CONTEXT_WINDOW."
- [ ] `CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW = 200000` constant exists in `defaults.ts` and is wired into the defaults object
- [ ] Resolver validates `context.modelWindow` as a positive integer (error: "Invalid context.modelWindow value.") and reads `UNCLECODE_CONTEXT_WINDOW` env into the setting (positive integer; 0/invalid → default)
- [ ] `npm run build && npm run check` passes
- [ ] A test asserts: config `{context:{modelWindow:128000}}` resolves to `128000`; env `UNCLECODE_CONTEXT_WINDOW=1000000` resolves to `1000000`; invalid value `modelWindow:-5` throws the expected error

**Steps:**
1. Read `packages/config-core/src/types.ts:39-44`, `defaults.ts:23-53`, `resolver.ts:214-311`.
2. Add `modelWindow?: number` to the `context` type block.
3. Add `CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW = 200000` to `defaults.ts` and include `modelWindow: CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW` in the context defaults.
4. In `resolver.ts`, add validation in the context-validation block: if `modelWindow` present and not a positive integer, throw `"Invalid context.modelWindow value."`. In the env block, read `Number(process.env.UNCLECODE_CONTEXT_WINDOW)` — if a positive integer, set `context.modelWindow` to it.
5. Find the existing config-core test file (rg for `crpBudget` test assertions), add three assertions for modelWindow: explicit config, env override, invalid throws.
6. Run `npm run build && npm run check && npm run test:config-core` (or the closest test script — verify script name in package.json).

---

## Task 4: Adaptive token meter reads model window from props

**Goal:** The token meter in `renderRunbookLine` (currently hard-coded to `200_000` / `UNCLECODE_CONTEXT_WINDOW` env) reads a `modelWindow` prop passed down from the pane, which sources it from config. Removes the hard-coded 200k (defect #7).

**Dependencies:** Task 3 (config field).

**Files:**
- Modify: `packages/tui/src/work-shell-view.tsx` (anchor: `renderRunbookLine`, line 825; meter math line 840-845)
- Modify: `packages/tui/src/work-shell-pane.tsx` (anchor: pass `modelWindow` prop)
- Test: `tests/contracts/tui-work-shell.contract.test.mjs` (extend)

**Acceptance Criteria:**
- [ ] `renderRunbookLine` accepts an optional `modelWindow?: number` (default 200000) in its options and uses it instead of reading `process.env.UNCLECODE_CONTEXT_WINDOW`
- [ ] The meter math (`filled`, `windowLabel`) derives from the passed `modelWindow`
- [ ] `work-shell-pane.tsx` passes the config-resolved `modelWindow` into the overlay render
- [ ] No remaining reference to `process.env.UNCLECODE_CONTEXT_WINDOW` in `work-shell-view.tsx`
- [ ] `npm run build && npm run check && npm run test:contracts` passes
- [ ] A contract test asserts `renderRunbookLine("Sources · ~1000 tokens", 0, {modelWindow:128000})` produces a meter label containing "128k" (not "200k")

**Steps:**
1. Read `packages/tui/src/work-shell-view.tsx:825-866`.
2. Change `renderRunbookLine` signature to accept `{ cursor?, modelWindow? }` as a 4th param (or extend the existing options object). Replace `const envWindow = Number.parseInt(process.env.UNCLECODE_CONTEXT_WINDOW ?? "", 10); const budgetWindow = ...` with `const budgetWindow = input.modelWindow ?? 200000;`.
3. Trace where `renderRunbookLine` is called (the overlay map at ~1927) and thread `modelWindow` from the pane props.
4. In `work-shell-pane.tsx`, ensure the pane receives `modelWindow` (sourced from config via the engine state or CLI bootstrap — add to the props passed to `WorkShellView`).
5. Remove the `process.env.UNCLECODE_CONTEXT_WINDOW` read.
6. Add a contract test rendering a `Sources ·` line with `modelWindow: 128000` and asserting the output contains "128k".
7. Run `npm run build && npm run check && npm run test:contracts`.

---

## Task 5: Structured view model + adaptive layout lines

**Goal:** Replace the string-roundtrip rendering with a `ContextInspectorViewModel` that the engine (cursor) and renderer both read. The view model produces display *rows* (not opaque strings), each tagged with its kind (`header` | `source` | `summary` | `meter` | `warning` | `hint`), so the cursor matches against navigable source rows only. The layout adapts: ≤4 sources → condensed (no collapsed-groups line); >8 sources → full with "+N more".

**Dependencies:** Task 1 (flags), Task 2 (propagation).

**Files:**
- Modify: `packages/context-broker/src/context-packet-view.ts` (anchor: append after `composeWorkShellTurnPromptFromPacket`)
- Modify: `packages/context-broker/src/index.ts` (anchor: CRP exports ~90)
- Modify: `packages/orchestrator/src/work-shell-engine.ts` (anchor: `resolveInspectorSourceList` ~872)
- Modify: `packages/orchestrator/src/work-shell-engine-builtins.ts` (anchor: `createContextBuiltinResult` ~305)
- Modify: `packages/orchestrator/src/work-shell-context-packet.ts` (anchor: ~9)
- Test: `tests/contracts/context-inspector-view-model.contract.test.mjs` (create)

**Acceptance Criteria:**
- [ ] `ContextInspectorViewModel` type exists with `rows: readonly ContextInspectorRow[]` where `ContextInspectorRow = { kind: "summary"|"meter"|"section-header"|"source"|"warning"|"hint"; sourceIndex?: number; text: string; item?: ContextPacketViewItem }`
- [ ] `buildContextInspectorViewModel(packet, options?)` returns a view model where every `kind:"source"` row carries a stable `sourceIndex` (0-based, included-then-excluded order) and the source `item`
- [ ] The number of source rows shown is adaptive: all included sources always shown; excluded sources capped at 4, with a `kind:"hint"` "+N more held back" row when truncated
- [ ] `resolveInspectorSourceList` in the engine reads directly from the view model's source rows (or the packet items directly) so cursor `sourceIndex` matches the rendered row — no more flat-list/line-index mismatch
- [ ] `npm run build && npm run check` passes
- [ ] A contract test asserts: (a) source rows have sequential `sourceIndex` 0..N-1; (b) cursor moving to `sourceIndex` highlights exactly that source row; (c) with 2 included + 6 excluded, exactly 4 excluded rows + 1 hint row appear

**Steps:**
1. Read `packages/context-broker/src/context-packet-view.ts` fully and `packages/orchestrator/src/work-shell-engine.ts:866-905`.
2. In `context-packet-view.ts`, add:
   ```ts
   export type ContextInspectorRowKind = "summary"|"meter"|"section-header"|"source"|"warning"|"hint";
   export type ContextInspectorRow = {
     readonly kind: ContextInspectorRowKind;
     readonly text: string;
     readonly sourceIndex?: number;
     readonly item?: ContextPacketViewItem;
   };
   export type ContextInspectorViewModel = { readonly rows: readonly ContextInspectorRow[] };
   export function buildContextInspectorViewModel(packet: ContextPacketView): ContextInspectorViewModel { ... }
   ```
   The builder emits: summary row, meter row (token estimate + window from packet), "Included in next answer" header, one source row per included item (sourceIndex = ordinal), "Held back locally" header, up to 4 excluded source rows, optional hint row, warning row, next-answer row.
3. Export from `packages/context-broker/src/index.ts`.
4. In `work-shell-engine.ts`, rewrite `resolveInspectorSourceList` to derive from `buildContextInspectorViewModel(state.contextPacket).rows` filtered to `kind:"source"` — preserving the existing return shape (`id,label,category,detail,pinned,heldBack`) but now with authoritative `pinned`/`heldBack` from the item flags.
5. In `work-shell-engine-builtins.ts`, `createContextBuiltinResult` for context builds `panel.lines` from the view model row `.text` (so the TUI's string-based `renderRunbookLine` still has text to match on) — but the *cursor* math uses `sourceIndex`.
6. Update `work-shell-context-packet.ts` re-exports.
7. Create the contract test asserting sourceIndex sequencing, cursor-row match, and adaptive cap.
8. Run `npm run build && npm run check && npm run test:contracts`.

---

## Task 6: Visual hierarchy — pinned glyph, dimmed held-back, section rules

**Goal:** `renderRunbookLine` renders pinned sources with `◆` (vs `◇`), held-back rows dimmed, and the cursor highlight tracks `sourceIndex` from the view model. Section headers get visual containment rules (defects #8, #12).

**Dependencies:** Task 5 (view model provides sourceIndex + item flags).

**Files:**
- Modify: `packages/tui/src/work-shell-view.tsx` (anchor: `renderRunbookLine` source-line branch ~911-937)
- Test: `tests/contracts/tui-work-shell.contract.test.mjs` (extend) OR `scripts/runtime-qa/tui-context-contrast-smoke.mjs` (extend)

**Acceptance Criteria:**
- [ ] A source row whose item has `pinned === true` renders `◆` glyph (bold accent color); otherwise `◇`
- [ ] A source row whose item has `includedInModel === false` renders in a dimmed/muted color
- [ ] The cursor highlight (`▶` + background) applies when `cursor.sourceIndex === row.sourceIndex` (not line index)
- [ ] Section headers ("Included in next answer" / "Held back locally") render with a colored rule and a one-line explanatory subtitle for Held back (e.g., "local only · not sent to the model"), addressing defect #8
- [ ] `npm run build && npm run check && npm run test:contracts` passes
- [ ] `node scripts/runtime-qa/tui-context-contrast-smoke.mjs` passes (the existing pinned-contract gate)

**Steps:**
1. Read `packages/tui/src/work-shell-view.tsx:911-948`.
2. Extend `renderRunbookLine` to accept the current row's `item` (from the view model) so it can read `pinned`/`includedInModel`. Thread the view model rows into the overlay render loop (the map at ~1927).
3. In the source-line branch, change glyph logic: `const glyph = item?.pinned ? "◆" : "◇"`. Color: pinned → bold `W.toolAccent`; normal → icon color from `CONTEXT_SOURCE_META`.
4. Dimming: if `item?.includedInModel === false`, wrap the row text in `color={W.textMuted}`.
5. Cursor: change `cursor.cursorIndex === index` (line index) to compare against the row's `sourceIndex` passed via the options. Thread `sourceIndex` from the view model row into the render call.
6. Held-back header: add a subtitle line `local only · not sent to the model` rendered in muted text under the header.
7. Update `tui-context-contrast-smoke.mjs` if its fixture needs the new glyph/subtitle — but prefer adding a new assertion in `tui-work-shell.contract.test.mjs` for the pinned/dim/held-back-subtitle behavior.
8. Run `npm run build && npm run check && npm run test:contracts && node scripts/runtime-qa/tui-context-contrast-smoke.mjs`.

---

## Task 7: Live footer chip — freshness pulse + salience hint

**Goal:** `formatContextPacketIndicator` becomes a live mini-dashboard: shows a freshness signal (how many sources changed since last turn), a salience hint (highest-pinned), and keeps the token estimate. Replaces the static `▤ N ctx · ~Xk · M held`.

**Dependencies:** Task 2 (flags for salience).

**Files:**
- Modify: `packages/context-broker/src/context-packet-view.ts` (anchor: `formatContextPacketIndicator`, line 246)
- Modify: `packages/tui/src/work-shell-footer-fast-paths.ts` (anchor: `compactWorkShellFooterContextChip`, line 42)
- Test: `tests/contracts/tui-work-shell.contract.test.mjs` (extend)

**Acceptance Criteria:**
- [ ] `formatContextPacketIndicator(packet)` output includes: included count, token estimate (`~Xk`), held count, and when >0 pinned sources exist, a `📌 N pinned` segment
- [ ] When `packet.sourceCounts.warnings > 0`, a `⚠N` segment is present (existing behavior preserved)
- [ ] The footer chip parser in `work-shell-footer-fast-paths.ts` recognizes the new form (regex updated) and falls back gracefully to the first `·`-segment for unknown forms
- [ ] `npm run build && npm run check && npm run test:contracts` passes
- [ ] A test asserts: a packet with 2 pinned sources yields an indicator containing "pinned"; a packet with 0 pinned omits the segment

**Steps:**
1. Read `packages/context-broker/src/context-packet-view.ts:246-252` and `packages/tui/src/work-shell-footer-fast-paths.ts:42-53`.
2. In `formatContextPacketIndicator`, compute `pinnedCount = packet.included.filter(i => i.pinned).length`. Append ` · 📌 ${pinnedCount} pinned` when `pinnedCount > 0`.
3. In `compactWorkShellFooterContextChip`, update the regex to also match the new `📌` segment form; keep the existing fallback for the `context N ready` legacy form.
4. Add a contract test: build a packet with 2 included items both `pinned: true`, call `formatContextPacketIndicator`, assert output includes "pinned". Build one with 0 pinned, assert "pinned" absent.
5. Run `npm run build && npm run check && npm run test:contracts`.

---

## Task 8: Final Verification

**Goal:** Run the full verification chain end-to-end and confirm no regressions across the workspace.

**Dependencies:** Tasks 1–7.

**Files:** None (verification only).

**Acceptance Criteria:**
- [ ] `npm run build` succeeds
- [ ] `npm run check` succeeds (tsc -p tsconfig.check.json --noEmit)
- [ ] `npm run test:contracts` passes
- [ ] `npm run test:context-broker` passes
- [ ] `npm run test:orchestrator` passes
- [ ] `npm run test:tui` passes
- [ ] `npm run test:config-core` (or nearest equivalent) passes
- [ ] `node scripts/runtime-qa/tui-context-contrast-smoke.mjs` passes
- [ ] No new TypeScript errors introduced in any touched package

**Steps:**
1. Run `npm run build` — confirm exit 0.
2. Run `npm run check` — confirm exit 0.
3. Run each test script listed above, confirming exit 0 and no failing assertions.
4. Run the runtime-qa smoke gate.
5. Save the combined output to `.glm-hammer/evidence/e2e.md`.

---

## Notes for Workers

- **Build before check.** Per AGENTS.md, `npm run check` resolves `@unclecode/*` subpath exports from `dist/` — always run `npm run build` first or you get false TS2307 errors.
- **Node version.** If `npm run node:check` fails, run `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- **No new dependencies.** All work uses existing packages.
- **No Rust changes.** The model-window metadata does not exist in the Rust model catalog; we source it from config/env, not the catalog.
- **Match surrounding code style.** `rg` for search, JSDoc on exported symbols, `readonly` fields, no `useEffect` for derived state.
- **Pre-existing test quirks are not yours to fix** (per AGENTS.md): `orchestrator-multi-agent.contract.test.mjs` and `tests/work/tools.test.mjs` have known issues unrelated to this work.
