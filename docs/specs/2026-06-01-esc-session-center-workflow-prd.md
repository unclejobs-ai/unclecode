# ESC Session Center Workflow PRD

> Date: 2026-06-01
> Status: Draft from current implementation audit
> Scope: `Esc`/session-center shell, Work, History, MCP, Research tabs, and the workflow between them

## Problem

The work-first TUI has the right strategic shape: the user starts in the real work shell, then presses `Esc` or opens `/sessions` to inspect operational context without losing the active work session. Current implementation only partially realizes that shape.

The UI has four named tabs: `1 Work`, `2 History`, `3 MCP`, and `4 Research`. Work is capable of rendering the embedded work pane, but the other tabs are mostly summaries plus command hints. The result is a shell that exposes the right nouns but does not yet make each page feel like a coherent workflow surface.

## Goals

- Make `Esc` feel like a live command center, not a detached launcher.
- Preserve the work-first principle: `Work` remains the primary place to type tasks and see agent output.
- Give each tab a clear job, visible state, available actions, and recovery path.
- Keep all displayed state honest. Do not show fake worker, token, cost, or reasoning details.
- Support keyboard-first operation with predictable shortcuts and no accidental exits.
- Make page behavior testable with contract tests before adding more visual complexity.

## Current Implementation Evidence

| Surface | Current evidence | What it proves |
| --- | --- | --- |
| Tab model | `VIEW_TABS` declares `Work`, `History`, `MCP`, `Research` in `packages/tui/src/dashboard-components.tsx`. | The four-page information architecture already exists. |
| ESC handoff | `dashboard-shell.tsx` returns from `sessions` to `work` on `Esc` when no detail/approval is open. | Escape is currently a back-to-work gesture, but only in the History view. |
| Work page | `shouldRenderEmbeddedWorkPaneFullscreen("work", true)` delegates the active `work` tab to the embedded work pane, and `createEmbeddedWorkShellPaneDashboardProps()` forwards `openSessions` as `onRequestSessionsView`. | Work can be real, and embedded Work can request the command center on `Esc`. |
| History page | `SessionList`, `buildHistoryContextSummaryLines`, and `runSession`/`openWorkPane(["--session-id", id])` wire saved sessions to resume actions. | Resume workflow exists, but the page is limited to six sessions and shallow detail. |
| MCP page | `McpServerList` renders the page's primary column and `DetailPanel` renders `mcpServerCount`, selected server metadata, up to four `mcpServers`, `unclecode mcp list`, and `unclecode mcp inspect <server>`. | MCP inventory is page-native, selected-server inspect is actionable, and health remains explicitly unchecked. |
| Research page | `ResearchRunList` renders recent ledger runs, `shouldOpenResearchPromptLane()` opens prompt entry directly from the Research page, and `DetailPanel` renders latest research session, run count, timestamp, selected run, summary, and prompt entry. | Research has a page-native run list and prompt lane, while execution still reuses the existing `new-research` action runner. |
| Data source | `buildTuiHomeState()` loads sessions, MCP registry, research ledger, bridge lines, and memory lines. | The shell has enough source data to make richer pages without inventing state. |

## User Requirements

1. `Esc` from work opens a useful command center preserving the live work context.
2. `Work` page must show the current work session or resume/start a work session without process confusion.
3. `History` page must make saved sessions understandable and resumable.
4. `MCP` page must show configured servers and how they affect work/research.
5. `Research` page must show prior research and support starting a new research run.
6. Every page must expose visible keyboard actions and expected result states.
7. The design must be grounded in current code, with clear implementation gaps.

## Information Architecture

### Global Shell

Persistent elements:
- Header: app name, workspace, git branch, dirty/clean status.
- Tabs: `1 Work`, `2 History`, `3 MCP`, `4 Research`.
- Status line: current workflow state, approval state, active worker count, mode, auth.
- Inspector: contextual right-side panel for selected item or page-level summary.
- Footer: available shortcuts for the active page.

Global shortcuts:
- `1` opens Work.
- `2` opens History.
- `3` opens MCP.
- `4` opens Research.
- `Esc` closes current detail first. If no detail is open, returns to Work. If already in Work, it opens History/session center.
- `Tab` or left/right arrows move between list and action columns where applicable.
- `Enter` runs the selected primary action.
- Uppercase action keys run immediately when safe, matching current `W`, `B`, `K`, `L`, `R`, `M`, `D` behavior.

### Work Page

Job:
- Keep the real assistant session in focus.
- Show live turn state without duplicating generic reasoning noise.
- Provide a quick route into History when the user presses `Esc`.

Visible state:
- Current model, mode, auth, reasoning support.
- Current input/composer.
- Live assistant output.
- Specific progress only, for example `thinking inspect repo`; generic `thinking` should remain in the header/status, not repeated in the transcript.
- Recent operational signal only if it helps recover a running/blocked turn.

Primary actions:
- Type and submit a task.
- `/sessions` or `Esc` opens the command center.
- `/mcp`, `/research`, `/status`, `/context` can deep-link to the corresponding page or panel.

Acceptance criteria:
- `Work` tab with embedded pane gives input focus to the work shell.
- `Esc` from Work opens the session-center shell without losing active state.
- Generic provider reasoning deltas like `thinking` are suppressed from transcript display.
- Specific reasoning/progress deltas remain visible.
- No fake cost/token metrics are shown.

Current gaps:
- `shouldCaptureDashboardInput("work", true)` correctly yields input to the embedded pane; `Esc` forwarding is now covered by contract through `onRequestSessionsView`.
- Work page is full-screen when embedded; it does not show the four tabs alongside the composer.
- There is no page-level visual reminder that `Esc` opens History/session center when inside embedded Work, except header copy.
- Top-level `Esc` from History, MCP, and Research returns to Work; embedded Work forwards `Esc` to `openSessions` unless a local overlay/sensitive input consumes it first.

### History Page

Job:
- Resume prior work or research sessions with enough context to choose correctly.
- Explain what will happen before a session resumes.

Visible state:
- Saved session list with state, model, updated time, branch, mode, pending action, summary.
- Context availability: workspace guidance, bridge summaries, memory notes.
- Resume target command or embedded resume behavior.
- Last activity/result from the session center.

Primary actions:
- `Enter` on a `work-*` session opens Work with `--session-id`.
- `Enter` on a non-work session uses `runSession()` to show resume summary.
- `W` starts/opens Work.
- `R` opens Research prompt flow.

Acceptance criteria:
- Empty state explains `Press W to start work`.
- History never exits the shell on a resumable work session when an embedded pane/controller is available.
- Detail panel states whether resume will open Work or only show a summary.
- `Esc` from detail closes detail; `Esc` from page returns to Work.

Current gaps:
- Session list is capped at six items without search/filter.
- Non-work session resume is summary-only; it does not open a dedicated Research replay.
- Detail copy says `Enter resume · Esc work` even when `Esc` only closes detail first.

### MCP Page

Job:
- Show what MCP servers are available, where they came from, and whether they are trusted enough for current work.
- Make MCP operational status actionable from the command center.

Visible state:
- Server count.
- Server list with name, transport, scope, trust tier, origin label.
- Config source: project `.mcp.json`, user `~/.unclecode/mcp.json`, extension overlay if applicable.
- Health/status per server when known.
- Relevant next commands: `unclecode mcp list`, future `unclecode mcp doctor`, future server detail/test action.

Primary actions:
- `Enter` on a server opens server detail.
- `I` inspects selected server config without starting it or claiming health.
- `D` runs doctor/MCP readiness.
- Future: `T` tests selected server connectivity.
- Future: `C` copies or shows the exact config origin.

Acceptance criteria:
- MCP page handles zero servers with setup guidance.
- Configured servers show no more than necessary but include transport, scope, trust, and origin.
- Page clearly distinguishes configured from connected/healthy.
- MCP actions do not imply tools are connected if only config was loaded.

Current gaps:
- `mcp-list` is now exposed as a session-center action and `M` shortcut, and the MCP tab now focuses it on entry; the page still needs server-level selection and detail.
- MCP now has a page-native server list, selected-server inspector, and `I` inspect action; selected server testing/connection actions do not exist.
- Health is explicitly shown as "not checked from this page yet"; current data is registry metadata only.

### Research Page

Job:
- Start and review local research runs without forcing users to remember CLI syntax.
- Show whether research has enough context/MCP support to be useful.

Visible state:
- Latest research session ID.
- Research run count from `.unclecode/research-runs.jsonl`.
- Recent research runs from the ledger: prompt, status, summary, timestamp.
- Latest timestamp.
- Latest summary or empty state.
- Research prompt draft.
- Context sources available: workspace, bridge, memory, MCP.

Primary actions:
- `R` opens research prompt entry.
- `Enter` submits non-empty prompt.
- `Esc` cancels draft or returns to Work if no draft/detail is open.
- Future: select prior research run from ledger.
- Future: resume/open latest research session from page.

Acceptance criteria:
- Research page is useful when there are zero research runs.
- Prompt entry is visible as a page-native workflow, not only as a generic action detail.
- Successful research run refreshes home state and returns the page to Research.
- Failed research run leaves an inspectable error in activity/output.

Current gaps:
- Research prompt entry is now a page-native lane: `R` or `Enter` on Research opens it, `Esc` cancels it, and submit reuses `new-research` execution.
- Research ledger now contributes a bounded recent-run list and selected-run inspector detail; prior runs cannot be resumed/opened directly yet.
- Latest summary comes from saved session summary, not directly from the ledger artifact.

## Workflow Design

### Flow A: Active Work -> ESC -> Inspect -> Return

1. User is in Work composer.
2. User presses `Esc`.
3. Shell opens History/session-center over or beside the preserved work session.
4. User inspects History/MCP/Research with `2/3/4`.
5. User presses `1` or `Esc` from top level to return to Work.
6. Work input and active turn state remain intact.

### Flow B: Resume Work Session

1. User opens History.
2. User selects a `work-*` session.
3. Detail panel shows summary, model, mode, branch, pending action, context source count.
4. `Enter` opens Work with `--session-id <id>`.
5. Work pane refreshes home state and selected session.

### Flow C: Inspect MCP Before Work

1. User opens MCP.
2. Page lists configured MCP servers.
3. User can run `mcp-list` or future server test without leaving shell.
4. Result appears in activity/output and home state refreshes.
5. User returns to Work.

### Flow D: Run Research

1. User opens Research or presses `R`.
2. Prompt field is focused.
3. User types a prompt and presses `Enter`.
4. Running state shows context assembly, research execution, artifact write.
5. On success, Research page updates run count, latest timestamp, summary/session ID.
6. On failure, error is retained in activity/output and user can retry.

## UX Rules

- Use page labels consistently: product text should say `History`, not sometimes `sessions`.
- Avoid duplicate panels. If Work is embedded full-screen, do not render a fake Work card behind it.
- Do not show implementation labels like `new-research`, `api-key-login`, worker IDs, or internal enum values to users.
- Empty states must include the next useful key.
- Destructive or external side-effect actions require approval or clear review state.
- Keyboard hints must reflect actual state. If `Esc` closes detail first, do not label it only as `Esc work`.

## Implementation Plan

### Phase 1 - Contract the Intended UX

- Add tests for top-level `Esc` behavior across all tabs.
- Add tests for MCP action availability and empty/configured server states.
- Add tests for Research page-native prompt/draft behavior.
- Add tests that detail hints change between top-level and detail-open states.

### Phase 2 - Make Pages First-Class

- Add page-specific action models instead of one generic `SESSION_CENTER_ACTIONS` list for all tabs.
- Add `mcp-list` action to the MCP page.
- Move Research prompt entry into the Research page when `view === "research"`. Completed for direct prompt entry; future work can improve visual layout.
- Add selected MCP server test/connect actions if server-level operations are implemented.

### Phase 3 - Refine ESC and Work Integration

- Ensure embedded Work can always call `openSessions` on `Esc`.
- Decide whether the session center is an overlay/drawer or full replacement, then make the transition visually consistent.
- Keep Work state alive while inspecting other tabs.

### Phase 4 - Data Enrichment

- Parse research ledger entries for prior-run list. Completed for bounded display; latest artifact summary remains future work.
- Add optional MCP health checks distinct from registry config.
- Add search/filter for sessions once the list grows beyond six.

## Non-Goals

- Do not add fake live MCP health if only registry config is available.
- Do not invent research summaries from filenames or timestamps.
- Do not rebuild the TUI framework.
- Do not introduce new dependencies for this PRD.
- Do not replace the work-first startup model.

## Verification Matrix

| Requirement | Evidence needed |
| --- | --- |
| Work remains primary | TUI contract test for `initialView`, embedded Work render, and Work input capture. |
| `Esc` opens/returns predictably | Navigation tests for Work, History, MCP, Research, detail-open, approval-open. |
| History resumes sessions | Contract tests for `work-*` embedded open and non-work `runSession()` summary path. |
| MCP is actionable | Tests for configured/empty MCP page and `mcp-list` action dispatch. |
| Research is page-native | Tests for Research prompt draft, submit, cancel, success refresh, failure retention. |
| Honest UI | Tests suppress generic reasoning deltas and prohibit fake token/cost metrics. |

## Open Questions

- Should `Esc` from Work open History specifically, or the last visited command-center tab?
- Should MCP server health run automatically on page open, or only on explicit action?
- Should Research page list ledger entries by default, or show latest plus a separate history toggle?
- Should `unclecode tui` start on History while `Esc` from Work starts on last visited tab?
