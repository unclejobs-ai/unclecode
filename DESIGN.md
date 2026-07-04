# UncleCode Design System

## 1. Atmosphere & Identity

UncleCode is a calm command desk for agentic work: quiet by default, explicit when risk or progress matters, and dense only at the edges where operators need control. The signature is "ink on structured paper": terminal-native panels with strong readable typography, cool slate borders, and restrained teal/sky accents that separate user intent, assistant output, tools, warnings, and queue state without loud chrome.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
| --- | --- | --- | --- | --- |
| Surface/primary | `--surface-primary` | `#ffffff` | `#0f172a` | Main terminal background assumption and plain text surfaces |
| Surface/secondary | `--surface-secondary` | `#f8fafc` | `#1e293b` | Dashboard panels and quiet grouped areas |
| Surface/info | `--surface-info` | `#dbeafe` | `#082f49` | User badge and session header accents |
| Surface/success | `--surface-success` | `#dcfce7` | `#052e16` | Running/completed status backgrounds |
| Surface/warning | `--surface-warning` | `#fef3c7` | `#451a03` | Requires-action and warning backgrounds |
| Surface/error | `--surface-error` | `#fee2e2` | `#450a0a` | Error badges and destructive feedback |
| Text/primary | `--text-primary` | `#0f172a` | `#f8fafc` | Main body, command output, assistant replies |
| Text/secondary | `--text-secondary` | `#1e293b` | `#e2e8f0` | Headers and stronger metadata |
| Text/muted | `--text-muted` | `#334155` | `#cbd5e1` | Hints, dividers, less important context |
| Text/faint | `--text-faint` | `#475569` | `#94a3b8` | Footers and tertiary labels |
| Border/default | `--border-default` | `#334155` | `#64748b` | Primary TUI dividers |
| Border/strong | `--border-strong` | `#1e293b` | `#cbd5e1` | Active panels, empty-state frames |
| Accent/user | `--accent-user` | `#075985` | `#7dd3fc` | User intent, selected commands, focus accents |
| Accent/assistant | `--accent-assistant` | `#115e59` | `#5eead4` | Assistant identity and progress accents |
| Accent/tool | `--accent-tool` | `#365314` | `#bef264` | Tool-only diagnostics when trace surfaces are explicit |
| Status/success | `--status-success` | `#166534` | `#86efac` | Running or completed status text |
| Status/warning | `--status-warning` | `#713f12` | `#facc15` | Warnings, paused queue, requires action |
| Status/error | `--status-error` | `#991b1b` | `#fca5a5` | Errors and failed operations |
| Status/info | `--status-info` | `#075985` | `#7dd3fc` | Informational state |

### Rules

- Keep the product in a cool slate/teal/sky palette. Do not add purple-blue AI gradients or orange chrome.
- Use one semantic accent at a time in a row: user sky, assistant teal, tool olive, warning amber, or error red.
- Every new color must be added here before code uses it.
- Contrast must remain readable on light terminal backgrounds because many operators run white or transparent terminals.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
| --- | --- | --- | --- | --- | --- |
| TUI/title | terminal cell | bold | 1 row | normal | Provider title, major section labels |
| TUI/body | terminal cell | regular | 1 row | normal | Conversation and panel content |
| TUI/label | terminal cell | bold or semibold | 1 row | normal | Badges, facts, selected commands |
| TUI/caption | terminal cell | regular | 1 row | normal | Footer, hints, muted context |
| TUI/code | terminal cell | regular | 1 row | tabular by terminal | Paths, commands, ids, counts |

### Font Stack

- Primary: terminal font chosen by the operator. The interface must not assume proportional metrics.
- Mono: terminal font chosen by the operator. All layout math uses display width, not JavaScript string length.
- Serif: none.

### Rules

- Treat Korean, CJK, emoji-width glyphs, and box drawing characters as first-class display-width cases.
- Use bold for hierarchy, not excessive boxes.
- Avoid long all-caps labels. Prefer concise sentence case or short role labels.

## 4. Spacing & Layout

### Base Unit

Terminal spacing is row/column based. Map spacing to a 4px mental model for cross-surface consistency.

| Token | Value | TUI equivalent | Usage |
| --- | --- | --- | --- |
| `--space-1` | 4px | 0 to 1 column | Tight icon-to-label spacing |
| `--space-2` | 8px | 1 column | Inline separators and command facts |
| `--space-4` | 16px | 1 row or 2 columns | Standard panel padding |
| `--space-6` | 24px | 1 to 2 rows | Separation between transcript blocks |
| `--space-8` | 32px | 2 rows | Major panel/composer separation |

### Grid

- Work shell uses a single-column stack by default.
- Side panels may occupy about one third of the terminal only when there is enough width.
- Composer stays anchored near the bottom with status and footer context close to input.
- Width-dependent layout must use display-width helpers and terminal column checks.

### Rules

- Do not use raw string length for visual centering or truncation.
- Do not let passive panels crowd the composer while the user is typing.
- Dense trace/tool details belong in context/trace surfaces, not the main conversation.

## 5. Components

### Work shell header

- Structure: provider title, shortcut hint, strong divider.
- Variants: default provider, narrow terminal truncation.
- Spacing: `--space-2` inline gap, one divider row.
- States: default, truncated.
- Accessibility: text must remain useful without color.
- Motion: none.

### Work shell status line

- Structure: grouped facts — session (`model · mode`), auth, activity — separated by muted `│`.
- Variants: idle, busy, interrupted idle, queue paused.
- Spacing: inline separators with muted text; avoid repeating footer facts here.
- States: default, loading/busy, paused, warning.
- Accessibility: spinner is supplementary; text must carry the state.
- Motion: single spinner only while busy. Never duplicate activity spinners elsewhere.

### Work shell footer

- Structure: cwd path plus one compact context chip when context is folded.
- Variants: default, narrow terminal truncation.
- Spacing: double-dot separators between cwd and context only.
- States: default, truncated.
- Accessibility: path and context counts remain readable without color.
- Motion: none.

### Conversation entry

- Structure: role badge and wrapped body; rail color carries role identity on the first body line only.
- Variants: user, assistant compact, assistant expanded, system, tool diagnostics.
- Spacing: one row between entries; continuation lines use a quiet indent without repeating the rail glyph.
- States: default, streaming assistant, filtered tool trace.
- Accessibility: role labels are textual; color is not the only role signal.
- Motion: streaming cursor only when assistant text is live.
- Badge copy: do not append redundant `message` / `reply` suffixes beside role badges.
- System feedback: muted body (`text-muted`), dim glyph prefix, no standalone unstyled float.

### Empty conversation

- Structure: framed ready state, one concise explanation, three action hints.
- Variants: default, narrow terminal wrapped layout.
- Spacing: `--space-4` internal padding equivalent.
- States: empty.
- Accessibility: hints must describe real commands or direct user actions.
- Motion: none.

### Panel and overlay

- Structure: section divider, line-classified content, optional border for overlay.
- Variants: bottom drawer, side panel, overlay, hidden passive panel.
- Spacing: one row before panel; compact line groups inside.
- States: loading, empty, warning, error, no-match, selected command.
- Accessibility: fact lines use labels and values, not color alone.
- Motion: none.
- Context expanded: lead with the `Sources · …` fact line; group rows use `label · count · one-line summary` with 64-char truncation; hidden-group notices stay on one trailing line per section.

### Composer dock

- Structure: muted prompt-deck divider, `›` input prefix, footer context row.
- Variants: default, slash command accent, secure entry, attachment count, queue paused hint.
- Spacing: one hint row above, one prompt row, one footer row; no double border above/below input.
- States: default, focus by input, secure input, attachment cap warning, queued.
- Accessibility: hints must expose keyboard actions.
- Motion: none.

### Dashboard panels

- Structure: rounded panel, thin divider, status dots, key/value rows.
- Variants: Work, History, MCP, Research, approval, empty sessions.
- Spacing: display-width safe borders, one row between major groups.
- States: idle, running, queued, completed, requires action, empty, error.
- Accessibility: status labels accompany colored dots.
- Motion: spinner only for active work.

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
| --- | --- | --- | --- |
| Terminal spinner | 100ms frame step | discrete | Busy status only |
| Keyboard feedback | immediate | none | Input, selection, interrupt |
| Panel transition | immediate | none | TUI panel swap |

### Rules

- TUI motion is intentionally sparse. State changes should be legible, not cinematic.
- Use one spinner per surface. Duplicated spinners are a bug.
- Interrupt and cancel must update visible state immediately even if provider cleanup finishes later.
- Preserve reduced-motion friendliness by avoiding decorative animation.

## 7. Depth & Surface

### Strategy

Use mixed terminal-native depth: borders for structure, tonal badges for role identity, and whitespace for hierarchy. Do not add shadow metaphors to terminal UI.

| Layer | Treatment | Usage |
| --- | --- | --- |
| Base | plain text on terminal background | Conversation body and normal panels |
| Structured | slate divider or rounded border | Header, overlay, empty state, dashboard panels |
| Role identity | tinted text/background badge | User, assistant, status, auth, attachments |
| Warning/error | amber/red text plus explicit label | Auth issues, paused queue, failed commands |

### Rules

- Borders are structural, not decorative. Avoid boxing every message.
- Tool traces are diagnostic depth and should stay out of the main transcript unless explicitly requested.
- Empty, loading, and error states must be intentionally composed, never blank areas.
