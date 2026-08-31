# UncleCode TUI + SCC P0 handoff

Date: 2026-08-31 Asia/Seoul  
Repository: `/Users/parkeungje/project/unclecode/.worktrees/unclecode-scc-integration`  
Branch: `feat/unclecode-scc-integration`  
Implementation checkpoint: `fddf84d943f97233e5780b7ead1ef4cf8ffa2b82`  
Status: **not merge-ready; implementation is preserved, verification is incomplete**

## User intent that must not drift

UncleCode is the only runtime harness. SCC is its in-process Quality Engine,
not a second daemon, MCP runtime, event store, or competing product surface.
The TUI is the primary work surface. The browser/web control room must not be
opened during this P0 verification; use a visible Herdr **terminal pane** only.

The immediate P0 is:

1. Stable Composer/input dock with Korean, CJK, emoji, IME-like edits, split
   panes, resize, long sessions, and a middle-of-draft cursor.
2. Real response-history scrolling in the alternate-screen TUI: PageUp,
   PageDown, macOS Fn equivalents, and End/latest. New output must not move a
   reader who is looking at older content.
3. `/scc` must be an actionable quality cockpit rather than an empty generic
   Agents/Jobs/Plan window. `/scc review <target>` remains the explicit
   model-backed review command.
4. One compact provider performance receipt showing truthful cache status,
   TTFT, generation tok/s, and cost without inventing missing evidence.
5. `Ctrl+O` remains **only** the compact/verbose tool-history display toggle.
6. English shell chrome stays English; Korean shell chrome stays Korean. User
   input by itself must not flip the chrome locale.

The approved hierarchy and responsive contract are in
`docs/plans/2026-08-31-tui-p0-stability-hierarchy.md`. Treat it as the design
source of truth.

## What is safely committed

Commit `fddf84d fix(tui): budget pinned composer frame` is the current HEAD.
It contains only:

- `packages/tui/src/composer.tsx`
- `packages/tui/src/work-shell-pane.tsx`
- `packages/tui/src/work-shell-view.tsx`
- `tests/tui/work-shell-empty-state.test.mjs`
- `tests/tui/work-shell-resize-reflow.test.mjs`

It removes the pane-level hardcoded cursor anchor, makes the rendered dock own
cursor geometry and row budgeting, bounds long CJK input at 9/10 rows, keeps
the footer visible, suppresses optional activity/trace rows when necessary,
and prevents a partial ASCII wordmark in small terminal heights. Focused
Composer/resize/empty-state verification reported 31/31 passing.

Earlier relevant committed checkpoints remain below it:

- `cb0442e` Anthropic cookbook adoption gates
- `fb10123` pinned SCC core checksum correction
- `f129ee9` Anthropic cache bucket pricing
- `95b03e0` Korean prompt dock baseline
- `10bf18d` bounded long-session transcript state
- `38945e2` shell chrome locale separated from turn language
- `e8f5ea0` oversized transcript entry paging
- `c2d4994` bounded owner sessions

No PR was created, nothing was pushed, and nothing was merged.

## Uncommitted P0 work preserved in the worktree

Four parallel tasks were interrupted at the user's request to make this
handoff. Their changes are intentionally **not** discarded.

### Transcript scroll input

Owned files:

- `packages/tui/src/work-shell-hooks.ts`
- `packages/tui/src/work-shell-input.ts`
- `tests/tui/work-shell-scrollback.test.mjs`

The patch adds one normalized transcript-navigation path, including ordinary
Ink PageUp/PageDown/End flags and Kitty keypad CSI-u fallbacks. It preserves a
non-empty draft, prevents an open Context/SCC/other overlay from scrolling the
transcript behind it, and retains the content-addressed anchor while streaming
and appending entries.

Observed passing cases include PageUp/PageDown, End/latest, Kitty keypad
PageUp/PageDown/End, non-empty draft preservation, overlay ownership, a
100-line single reply, CJK wrapping, streaming growth, append, and resize.
This patch is not committed and has not yet been tested through the rebuilt
Rust → Node → Ink launcher in Herdr.

### SCC focused quality view

Owned files:

- `packages/orchestrator/src/work-shell-agent-console-state.ts`
- `packages/tui/src/work-shell-agent-console-model.ts`
- `packages/tui/src/work-shell-agent-console-view.tsx`
- `tests/tui/work-shell-agent-console-render.test.mjs`
- `tests/tui/task4-quality-workspace.test.mjs`

The patch removes the dead empty roster/inspector behavior for the quality tab,
adds actionable no-run and active-no-history states, bounds a 32-failure
summary, and selects the latest review history event by default. Korean and
English copy is selected from the existing `uiLocale`; it does not switch on
the latest user message alone.

Observed focused renders passed for:

- empty `/scc`: no `Select a row`, no unusable Enter hint;
- active run without history;
- 32 findings without unbounded summary growth;
- latest history selection;
- populated quality evidence and hostile-string physical-height bounds.

This is still implemented inside the existing Agent Console quality route. A
later cleanup may extract a shared pure `QualityFocus` projection for TUI and
server, but that is not required before repairing the reported empty state.

### Provider cache/TTFT/tok-per-second receipt

Owned files:

- `packages/contracts/src/performance.ts` (new)
- `packages/contracts/src/agent-console.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/trace.ts`
- `packages/orchestrator/src/coding-agent.ts`
- `packages/orchestrator/src/work-shell-agent-console.ts`
- `packages/tui/src/index.tsx`
- `packages/tui/src/work-shell-performance-receipt.ts` (new)
- `tests/contracts/provider-performance.test.mjs` (new)
- `tests/orchestrator/coding-agent-performance.test.mjs` (new)
- `tests/orchestrator/work-shell-performance-projection.test.mjs` (new)
- `tests/tui/work-shell-performance-receipt.test.mjs` (new)

The patch records `firstTokenAt` only on the first non-empty assistant delta,
records `completedAt`, and projects one main-provider turn into a bounded
receipt. Executor/worker usage cannot replace the main provider receipt.

Semantics in the current tests:

- cache `HIT` only when provider `cacheReadTokens > 0`;
- cache `MISS` only when known usage reports zero;
- cache `n/a` when usage is absent;
- TTFT and tok/s are omitted rather than guessed;
- zero cost is not fabricated;
- the narrow receipt drops optional counters before wrapping.

Focused provider, trace, coding-agent, projection, and receipt tests were
observed passing. The patch is not committed and the receipt still needs to be
visually checked in the final dock after a real provider response.

### SCC artifact-store trust boundary

Owned files:

- `packages/orchestrator/src/quality-runtime.ts`
- `tests/work/quality-runtime.test.mjs`

The preserved patch adds immutable/idempotent evidence writes, artifact-root
ancestor checks, run and workspace aggregate caps, a bounded run admission
count, a usage index, dead stale-lock reclamation, and telemetry. The complete
focused suite currently passes:

```text
71 tests, 71 passed, 0 failed
```

It includes explicit tests for a symlinked artifact ancestor, workspace byte
cap, run cap, retained evidence, and stale-lock recovery.

One TypeScript error remains and is the first code fix to make:

```text
packages/orchestrator/src/quality-runtime.ts(1722,83):
TS18046: 'indexedTotalBytes' is of type 'unknown'.
```

Narrow `record.totalBytes` with `typeof indexedTotalBytes === "number"` before
calling `Number.isSafeInteger` and comparing it. Do not weaken the parser with
an unconditional cast.

## Other dirty files: preserve, do not stage with P0

The worktree was already dirty before this P0. These are user/earlier-agent
changes and must not be reverted or swept into a P0 commit without reviewing
their provenance:

- `.superpowers/sdd/2026-08-28-unclecode-scc-integration/*`
- `AGENTS.md`
- `packages/orchestrator/src/work-agent.ts`
- `tests/contracts/orchestrator-multi-agent.contract.test.mjs` (deleted)
- `tests/work/tools.test.mjs`
- `.devcontainer/`, `.tool-versions`, `rust-toolchain.toml`
- generated `.js`, `.d.ts`, and source-map files under orchestrator subtrees
- `packages/orchestrator/src/work-shell-engine-types.ts`
- earlier untracked UX plan/handoff documents under `docs/plans/`

Before committing any remaining P0 patch, stage exact paths only and inspect
`git diff --cached --name-status`.

## Verification snapshot

Verified at handoff:

- `git diff --check`: passed.
- `unclecode --version`: `0.1.0`.
- `~/.local/bin/unclecode` points to this worktree's `bin/unclecode.cjs`.
- `target/debug/unclecode` exists.
- committed Composer/resize/empty-state focused tests: 31/31 passed.
- uncommitted artifact-store suite: 71/71 passed.
- focused scroll, SCC cockpit, provider timing/cache, and receipt tests emitted
  no failures in the combined run and all named cases above passed.

Not green at handoff:

- `npm run check`: fails with the single `indexedTotalBytes` narrowing error
  shown above.
- full `npm run test:all`: not completed after the new P0 patches.
- `npm run build` and `cargo build -p unclecode`: not rerun after all
  uncommitted patches were combined.
- post-fix Herdr visual/PTY verification: not performed.
- independent post-fix review: not performed.
- PR, push, and merge: not performed.

An earlier pre-fix screenshot is available at `/tmp/unclecode-scc-empty.png`.
It is failure evidence only; do not use it as proof of the current patch.

## Exact continuation order

1. Work only in the integration worktree and re-read its current `AGENTS.md`.
2. Preserve all dirty files. Fix only the one TypeScript narrowing error.
3. Run:

   ```bash
   npm run check
   node --disable-warning=ExperimentalWarning --conditions=source --import tsx \
     --test --test-concurrency=1 \
     tests/tui/work-shell-resize-reflow.test.mjs \
     tests/tui/work-shell-empty-state.test.mjs \
     tests/tui/work-shell-scrollback.test.mjs \
     tests/tui/work-shell-agent-console-render.test.mjs \
     tests/tui/task4-quality-workspace.test.mjs \
     tests/contracts/provider-performance.test.mjs \
     tests/orchestrator/coding-agent-performance.test.mjs \
     tests/orchestrator/work-shell-performance-projection.test.mjs \
     tests/tui/work-shell-performance-receipt.test.mjs
   node --disable-warning=ExperimentalWarning --conditions=source --import tsx \
     --test --test-concurrency=1 tests/work/quality-runtime.test.mjs
   ```

4. Review each uncommitted ownership group separately and commit exact paths in
   this order: scroll, SCC cockpit, performance receipt, artifact store. Do not
   mix the unrelated dirty files listed above.
5. Run `npm run build` and `cargo build -p unclecode`.
6. Confirm `which unclecode` still resolves to this worktree, then launch the
   literal `unclecode` command from an unrelated repository.
7. In a visible Herdr terminal split, never a browser pane, verify:
   - 60×18 and a narrower 9/10-row split;
   - long Korean/CJK/emoji draft with the cursor moved into the middle;
   - streaming/busy activity without prompt/footer overlap or screen shake;
   - a long answer followed by PageUp/Fn+Up, PageDown/Fn+Down, and End;
   - new output while scrolled does not jump to latest;
   - `/scc` before a run, during an active run, and after gate evidence;
   - one cache/TTFT/tok/s/cost receipt after a real provider response;
   - `Ctrl+O` changes only tool-history detail;
   - English input keeps English chrome and Korean input does not globally
     force Korean chrome.
8. Capture numbered screenshots of the actual terminal states. A render string
   or unit-test snapshot is not visual acceptance evidence.
9. Run the full relevant Node/Rust suite only after the focused and live gates
   are green.
10. Ask an independent reviewer to inspect the frozen commit range for layout
    bounds, scroll ownership, locale rules, cache evidence semantics, SCC
    independence/freshness, artifact containment, idempotence, and memory
    bounds. Only then create the PR. Main merge and release remain human-
    approved.

## Merge blockers that must remain fail-closed

- A worker cannot approve its own result.
- Same-provider/different-label review is not independent evidence.
- A changed artifact invalidates its previous verdict.
- Missing critic/promote evidence is `unproven`, not silently `proceed`.
- SCC writes only to UncleCode session/agentops/artifact ownership; no SCC
  `.data` runtime or JSONL store is introduced.
- Artifact ancestors and leaf files cannot be symlinks; evidence is immutable
  and aggregate-bounded.
- Queue is user follow-up only; Plan, Jobs, Agents, approval, product decision,
  and quality gate remain separate types and surfaces.
- Performance/cache telemetry never becomes SCC quality evidence.

## Honest current verdict

The major fixes are present and the committed Composer/frame patch is green in
focused tests. The remaining uncommitted groups also have strong focused test
evidence, but the branch is **not complete** until the one type error is fixed,
the patches are reviewed and committed separately, the actual launcher is
built, and the user-reported behavior is visually verified in Herdr.
