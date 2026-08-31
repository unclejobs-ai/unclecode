# 2026-08-18 User-Reported TUI Hotfix Handoff

> Historical handoff. The authoritative hierarchy, implementation decisions, and acceptance status
> are tracked in `2026-08-31-tui-p0-stability-hierarchy.md`.

## Objective

Unclecode의 사용자 체감 결함 4개를 실제 코드로 수정하고, 레퍼런스 화면 수준의 세련된 Live Progress UI까지 구현·검증한다.

## User-confirmed problems

1. **Transcript scrolling is unusable**
   - 긴 대화에서 과거 내용을 위로 볼 수 없음.
   - 문서상 PageUp/PageDown 지원 여부가 아니라 실제 사용자 부트 화면에서 동작해야 함.

2. **Korean support remains broken**
   - 첨부 화면에서 한글 음절 간격이 비정상적으로 벌어짐.
   - Unicode cell width, wrapping, IME composition, cursor/editing, resize/scroll row math를 함께 점검해야 함.

3. **Queue UX is ambiguous**
   - Queue, Live Progress/Plan, Jobs/Agents의 역할이 혼재.
   - 기존 read-only 4-column mini-kanban은 queue 순서와 직접 관리 행동을 명확히 전달하지 못함.

4. **Approval policy and UI disagree**
   - `Always allowed: bash` 이후 다시 `Approval needed bash`가 발생.
   - 카드 제목은 bash 전체 허용처럼 보이나 저장 scope는 `ln:*`로 표시.
   - 성공 알림 중복과 running/approval race 가능성도 확인 필요.

## Desired visual direction

사용자 레퍼런스처럼 composer 바로 위에 컴팩트한 Live Progress를 둔다.

```text
✓ Phase 1: completed task
○ Phase 2: current task 2/5
○ Phase 3: pending task
… +6 more · 3/9 done · 6 pending · Ctrl+T expand

⠋ Loading 25s · Enter queue · Ctrl+X steer · Ctrl+O tool history · Esc stop
────────────────────────────────────────────────────────────────────
> 
```

Scrolled state should expose both directions and a direct latest action, e.g. earlier/newer row counts plus PageUp/PageDown or macOS Fn equivalents.

## Product boundaries

- **Live Progress / Plan:** current request's internal task graph and progress.
- **Queue:** user follow-ups that run after the current turn, ordered `Next`, `#2`, `#3`.
- **Jobs/Agents:** asynchronous or parallel executions.
- Do not present these as one generic queued/running/done board.

## Existing planning artifacts

- `docs/plans/2026-08-18-scroll-usability-hotfix-todo.md`
- `docs/plans/2026-08-18-korean-terminal-support-hotfix-todo.md`
- `docs/plans/2026-08-18-approval-policy-ui-hotfix-todo.md`
- `docs/plans/2026-08-18-queue-ux-redesign-todo.md`
- `docs/plans/2026-08-18-polished-live-progress-ui-target.md`
- Existing queue design: `docs/design/work-queue-board-t15.md`
- Existing scroll work: `docs/glm-hammer/plans/2026-08-15-tui-main-ux-overhaul.md` Task 11 and `docs/glm-hammer/plans/2026-08-16-tui-tool-trace-stability.md` Tasks 3/7.

## Initial code finding

`packages/tui/src/work-shell-hooks.ts` already has transcript PageUp/PageDown handling and pane-owned `transcriptScrollOffset`.

Important suspected defect: the `useEffect` keyed by `engineState.entries` resets `transcriptScrollOffset` to `0` whenever the visible-entry anchor changes. This contradicts the desired behavior of preserving the user's scroll position while new output arrives and should be investigated first. Do not assume it is the only cause; reproduce through the real `bin → rust → node dist` path.

Ink renderer capabilities currently declare `mouseEvents: false` in `packages/tui/src/renderer-capabilities.ts`; mouse-wheel support may require a renderer/input-layer decision rather than a small hook patch.

## Recommended execution order

### Phase 1 — Reproduce and lock tests

1. Capture `git status`; preserve unrelated user changes.
2. Build current `dist` and reproduce all four issues in a small tmux pane.
3. Add failing tests before behavioral changes:
   - scroll position preservation and actual PageUp/PageDown input;
   - Korean width/wrap/IME editing;
   - approval canonical scope and dedupe/race;
   - Queue/Live Progress/Jobs model separation.

### Phase 2 — P0 fixes

1. Scroll keyboard path, viewport math, arrival behavior, latest return, runtime smoke.
2. Korean display width/wrap and composer grapheme/IME behavior.
3. Approval card label, persisted rule key, matcher, dedupe, state transition.

### Phase 3 — UX redesign

1. Separate Live Progress from Queue and Jobs.
2. Implement compact progress list with completed/current/pending states and `+N more` expansion.
3. Redesign `/queue` as an ordered, actionable follow-up list; add remove/reorder/clear/resume only where backend semantics are real.
4. Add clear scroll-position UI and macOS key hints.

### Phase 4 — Verification

Run format, lint, typecheck, focused tests, full TUI/contracts/CLI tests, Rust tests, build, then real runtime QA. Report any pre-existing failures separately and honestly.

## Required acceptance evidence

- Long conversation can scroll up/down and return to latest in the actual user launch path.
- New streaming output does not yank a scrolled reader to bottom.
- Korean mixed text renders without abnormal spacing and edits correctly with macOS IME.
- `Always allow` display, stored scope, and next policy decision agree; no duplicate success row.
- Queue order and actions are understandable; Queue is not confused with Live Progress or Jobs.
- Compact Live Progress renders correctly at narrow and wide terminal sizes.

## Current blocker

No source implementation or verification was completed in this session. `run_shell` remained disabled by execution policy even after repeated attempts. The next session must start with shell execution enabled, for example by launching Unclecode with:

```bash
UNCLECODE_ALLOW_RUN_SHELL=1 unclecode
```

Do not claim completion based on the planning documents. Completion requires code changes plus automated and real-runtime evidence.
