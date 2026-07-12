# References — Work Shell Palette Hierarchy

Curated from the five prospecting dispatches. Each entry names its source prospector.

## Color (color-prospector)

### R0 — Existing UncleCode `W_DARK`/`W_LIGHT` codebase palette
- **Source:** `packages/tui/src/work-shell-view.tsx` (lines 71-127) — the existing dark/light palette in the UncleCode TUI codebase.
- **Prospector:** color-prospector (cross-verified during the contrast-courage analysis)
- **Contribution:** The "retained existing" tokens that the design preserves unchanged: `text #e6edf3` (W_DARK.text, line 103), `border #30363d` (W_DARK.border, line 106), `borderSoft #21262d` (W_DARK.borderSoft, line 108), `borderAccent/user #92abdf` (W_DARK lines 109-110), `toolSurface/userBadgeBg #161b22` (W_DARK lines 113,117,120), `tool #9ece6a` (W_DARK.tool, line 119). These are the continuity anchors — the design de-collapses and re-ladders around them, but does not invent new base values where the existing ones are sound. The `#0d1117` surface.default is W_LIGHT.text (line 72) repurposed as the bg.

### R1 — Catppuccin Mocha (v1.8.0)
- **Source:** `catppuccin/palette` (canonical upstream), fetched via curl
- **Prospector:** color-prospector
- **Contribution:** The 4-tier foreground ladder template — `text #cdd6f4` → `subtext1 #bac2de` → `subtext0 #a6adc8` → `overlay1 #7f849c`. Plus the surface stack `base #1e1e2e` / `mantle #181825` / `crust #11111b`. This is the structural model for the `color.text` group.
- **Accent hues adopted:** `teal #94e2d5` (assistant), `green #a6e3a1` (success), `yellow #f9e2af` (warning), `red #f38ba8` (error), `peach #fab387` (spinner), `overlay0 #6c7086` (border strong).

### R2 — Tokyo Night
- **Source:** `folke/tokyonight.nvim` (canonical upstream)
- **Prospector:** color-prospector
- **Contribution:** The muted-tier contrast courage — `fg #c0caf5`, `comment #565f89`. The green family `#9ece6a`/`#73daca` de-collapses the old `#9ece6a×3`.

### R3 — GitHub Dark Default (Primer)
- **Source:** `primer/primitives` (canonical upstream)
- **Prospector:** color-prospector
- **Contribution:** The neutral ladder + functional token resolution proof. Validates the approach: `fgColor.default → neutral.12`, `fgColor.muted → neutral.9`, borders split into ~1.57:1 default + ~3.57:1 emphasis. Confirms de-collapsing green across `green.3/4/5` is the right call.

### R4 — btop Tokyo-Night theme
- **Source:** btop theme config (fetched via curl by layout-prospector)
- **Prospector:** layout-prospector + color-prospector
- **Contribution:** Empirical proof that `inactive_fg #565f89` (+31 lightness pts) works as BOTH the divider color AND the muted-text tier. The single-token-carries-all-structure pattern.

## Typography (type-prospector)

### R5 — Lazygit
- **Prospector:** type-prospector
- **Contribution:** 2-weight (regular/bold) panel discipline — bold for panel titles + active selection, regular for body, dim for meta. Confirms weight is boolean in TUI; sub-hierarchy must live on the color lightness ladder.

### R6 — JetBrains Mono weight ladder
- **Prospector:** type-prospector
- **Contribution:** Proof that only 400/700 weights are addressable in a terminal; the raised x-height is what makes bold-label-vs-regular-body scan. Informs the "no third weight" constraint.

## Layout (layout-prospector)

### R7 — Lazygit / yazi / btop divider discipline
- **Prospector:** layout-prospector
- **Contribution:** HSL lightness analysis proving UncleCode's `borderSoft #21262d` (+2.8 pts) is 6–10× too close to the bg. Every working reference lands at +16 to +40 pts. yazi's two-tier divider ladder (overlay1 `#7f849c` for rails, surface2 `#585b70` for intra-content) validates the `border.default` / `border.quiet` split.

## Motion (motion-prospector)

### R8 — cli-spinners / ora / nanospinner
- **Source:** `sindresorhus/cli-spinners` (canonical, fetched via curl)
- **Prospector:** motion-prospector
- **Contribution:** Confirms `dots` spinner = `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` @ 80ms — byte-for-byte UncleCode's existing set. No change needed.

### R9 — cargo / indicatif + aider
- **Prospector:** motion-prospector
- **Contribution:** Confirms meter default `█░` (indicatif) and the 500ms show-delay gate (cargo first-paint throttle + aider independently). Validates UncleCode's existing `WORK_SHELL_SPINNER_SHOW_DELAY_MS = 500`.

### R10 — btop meter ladder
- **Prospector:** motion-prospector
- **Contribution:** btop Tokyo-Night uses UncleCode's exact `#9ece6a`/`#e0af68`/`#f7768e` as a 3-tier green→amber→red meter ladder — independent validation of the ascending-urgency meter treatment adopted in the Application Guide.
