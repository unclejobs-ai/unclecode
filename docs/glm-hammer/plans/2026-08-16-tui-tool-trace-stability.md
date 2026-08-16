# 2026-08-16 TUI Tool Trace Visibility + Rendering Stability

## Goal

메인 트랜스크립트에 Claude Code형 툴 콜 표시(호출 라인 + 들여쓴 결과 요약·diff 통계)와 리저닝 요약을 **기본 모드에서** 보여 주고, 입력/스트리밍 시 전체 프레임 재편인트로 인한 깜빡임을 제거하며, 스크롤백이 실제 부트 체인(bin→rust→node dist)에서 동작함을 e2e 스모크로 증명한다.

## Architecture

변경은 세 층에 나뉜다. (1) **엔트리 결정 소유는 Rust 유지**: `work_shell_trace.rs`의 `resolve_verbose_trace_entry`가 `tool.completed`를 **모든 traceMode에서** transcript entry로 내보내도록 결정만 바꾸고, 다중 행 상세 텍스트는 TS(`work-shell-engine-trace.ts`)가 구조화 이벤트의 `output/durationMs/isError/표시용 input(path·query·command)`로 조립한다. **프로바이더 계층은 건드리지 않는다** — `attachDisplayToolInput`(providers/runtime.ts:3260-3272)이 trace input을 path/query/command로 축소하므로, diff 통계는 `output`에 포함된 unified diff에서만 도출하고(에이전트 콘솔의 `UNIFIED_DIFF_HUNK_RE` 패턴 준용) `input.patch`는 요구하지 않는다. **글리프 소유는 렌더러에 단일화**: 조립 텍스트는 글리프 없는 평문 행(첫 행 `{동사} {인자}`, 이어서 평문 메트릭/발췌 행)이고, 렌더러가 첫 행에 `● `, 첫 결과 행에 `  ⎿ `를 붙인다 — 이중 글리프 구조적 불가. (2) **라이브 피드는 새 상태 필드로**: 기존 `traceLines`(verbose 전용, 컨텍스트 패널·`/minimal`과 결합)와 분리된 항상-채움 `liveTraceLines`(TS 상태, cap 8)를 추가해 도크 피드가 기본 모드에서 살아있게 한다 — 오버레이·패널·`/minimal` 의미론 불변. (3) **렌더링 안정성**: `incrementalRendering` 재활성화(66ce4b9 도입, ec75b09에서 리사이즈 드리프트로 반려했던 것). 리사이즈 대응은 Ink 6.8의 비대칭을 따른다 — **축소(행·열 감소) 시에만** 외부 전체 클리어(감소 방향이 Ink 자체 리셋 조건과 일치), 확대는 증분 재레이아웃에 맡긴다(Ink log-update는 미변경 행을 스킵, 확대 후 전체-재편인트 분기 조건이 거짓이라 외부 클리어가 잔류 화면을 남김 — 그래서 확대 클리어는 금지). 키 입력 경로의 동기 Rust spawn 제거, `renderMarkdown` 캐시(text·width·theme 키). 스크롤 창 수학은 엔트리 행 수 가중치로 교체하며 뷰·컨트롤러(hooks step/clamp)가 동일 가중 함수를 공유한다. (4) **e2e**: qa:runtime tmux 스모크에 스크롤백 케이스 추가 — 사용자가 실행하는 dist 빌드(build 선행)를 검증해 "테스트는 src, 실행은 dist" 스테일리니스 재발을 차단한다.

알려진 선결 한계(본 계획 범위 밖, 기록용): Rust 세션 재개가 tool 엔트리를 drop함(session.rs:433-435) — 멀티라인 툴 엔트리도 재개 후 소실. 스크롤백 불만과 무관하지 않으므로 향후 과제로 남긴다.

## Tech Stack

Ink 6.8 + React 19.2 (packages/tui, `incrementalRendering` 옵션은 tui-entry.tsx), node:test + tsx(`--conditions=source`), Rust 결정 유닛(cargo test -p unclecode-core), tmux 부트 스모크(scripts/runtime-qa/*).

## Work Scope

**In:** DESIGN.md 스펙 전환, Rust 트레이스 결정 1함수(+단위 테스트), 엔진 트레이스 조립(툴 상세 엔트리 + 리저닝 누적 엔트리 + `liveTraceLines`), TUI 렌더(툴/✻ 엔트리 + 스크롤 창 가중치 + 컨트롤러 공유), 플리커 제거(incremental rendering + 키 입력 spawn 제거 + markdown 캐시), 스크롤백 e2e 스모크, 관련 테스트 전부.

**Out:** 프로바이더 실행 경로(attachDisplayToolInput 포함 — diff 인자는 output에서만 도출), Agent Console/Context Desk/텔레메트리 오버레이 내부, 팔레트/색 토큰, 슬래시 커맨드 패널 콘텐츠, 마우스 휠 스크롤, 터미널 네이티브 스크롤백(alt-screen 유지), Rust ux_panels/ux_text 포맷 변경, 세션 재개의 tool 엔트리 drop(선결 한계로 기록만). (이유: 프로바이더·오버레이는 타 영역 소유; 마우스·네이티브 스크롤백은 커널 수준 변경.)

## Verification Strategy

**Level:** test-suite + runtime smoke.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run build                                # dist 재생성 — e2e/실구동 전제
cargo test -p unclecode-core                 # Rust 결정 유닛
npm run check && npm run lint
npm run test:tui                             # serial (신규/갱신 스위트 포함)
npm run test:contracts                       # tui-work-shell·tui-dashboard·unclecode-cli 계약 포함
npm run test:cli
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/agent-console-preview.test.mjs   # derive 헬퍼 export 회귀 (work-shell-agent-console.ts의 유일 테스트 임포터)
npm run qa:runtime                           # tmux 실부트 체인 + 신규 스크롤백 스모크
```

통과 = 컴파일·계약·렌더·키보드·엔진·Rust 결정·실부트 체인 전부 정합. **알려진 기존 실툴**: `tests/contracts/orchestrator-multi-agent.contract.test.mjs`(AGENTS.md 공지 스키, 이 머신에서는 통과해 왔음 — 실패 시 공지 내용인지 신규 문제인지 구분 보고). 동결 불변: 컴포저 힌트 문자열들, `WORK_SHELL_SPINNER_INTERVAL_MS=100`, 단일 스피너 규칙, `▤ N sent` 프루프 핀, `Ready · last reply 1.5s` 계약, 스크롤 인디케이터 문자열, tmux 부트/레디 마커.

## File Structure Mapping

| File | Action | Anchors |
| --- | --- | --- |
| `DESIGN.md` | Modify | §4 Rules(:89), §5 Conversation entry(:125-135), §5 Composer dock(:159-168), §5 Work shell keys(:201-202), §5.1 preamble(:206)/Conversation(:212)/Composer(:214)/Context overlay(:217), §6(:226-237), §7 Rules(:255) |
| `rust/unclecode-core/src/work_shell_trace.rs` | Modify | `resolve_verbose_trace_entry`(:80-96) — `tool.completed`을 traceMode 무관 entry로; `mod tests`(:102-215) 갱신 |
| `packages/orchestrator/src/work-shell-engine-trace.ts` | Modify | `applyWorkShellTraceEvent`(:93-138) — 툴 상세 텍스트 조립(신규 `formatWorkShellToolDetailEntry`), reasoning 누적(`streamingReasoningText`), `liveTraceLines` push |
| `packages/orchestrator/src/work-shell-agent-console.ts` | Modify | `UNIFIED_DIFF_HUNK_RE`(:713-715), `deriveToolActivityPreview`(:726), `deriveToolOutputMetric`(:795) — export 정리(로직 불변); diff 라인 통계는 신규 소형 헬퍼 `countUnifiedDiffLines`(output 내 unified diff 카운트) |
| `packages/orchestrator/src/work-shell-engine-state.ts` / `work-shell-engine.ts` | Modify | `liveTraceLines` 필드(cap 8) + `streamingReasoningText`; state 타입·publish wiring |
| `packages/tui/src/work-shell-view.tsx` | Modify | 툴/✻ 엔트리 렌더(:1441-1496), `splitWorkShellToolEntry`(:1252-1276), `resolveWorkShellTranscriptWindow`(:1657-1684)/capacity(:1638-1647) 행 가중치(신규 공유 헬퍼 `measureWorkShellEntryRows`), `resolveWorkShellComposerAdditionalRows`(:1363-1378) wrapDisplayTextFast 전환, `renderMarkdown` 호출부(:1449/1465) 캐시 |
| `packages/tui/src/work-shell-hooks.ts` | Modify | (a) `moveTranscriptPage`/clamp(:1330-1349) — 뷰와 동일 행 가중 함수 공유; (b) `WorkShellPaneRuntimeState`에 `liveTraceLines?` 선택 필드 |
| `packages/tui/src/work-shell-pane.tsx` | Modify | 도크 피드 소스를 `liveTraceLines.slice(-3)`로(:310-312) |
| `packages/tui/src/markdown-render.tsx` | Modify | `renderMarkdown`(:361) — (text,width,theme) LRU 캐시 |
| `packages/tui/src/tui-entry.tsx` | Modify | `DASHBOARD_RENDER_OPTIONS`(:17-20) — incrementalRendering 재활성화 |
| `packages/tui/src/terminal-resize-clear.ts` | Modify | 축소 판정에 rows 추가(현재 열 축소만) — 확대는 클리어하지 않음 |
| `tests/tui/tui-entry-rendering.test.mjs` | Modify | 재스펙 — 최종 프레임 정합 + 크롬 잔류 없음 + 스트리밍 증분 프레임(안정 행 미재출력) + 행 확대/축소 케이스 |
| `tests/orchestrator/work-shell-engine.test.mjs` | Modify | minimal 모드 툴 엔트리 기대 갱신(:2425-2550, :5636-5703), reasoning 엔트리·liveTraceLines 케이스 |
| `tests/orchestrator/agent-console-preview.test.mjs` | Verify-only | derive 헬퍼 export 후 회귀(수정 모듈의 유일 테스트 임포터) |
| `tests/contracts/tui-work-shell.contract.test.mjs` | Modify | 신규 툴 상세 조립 포맷 핀 추가 + tool 역 프리젠테이션 핀(:269-308 중 **tool 행만·추가만**) 갱신; 기존 `→ read package.json` 숨김 단언(:1423-1442)은 유지 |
| `tests/tui/work-shell-tool-detail.test.mjs` | Create | 툴 엔트리 조립+렌더(동사/⎿ 렌더러 글리프/캡/에러/output-diff 통계/이중 ellipsis 부재) + ✻ 엔트리 렌더 |
| `tests/tui/work-shell-scrollback.test.mjs` | Modify | 다중 행 툴 엔트리가 포함된 창 가중치 케이스 + 컨트롤러 step/clamp 일관성 |
| `tests/tui/work-shell-live-activity.test.mjs` | Modify | minimal 모드 busy 피드(liveTraceLines 주입 패턴) 케이스 |
| `scripts/runtime-qa/tui-scrollback-smoke.mjs` | Create | tmux 실부트 — 12턴 → PageUp → `↑ N entries above` 인디케이터 → Esc 해제; 실패는 throw(내부 catch 금지) |
| `scripts/runtime-qa/tui-suite-smokes.mjs` / `scripts/unclecode-runtime-qa.mjs` | Modify | 신규 스모크 등록 + 요약 불릿 `scrollbackPageUp=true` |

## Tasks

### Task 1: DESIGN.md — 툴/리저닝 기본 표시 + 렌더링 안정성 스펙

**Goal:** 스펙을 "숨김 우선"에서 "툴 콜·리저닝이 트랜스크립트 1급 시민"으로 전환하고 플리커 제거 원칙을 명문화한다.

**Dependencies:** None.

**Files:** Modify `DESIGN.md` (File Structure Mapping의 9개 섹션).

**Acceptance Criteria:**
- [ ] §5 Conversation entry 구조에 툴 엔트리 형식 명시: 렌더 첫 행 `● <동사> <핵심 인자>`(동사: read/write/bash/search/patch — **렌더 글리프, 조립 텍스트는 글리프 없음**), 첫 결과 행 `  ⎿ <요약>`·나머지 4-space 들여쓰기(메트릭: `N lines`/에러 표시/지속시간 `· {ms}ms`, output에 unified diff가 있으면 `+N −M`, 발췌, 전체 8행 캡 `… +N more lines` 최대 1회). 리저닝 엔트리: `✻` 접두 dim, 턴당 1개 최대 6행. 도크 피드: busy 중 진행 라인(`→ …`) 라이브, 기본 모드 포함(`liveTraceLines` 소스).
- [ ] §4:89("Dense trace/tool details belong in context/trace surfaces, not the main conversation")과 §7:255("Tool traces are diagnostic depth and should stay out of the main transcript unless explicitly requested") 문장이 제거/교체됨: `rg -n "not the main conversation|stay out of the main transcript" DESIGN.md` → 0. §5.1 Conversation/Composer/Context overlay 행 갱신(툴 엔트리 Show, 리저닝 요약 Show, 도크 피드 = 라이브 진행, 컨텍스트 오버레이는 verbose 확장 그대로).
- [ ] §6에 렌더링 안정성 규칙 추가: 기본 incremental rendering, **리사이즈 축소(행·열 감소) 시 전체 클리어 후 재편인트(확대는 증분 재레이아웃에 맡김)**, 키 입력 경로 동기 프로세스 spawn 금지, 스트리밍 중 안정 엔트리 재파싱 금지(markdown 캐시).
- [ ] `node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs` 통과(스펙만 바꾸므로).

**Steps:**
1. 각 섹션 문장 교체(행 번호는 `rg -n`으로 재확인).
2. §6 규칙은 위 기준의 4가지를 그대로 문장화.

### Task 2: Rust 결정 + 엔진 툴 상세 엔트리 (모든 모드)

**Goal:** `tool.completed`가 traceMode 무관으로 transcript entry가 되고, TS가 구조화 이벤트에서 다중 행 상세(호출+메트릭+발췌+output-diff 통계)를 **글리프 없이** 조립한다.

**Dependencies:** Task 1.

**Files:** Modify `rust/unclecode-core/src/work_shell_trace.rs`(`resolve_verbose_trace_entry`, 단위 테스트), `packages/orchestrator/src/work-shell-engine-trace.ts`(`applyWorkShellTraceEvent` + 신규 `formatWorkShellToolDetailEntry`), `packages/orchestrator/src/work-shell-agent-console.ts`(derive 헬퍼 export + 신규 `countUnifiedDiffLines`), `tests/orchestrator/work-shell-engine.test.mjs`(기대 갱신 :2425-2550, :5636-5703), Create `tests/tui/work-shell-tool-detail.test.mjs`(조립 단언 중심; 렌더 케이스는 Task 3에서 확장).

**Acceptance Criteria:**
- [ ] `resolve_verbose_trace_entry`: `tool.completed`가 **모든** traceMode에서 `traceEntry` 반환(함수 개명 필요 시 호출부/JSON 키 `traceEntry` 불변). `policy.denied` 현행 유지. Rust 단위 테스트 갱신 후 `cargo test -p unclecode-core` 통과.
- [ ] `formatWorkShellToolDetailEntry(event)`(TS, 순수): 첫 행은 **글리프 없는** `{동사} {핵심인자}`(동사 TS 상수: read_file→read, write_file→write, run_shell→bash, search_text→search, apply_patch→patch, 그 외 원 이름; 핵심 인자는 표시용 input의 path>command>query 순). 이어서 **평문** 메트릭/발췌 행(글리프 없음 — `⎿`·`●`는 렌더러 소유): `deriveToolOutputMetric` 결과 · output 첫 6행 발췌(행별 트렁케이션) · output에 unified diff가 있으면 `+N −M`(`countUnifiedDiffLines`, `UNIFIED_DIFF_HUNK_RE` 기반 — `input.patch`는 요구하지 않는다) · `isError`면 첫 에러 라인 행 · 마지막 메트릭 행에 `{durationMs}ms`. 전체 8행 초과 시 마지막 행 `… +N more lines`(엘리시스는 조립이 한 번만 — 렌더 재캡과 합쳐 이중 ellipsis 금지). 엔트리 **첫 행**이 킬 필터에 걸리지 않음(필터는 첫 행 접두만 검사): `shouldShowWorkShellConversationEntry({role:"tool", text: 조립결과}) === true`.
- [ ] `applyWorkShellTraceEvent`: tool.completed에서 Rust 결정 traceEntry 수신 시 `appendEntries({role:"tool", text: formatWorkShellToolDetailEntry(event)})`. executor-scoped(agentRunId/asyncJobId) 이벤트는 기존대로 메인 트랜스크립트 제외.
- [ ] 엔진 테스트 갱신: minimal 모드에서 tool.completed → entries에 상세 엔트리(:5636-5703의 `entries: []` 기대 변경, :2537-2550 minimal 핀 갱신), verbose 케이스 유지, executor-scoped 제외 회귀. 계약의 기존 숨김 핀(`→ read package.json` → false)은 그대로 통과.
- [ ] derive 헬퍼 export 후 `tests/orchestrator/agent-console-preview.test.mjs` 회귀 통과.
- [ ] 통과: `cargo test -p unclecode-core` · 엔진 스위트 · agent-console-preview 스위트 · `tests/tui/work-shell-tool-detail.test.mjs`(조립 단언).

**Steps:**
1. Rust 결정 변경 + 단위 테스트 갱신.
2. agent-console: derive 헬퍼 `export function`화(로직 불변) + `countUnifiedDiffLines` 추가, preview 스위트 회귀.
3. TS 조립 함수 + 적용, 엔진/tool-detail 테스트 작성.

### Task 3: TUI 툴·✻ 엔트리 렌더 + 스크롤 창 행 가중치(뷰·컨트롤러 공유)

**Goal:** 다중 행 툴 엔트리가 Claude Code형(렌더러 소유 `● ` 굵은 호출 + `  ⎿ ` dim 결과)으로 렌더되고, ✻ 리저닝 엔트리가 dim으로 렌더되며, 창·step·clamp 계산이 엔트리 행 수를 반영해 스크롤백이 정확해진다.

**Dependencies:** Task 2.

**Files:** Modify `packages/tui/src/work-shell-view.tsx`(툴/✻ 렌더 :1441-1496, `splitWorkShellToolEntry` :1252-1276, 신규 공유 헬퍼 `measureWorkShellEntryRows`, `resolveWorkShellTranscriptWindow` :1657-1684, capacity :1638-1647), `packages/tui/src/work-shell-hooks.ts`(step/clamp :1330-1349 — 공유 가중 함수 사용), `tests/tui/work-shell-tool-detail.test.mjs`(렌더 케이스: 툴 + ✻), `tests/tui/work-shell-scrollback.test.mjs`(가중치 + step/clamp 일관성 케이스), `tests/contracts/tui-work-shell.contract.test.mjs`(툴 상세 조립 핀 추가 + tool 역 프리젠테이션 핀 갱신 — **tool 행만·추가만, 타 역할 핀 불변**: 본 계획이 명시적으로 승인하는 계약 갱신).

**Acceptance Criteria:**
- [ ] 툴 엔트리 렌더: 첫 행 `● ` + 굵은 호출(성공 `W.success`, 에러 `W.error`), 첫 결과 행 `  ⎿ `·나머지 4-space `W.textMuted`; 8행 캡; 렌더된 엔트리에 `… +` 행 최대 1회(조립-렌더 이중 ellipsis 없음); 폭 트렁케이션 기존 규칙. 렌더 프레임에 `●`/`⎿` 동시 등장 + 조립-레벨 텍스트에는 글리프 부재(하니스 단언 2종).
- [ ] ✻ 엔트리 렌더: `✻ `로 시작하는 assistant 엔트리는 dim(`W.textMuted`) 단색으로 렌더(마크다운 파싱 없이) — Task 4가 만들 엔트리의 표시 담당을 이 태스크가 소유.
- [ ] 행 가중 창: 공유 순수 헬퍼 `measureWorkShellEntryRows(entry)`(텍스트 행 수 + 여백 1)를 뷰에서 export하고 `resolveWorkShellTranscriptWindow`/capacity가 사용. 컨트롤러 `moveTranscriptPage`의 step = 같은 함수들의 창 용량(엔트리 수), maxOffset = 가시 엔트리 수 − 용량 — 동일 가중 함수에서 도출(소스: 두 계산이 모두 헬퍼를 경유, 직접 상수 없음 — 검증 가능한 구조 기준). 오프셋 0(at-rest)은 기존 last-50 슬라이스와 동일 엔트리 집합(회귀 방어).
- [ ] 스크롤백 테스트: (a) 다중 행 툴 엔트리 포함 대화에서 PageUp → 이전 엔트리 가시 + 인디케이터, (b) PageDown/Esc → 최신 복귀, (c) 가중 헬퍼 직접 단언(단일 행 vs 8행 엔트리의 용량 차이).
- [ ] 계약 갱신 후 통과: `tests/contracts/tui-work-shell.contract.test.mjs` 전체(타 역할 프리젠테이션 핀 무수정 통과 포함) + `npm run test:tui`.

**Steps:**
1. 공유 가중 헬퍼 → 창/capacity 교체 → hooks step/clamp 연결.
2. 렌더 폴리시(툴 글리프/색/캡, ✻ dim 브랜치).
3. 테스트 갱신·실행.

### Task 4: 리저닝 요약 엔트리 (엔진)

**Goal:** 턴의 리저닝 텍스트를 누적해 assistant 답변 앞에 dim `✻` 요약 엔트리 1개로 트랜스크립트에 남긴다(실시간 채터링 없음 — 라이브 표시는 도크 활동 행·피드가 담당. 렌더 dim 처리는 Task 3 소유).

**Dependencies:** Task 3 (동일 테스트 파일·엔진 파일 순서).

**Files:** Modify `packages/orchestrator/src/work-shell-engine-trace.ts`(reasoning.delta 누적 — 상태 필드명 `streamingReasoningText`), `work-shell-engine-state.ts`/`work-shell-engine.ts`(필드 정의 + 확정/리셋 시점), `tests/orchestrator/work-shell-engine.test.mjs`, `tests/tui/work-shell-tool-detail.test.mjs`(✻ 엔트리 렌더 케이스 추가 — Task 3의 dim 브랜치 소비).

**Acceptance Criteria:**
- [ ] reasoning.delta(`kind: text|summary`)를 턴별 누적(`streamingReasoningText`, 2000자 캡). 첫 assistant.delta 도착 또는 turn.completed 시 누적분이 있으면 `appendEntries({role:"assistant", text: "✻ " + 요약})` — 요약 첫 6행 캡, 빈 누적이면 엔트리 없음. 턴 종료 후 누적 리셋. (✻ 첫 행은 킬 필터 미포함 — 필터 목록 대조 단언: `rg -n "✻" packages/tui/src/work-shell-view.tsx`가 필터 클래스 문자열과 무관함을 테스트로 고정.)
- [ ] 라이브 표시는 기존 활동 행 그대로(단일 스피너 불변, 추가 실시간 리저닝 행 없음).
- [ ] 엔진 테스트: 누적 → ✻ 엔트리 1개; 리저닝 없는 턴 엔트리 없음; 다음 턴 리셋; ✻ 엔트리는 assistant 답변 **앞** 순서. 렌더: ✻ 라인 dim 등장(tool-detail 스위트).
- [ ] 통과: 엔진 스위트 + tool-detail 스위트 + `npm run test:tui`.

**Steps:**
1. 상태 필드 + 누적/확정/리셋.
2. 테스트 작성.

### Task 5: 라이브 피드 상태 분리 — `liveTraceLines`

**Goal:** 기본(minimal) 모드에서도 busy 중 도크 피드가 살아있게 한다 — 기존 `traceLines`(verbose·컨텍스트 패널·`/minimal` 결합)와 분리된 항상-채움 상태를 추가해 오버레이 의미론은 불변으로 둔다.

**Dependencies:** Task 4.

**Files:** Modify `packages/orchestrator/src/work-shell-engine-trace.ts`, `work-shell-engine-state.ts`/`work-shell-engine.ts`(신규 `liveTraceLines` 필드, cap 8, TS-side, state 타입·publish wiring), `packages/tui/src/work-shell-hooks.ts`(`WorkShellPaneRuntimeState`에 `liveTraceLines?` 선택 필드), `packages/tui/src/work-shell-pane.tsx`(피드 소스 교체 :310-312), `tests/orchestrator/work-shell-engine.test.mjs`, `tests/tui/work-shell-live-activity.test.mjs`.

**Acceptance Criteria:**
- [ ] `applyWorkShellTraceEvent`가 유의미 포맷 라인(빈 문자열 제외)을 **모든 모드**에서 `liveTraceLines`에 push(cap 8, 오래된 것부터 drop). 기존 `traceLines`는 verbose 전용 로직 그대로 — 컨텍스트 패널/오버레이/`/minimal` 청소 동작 불변(`/minimal`은 `traceLines`만 클리어, `liveTraceLines`는 유지해 피드가 끊기지 않음). executor-scoped 라인은 `liveTraceLines`에도 제외.
- [ ] pane 피드가 `liveTraceLines.slice(-3)` 사용. 엔진 테스트: minimal 모드에서 tool.started/reasoning.delta → `traceLines: []`(불변) + `liveTraceLines` 채움; verbose에서 둘 다 채움; `/minimal` 전환 후 `liveTraceLines` 유지; orchestrator.step 케이스(:5648/:5666/:5702) `traceLines` 기대 불변.
- [ ] live-activity 스위트: busy + liveTraceLines → 피드 렌더, idle → 없음(기존 패턴). 통과 + `npm run test:tui`.

**Steps:**
1. 상태 필드 + push 로직, hooks/pane 소스 교체.
2. 기대 갱신·실행.

### Task 6: 플리커 제거 — incremental rendering + 키 입력 spawn 제거 + markdown 캐시

**Goal:** 입력과 스트리밍 중 화면이 다시 그려지는 양을 최소화해 깜빡임/점프를 제거한다.

**Dependencies:** Task 3 (view 파일 순서; Task 4/5와 파일 불겹침 — Task 4는 엔진/테스트만, Task 5는 hooks/pane이지만 6의 view 편집과 무겹침, 대상 심볼 상이).

**Files:** Modify `packages/tui/src/tui-entry.tsx`(옵션), `packages/tui/src/terminal-resize-clear.ts`(축소 판정 rows 추가 — **확대 클리어 금지**), `packages/tui/src/work-shell-view.tsx`(`resolveWorkShellComposerAdditionalRows` :1363-1378의 `wrapDisplayText`(:1306-1316 경유) → `wrapDisplayTextFast`; `renderMarkdown` 호출부 캐시), `packages/tui/src/markdown-render.tsx`(`renderMarkdown` (text,width,theme) LRU), `tests/tui/tui-entry-rendering.test.mjs`(재스펙), `tests/tui/text-width-fast-wrap.test.mjs`(회귀), `tests/contracts/tui-work-shell.contract.test.mjs`(composer 경로 동기 Rust wrap 금지 소스 단언 추가 — 기존 panel-line-class 패턴 준용).

**Acceptance Criteria:**
- [ ] `incrementalRendering: true` 재활성화. 리사이즈 대응: **축소(행 또는 열 감소) 시에만** 전체 클리어 후 재편인트(`terminal-resize-clear.ts` 축소 판정에 rows 추가; 확대 방향은 클리어하지 않음 — Ink log-update 미변경 행 스킵/전체 재편인트 분기 조건과 정합). `tui-entry-rendering.test.mjs` 재작성: (a) **축소** 후 최종 프레임에 크롬 잔류/이중 행 없음, (b) **행 확대** 후에도 최종 프레임 정합(클리어 없이 증분), (c) 스트리밍 2회 publish 시 안정 행(헤더 워드마크 등)이 재출력되지 않음(증분 프레임 증명), (d) 최종 프레임 정합. `work-shell-resize-reflow.test.mjs`·terminal-resize-clear 회귀 없음. `tests/contracts/tui-dashboard.contract.test.mjs`·`tests/contracts/unclecode-cli.contract.test.mjs`도 tui-entry를 렌더에 사용 — `test:contracts`로 회귀 확인(명시 실행).
- [ ] 키 입력 경로 동기 프로세스 spawn 제거: `resolveWorkShellComposerAdditionalRows`가 `wrapDisplayTextFast` 사용; 뷰 소스에 해당 경로의 `wrap-display` Rust 호출 부재(계약 소스 단언 추가). `text-width-fast-wrap` 동등성 회귀 없음. (스트리밍 제외 규칙 `shouldSkipRustTextCacheStore`는 work-shell-view.tsx:570-572에 있음 — 캐시가 이 규칙을 존중.)
- [ ] `renderMarkdown` (text,width,theme) LRU 캐시: 동일 키 재호출이 재파싱하지 않음(호출 카운터/스파이 단언), 스트리밍 텍스트는 캐시 미적용(기존 제외 규칙 유지).
- [ ] 동결 불변: 스피너 인터벌 100ms, 단일 스피너, 컴포저 힌트, 부트/레디 마커. 통과: `npm run test:tui` + contracts(위 2개 계약 파일 포함 전체).

**Steps:**
1. 옵션 전환 + resize-clear 축소-판정 확장, tui-entry-rendering 재스펙(축소/확대/스트리밍 케이스).
2. wrapDisplayTextFast 전환 + 계약 소스 단언.
3. renderMarkdown 캐시 + 스파이 유닛.

### Task 7: 스크롤백 e2e 스모크 (실부트 체인)

**Goal:** qa:runtime이 실제 사용자 부트 체인(bin→rust→node dist)에서 PageUp 스크롤백을 검증한다 — "테스트는 src, 실행은 dist" 스테일리니스가 재발하지 않게.

**Dependencies:** Task 5, Task 6 (창 수학은 Task 3 갱신 이후 — 6 의존으로 보장; 빌드 동시성 회피).

**Files:** Create `scripts/runtime-qa/tui-scrollback-smoke.mjs`, Modify `scripts/runtime-qa/tui-suite-smokes.mjs`(등록), `scripts/unclecode-runtime-qa.mjs`(요약 불릿 `scrollbackPageUp=true`).

**Acceptance Criteria:**
- [ ] 스모크: fake provider로 **12턴** 제출(어떤 합리적 용량에서도 창이 넘치게; `-y 30` 하니스) → `tmux send-keys PageUp` → `waitForPane(/↑ \d+ entries above · PageUp\/PageDown scroll · Esc newest/)` → `send-keys Escape` → 인디케이터 소멸(폴링 부재 확인). 기존 tmux-helpers 패턴 준용. **실패 형태는 throw뿐** — 스모크 내부에서 실패를 catch해 보고만 하면 러너가 삼키므로 내부 try/catch 금지(waitForPane 타임아웃 throw가 그대로 전파).
- [ ] `npm run qa:runtime` 통과 시 요약에 불릿 문자열 `scrollbackPageUp=true` — Task 8에서 `rg "scrollbackPageUp=true"` 출력 grep으로 재확인. qa:runtime은 `npm run build` 선행으로 dist 최신성 동시 보장.
- [ ] 로컬 1회 실행 결과를 증거에 기록.

**Steps:**
1. 스모크 작성(real-use 스모크 구조 복제) → 등록 → `npm run qa:runtime`.

### Task 8: 최종 검증

**Goal:** 전체 Verification Strategy를 실행해 개편이 회귀 없음을 증명한다.

**Dependencies:** Task 6, Task 7.

**Files:** None (실행만; 증거는 `.glm-hammer/evidence/e2e.md`로 갱신).

**Acceptance Criteria:**
- [ ] Verification Strategy 커맨드 전부 통과(build / cargo test -p unclecode-core / check / lint / test:tui / test:contracts[공지 실패 구분] / test:cli / 엔진 스위트 / agent-console-preview 스위트 / qa:runtime).
- [ ] qa:runtime 출력에 `scrollbackPageUp=true` 존재(`rg` 확인).
- [ ] 동결 마커 grep 전부 재통과(컴포저 힌트 3종, `Ready` 리터럴, `provider-title`, `Ready · last reply 1.5s`, 스피너 인터벌 100, `▤ N sent` 프루프 핀, 스크롤 인디케이터 문자열).
- [ ] 렌더 프루프: 넓은 프레임에서 `●`/`⎿` 툴 엔트리 + `✻` 리저닝 엔트리 등장, `→ read` 라인은 트랜스크립트가 아니라 busy 피드에만(계약 숨김 핀 유지).

**Steps:**
1. 순서대로 실행, 실패 시 해당 태스크 수복 후 전체 재실행.

## Critic Responses

### Round 1 (3× REJECT → 개정)

- **feasibility[REJECT] — `extractDiffHunks(:715)` 부재**: 실제 앵커는 `UNIFIED_DIFF_HUNK_RE`(:713-715)/`deriveToolActivityPreview`(:726)/`deriveToolOutputMetric`(:795). → 매핑 수정, diff 통계는 신규 소형 헬퍼 `countUnifiedDiffLines`(재사용 아님을 명시).
- **feasibility[REJECT] — `input.patch`가 applyWorkShellTraceEvent에 도달하지 않음**: `attachDisplayToolInput`(providers/runtime.ts:3260-3272)이 input을 path/query/command로 축소하며 프로바이더 계층은 Out-of-scope. → diff 통계를 **output에 포함된 unified diff에서만** 도출로 변경(에이전트 콘솔 preview가 이미 output 기반으로 동일 패턴 사용). `input.patch` 요구 삭제.
- **feasibility/integration/coverage[REJECT] — Task 3↔4 공유 테스트 파일 순서**: → Task 4 의존성을 Task 3로 변경(순서 고정).
- **integration/coverage[REJECT] — Task 7→3 의존성 누락**(용량 기대가 Task 3 창 수학에 의존): → Task 7 의존성을 Task 5+6으로(3→6 경유 보장) 변경 및 용량 하드코딩 대신 12턴 오버플로우 설계.
- **integration[REJECT] — hooks(:1330-1349)가 capacity를 소비하나 어떤 태스크에도 없음**: → Task 3 Files에 work-shell-hooks.ts 추가 + "동일 가중 함수에서 step·maxOffset 도출" 불변식 기준 명시.
- **integration[REJECT] — Task 5 unconditional push가 컨텍스트 패널(`→ Live`, ux_panels.rs:716-720)과 `/minimal` 클리어(trace_mode_command.rs:33-38)와 충돌, "오버레이 불변"이 거짓**: → 설계 변경: 새 `liveTraceLines` 상태(TS, cap 8, 항상 채움, 오버레이 미소비, `/minimal`이 클리어하지 않음)로 분리. `traceLines`와 오버레이·패널·`/minimal` 의미론 완전 불변.
- **integration/coverage[권고] — `●` 이중 글리프 위험(조립+렌더러)**: → 글리프 소유를 렌더러로 단일화, 조립 첫 행은 글리프 없음.
- **coverage[권고] — "prompt deck → 0" 공허**: → 실제 제거 대상 문구(`not the main conversation`/`stay out of the main transcript`)로 재지정.
- **coverage[권고] — agent-console 회귀 무커맨드**: → 전략에 단일 파일 커맨드 추가(라운드 2에서 경로 정정).
- **feasibility[권고] — 동사 매핑에 patch 부재(ux_text)**: → TS 상수로 자체 정의(ux_text 준용 + apply_patch→patch).
- **feasibility/coverage[권고] — Task 6 앵커 오류(view:570-572, LRU theme 키, rows-only 리사이즈)**: → 모두 반영(theme 포함 키, resize-clear rows 추적).
- **coverage[권고] — 스트리밍 경로 플리커 직접 단언 부재**: → tui-entry-rendering 재스펙에 "스트리밍 2 publish 시 안정 행 미재출력" 증분 프레임 단언 추가.
- **integration[권고] — 요약 불릿 미등록이 조용히 통과**: → 스모크 실패 throw 전파 + Task 8에서 출력 grep 재확인.
- **integration[권고] — Task 6∥7 빌드 레이스**: → Task 7 의존성에 Task 6 추가.
- **coverage[권고] — 로컬 애드혹 부트 dist 신선도 경고(하드닝)**: → 이번 계획에서는 거부(qa:runtime이 build 선행으로 e2e 보장; 로컬 부트는 빈 화면 워드마크 등 시각 마커로 자기 확인 가능). 향후 별개 하드닝 과제로 기록.

### Round 2 (3× REJECT → 개정)

- **feasibility/coverage[REJECT] — 존재하지 않는 회귀 커맨드**: `tests/orchestrator/work-shell-agent-console-model.test.mjs` 부재(실제는 tests/tui/ 소속이며 import 모듈도 상이 — `work-shell-agent-console-model.ts`). 수정 모듈(`work-shell-agent-console.ts`)의 유일 테스트 임포터는 `tests/orchestrator/agent-console-preview.test.mjs`. → 전략·Task 2 AC·Task 8·매핑의 4곳을 `tests/orchestrator/agent-console-preview.test.mjs` 단일 파일 실행으로 정정.
- **integration[REJECT] — `⎿` 글리프 이중 소유(조립 `⎿ {메트릭}` + 렌더 `  ⎿ `)**: → 라운드 1의 ● 규칙을 완결: 조립 텍스트는 전 행 글리프 없는 평문, 렌더러가 `● `(첫 행)/`  ⎿ `(첫 결과 행)을 소유. 하니스 단언에 "조립 텍스트 글리프 부재 + 렌더 프레임 글리프 존재" 2종 추가.
- **integration[REJECT] — Task 4의 ✻ dim 렌더 담당 파일 부재**(view는 Task 6과 병렬이며 6은 "불겹침" 주장 — ✻ dim이 어느 태스크 Files에도 없어 기대 미충족): → ✻ dim 렌더 브랜치를 Task 3(뷰 소유 태스크)으로 이동, Task 4는 엔진 누적+테스트로 순수화, Task 6의 불겹침 주장이 참이 됨.
- **integration[REJECT] — 행 확대 시 외부 클리어+증분 조합 붕괴**(Ink log-update 미변경 행 스킵, 전체 재편인트 분기는 lastOutputHeight>=rows 거짓, 미변경 프레임 스킵 — 확대 후 외부 클리어가 잔류 생성): → 클리어를 **축소(행·열 감소) 시에만**으로 제한(Ink 자체 리셋 비대칭과 정합), tui-entry-rendering에 행 확대 케이스(클리어 없이 증분 정합) 추가, Task 1 §6 규칙 문구 동일 정정.
- **integration[권고] — Task 2 Files에 엔진 테스트 누락·:2537-2550 핀 미언급**: → Files/AC에 추가.
- **integration[권고] — Task 5 Files에 work-shell-engine.ts 누락**: → 추가(state 타입·publish wiring). hooks `WorkShellPaneRuntimeState` 선택 필드도 추가.
- **integration[권고] — 조립 8행 캡 + 렌더 재캡 이중 ellipsis**: → 조립이 ellipsis를 1회 포함(8행 포함), 렌더에 `… +` 행 최대 1회 단언.
- **integration[권고] — 에러 행 `✖`와 킬 필터 문제**: → 필터는 첫 행 접두만 검사함을 명시, "첫 행 글리프 없음"으로 기준 정정(에러 표시 행은 첫 행이 아님).
- **integration[권고] — 스모크 실패가 러너에서 삼켜질 수 있음(status 하드코딩)**: → "실패는 throw뿐, 내부 catch 금지" 기준 명시.
- **integration[권고] — 계약 :269-308 편집 범위 제한**: → tool 행만·추가만, 타 역할 핀 무수정 통과로 제한.
- **coverage[권고] — 미정 이름들(상태 필드/헬퍼/불릿)**: → `streamingReasoningText`/`measureWorkShellEntryRows`/`scrollbackPageUp=true`로 고정.
- **coverage[권고] — Task 6 위험 계약 스위트 미명시**: → tui-dashboard·unclecode-cli 계약 파일을 AC에 명시 실행.
- **integration[권고] — 세션 재개가 tool 엔트리 drop(선결)**: → Architecture에 알려진 한계로 기록(Out-of-scope 사유 명시).

## Plan Amendment Log

(없음)
