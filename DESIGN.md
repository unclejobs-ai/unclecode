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
- Compact tool entries and reasoning summaries are first-class conversation content; dense trace detail (raw output, verbose expansion) stays in trace/context surfaces.

## 5. Components

### Work shell header

- Structure: provider title (left, bold) + right-aligned session facts `model · mode` (muted); one rule line below. An auth chip is appended to the facts only when auth is in a warning state.
- Default chrome carries no shortcut hint; an explicitly injected hint may still override the right side for tests and callers.
- Variants: default provider, auth warning chip, narrow terminal truncation (session facts drop first, then the title truncates).
- Spacing: `--space-2` inline gap, one divider row.
- States: default, auth warning, truncated.
- Accessibility: text must remain useful without color.
- Motion: none.

### Work shell status line

- Structure: idle-only single row directly below the header. Idle renders `◇ Ready · last Xs` alone (`◇ Ready` before reply timing exists); model/mode moved to the header.
- Busy placement: while a main turn or background agents/jobs are live, this row renders nothing — the busy display (spinner, activity phrase, elapsed, agent/job counts) is the composer dock's live activity row, pinned directly above the dock's hint row. One spinner per surface; a busy frame never paints both.
- Interrupted idle and queue paused are idle-class states (no turn active), so they keep the top row (`◇ Ready …`) alongside their composer hint copy.
- Variants: idle, interrupted idle, queue paused, narrow (model retained because the header dropped the facts).
- Spacing: inline separators with muted text; avoid repeating footer facts here.
- States: default, paused.
- Scope note: the pure formatter `formatWorkShellUsageLine` (`Ready · last reply 1.5s`, frozen by contract tests) is a separate usage-summary format, not the status-line assembly above.
- Accessibility: spinner is supplementary; text must carry the state.
- Motion: none here; the spinner lives in the dock's activity row.
- Busy detail: humanize file paths and raw tool names; keep specific progress phrases like `thinking inspect repo` when they add signal.

### Work shell footer

- Structure: cwd path plus one compact context chip when context is folded.
- Variants: default, narrow terminal truncation.
- Spacing: double-dot separators between cwd and context only.
- States: default, truncated.
- Accessibility: path and context counts remain readable without color.
- Motion: none.

### Conversation entry

- Structure: role badge and wrapped body; continuation lines use a quiet indent only — no repeated rail glyph (`▌`) spam.
- Variants: user, assistant compact, assistant expanded, system, tool call, reasoning summary.
- Spacing: one row between entries; user entries use `badge label · body` on the first line when short.
- States: default, streaming assistant, filtered orchestration noise.
- Accessibility: role labels are textual; color is not the only role signal.
- Motion: streaming cursor only when assistant text is live.
- Badge copy: do not append redundant `message` / `reply` suffixes beside role badges.
- System feedback: muted body (`text-muted`), dim glyph prefix, no standalone unstyled float.
- Tool entry: first rendered row `● <verb> <key argument>` (bold; status-success, or status-error when the tool failed); first result row `  ⎿ <summary>`, remaining result rows indented 4 spaces — all result rows text-muted. Verbs map read_file→read, write_file→write, run_shell→bash, search_text→search, apply_patch→patch; other tool names pass through. The key argument picks the display input's path, else command, else query.
- Tool entry detail: result rows carry the output metric (`N lines`, or the first error line when the tool failed), an output excerpt of at most 6 per-row-truncated lines, `+N −M` line stats only when the output contains a unified diff, and `· {ms}ms` duration on the last metric row. Rendered height is capped at 8 rows; overflow collapses into exactly one `… +N more lines` row per entry.
- Tool entry ownership: stored entry text is glyph-less plain rows — `<verb> <key argument>` first, then plain metric/excerpt rows. The renderer owns `● ` (first row) and `  ⎿ ` (first result row); glyphs appearing in both layers are a bug.
- Reasoning entry: one dim `✻ `-prefixed entry per turn, at most 6 rows, appended before that turn's assistant answer; it renders plain dim (text-muted) without markdown parsing. Live reasoning keeps churning on the dock activity row — the transcript keeps only the settled summary.
- Hidden transcript: live reasoning deltas (superseded by the settled `✻` summary), raw verbose trace lines, subtask JSON, worker meta, and internal turn routing lines stay out of the default conversation surface.

### Empty conversation

- Structure: ASCII wordmark (dim, width-gated) → heading → starter prompts → hint line; one concise explanation line sits between the heading and the starters, one opener hint row closes the block.
- ASCII wordmark: figlet-standard `unclecode` block, single dim color, rendered only when the conversation container fits the art width plus two columns of margin each side — narrower terminals skip the art and keep the text-only block.
- Starter prompts: three example tasks as `1 …`/`2 …`/`3 …` rows (number in assistant accent, body muted); keys `1`-`3` prefill the composer with the matching prompt.
- Opener hint row: `/ commands · @ attach a file · ! shell · ? keys` (single dim line, wraps naturally at narrow widths).
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

- Structure: live activity row (busy only), dim live trace feed (busy only), hint row (accent follows state: user slash, assistant busy, warning queue), unlabeled soft divider (pure `─` rule above the input area, no label text), `›` input prefix, footer context row (cwd + one chip).
- Live activity row: while a main turn or background agents/jobs are live, the row directly above the hint carries `⠙ <activity phrase> · <elapsed>` plus `N agents · M jobs` when delegated work is meaningful — the busy display the top status row used to own. Idle frames render no activity row (and no spinner glyph anywhere).
- Live trace feed: while busy, up to three dim `→ …` progress lines (dock-width truncated) sit between the activity row and the hint row, sourced from the always-on `liveTraceLines` state — the feed renders in every trace mode, default and `/minimal` included; idle frames render no feed. Deep trace expansion stays with the context overlay.
- Placeholder: empty input renders a dim ghost placeholder (`Describe a task · / for commands`) that disappears as soon as typing starts.
- Variants: default, slash command accent, secure entry, attachment count, queue paused hint, parallel busy accent, busy live activity row, busy live trace feed.
- Spacing: one activity row and up to three trace feed rows (busy only) above one hint row, one prompt row, one footer row; no double border above/below input.
- States: default, focus by input, secure input, attachment cap warning, queued, busy.
- Accessibility: hints must expose keyboard actions.
- Motion: single spinner in the activity row, only while busy; never duplicated elsewhere.

### Decision bar

- Structure: `◆` glyph plus title (fallback `Decision required`) directly above the composer dock while a decision is pending.
- Single question: numbered options with the `(recommended)` marker when present, plus hint `1-N answer · Esc cancel · or type`.
- One-key answer: `1`-`9` submits the matching option, `Esc` cancels; typing a full answer stays valid.
- Multi-question: one compact line `◆ <title> · N questions · type answers · /cancel`; no one-key binding.
- Variants: single question, multi question.
- Spacing: one row above the composer dock; replaces the passive decision panel for that frame (option lines render exactly once).
- States: pending, answered, cancelled (the bar disappears once the decision settles).
- Accessibility: options carry textual numbers; color is never the only signal.
- Motion: none.

### Dashboard panels

- Structure: rounded panel, thin divider, status dots, key/value rows.
- Variants: Work, History, MCP, Research, approval, empty sessions.
- Spacing: display-width safe borders, one row between major groups.
- States: idle, running, queued, completed, requires action, empty, error.
- Accessibility: status labels accompany colored dots.
- Motion: spinner only for active work.

### Work shell keys

Single-character shortcuts for discovery and pending decisions. They fire only while the composer is empty, no overlay, desk, console, or slash picker is open, and the composer is not in secure entry; otherwise the character is typed. Ctrl-combos always keep their global bindings. The transcript scrollback keys are the one non-character exception: `PageUp`/`PageDown` are not print keys, so they also work with a draft in the composer, and an overlay that pages on its own (the Context Desk) keeps its meaning while it is open.

| Key | Context | Action |
| --- | --- | --- |
| `?` | Default chrome | Opens the `/help` panel |
| `1`-`3` | Empty conversation | Prefills the composer with starter prompt N |
| `1`-`9` | Decision bar (single question) | Answers with option N |
| `Esc` | Decision bar | Cancels the pending decision |
| `PageUp`/`PageDown` | Transcript longer than the window | Scrolls the transcript one visible window, measured in entries weighted by rendered rows so multi-row tool entries page accurately (no-op at the top/bottom or on a short conversation); a dim `↑ N entries above · PageUp/PageDown scroll · Esc newest` row marks the transcript/dock boundary while scrolled |
| `Esc` | Transcript scrolled up | Returns to the newest entry (added to Esc's other meanings — interrupt, overlay close, and decision cancel still win) |

## 5.1 Region show/hide matrix

Default work shell: show answers, compact tool entries, and reasoning summaries as first-class transcript content; hide orchestration noise. `/verbose` keeps its deep-trace expansion in the context overlay — the conversation rail carries compact entries only.

| Region | Show (default) | Hide (default) | Notes |
| --- | --- | --- | --- |
| **Header** | Provider title (bold), right-aligned `model · mode` facts (muted), auth chip on warning, divider | Default shortcut hint, duplicate model/mode/auth in status or footer | Facts drop first when narrow |
| **Status strip** | Idle `◇ Ready · last Xs` alone (interrupted idle / queue paused stay here — no turn active) | The entire row while busy (moved to the composer dock activity row), `model · mode` and auth label (moved to the header), raw file paths, duplicate spinners | Top row is idle-only; busy lives above the composer hint |
| **Conversation** | User messages, final assistant synthesis, streaming partial text, compact tool entries (`● verb …` + `⎿` result summary, 8-row cap), reasoning summary (`✻`, one per turn, max 6 rows), `policy.denied` (minimal) | Live reasoning deltas (the settled `✻` entry replaces them), raw verbose trace lines, subtask JSON, worker meta, internal routing | User: `◇ You · body`; assistant: badge + quiet indent; tool and reasoning entries render in every trace mode; verbose depth lives in the context overlay |
| **Empty state** | Ready heading, concise explanation, starter prompts `1`-`3`, opener hint row `/ commands · @ attach a file · ! shell · ? keys` | Orphan chrome, non-actionable filler | Starter keys prefill the composer |
| **Composer** | Busy: live activity row (spinner + elapsed + agent/job counts) plus a dim `→ …` live trace feed (max 3 lines, dock-width truncated, from `liveTraceLines` in every trace mode including default and `/minimal`) directly above the hint row; hint row, ghost placeholder, unlabeled soft divider, `›` prefix, cwd · context chip footer | Activity row and trace feed while idle (idle screens carry no spinner glyph), raw paths in hints, double borders, divider label text | Tint follows slash / busy / queue state |
| **Footer** | cwd + one context chip | Model, mode, auth repetition | Never duplicate status strip |
| **Slash picker** | Matching commands + Korean descriptions for `/context`, `/mode` | Unrelated commands | Selected row uses user accent + bold |
| **Context overlay** (`/context`, `/verbose`) | Sources fact line, included/excluded/warning groups, trace lines when verbose | Full raw configs, duplicate conversation entries | 64-char summary truncation; verbose-only deep expansion of tool traces (the rail keeps compact entries) |
| **Dashboard panels** | Session Center facts when navigated | Passive while composing | Not mixed into chat rail |

Implementation reference: `packages/tui/src/work-shell-view.tsx`, `work-shell-panels.ts`, `work-shell-engine-turns.ts` (sanitization).

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

### Rendering stability

- Frames render incrementally by default: keystrokes and streaming updates repaint only changed rows; unchanged rows are never re-emitted.
- Resize handling is asymmetric by design: a full clear and repaint runs only when the terminal shrinks (rows or columns decrease); growth reflows via incremental relayout with no clear.
- The keystroke path must not spawn processes synchronously — no synchronous width/wrap subprocess calls while typing.
- Settled transcript entries are never re-parsed while a later entry streams; markdown rendering is cached by text, width, and theme.

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
- Tool traces are first-class transcript entries in compact form (`●` call line, `⎿` result rows); diagnostic depth — raw output and verbose expansion — stays in the context overlay.
- Empty, loading, and error states must be intentionally composed, never blank areas.

## 8. Korean product copy (우리)

Operator-facing Work Shell copy uses Korean for modes, guards, and slash hints. Internal mode ids stay English for config/tests.

| Surface | Rule | Owner |
| --- | --- | --- |
| Status/footer mode chip | `mode_label` (`mode.rs`) is the label source; `ux_text.rs` and the TS footer call the Rust runtime path | `rust/unclecode-core/src/mode.rs`, `rust/unclecode-core/src/ux_text.rs`, `packages/tui/src/work-shell-footer-fast-paths.ts` |
| `/mode` slash descriptions | Korean one-line behavior hint per profile | `packages/orchestrator/src/work-shell-slash.ts` |
| Read-only guards | Korean rejection before turn (`search`, `plan`) | `rust/unclecode-core/src/prompt_turn.rs` |
| Busy/detail strings | Korean humanization for orchestrator traces in status only | `ux_text.rs` |
| Model/auth labels | English compact chips OK (`Saved OAuth`, model id) | `ux_text.rs` |

Do not mix EN mode names (`Parallel mode`, `Work mode`) in operator-visible paths. Prefer **집중 작업 모드** for `ultrawork`, not "Parallel mode".
