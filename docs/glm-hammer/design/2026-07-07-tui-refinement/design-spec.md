# UncleCode TUI Design Spec — Instrument, Not Costume

## Story & Direction

The user called the current TUI **"짜치니깐"** (lame/ugly) and asked for **"세련되게"** (refined/sophisticated). Four concrete failures: typed input invisible on black backgrounds, duplicate competing spinners, an opaque "oauth blocked" label, and general design noise. The vein the vein-reader struck:

> **An instrument, not a costume.** UncleCode should feel like a composed, trustworthy, instrument-grade terminal tool — cool, high-contrast, low-saturation, with motion that barely moves and labels that state meaning plainly.

Mood keywords: **composed, precise, quiet, instrument-grade, legible.**

The defining discipline is **restraint** — fewer accent hues (4→2), one animated element system-wide, weight+case (not decoration) for hierarchy, and every text token carrying an explicit contrast-verified color so nothing ever vanishes on dark backgrounds again.

## References

Curated from four prospectors (full receipts in `.glm-hammer/evidence/design/prospect/`):

- **Color:** GitHub Primer Dark (`#0d1117`/`#e6edf3`/`#7d8590`), Tokyo Night (muted-desaturated semantics), Catppuccin Mocha (4-tier fg ramp), Anthropic Crail `#D97757` (single warm accent blueprint).
- **Type:** Claude Code (zero bold in chat body), gfargo/tui-design-skill (bold = titles/selection only + clutter audit), Ink renderer vocabulary constraint, Aider (role→color token naming).
- **Layout:** Claude Code statusline (dedicated row above footer badge row), lazygit (⅓ panel split + border budget), Helix (empty-center breathing slot).
- **Motion:** cli-spinners/ora (braille at 80ms), Claude Code (one spinner + one verb), Aider (500ms show-delay), Gemini CLI (anti-reference: rainbow cycle = costume).

See `references.md` for the full annotated list.

## Token Rationale

### Color
The original invisible-input bug was structural (typed text had no explicit color → terminal-default fallback), not a value problem. The fix: **every readable token carries an explicit, contrast-verified hex.**

- **`text.default #e6edf3`** (17.77:1 on `#000`) — from GitHub Primer. The highest-contrast near-white that avoids pure `#ffffff` glare. Primary foreground for all content including composer input.
- **`text.muted #a6adc8`** (9.43:1) — from Catppuccin Mocha's subtext tier. Panel labels, meta lines. Comfortably above the 4.5:1 floor. *(Coincidence, documented for future engineers: `text.muted` and `border.strong` share `#a6adc8`. Different group/intent — muted is foreground, strong is chrome. Do not "fix" one without the other.)*
- **`text.dim #7d8590`** (5.63:1) — from GitHub Primer. Hints, footers, the quietest readable tier. At the 3:1 muted/large threshold; named `dim` so it's clear it's AA-large only.
- **`surface.default #000000`** — true black, the OLED/common-dark assumption. The contrast baseline all text tokens are verified against.
- **`surface.raised #0d1117`** — GitHub Primer canvas (Ref 1); panels/header bars that lift off the base.
- **`surface.sunken #1a1b26`** — Tokyo Night base (Ref 2); composer well / inset regions.
- **`text.inverse #0d1117`** — GitHub Primer canvas, for text on light/accent backgrounds (cursor row highlights, badges).
- **`accent.primary #92abdf`** (desaturated from Tokyo Night blue `#7aa2f7`, 9.11:1 on `#000`) — replaces the old user-blue `#60a5fa`. H=220.8° kept (cool), saturation pulled from S=88.7% to S=55% per the harmony-critic finding that the most-used accent must not be the loudest value. Now sits under the warm secondary's chroma (S=63%), delivering the brief's "low-to-medium saturation / desaturated, not candy" stance. Used for: user role, active selection, interactive accents.
- **`accent.secondary #d97757`** (Anthropic Crail, 6.73:1) — the warm identity hue. Used for: spinner, "busy" glyph, brand touchpoints. Replaces teal `#5eead4` which was too candy-bright.
- **`role`** — derived: user=primary, assistant=text.default (assistant is the "voice," doesn't need a hue), tool=success-green, system=warning-amber. This collapses the old 4-way blue+teal+lime+amber shouting match: assistant now uses plain text color (instrument reads in default), and tool/system inherit semantic hues.
- **`semantic`** — success `#9ece6a` (S=51%), warning `#e0af68` (S=66%), danger `#e28b9b` (desaturated from `#f7768e` to S=60%, 8.40:1). All from Tokyo Night's set, with danger pulled down from S=89% so it no longer reads as the hottest token next to the primary. Lower saturation than the old `#86efac`/`#fcd34d`/`#fca5a5` — composed, not candy.
- **`border`** — default/strong/soft form a 3-tier ramp (`#30363d`/`#a6adc8`/`#21262d`). `#30363d` and `#21262d` are GitHub Primer's border/border-subtle values (color-prospector Ref 1); soft `#21262d` is deliberately dim so rules recede. Borders are non-text and intentionally sit below 3:1 contrast — that's correct for chrome, not a failure.

### Typography
Size is fixed by the terminal cell — "scale" is re-expressed as **weight × case × tone** (the one brief conflict, flagged by the type-prospector: numeric font-size can't be honored in a terminal).

- **`weight.regular 400` / `weight.emphasis 700`** — Ink exposes only bold (700), no numeric weights. Per gfargo/tui-design-skill and Claude Code: **bold appears in exactly 2 places** — panel headers (UPPERCASE) and active selection. Never in chat body or role labels.
- **`case.label sentence`** — role labels are sentence-case ("You", not "USER:"), per Claude Code. Avoids the cosplay/shouty register.
- **`case.header upper`** — panel headers go UPPERCASE with a `▸` prefix or `── LABEL ──` rule-set label, the gfargo convention for section hierarchy.
- **`glyph.railSoft ▏`** — unified to ONE rail character (softest, what Glow/Posting use) for role rails, replacing the old three-rail `│┃▏` system. `│` reserved for real borders only.

### Spacing
From lazygit's border-budget discipline and Textual's spacing-token grammar:

- **`padX 2`** — horizontal padding inside blocks (up from 1, gives breathing room).
- **`gutter 1`** — between rail and content.
- **`sectionGap 1`** — vertical margin between header/status/conversation. Kept tight (1 row) to preserve conversation real estate.
- **`indent 2`** — nested content indent.
- **`statusPadX 2`** — status bar padding, matching padX for consistency.

### Radius
- **`radius.panel 0`** — sharp single-line borders, no faux rounded depth. The layout-prospector flagged lazygit's default `rounded` as reading soft against the "flat" stance; we choose `single` sharp borders. This is a deliberate conflict resolution (rounded → sharp).

### Motion
The user's "duplicate spinner" complaint is the spine of this group.

- **`spinnerInterval 80ms`** — tuned from 100ms to the cli-spinners/ora modal value (what Claude Code and Gemini both ship). "Alive, not twitchy."
- **`spinnerShowDelay 500ms`** — the Aider finding. The spinner does not appear for the first 500ms of any operation. This kills redundant-spinner noise at the root: short operations show nothing; the spinner only earns its place when the user would actually wonder "is this stuck?"
- **`cursorBlink 0ms`** — the streaming cursor `▌` is **static**. A blinking cursor is a second animated element and violates "one indicator max."
- **`transition 0ms`** — instant glyph swaps. Terminal instruments do not ease; state changes are immediate. Status surfaces are always static.

## Application Guide

Tokens applied to concrete UncleCode TUI component treatments:

### Header block
- Provider title: `text.default`, `weight.emphasis` (bold). Hint: `text.dim`. One `rule` thin line below in `border.soft`. Drops the old "prompt deck" label in favor of a semantic mode label.

### Status bar (was: dense single line)
Split into TWO rows per Claude Code's statusline model:
- **Row 1 (status):** `glyph` status indicator (static `◇` ready / `֎` busy in `accent.secondary`) + session group (`model · mode`) in `text.muted` `weight.regular`. One `│` separator (Helix sparse style).
- **Row 2 (context):** auth group + activity/timing. Auth warning states render in `semantic.warning`; healthy states in `text.dim`. **No animated spinner here** — the status surface is always static.

### Conversation entries
- **User:** `accent.primary` `│` rail + `text.default` body. Sentence-case label, `weight.regular` (not bold — Claude Code discipline).
- **Assistant:** `role.assistant` (= `text.default`) — no rail hue, the assistant IS the default voice. Markdown rendered with heading/bold/code tokens from the palette. `weight.regular` body.
- **Tool:** `semantic.success` `▏` rail + `text.muted` body.
- **System:** `semantic.warning` `◌`/`✓` glyph + `text.muted` italic body.

### Composer dock
- Prompt glyph `›` in `accent.primary` (`weight.emphasis`). **Input text in `text.default` with explicit `#e6edf3`** — this is the original bug fix made structural via token.
- Hint line: `text.dim`. Divider rules: `border.soft`.
- Footer: `text.dim`, path compacted via `~`/`…`.

### Activity indicator (the single animated surface)
- ONE braille spinner at `motion.spinnerInterval` (80ms) in `accent.secondary`, with a `motion.spinnerShowDelay` (500ms) gate. No competing activity-type icons (the old 7-glyph `ACTIVITY_META` table is removed). Label in `text.default` `weight.emphasis`. This is the only animated element in the entire UI.

### Context/auth panels
- Section divider: `── LABEL ──` rule-set label, `case.header` (uppercase) in `text.muted`, `weight.emphasis`.
- Source lines: one icon + category in `accent.primary`, count in `text.default`, detail in `text.muted`. Budget the glyphs (the clutter audit).

## Fidelity Notes

- **Every color token traces to a prospected reference** (see `references.md` and the prospector receipts). No invented hexes. Contrast ratios were computed against `#000` and noted where a token sits at the AA-large threshold (`text.dim` at 5.63:1).
- **The 4→2 accent reduction** is a deliberate design decision grounded in the Anthropic-Crail single-accent blueprint and the brief's "fewer, muted role accents" directive. It is NOT a gap — `role.assistant` intentionally maps to `text.default` (the instrument reads in default color; the assistant is the voice, not a colored tag).
- **`radius` group** is present but minimal (one token, value 0) because the terminal is a flat grid. The layout-prospector's "rounded → sharp" conflict resolution is documented in the Token Rationale.
- **Typography "scale/ratio"** is re-expressed as weight×case×tone because terminals use fixed cell sizes — this is the one un-honor-able brief concept, flagged honestly by the type-prospector, not papered over.
- **`motion.transition 0ms`** is a doctrine statement (instant swaps) more than an animated duration; terminal instruments don't tween. It exists as a token so the principle is machine-readable, not advisory.
