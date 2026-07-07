# ESC Session Center Workflow — Implementation Plan

> **Status (2026-07):** SHIPPED — ESC/sessions features landed (code in `dashboard-navigation.ts`, `work-shell-dashboard.tsx`, `onRequestSessionsView`). The checkboxes below were never flipped; the PRD companion (`docs/specs/2026-06-01-esc-session-center-workflow-prd.md`) records the implementation evidence. Kept as a task record.

**Companion to:** `docs/specs/2026-06-01-esc-session-center-workflow-prd.md`
**Generated:** 2026-06-01

This plan converts the PRD's phases and verification matrix into executable
tasks. Each task has a "Done when" gate that maps to a concrete test or
runtime check. Do not start a phase before the previous phase's gate is green.

## Phase 1 — Contract the Intended UX

- [ ] **P1.1** Top-level `Esc` behaviour is identical across all tabs.
  - **Done when:** `tests/tui/session-center-esc.test.mjs` covers Work, History, MCP, Research, detail-open, approval-open and asserts the same return-to-previous-view behaviour.
- [ ] **P1.2** MCP page action availability matches configured/empty server state.
  - **Done when:** `tests/tui/mcp-page.test.mjs` exercises empty registry, configured-but-disconnected, and configured-and-connected.
- [ ] **P1.3** Research page is prompt-native, not a modal hijack.
  - **Done when:** `tests/tui/research-prompt-page.test.mjs` covers draft/submit/cancel/success-refresh/failure-retention flows.
- [ ] **P1.4** Detail hints differ between top-level and detail-open states.
  - **Done when:** snapshot test on `formatWorkShellFooterLine` for each state.

## Phase 2 — Make Pages First-Class

- [ ] **P2.1** Per-page action models replace the global `SESSION_CENTER_ACTIONS` list.
  - **Done when:** `packages/orchestrator/src/command-registry.ts` exposes `getActionsForPage(pageId)` and the global list is removed.
- [ ] **P2.2** `mcp-list` action ships on the MCP page.
  - **Done when:** `tests/commands/mcp-list.test.mjs` covers server list, click-to-connect, and error surface.
- [ ] **P2.3** Research prompt entry lives in the Research page (already done for direct entry).
  - **Done when:** prompt is reachable from the Research page only; modal removed; visual layout improvement tracked as a follow-up.
- [ ] **P2.4** Per-MCP-server test/connect actions are wired when a server-level operation exists.
  - **Done when:** registry exposes a `getServerOps(name)` hook and at least one op is exercised in tests.

## Phase 3 — Refine ESC and Work Integration

- [ ] **P3.1** Embedded Work can always call `openSessions` on `Esc`.
  - **Done when:** `tests/tui/work-esc-override.test.mjs` proves the Work shell still receives input after `Esc` opens the session center.
- [ ] **P3.2** Session center visual is consistent across overlay/drawer/full-replace.
  - **Done when:** visual snapshot test for the chosen transition (decision logged in `docs/decisions/` if not already).
- [ ] **P3.3** Work state survives inspection of other tabs.
  - **Done when:** integration test starts a Work turn, navigates to History, returns, and the turn resumes without re-prompt.

## Phase 4 — Data Enrichment

- [ ] **P4.1** Research ledger parsing for prior-run list.
  - **Done when:** `packages/memory-bus/src/research-ledger.ts` (or equivalent) exposes a sorted list view; the page uses it; fake summaries are forbidden by contract test.
- [ ] **P4.2** Optional MCP health checks distinct from registry config.
  - **Done when:** an explicit `mcp-health` action is available and runs only on click (never on open).
- [ ] **P4.3** Session search/filter for lists beyond six entries.
  - **Done when:** History page exposes a filter input and `tests/tui/history-filter.test.mjs` covers prefix and tag filters.

## Non-Goals (do not do these)

- No fake live MCP health from registry config.
- No invented research summaries from filenames/timestamps.
- No TUI framework replacement.
- No new dependencies for this PRD.
- No replacement of the work-first startup model.

## Verification Matrix Gates

| Requirement | Test | Owner | Status |
| --- | --- | --- | --- |
| Work remains primary | `tests/tui/work-primary.test.mjs` (initialView, embedded render, input capture) | TUI lane | todo |
| `Esc` opens/returns predictably | `tests/tui/session-center-esc.test.mjs` | TUI lane | todo |
| History resumes sessions | `tests/tui/history-resume.test.mjs` | TUI lane | todo |
| MCP is actionable | `tests/commands/mcp-list.test.mjs` | commands lane | todo |
| Research is page-native | `tests/tui/research-prompt-page.test.mjs` | TUI lane | todo |
| Honest UI | `tests/tui/honesty.test.mjs` (no generic reasoning deltas, no fake token/cost) | TUI lane | todo |

## Open Questions to resolve before P3.2

- `Esc` from Work → History specifically, or last visited tab?
- MCP server health on page open, or only on explicit action?
- Research page: ledger entries by default, or latest + history toggle?
- `unclecode tui` start page: History always, or last visited?

Track these in `docs/decisions/2026-06-01-esc-tab-default.md` (or a similar ADR
slug) before phase 3 starts.

## Definition of Done

All boxes above are checked, all verification matrix rows are green, and the
changes have been run through `npm run test:all`.
