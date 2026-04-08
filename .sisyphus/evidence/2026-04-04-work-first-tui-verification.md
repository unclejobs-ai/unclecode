# 2026-04-04 Work-First TUI Verification

## Implemented in this loop
- Default `unclecode` interactive startup now launches the repo-local work shell instead of the session-center launcher.
- Work shell header now surfaces `model`, `reasoning`, `mode`, and `auth`.
- OpenAI work sessions default to `gpt-5.4` and use mode-based reasoning defaults.
- `/reasoning` now reports or overrides reasoning without hiding unsupported models.
- Browser OAuth integration flake was hardened by waiting for callback listener readiness.
- Session-center browser OAuth now completes the callback flow and writes credentials instead of only printing a URL.
- Work-shell chat sessions now persist into `@unclecode/session-store` and appear in recent sessions.
- Session-center navigation now treats arrows/Tab/Enter/Esc as primary controls and no longer traps movement while detail/approval panes are open.
- Runtime labeling now clearly shows `Node <version>` instead of a bare version string.
- `setup`, `doctor --verbose`, and provenance release-surface checks remain green.

## Verification commands
- `npm run lint`
- `npm run check`
- `npm run build`
- `npm run test:integration`
- `node --conditions=source --import tsx --test tests/contracts/tui-session-center.contract.test.mjs tests/tui/shell-state.test.mjs tests/work/repl.test.mjs tests/commands/tui-action-runner.test.mjs tests/work/openai-provider.test.mjs`
- `node --conditions=source --import tsx --test tests/contracts/tui-session-center.contract.test.mjs tests/integration/unclecode-sessions.integration.test.mjs`
- `node --test tests/integration/unclecode-auth-login.integration.test.mjs` repeated 10 times

## Result
All listed commands passed during this loop.

## Remaining verification gaps
- F1-F4 artifacts are now present, but they remain self-authored rather than independently reviewed.
- Working tree cleanup/history shaping remains unfinished because the branch still contains broad in-flight rebuild changes outside this loop.
