# Work Shell Palette Hierarchy — Design Spec

> Date: 2026-07-07 · Crucible smelt for the UncleCode work-shell terminal palette
> Storyline: "터미널에서 색상들 제대로 안 보인다 — 위계·하이라이키 개선, 세련되게"

## Story & Direction

The UncleCode work-shell TUI has a **perceptual lightness-ladder failure** in its dark palette. Three semantic green roles (`success`/`toolAccent`/`tool`) collapse to the identical `#9ece6a`, removing all hierarchy between tool chrome, success confirmation, and tool-call rails. The `borderSoft #21262d` divider sits at only +2.8 lightness points above the background — invisible. The foreground ladder has a gap: `textDim #7d8590` is technically AA-compliant (4.58:1) but there is no intermediate step between body text and the muted tier, so the eye cannot distinguish "secondary" from "tertiary."

**Direction:** Adopt the Catppuccin Mocha 4-tier foreground ladder (`#cdd6f4 → #bac2de → #a6adc8 → #7f849c`) to give dim/muted/body distinct, *legible* rungs. Raise the border ladder into a visible-but-neutral band (`#45475a`, Catppuccin Mocha `surface1`, +18 lightness points). De-collapse the green triple by lightness: tool chrome stays `#9ece6a` (base), tool-accent shifts teal to `#73daca`, success brightens to `#a6e3a1`. Keep the established role-hue identity (blue=user, teal=assistant, green=tool) and the single-thin-rule structural discipline — the fix is contrast calibration, not new furniture.

Mood: refined, precise, terminal-native, instrument-panel. The terminal should read like a calibrated IDE statusline, not a web dashboard.

## References

(See `references.md` for the full curated list. Summary:)
1. **Catppuccin Mocha** — 4-tier foreground ladder + surface stack. The structural template for the foreground rungs.
2. **Tokyo Night** — muted-tier contrast courage (`comment #565f89`). Source of the de-collapsed green family (`#9ece6a`/`#73daca`).
3. **GitHub Dark Default (Primer)** — neutral ladder + functional token resolution; de-collapsed green family.
4. **btop Tokyo-Night theme** — `inactive_fg #565f89` reused for dividers AND muted text (+31 lightness pts).
5. **cli-spinners/ora** — `dots` @ 80ms cadence (UncleCode's existing set, confirmed).

## Token Rationale

### color.surface
- `default #0d1117` — the existing UncleCode `W_LIGHT.text` value (`work-shell-view.tsx:72`), repurposed as the base background (also GitHub Dark base). True-black-adjacent for OLED, but not pure `#000` so borders have something to contrast against. **Source: existing codebase (`W_LIGHT.text`).**
- `raised #161b22` — the existing UncleCode `W_DARK.userBadgeBg`/`assistantBadgeBg`/`toolSurface` value (`work-shell-view.tsx:113,117,120`). **Source: existing codebase (`W_DARK`).**
- `overlay #181825` — Catppuccin Mocha `mantle`, one step above `base` in the Catppuccin surface stack (color-prospector R1 documents the `base #1e1e2e` / `mantle #181825` / `crust #11111b` ladder). For modal overlay backgrounds. **Source: color-prospector R1 (Catppuccin Mocha `mantle`).**

### color.border (THE FIX)
- `subtle #21262d` — the existing UncleCode `W_DARK.borderSoft` (`work-shell-view.tsx:108`), retained at the floor for hairline intra-content separators. **Source: existing codebase (`W_DARK.borderSoft`).**
- `quiet #30363d` — the existing UncleCode `W_DARK.border` (`work-shell-view.tsx:106`), for default 1px rules. **Source: existing codebase (`W_DARK.border`).**
- `default #45475a` — **NEW primary divider**. Catppuccin Mocha `surface1` (`#45475a`, 1.80:1 per color-prospector R1). The color-prospector explicitly names this as "the target for visible-but-quiet rules — it sits right where the brief wants `borderSoft` to land." This replaces `borderSoft` in the runbook/inspector so section rules are *visible* without shouting. **Source: color-prospector R1 (Catppuccin Mocha `surface1`).**
- `strong #6c7086` — Catppuccin `overlay0`, for emphasis borders (active panel focus). **Source: color-prospector R1 (Catppuccin Mocha `overlay0`).**
- `accent #92abdf` — the existing UncleCode `W_DARK.borderAccent`/`user` (`work-shell-view.tsx:109,110`), kept for accent-tinted rules. **Source: existing codebase (`W_DARK.borderAccent`).**

### color.text (THE FIX — 4-tier ladder)
- `default #e6edf3` — the existing UncleCode `W_DARK.text` (`work-shell-view.tsx:103`). 15.3:1 on bg. **Source: existing codebase (`W_DARK.text`).**
- `secondary #cdd6f4` — Catppuccin `text`. Primary label text; the brightest non-body tier. 13.1:1. **Source: color-prospector R1 (Catppuccin Mocha `text`).**
- `muted #bac2de` — Catppuccin `subtext1`. Meta/secondary info. 10.4:1. **Source: color-prospector R1 (Catppuccin Mocha `subtext1`).**
- `subtle #a6adc8` — Catppuccin `subtext0`. Detail/timestamps. 7.6:1. **Source: color-prospector R1 (Catppuccin Mocha `subtext0`).**
- `dim #7f849c` — Catppuccin `overlay1`. Replaces `textDim #7d8590`; readable but clearly tertiary. **Source: color-prospector R1 (Catppuccin Mocha `overlay1`).**

### color.accent (THE FIX — de-collapsed green + calibrated semantics)
- `user #92abdf` — the existing UncleCode `W_DARK.user` (`work-shell-view.tsx:110`). Role hue for user. **Source: existing codebase (`W_DARK.user`).**
- `assistant #94e2d5` — Catppuccin `teal`. Shifted from the old `#e6edf3` (which was just body-text color) to give assistant a real hue identity. **Source: color-prospector R1 (Catppuccin Mocha `teal`).**
- `tool #9ece6a` — the existing UncleCode `W_DARK.tool`/`success`/`toolAccent` (`work-shell-view.tsx:119,121,124`), now de-duplicated to the base-tool role only. **Source: existing codebase (`W_DARK.tool`) + color-prospector R2 (Tokyo Night green `#9ece6a`).**
- `toolAccent #73daca` — Tokyo Night `green1`, teal-shifted. **De-collapsed** from `#9ece6a`. **Source: color-prospector R2 (Tokyo Night `#73daca`).**
- `success #a6e3a1` — Catppuccin `green`, brightened. **De-collapsed** from `#9ece6a`. **Source: color-prospector R1 (Catppuccin Mocha `green`).**
- `warning #f9e2af` — Catppuccin `yellow`, brighter than the old `#e0af68`. **Source: color-prospector R1 (Catppuccin Mocha `yellow`).**
- `error #f38ba8` — Catppuccin `red`, warmer than the old `#e28b9b`. **Source: color-prospector R1 (Catppuccin Mocha `red`).**
- `spinner #fab387` — Catppuccin `peach`. Kept warm/orange to stay distinct from warning yellow (ΔE≥15, per motion-prospector guardrail). **Source: color-prospector R1 (Catppuccin Mocha `peach`).**

### typography
Terminal-native: monospace stack (JetBrains Mono → SF Mono → Menlo fallbacks). Weight is boolean (`bold`), not numeric — Ink/ANSI cannot render 500/600. Hierarchy comes from bold + the foreground lightness ladder, never from a third weight. Body is 1rem (terminal default size).

### spacing
Single-thin-rule discipline preserved: `gutter 1px`, `railIndent 2ch` (box-drawing rail indent), `sectionGap 1rem` (one terminal row of breathing room between sections), `rowPad 0.25rem`.

### radius
`none` — terminals don't do rounded corners (the existing `borderStyle="round"` box-drawing is a glyph, not CSS radius).

### motion
Confirmed correct: spinner 80ms (cli-spinners `dots`), stream cursor 500ms blink, spinner show-delay 500ms (cargo/aider convention). Static chrome — motion is signal, not decoration.

## Application Guide

### Runbook header (`/context` overlay title)
`color.text.secondary` (`#cdd6f4`) bold + `color.text.dim` (`#7f849c`) subtitle. The header pops above body via the secondary tier; the subtitle recedes to dim.

### Section dividers ("Included in next answer" / "Held back locally")
Rule line in `color.border.default` (`#45475a`) — **visible** at +18 lightness (Catppuccin Mocha `surface1`). Header label in `color.accent.success` (included) or `color.text.subtle` (held-back). The old `borderSoft` is gone from this role.

### Source rows (inspector list)
Icon in the role accent (`color.accent.user`/`assistant`/`tool`); category label in `color.text.subtle` (`#a6adc8`); count in `color.text.default` bold; detail/preview in `color.text.muted` (`#bac2de`). Cursor row: `color.surface.raised` background + `color.border.strong` foreground.

### Budget meter (`█░` / `●·`)
Fill tiers: low-fill (<50%) `color.accent.success` (`#a6e3a1`); mid-fill (50-80%) `color.accent.warning` (`#f9e2af`); high-fill (>80%) `color.accent.error` (`#f38ba8`). The three tiers are now perceptually distinct (green→yellow→red, ascending urgency) instead of collapsing.

### Footer chip
`color.accent.spinner` (`#fab387`) for the `▤` glyph; `color.text.muted` for counts; `color.accent.success` for the pinned segment count. The pinned count pops because `#a6e3a1` is the brightest green tier.

### Pinned glyph (◆ vs ◇)
Pinned: `color.accent.success` (`#a6e3a1`) bold ◆ — brightest green, signals "actively pinned." Unpinned: `color.text.dim` (`#7f849c`) ◇ — recedes.

### `W_DARK` migration map (implementation contract)

The existing `W_DARK` object (`work-shell-view.tsx:102-127`) maps to the new tokens as follows. **Read this as the worker's apply-table** — it resolves the highest-traffic key (`textMuted`, 30 call sites) and the role-conditional `borderSoft` remap.

| Existing `W_DARK` key | New token | Note |
|---|---|---|
| `text #e6edf3` | `color.text.default` | unchanged value |
| `textMuted #a6adc8` | `color.text.subtle` | **NOT `color.text.muted`** — the existing `#a6adc8` maps to Catppuccin `subtext0` (the `subtle` tier), one step below `muted`. The naming flips because the new ladder has 5 rungs; `textMuted`'s value is the `subtle` rung. |
| `textDim #7d8590` | `color.text.dim` | value shifts `#7d8590`→`#7f849c` (Catppuccin `overlay1`, +0.4 L, 5.1:1) |
| `border #30363d` | `color.border.quiet` | unchanged value |
| `borderStrong #a6adc8` | `color.border.strong` (`#6c7086`) | value shifts brighter for emphasis |
| `borderSoft #21262d` | **role-conditional:** hairline separators → `color.border.subtle` (unchanged `#21262d`); **section dividers** → `color.border.default` (`#45475a`, the fix) | The key split: `borderSoft` was overloaded. Hairlines stay invisible; section rules move to the visible `border.default` tier. |
| `borderAccent #92abdf` | `color.border.accent` | unchanged value |
| `user #92abdf` | `color.accent.user` | unchanged value |
| `userBody #e6edf3` | `color.text.default` | maps to body text |
| `userBadgeText #92abdf` | `color.accent.user` | badge text = role hue |
| `userBadgeBg #161b22` | `color.surface.raised` | unchanged value |
| `assistant #e6edf3` | `color.accent.assistant` (`#94e2d5`) | **value shifts** — assistant gets a real teal hue (was just body-text color) |
| `assistantBody #e6edf3` | `color.text.default` | maps to body text |
| `assistantBadgeText #e6edf3` | `color.text.default` | badge text = body |
| `assistantBadgeBg #161b22` | `color.surface.raised` | unchanged value |
| `assistantMuted #a6adc8` | `color.text.subtle` | same as `textMuted` |
| `tool #9ece6a` | `color.accent.tool` | unchanged value (de-duplicated to tool role only) |
| `toolSurface #161b22` | `color.surface.raised` | unchanged value |
| `toolAccent #9ece6a` | `color.accent.toolAccent` (`#73daca`) | **value shifts** — teal-shifted, de-collapsed |
| `toolMuted #a6adc8` | `color.text.subtle` | same as `textMuted` |
| `warning #e0af68` | `color.accent.warning` (`#f9e2af`) | **value shifts** brighter |
| `success #9ece6a` | `color.accent.success` (`#a6e3a1`) | **value shifts** — brightened, de-collapsed |
| `error #e28b9b` | `color.accent.error` (`#f38ba8`) | **value shifts** warmer |
| `spinner #d97757` | `color.accent.spinner` (`#fab387`) | **value shifts** to Catppuccin peach |

**Migration rule of thumb:** the foreground ladder adds a tier, so the existing `textMuted` value (`#a6adc8`) lands on `subtle`, not `muted`. Workers must NOT naively rename `textMuted → text.muted` — they rename to `text.subtle` to preserve the value. The `muted` tier (`#bac2de`) is NEW and used for detail/preview text that was previously undifferentiated.

## Fidelity Notes

- Every hex traces to Catppuccin Mocha v1.8.0, Tokyo Night, or GitHub Dark Default (Primer) — fetched from canonical upstream repos by the color prospector, not invented.
- WCAG contrast recomputed (WCAG 2.1 sRGB-linearized) against `color.surface.default #0d1117` (relLum 0.00548): `text.default` 16.0:1, `secondary` 13.1:1, `muted` 10.7:1, `subtle` 8.5:1, `dim` 5.1:1 (clears AA-normal 4.5:1). All `color.accent.*` tokens ≥8.0:1. Border ladder strictly monotonic ascending in lightness. (Earlier draft ratios were conservative underestimates; these are the recomputed values, verified by the rigor-critic.)
- The `border.subtle #21262d` token is retained for its original hairline role but is NOT used for section dividers anymore — `border.default #45475a` takes that role.
- The light palette (`W_LIGHT`) is intentionally out of scope for this smelt — the user's screenshot and complaint are dark-terminal-specific. The light palette can be re-smelted separately if needed.
- Motion primitives unchanged — the 80ms spinner and 500ms show-delay are confirmed correct by the motion prospector (cli-spinners `dots`, cargo/aider convention).
