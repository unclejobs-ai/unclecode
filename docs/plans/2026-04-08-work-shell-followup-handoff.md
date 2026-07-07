# UncleCode work-shell / OAuth / bootstrap follow-up handoff

> **Date:** 2026-04-08
> **Status:** Verified code state; remaining uncertainty is mostly manual terminal UX validation
> **Scope:** Legacy skill cleanup, OpenAI/Codex OAuth usability, packaged work bootstrap reachability, TUI product cleanup, and continuing `work-shell-engine` seam extraction

## Why this handoff exists

This branch already went through multiple focused cleanup/refactor passes. The risk now is not missing implementation effort; it is losing the thread and reopening solved problems.

This handoff records:
- what is already done and green
- what architectural decisions should not be casually reversed
- what still remains honestly unfinished
- where the next executor should start

---

## Current truth summary

### 1) Legacy `superpowers` behavior is removed

The repo no longer auto-discovers or honors the legacy always-on `superpowers` workflow path, especially the hidden `using-superpowers` meta-skill behavior.

Key outcomes:
- legacy `~/.agents/skills/superpowers/*` lookup removed from runtime discovery
- discovery now ignores legacy superpowers paths explicitly
- regression tests lock that behavior
- old docs under `docs/superpowers/` were removed in the 2026-07 repo cleanup (the flattening into `docs/plans/`/`docs/specs/` had already happened for the live content; the stale 2026-04-09 stubs were deleted as superseded)
- the local disabled superpowers directory was deleted

**Do not reintroduce hidden always-on skill injection.** Normal workspace/global skills are still supported; only the legacy superpowers pathing was removed.

### 2) CLI/bootstrap ownership is now app-owned

The app bootstrap path is substantially cleaner than before.

Important outcomes:
- stale root shims were removed
- session center / work bootstrap / launch input handling moved into dedicated app-owned seams
- packaged work launch now prefers `dist-work/apps/unclecode-cli/src/work-entry.js` but has a verified fallback to `apps/unclecode-cli/dist/work-entry.js`
- `bin/unclecode.cjs` and `work-bootstrap.ts` now agree on candidate work entrypoints

**Do not collapse packaged entrypoint handling back to a single assumed path.** The fallback exists because real builds exercised both layouts.

### 3) OpenAI OAuth is usable now, but only because runtime semantics were fixed honestly

The major auth bug was not just “OAuth broken.” It was a product-boundary mismatch:
- UncleCode originally modeled `openai` like the public OpenAI API path
- reused Codex/ChatGPT OAuth credentials actually belong to a Codex-style backend runtime contract

What is true now:
- placeholder `OPENAI_API_KEY` env values no longer incorrectly override reusable OAuth
- UncleCode can reuse Codex auth without requiring `model.request`
- saved UncleCode OAuth persists runtime metadata so Codex OAuth stays usable after storage
- the OpenAI runtime now internally branches between:
  - public API runtime
  - Codex backend runtime (`chatgpt.com/backend-api/codex/responses`)
- local end-to-end verification succeeded:
  - `auth status` showed reusable OAuth
  - `work "Reply with OK only."` returned `OK`

**Do not pretend Codex OAuth and OpenAI API auth are the same contract.** They currently share one outward `openai` provider label internally, but runtime behavior already treats them as distinct.

### 4) The work shell now reads more like a product and less like leaked debugger output

The shell had multiple operator-facing quality failures. Those were treated as real product bugs, not cosmetic polish.

Important outcomes:
- raw bridge/memory bookkeeping no longer pollutes the main transcript
- `bridge undefined`-style trace leakage was fixed
- Hangul/wide-character truncation now uses display width rather than naive string length
- worker/workflow labels are normalized for human-readable display
- top status guidance is shorter and more product-facing
- slash panels are stabilized at the bottom to reduce layout churn
- multiline composer support (`Shift+Enter`) was added
- plain-text composer preview uses a faster path when no slow context resolution is needed
- fake token/cost metrics were deliberately avoided; only honest timing signals are shown

**Do not reintroduce internal status enums, worker ids, or bookkeeping text into the operator transcript.**

### 5) `work-shell-engine.ts` is no longer the owner of every behavior family

A large amount of `work-shell-engine.ts` ownership has already been split into dedicated seams.

Current extracted helper families include:
- commands
- state
- turns
- post-turns
- trace
- persistence
- builtins
- operations
- execution
- panels
- context
- submit route classification
- lifecycle
- builtin runtime
- command runtime
- prompt runtime

The newest seam extracted in this latest pass:
- `packages/orchestrator/src/work-shell-engine-prompt-runtime.ts`
  - `executeWorkShellChatSubmit(...)`
  - `executeWorkShellPromptCommandSubmit(...)`

This means the engine is moving closer to coordinator-only ownership.

**Do not let `work-shell-engine.ts` regrow local prompt-submit adaptation or other helper-owned runtime paths.** Contract tests now lock that boundary.

---

## Important commits already on the branch

These commits are the meaningful handoff anchors.

- `c9f69d8` — Reduce agent overhead by dropping legacy superpowers hooks
- `6361850` — Make the app own interactive bootstraps and drop stale root shims
- `77d2029` — Finish retiring the interactive-shell router shim
- `29a0315` — Make reused Codex OAuth usable in the work shell
- `e9132ea` — Keep Codex device OAuth usable after credentials are saved
- `25c191b` — Keep packaged work entrypoints reachable during bootstrap handoff
- `4b8c5c1` — Finish extracting CLI/bootstrap helper seams for the app-owned startup path
- `185111f` — Make the TUI show workflow state instead of raw worker noise
- `5c4ff49` — Finish the remaining CLI/bootstrap follow-up seams
- `905c16a` — Make the work shell read like a product instead of debug output
- `811f848` — Finish splitting work-runtime ownership into explicit app seams
- `03a8ef5` — Make the shell feel faster and less like an internal debugger
- `e377e3b` — Finish extracting work-runtime bootstrap from the shell entrypoint
- `e710d01` — Reduce work-shell redraw churn around slash panels and model picking
- `4c04cf2` — Add a compact work-shell usage strip without inventing fake metrics
- `282e8b1` — Refresh the model picker catalog to emphasize current OpenAI defaults
- `d8437b4` — Make the work shell show live elapsed time instead of opaque busy state
- `b565216` — Cut busy redraw noise and split post-turn work out of the shell engine
- `b5d1503` — Memoize heavy shell panes and split trace helpers for steadier redraws
- `6a4693e` — Expose shared work-shell persistence helpers through the orchestrator seam
- `dce90d6` — Finish routing work-shell persistence through the shared helper seam
- `5b549b9` — Localize elapsed timer updates to the shell status strip
- `dcf10fa` — Keep memoized shell attachments stable across pane rerenders
- `d74d0d4` — Split shell builtins and inline operations out of the engine core
- `8775ab1` — Split prompt-turn execution and memory operations out of the shell engine
- `fc66e1c` — Move shell panel assembly and prompt turn sequencing out of the engine core
- `29736f5` — Extract trace-event patching and remaining panel assembly from the shell engine
- `d8e0435` — Route shell submissions and context reload state through dedicated helper seams
- `3c25068` — Clarify shell helper ownership around submit handling and context loading
- `bf15992` — Keep shell lifecycle and prompt-turn orchestration out of the engine core
- `681b63c` — Keep shell command and trace runtime flows out of the engine core
- `14c09e6` — Lock the new TUI seam roadmap with source-level contract coverage
- `aaa18c3` — Keep prompt submit adaptation out of the shell engine coordinator

---

## Verification status

### Last broad green verification before this handoff

These were run successfully during the latest implementation pass:
- `npm run lint`
- `npm run check`
- `npm run test:tui`
- `npm run test:orchestrator`
- `npm run test:work`
- `npm run test:contracts`
- `npm run build`

### Latest targeted seam verification

Prompt-runtime extraction was additionally verified with:
- `node --conditions=source --import tsx --test tests/contracts/orchestrator-work-shell.contract.test.mjs tests/orchestrator/work-shell-engine.test.mjs`

### What is still not verified enough

Manual terminal dogfooding remains the main gap:
- iTerm2
- Ghostty
- kitty
- VSCode terminal

The code/test/build state is green. The remaining uncertainty is mainly perceived redraw quality, layout stability, and terminal-specific behavior.

---

## Remaining risks and honest gaps

### 1) Manual UX validation is still incomplete

The shell has been improved substantially, but there is still no recorded multi-terminal validation proving that ghosting/redraw perception is now good enough in real use.

Validate specifically:
- `/model` navigation churn
- slash drawer open/close stability
- long-running busy turns
- multiline composer editing feel
- recent-sessions/context/status overlay transitions

### 2) Real usage/token accounting is still intentionally unimplemented

The current usage strip is honest because it only shows timing-based data (`elapsed`, `last reply`).

There is still no trustworthy token/cost accounting seam.

**Do not invent token/cost numbers just to make the shell feel richer.**

### 3) `work-shell-engine.ts` may still have smaller extractable hotspots

The major behavior families are already extracted, but the file may still contain some residual orchestration clusters worth trimming later.

Any future extraction should stay narrow and paired with:
- direct seam tests
- source-level contract locks
- full regression rerun before commit

### 4) Public provider naming is still transitional

Internally, the runtime now distinguishes API vs Codex behavior honestly. Externally, the product still presents one outward `openai` provider lane in several places.

There is already a plan document for a future explicit split:
- `docs/plans/2026-04-07-openai-codex-provider-implementation.md`

That split is still optional future work, not current truth.

**Do not claim the explicit provider split is already complete.**

---

## Recommended next execution order

### Priority 1 — Manual shell dogfooding

Run the actual shell in:
- iTerm2
- Ghostty
- kitty
- VSCode terminal

Check:
1. slash panel stability
2. busy indicator behavior
3. multiline editing feel
4. top status strip churn
5. transcript readability during real work

If visual churn is still obvious, profile the remaining hot paths around:
- `packages/tui/src/work-shell-pane.tsx`
- `packages/tui/src/work-shell-view.tsx`
- slash suggestion/panel prop churn
- top status/usage strip update cadence

### Priority 2 — Continue only narrow seam extraction

If further orchestrator cleanup is needed, keep extracting small owner seams from `packages/orchestrator/src/work-shell-engine.ts` rather than attempting a large rewrite.

Rules for the next pass:
- one behavior family at a time
- lock it with contract coverage
- rerun targeted tests first
- rerun full regression before commit
- keep the engine as coordinator glue, not helper owner

### Priority 3 — Only then consider explicit `openai-api` / `openai-codex` split

If product clarity around provider choice/auth guidance still matters after dogfooding, use the existing implementation plan instead of improvising:
- `docs/plans/2026-04-07-openai-codex-provider-implementation.md`

That work should preserve these truths:
- Codex OAuth is not the same as OpenAI API auth
- `model.request` belongs to API semantics, not Codex semantics
- legacy `openai` compatibility should be preserved deliberately if changed

---

## Files most likely to matter next

### Runtime / orchestrator
- `packages/orchestrator/src/work-shell-engine.ts`
- `packages/orchestrator/src/work-shell-engine-prompt-runtime.ts`
- `packages/orchestrator/src/work-shell-engine-execution.ts`
- `packages/orchestrator/src/work-shell-engine-submit.ts`
- `packages/orchestrator/src/work-shell-engine-trace.ts`
- `packages/orchestrator/src/index.ts`

### TUI / UX
- `packages/tui/src/work-shell-view.tsx`
- `packages/tui/src/work-shell-pane.tsx`
- `packages/tui/src/work-shell-panels.ts`
- `packages/tui/src/work-shell-hooks.ts`
- `packages/tui/src/composer.tsx`
- `packages/tui/src/index.tsx`

### App bootstrap / runtime
- `apps/unclecode-cli/src/work-runtime.ts`
- `apps/unclecode-cli/src/work-runtime-bootstrap.ts`
- `apps/unclecode-cli/src/program.ts`

### OAuth / provider behavior
- `packages/providers/src/openai-auth.ts`
- `packages/providers/src/openai-oauth.ts`
- `packages/providers/src/openai-credential-store.ts`
- `packages/providers/src/runtime.ts`
- `packages/orchestrator/src/work-config.ts`

### Contract locks
- `tests/contracts/orchestrator-work-shell.contract.test.mjs`
- `tests/orchestrator/work-shell-engine.test.mjs`
- `tests/contracts/tui-work-shell.contract.test.mjs`
- `tests/contracts/tui-dashboard.contract.test.mjs`
- `tests/contracts/unclecode-cli.contract.test.mjs`

---

## Non-negotiable handoff guidance

- Do not reintroduce legacy `superpowers` auto-loading or meta-skill execution.
- Do not collapse Codex-backed OAuth into public OpenAI API semantics.
- Do not let placeholder `OPENAI_API_KEY` env values override reusable OAuth again.
- Do not leak bridge/memory/internal trace bookkeeping into the operator transcript.
- Do not fake token/cost usage metrics.
- Do not weaken seam contracts just because a helper extraction made an old regex stale; implement or realign the true seam instead.
- Do not turn the current narrow seam-extraction strategy into a broad rewrite.

---

## Suggested commit discipline for the next executor

Keep the same pattern that worked in this branch:
1. identify one narrow hotspot
2. write/update the contract lock first
3. extract the real owner seam
4. rerun targeted tests
5. rerun broad regression
6. commit only when green and clean

Use Lore-style commit messages with explicit constraints/rejections/verification notes.

---

## Cross-reference docs

- Follow-up roadmap: `docs/plans/2026-04-05-unclecode-post-plan-followup-refactor-roadmap.md`
- TUI/orchestration redesign plan: `docs/plans/2026-04-05-unclecode-tui-orchestration-redesign.md`
- OpenAI/Codex split plan: `docs/plans/2026-04-07-openai-codex-provider-implementation.md`
- OpenAI/Codex design context: `docs/specs/2026-04-07-openai-codex-provider-design.md`
- Historical cutover evidence: `.sisyphus/evidence/2026-04-05-single-process-cutover.md`

---

## Bottom line

The repo is in a much better state than the earlier conversation implied:
- legacy hidden superpowers behavior is gone
- Codex-backed OAuth actually works for UncleCode work turns locally
- packaged work entrypoints are reachable again
- the shell is noticeably less debuggy and more product-shaped
- the engine is steadily becoming a coordinator instead of a monolith

The biggest remaining truth is simple:
**the next high-value step is manual dogfooding, not another blind rewrite.**
