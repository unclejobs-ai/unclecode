# Worktree Audit — 2026-07-03

## Baseline

| Field | Value |
| --- | --- |
| Base commit | `0998d43d978819696210baf5b8479b18087b04d7` (`main`, synced with `origin/main`) |
| Audit snapshot time | 2026-07-03 KST (executor start) |
| Scope | All uncommitted changes relative to `HEAD` |
| Diff size | **72 files changed, +3,819 / −754** (tracked modifications only; additional untracked files listed below) |
| Parallel-work caveat | Another worker may be editing `packages/tui` concurrently. This audit reflects the tree at snapshot time only. |

### Inventory summary

- **Tracked modified:** 72 files
- **Untracked (not in diff stat):** `.cursor/`, `DESIGN.md`, `UNCLECODE.md`, `docs/runbooks/`, four TUI fast-path modules, `rust/unclecode/src/cli_auth_saved.rs`, entire `scripts/health-qa/`, `scripts/runtime-qa/`, `scripts/live-provider-qa/`, `scripts/qa/`, four `scripts/unclecode-*.mjs` entrypoints, 16+ new `tests/cli/*.test.mjs`, `tests/contracts/terminal-visual-qa.contract.test.mjs`, `tests/integration/unclecode-work-provider-alias.integration.test.mjs`

---

## Area (a) — TUI fast-paths and view/panel changes

**Purpose:** Align the Work Shell with the new light-terminal design system (`DESIGN.md`), improve render performance via extracted “fast-path” helpers, and enforce readable foreground colors on white/transparent terminals.

**Key files**

| Kind | Path |
| --- | --- |
| New (untracked) | `packages/tui/src/work-shell-view-fast-paths.ts` (re-export barrel) |
| New | `work-shell-footer-fast-paths.ts`, `work-shell-panel-layout-fast-paths.ts`, `work-shell-panel-line-fast-paths.ts` |
| Modified | `work-shell-view.tsx` (+436/−refactor), `work-shell-panels.ts`, `work-shell-pane.tsx`, `composer.tsx`, dashboard components/shell, `work-shell-hooks.ts`, `work-shell-attachments.ts` |

**Notable diff signals**

- Palette shift from dark-assumed colors (`#e5eef7`, `#7dd3fc`) to light-terminal tokens (`#0f172a`, `#075985`, `#115e59`).
- `resolveReadableWorkShellTextColor()` remaps legacy near-white text to readable slate.
- Fast-path modules encapsulate panel layout, line classification, and footer formatting for hot render paths.

**Companion tests**

| Test surface | Status |
| --- | --- |
| `tests/tui/*.test.mjs` (modified) | Present; **pass** under `qa:health` tui-tests gate |
| `tests/contracts/tui-*.contract.test.mjs` | Modified |
| `tests/contracts/terminal-visual-qa.contract.test.mjs` | New (untracked) |
| `scripts/runtime-qa/tui-*-smoke.mjs` | Runtime gate — **currently failing** (see Known QA failure) |

**Risks**

- **High:** Runtime QA asserts explicit truecolor foreground (`38;2;15;23;42m`) on full-screen TUI header/body; current capture lacks that escape on `UncleCode ·` header → `qa:health` fails at runtime QA.
- **Medium:** Parallel TUI edits may diverge from this snapshot; rebasing or merging could conflict on `work-shell-view.tsx`.
- **Medium:** Light-theme palette change is broad; contract tests may pass while tmux ANSI capture regressions remain.

---

## Area (b) — QA harness (`scripts/health-qa`, `scripts/runtime-qa`, `scripts/qa`, entrypoints)

**Purpose:** Introduce a bounded, fail-fast operational gate (`npm run qa:health`) with per-check timeouts, process-tree termination, structured evidence reports, and decomposed runtime/live provider smokes.

**Key files**

| Component | Paths |
| --- | --- |
| Health runner | `scripts/unclecode-health-qa.mjs`, `scripts/health-qa/runner.mjs`, `process-tree.mjs`, `timeout-watchdog.mjs`, `summary.mjs` |
| Runtime QA | `scripts/unclecode-runtime-qa.mjs`, `scripts/runtime-qa/*` (fake provider servers, tmux/tty smokes, evidence builder) |
| Live provider QA | `scripts/unclecode-live-provider-qa.mjs`, `scripts/unclecode-live-provider-qa-lib.mjs`, `scripts/live-provider-qa/tool-smoke.mjs` |
| Visual QA helper | `scripts/qa/web-terminal-visual-qa.mjs` (ANSI → HTML for manual/visual review) |
| Package wiring | `package.json`: `qa:health`, `qa:runtime`, `qa:live`, `qa:live:record`, `qa:stability` (alias) |

**Design highlights**

- `DEFAULT_CHECK_TIMEOUT_MS = 300_000` (5 min) per check; SIGTERM → SIGKILL on timeout.
- Fail-fast: first failing check stops the gate (live provider and whitespace diff may not run).
- Native ABI self-recovery: `better-sqlite3` rebuild + single retry on `ERR_DLOPEN_FAILED`.
- Evidence persisted to `.unclecode/qa/runtime-qa-latest.json` and `live-provider-latest.json`.

**Companion tests**

| Path | Role |
| --- | --- |
| `tests/cli/health-*.test.mjs` (4 files) | Summary contracts, timeout behavior |
| `tests/cli/live-*.test.mjs` (5 files) | Live report format, runner contract, tool smoke |
| `tests/cli/runtime-*.test.mjs` (3 files) | Evidence contract, tmux helpers, CLI helpers |
| `tests/cli/stability-script.test.mjs` | `qa:stability` → `qa:health` alias |
| `tests/contracts/terminal-visual-qa.contract.test.mjs` | Web terminal visual QA contract |

**Risks**

- **Medium:** Untracked scripts are invisible to `origin/main` CI until committed; gate exists only in dirty worktree.
- **Medium:** Runtime QA depends on `tmux` and local fake provider servers — environment-sensitive.
- **Low:** Fail-fast design means a single early failure hides downstream check status (observed: live provider QA not reached on 2026-07-03 run).

---

## Area (c) — Rust core normalization (`rust/unclecode-core`)

**Purpose:** Harden auth/doctor transparency, normalize UX copy/panels, and extend provider/research/team surfaces for API-readiness signaling.

**Key files (16 modified, +997/−154)**

| Module | Inferred purpose |
| --- | --- |
| `auth.rs` | `OpenAIAuthRecovery`, `runtime` field, `openai_auth_supports_api_calls()`, structured recovery commands |
| `doctor_report.rs` | Auth verdict based on `apiReady`; JSON `auth` block with recovery; human labels for Codex OAuth block |
| `gemini_request.rs`, `provider_response.rs` | Provider protocol normalization |
| `ux_panels.rs`, `ux_text.rs` | Panel/text normalization for operator-facing output |
| `orchestrator.rs`, `team_runtime.rs`, `team_mini_loop.rs` | Team/runtime orchestration adjustments |
| `research_run.rs`, `research_status.rs` | Research status/run alignment |
| `session.rs`, `repo_context.rs`, `setup_report.rs`, `time_iso.rs`, `work_runtime_args.rs` | Supporting normalization |

**Companion tests**

- Inline `#[cfg(test)]` modules (e.g. `doctor_report.rs`, `cli_auth_saved.rs` in sibling crate).
- Integration tests updated: auth login/status, doctor, research status, bin smoke.

**Risks**

- **Medium:** Auth semantics change (WARN vs PASS for saved Codex OAuth) affects operator expectations and live QA skip paths.
- **Low:** Large cross-cutting Rust diff increases merge conflict surface with any parallel Rust work.

---

## Area (b) continued — `apps/unclecode-cli` bootstrap/session

**Purpose:** Wire runtime bootstrap and session layers to normalized auth/context behavior.

**Key files:** `fast-setup.ts`, `operational.ts`, `program.ts`, `work-runtime-bootstrap.ts`, `work-runtime-session.ts` (+75/−58 combined).

**Tests:** `tests/work/work-runtime.test.mjs`, `tests/work/repl.test.mjs` (modified); work tests **pass** in `qa:health`.

**Risks:** **Low** — localized to CLI bootstrap path; covered by work tests.

---

## Area (d) — Rust CLI (`rust/unclecode`)

**Purpose:** Auth login flow guards against non-API-ready saved OAuth; expand work/team CLI surfaces; JSON output improvements.

**Key files**

| Path | Notes |
| --- | --- |
| `cli_auth_saved.rs` (new) | `saved_auth_login_decision()` — blocks silent use of Codex OAuth for API calls |
| `cli_auth.rs` | Integration with saved-auth decision |
| `cli_work.rs`, `cli_team.rs`, `main.rs` | Work/team command expansion |
| `Cargo.toml` + `Cargo.lock` | Adds `serde_json` dependency to `unclecode` binary crate |

**Companion tests:** `tests/integration/unclecode-auth-login.integration.test.mjs`, `unclecode-auth-status.integration.test.mjs`, `unclecode-bin.integration.test.mjs` (+198 lines), `unclecode-work-provider-alias.integration.test.mjs` (new).

**Risks**

- **Medium:** Auth login behavior change is user-facing; incorrect merge could lock users out of login or silently accept bad OAuth.
- **Low:** New `serde_json` dep is isolated to CLI crate.

---

## Area (e) — TypeScript providers and orchestrator

**Purpose:** Propagate `apiReady` / `runtime` through provider types; optimize slash-command suggestion caching; work-shell engine tweaks.

**Key files**

| Package | Files |
| --- | --- |
| `packages/providers` | `openai-status.ts`, `runtime.ts`, `types.ts`, `types.d.ts` — `runtime`, `apiReady` fields |
| `packages/orchestrator` | `work-shell-slash.ts` (suggestion cache + mode profile IDs), `extension-registry.ts`, `work-shell-engine*.ts`, `work-shell-pane-runtime.ts` |

**Companion tests:** `tests/providers/openai-status.test.mjs`, `tests/orchestrator/work-shell-engine.test.mjs`, `tests/commands/extension-registry.test.mjs`.

**Risks**

- **Low–medium:** Slash suggestion cache keyed on extension registry generation — stale cache if generation bump logic wrong.
- **Low:** Provider type changes require rebuild before `npm run check` (standard monorepo workflow).

---

## Area (f) — Tests (aggregate)

**Purpose:** Lock in health/runtime/live contracts, TUI behavior, integration auth/doctor/research paths.

**Scale**

| Bucket | Modified | New (untracked) |
| --- | --- | --- |
| `tests/cli/` | — | 16 files |
| `tests/contracts/` | 4 | 1 (`terminal-visual-qa`) |
| `tests/integration/` | 8 | 1 (`work-provider-alias`) |
| `tests/tui/`, `tests/work/`, `tests/commands/`, `tests/orchestrator/`, `tests/providers/` | 11 | — |

**qa:health test gates (2026-07-03):** work, cli, tui unit tests all **PASS**. Runtime QA **FAIL** (see below). Live provider QA **not reached** (fail-fast).

**Risks**

- **Medium:** New CLI contract tests are untracked — CI on `main` does not run them until committed.
- **Low:** `package.json` adds `--disable-warning=ExperimentalWarning` to all test scripts (Node 22 experimental warning suppression).

---

## Area (g) — Documentation

**Purpose:** Codify design system, agent operating loop, and normalization runbook.

| File | Lines | Role |
| --- | --- | --- |
| `DESIGN.md` (untracked) | ~190 | Color/typography/spacing design system for TUI |
| `UNCLECODE.md` (untracked) | ~56 | Deep-work loop, verification ledger, untrusted-input boundary |
| `docs/runbooks/unclecode-normalization-runbook.md` (untracked) | ~168 | Operational gate, source-of-truth map, context transparency rules |

**Tests:** None directly; runbook validated separately via `qa:health` (partial pass on 2026-07-03).

**Risks**

- **Low:** Docs drift from code until committed and reviewed with the normalization diff.

---

## Cross-cutting changes

| File | Change |
| --- | --- |
| `.gitignore` | Ignore `.omo/`, `.superpowers/` |
| `package.json` | QA scripts + experimental-warning suppression on test runners |

---

## qa:health validation (2026-07-03 KST)

Executed: `npm run qa:health --silent` on dirty worktree, Node v22.22.0, duration **85.8s**, exit **1**.

| Check | Result |
| --- | --- |
| cli version | PASS |
| node version | PASS |
| doctor | PASS (auth WARN: oauth-file, codex runtime, apiReady=false) |
| doctor json | PASS |
| mcp list | PASS |
| research status | PASS |
| typecheck | PASS |
| lint | PASS |
| work tests | PASS |
| cli tests | PASS |
| tui tests | PASS |
| runtime QA | **FAIL** — TUI full-screen header missing explicit readable foreground |
| live provider QA | **Not run** (fail-fast) |
| diff whitespace | **Not run** (fail-fast) |

**Failure detail (runtime QA):**

```
AssertionError: full-screen header should use an explicit readable foreground
  expected: /\x1b\[38;2;15;23;42mUncleCode ·/
  actual: plain text header line without truecolor foreground escape
  at scripts/runtime-qa/tui-basic-smokes.mjs:56
```

This correlates with Area (a) TUI palette work: unit/contract tests pass, but tmux ANSI capture gate fails.

---

## Cloud vs local environment notes

Compared against `AGENTS.md` “Cursor Cloud specific instructions” on the local macOS host used for this audit:

| Requirement | AGENTS.md claim | Local observation | Match? |
| --- | --- | --- | --- |
| Node | `>=22.18.0 <26`; `.nvmrc` pins `22.22.0`; cloud uses nvm `v22.22.2` | `v22.22.0` (matches `.nvmrc`) | Yes |
| Cargo | `>=1.85`; cloud stable **1.96.1** via rustup (`rustup default stable`) | `cargo 1.94.1 (Homebrew)`; `rustup` not installed (`command not found`) | Yes (≥1.85; toolchain manager differs — Homebrew locally vs rustup on cloud) |
| Build before check | `npm run build` before `npm run check` | Not re-run end-to-end; typecheck passed in qa:health | Consistent |
| Rust CLI before npm unclecode | `cargo build --workspace` | Runtime QA invokes build via `qa:runtime` script | Consistent |
| Checkout path | Cloud uses `/workspace` | Local: `/Users/parkeungje/project/unclecode` | Expected divergence; affects `tests/work/tools.test.mjs` pwd assertion noted in AGENTS.md |
| Known pre-existing failures | orchestrator-multi-agent classifier; tools.test pwd path | Not re-validated in this audit | Still documented in AGENTS.md |

**Minor doc drift:** AGENTS.md references nvm `v22.22.2` while `.nvmrc` pins `22.22.0`. Both satisfy `engines.node`. Cloud VM path `/exec-daemon/node` (22.14.0) is not applicable locally.

---

## Suggested commit split

Proposed reviewable units (suggestion only — **do not commit as a single blob**):

1. **`feat(qa): add health/runtime/live QA harness`** — `scripts/health-qa/`, `scripts/runtime-qa/`, `scripts/live-provider-qa/`, `scripts/qa/`, `scripts/unclecode-*.mjs`, `package.json` QA scripts, `tests/cli/*`, `tests/contracts/terminal-visual-qa.contract.test.mjs`, `.gitignore` QA artifacts if any.

2. **`feat(auth): API-ready auth contract and recovery`** — `rust/unclecode-core/src/auth.rs`, `doctor_report.rs`, `packages/providers/src/openai-status.ts`, `types.ts`, `rust/unclecode/src/cli_auth*.rs`, auth integration tests.

3. **`refactor(rust-core): UX and provider normalization`** — remaining `rust/unclecode-core/*` changes not in (2).

4. **`feat(rust-cli): work/team CLI expansion`** — `rust/unclecode/src/cli_work.rs`, `cli_team.rs`, `main.rs`, `Cargo.toml`/`Cargo.lock`, provider-alias integration test.

5. **`perf(orchestrator): slash suggestion cache and engine tweaks`** — `packages/orchestrator/*`.

6. **`feat(tui): light-terminal design system and fast-path render helpers`** — `packages/tui/*`, `DESIGN.md`, TUI tests; **resolve runtime QA failure before or with this commit**.

7. **`feat(cli): work runtime bootstrap/session wiring`** — `apps/unclecode-cli/*`, `tests/work/*`.

8. **`docs: agent guidance and normalization runbook`** — `UNCLECODE.md`, `docs/runbooks/unclecode-normalization-runbook.md`, this audit doc.

Dependencies: (1) should land early so later commits can use the gate; (6) should not land without fixing runtime QA or updating smoke expectations intentionally.

---

## Residual risks (uncommitted state)

1. **No CI coverage** until commits land — 72 tracked + ~30 untracked files invisible to `origin/main`.
2. **Runtime QA regression** blocks full `qa:health` pass; live provider and whitespace checks unverified in this run.
3. **Parallel TUI edits** may invalidate Area (a) characterization.
4. **Auth WARN default** (Codex OAuth saved locally) is intentional but may confuse operators expecting green doctor.
5. **tmux-dependent gates** fail in environments without tmux even if TUI code is correct.
