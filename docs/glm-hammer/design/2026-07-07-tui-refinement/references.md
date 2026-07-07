# References

Curated keepers from the four dimension prospectors. Every entry names which prospector supplied it. Full evidence at `.glm-hammer/evidence/design/prospect/*.md`.

## Color (color-prospector)

1. **GitHub Primer / GitHub Dark** — base `#0d1117`, text `#e6edf3`, muted `#7d8590`.
   Contrast: text 17.77:1, muted 5.63:1 on `#000`.
   *Why:* The gold-standard composed instrument; cool-neutral, high-contrast, the exact register the brief asks for.
   Source: GitHub Primer design tokens.

2. **Tokyo Night** — fg `#C0CAF5` on `#1A1B26`, desaturated semantics.
   *Why:* The antidote to the candy palette — proves muted-desaturated accents still read as lively without shouting.

3. **Catppuccin Mocha** — four-tier foreground ramp (Text → Subtext0/1 → Overlay0/1/2).
   *Why:* Supplies the text/textMuted/textDim separation with a principled ramp, not ad-hoc picks.

4. **Anthropic "Crail" `#D97757`** — single warm identity accent, 6.73:1 on `#000`.
   *Why:* Blueprint for the 2-accent system (one cool primary + one warm secondary). Proves a single brand hue carries identity better than four competing role colors.

## Typography (type-prospector)

1. **Claude Code TUI** (Jake Goldsborough Rust rewrite analysis) — full agent turn-loop with **zero bold in the chat body**. Roles distinguished by sentence-case label ("You") + color only.
   *Why:* Proves "weight + case do hierarchy, never decoration" is achievable and is exactly what top agent TUIs ship.

2. **gfargo/tui-design-skill** — canonical framework: bold = titles/selection/primary only; dim = metadata; reverse = cursor; clutter audit rule against costume-y nesting.
   *Why:* The enforcement discipline — names exactly what to strip from UncleCode's current glyph over-inventory.

3. **Ink** (the render layer) — entire text-style vocabulary is `{bold, italic, underline, inverse, dimColor, color}`. No numeric weight.
   *Why:* Constrains the token set to what the Ink renderer can actually emit; tokens must map to these props.

4. **Aider** — cleanest role→color token names (`user-input-color`, `assistant-output-color`, `tool-output-color`, `tool-error-color`).
   *Why:* Ready-made semantic naming for UncleCode's role tokens.

## Layout (layout-prospector)

1. **Claude Code statusline** (`code.claude.com/docs/en/statusline.md`) — dedicated status row ABOVE a separate footer badge row; "does not replace them." Named `padding` token, 2-line max, sparse single `|` separators.
   *Why:* Structural answer to UncleCode's cramped single-line status — split session/auth/activity into two rows.

2. **lazygit** (`Config.md`) — `sidePanelWidth: 0.3333` (⅓ panel / ⅔ main); single named `border` vocabulary; maintainer-quoted 4-char total border budget; `portraitMode` breakpoint at 84 cols.
   *Why:* Concrete panel/conversation split + the "border budget" discipline (count every border char — don't over-decorate).

3. **Helix** (`docs.helix-editor.com/editor.html`) — LEFT | CENTER | RIGHT statusline with CENTER empty by default (deliberate breathing slot), one `│` separator, fixed 3-char mode tokens.
   *Why:* The breathing-slot principle — an empty center column reads as composure, not missing content.

## Motion (motion-prospector)

1. **cli-spinners/ora** (canonical lib) — braille `dots` `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at **80ms**.
   *Why:* The ecosystem modal value; 80–100ms settled as "alive, not twitchy." UncleCode currently runs 100ms — tune to 80ms.

2. **Claude Code** — ONE spinner + one rotating verb; everything else static.
   *Why:* Directly validates the singular-indicator doctrine the user's "duplicate spinner" complaint demands.

3. **Aider** (`waiting.py`) — **500ms show-delay** before the spinner appears.
   *Why:* The highest-signal finding — kills the redundant-spinner complaint at the root by not animating until motion earns its place.

4. **Gemini CLI** (`GeminiSpinner.tsx`) — braille at 80ms **+ 4000ms rainbow color cycle**.
   *Why:* The cautionary anti-reference — ambient color motion IS the "costume" to reject. Confirms static status surfaces.

## User-provided references

None beyond the live TUI itself (the existing slate-based palette and the four reported visual bugs, captured in the vein-reader Direction Brief).
