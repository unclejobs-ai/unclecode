# Work Shell Palette Hierarchy — Application Plan

> Plan: `docs/glm-hammer/plans/2026-07-07-work-shell-palette-apply.md`
> Skill: `forge` → `hammer`
> Design input: `docs/glm-hammer/design/2026-07-07-work-shell-palette-hierarchy/` (tokens.json, design-spec.md, references.md)
> User request: "터미널에서 색상들 제대로 안 보인다 — 위계·하이라이키 개선, 세련되게"

## Critic Responses (round 1 → round 2)

- **feasibility F2 + integration C4 — `ContextInspectorPalette` lacks `borderDefault`:** Confirmed — `palette` in the inspector is typed `ContextInspectorPalette` (`work-shell-context-inspector-model.ts:3-14`), a SEPARATE type from `W`/`W_DARK`. Task 1 now ALSO adds `readonly borderDefault: string;` to this type so `palette.borderDefault` typechecks in Task 2.
- **integration C2 — `work-shell-live-activity.test.mjs:438` breaks:** Confirmed — that test asserts `resolveReadableWorkShellTextColor("#7d8590") === "#64748b"` (old textDim in the low-contrast set). After changing the set literal, `#7d8590` is no longer a member so the function returns it unchanged and the assertion fails. Fix: Task 1 KEEPS `"#7d8590"` in `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` AND adds `"#7f849c"` (both values present) — the old value stays a recognized low-contrast color for the resolver's legacy-color purpose, the new value is also recognized. No test breakage.
- **feasibility F1 — Task 3 WCAG threshold mathematically false:** Confirmed — `#45475a` against `#0d1117` is ~2.07:1, NOT ≥3.0:1. `borderDefault` is a BORDER (non-text UI component), whose WCAG threshold is ≥3.0:1 for non-text but this value is intentionally a quiet structural line (Catppuccin `surface1` = 1.80:1 per color-prospector). Task 3's contrast test now asserts `borderDefault` against the CORRECT threshold for a structural divider: it asserts `borderDefault` has HIGHER contrast than `borderSoft` (the fix invariant), and the ≥3.0:1 threshold applies only to `text`/`textMuted`/`textDim`/accent tokens (actual foreground colors). Borders are tested as a relative-improvement invariant, not an absolute text threshold.
- **integration C5 — main-shell dividers stay on `borderSoft`:** Scoped intentionally — the user's screenshot/complaint is the `/context` inspector overlay specifically. The design-spec Fidelity Notes say "The light palette is out of scope." Main-shell chrome rules (`renderChromeRule` etc.) are a separate surface; retargeting them is a follow-up. Task 2's scope is explicitly the context inspector. Added to Work Scope OUT for honesty.

## Critic Responses (recon findings folded in)

- **Recon "no test pins W_DARK directly":** Confirmed — all hex-pinning tests read from Rust (`getWorkShellEntryPresentation`) or force `UNCLECODE_TERMINAL_BACKGROUND=light` (exercising `W_LIGHT`). A `W_DARK`-only value change passes `test:contracts`, `test:tui`, and the runtime-qa smokes without test edits. BUT `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` (work-shell-view.tsx:184) contains the literal `#7d8590` (the old `textDim` value) — when `textDim` shifts to `#7f849c`, this set membership check must update or `resolveReadableWorkShellTextColor` will stop remapping the old value. Task 1 handles this.
- **Recon "borderSoft role-split needs structural change":** Confirmed — `renderContextInspectorOverlay` (work-shell-context-inspector.tsx:219) uses `borderSoft` for the section-divider rule, while `renderContextInspectorSourceRow` (lines 115-125) uses it for hairline field separators. The design wants section dividers at `#45475a` and hairlines at `#21262d`. A single `W.borderSoft` key cannot express both. Task 2 adds a `borderDefault` key to the palette and retargets the section-divider call site; hairlines keep reading `borderSoft`.
- **Recon "12 keys unused":** Confirmed — `borderAccent`, `userBody`, `userBadgeText/Bg`, `assistantBody/BadgeText/Bg`, `assistantMuted`, `tool`, `toolSurface`, `toolMuted`, `error` have 0 call sites. The migration map documents them for completeness but they need no code change (their values live in `W_DARK`/`W_LIGHT` as dead entries; updating their values is harmless no-ops since nothing reads them). Task 1 updates them for consistency but they carry no risk.

## Goal

Apply the crucible-approved dark-palette tokens to `W_DARK` in `packages/tui/src/work-shell-view.tsx` and add the structural `borderSoft` → `borderDefault` role-split so section dividers become visible (`#45475a`, +24 lightness) while hairlines stay quiet. This fixes the "색이 안 보인다 / 위계 엉망" complaint: the 4-tier foreground ladder gains distinct rungs, the three identical `#9ece6a` green roles de-collapse, and the invisible `borderSoft` section rules become readable.

## Architecture

The `W_DARK` object (work-shell-view.tsx:102-127) is the single source of dark-palette values, accessed only through the `W` Proxy (line 132). Changing its hexes propagates to every consumer automatically. The structural gap is `borderSoft` overloading two roles (hairline + section-divider); the fix adds a `borderDefault` key to BOTH `W_DARK` and `W_LIGHT` (for type-parity on the Proxy) and retargets the context-inspector's section-divider call site to read it. Hairline call sites keep `borderSoft`. The `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` set (line 184) updates its literal `#7d8590` → `#7f849c` so the text-color readability resolver tracks the new `textDim` value.

## Tech Stack

- TypeScript + React (Ink) — TUI in `packages/tui/`
- `packages/tui/src/work-shell-view.tsx` — `W_DARK`, `W_LIGHT`, the `W` Proxy, `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS`
- `packages/tui/src/work-shell-context-inspector.tsx` — section-divider call site
- Node `>=22.18.0`, Rust `>=1.85` (no Rust changes)
- Test runner: `node --test` via `npm run test:contracts` / `test:tui`

## Work Scope

**In:**
- `W_DARK` value updates (per the design migration map): `textDim`, `borderSoft` (stays as hairline value), new `borderDefault`, `assistant`, `toolAccent`, `success`, `warning`, `error`, `spinner`, `borderStrong`
- `W_LIGHT` gains a `borderDefault` key (type-parity for the Proxy)
- `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` literal update (`#7d8590` → `#7f849c`)
- Context-inspector section-divider retarget (`borderSoft` → `borderDefault`)
- A contrast smoke gate asserting the new dark palette clears WCAG

**Out:**
- `W_LIGHT` value changes (design explicitly scopes dark-only; the user's screenshot/complaint is dark-terminal)
- Dashboard `C` palette (separate, out of scope per design-spec)
- Rust entry-presentation palette (separate, pinned by contract tests)
- Main-shell chrome divider retarget (`renderChromeRule` and other `borderSoft` call sites in `work-shell-view.tsx` outside the context inspector) — the user's complaint is the `/context` inspector overlay specifically; main-shell chrome is a separate surface and a follow-up
- Removing the 12 unused `W_DARK` keys (harmless dead entries; removing risks type churn for no benefit)
- New dependencies

## Verification Strategy

**Level:** test-suite + build + a new contrast contract.
**Command:** `npm run build && npm run check && npm run test:contracts && npm run test:tui && node scripts/runtime-qa/tui-context-contrast-smoke.mjs`
**What passing proves:** the new dark-palette values typecheck, all existing TUI/contract tests still pass (no regressions — they exercise `W_LIGHT`/Rust paths), the context-inspector section dividers now use `borderDefault`, and a new contract test asserts the `W_DARK` foreground tokens clear WCAG AA (≥4.5:1 for text, ≥3.0:1 for dim/accent) against the dark base — locking in the readability fix.
**Prerequisite:** `npm run build` before `npm run check` (per AGENTS.md).

---

## File Structure Mapping

**Modify:**
- `packages/tui/src/work-shell-view.tsx` — `W_DARK` (anchor: line 102-127), `W_LIGHT` (anchor: line 71-96, add `borderDefault` key), `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` (anchor: line 184)
- `packages/tui/src/work-shell-context-inspector-model.ts` — `ContextInspectorPalette` type (anchor: line 3-14, add `borderDefault`)
- `packages/tui/src/work-shell-context-inspector.tsx` — section-divider call site (anchor: `renderContextInspectorSection` rule line, ~line 152 within the `renderContextInspectorSection` function; the section color currently passed as `palette.success`/`palette.borderSoft` feeds the rule)

**Create:**
- `tests/contracts/work-shell-dark-palette-contrast.contract.test.mjs` — WCAG contrast assertions for `W_DARK` tokens

---

## Task 1: Apply W_DARK value updates + borderDefault key + low-contrast set fix

**Goal:** Update the `W_DARK` object's hex values to the crucible-approved tokens, add a `borderDefault` key to both `W_DARK` and `W_LIGHT` for the section-divider role, and update the `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` literal so the readability resolver tracks the new `textDim`.

**Dependencies:** None.

**Files:**
- Modify: `packages/tui/src/work-shell-view.tsx` (anchor: `W_DARK` line 102-127; `W_LIGHT` line 71-96; `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` line 184)
- Test: `tests/contracts/work-shell-dark-palette-contrast.contract.test.mjs` (create)

**Acceptance Criteria:**
- [ ] `W_DARK` object contains the exact values from the design migration map: `text: "#e6edf3"`, `textMuted: "#a6adc8"` (unchanged), `textDim: "#7f849c"`, `border: "#30363d"` (unchanged), `borderStrong: "#6c7086"`, `borderSoft: "#21262d"` (unchanged), `borderDefault: "#45475a"` (NEW), `borderAccent: "#92abdf"` (unchanged), `user: "#92abdf"` (unchanged), `assistant: "#94e2d5"`, `tool: "#9ece6a"` (unchanged), `toolAccent: "#73daca"`, `warning: "#f9e2af"`, `success: "#a6e3a1"`, `error: "#f38ba8"`, `spinner: "#fab387"` — plus the badge/body/muted keys updated per the migration map for consistency
- [ ] `W_LIGHT` object gains a `borderDefault` key (value `#d0d7de`, matching its existing `borderSoft` light value so the section-divider is visible on light bg too)
- [ ] `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` contains BOTH `"#7d8590"` (old, kept for legacy-color resolver compat — the existing `work-shell-live-activity.test.mjs:438` asserts this value resolves) AND `"#7f849c"` (new textDim, added so the resolver recognizes it too)
- [ ] `npm run build && npm run check` passes (the new `borderDefault` key must be on both `W_DARK` and `W_LIGHT` so the Proxy's `typeof W_LIGHT` type union stays consistent)
- [ ] `npm run test:contracts && npm run test:tui` passes (no regressions — these exercise W_LIGHT/Rust paths)

**Steps:**
1. Read `packages/tui/src/work-shell-view.tsx:71-127` (the `W_LIGHT` and `W_DARK` objects) and `:184-188` (`WORK_SHELL_LOW_CONTRAST_TEXT_COLORS`).
2. In `W_DARK` (lines 102-127), update these values per the design migration map:
   - `textDim: "#7d8590"` → `"#7f849c"`
   - `borderStrong: "#a6adc8"` → `"#6c7086"`
   - `assistant: "#e6edf3"` → `"#94e2d5"`
   - `toolAccent: "#9ece6a"` → `"#73daca"`
   - `warning: "#e0af68"` → `"#f9e2af"`
   - `success: "#9ece6a"` → `"#a6e3a1"`
   - `error: "#e28b9b"` → `"#f38ba8"`
   - `spinner: "#d97757"` → `"#fab387"`
   - Add new key: `borderDefault: "#45475a"`
   - Leave unchanged: `text`, `textMuted`, `border`, `borderSoft`, `borderAccent`, `user`, `userBody`, `userBadgeText`, `userBadgeBg`, `assistantBody`, `assistantBadgeText`, `assistantBadgeBg`, `assistantMuted`, `tool`, `toolSurface`, `toolMuted`
   - For the body/badge/muted keys the migration map re-points (e.g., `userBody` → `text.default`), update their VALUES to match the target token where the map shows a value-shift; where the map says "maps to text.default" with the SAME value, leave as-is. Concretely: `assistant: "#94e2d5"` (shifted), `assistantBody`/`assistantBadgeText`/`assistantMuted` stay at their current values if they equal `#e6edf3`/`#a6adc8` (these are unused dead keys — no behavioral impact, but keep them consistent with the map's intent: `assistantBody`/`assistantBadgeText` → `#e6edf3`, `assistantMuted` → `#a6adc8`).
3. In `W_LIGHT` (lines 71-96), add `borderDefault: "#d0d7de"` (after `borderSoft`). This ensures the Proxy type union (`as typeof W_LIGHT`) includes the key.
4. In `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` (line 184-188), ADD `"#7f849c"` alongside the existing `"#7d8590"` (do NOT remove the old value — the existing `work-shell-live-activity.test.mjs:438` asserts `resolveReadableWorkShellTextColor("#7d8590") === "#64748b"` and will break if the old value is removed). Both values are now low-contrast-set members.
5. In `packages/tui/src/work-shell-context-inspector-model.ts` (the `ContextInspectorPalette` type, lines 3-14), add `readonly borderDefault: string;` after `borderSoft`. This is required so `palette.borderDefault` typechecks in Task 2 (the inspector's `palette` param is this type, NOT `W`/`W_DARK`).
5. Run `npm run build && npm run check && npm run test:contracts && npm run test:tui`. All must pass.

---

## Task 2: Retarget context-inspector section dividers to borderDefault

**Goal:** The context-inspector section-divider rule lines currently read `borderSoft` (invisible `#21262d`). Retarget them to the new `borderDefault` (`#45475a`) so the "Included"/"Held back" section rules become visible. Hairline separators in source rows keep `borderSoft`.

**Dependencies:** Task 1 (the `borderDefault` key must exist on the palette).

**Files:**
- Modify: `packages/tui/src/work-shell-context-inspector.tsx` (anchor: `renderContextInspectorSection` rule line ~152; the section `color` parameter passed from `renderContextInspectorOverlay` ~line 208/219)
- Test: `tests/contracts/work-shell-dark-palette-contrast.contract.test.mjs` (extend)

**Acceptance Criteria:**
- [ ] The section-divider rule line in `renderContextInspectorSection` reads `palette.borderDefault` (not `palette.borderSoft`/the passed section `color`)
- [ ] The hairline ` · ` separators in `renderContextInspectorSourceRow` (lines ~115-125) still read `palette.borderSoft` (unchanged — these are intra-row field separators, not section dividers)
- [ ] `npm run build && npm run check` passes (the `borderDefault` key exists on the palette type after Task 1)
- [ ] `npm run test:contracts && npm run test:tui` passes
- [ ] A contract test asserts `W.borderDefault` resolves to `"#45475a"` under dark terminal emulation

**Steps:**
1. Read `packages/tui/src/work-shell-context-inspector.tsx` fully (~240 lines). Locate `renderContextInspectorSection` (the function that renders the section header + rule line) — find the line that draws the `"─".repeat(...)` rule and what color it uses (currently the passed `input.color`).
2. The section rule line currently uses `input.color` (which is `palette.success` for "Included" and `palette.borderSoft` for "Held back"). Change the RULE line specifically to read `palette.borderDefault` instead of `input.color`. Keep the header TEXT in `input.color` (the success/borderSoft hue on the label is correct — only the rule needs the neutral visible color).
3. Verify the hairline separators in `renderContextInspectorSourceRow` (the ` · ` between icon/category/count/detail) still read `palette.borderSoft` — do NOT change these.
4. In `tests/contracts/work-shell-dark-palette-contrast.contract.test.mjs`, add an assertion: set `process.env.UNCLECODE_TERMINAL_BACKGROUND = "dark"`, import the palette (or read the value via the same Proxy path — check how existing tests access palette values; if the Proxy isn't exported, assert against the `W_DARK` literal by reading the source via `getWorkShellEntryPresentation`-style or a direct module import), confirm `borderDefault === "#45475a"`.
5. Run `npm run build && npm run check && npm run test:contracts && npm run test:tui`. All must pass.

---

## Task 3: Dark-palette WCAG contrast contract test

**Goal:** Lock in the readability fix with a contract test that computes WCAG contrast for every `W_DARK` text/accent token against the dark base background and asserts the thresholds — so a future regression that re-introduces an unreadable tier is caught.

**Dependencies:** Task 1 (the values must be applied).

**Files:**
- Create: `tests/contracts/work-shell-dark-palette-contrast.contract.test.mjs`

**Acceptance Criteria:**
- [ ] A contract test exists that computes WCAG 2.1 contrast (sRGB-linearized relative luminance) for each `W_DARK` foreground token (`text`, `textMuted`, `textDim`) against base `#0d1117` and asserts: `text` ≥4.5:1, `textMuted` ≥3.0:1, `textDim` ≥3.0:1
- [ ] The test asserts accent tokens (`user`, `assistant`, `tool`, `toolAccent`, `success`, `warning`, `error`, `spinner`) each ≥3.0:1 against `#0d1117`
- [ ] The test asserts the de-collapsed green triple are distinct hexes: `tool !== toolAccent`, `tool !== success`, `toolAccent !== success`
- [ ] The test asserts `borderDefault (#45475a)` has STRICTLY HIGHER contrast than `borderSoft (#21262d)` against `#0d1117` — this is the readability-fix invariant (the section divider became more visible). NOTE: `borderDefault` is a structural divider (~2.07:1), NOT a text token, so it is NOT held to the ≥3.0:1 text threshold; it is tested as a relative improvement over the old invisible `borderSoft`.
- [ ] `npm run build && npm run check && npm run test:contracts` passes including the new test

**Steps:**
1. Create `tests/contracts/work-shell-dark-palette-contrast.contract.test.mjs`. Import `assert` from `node:assert/strict` and `test` from `node:test`.
2. Define the WCAG helpers locally (mirror the helpers in `tests/contracts/tui-work-shell.contract.test.mjs` — `parseHexColor`, `relativeLuminance`, `contrastRatio`; find them at lines ~1840-1865 of that file and copy the implementation). Do NOT import across test files (they're not exported); copy the pure functions.
3. Define the `W_DARK` values as a const object in the test (the literal hexes from Task 1's acceptance criteria) — this pins the expected values. If the actual `W_DARK` is importable (check whether `work-shell-view.tsx` exports it or only the `W` Proxy), import and assert against it; otherwise assert against the literal contract.
4. Base background: `#0d1117`.
5. Write assertions:
   - `contrastRatio(W_DARK.text, "#0d1117") >= 4.5`
   - `contrastRatio(W_DARK.textMuted, "#0d1117") >= 3.0`
   - `contrastRatio(W_DARK.textDim, "#0d1117") >= 3.0`
   - For each accent (`user`, `assistant`, `tool`, `toolAccent`, `success`, `warning`, `error`, `spinner`): `>= 3.0`
   - `W_DARK.tool !== W_DARK.toolAccent` && `W_DARK.tool !== W_DARK.success` && `W_DARK.toolAccent !== W_DARK.success`
   - `contrastRatio(W_DARK.borderDefault, "#0d1117") > contrastRatio(W_DARK.borderSoft, "#0d1117")` (the readability-fix invariant — borderDefault is a structural divider, NOT held to the ≥3.0 text threshold)
6. Run `npm run build && npm run check && npm run test:contracts`. All must pass.

---

## Task 4: Final Verification

**Goal:** Run the full verification chain end-to-end.

**Dependencies:** Tasks 1–3.

**Files:** None (verification only).

**Acceptance Criteria:**
- [ ] `npm run build` succeeds (exit 0)
- [ ] `npm run check` succeeds (exit 0)
- [ ] `npm run test:contracts` passes (includes the new contrast contract)
- [ ] `npm run test:tui` passes
- [ ] `node scripts/runtime-qa/tui-context-contrast-smoke.mjs` passes (the contrast smoke — forces light, so unaffected, but confirms no regression)
- [ ] No test that previously passed now fails

**Steps:**
1. Run `npm run build` — confirm exit 0.
2. Run `npm run check` — confirm exit 0.
3. Run `npm run test:contracts && npm run test:tui` — confirm exit 0.
4. Run `node scripts/runtime-qa/tui-context-contrast-smoke.mjs` — confirm pass.
5. Save combined output to `.glm-hammer/evidence/e2e.md`.

---

## Notes for Workers

- **Build before check.** Per AGENTS.md, `npm run check` resolves `@unclecode/*` subpath exports from `dist/` — always `npm run build` first.
- **Node version.** Run `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` first.
- **No W_LIGHT value changes** — the design is dark-only. Only ADD the `borderDefault` key to `W_LIGHT` for type-parity.
- **The `borderSoft` role-split is the key structural change** — section dividers move to `borderDefault`, hairlines stay on `borderSoft`. Do not globally replace `borderSoft`.
- **`textMuted` stays `#a6adc8`** (unchanged value) — it is the `subtle` tier in the new ladder, not `muted`. Do not change its value.
- **Pre-existing test quirks** (per AGENTS.md): `orchestrator-multi-agent.contract.test.mjs`, `tests/work/tools.test.mjs` have known issues unrelated to this work.
- The design directory (`docs/glm-hammer/design/2026-07-07-work-shell-palette-hierarchy/`) is the authoritative source for values — `tokens.json` and `design-spec.md` (especially the "W_DARK migration map" in Application Guide).
