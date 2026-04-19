# Manual shell dogfooding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the improved work shell UX across iTerm2, Ghostty, kitty, and VSCode terminals and capture findings.

**Architecture:** No code changes expected; focus is on running the built CLI (`npm run unclecode`) and exercising `/model`, slash panels, busy turns, and multiline composer interactions. Observations are logged in a dedicated testing report file for future reference.

**Tech Stack:** Node 22+, npm scripts, UncleCode CLI, macOS terminals (iTerm2, Ghostty, kitty, VSCode integrated terminal).

---

### Task 1: Prepare workspace & build artifacts

**Files:**
- Modify: _none_
- Test/Output: shell commands only

- [ ] **Step 1: Install dependencies**

```bash
npm install
```

Expected: completes without errors; ensures latest dependencies are present.

- [ ] **Step 2: Build workspace artifacts**

```bash
npm run build
```

Expected: succeeds, producing `dist-work/` outputs to guarantee CLI uses fresh seams.

- [ ] **Step 3: Verify key test suites still green prior to manual validation**

```bash
npm run test:contracts && \
npm run test:orchestrator && \
npm run test:tui
```

Expected: all pass, confirming code baseline is clean before manual checks.

---

### Task 2: Create shared dogfooding log template

**Files:**
- Create: `docs/testing/2026-04-09-work-shell-dogfooding.md`

- [ ] **Step 1: Scaffold log file with per-terminal sections**

```markdown
# Work shell dogfooding — 2026-04-09

## Common setup
- commit: <git rev-parse HEAD>
- build timestamp: <ISO8601>

## iTerm2 findings
- status strip:
- slash panel:
- multiline composer:
- busy turns:
- transcript readability:

## Ghostty findings
...
```

Expected: file contains placeholders for each terminal, matching the metrics listed in the handoff.

- [ ] **Step 2: Commit template (optional) or leave staged for execution phase**

```bash
git add docs/testing/2026-04-09-work-shell-dogfooding.md
```

(Commit after all findings recorded.)

---

### Task 3: iTerm2 validation run

**Files:**
- Modify: `docs/testing/2026-04-09-work-shell-dogfooding.md`

- [ ] **Step 1: Launch iTerm2 session in repo root**

Open iTerm2 window, ensure `$PWD` is `/Users/parkeungje/project/unclecode`.

- [ ] **Step 2: Start work shell**

```bash
npm run unclecode
```

- [ ] **Step 3: Validate `/model` navigation churn**

Within shell:
```
/model
```
Cycle through models twice, noting redraw stability.

- [ ] **Step 4: Validate slash drawer open/close**

Use `/` key to open drawer, arrow through entries, confirm layout stability, close with `Esc`.

- [ ] **Step 5: Exercise multiline composer**

```
Shift+Enter
Type multi-line prompt describing reproduction test
Submit with Enter
```

Record whether indentation/chars behave correctly.

- [ ] **Step 6: Trigger busy state**

```
/work "Summarize the last reply with extra detail and wait 5 seconds"
```

Observe busy indicator + elapsed timer updates.

- [ ] **Step 7: Log observations**

Update iTerm2 section in log with raw notes, screenshots if needed.

---

### Task 4: Ghostty validation run

**Files:**
- Modify: `docs/testing/2026-04-09-work-shell-dogfooding.md`

Repeat Task 3 steps inside Ghostty:

- [ ] Launch Ghostty in repo root.
- [ ] Run `npm run unclecode`.
- [ ] Check `/model` navigation churn.
- [ ] Validate slash drawer open/close cycle.
- [ ] Exercise multiline composer via `Shift+Enter`.
- [ ] Trigger busy state (same command) and watch indicators.
- [ ] Log Ghostty-specific observations in the report.

Note Ghostty-specific rendering quirks (e.g., ligatures, GPU acceleration) if they affect UI.

---

### Task 5: kitty validation run

**Files:**
- Modify: `docs/testing/2026-04-09-work-shell-dogfooding.md`

- [ ] Launch kitty, cd to repo root.
- [ ] Run `npm run unclecode`.
- [ ] `/model` navigation churn test.
- [ ] Slash drawer open/close stability.
- [ ] Multiline composer editing feel.
- [ ] Busy turn behavior.
- [ ] Log kitty findings (include whether kitty’s font rendering or GPU scaling introduces drift).

---

### Task 6: VSCode terminal validation run

**Files:**
- Modify: `docs/testing/2026-04-09-work-shell-dogfooding.md`

- [ ] Open VSCode workspace -> integrated terminal at repo root.
- [ ] Run `npm run unclecode`.
- [ ] `/model` churn test.
- [ ] Slash drawer open/close.
- [ ] Multiline composer.
- [ ] Busy turn observation.
- [ ] Record VSCode-specific findings (e.g., how panel resizing impacts layout, any keybinding conflicts).

---

### Task 7: Cross-terminal comparison & summary

**Files:**
- Modify: `docs/testing/2026-04-09-work-shell-dogfooding.md`

- [ ] **Step 1: Synthesize issues**

Add final section summarizing:
- repeated problems across terminals
- terminal-specific glitches
- positive confirmations (what is solid)

- [ ] **Step 2: Recommend follow-ups**

List actionable items (e.g., adjust slash-panel redraw) referencing files like `packages/tui/src/work-shell-pane.tsx` if issues observed.

- [ ] **Step 3: Stage log file**

```bash
git add docs/testing/2026-04-09-work-shell-dogfooding.md
```

- [ ] **Step 4: (Optional) Commit manual report**

```bash
git commit -m "docs: record 2026-04-09 terminal dogfooding results"
```

Commit only if required; otherwise leave staged for inclusion with related fixes.

---

### Task 8: Final verification & cleanup

**Files:**
- Modify: as needed

- [ ] **Step 1: Re-run smoke test**

```bash
npm run test:contracts && npm run test:tui
```

Ensures no regressions introduced while testing (should still be green).

- [ ] **Step 2: Update handoff doc references if needed**

If findings affect follow-up plan, note summary in `docs/plans/2026-04-08-work-shell-followup-handoff.md`.

- [ ] **Step 3: Share summary with team**

Provide final report path and conclusions to maintain continuity.
