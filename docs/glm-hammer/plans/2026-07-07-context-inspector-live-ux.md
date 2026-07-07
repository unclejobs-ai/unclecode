# Context Inspector — Live, Adaptive UI/UX

> Plan: `docs/glm-hammer/plans/2026-07-07-context-inspector-live-ux.md`
> Skill: `forge` → `hammer`
> Round 2 — rewritten after round-1 critic panel REJECT. The round-1 plan was written against a stale picture; the codebase already implements the structured overlay (`renderContextInspectorOverlay`, `buildContextInspectorRows`, sourceIndex cursor, ◆/◇ pinned glyph, dimmed held-back). This round targets the **genuinely remaining gaps**.

## Critic Responses (round 2 → round 3)

- **feasibility REJECT "modelWindow never wired into config explanation":** Confirmed — `explainUncleCodeConfig`'s `settings` object (resolver.ts:575-584) has no `modelWindow` entry, and `UncleCodeConfigExplanation['settings']` (types.ts:112) has no field. Task 1 now explicitly adds both the `explainSetting(...)` call and the type field, mirroring `crpBudget` exactly.
- **feasibility REJECT "resolver throws vs issues.push":** Confirmed — the resolver uses `issues.push("Invalid context.crpBudget value.")` (resolver.ts:229), never throws. Task 1 Step 4 now mandates the `issues.push` pattern and the criterion asserts the issue string, not a throw.
- **integration REJECT "T5 shared test-file conflict":** Resolved — Task 5 now mandates the pre-existing `tests/context-broker/context-packet-view.test.mjs` (created if absent within that dir), no "OR" fallback. T5's production files remain disjoint from T1–4.

## Critic Responses (round 1 → round 2)

- **feasibility REJECT "fields already exist":** Confirmed — `ContextPacketViewItem` already has `salience`/`includedInModel` (contracts:21-22), and `contextSourceToPacketItem` already propagates them (crp-selector:48-49). Round 2 drops those tasks entirely (T1, T2 gone).
- **feasibility REJECT "overlay already structured":** Confirmed — `renderContextInspectorOverlay` (work-shell-view.tsx:1043) already renders from `sourceIndex`-tagged rows with cursor + pin glyph + held-back dimming. Round 2 does NOT rebuild the overlay; it enhances the existing one.
- **feasibility REJECT "test:config-core missing":** Confirmed — no such script; config tests live at `tests/contracts/config-core.contract.test.mjs` under `test:contracts`. Round 2 uses `test:contracts` for all config-core assertions.
- **integration REJECT "config→engine→pane wiring missing":** Confirmed — no task wired `modelWindow` through state/props. Round 2 Task 1 (config) + Task 2 (state threading) form a single dependency chain that closes this end-to-end.
- **integration REJECT "T4↔T6 file conflict":** Resolved — round 2 has no parallel tasks touching `work-shell-view.tsx`; the meter change (Task 3) and the adaptive-layout change (Task 4) are sequential on the same file with an explicit dependency edge.
- **coverage REJECT "#4 composer cohabitation uncovered":** Verified FIXED already — `shouldHideWorkShellOverlayForInput` unconditionally returns `false` (work-shell-view.tsx:342). Not a gap; documented in Work Scope OUT.
- **coverage REJECT "freshness pulse has no step":** Round 2 Task 5 replaces the vague "freshness" goal with a concrete pinned-count segment (binary-decidable).

## Goal

Close the five genuinely-remaining gaps in the context inspector: (1) the token meter is hard-coded to an env var instead of config-driven (defect #7); (2) no `context.modelWindow` config exists; (3) the footer chip carries no salience/pinned signal; (4) the overlay's section row caps are static (`maxRows: 12/7`) instead of adapting to terminal height and source volume; (5) the config value does not thread from config-core through engine state to the TUI overlay.

## Architecture

A single config field (`context.modelWindow`, default 200000, env `UNCLECODE_CONTEXT_WINDOW`) threads through: config-core resolver → CLI bootstrap (`WorkShellCrpConfig`) → engine state (`WorkShellEngineState.modelWindow`) → `WorkShellView` props → `renderContextInspectorOverlay` → `renderContextInspectorBudgetLine`. This replaces the two `process.env.UNCLECODE_CONTEXT_WINDOW` reads in the TUI (work-shell-view.tsx:933 and the fallback `renderRunbookLine` meter) with a prop sourced from config. The footer indicator gains a `📌 N pinned` segment computed from `packet.included` items' `pinned`/`salience` flags (already present on the type). The overlay's section row caps become adaptive: derived from `terminalColumns`/terminal height rather than the hard-coded 12/7.

## Tech Stack

- TypeScript + React (Ink) — TUI in `packages/tui/`
- `@unclecode/config-core` — `context.modelWindow` config + env
- `@unclecode/contracts` — consumes existing `ContextPacketViewItem.salience` (no type change)
- `@unclecode/context-broker` — `formatContextPacketIndicator` enhancement
- `@unclecode/orchestrator` — `WorkShellEngineState.modelWindow`, bootstrap threading
- `apps/unclecode-cli` — `WorkShellCrpConfig.modelWindow`, resolver wiring
- Node `>=22.18.0`, Rust `>=1.85` (no Rust changes)
- Test runner: `node --test` via `npm run test:contracts` / `test:context-broker` / `test:orchestrator` / `test:tui`

## Work Scope

**In:**
- `context.modelWindow` config field + `UNCLECODE_CONTEXT_WINDOW` env wiring (config-core)
- `modelWindow` threaded into engine state + CLI bootstrap + TUI props
- Adaptive token meter reading the threaded `modelWindow` (replaces both env reads)
- Live footer indicator with pinned-count segment
- Adaptive overlay section row caps (terminal-height + source-volume aware)

**Out:**
- Rust `context_panel` retirement (defect #5) — separate effort, Rust changes
- Full-height *modal* display mode (design §B) — overlay already cohabits; modal is cosmetic
- `.omo/` path scrub structural replacement (defect #10) — band-aid retained (`sanitizeContextPreview` already centralizes it)
- Defect #4 (auto-hide) — ALREADY FIXED (`shouldHideWorkShellOverlayForInput` returns false)
- Defect #9 (64-char truncation) — ALREADY FIXED (`WORK_SHELL_GROUP_SUMMARY_MAX_WIDTH = 110`, overlay uses `previewWidth` derived from width)
- New dependencies

## Verification Strategy

**Level:** test-suite + build.
**Command:** `npm run build && npm run check && npm run test:contracts && npm run test:context-broker && npm run test:orchestrator && npm run test:tui`
**What passing proves:** the config field resolves and validates, the model window threads through state to the meter, the footer indicator emits the pinned segment, and the adaptive caps compute from terminal dimensions — all typecheck under composite project refs and their unit/contract tests pass. (The interactive overlay is not headlessly drivable; rendering math is locked by contract tests on the pure functions: `formatContextPacketIndicator`, the adaptive-cap helper, and the meter-label derivation.)
**Prerequisite:** `npm run build` before `npm run check` (per AGENTS.md — `@unclecode/*` subpath exports resolve to `dist/`).

---

## File Structure Mapping

**Modify:**
- `packages/config-core/src/types.ts` — add `modelWindow?: number` to `context` block (anchor: `context` block, line 39)
- `packages/config-core/src/defaults.ts` — add `CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW = 200000` (anchor: context defaults, line 50)
- `packages/config-core/src/resolver.ts` — validate `context.modelWindow`; read `UNCLECODE_CONTEXT_WINDOW` env (anchor: context validation ~214; env ~283)
- `packages/orchestrator/src/work-shell-engine.ts` — add `modelWindow?: number` to `WorkShellEngineState` (anchor: line 319, next to `contextIndicator`); set default in `createInitialWorkShellEngineState`-equivalent (the state literal at work-shell-engine-state.ts:76)
- `packages/orchestrator/src/work-shell-engine-state.ts` — include `modelWindow` in the initial state object (anchor: line 96, next to `terminalColumns`)
- `packages/orchestrator/src/work-shell-engine-builtins.ts` — pass `modelWindow` into the context builtin result if needed (anchor: `createContextBuiltinResult` ~276)
- `apps/unclecode-cli/src/work-runtime-crp.ts` — add `modelWindow: number` to `WorkShellCrpConfig` + `resolveWorkShellCrpConfig` (anchor: line 32, 37)
- `apps/unclecode-cli/src/work-runtime-bootstrap.ts` — thread `modelWindow` into engine construction (anchor: `createCrpRuntime` call ~491)
- `packages/context-broker/src/context-packet-view.ts` — enhance `formatContextPacketIndicator` with pinned segment (anchor: line 246)
- `packages/tui/src/work-shell-view.tsx` — `renderContextInspectorOverlay` accepts + forwards `modelWindow`; `renderContextInspectorBudgetLine` uses prop instead of env (anchor: 1043, 931); `WorkShellView` props add `modelWindow?: number` (anchor: 1411/1971/2049); adaptive section caps (anchor: `maxRows: 12` at 1066, `maxRows: 7` at 1076)
- `packages/tui/src/work-shell-pane.tsx` — pass `modelWindow` from engine state into `WorkShellView` (anchor: inspector props wiring ~166)

**Create (tests):**
- `tests/contracts/context-model-window.contract.test.mjs` (config + indicator + meter-label assertions)

---

## Task 1: Add `context.modelWindow` config + env wiring

**Goal:** Create a configurable, env-overridable model context window (default 200000) in config-core that downstream tasks thread into the inspector meter, replacing the hard-coded env reads (defect #7).

**Dependencies:** None.

**Files:**
- Modify: `packages/config-core/src/types.ts` (anchor: `context` block line 39; AND `UncleCodeConfigExplanation['settings']` line 112 — add `modelWindow: SettingExplanation<number>`)
- Modify: `packages/config-core/src/defaults.ts` (anchor: line 50)
- Modify: `packages/config-core/src/resolver.ts` (anchor: context validation ~214-236 — mirror `crpBudget`; env ~283-300 — mirror `UNCLECODE_CRP_BUDGET`; explanation `settings` object ~575-584 — add `modelWindow: explainSetting(...)`)
- Test: `tests/contracts/config-core.contract.test.mjs` (extend with modelWindow cases)

**Acceptance Criteria:**
- [ ] `UncleCodeConfig['context']` type includes `readonly modelWindow?: number` with JSDoc "Model context window in tokens, used by the /context budget meter. Defaults to 200000. Override via UNCLECODE_CONTEXT_WINDOW."
- [ ] `UncleCodeConfigExplanation['settings']` includes `readonly modelWindow: SettingExplanation<number>;` (anchor types.ts:112, next to `crpBudget`)
- [ ] `CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW = 200000` exists in `defaults.ts` and the context defaults object includes `modelWindow: CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW`
- [ ] Resolver validation uses the `issues.push(...)` pattern (NOT throw) — when `context.modelWindow` is present and not a positive integer, pushes the string `"Invalid context.modelWindow value."` into `issues` exactly as `crpBudget` does at resolver.ts:229
- [ ] `explainUncleCodeConfig(...).settings.modelWindow.value` reflects the resolved value, and the resolver's `settings` object includes `modelWindow: explainSetting(sources, (c) => c.context?.modelWindow, CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW)` at resolver.ts ~584
- [ ] Resolver env layer reads `UNCLECODE_CONTEXT_WINDOW` (mirror the `UNCLECODE_CRP_BUDGET` block at resolver.ts:294-298): when set and a positive integer via `Number.parseInt`, folds into the synthesized env config layer's `context.modelWindow`
- [ ] `npm run build && npm run check` passes
- [ ] `npm run test:contracts` passes, including new assertions: (a) `explainUncleCodeConfig` with `{context:{modelWindow:128000}}` yields `.settings.modelWindow.value === 128000`; (b) with env `UNCLECODE_CONTEXT_WINDOW=1000000` yields `.settings.modelWindow.value === 1000000`; (c) `{context:{modelWindow:-5}}` yields `explanation.sourceIssues` containing the string `"Invalid context.modelWindow value."`

**Steps:**
1. Read `packages/config-core/src/types.ts:39-44` and `:100-113`; `defaults.ts:23-53`; `resolver.ts:210-240`, `:280-300`, `:570-585`.
2. In `types.ts`: add `readonly modelWindow?: number;` (with the JSDoc) to the `context` block (after `crpBudget`, ~line 44). Add `readonly modelWindow: SettingExplanation<number>;` to the `settings` block of `UncleCodeConfigExplanation` (after `crpBudget`, ~line 112).
3. In `defaults.ts`: add `export const CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW = 200000;` near the other `CONFIG_CORE_DEFAULT_CONTEXT_*` constants, and add `modelWindow: CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW,` to the context defaults object.
4. In `resolver.ts`: FIRST add `modelWindow?: number;` to the `MutableContext` type (resolver.ts:74-77) so the assignment below typechecks. Then in the context-validation block (~214-236, alongside `crpBudget`): add `const modelWindow = asPositiveInteger(rawContext.modelWindow);` then `if ("modelWindow" in rawContext && rawContext.modelWindow !== undefined && modelWindow === undefined) { issues.push("Invalid context.modelWindow value."); }` then `if (modelWindow !== undefined) { nextContext.modelWindow = modelWindow; }` — mirror lines 223-236 for `crpBudget` exactly. (Use the SAME `asPositiveInteger` helper `crpBudget` uses.)
5. In `resolver.ts` env block (~287-300, the `crpContext` synthesis): extend the `crpContext` type to `{ crp?: boolean; crpBudget?: number; modelWindow?: number }`, add `const modelWindowRaw = env.UNCLECODE_CONTEXT_WINDOW;` then `if (modelWindowRaw !== undefined) { const parsed = Number.parseInt(modelWindowRaw, 10); if (Number.isFinite(parsed) && parsed > 0) { crpContext.modelWindow = parsed; } }` — mirror lines 294-298.
6. In `resolver.ts` explanation `settings` object (~580-584): add after the `crpBudget` entry:
   ```ts
   modelWindow: explainSetting(
     sources,
     (config) => config.context?.modelWindow,
     CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW,
   ),
   ```
7. In `tests/contracts/config-core.contract.test.mjs`, add three tests mirroring the existing `crpBudget` test style (find the existing `crpBudget` test to copy its fixture/teardown pattern): (a) config `{context:{modelWindow:128000}}` → `result.settings.modelWindow.value === 128000`; (b) with env `UNCLECODE_CONTEXT_WINDOW=1000000` (save/restore env) → `.value === 1000000`; (c) `{context:{modelWindow:-5}}` → the resolution surfaces `"Invalid context.modelWindow value."` in `explanation.sourceIssues` (match how the existing `crpBudget` invalid test asserts its issue string).
8. Run `npm run build && npm run check && npm run test:contracts`. All must pass.

---

## Task 2: Thread `modelWindow` through engine state + CLI bootstrap

**Goal:** Carry the resolved `modelWindow` from config-core through `WorkShellCrpConfig` and `WorkShellEngineState` into the TUI props so Task 3 can read it as a prop, not from `process.env`.

**Dependencies:** Task 1 (config field must exist).

**Files:**
- Modify: `packages/orchestrator/src/work-shell-engine.ts` (anchor: `WorkShellEngineState` type, line 319; default-state is set via `createInitialWorkShellEngineState` in work-shell-engine-state.ts)
- Modify: `packages/orchestrator/src/work-shell-engine-state.ts` (anchor: initial state literal, line 96)
- Modify: `apps/unclecode-cli/src/work-runtime-crp.ts` (anchor: `WorkShellCrpConfig`, line 32; `resolveWorkShellCrpConfig`, line 37)
- Modify: `apps/unclecode-cli/src/work-runtime-bootstrap.ts` (anchor: `createCrpRuntime`/engine construction, line ~491)
- Test: `tests/contracts/context-model-window.contract.test.mjs` (extend)

**Acceptance Criteria:**
- [ ] `WorkShellEngineState` type includes `readonly modelWindow: number;` (required, not optional — always has a default)
- [ ] `createInitialWorkShellEngineState` sets `modelWindow` to `input.options.modelWindow ?? 200000` in the returned state object
- [ ] `WorkShellCrpConfig` includes `readonly modelWindow: number;` and `resolveWorkShellCrpConfig` reads it from `explanation.settings.modelWindow.value`
- [ ] `work-runtime-bootstrap.ts` passes the resolved `modelWindow` into the engine options (or state seed)
- [ ] `npm run build && npm run check` passes
- [ ] A contract test asserts `createInitialWorkShellEngineState({...}).modelWindow === 200000` by default and `=== 128000` when `options.modelWindow` is provided

**Steps:**
1. Read `packages/orchestrator/src/work-shell-engine.ts:310-329`, `work-shell-engine-state.ts:64-104`, `apps/unclecode-cli/src/work-runtime-crp.ts:32-42`, `apps/unclecode-cli/src/work-runtime-bootstrap.ts:480-520`.
2. In `work-shell-engine.ts`, add `readonly modelWindow: number;` to `WorkShellEngineState` (after `contextIndicator`, line 319). Also add `readonly modelWindow?: number;` to `WorkShellEngineOptions` (find its declaration via `rg "WorkShellEngineOptions"`).
3. In `work-shell-engine-state.ts:76-103`, add `modelWindow: input.options.modelWindow ?? 200000,` to the returned state object (next to `terminalColumns`).
4. In `work-runtime-crp.ts`, add `readonly modelWindow: number;` to `WorkShellCrpConfig` (line ~34) and set it in `resolveWorkShellCrpConfig`: `modelWindow: explanation.settings.modelWindow.value`.
5. In `work-runtime-bootstrap.ts`, where `createCrpRuntime` is called (~491) and where the engine is constructed, pass `modelWindow: resolveWorkShellCrpConfig(configExplanation).modelWindow` into the engine options (trace the engine construction call site and add the option).
6. Add a contract test in `tests/contracts/context-model-window.contract.test.mjs`: import `createInitialWorkShellEngineState`, call with a minimal options fixture (mirror existing engine-state tests in the repo — `rg "createInitialWorkShellEngineState" tests/`), assert `.modelWindow === 200000` default and `=== 128000` when seeded.
7. Run `npm run build && npm run check && npm run test:contracts`. All must pass.

---

## Task 3: Adaptive token meter reads `modelWindow` from props

**Goal:** Replace the `process.env.UNCLECODE_CONTEXT_WINDOW` read in `renderContextInspectorBudgetLine` (work-shell-view.tsx:933) and the fallback `renderRunbookLine` meter with the threaded `modelWindow` prop. Closes defect #7.

**Dependencies:** Task 2 (state threading must land first so the prop exists).

**Files:**
- Modify: `packages/tui/src/work-shell-view.tsx` (anchor: `renderContextInspectorBudgetLine`, line 931; `renderContextInspectorOverlay`, line 1043; `renderRunbookLine` meter branch, line ~1111; `WorkShellView` render of overlay, line ~2188)
- Modify: `packages/tui/src/work-shell-pane.tsx` (anchor: pass `modelWindow` into `WorkShellView`, ~166)
- Test: `tests/contracts/context-model-window.contract.test.mjs` (extend)

**Acceptance Criteria:**
- [ ] `renderContextInspectorBudgetLine(packet, modelWindow)` uses the passed `modelWindow` for the window label and fill math; no `process.env.UNCLECODE_CONTEXT_WINDOW` read remains in this function
- [ ] `renderContextInspectorOverlay` accepts `modelWindow: number` and forwards it to `renderContextInspectorBudgetLine`
- [ ] The `WorkShellView` overlay render site (line ~2188) passes `props.modelWindow ?? 200000` into `renderContextInspectorOverlay`
- [ ] `work-shell-pane.tsx` passes the engine-state `modelWindow` into the `WorkShellView` props
- [ ] No remaining reference to `process.env.UNCLECODE_CONTEXT_WINDOW` in `packages/tui/src/work-shell-view.tsx`
- [ ] `npm run build && npm run check && npm run test:contracts && npm run test:tui` passes
- [ ] A contract test asserts: with `modelWindow = 128000` and a packet token estimate of 16000, the meter fill computes to 1 cell (10-cell meter: `round(16000/128000*10) = 1`) and the label contains "128k" not "200k"

**Steps:**
1. Read `packages/tui/src/work-shell-view.tsx:931-950`, `1043-1097`, the `renderRunbookLine` meter branch (~1107-1170 — read to find the exact env read in the fallback path), and the overlay render call at ~2188.
2. Change `renderContextInspectorBudgetLine` signature from `(packet: ContextPacketView)` to `(packet: ContextPacketView, modelWindow: number)`. Replace lines 933-934 (`envWindow`/`budgetWindow` from env) with `const budgetWindow = modelWindow;`.
3. In `renderContextInspectorOverlay`, add `modelWindow: number` to the input type and pass it: `{renderContextInspectorBudgetLine(input.packet, input.modelWindow)}`.
4. At the overlay render call site (~2188), add `modelWindow: props.modelWindow ?? 200000` to the `renderContextInspectorOverlay({...})` arguments.
5. Find and fix the `renderRunbookLine` fallback meter branch — it also reads `process.env.UNCLECODE_CONTEXT_WINDOW`. Since `renderRunbookLine` is the *fallback* (string-based) path and the structured overlay is now primary, thread `modelWindow` into it via its options object (it already accepts `{cursorIndex}` — extend to `{cursorIndex?, modelWindow?}`) and default to 200000. Replace the env read with `input.modelWindow ?? 200000`.
6. In `work-shell-pane.tsx`, find where `WorkShellView` props are assembled (the inspector props wiring ~166) and add `modelWindow: engineState.modelWindow` (or however the pane reads engine state).
7. Add a contract test: extract the meter-fill math into a tiny pure helper if it isn't already testable (the math is `Math.min(10, Math.max(0, Math.round((tokenEstimate / modelWindow) * 10)))` — test it directly by replicating or exporting a `computeContextMeterFill(tokenEstimate, modelWindow)` helper from the TUI module). Assert fill=1 and label "128k" for (16000, 128000).
8. Run `npm run build && npm run check && npm run test:contracts && npm run test:tui`. All must pass.

---

## Task 4: Adaptive overlay section row caps

**Goal:** Replace the hard-coded `maxRows: 12` (included) and `maxRows: 7` (held-back) in `renderContextInspectorOverlay` with values derived from terminal height (`terminalColumns` is available; derive a row budget from it or from a new height prop) so small terminals show fewer rows and tall terminals show more — the layout adapts to the viewport.

**Dependencies:** Task 3 (same file, sequential to avoid conflict).

**Files:**
- Modify: `packages/tui/src/work-shell-view.tsx` (anchor: `renderContextInspectorOverlay` section calls, lines 1062-1081; `maxRows` at 1066 and 1076)
- Test: `tests/contracts/context-model-window.contract.test.mjs` (extend — same file T1/T2/T3 write; T4 depends on T3 so sequential)

**Acceptance Criteria:**
- [ ] A pure helper `computeContextOverlaySectionMaxRows({ terminalRows?: number, sourceCount: number, section: "included"|"held" }): { included: number; held: number }` exists and is exported from `work-shell-view.tsx` (or a new small `work-shell-context-layout.ts` module)
- [ ] The helper returns: when `terminalRows` is undefined, `{included: 12, held: 7}` (current defaults preserved as fallback); when `terminalRows` is defined, `included = clamp(round(terminalRows * 0.4), 4, 20)` and `held = clamp(round(terminalRows * 0.25), 3, 12)`
- [ ] `renderContextInspectorOverlay` uses the helper instead of literal `12`/`7`
- [ ] `npm run build && npm run check && npm run test:contracts && npm run test:tui` passes
- [ ] A contract test asserts: `computeContextOverlaySectionMaxRows({terminalRows: 24})` returns `{included: 10, held: 6}` (round(9.6)=10, round(6)=6); `computeContextOverlaySectionMaxRows({terminalRows: 50})` returns `{included: 20, held: 12}` (clamped to max); `computeContextOverlaySectionMaxRows({})` returns `{included: 12, held: 7}`

**Steps:**
1. Read `packages/tui/src/work-shell-view.tsx:1043-1097`.
2. Add the helper function (with `clamp = (v,min,max)=>Math.min(max,Math.max(min,v))`):
   ```ts
   export function computeContextOverlaySectionMaxRows(input: {
     readonly terminalRows?: number;
     readonly sourceCount?: number;
     readonly section?: "included" | "held";
   }): { readonly included: number; readonly held: number } {
     if (input.terminalRows === undefined) return { included: 12, held: 7 };
     const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
     return {
       included: clamp(Math.round(input.terminalRows * 0.4), 4, 20),
       held: clamp(Math.round(input.terminalRows * 0.25), 3, 12),
     };
   }
   ```
3. In `renderContextInspectorOverlay`, accept `terminalRows?: number` in the input, compute `const caps = computeContextOverlaySectionMaxRows({terminalRows: input.terminalRows});`, and replace `maxRows: 12` → `maxRows: caps.included`, `maxRows: 7` → `maxRows: caps.held`.
4. At the overlay render call site (~2188), pass `terminalRows: props.terminalRows` (check if `WorkShellView` already receives terminal rows — if only `terminalColumns`, add a `terminalRows?: number` prop threaded the same way columns is).
5. Add the contract test with the three cases above.
6. Run `npm run build && npm run check && npm run test:contracts && npm run test:tui`. All must pass.

---

## Task 5: Live footer indicator with pinned-count segment

**Goal:** `formatContextPacketIndicator` emits a `📌 N pinned` segment when any included source is pinned (salience ≥ 1.0), turning the footer chip into a live salience signal. Keeps the existing token/held/warnings segments.

**Dependencies:** None (parallelizable with Tasks 1–4 — touches only `context-packet-view.ts` + footer parser, disjoint files).

**Files:**
- Modify: `packages/context-broker/src/context-packet-view.ts` (anchor: `formatContextPacketIndicator`, line 246)
- Modify: `packages/tui/src/work-shell-footer-fast-paths.ts` (anchor: `compactWorkShellFooterContextChip`, line 42)
- Test: `tests/context-broker/context-packet-view.test.mjs` (this file is disjoint from T1–4's `tests/contracts/context-model-window.contract.test.mjs`; create it if absent under `tests/context-broker/`)

**Acceptance Criteria:**
- [ ] `formatContextPacketIndicator(packet)` appends ` · 📌 N pinned` when `packet.included.filter(i => (i.salience ?? 0) >= 1).length > 0` (N = that count); omits the segment when count is 0
- [ ] Existing segments preserved: `▤ N ctx · ~Xk · M held` plus optional ` · W⚠`
- [ ] `compactWorkShellFooterContextChip` regex still parses the new form (the `📌` segment is after the first `·`-segment, so the existing `firstSegment` logic still returns the `▤ N ctx` segment unchanged — verify and, if needed, update the regex)
- [ ] `npm run build && npm run check && npm run test:contracts && npm run test:context-broker` passes
- [ ] A test asserts: a packet with 2 included items both `salience: 1.0` yields an indicator string containing "📌" and "2 pinned"; a packet with 0 pinned omits "pinned"

**Steps:**
1. Read `packages/context-broker/src/context-packet-view.ts:246-252` and `packages/tui/src/work-shell-footer-fast-paths.ts:42-53`.
2. In `formatContextPacketIndicator`, after computing `held` and `tokenK`, add:
   ```ts
   const pinnedCount = packet.included.reduce(
     (count, item) => count + ((item.salience ?? 0) >= 1 ? 1 : 0),
     0,
   );
   const pinnedSuffix = pinnedCount > 0 ? ` · 📌 ${pinnedCount} pinned` : "";
   ```
   Append `pinnedSuffix` to `base` before the warnings suffix (or after — consistent with existing order).
3. In `compactWorkShellFooterContextChip`, verify the `firstSegment` split still works: `normalized.split(/\s·\s/u)[0]` on `▤ 12 ctx · ~34k · 2 held · 📌 3 pinned` yields `▤ 12 ctx` — correct, no change needed. Add a comment noting the parser intentionally takes only the first segment so appended segments don't break it. If the existing `readyMatch` regex is the only path, no change; otherwise no change.
4. Find or create `tests/context-broker/context-packet-view.test.mjs` (do NOT use `tests/contracts/` — that dir is owned by T1–4's `context-model-window.contract.test.mjs` to avoid parallel-write conflict). Add two tests: (a) build a packet via `createContextPacketView` with 2 included items each `salience: 1.0`, call `formatContextPacketIndicator`, assert `/📌.*2 pinned/.test(result)`; (b) same with `salience: 0.5`, assert `!result.includes("pinned")`. Import from `@unclecode/context-broker` (source condition) mirroring the import style in other `tests/context-broker/*.test.mjs` files.
5. Run `npm run build && npm run check && npm run test:contracts && npm run test:context-broker`. All must pass.

---

## Task 6: Final Verification

**Goal:** Run the full verification chain end-to-end and confirm no regressions.

**Dependencies:** Tasks 1–5.

**Files:** None (verification only).

**Acceptance Criteria:**
- [ ] `npm run build` succeeds (exit 0)
- [ ] `npm run check` succeeds (exit 0)
- [ ] `npm run test:contracts` passes (includes config-core + context-model-window assertions)
- [ ] `npm run test:context-broker` passes
- [ ] `npm run test:orchestrator` passes
- [ ] `npm run test:tui` passes
- [ ] `node scripts/runtime-qa/tui-context-contrast-smoke.mjs` passes
- [ ] No reference to `process.env.UNCLECODE_CONTEXT_WINDOW` remains in `packages/tui/src/work-shell-view.tsx`

**Steps:**
1. Run `npm run build` — confirm exit 0.
2. Run `npm run check` — confirm exit 0.
3. Run `npm run test:contracts && npm run test:context-broker && npm run test:orchestrator && npm run test:tui` — confirm all exit 0.
4. Run `node scripts/runtime-qa/tui-context-contrast-smoke.mjs` — confirm pass.
5. Run `rg -n "UNCLECODE_CONTEXT_WINDOW" packages/tui/src/work-shell-view.tsx` — confirm no matches.
6. Save combined output to `.glm-hammer/evidence/e2e.md`.

---

## Notes for Workers

- **Build before check.** Per AGENTS.md, `npm run check` resolves `@unclecode/*` subpath exports from `dist/` — always `npm run build` first or you get false TS2307 errors.
- **Node version.** If `npm run node:check` fails, run `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- **No new dependencies.** No Rust changes.
- **`salience`/`includedInModel` already exist** on `ContextPacketViewItem` (contracts:21-22) — do NOT re-add them.
- **The structured overlay already exists** (`renderContextInspectorOverlay`, `buildContextInspectorRows`) — enhance, do not rebuild.
- **Config-core tests live at `tests/contracts/config-core.contract.test.mjs`** under `npm run test:contracts` — there is no `test:config-core` script.
- **Pre-existing test quirks are not yours to fix** (per AGENTS.md): `orchestrator-multi-agent.contract.test.mjs` and `tests/work/tools.test.mjs`.
