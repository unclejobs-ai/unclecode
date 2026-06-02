# UncleCode Product Hardening + YOLO Harness Plan

> For Hermes: use subagent-driven-development to execute this plan task-by-task after the owner approves scope changes.

Goal: turn UncleCode into a fast, Korean-safe, work-first agent shell with first-class YOLO behavior, discoverable slash surfaces, a real `/queue` operator view, and external-orchestration-style harness controls that reduce needless re-asking.

Architecture:
- Keep the existing package boundaries (`contracts` → `config-core` / `policy-engine` → `orchestrator` → `tui` → `apps/unclecode-cli`).
- Fix correctness inside shared seams instead of patching one caller at a time.
- Treat “YOLO mode” as three linked layers, not one flag: mode profile defaults, approval/policy behavior, and Codex/external orchestration harness settings.
- Do not add new dependencies unless the display-width work proves impossible with a small internal utility and that tradeoff is explicitly reviewed.

Tech stack: TypeScript, Ink, Commander, external Codex orchestration, local workspace packages, Node 22+

Success bars:
- Korean/Hangul/CJK/emoji composer cases stop drifting or leaking wrapped glyphs.
- `node apps/unclecode-cli/dist/index.js --help` stays under ~600ms on a warm local machine.
- `npm run unclecode` no longer forces a build on every launch.
- `/skills`, `/skill`, `/tools`, `/queue`, `/mode set yolo`, and harness surfaces are discoverable and tested.
- `unclecode mode set yolo` and `unclecode harness apply yolo` produce a low-friction execution profile without silently weakening remote/MCP safety.
- Reasoning/thinking state is visible as a first-class operator signal, not buried inline in metadata soup.
- The main shell no longer uses oversized empty chrome such as the giant `Conversation` header box, and chat labels/readability feel product-grade rather than scaffold-grade.
- Plugin/skill/agent diagnostics are visible in doctor/status output.

Non-goals:
- Rebuilding the shell from scratch.
- Replacing the current orchestration model wholesale.
- Blindly copying external Codex orchestration config; only port the bounded parts that help UncleCode’s product behavior.

---

## Phase 1 — Lock current gaps with failing tests

### Task 1: Add failing regression tests for wide-character composer behavior
Objective: make the current IME/CJK bug concrete before changing composer logic.

Files:
- Modify: `tests/work/composer.test.mjs`
- Modify: `tests/work/repl.test.mjs`
- Modify: `tests/contracts/tui-work-shell.contract.test.mjs`

Steps:
1. Add unit cases for Hangul/CJK/emoji cursor positioning using `applyComposerEdit()` and the exported composer helpers.
2. Add tests that model mixed-width input like `한a`, `한글`, `🙂a`, and multiline mixed-width strings.
3. Add a regression assertion for cursor placement after left/right movement and backspace across wide characters.
4. Add a contract assertion that the shared TUI seam exports any new display-width helper you introduce.

Verify:
- `npm run test:work --silent`
- `npm run test:tui --silent`

### Task 2: Add failing tests for slash/help parity and missing `/queue`
Objective: force builtin handling, slash suggestions, and help text to agree.

Files:
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`
- Modify: `tests/contracts/tui-work-shell.contract.test.mjs`
- Create: `tests/commands/unclecode-queue.contract.test.mjs`

Steps:
1. Add assertions that `/skills`, `/skill <name>`, `/tools`, and `/queue` appear in slash suggestions when appropriate.
2. Add assertions that `/queue` resolves as a real builtin/local command rather than `undefined`.
3. Add assertions that help/status panels do not advertise commands the registry cannot discover.
4. Add a CLI-level contract for `/queue` and any harness subcommands added later.

Verify:
- `npm run test:commands --silent`
- `npm run test:work --silent`

### Task 3: Add failing mode/policy tests for first-class YOLO support
Objective: make “YOLO mode” explicit in fixtures before wiring behavior.

Files:
- Modify: `tests/contracts/mode-profile.contract.test.mjs`
- Create: `tests/contracts/policy-yolo.contract.test.mjs`
- Modify: `tests/contracts/policy-intent.contract.test.mjs`

Steps:
1. Add a mode-fixture expectation for a new `yolo` profile.
2. Add policy tests that describe exactly which intents remain prompt-gated in `yolo`.
3. Add tests that distinguish local workspace execution from remote runtime / MCP / background-task review.

Verify:
- `npm run test:contracts --silent`

---

## Phase 2 — Fix the real composer bug, not just symptoms

### Task 4: Introduce a display-width-aware composer utility seam
Objective: stop relying on raw JS string length for terminal cursor math.

Files:
- Create: `packages/tui/src/display-width.ts`
- Modify: `packages/tui/src/index.tsx`
- Modify: `tests/work/composer.test.mjs`
- Modify: `tests/contracts/tui-work-shell.contract.test.mjs`

Implementation notes:
- Prefer a tiny internal utility with explicit tests over a new dependency.
- Separate three concepts cleanly:
  - grapheme count
  - display width
  - string slicing by grapheme/display cell
- If you use `Intl.Segmenter`, keep the fallback behavior deterministic in tests.

Suggested seam:
```ts
export type DisplayCursor = { graphemeOffset: number; displayColumn: number };
export function getDisplayWidth(value: string): number;
export function sliceByDisplayWidth(value: string, start: number, end?: number): string;
```

Verify:
- `npm run test:work --silent`
- `npm run test:contracts --silent`

### Task 5: Replace width-naive cursor/rendering logic in `Composer`
Objective: make the live composer render wide characters correctly without regressing paste or multiline support.

Files:
- Modify: `packages/tui/src/composer.tsx`
- Modify: `packages/tui/src/work-shell-hooks.ts`
- Modify: `packages/tui/src/work-shell-pane.tsx`
- Modify: `tests/work/repl.test.mjs`

Steps:
1. Replace `.length`-based cursor math with the new display-width seam.
2. Make `getCursorPosition()` and `renderComposerLine()` operate on display columns, not code-unit indexes.
3. Preserve fast-path plain-text typing and existing paste suppression behavior.
4. Keep masked input (`/auth key`) aligned with the same cursor logic.

Manual verification:
- Open the work shell.
- Type `한글 테스트`, move left/right, backspace in the middle, add `🙂`, add newline with `Shift+Enter`.
- Confirm cursor, inverse highlight, and wrapped output do not drift.

Verify:
- `npm run test:work --silent`
- `npm run test:tui --silent`

---

## Phase 3 — Fix the “slow product” perception at the launcher boundary

### Task 6: Separate production launch from build-on-launch dev flow
Objective: remove the biggest fake performance regression: mandatory build on every `npm run unclecode`.

Files:
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/integration/unclecode-performance.integration.test.mjs`

Steps:
1. Change the default `unclecode` script to run built output directly.
2. Add an explicit dev helper such as `unclecode:dev` or `unclecode:build-run` for the current build-then-run behavior.
3. Update README quick start so operators use the fast path by default.
4. Keep the performance integration suite measuring the real product path, not the old dev convenience path.

Suggested script split:
```json
{
  "unclecode": "node apps/unclecode-cli/dist/index.js",
  "unclecode:dev": "npm run build --silent && node apps/unclecode-cli/dist/index.js"
}
```

Verify:
- `time npm run unclecode -- --help`
- `node apps/unclecode-cli/dist/index.js doctor --json`
- `npm run test:integration:performance --silent`

### Task 7: Add explicit startup/resume perf reporting for product paths
Objective: keep the “fast by default” promise visible and enforceable.

Files:
- Modify: `apps/unclecode-cli/src/fast-doctor.ts`
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: `tests/integration/unclecode-performance.integration.test.mjs`
- Modify: `docs/plans/2026-04-05-unclecode-post-plan-followup-refactor-roadmap.md` (reference only if you want to check off linked debt)

Steps:
1. Keep existing doctor/research budgets.
2. Add a reported metric for the effective launcher path when invoked via CLI commands that users actually run.
3. Fail loudly when product-path budgets regress.

Verify:
- `npm run test:integration:performance --silent`

---

## Phase 4 — Make slash surfaces honest and complete

### Task 8: Unify builtins, slash registry, and panel/help copy
Objective: remove the current “implemented but undiscoverable” mismatch.

Files:
- Modify: `packages/orchestrator/src/command-registry.ts`
- Modify: `packages/orchestrator/src/work-shell-slash.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-commands.ts`
- Modify: `packages/tui/src/work-shell-panels.ts`
- Modify: `packages/tui/src/work-shell-view.tsx`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`

Steps:
1. Add `/skills`, `/skill <name>`, `/tools`, and `/queue` to the discoverable registry/suggestion path.
2. Keep `/auth key` as a secure builtin, but make it appear intentionally.
3. Ensure panel/help copy reflects the actual registry.
4. Preserve extension command injection order.

Verify:
- `node --conditions=source --import tsx --input-type=module - <<'JS' ... getWorkShellSlashSuggestions(...)`
- `npm run test:work --silent`
- `npm run test:commands --silent`

### Task 9: Add a real `/queue` operator surface
Objective: expose queued/running approvals and work state as a first-class shell command.

Files:
- Modify: `packages/orchestrator/src/work-shell-engine-commands.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-builtins.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-builtin-runtime.ts`
- Modify: `packages/tui/src/shell-state.ts`
- Modify: `packages/tui/src/dashboard-shell.tsx`
- Modify: `packages/tui/src/work-shell-panels.ts`
- Modify: `tests/tui/shell-state.test.mjs`
- Modify: `tests/performance/backpressure.test.mjs`

Design:
- `/queue` should be read-only first.
- Show, at minimum:
  - active approvals
  - running workers
  - queued workers/sessions if known
  - current action id
- Do not invent backend queue persistence yet; surface the queue/state that already exists in the shell runtime.

Verify:
- `npm run test:tui --silent`
- `npm run test:work --silent`

---

## Phase 5 — Add first-class YOLO behavior instead of scattered heuristics

### Task 10: Add a `yolo` mode profile across contracts, config, and CLI surfaces
Objective: make YOLO an explicit mode the product can explain, persist, and test.

Files:
- Modify: `packages/contracts/src/modes.ts`
- Modify: `packages/config-core/src/defaults.ts`
- Modify: `packages/config-core/src/resolver.ts`
- Modify: `packages/orchestrator/src/work-config.ts`
- Modify: `apps/unclecode-cli/src/program.ts`
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: `apps/unclecode-cli/src/fast-mode.ts`
- Modify: `packages/tui/src/work-shell-view.tsx`
- Modify: `tests/contracts/mode-profile.contract.test.mjs`

Proposed initial profile:
- id: `yolo`
- label: `YOLO`
- editing: `allowed`
- searchDepth: `balanced`
- backgroundTasks: `preferred`
- explanationStyle: `concise`
- reasoningDefault: `medium`

Rationale:
- faster than `ultrawork`
- more action-biased than `default`
- still a product-visible mode, not a hidden hack

Verify:
- `node apps/unclecode-cli/dist/index.js mode set yolo`
- `node apps/unclecode-cli/dist/index.js mode status`
- `npm run test:contracts --silent`

### Task 11: Convert “permission stall auto-continue” into explicit YOLO policy behavior
Objective: stop relying on one post-processing prompt to simulate autonomy.

Files:
- Modify: `packages/policy-engine/src/types.ts`
- Modify: `packages/policy-engine/src/decision-table.ts`
- Modify: `packages/policy-engine/src/overrides.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-turns.ts`
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-factory.ts`
- Modify: `tests/contracts/policy-yolo.contract.test.mjs`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`

Policy target:
- `yolo` should auto-allow local workspace tool execution by default.
- `yolo` should still prompt for:
  - MCP server actions
  - remote runtime actions
  - background tasks with external side effects
- keep `autoContinueOnPermissionStall` only as a bounded fallback, not the main autonomy mechanism.

Verify:
- `npm run test:contracts --silent`
- `npm run test:work --silent`

---

## Phase 6 — Add Codex/external orchestration-style harness controls instead of ad-hoc repo tweaking

### Task 12: Add a first-class `harness` command family
Objective: give operators an UncleCode-native place to inspect/apply low-friction Codex/external orchestration settings.

Files:
- Create: `apps/unclecode-cli/src/harness.ts`
- Modify: `apps/unclecode-cli/src/program.ts`
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: `apps/unclecode-cli/src/command-router.ts`
- Create: `tests/commands/unclecode-harness.contract.test.mjs`

Initial subcommands:
- `unclecode harness status`
- `unclecode harness apply yolo`
- `unclecode harness explain`

Status should inspect:
- project `.codex/config.toml`
- presence of external Codex orchestration features (`multi_agent`, MCP servers, status line)
- whether current harness settings match the expected YOLO preset

Apply should:
- merge only the safe, project-scoped settings
- never wipe user-specific notify hooks, absolute MCP paths, or unrelated sections
- print a diff-like summary of what changed

Verify:
- `node apps/unclecode-cli/dist/index.js harness status`
- `node apps/unclecode-cli/dist/index.js harness explain`
- `npm run test:commands --silent`

### Task 13: Define a bounded YOLO harness preset anchored in `.codex/config.toml`
Objective: make “external Codex orchestration-like low friction” concrete and reversible.

Files:
- Modify: `.codex/config.toml` (via harness command, not by hand in tests)
- Modify: `apps/unclecode-cli/src/harness.ts`
- Modify: `tests/commands/unclecode-harness.contract.test.mjs`

Preset scope:
- preserve existing `notify`, model, and MCP wiring unless explicitly overridden
- tune only what reduces needless operator interruption, for example:
  - reasoning effort default for interactive work
  - approvals review posture metadata if supported
  - TUI status-line defaults
  - project trust level
  - external Codex orchestration feature toggles already present in the repo

Important guardrail:
- because `.codex/config.toml` already contains project-specific absolute paths and MCP setup, apply must be a structured merge, not template overwrite.

Verify:
- run `unclecode harness apply yolo`
- inspect resulting `.codex/config.toml`
- run `npm run external-codex-orchestration:doctor`

---

## Phase 7 — Finish the skill/plugin/agent runtime story

### Task 14: Complete plugin manifest runtime support for commands, skills, hooks, and agents
Objective: close the current gap between manifest discovery and actual runtime effect.

Files:
- Modify: `packages/orchestrator/src/extension-registry.ts`
- Modify: `packages/orchestrator/src/command-registry.ts`
- Modify: `packages/contracts/src/commands.ts`
- Modify: `packages/context-broker/src/workspace-skills.ts`
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: `tests/commands/*`
- Modify: `tests/context-broker/*`
- Modify: `tests/integration/*`

Steps:
1. Extend manifest schema beyond `commands/config/status`.
2. Add deterministic load order: builtin → user → project.
3. Surface manifest load failures honestly in doctor/status output.

Verify:
- `npm run test:commands --silent`
- `npm run test:context-broker --silent`
- `npm run test:integration --silent`

### Task 15: Add real runtime skill matching and prompt injection
Objective: move from “skills can be listed/loaded” to “relevant skills influence work turns.”

Files:
- Modify: `packages/context-broker/src/workspace-skills.ts`
- Modify: `packages/context-broker/src/workspace-guidance.ts`
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Modify: `packages/orchestrator/src/work-agent.ts`
- Modify: `tests/context-broker/workspace-skills.test.mjs`
- Modify: `tests/work/workspace-guidance.test.mjs`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`

Steps:
1. Keep `/skills` and `/skill` UX intact.
2. Add a match → load → inject seam for work turns.
3. Keep loading lazy and bounded.
4. Add diagnostics so operators can see which skills actually matched.

Verify:
- `npm run test:context-broker --silent`
- `npm run test:work --silent`

---

## Phase 8 — Raise product polish to the pi-agent quality bar

### Task 16: Upgrade status chrome, reasoning visibility, and operator wording
Objective: make the shell feel fast and product-like, not enum-like or wireframe-like.

Files:
- Modify: `packages/tui/src/work-shell-view.tsx`
- Modify: `packages/tui/src/work-shell-panels.ts`
- Modify: `packages/tui/src/dashboard-shell.tsx`
- Modify: `tests/contracts/tui-work-shell.contract.test.mjs`
- Modify: `tests/work/repl.test.mjs`

Concrete product debt observed in the live screenshot/code:
- reasoning is currently buried inline in one sentence (`gpt-5.4 · Light thinking · Search mode · Saved OAuth`)
- auth/mode/reasoning/runtime are rendered as one flat metadata line
- the giant bordered `Conversation` header box wastes space and looks like unfinished scaffolding
- chat labels use `Request` / `Answer`, which feels robotic and awkward
- the shell relies on too many similar bordered cards, weakening hierarchy

Steps:
1. Replace raw labels with product language everywhere.
2. Break the current metadata soup into grouped, scan-friendly status chrome:
   - model
   - reasoning/thinking
   - mode
   - auth
   - runtime/activity
3. Make reasoning/thinking a dedicated, obvious operator signal instead of just one inline token in the status sentence.
4. Remove or radically shrink decorative empty chrome like the bordered `Conversation` header block.
5. Rework message presentation so the chat feels like a conversation thread rather than stacked admin cards.
6. Replace `Request` / `Answer` with more natural operator-facing labels, or prove that labels can be removed safely.
7. Keep the current status strip, but expand it to include:
   - turn latency
   - queue/approval counts when non-zero
   - token/usage facts if available later
8. Ensure internal planning/self-talk never leaks into operator-facing copy.

Verify:
- `npm run test:tui --silent`
- `npm run test:work --silent`
- manual smoke test in the interactive shell

### Task 17: Add final manual acceptance matrix
Objective: prevent “tests pass, product still feels bad” regressions.

Files:
- Create: `docs/checklists/unclecode-manual-acceptance.md`
- Modify: `README.md`

Manual matrix:
- Korean/Hangul typing
- emoji typing
- multiline editing
- reasoning/thinking visibility at a glance
- status chrome readability (no metadata soup)
- conversation hierarchy without giant empty header boxes
- message labels/readability in real chat flow
- `/skills` discoverability
- `/queue` visibility
- `mode set yolo`
- `harness status/apply yolo`
- fast launch from built dist
- resumed session path

Verify:
- walk the checklist once after implementation

---

## Recommended execution order
1. Task 1-5 (lock and fix IME/composer correctness)
2. Task 6-7 (launcher/perf)
3. Task 8-9 (`/queue` + slash parity)
4. Task 10-13 (YOLO mode + harness)
5. Task 14-15 (plugin/skill/agent runtime)
6. Task 16-17 (product polish + manual acceptance)

## Verification bundle
Run after each phase:
- `npm run test:contracts --silent`
- `npm run test:commands --silent`
- `npm run test:tui --silent`
- `npm run test:work --silent`
- `npm run test:integration:performance --silent`

Run before merge:
- `npm run lint`
- `npm run check`
- `npm run build`

## Known risks
- display-width logic is easy to get almost-right and still wrong for edge cases; keep tests focused on real Korean/CJK/emoji cases.
- `.codex/config.toml` is user/path-sensitive; harness apply must merge, not overwrite.
- a real YOLO mode without explicit policy boundaries can create silent safety regressions; keep remote/MCP/background-task review explicit.
- `/queue` should ship read-only first; do not invent lifecycle semantics you cannot persist honestly.
