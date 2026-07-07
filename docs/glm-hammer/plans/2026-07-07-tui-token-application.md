# Plan: Apply Instrument-Grade Design Tokens to UncleCode TUI

**Source design:** `docs/glm-hammer/design/2026-07-07-tui-refinement/` (`tokens.json`, `design-spec.md`)
**Crucible approval:** assay APPROVE (round 3), panel APPROVE (harmony + rigor, round 2)
**Prior fixes already applied (out of scope, recorded for completeness):** composer `textColor` prop (invisible-input fix), status bar spinner dedup, `compactWorkShellAuthLabel` "OAuth blocked"→"OAuth · needs API key" (TS + Rust).

## Critic Responses (Round 1 → Round 2 → Round 3)

### Round 1 findings (all fixed in Round 2)
- **Shared-file conflict** — Tasks 1/4/5 all modified `work-shell-view.tsx`. **Fixed:** serialized into single Task 1.
- **Stale code reference** — `showActivityIndicator` expression wrong. **Fixed:** corrected to `const showActivityIndicator = props.isBusy;`.
- **Missing test updates** — spinner interval + borderStyle assertions. **Fixed:** added explicit steps.

### Round 2 findings (fixed in Round 3)
- **WCAG `#1e6feb` (user labelColor) = 4.64:1 on `#ffffff`** — fails contract test ≥7:1. **Fixed:** Rust user `labelColor` pinned to `#0a3069` (navy, 12.81:1, verified). No longer conditional.
- **WCAG `#1a7f37` (tool labelColor) = 5.08:1** — fails ≥7:1. **Fixed:** Rust tool `labelColor` pinned to `#033a16` (dark green, 12.96:1, verified). The `#1a7f37` stays only in TS `W_LIGHT.tool` (not subject to the contract WCAG test, which reads Rust values).
- **Spinner interval tests already 80** — `composer-workflow.test.mjs:58` and `contract.test.mjs:386` already assert 80. **Fixed:** removed the stale 100→80 instructions; these tests need NO change. The constant `WORK_SHELL_SPINNER_INTERVAL_MS` (line 464) is already 80.
- **`#0d1117` bodyColor not in `WORK_SHELL_RUST_LIGHT_BODY_COLORS`** — would render near-black on dark terminals (re-introduces invisible-text bug). **Fixed:** Task 1 Step 5 now explicitly adds `#0d1117` to the remap set.
- **Conditional `#0a3069` in Task 3 Step 5** contradicted Task 2's `#1e6feb`. **Fixed:** both tasks now use `#0a3069` deterministically.

## Goal

Apply the approved instrument-grade design tokens to the UncleCode TUI: replace palette hexes (TS + Rust), apply spacing/radius tokens, add the spinner show-delay, and update ALL tests asserting old values — so the TUI reads as "an instrument, not a costume."

## Architecture

Three color sources move in lockstep: (1) TS `W_DARK`/`W_LIGHT` + Proxy in `work-shell-view.tsx`, (2) Rust `resolve_work_shell_entry_presentation` in `ux_text.rs`, (3) tests asserting exact values. Key architectural constraint (discovered in recon): the Rust bridge emits ONE set of role hexes (light-mode values), and the TS `WORK_SHELL_RUST_LIGHT_BODY_COLORS` remapping set bridges them to dark. So Rust keeps light-appropriate values; TS `W_DARK` gets the dark token values independently. All `work-shell-view.tsx` edits are serialized into one task to avoid file conflicts.

## Tech Stack

TypeScript (Ink/React), Rust, `node:test` + `tsx`, `cargo test`.

## Work Scope

**In:** TS palette values, Rust role hexes (light-mode), markdown theme mappings, hex detection sets, spinner show-delay gate, spacing/radius inline literals, all affected test assertions.

**Out:** Dashboard palette `C` (separate view), markdown renderer (palette-agnostic), `cursorBlink`/`transition` (already compliant), oauth label (already fixed).

## Verification Strategy

**Level:** test-suite + build
**Commands:** `npm run build`, `cargo build --workspace`, `npm run test:tui`, `npm run test:contracts`, `npm run test:work`, `cargo test -p unclecode-core ux_text`
**What passing proves:** new hexes satisfy WCAG, no forbidden oranges, Rust/TS agree, spinner delay works, everything compiles.

---

## Task 1: Apply All TS Token Changes to work-shell-view.tsx (Serialized)

**Goal:** Replace `W_DARK`/`W_LIGHT` palette values, update hex detection sets, apply spacing/radius tokens, and add the spinner show-delay gate — all in one task since they touch the same file.

**Dependencies:** None (single-file task, self-contained)

**Files:** Modify `packages/tui/src/work-shell-view.tsx`

**Acceptance Criteria:**
- [ ] `W_DARK` (anchor: line ~98) contains dark token values: `text: "#e6edf3"`, `textMuted: "#a6adc8"`, `textDim: "#7d8590"`, `border: "#30363d"`, `borderStrong: "#a6adc8"`, `borderSoft: "#21262d"`, `user: "#92abdf"`, `assistant: "#e6edf3"`, `tool: "#9ece6a"`, `toolAccent: "#9ece6a"`, `warning: "#e0af68"`, `success: "#9ece6a"`, `error: "#e28b9b"`, `spinner: "#d97757"`
- [ ] `W_LIGHT` (anchor: line ~67) contains light-mode equivalents: `text: "#0d1117"`, `textMuted: "#475569"`, `textDim: "#64748b"`, `border: "#30363d"`, `borderStrong: "#1e293b"`, `borderSoft: "#d0d7de"`, `user: "#1e6feb"`, `assistant: "#0d1117"`, `tool: "#1a7f37"`, `toolAccent: "#1a7f37"`, `warning: "#9a6700"`, `success: "#1a7f37"`, `error: "#cf222e"`, `spinner: "#bc4c00"`
- [ ] `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` (anchor: ~L176) contains `#7d8590`
- [ ] Root `<Box ... paddingX={1}>` in `WorkShellView` return (grep for `paddingX={1}` in the outermost Box) → `paddingX={2}`
- [ ] `WorkShellStatusBlock` paddingLeft (anchor: the `<Box marginTop={1} paddingLeft={1}>` in StatusBlock) → `paddingLeft={2}`
- [ ] All `borderStyle="round"` occurrences → `borderStyle="single"` (grep `borderStyle="round"` — currently 3 sites)
- [ ] New constant `WORK_SHELL_SPINNER_SHOW_DELAY_MS = 500` exists near `WORK_SHELL_SPINNER_INTERVAL_MS` (anchor: ~L462)
- [ ] `WorkShellConversationBlock` (anchor: ~L1726) has `showSpinner` state gated by `setTimeout(..., WORK_SHELL_SPINNER_SHOW_DELAY_MS)`, and `showActivityIndicator` (actual line 1751: `const showActivityIndicator = props.isBusy;`) becomes `const showActivityIndicator = props.isBusy && showSpinner;`
- [ ] `npm run build` succeeds

**Steps:**
1. Read `W_DARK` (~L98-123). Replace each hex with the dark token value. Badge bg/text derive: `userBadgeBg: "#161b22"`, `userBadgeText: "#92abdf"`, `assistantBadgeBg: "#161b22"`, `assistantBadgeText: "#e6edf3"`, `toolSurface: "#161b22"`, `toolMuted: "#a6adc8"`, `assistantMuted: "#a6adc8"`, `borderAccent: "#92abdf"`, `userBody: "#e6edf3"`, `assistantBody: "#e6edf3"`.
2. Read `W_LIGHT` (~L67-92). Replace with light values (GitHub Primer light). Badge bg/text: `userBadgeBg: "#ddf4ff"`, `userBadgeText: "#0d1117"`, `assistantBadgeBg: "#dafbe1"`, `assistantBadgeText: "#0d1117"`, `toolSurface: "#ddf4ff"`, `toolMuted: "#475569"`, `assistantMuted: "#475569"`, `borderAccent: "#1e6feb"`, `userBody: "#0d1117"`, `assistantBody: "#0d1117"`.
3. Update `resolveMarkdownTheme()` (~L137-154): `heading`/`headingL2`/`bullet`/`tableHeader` → `W.assistant`, `headingL3`/`codeBlock` → `W.textMuted`, `bold` → `W.borderStrong`, `inlineCode`/`link` → `W.user`, `inlineCodeBg`/`tableBorder` → `W.borderSoft`, `quote` → `W.textMuted`.
4. Update `WORK_SHELL_LOW_CONTRAST_TEXT_COLORS` (~L176): replace `#94a3b8`/`#0d9488` with `#7d8590`.
5. Update `WORK_SHELL_LEGACY_LIGHT_TEXT_COLORS` (~L169): replace old hexes (`#e2e8f0`, `#e5eef7`, `#f4f1ea`, `#f8fafc`) with any new light-mode values that might need remapping — keep as guard for stale cache output: `#e6edf3`, `#a6adc8`, `#7d8590`, `#0d1117`, `#475569`.
6. **Critical (Round 2 fix):** Update `WORK_SHELL_RUST_LIGHT_BODY_COLORS` (~L194) — ADD `#0d1117` to this set. Without it, Rust-emitted `bodyColor: "#0d1117"` renders near-black on dark terminals, re-introducing the invisible-text bug. The set must contain `#0d1117` so it gets remapped to `W.text` on dark.
7. Grep `borderStyle="round"` — change all 3 occurrences to `borderStyle="single"`.
8. Find root `<Box flexDirection="column" paddingX={1}>` in `WorkShellView` — change to `paddingX={2}`.
9. Find `WorkShellStatusBlock`'s `<Box marginTop={1} paddingLeft={1}>` — change paddingLeft to `2`.
10. Add `export const WORK_SHELL_SPINNER_SHOW_DELAY_MS = 500;` after `WORK_SHELL_SPINNER_INTERVAL_MS` (~L464).
11. In `WorkShellConversationBlock` (~L1726): add `const [showSpinner, setShowSpinner] = React.useState(false);`. In the `isBusy` effect, add: when `isBusy` true, `const delay = setTimeout(() => setShowSpinner(true), WORK_SHELL_SPINNER_SHOW_DELAY_MS);` and return cleanup `() => { clearTimeout(delay); setShowSpinner(false); };`. When `isBusy` false, `setShowSpinner(false)`.
12. Change `const showActivityIndicator = props.isBusy;` (line 1751) to `const showActivityIndicator = props.isBusy && showSpinner;`.
13. Run `npm run build` → expect zero errors.

---

## Task 2: Update Rust Entry Presentation (Light-Mode Role Hexes + Border Style)

**Goal:** Replace Rust role hexes with light-mode-appropriate values (that pass ≥7:1 on white per the contract test) and change borderStyle round→single.

**Dependencies:** None (different file from Task 1)

**Files:** Modify `rust/unclecode-core/src/ux_text.rs` (anchor: `resolve_work_shell_entry_presentation` ~L435)

**Acceptance Criteria:**
- [ ] `resolve_work_shell_entry_presentation("user")` emits: `labelColor: "#0a3069"`, `labelTextColor: "#0d1117"`, `labelBackgroundColor: "#ddf4ff"`, `railColor: "#0d1117"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`, `borderStyle: "single"`
- [ ] `resolve_work_shell_entry_presentation("assistant")` emits: `labelColor: "#0d1117"`, `labelTextColor: "#0d1117"`, `labelBackgroundColor: "#dafbe1"`, `railColor: "#0a3069"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`, `borderStyle: "single"`
- [ ] `resolve_work_shell_entry_presentation("tool")` emits: `labelColor: "#033a16"`, `railColor: "#475569"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`, `borderStyle: "single"`
- [ ] `resolve_work_shell_entry_presentation` default/system emits: `labelColor: "#475569"`, `railColor: "#475569"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`
- [ ] The `match role` border_style line: `"assistant" => (1, 2, "single")`, `_ => (1, 0, "single")` (both round→single)
- [ ] `cargo build --workspace` succeeds

**Steps:**
1. Read `resolve_work_shell_entry_presentation` (~L435-488).
2. Change border_style match: `"assistant" => (1, 2, "round")` → `(1, 2, "single")`; `_ => (1, 0, "round")` → `(1, 0, "single")`.
3. User role hexes: `labelColor` `#075985`→`#0a3069` (navy, 12.81:1 on white — passes contract ≥7:1), `labelTextColor` `#082f49`→`#0d1117`, `labelBackgroundColor` `#bfdbfe`→`#ddf4ff`, `railColor` `#115e59`→`#0d1117`, `borderColor` `#334155`→`#30363d`, `bodyColor` `#0f172a`→`#0d1117`.
4. Assistant: `labelColor` `#115e59`→`#0d1117`, `labelTextColor` `#042f2e`→`#0d1117`, `labelBackgroundColor` `#ccfbf1`→`#dafbe1`, `railColor` `#075985`→`#0a3069`, `borderColor` `#1e293b`→`#30363d`, `bodyColor` `#0f172a`→`#0d1117`.
5. Tool: `labelColor` `#365314`→`#033a16` (dark green, 12.96:1 on white — passes ≥7:1), `railColor` `#334155`→`#475569`, `borderColor` `#1e293b`→`#30363d`, `bodyColor` `#0f172a`→`#0d1117`.
6. System/default: all `#334155`→`#475569` except `borderColor`→`#30363d`, `bodyColor`→`#0d1117`.
7. Run `cargo build --workspace` → expect zero errors.

---

## Task 3: Update All Test Assertions

**Goal:** Update every test that asserts old hex values, old spinner interval (100), old borderStyle ("round"), so all suites pass with the new values.

**Dependencies:** Task 1 (TS palette) + Task 2 (Rust presentation)

**Files:** Modify `tests/contracts/tui-work-shell.contract.test.mjs`, `tests/tui/work-shell-composer-workflow.test.mjs`, `rust/unclecode-core/src/ux_text.rs` (test fixture only)

**Acceptance Criteria:**
- [ ] Contract test role hex assertions (~L206-237) match Task 2's Rust output exactly: user `labelColor: "#0a3069"`, tool `labelColor: "#033a16"`, etc.
- [ ] Contract test "must contain" regex (~L258) is `/#0a3069|#0d1117|#033a16/i`
- [ ] Contract test `borderStyle` assertions (~L239-240): `getWorkShellEntryBorderStyle("user")` → `"single"`, `("assistant")` → `"single"`
- [ ] Contract test source-grep assertions for `borderStyle="round"` (~L128, L132) → updated to `borderStyle="single"`
- [ ] Contract test WCAG contrast (~L285) passes with new light-mode hexes — all role labelColors ≥7:1 on `#ffffff` (verified: `#0a3069`=12.81:1, `#0d1117`=18.92:1, `#033a16`=12.96:1, `#475569`=7.58:1)
- [ ] Rust test fixture `resolves_work_shell_entry_presentation` (~L1730-1748): hex JSON + `"borderStyle":"single"` updated to match Task 2
- [ ] `tests/tui/work-shell-live-activity.test.mjs` (~L366-375) `resolveReadableWorkShellTextColor` assertions updated to new return values
- [ ] `tests/work/repl.test.mjs` (~L1376-1377) bodyColor assertions updated from `#0f172a` to `#0d1117`
- [ ] `npm run test:contracts` passes
- [ ] `npm run test:tui` passes
- [ ] `cargo test -p unclecode-core ux_text` passes

**Note on spinner interval tests:** `WORK_SHELL_SPINNER_INTERVAL_MS` is already 80 (line 464), and `composer-workflow.test.mjs:58` + `contract.test.mjs:386` already assert 80. These tests need NO change — they already pass. Do not edit them.

**Steps:**
1. Read contract test role hex block (~L200-240). Update user: `labelColor: "#0a3069"`, `labelTextColor: "#0d1117"`, `labelBackgroundColor: "#ddf4ff"`, `railColor: "#0d1117"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`. Update assistant: `labelColor: "#0d1117"`, `labelTextColor: "#0d1117"`, `labelBackgroundColor: "#dafbe1"`, `railColor: "#0a3069"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`. Update tool: `labelColor: "#033a16"`, `railColor: "#475569"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`. Update system: `labelColor: "#475569"`, `railColor: "#475569"`, `borderColor: "#30363d"`, `bodyColor: "#0d1117"`.
2. Update "must contain" regex (~L258): `/#075985|#115e59|#365314/i` → `/#0a3069|#0d1117|#033a16/i`.
3. Update borderStyle assertions (~L239-240): both `"round"` → `"single"`.
4. Update source-grep assertions (~L128, L132): `borderStyle="round"` → `borderStyle="single"` in the regex patterns.
5. Verify WCAG (already computed — values above all pass ≥7:1 on white). No adjustment needed.
6. Read Rust test fixture (~L1730-1748). Update expected JSON strings: user `labelColor`→`#0a3069`, tool `labelColor`→`#033a16`, all bodyColors→`#0d1117`, all borderColors→`#30363d`, `borderStyle`→`"single"` for user/assistant.
7. **Update `tests/tui/work-shell-live-activity.test.mjs` (~L366-375):** This test is light-mode (`UNCLECODE_TERMINAL_BACKGROUND=light`, so `W.text`=`#0d1117`, `W.textDim`=`#64748b`). After Task 1's palette + detection-set changes: `resolveReadableWorkShellTextColor("#f8fafc")`→`"#0d1117"` (in legacy set), `("#e2e8f0")`→`"#0d1117"`, `("#0f172a")`→`"#0d1117"`, `("#334155")`→`"#0d1117"`, `("#475569")`→`"#0d1117"`, `("#94a3b8")`→`"#94a3b8"` (no longer in LOW_CONTRAST set after Task 1 Step 4 — returns input unchanged), `("#115e59")`→`"#115e59"` (unchanged). Update all 7 assertions to these values.
8. **Update `tests/work/repl.test.mjs` (~L1376-1377):** Change `assert.equal(userPresentation.bodyColor, "#0f172a")`→`"#0d1117"` and `assert.equal(assistantPresentation.bodyColor, "#0f172a")`→`"#0d1117"`.
9. Run `npm run test:contracts`, `npm run test:tui`, `cargo test -p unclecode-core ux_text` — all must pass.

---

## Task 4: Final Verification

**Goal:** Run the full verification suite to prove the token application is complete.

**Dependencies:** Tasks 1, 2, 3

**Files:** None (verification only)

**Acceptance Criteria:**
- [ ] `npm run build` passes
- [ ] `cargo build --workspace` passes
- [ ] `npm run test:tui` passes (0 fail)
- [ ] `npm run test:contracts` passes (0 fail)
- [ ] `npm run test:work` passes (0 fail)
- [ ] `cargo test -p unclecode-core ux_text` passes (0 fail)

**Steps:**
1. `npm run build 2>&1 | tail -5`
2. `cargo build --workspace 2>&1 | tail -5`
3. `npm run test:tui 2>&1 | tail -15`
4. `npm run test:contracts 2>&1 | tail -15`
5. `npm run test:work 2>&1 | tail -15`
6. `cargo test -p unclecode-core ux_text 2>&1 | tail -15`
7. Report any failures.
