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

## Cursor Cloud specific instructions

This is a Node.js + Rust monorepo. Two toolchains must be correct or many commands fail. Root toolchain files pin both, so a clean checkout should "just work" without manual PATH surgery:

- **Node**: `engines.node` requires `>=22.18.0 <26` and `.nvmrc` pins `22.22.0`. The default VM `node` (`/exec-daemon/node`) is 22.14.0, which FAILS `npm run node:check`. The repo also ships `.tool-versions` (asdf) and `.devcontainer/devcontainer.json` (Codespaces / Cursor Cloud), so prefer those over hand-rolling nvm shims. If a command still hits an engines/version error after switching to the pinned toolchain, the lock files are out of date — bump them rather than patching PATH.
- **Rust**: the locked dependency graph requires Rust `>=1.86`. Both `rust-toolchain.toml` and `.tool-versions` pin the verified `1.98.0` release so rustup, asdf, and the devcontainer agree. The preinstalled 1.83.0 fails `cargo build` with an edition/MSRV error; rustup installs the pinned toolchain automatically when it honors `rust-toolchain.toml`.

Key workflow notes (standard commands live in `package.json` scripts and `README.md`):

- `npm run check` (tsc) depends on build output: the `@unclecode/*` subpath exports (e.g. `@unclecode/providers/openai-status`) resolve to `dist/`. Run `npm run build` before `npm run check`, otherwise you get `TS2307 Cannot find module` errors. Building `packages/*` is a prerequisite for the check to pass.
- Build the Rust CLI (`cargo build --workspace`) before `npm run unclecode` / `./target/debug/unclecode`; the npm script points at `target/debug/unclecode`.
- The interactive shell (`./target/debug/unclecode`, `unclecode work`) needs a real provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) for LLM turns; placeholder values in `.env.example` are treated as unset. Offline core surfaces still work without keys: built-in slash commands, `unclecode rust orchestrator ...`, `unclecode rust model catalog <provider>`, and `unclecode rust aci read|write` (sandboxed to cwd; rejects absolute paths — use repo-relative paths under gitignored dirs like `.data/`).
- Known test conventions (already aligned as of this change):
  - The work-intent classifier contract lives in `tests/contracts/work-intent-classifier.contract.test.mjs`; multi-agent runtime isolation (bounded executor + file ownership) lives in `tests/contracts/agent-runtime-isolation.contract.test.mjs`. The old `orchestrator-multi-agent.contract.test.mjs` filename was stale after T12-E1 (ultrawork now routes informational prompts to `simple`) and was split on touch.
  - `tests/work/tools.test.mjs` asserts `pwd` returns `process.cwd()` rather than matching a hardcoded path, so it runs in both `/workspace` (cloud) and any local checkout.
