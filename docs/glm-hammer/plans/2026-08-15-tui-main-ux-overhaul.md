# 2026-08-15 TUI Work Shell UX Overhaul

## Goal

메인 work shell 화면의 크롬을 "상황별 미니멀"로 개편하고, 첫 실행 경험(스타터 프롬프트), 디시전 원키 응답, `?` 키맵 단축키로 워크플로 마찰을 제거하여 세련되고 직관적인 메인 화면을 만든다. 아울러(2026-08-15 사용자 리다이렉트) 진행 중 작업 표시(스피너·활동 구문·툴 트레이스)는 **컴포저 바로 위에 고정**되어 사용자 오인을 방지하고, 툴 콜 과정이 busy 중 라이브로 보이며, alt-screen 제약 안에서 트랜스크립트 스크롤백(PageUp/PageDown)이 가능해야 한다. (2026-08-15 두 번째 리다이렉트) 빈 화면은 단축키 나열이 아니라 **세련된 ASCII 워드마크 브랜딩**으로 아이덴티티를 갖고, 컨텍스트 프루프 라인과 컨텍스트 데스크가 **불필요한 공간을 차지하지 않는다**(프루프 컴팩트화 + 제출 시 데스크 자동 닫힘).

## Architecture

모든 변경은 TS 계층(packages/tui + packages/orchestrator 엔진 메서드 2개)에 머문다. Rust `ux_input.rs`/`ux_panels.rs`/`ux_text.rs`, 계약 타입 유니언, 팔레트(ANSI 상속 `W` 프록시), 트랜스크립트 엔트리 표현, 오버레이(컨텍스트 데스크·에이전트 콘솔·텔레메트리) 내부는 건드리지 않는다. 새 핫키(스타터 `1/2/3`, 디시전 `1..9`/`Esc`, `?`)는 기존 telemetry 핫키 패턴처럼 `useWorkShellInputController`(TS)의 기존 키 사다리에서 **가장 마지막(데스크/콘솔/텔레메트리 소유자들 다음, Rust 리졸버 직전)** 에 소비하고, `Composer`는 `suppressAgentConsoleKey`와 동일한 콜백 패턴의 `suppressShellActionKeys` prop으로 드래프트 삽입을 막는다 — Rust 리졸버는 그대로다. 컴포저 힌트 문자열(`Enter send · Shift+Enter newline …`, `Enter queues follow-up …`, `Queue paused after interrupt …`)과 상태 행의 `Ready` 조립 포맷, Rust제 헤더 워드마크(`UncleCode · <Provider>`)는 tmux 스모크의 부팅/레디 마커이므로 절대 바꾸지 않는다.

**문자열 소유 규칙(계약 정합):** `tests/contracts/tui-work-shell.contract.test.mjs`는 view 소스에 `Ctrl+O context`/`Ctrl+O sessions` 문자열이 없기를 단언한다(L122 부근 `doesNotMatch(viewSource, …)`). 따라서 새 오프너 힌트는 `Ctrl+O`를 포함하지 않는다(세션 접근은 `?`→`/help`로 발견). "prompt deck" 라벨 제거 시 `tests/tui/work-shell-context-composer.test.mjs`와 `tests/tui/composer-clipboard-flow.test.mjs`의 settle 앵커도 함께 갱신한다(파일 맵 참조).

## Tech Stack

Ink 6.8 + React 19.2 (packages/tui), node:test + tsx (`--conditions=source`), 커스텀 렌더 하니스 `tests/tui/work-shell-render-harness.mjs` (`renderDebugFrame`/`waitForSettledFrame`).

## Work Scope

**In:** 헤더 identity row(모델·모드·auth 경고 우측 배치, 기본 힌트 제거), 상황별 상태 행(유휴 시 `◇ Ready · last Xs`만), 빈 화면 스타터 프롬프트 + `1/2/3` 프리필, 컴포저 플레이스홀더 고스트 텍스트 + `prompt deck` 라벨 제거, 디시전 바(원키 응답), `?` → `/help` 단축키, **컴포저 위 고정 라이브 액티비티 행(busy 시 상단 행 대체), busy 중 툴 트레이스 라이브 피드, 트랜스크립트 PageUp/PageDown 스크롤백**(1차 리다이렉트), **빈 화면 ASCII 워드마크 브랜딩 + 컨텍스트 프루프 컴팩트화 + 데스크 제출 시 자동 닫힘**(2차 리다이렉트), DESIGN.md 갱신, 관련 테스트 정렬.

**Out:** Rust ux_input/ux_panels/ux_text 변경, 엔트리 프레젠테이션·마진(러스트 소유), 팔레트/색 변경, 컨텍스트 데스크·에이전트 콘솔·텔레메트리 오버레이 내부, 대시보드 세션 뷰, `/help` 패널 내용 자체, 큐 자동 재개 정책. (이유: Rust 영역과 팔레트는 최근 결정(66ce4b9 ANSI 상속)을 존중; 오버레이 내부는 진행 중인 Context Desk 작업과 충돌 회피; 큐 재개는 별개 정책 논의.)

## Verification Strategy

**Level:** test-suite.

```bash
npm run build          # dist 생성 — check의 전제
npm run check          # tsc --noEmit
npm run lint           # biome (packages/** 포함)
npm run test:tui       # TUI 전체 (serial, 전부 통과해야 함)
npm run test:contracts # 계약 (orchestrator-multi-agent 1건은 AGENTS.md 공지 기존 실패로 제외)
npm run test:cli       # tmux 헬퍼/스모크 스크립트 유닛 (전부 통과해야 함)
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs  # Task 6이 건드리는 엔진 스위트
```

통과 = 컴파일·린트·렌더/키보드/계약 표면 전부 정합. 사전 조건: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` (engines.node). `npm run qa:runtime`은 tmux+cargo가 있으면 돌리고(마커 문자열을 바꾸지 않으므로 변경 없이 통과해야 함), 환경에 없으면 "not run"으로 보고한다.

**알려진 기존 실패(수정 금지):** `tests/contracts/orchestrator-multi-agent.contract.test.mjs`(계약명 스키), `tests/work/tools.test.mjs`(클라우드 경로 의존 — 로컬 unclecode 디렉터리에서는 통과).

## File Structure Mapping

| File | Action | Anchors |
| --- | --- | --- |
| `DESIGN.md` | Modify | §5 "Work shell header", "Work shell status line", "Empty conversation", "Composer dock", 신규 "Decision bar", 신규 "Work shell keys" 서브섹션(§5 내 신설), §5.1 matrix |
| `packages/tui/src/work-shell-view.tsx` | Modify | `WorkShellHeaderBlock`(L1687), `WorkShellStatusBlock`(L1830), `renderWorkShellEmptyConversation`(L1533), `WORK_SHELL_OPENERS`(L1524), `WorkShellComposerDock`(L1998), `formatWorkShellPromptDeckDivider`(L1064), `WorkShellView`(L2087)의 각 리턴 브랜치(L2272 agent console, L2333 context desk, L2398 telemetry, L2436 default), 신규 `WORK_SHELL_STARTER_PROMPTS`, `WorkShellDecisionBar` |
| `packages/tui/src/work-shell-footer-fast-paths.ts` | Modify | `WORK_SHELL_DEFAULT_HEADER_HINT`(L12) 삭제, `formatWorkShellSessionFactsGroup`(L180) 유지(헤더가 사용) |
| `packages/tui/src/composer.tsx` | Modify | `Composer`(L359) — 신규 `placeholder` prop, `suppressShellActionKeys` prop; useInput 삽입 경로(`suppressAgentConsoleKey` 평가 지점 부근, 빈 값 렌더 L687-689) |
| `packages/tui/src/work-shell-hooks.ts` | Modify | `useWorkShellInputController`(L512-579 입력 타입, L581- 사다리), `useWorkShellPaneState`의 컨트롤러 호출부(~L1293) 신규 입력 스레딩, `WorkShellPaneEngine` 인터페이스(L316-356) — 신규 엔진 메서드 선택형 노출 |
| `packages/tui/src/work-shell-pane.tsx` | Modify | `WorkShellPane` — Composer로 `placeholder`/`suppressShellActionKeys` 전달 |
| `packages/orchestrator/src/work-shell-engine.ts` | Modify | `handlePendingDecisionReply`(L2283) 곁의 신규 `answerPendingDecisionByIndex`, `cancelPendingDecision` |
| `tests/contracts/tui-work-shell.contract.test.mjs` | Modify | L195-230 headerHint 단언(Task 2), L122 `Ctrl+O` 부정 단언은 그대로 유지됨(새 힌트가 미포함) |
| `tests/tui/work-shell-composer-workflow.test.mjs` | Modify | L234 헤더 힌트 regex, `deckIndex` 앵커들(L132, L413, L428), 문구 L618/L871 |
| `tests/tui/work-shell-live-activity.test.mjs` | Modify | L253/L263 부근 상태 행·`prompt deck` 단언 |
| `tests/tui/work-shell-context-composer.test.mjs` | Modify | L105, L276, L295, L415, L510 — `prompt deck` settle 앵커 교체 |
| `tests/tui/composer-clipboard-flow.test.mjs` | Modify | L207, L462 — `prompt deck` 부팅/settle 게이트 교체 |
| `tests/tui/work-shell-resize-reflow.test.mjs` | Verify-only | L65 headerHint prop 주입 케이스 — 주입 힌트가 계속 렌더되는지만 확인(수정 불요) |
| `tests/tui/work-shell-empty-state.test.mjs` | Create | 렌더 + 프리필 키보드 |
| `tests/tui/work-shell-decision-bar.test.mjs` | Create | 렌더 + 원키 응답 |
| `tests/tui/work-shell-keyboard.test.mjs` | Modify | `?` 키맵 케이스 2개 추가 |
| `tests/orchestrator/work-shell-engine.test.mjs` | Modify | `answerPendingDecisionByIndex`/`cancelPendingDecision` 유닛 |
| `tests/tui/work-shell-scrollback.test.mjs` | Create | 스크롤백 렌더 + 키보드 (Task 11) |
| `packages/tui/src/work-shell-context-receipt.tsx` | Modify | `▤ Context proof` 프루프 라인 포맷 컴팩트화 (Task 14) |
| `packages/tui/src/work-shell-view.tsx` (추가) | Modify | `renderWorkShellEmptyConversation` — 신규 `WORK_SHELL_WORDMARK` 상수 (Task 13) |
| `tests/tui/work-shell-context-inspector-render.test.mjs` | Modify | 프루프 문자열 단언 갱신 (Task 14) |
| `tests/tui/work-shell-context-composer.test.mjs` (추가) | Modify | 데스크 제출 시 자동 닫힘 케이스 추가 (Task 14) |

## Tasks

### Task 1: DESIGN.md — 새 메인 크롬 스펙 반영

**Goal:** 계약 테스트가 참조하는 디자인 원천 문서를 구현에 앞서 새 크롬 스펙으로 갱신한다.

**Dependencies:** None.

**Files:** Modify `DESIGN.md`.

**Acceptance Criteria:**
- [ ] §5 "Work shell header"가 "provider title(좌, bold) + 우측 정렬 세션 팩트 `model · mode`(muted), auth 경고 시에만 auth 칩, 하단 규칙선; 기본 shortcut hint는 없음"을 규정한다.
- [ ] §5 "Work shell status line"이 "유휴 = `◇ Ready · last Xs` 단독(모델·모드는 헤더로 이동); busy/백그라운드 작업 시 activity facts 확장; auth 경고는 헤더 칩"을 규정한다. 순수 포매터 `formatWorkShellUsageLine`(`Ready · last reply 1.5s`, 계약 L1493이 고정)은 상태 행 조립 포맷과 별개임을 명시한다.
- [ ] §5 "Empty conversation"이 "스타터 프롬프트 3개(숫자키 1-3으로 프리필) + 오프너 힌트 행(`/ commands · @ attach a file · ! shell · ? keys`)"을 규정한다.
- [ ] §5 "Composer dock"에 "빈 입력 시 고스트 플레이스홀더", "라벨 없는 소프트 구분선(입력 영역 위 라벨 문구 없음)"이 포함된다.
- [ ] §5에 신규 "Decision bar" 컴포넌트(단일 질문 숫자 옵션 + `1..9` 원키 + Esc 취소 + 다중 질문 타이핑 안내)가 문서화된다.
- [ ] §5에 신규 "Work shell keys" 서브섹션(신설)이 `?` → `/help`, 스타터 `1-3`(빈 세션), 디시전 `1..9`/Esc 바인딩을 규정한다.
- [ ] §5.1 matrix의 Header/Status strip 행이 위와 일치하도록 수정되고, 빈 화면 규격은 Conversation 행에 반영하거나 신규 Empty 행으로 추가된다(현재 matrix에는 Empty 행이 없음).

**Steps:**
1. 위 7개 항목을 `apply_patch`로 반영한다. 문체는 기존 표 형식 유지.
2. `grep -n "prompt deck" DESIGN.md` → 매치 없음(기존 §5.1 L179 `prompt deck` 문구도 라벨 없는 구분선 표현으로 교체). `grep -n "Decision bar" DESIGN.md` → 1건 이상. `grep -n "Work shell keys" DESIGN.md` → 1건 이상.

### Task 2: 헤더 identity row

**Goal:** 헤더를 브랜드 + 세션 팩트의 identity row로 바꾸고, 상시 점등되던 암호적 힌트 `work context · Ctrl+O sessions · / commands`를 제거한다.

**Dependencies:** Task 1.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`WorkShellHeaderBlock`, `WorkShellView` 리턴 브랜치들), `packages/tui/src/work-shell-footer-fast-paths.ts` (`WORK_SHELL_DEFAULT_HEADER_HINT` 삭제), Modify tests: `tests/contracts/tui-work-shell.contract.test.mjs`(L195-230 부근), `tests/tui/work-shell-composer-workflow.test.mjs`(L234 부근).

**Acceptance Criteria:**
- [ ] `WorkShellHeaderBlock`이 `model`, `mode`, `authLabel` props를 받고, 첫 행이 좌측 `formatWorkShellProviderTitle(provider)`(bold) + 우측 정렬 `formatWorkShellSessionFactsGroup({model, mode})`(muted)를 렌더한다. auth 경고(`/blocked|unavailable|not signed|needs refresh|needs API key|lacks/i`)일 때만 세션 팩트 뒤에 warning색 auth 칩이 붙는다.
- [ ] `props.headerHint`가 오면 종전처럼 우측에 우선 표시(테스트/호출자 오버라이드 유지 — resize-reflow L65가 주입 힌트로 의존), 미지정 시 우측은 세션 팩트. `WORK_SHELL_DEFAULT_HEADER_HINT` 상수·import가 소스에서 삭제된다.
- [ ] 좌측+우측이 좁아서 못 들어가면(종전 minGap=2 로직) 우측 팩트부터 생략, 그래도 안 되면 워드마크만 truncate — 종전 축소 로직 준용.
- [ ] `WorkShellView`의 모든 리턴 브랜치(agent console L2272, context desk L2333, telemetry L2398, default L2436)가 새 props를 전달한다.
- [ ] `rg -n "work context ·" packages/tui/src/` → 매치 없음.
- [ ] 아래 커맨드가 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-composer-workflow.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs
  ```

**Steps:**
1. `WorkShellHeaderBlock` props에 `model: string; mode: string; authLabel: string` 추가. 내부에서 `formatWorkShellSessionFactsGroup` 호출(이미 L29 import됨). auth 경고 판정 regex를 `WorkShellStatusBlock`(L1858)에서 `isWorkShellAuthWarning(authLabel): boolean` 헬퍼로 추출해 양쪽이 공유.
2. `work-shell-footer-fast-paths.ts`에서 `WORK_SHELL_DEFAULT_HEADER_HINT` 삭제, `work-shell-view.tsx` L31 import 제거.
3. 4개 브랜치의 `<WorkShellHeaderBlock …/>`에 `model={props.model} mode={props.mode} authLabel={props.authLabel}` 추가.
4. 테스트 갱신: composer-workflow L232-236의 기본 헤더 렌더 단언(`/work context · Ctrl\+O sessions · \/ commands/`)을 헤더에 모델·모드가 보인다는 단언으로 교체(렌더 프레임에 `gemini-2.5-flash`와 모드 라벨 존재). 계약 테스트 L195-230의 L200/L211/L221은 모두 **주입 hint를 준 순수 포매터 긍정 케이스**(`formatWorkShellHeaderLine`에 headerHint를 명시 전달 — 상수 삭제 후에도 그대로 통과)이므로 손대지 않는다. L122의 `Ctrl+O` 부정 단언은 유지된다(새 문자열이 미포함).
5. 상기 커맨드 실행해 통과 확인.

### Task 3: 상황별 상태 행

**Goal:** 유휴 상태 행을 `◇ Ready · last Xs` 한 줄로 슬림화한다(모델·모드는 헤더로 이동했으므로).

**Dependencies:** Task 2.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`WorkShellStatusBlock`), Modify `tests/tui/work-shell-live-activity.test.mjs`(L253 부근 상태 행 단언).

**Acceptance Criteria:**
- [ ] wide 유휴 렌더가 `◇ Ready · last 1.5s`(타이밍 있을 때) / `◇ Ready`(첫 세션, 타밍 미정)만 출력 — `sessionGroup`(model · mode)과 뒤따르는 ` · ` 프리픽스가 유휴 행에서 사라진다. ("Ready"·"last" 리터럴은 `formatWorkShellStatusActivityFacts` 조립으로 이미 view에 있음 — L1864-1884.)
- [ ] busy/백그라운드 렌더는 종전의 activity facts(`2 agents · 2 jobs · Reading context · 16s`)를 유지하되 sessionGroup 없이 `⠋ Reading context · 16s` 형태로 출력한다.
- [ ] narrow(<72 cols) 변형은 종전대로 모델을 포함해 유지(헤더가 좁아서 팩트를 생략하므로).
- [ ] 순수 포매터 `formatWorkShellUsageLine`은 불변 — 계약 L1493 `"Ready · last reply 1.5s"` 단언이 **수정 없이** 통과한다(이 포매터는 상태 행 렌더와 별개다).
- [ ] `node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-live-activity.test.mjs` 통과.

**Steps:**
1. `WorkShellStatusBlock` wide 브랜치(L1913-)의 `<Text bold>{sessionGroup}</Text>` 및 뒤따르는 ` · ` 세그먼트 제거. auth 경고 칩은 헤더로 이동했으므로 wide에서 제거(narrow는 유지).
2. live-activity 테스트의 유휴 행 단언(L253 부근)을 모델이 상태 행이 아닌 헤더에 있음을 검증하는 단언으로 교체.
3. 단일 파일 실행으로 확인.

### Task 4: 빈 화면 스타터 + 프리필 핫키

**Goal:** 첫 화면에서 숫자키 한 번으로 예시 태스크가 컴포저에 채워지게 한다.

**Dependencies:** Task 3.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`WORK_SHELL_STARTER_PROMPTS`, `renderWorkShellEmptyConversation`, `WORK_SHELL_OPENERS`), `packages/tui/src/work-shell-hooks.ts` (컨트롤러 입력 타입 L512-579 + 사다리 + 호출부 ~L1293 스레딩), `packages/tui/src/composer.tsx` (`suppressShellActionKeys` prop), `packages/tui/src/work-shell-pane.tsx` (전달), Create `tests/tui/work-shell-empty-state.test.mjs`.

**Acceptance Criteria:**
- [ ] `WORK_SHELL_STARTER_PROMPTS = ["Explain this codebase and how it is organized", "Find the cause of a failing test and propose a fix", "Draft a plan for the next change"]`가 빈 대화면에 `1  Explain this codebase…` 형태(숫자는 assistant 액센트, 본문 textDim)로 렌더된다. 기존 `● Ready for the next move` 헤딩과 `getWorkShellEmptyConversationHint()` 라인은 유지.
- [ ] 오프너 표가 2열 그리드 대신 한 줄 힌트 `/ commands · @ attach a file · ! shell`(textDim)로 바뀐다(좁은 폭에서는 자연 줄바꿈 허용 — 기존 cellWidth 계산 삭제). **이 시점에는 `? keys`를 포함하지 않는다**(Task 7에서 바인딩과 함께 추가). `Ctrl+O`는 포함 금지 — 계약 L122 `doesNotMatch(viewSource, /Ctrl\+O sessions/)` 유지.
- [ ] 컴포저가 비어 있고 대화 entries가 비어 있고 !isBusy이고 오버레이/데스크/콘솔/슬래시 피커가 닫혀 있고 `composerMode !== "api-key-entry"`일 때 `1`/`2`/`3` 키가 `setInputValue(WORK_SHELL_STARTER_PROMPTS[i-1])`로 프리필하고 드래프트에 숫자가 삽입되지 않는다.
- [ ] 컴포저에 텍스트가 있거나 entries가 있으면 `1`은 그냥 입력된다. api-key-entry 모드에서 `1`은 그냥 입력된다.
- [ ] `Composer`에 신규 `suppressShellActionKeys?: (input: string, composerEmpty: boolean) => boolean` prop이 추가되고, true 반환 시 해당 단일 문자가 드래프트에 삽입되지 않는다(`suppressAgentConsoleKey`와 동일한 평가 지점, composer.tsx ~L511).
- [ ] 컨트롤러 입력 타입에 신규 필드(예: `hasConversation: boolean`, `composerMode`, 오버레이 열림 플래그 — 사다리 조건에 필요한 전부)가 추가되고 `useWorkShellPaneState`의 컨트롤러 호출부(~L1293)에서 `engineState`로부터 스레딩된다(컨트롤러는 기존에 entries/모드를 모른다).
- [ ] 소유권 판정이 **단일 공유 헬퍼**(예: hooks 내 `resolveShellActionKeyOwnership(state): "starter" | "decision" | "keymap" | undefined`)로 추출되어 키 사다리 분기와 `suppressShellActionKeys` 콜백이 같은 술어를 사용한다(복사-붙여넣기 불일치로 "삼켜지는데 아무 동작 없는 키" 방지). 새 분기들은 텔레메트리 핫키(hooks L620-627)와 동일하게 `!key.ctrl`을 요구한다(ctrl 코드는 전역 동작 유지).
- [ ] 신규 테스트 파일: (a) 렌더 — 스타터 3줄 + 오프너 힌트 행 보임; (b) 키보드 — "1" 입력 후 프레임에 스타터 텍스트가 `›` 옆에 보임; (c) "1"을 텍스트 있는 상태에서 입력하면 "1"이 드래프트에 보임. 전부 통과.

**Steps:**
1. view에 상수·렌더 추가. `renderWorkShellEmptyConversation` 폭 인자는 힌트 줄바꿈에만 사용.
2. `composer.tsx`: `suppressAgentConsoleKey`가 평가되는 useInput 지점(~L511) 바로 옆에 동일 패턴으로 `suppressShellActionKeys?.(input, value.length === 0)` 평가 추가.
3. `work-shell-hooks.ts`: (a) 컨트롤러 입력 타입에 신규 필드 추가; (b) 키 사다리에서 **데스크/콘솔/텔레메트리 소유자 분기들 다음, Rust 리졸버 직전**에 스타터 분기 추가; (c) `suppressShellActionKeys` 콜백을 훅 반환값에 노출; (d) `useWorkShellPaneState` 호출부에서 `engineState.entries.length === 0`, `engineState.composerMode`, 오버레이 플래그를 스레딩. pane이 콜백을 Composer에 전달.
4. 테스트 작성 후 실행.

### Task 5: 컴포저 플레이스홀더 + 구분선 정리

**Goal:** 빈 컴포저에 고스트 힌트를 주고, `prompt deck`이라는 내부 용어를 화면에서 제거한다.

**Dependencies:** Task 4.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`formatWorkShellPromptDeckDivider` L1064, `WorkShellComposerDock` L2063), `packages/tui/src/composer.tsx` (`placeholder` prop, 빈 렌더 L687-689), `packages/tui/src/work-shell-pane.tsx` (전달), Modify tests: `tests/tui/work-shell-live-activity.test.mjs`(L263), `tests/tui/work-shell-composer-workflow.test.mjs`(deckIndex 앵커 L132/L413/L428, 문구 L618/L871), `tests/tui/work-shell-context-composer.test.mjs`(L105, L276, L295, L415, L510), `tests/tui/composer-clipboard-flow.test.mjs`(L207, L462).

**Acceptance Criteria:**
- [ ] `Composer`에 `placeholder?: string` prop 추가 — `value.length === 0 && !mask && !isPasting`일 때 기존 빈 렌더(패딩 공백행 + 커서, L687-689) 자리에 dim placeholder가 렌더되고, 입력이 시작되면 사라진다. 커서 표시 로직은 기존 유지.
- [ ] 팩토리가 전달하는 placeholder는 `"Describe a task · / for commands"`(view 또는 pane의 상수).
- [ ] `formatWorkShellPromptDeckDivider`가 `" prompt deck "` 라벨 없이 순수 소프트 룰(`─` 반복)을 반환하도록 변경되고, `rg -n "prompt deck" packages/tui/src/` → 매치 없음.
- [ ] 4개 테스트 파일의 `prompt deck` 앵커가 모두 교체되어, 아래가 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-live-activity.test.mjs tests/tui/work-shell-composer-workflow.test.mjs tests/tui/work-shell-context-composer.test.mjs tests/tui/composer-clipboard-flow.test.mjs
  ```
  교체 방식: composer-workflow의 `deckIndex`는 `rows.findIndex(row => row.includes("› "))` 프롬프트 행 또는 구분선 행으로, "prompt deck must keep a hint row" 계열 문구·단언명은 "dock"으로 재명명. context-composer·clipboard-flow의 settle/부팅 게이트는 워드마크(`UncleCode ·`) 또는 구분선 행으로.
- [ ] tmux 부팅 마커는 `prompt deck|UncleCode · <Provider>` 교집합 형태라 `scripts/runtime-qa/*`는 수정 불요 — `rg -n "prompt deck" scripts/` 결과의 regex가 전부 `|`(교집합) 형태임을 확인하고 수정하지 않는다.

**Steps:**
1. `composer.tsx` 빈 값 렌더 지점(L687-689)에 placeholder `<Text dimColor>` 분기 추가(색은 `textColor`+`dimColor` 조합 — 팔레트 의존 최소화).
2. view: divider 함수에서 라벨 제거, dock→Composer로 `placeholder` 전달 경로 확보(pane 경유).
3. 4개 테스트 파일 앵커 교체 후 실행.

### Task 6: 디시전 바 + 원키 응답

**Goal:** 대기 중인 AskUserQuestion을 컴포저 위 인터랙티브 바로 승격하고, 숫자키 한 번으로 답하게 한다.

**Dependencies:** Task 5.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (신규 `WorkShellDecisionBar`, default 브랜치 배치), `packages/tui/src/work-shell-hooks.ts` (핫키 + `WorkShellPaneEngine` 인터페이스 L316-356), `packages/orchestrator/src/work-shell-engine.ts` (`answerPendingDecisionByIndex`, `cancelPendingDecision`), Create `tests/tui/work-shell-decision-bar.test.mjs`, Modify `tests/orchestrator/work-shell-engine.test.mjs`.

**Acceptance Criteria:**
- [ ] 엔진: `answerPendingDecisionByIndex(index: number): boolean` — `pendingDecision`가 없거나 `questions.length !== 1`이거나 `index < 1 || index > question.options.length`이면 false(`handlePendingDecisionReply`는 void를 반환하므로 **사전 범위 검증이 필수**); 아니면 기존 `handlePendingDecisionReply(String(index))` 경로를 재use해 응답하고 true. `cancelPendingDecision(): boolean` — 대기 중이면 `handlePendingDecisionReply("/cancel")` 후 true. 이중 settle 불가(기존 `settle`의 pending identity 가드, 엔진 L2241-2243). `packages/contracts/src/agent-console.ts`의 상태 유니언은 변경하지 않는다.
- [ ] 두 메서드가 `WorkShellPaneEngine` 인터페이스(hooks L316-356)에 선택형(`answerPendingDecisionByIndex?:`)으로 선언된다(기존 capability probe 패턴 준용).
- [ ] 뷰: `props.agentConsole?.pendingDecision`가 존재하면 컴포저 독 바로 위(default 브랜치)에 `◆ <title|"Decision required">` + 단일 질문일 때 번호 옵션들(`(recommended)` 마커 포함, `formatWorkShellDecisionLines`와 동일 번호/라벨 규칙) + 힌트 `1-2 answer · Esc cancel · or type` 렌더. 다중 질문이면 `◆ <title> · N questions · type answers · /cancel` 한 줄. 완료/취소 즉시 사라진다(엔진이 pendingDecision을 비움 — 스냅샷은 이미 pane→view로 흐름, `work-shell-pane.tsx` L465, contracts L327).
- [ ] 패널 이중 렌더 방지: 디시전 바가 그려지는 프레임에서 "Decision" 패시브 패널의 옵션 라인들이 함께 보이지 않는다(`shouldSuppressWorkShellPassivePanel` view L403 또는 오버레이 게이팅에 조건 추가). 렌더 테스트로 각 옵션 라벨이 프레임에 정확히 1회 등장함을 검증.
- [ ] 컨트롤러 사다리의 디시전 분기는 **데스크/콘솔/텔레메트리/슬래시 소유자 분기들 다음**(Rust 직전)에 위치하며, Task 4의 공유 헬퍼 `resolveShellActionKeyOwnership`이 `"decision"`을 반환하는 조건(위 게이트)에서만 동작한다. 이 게이트면 데스크 열림+디시전 대기가 동시에 도달해도 Esc는 기존 데스크 close-overlay(Rust `ux_input.rs` L194-196)를 그대로 존중한다. 조건 충족 시 `1..9`는 `answerPendingDecisionByIndex`, `Esc`는 `cancelPendingDecision`을 호출하고 Rust Esc 사다리로 넘어가지 않는다(`!key.ctrl` 포함).
- [ ] 힌트 정합: 디시전 바가 보이는 동안 컴포저 힌트가 Esc 의미가 충돌하지 않게 `resolveWorkShellComposerHint`에 선택 입력 `decisionPending`을 추가해 `"1-N answer · Esc cancels decision · or type"`를 반환한다(기존 고정 케이스들은 이 입력을 주지 않으므로 계약 L416-445 단언 불변).
- [ ] 신규 테스트: (a) 렌더 — 옵션·힌트·recommended 표시, 옵션 라벨 1회 등장; (b) 키보드 — "1" 입력 시 가짜 엔진의 `answerPendingDecisionByIndex` 호출 확인; (c) 엔진 유닛 — `answerPendingDecisionByIndex(2)`가 두 번째 옵션으로 `answered` settle, 범위 밖(0, 99)은 false이며 pending 유지, `cancelPendingDecision`이 `cancelled` settle. 아래 커맨드 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs
  ```

**Steps:**
1. 엔진 메서드를 `handlePendingDecisionReply` 바로 아래 추가(범위 사전 검증 포함), `WorkShellPaneEngine`에 선택형 노출.
2. 뷰 컴포넌트 추가 및 default 브랜치 `composerDock` 앞 배치. 옵션 파생은 `agentConsole.pendingDecision.questions` 직독.
3. `work-shell-hooks.ts`: 컨트롤러 사다리에 디시전 분기 추가(위 게이트). `suppressShellActionKeys` 콜백에도 디시전 조건 포함.
4. 테스트 작성·실행.

### Task 7: `?` 키맵 단축키

**Goal:** `?` 한 번으로 `/help` 패널을 열게 해서 키 발견성을 확보한다.

**Dependencies:** Task 6.

**Files:** Modify `packages/tui/src/work-shell-hooks.ts` (컨트롤러), `packages/tui/src/work-shell-view.tsx` (오프너 힌트에 `? keys` 추가), Modify `tests/tui/work-shell-keyboard.test.mjs`.

**Acceptance Criteria:**
- [ ] 게이트: 컴포저 비어 있음 + 오버레이/데스크/콘솔/피커 닫힘 + 디시전 대기 아님 + `composerMode !== "api-key-entry"`(`hasSensitiveInput` — 보안 입력 중 `?`는 반드시 타이핑되어야 함)일 때 `?` 입력이 기존 submit 경로로 `/help`를 dispatch하고, 드래프트에 `?`가 삽입되지 않는다(`suppressShellActionKeys`에 조건 포함).
- [ ] 컴포저에 텍스트가 있으면 `?`는 그냥 입력된다. api-key-entry 모드에서 `?`는 그냥 입력된다.
- [ ] 빈 화면 오프너 힌트가 `/ commands · @ attach a file · ! shell · ? keys`로 갱신된다(Task 4가 만든 문자열에 `? keys` 세그먼트 추가).
- [ ] 키보드 테스트 2개(빈 컴포저 `?` → `/help` 패널 오픈 확인 via 패널 라인, 비어있지 않음/api-key-entry → `?` 드래프트 삽입) 추가되어 통과.

**Steps:**
1. 컨트롤러에 분기 추가 — 컨트롤러가 내부 정의한 submit 호출부(hooks 내부 정의, `rg -n "const submit" packages/tui/src/work-shell-hooks.ts` — pane 측 반환값 분해가 아니라 컨트롤러 안의 정의)를 슬래시 제출과 동일하게 재사용.
2. 오프너 힌트 문자열에 `? keys` 추가.
3. 테스트 추가·실행.

### Task 8: 중간 전체 검증 (개정: 최초 8태스크 체크포인트)

**Goal:** Task 1-7의 Verification Strategy를 실행해 해당 범위의 회귀 없음을 증명한다(사용자 리다이렉트로 Task 9-12가 추가되어 최종 게이트는 Task 12로 이동).

**Files:** None (실행만).

**Acceptance Criteria:**
- [ ] `npm run build && npm run check && npm run lint` — exit 0.
- [ ] `npm run test:tui` — exit 0 (전 파일).
- [ ] `npm run test:contracts` — `tests/contracts/orchestrator-multi-agent.contract.test.mjs` 1건 제외 전부 통과(해당 파일은 AGENTS.md 공지 기존 실패).
- [ ] `npm run test:cli` — exit 0.
- [ ] `node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs` — exit 0(Task 6 엔진 메서드 검증).
- [ ] 안정성 grep(실제 소스 앵커 기준 — `Ready · last`와 `UncleCode ·`는 런타임 조립/Rust 생성 문자열이라 packages/tui/src에 리터럴이 없음에 유의):
  - `rg -n "Enter send · Shift\+Enter newline" packages/tui/src/work-shell-view.tsx` → 1건 이상(tmux 레디 마커, 현재 L492/L494).
  - `rg -n "Enter queues follow-up" packages/tui/src/work-shell-view.tsx` → 1건 이상(동결 마커, 현재 L510).
  - `rg -n "Queue paused after interrupt" packages/tui/src/work-shell-view.tsx` → 1건 이상(동결 마커, 현재 L513).
  - `rg -n '"Ready"' packages/tui/src/work-shell-view.tsx` → 1건 이상(유휴 상태 리터럴).
  - `rg -n "provider-title" packages/tui/src/work-shell-view.tsx` → 1건 이상(Rust 워드마크 호출부 유지).
  - `rg -n "prompt deck|work context ·" packages/tui/src/` → 0건.
  - 계약 L1493 `"Ready · last reply 1.5s"` 단언이 **어떤 파일 수정도 없이** 통과(포맷 동결 증명).
- [ ] `npm run qa:runtime`: tmux와 cargo가 있으면 실행해 통과 확인(마커 불변이므로 스크립트 수정 없음). 환경에 없으면 "not run" 보고.

**Steps:**
1. 순서대로 실행하고 결과를 요약에 기록한다. 실패 시 해당 태스크로 돌아가 수복 후 재실행(전체 재실행).

### Task 9: 라이브 액티비티 행 — 컴포저 바로 위 고정

**Goal:** busy 표시(스피너·활동 구문·경과 시간·에이전트/잡 카운트)를 화면 상단에서 컴포저 독 바로 위로 옮겨, 긴 대화 중에도 "지금 작동 중"이 입력칸 옆에서 보이게 한다.

**Dependencies:** Task 8.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`WorkShellComposerDock` — 힌트 행 위에 액티비티 행 추가; `WorkShellStatusBlock` — busy 시 상단 행 미렌더), Modify `DESIGN.md` (§5 "Work shell status line"/"Composer dock" — busy 라이브 행의 위치 규격, §5.1 matrix), Modify tests: `tests/tui/work-shell-live-activity.test.mjs`(busy 스피너 단언 위치 이동), `tests/tui/work-shell-composer-workflow.test.mjs`(행 순서 단언).

**Acceptance Criteria:**
- [ ] busy(메인 턴 또는 백그라운드 에이전트/잡 활성)일 때 컴포저 독의 **힌트 행 바로 위**에 라이브 액티비티 행(`⠙ <활동 구문> · <경과>` + 유의미한 경우 `N agents · M jobs`)이 렌더된다. `WorkShellComposerDock` 요소가 모든 리턴 브랜치(default/agent console/context desk/telemetry)에서 재사용되므로 독 내부에 추가하는 것으로 전 브랜치에 동일 적용된다. 재사용 프리미티브: `formatWorkShellLiveActivityLine`(view ~L1604), `formatWorkShellStatusActivityFacts`, `pickBusySpinnerFrame`, `useWorkShellActivityClock`의 clock 값(이미 `WorkShellView`에 있음 — 필요한 값을 dock props로 전달).
- [ ] busy 동안 상단 `WorkShellStatusBlock`은 렌더되지 않는다(DESIGN.md §6 "one spinner per surface" — 스피너 중복 금지). idle 동안 상단 행은 Task 3 결과 그대로(`◇ Ready · last Xs`).
- [ ] 스피너 프레임/인터벌 불변(`WORK_SHELL_SPINNER_INTERVAL_MS` = 100, 계약 고정). tmux 마커 불변(idle 화면에 스피너 행 없음, `Ready · last` 상단 유지).
- [ ] 테스트: 렌더에서 activity 행이 hint 행과 `›` 프롬프트 행 **위**에 있는 행 순서 단언(행 인덱스 비교 — composer-workflow의 기존 패턴 준용); idle 프레임에 스피너 프레임 글리프(`⠋` 등) 미등장. live-activity 스위트 갱신 후 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-live-activity.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-composer-workflow.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs
  ```

**Steps:**
1. `WorkShellComposerDock` props에 busy 표시에 필요한 입력(busyStatus, spinnerFrame, activeCounts, currentTurnStartedAt, clock/activityNow 등)을 추가하고, 힌트 행 위에 액티비티 행 렌더 추가(isBusy || backgroundBusy 게이트). `WorkShellView`의 composerDock 생성부에서 전달.
2. `WorkShellStatusBlock` 렌더 조건: busy(메인+백그라운드)면 null 반환, idle이면 종전(Task 3) 렌더. 4개 브랜치 모두 동일(브랜치별 중복 조건이면 공유 헬퍼로).
3. DESIGN.md §5 status line/dock 섹션과 §5.1 matrix에 위치 규격 반영(busy 라이브 행 = 컴포저 독 힌트 행 위; 상단 행 = idle 전용).
4. 테스트 갱신·실행.

### Task 10: 툴 콜 라이브 피드

**Goal:** busy 중인 턴이 지금 무슨 툴을 돌리는지 컴포저 바로 위에서 실시간으로 보여 준다(트레이스 꼬리 3줄). 트랜스크립트 플러딩은 하지 않는다.

**Dependencies:** Task 9.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`WorkShellComposerDock` — 액티비티 행 아래 피드 행 + 신규 prop), `packages/tui/src/work-shell-hooks.ts` / `packages/tui/src/work-shell-pane.tsx` (`engineState.traceLines` 꼬리 스레딩), Modify `DESIGN.md`(§5.1 matrix — 툴 트레이스: busy 중 독 위 라이브 피드로 표시, 기본 트랜스크립트는 tool 엔트리만), Modify/Create tests: `tests/tui/work-shell-live-activity.test.mjs`(피드 케이스 추가).

**Acceptance Criteria:**
- [ ] 엔진 상태의 `traceLines`(`work-shell-engine.ts` 상태 필드, 이미 존재) 꼬리 최대 3줄이 pane→view로 스레딩되고(신규 view prop, 예: `liveToolTraceLines: readonly string[]`), busy 중 컴포저 독의 액티비티 행 아래·힌트 행 위에 dim 색으로 dock 폭에 truncate되어 렌더된다. idle이면 피드는 렌더되지 않는다.
- [ ] `isInternalTraceConversationText`(view — `→ read/write/search…` 필터)과 트랜스크립트 엔트리 필터링은 **변경하지 않는다**(트랜스크립트 플러딩 방지; tool role 엔트리 표시는 현행 유지). traceMode verbose 오버레이 동작 불변.
- [ ] 테스트: (a) busy + traceLines → 최신 트레이스 라인들이 `›` 행 위에 보임; (b) idle → 피드 없음; (c) 폭 초과 라인은 truncate되어 한 줄 유지. 갱신 스위트 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-live-activity.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-context-inspector-render.test.mjs
  ```

**Steps:**
1. pane이 engineState에서 `traceLines.slice(-3)`을 view prop으로 전달(hooks 경유 또는 직접 — 기존 스레딩 패턴 준용).
2. 독에 피드 행 추가(Task 9의 액티비티 행 아래, 같은 busy 게이트).
3. DESIGN.md matrix 갱신, 테스트 추가·실행.

### Task 11: 트랜스크립트 스크롤백 (PageUp/PageDown)

**Goal:** alt-screen 제약 안에서 트랜스크립트를 위로 스크롤해 과거를 읽을 수 있게 한다.

**Dependencies:** Task 10.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`WorkShellConversationBlock` 표시 창 슬라이스 + 스크롤 인디케이터), `packages/tui/src/work-shell-hooks.ts` (컨트롤러 PageUp/PageDown — TS 사다리, `!key.ctrl`), `packages/tui/src/work-shell-pane.tsx` (스크롤 오프셋 상태), Modify `DESIGN.md` (Work shell keys 테이블에 PageUp/PageDown 추가), Create `tests/tui/work-shell-scrollback.test.mjs`.

**Acceptance Criteria:**
- [ ] PageUp/PageDown이 트랜스크립트 표시 창을 위/아래로 이동한다(엔트리 단위 스크롤; 표시 창 크기는 `terminalRows` 기반 근사). 인쇄 키와 무충돌(컴포저에 텍스트가 있어도 동작). Rust ux_input은 메인 뷰에서 이 키를 매핑하지 않음(확인 완료) — TS 사다리에서 소비, Context Desk/오버레이가 열려 있으면 기존 소유자(데스크 페이지네이션)가 우선(기존 테스트 회귀 없음).
- [ ] 위로 스크롤된 경우 인디케이터(예: `↑ N entries above · PageUp/PageDown scroll · Esc newest`)가 트랜스크립트/컴포저 독 경계에 표시된다. 대화가 표시 창보다 짧거나 이미 최상단이면 no-op.
- [ ] 새 엔트리 도착·입력 제출·Esc는 자동 bottom-follow로 복귀한다(Esc는 기존 사다리 의미에 **추가로** 복귀만 — 다른 Esc 동작을 대체하지 않는다).
- [ ] 신규 테스트: (a) 충분히 많은 엔트리(예: 60개)+제한된 rows에서 PageUp → 이전 엔트리 가시 + 인디케이터; (b) PageDown/Esc/입력 → 최신 복귀; (c) 컴포저에 텍스트가 있는 상태에서도 PageUp 동작. 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-scrollback.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-context-inspector-keyboard.test.mjs
  ```

**Steps:**
1. pane에 scroll offset 상태(기본 bottom-follow), 컨트롤러에 PageUp/PageDown 분기(사다리 마지막 영역, `!key.ctrl`, 데스크/오버레이 열림 시 제외), view에 표시 창 슬라이스 + 인디케이터.
2. DESIGN.md keys 테이블에 추가, 테스트 작성·실행.

### Task 13: 빈 화면 ASCII 워드마크 브랜딩

**Goal:** 빈 화면의 시각적 앵커를 단축키 나열이 아닌 세련된 "unclecode" ASCII 워드마크로 교체해 첫인상에 브랜드 아이덴티티를 심는다.

**Dependencies:** Task 8.

**Files:** Modify `packages/tui/src/work-shell-view.tsx` (`renderWorkShellEmptyConversation` + 신규 `WORK_SHELL_WORDMARK` 상수), Modify `DESIGN.md` (§5 Empty conversation 스펙), Modify `tests/tui/work-shell-empty-state.test.mjs`.

**Acceptance Criteria:**
- [ ] `WORK_SHELL_WORDMARK` 상수(문자열 배열, ASCII 전용 — 박스드로잉·이모지 금지, 4-7행, 모든 행이 동일 display width로 패딩된 직사각형 블록)가 빈 화면 최상단에 렌더된다. 아트는 `npx --yes figlet.js -f standard unclecode` 출력을 원본 사용(실행 불가 환경이면 계획에 못박은 임의 생성 금지 — figlet 표준 출력을 그대로 붙여넣어 검증). 색상은 단색 `W.textDim`(장식 gradient 금지, 팔레트 규칙 준수).
- [ ] 컨테이너 폭이 워드마크 폭 + 좌우 여유(각 2열) 미만이면 아트를 렌더하지 않고 기존 텍스트 헤딩("Ready for the next move" 계열)만 유지한다 — 좁은 터미널에서 줄바꿈/깨짐 없음(display-width 검증).
- [ ] Task 4의 스타터 프롬프트·오프너 힌트는 그대로 유지된다(워드마크는 그 위에 추가만).
- [ ] 계약 불변: `getWorkShellEmptyConversationHint()` 문자열 그대로(계약 고정), 뷰 소스에 `Ctrl+O` 문자열 부재 유지.
- [ ] 테스트 갱신: (a) 넓은 폭 렌더에서 워드마크 첫 행이 감지되고 블록이 직사각형(행별 display width 일치); (b) 좁은 폭에서 아트 부재 + 기존 콘텐츠 유지; (c) 기존 스타터/오프너 단언 통과. 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-empty-state.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs
  ```

**Steps:**
1. `npx --yes figlet.js -f standard unclecode`로 아트 생성 → `WORK_SHELL_WORDMARK` 상수화(각행 trailing space trim, 직사각형 패딩, 폭/행수를 상수 옆에 주석).
2. `renderWorkShellEmptyConversation`에 워드마크 렌더 추가(폭 게이트, dim 단색), DESIGN.md Empty conversation 스펙 갱신(구조: 워드마크 → 헤딩 → 스타터 → 힌트).
3. empty-state 테스트에 위 3케이스 반영·실행.

### Task 14: 컨텍스트 프루프 컴팩트화 + 데스크 제출 시 자동 닫힘

**Goal:** `▤ Context proof · …` 라인과 컨텍스트 데스크가 대화 공간을 불필요하게 차지하지 않게 한다 — 프루프는 한 줄 요약으로 컴팩트하게, 데스크는 검토 후 제출하면 스스로 물러난다.

**Dependencies:** Task 13.

**Files:** Modify `packages/tui/src/work-shell-context-receipt.tsx` (`▤ Context proof` 포맷), Modify `packages/orchestrator/src/work-shell-engine.ts` (`handleSubmit` L2350 — 제출 시 데스크/확장 패널 닫기), Modify `tests/contracts/tui-work-shell.contract.test.mjs` (L185 프루프 단언 갱신), Modify `tests/tui/work-shell-context-inspector-render.test.mjs` (프루프 문자열 단언 갱신), Modify `tests/tui/work-shell-context-composer.test.mjs` (제출 자동 닫힘 케이스 추가).

**Acceptance Criteria:**
- [ ] 프루프 라인이 `▤ N sent[ · M held][ · ~Xk tok]` 컴팩트 형태로 바뀐다 — `Context proof` 라벨 제거, `held 0` 세그먼트 생략, `tokens unknown` 세그먼트 생략(정보 손실 없음: 상세는 `/context` 데스크에서 동일 확인 가능). 예: 기존 `▤ Context proof · 1 sent · 0 held · tokens unknown` → `▤ 1 sent`, `▤ Context proof · 3 sent · 0 held · ~18.1k tok` → `▤ 3 sent · ~18.1k tok`, held 존재 시 `▤ 2 sent · 1 held`.
- [ ] 계약 L185 단언을 신규 형태로 갱신(같은 입력에 대한 의미 보존: sent/held/tok 값은 그대로 전달됨).
- [ ] 컨텍스트 데스크/확장 오버레이가 열린 상태에서 사용자가 턴을 제출하면 오버레이가 닫힌다(엔진 `handleSubmit`에서 activePanel이 Context 계열이면 해제). 타이핑만으로는 여전히 닫히지 않는다(기존 `shouldHideWorkShellOverlayForInput` 계약 그대로 유지 — Esc/토글만이 아니라 제출도 닫는 경로가 하나 추가됨).
- [ ] 테스트: (a) 프루프 3케이스(0 held + unknown, tok 존재, held 존재) 신규 형태 단언; (b) 데스크 열림 → 제출 → 오버레이 부재; (c) 데스크 열림 → 타이핑 → 여전히 열림(회귀 방어). 통과:
  ```bash
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-context-inspector-render.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-context-composer.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs
  node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs
  ```

**Steps:**
1. `work-shell-context-receipt.tsx` 포맷 컴팩트화(세그먼트 조건부 조립), 관련 단언 3파일 갱신.
2. 엔진 `handleSubmit` 시작부에 데스크 자동 닫힘 추가, context-composer 테스트에 (b)/(c) 케이스.

### Task 12: 최종 검증 (v2)

**Goal:** Task 1-14 전체에 대한 Verification Strategy를 실행해 개편이 회귀 없음을 증명한다.

**Dependencies:** Task 14.

**Files:** None (실행만).

**Acceptance Criteria:**
- [ ] Task 8과 동일한 커맨드 셋(build/check/lint/test:tui/test:contracts[공지 실패 제외]/test:cli/엔진 스위트) + 신규 테스트 파일(work-shell-empty-state, work-shell-decision-bar, work-shell-scrollback) 포함 전부 통과.- [ ] Task 8의 안정성 grep 전부 재통과.
- [ ] `npm run qa:runtime`: tmux+cargo가 있으면 실행(마커 불변). 없으면 "not run" 보고.

**Steps:**
1. 순서대로 실행, 결과 기록. 실패 시 해당 태스크 수복 후 전체 재실행.

## Critic Responses

### Round 1 (3× REJECT → 개정)

- **feasibility/coverage — Task 8 불가능한 grep 2건**: `Ready · last`는 `formatWorkShellStatusActivityFacts`의 런타임 조립(view L1864-1884), `UncleCode ·`는 Rust `provider-title`产物이라 packages/tui/src에 리터럴이 없다. → Task 8의 게이트를 실제 앵커(`"Ready"` 리터럸, `provider-title` 호출부, 계약 L1493 무수정 통과)로 재지정.
- **integration — `prompt deck` 제거 미커버 테스트 2건**: `work-shell-context-composer.test.mjs`(L105/276/295/415/510), `composer-clipboard-flow.test.mjs`(L207/462)가 `prompt deck`을 settle/부팅 앵커로 사용. → Task 5 Files/Steps/기준에 명시적으로 포함.
- **integration — `Ctrl+O sessions` 계약 위반**: 계약 L122 `doesNotMatch(viewSource, /Ctrl\+O sessions/)`. → 오프너 힌트에서 `Ctrl+O` 제외(세션 접근은 `?`→`/help`로 발견). Architecture 섹션에 문자열 소유 규칙으로 명문화.
- **integration — Esc 소유권 그림자**: 데스크 열림+디시전 대기가 동시 도달 가능하면 새 분기가 데스크 close-overlay Esc를 가린다(Rust ux_input L194-196). → 디시전 분기를 사다리 마지막(Rust 직전)에 배치 + 게이트에 오버라이/데스크 닫힘 요구.
- **integration — `?`가 api-key-entry 침범**: 보안 입력 중 `?`가 `/help`로 라우팅되면 안 됨. → 게이트에 `composerMode !== "api-key-entry"` 추가, 기준에 "api-key-entry에서 `?`는 입력" 명시. 스타터 `1/2/3`에도 동일 게이트 적용.
- **integration — `? keys` 힌트 조기 광고**: Task 4가 `? keys`를 렌더하고 Task 7이 바인딩. → Task 4는 `? keys` 없이 렌더, Task 7이 바인딩과 함께 힌트에 추가.
- **integration/feasibility — 컨트롤러 입력 스레딩 누락**: entries/composerMode는 `useWorkShellPaneState`에만 있고 컨트롤러 입력에 없다. → Task 4 기준/스텝에 컨트롤러 입력 타입 확장 + 호출부(~L1293) 스레딩 명시.
- **integration — 엔진 메서드 인터페이스 누락**: `WorkShellPaneEngine`(hooks L316-356) 선언 필요. → Task 6 기준에 선택형 노출 명시.
- **feasibility — `handlePendingDecisionReply`가 void**: → `answerPendingDecisionByIndex`가 범위를 사전 검증하도록 기준 명시.
- **feasibility — Task 2 계약 L200/L211 오기술**(금지가 아닌 주입 긍정 케이스) → 스텝 4 수정.
- **coverage/feasibility — DESIGN.md §6 앵커 스테일** → §5 내 "Work shell keys" 서브섹션 신설로 수정.
- **coverage — `formatWorkShellUsageLine` vs 상태 행 조립 구분** → Task 1/3 기준에 명시.

### Round 2 (feasibility APPROVE, integration APPROVE, coverage REJECT 1건 → 개정)

- **coverage[REJECT] — 엔진 스위트 미실행**: Task 6이 `work-shell-engine.ts`와 그 테스트를 고치는데 Verification Strategy/Task 8이 해당 스위트를 한 번도 실행하지 않음. → 전략 블록·Task 6 기준·Task 8에 엔진 단일 파일 커맨드 추가.
- **coverage[권고] — resize-reflow 매핑 행**: Modify로 표기됐으나 실제는 확인 전용. → Verify-only로 재표기.
- **coverage/feasibility[권고] — 계약 L221 오기술**: L221도 주입 hint 긍정 케이스(기본 렌더 단언은 composer-workflow L232-236). → Task 2 스텝 4 수정.
- **coverage[권고] — Task 1 자기모순**: 기준 4가 "prompt deck 라벨 제거"라는 리터럴을 요구하면서 스텝 2의 grep은 0건을 요구. → 기준 문구에서 리터럴 제거, §5.1 L179 기존 문구 교체도 스텝에 명시.
- **coverage[권고] — 동결 마커 grep 불완전**: Architecture가 3개 힌트 문자열을 동결하는데 Task 8은 1개만 grep. → `Enter queues follow-up`, `Queue paused after interrupt` grep 추가.
- **feasibility[권고] — §5.1 Empty 행 부재**: 현재 matrix에 Empty 행이 없음. → Conversation 행 반영 또는 신규 행 추가로 기준 수정.
- **feasibility[권고] — Task 7 grep 포인터**: `submit\(`가 pane 측 분해를 가리킴. → 컨트롤러 내부 정의(`const submit`)로 수정.
- **integration[권고] — 분기/서프레스 술어 공유**: 키 사다리 분기와 suppressShellActionKeys가 같은 조건을 복사하면 불일치 위험. → 단일 공유 헬퍼 `resolveShellActionKeyOwnership`을 Task 4 기준에 추가, Task 6이 재사용.
- **integration[권고] — `!key.ctrl` 게이트**: 텔레메트리 핫키 패턴처럼 ctrl 코드는 새 분기에서 배제. → Task 4 기준에 추가.
- **integration[권고] — 디시전 중 Esc 힌트 충돌**: busy 힌트 "Ctrl+C/Esc interrupt"와 바의 "Esc cancel"이 서로 모순. → `resolveWorkShellComposerHint`에 선택 입력 `decisionPending` 추가로 해결(고정 케이스 불변).

## Plan Amendment Log

### 2026-08-15 — 사용자 리다이렉트: 진행 표시 가시성·툴 콜·스크롤백 (Task 9-12 추가)

사용자 피드백(원문 요지): (1) 툴 콜링/스피너 등 진행 표시가 입력칸 위에 있어야 오인이 없다 — 현재는 상단이라 긴 대화 중 안 보임. (2) 툴 콜 과정이 아예 안 보인다. (3) TUI가 alt-screen이라 스크롤을 올릴 수 없다.

원인 확인(코드 리컨): busy 표시는 `WorkShellStatusBlock`(화면 상단)에만 존재; 툴 상세는 `traceLines`로 수집되나 `isInternalTraceConversationText` 필터로 기본 뷰에서 제외(tool role 엔트리만 트랜스크립트에 표시됨); `alt-screen.ts`가 `?1049h` 대체 버퍼 진입 + 전체 프레임 리페인트로 터미널 스크롤백 불가; Rust ux_input은 메인 뷰에서 PageUp/PageDown을 매핑하지 않음(TS 처리 가능).

추가된 태스크: Task 9(라이브 액티비티 행을 컴포저 독 위로 이동 — busy 시 상단 행은 미렌더로 스피너 중복 방지), Task 10(busy 중 트레이스 꼬리 3줄 라이브 피드 — 트랜스크립트 필터는 불변), Task 11(PageUp/PageDown 엔트리 단위 스크롤백 + 인디케이터 + 자동 bottom-follow), Task 12(최종 검증 — 기존 Task 8은 "중간 전체 검증"으로 재명명). `tasks.total` 8→12.

기존 태스크 기준 변경 없음(변경은 추가만). Out-of-scope 경계 유지: Rust ux_input/ux_panels/팔레트/오버레이 내부 변경 없음.

### 2026-08-15 — 사용자 리다이렉트 2: 빈 화면 브랜딩 + 컨텍스트 프루프/데스크 공간 절약 (Task 13-14 추가)

사용자 피드백(원문 요지): (1) 빈 화면 개선은 "세련된 ASCII로 unclecode를 내세우는" 브랜딩이어야지 단축키 나열로는 달라지는 게 없다. (2) 스피너/툴 콜링은 prompt deck 바로 위(1차 리다이렉트 재확인 — Task 9/10으로 이미 진행 예정). (3) context proof와 인스펙터(데스크)가 쓸데없이 자리를 차지하고 제대로 보이지도 않는다. "이어서 ㄱ".

추가된 태스크: Task 13(빈 화면 `WORK_SHELL_WORDMARK` — figlet standard "unclecode", dim 단색, 폭 부족 시 우아한 생략), Task 14(프루프 `▤ N sent · …` 컴팩트화 + 데스크 제출 시 자동 닫힘). `tasks.total` 12→14. 기존 태스크 강화·약화 없음. Task 12(최종 검증) 의존성을 Task 11 → Task 14로 갱신(실행 순서는 8→9→10→11→13→14→12; 태스크 번호 재정렬 대신 신규 번호 부여로 기존 영수증/상태 참조 안정성 유지).

계약 영향 명시: Task 14는 `tests/contracts/tui-work-shell.contract.test.mjs` L185의 프루프 문자열 단언을 **신규 컴팩트 형태로 갱신**한다(의미 보존 — 기존 단언이 고정하던 "sent/held/tok 값 전달"은 동일 입력에 대해 유지). 이는 사용자가 명시적으로 요청한 UX 변경을 반영하는 계약 갱신이며, 검증 약화가 아니다(신규 형태로 동등 이상 단언: 세그먼트 생략 규칙 포함).

Out-of-scope 경계 유지: 데스크 내부 레이아웃(진행 중 Context Desk 작업 소유)은 건드리지 않고 "닫힘 시점"만 엔진에서 제어한다.
