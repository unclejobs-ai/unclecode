<!-- AUTONOMY DIRECTIVE - DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" - PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT.
<!-- END AUTONOMY DIRECTIVE -->

# UncleCode Workspace Instructions

This repository should not assume third-party Codex orchestration integration.
Keep project automation local to UncleCode or generic Codex capabilities.

## Working Agreements

- Prefer the narrowest useful specialist over a generic worker.
- Keep diffs small, reviewable, and reversible.
- Prefer deletion, reuse, and boundary repair over new layers.
- No new dependencies without an explicit request.
- Do not revert unrelated user changes in a dirty worktree.
- Use `rg` for search and `rg --files` for file discovery.
- Use `apply_patch` for manual file edits.

## Verification

- Verify before claiming completion.
- For code changes, run the most relevant tests first, then broader checks when practical.
- Report any verification that could not be run.

## React Effect Discipline

- Treat `useEffect` as an escape hatch, not default wiring.
- Do not use `useEffect` for derived render state, props-to-state mirroring, filtering/sorting for display, event-specific work, or prop-change resets that can be handled with `key`.
- Prefer render-time calculation, event handlers, controlled/lifted state, `key` resets, and `useSyncExternalStore` for external subscriptions.
- If an effect is needed for DOM/browser APIs, timers, subscriptions, or visible-screen network sync, include cleanup/cancellation.
