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

This is a Node.js + Rust monorepo. Two toolchains must be correct or many commands fail:

- **Node**: `engines.node` requires `>=22.18.0 <26` and `.nvmrc` pins `22.22.0`. The default VM `node` (`/exec-daemon/node`) is 22.14.0, which FAILS `npm run node:check`. The agent's `~/.bashrc` is configured to source nvm and prepend the nvm-managed `v22.22.2` bin so interactive/dev shells use a satisfying Node. If a command hits an engines/version error, run `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- **Rust**: several transitive deps require edition2024, so Cargo must be `>=1.85`. The stable toolchain (currently 1.96.1) is installed via rustup and set as the global default (`rustup default stable`), which persists in the snapshot. The preinstalled 1.83.0 fails `cargo build` with a `feature 'edition2024' is required` error.

Key workflow notes (standard commands live in `package.json` scripts and `README.md`):

- `npm run check` (tsc) depends on build output: the `@unclecode/*` subpath exports (e.g. `@unclecode/providers/openai-status`) resolve to `dist/`. Run `npm run build` before `npm run check`, otherwise you get `TS2307 Cannot find module` errors. Building `packages/*` is a prerequisite for the check to pass.
- Build the Rust CLI (`cargo build --workspace`) before `npm run unclecode` / `./target/debug/unclecode`; the npm script points at `target/debug/unclecode`.
- The interactive shell (`./target/debug/unclecode`, `unclecode work`) needs a real provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) for LLM turns; placeholder values in `.env.example` are treated as unset. Offline core surfaces still work without keys: built-in slash commands, `unclecode rust orchestrator ...`, `unclecode rust model catalog <provider>`, and `unclecode rust aci read|write` (sandboxed to cwd; rejects absolute paths — use repo-relative paths under gitignored dirs like `.data/`).
- Known pre-existing test issues (not environment problems, do not "fix" as setup):
  - `tests/contracts/orchestrator-multi-agent.contract.test.mjs` — `classifyWorkIntent routes ultrawork prompts to complex` fails; the Rust classifier returns `simple` for short ultrawork prompts.
  - `tests/work/tools.test.mjs` — `run_shell executes a simple command` asserts `pwd` output matches `/unclecode/`, which fails because the cloud checkout path is `/workspace`, not a dir named `unclecode`.
