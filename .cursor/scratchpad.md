# UncleCode 정비 스크래치패드 (2026-07-03)

## Background and Motivation

사용자 요청: 클라우드(origin/main에 올라간 Cursor Cloud 에이전트 작업)와 로컬 상태를 점검하고, 기획/설계 오케스트레이션은 Fable 5, 실행은 Composer 2.5 워커로 수행. 대상 영역:

1. project 폴더의 런북 동기화 (`docs/runbooks/unclecode-normalization-runbook.md` ↔ 실제 상태, 그리고 별도 레포 `~/project/runbook`과의 경계)
2. 지금 main(origin/main)에 있는 것과 로컬의 격차 점검
3. TUI 한글/UTF-8(표시 폭) 문제 점검·개선
4. UI/UX 디자인 세련화 (DESIGN.md 디자인 시스템 대비 구현 격차)
5. 전 과정 문서화

## Key Challenges and Analysis

- **Git 상태**: 로컬 `main`이 `origin/main` 대비 behind 2 (`4c89c84` Cursor Cloud 지침, `0998d43` package-lock 동기화). ahead 0 → fast-forward 안전. 로컬 미커밋 변경 74파일(+3,819/-771)은 pull 대상 파일(AGENTS.md, package-lock.json)과 겹치지 않음을 확인.
- **클라우드 서브에이전트 불가 사유**: Cursor Cloud 에이전트는 원격 브랜치 스냅샷만 보므로 미커밋 74파일 감사가 불가능 → 로컬 백그라운드 워커(composer-2.5)로 실행.
- **런북 이원화**: `~/project/runbook`은 별도 제품(Local-first AgentOps DB) 레포. unclecode의 `packages/orchestrator/src/agentops-recorder.ts`(커밋 6a4cc80)가 유사 개념(black-box DB)을 구현 중 → 경계/역할을 unclecode 런북 문서에 명시 필요.
- **런북 신선도**: `unclecode-normalization-runbook.md`는 "Last validated: 2026-06-28". 이후 scripts/health-qa/*, scripts/runtime-qa/*, scripts/qa/web-terminal-visual-qa.mjs 등 다수 신설 → 재검증 + 갱신 필요.
- **TUI 한글/UTF**: DESIGN.md가 "한글/CJK/이모지 폭을 1급 display-width 케이스"로 규정. `scripts/runtime-qa/tui-korean-smoke.mjs` 존재. `.length` 기반 레이아웃 계산 잔존 여부 전수 감사 필요.
- **파일 소유권 경계**: 워커 A(문서/감사)는 docs/**만 수정, 워커 B(TUI)는 packages/tui/** + tests/tui/** + tests/contracts/tui-* + scripts/runtime-qa/tui-*만 수정. scratchpad는 조정자(Fable 5)만 갱신.

## High-level Task Breakdown

- [x] T0. origin/main fast-forward 동기화 (조정자) — 성공 기준: `git status -sb`에 behind 없음
- [ ] T1. (워커 A / composer-2.5) 워크트리 전수 감사 + 런북 동기화 + 문서화
  - 성공 기준: (a) `docs/audits/2026-07-03-worktree-audit.md` 생성, 74파일 변경을 영역별 분류·설명 (b) 런북 Last validated 갱신 + qa:health 실제 실행 근거 반영 (c) runbook 레포와 agentops-recorder 경계 문서화
- [ ] T2. (워커 B / composer-2.5) TUI 한글/UTF + UI/UX 세련화
  - 성공 기준: (a) `.length` 기반 폭 계산 결함 목록화 및 수정 (b) tui-korean-smoke 통과 (c) DESIGN.md 대비 격차 수정 목록 및 반영 (d) tests/tui + tui 계약 테스트 통과
- [ ] T3. (조정자) 종합 검증 게이트 + 최종 보고
  - 성공 기준: 관련 테스트 스위트 그린, scratchpad 갱신, 사용자 보고

## Project Status Board

- [x] T9-A1 OpenAI stream:true + SSE + stream smoke → `51d5aed`
- [x] T9-A2 슬래시 발견성·인자 힌트 → `2ac2f76`
- [x] T9-A3 truncate-end 한글·이모지 (display-width 테스트) → `2ac2f76`
- [x] T9-A4 워크플로우·컴포저 UX → `8a3ef52` (composer hint row, busy/queue dock accent, resolveWorkShellComposerHint, test:tui 86/86 + contract 46/46)
- [x] T9-B1 context-packet 정본화 → broker 단일 정본 + orchestrator re-export
- [x] T9-B2 컨텍스트 한글 display-width → `truncateForDisplayWidth` in broker
- [ ] T9-B3 메모리 투명성 (보류)
- [ ] T9-B4 런북 재대조 (보류 — T10 게이트 후)
- [x] T9-C1 TUI design pass (conversation rail, status grouping, composer/footer chrome) — Executor 7/5 02:xx
  - 산출: single-line rail, grouped status strip (`model · mode │ auth │ activity`), lighter prompt divider, footer = cwd + one context chip, busy copy `⠋ 1.5s · detail`
  - 검증: test:tui 86/86, contract tui-work-shell 46/46, packages/tui tsc OK (full npm run build blocked by Worker B orchestrator WIP)
  - 커밋: `feat(tui): refine conversation, spinner, and composer visual design`
- [x] T0 origin/main 동기화
- [x] T1 감사+런북 동기화 (워커 A 완료 2026-07-03 21:28)
- [x] T2 TUI 한글/UX 개선 (워커 B 완료 2026-07-03 21:30)
- [x] T3 종합 검증·보고 (qa:health 전체 그린 2026-07-03 21:31, exit 0)
- [x] T4 8단위 커밋 분할 실행 (워커 C 완료 2026-07-03 22:01 — 8커밋 4951159..0ac7b9f, 훅 전부 통과, 워크트리 클린(.cursor/만 의도적 제외), push 안 함)
- [x] T5 /simplify 간소화 패스 (2026-07-03 22:13 ~ 2026-07-04 09:47 완료 — 스코프 0998d43..HEAD)
  - [x] 리뷰어 3개 완료 (22:36): 품질 22건(즉시 7·스테일 5·간소화 7·판단 3), 성능 9+3건(즉시 7), 재사용 11건(즉시 7)
  - [x] 수정 적용: 워커가 21파일(+137/-204) 적용 후 서브에이전트 인프라 네트워크 오류로 반복 중단(DNS ENOTFOUND, 생성 타임아웃) → 조정자가 diff 전수 검수 후 게이트 직접 완주로 폴백
  - [x] 검증 게이트 (7/4 09:46): npm run build OK, cargo build OK, qa:health 14/14 PASS exit 0 (typecheck·lint·work/cli/tui 테스트 포함) — 간소화 수정 확정, 워킹트리에 미커밋 상태로 보존
  - 적용 요약: `-api-blocked` 라벨 규칙 단일 정본화(`workShellAuthLabelWithApiBlocked`), WCAG 대비 헬퍼·`isCredentialBlockedText`·`escapeRegExp` 중복 제거(cli-helpers.mjs 정본), SessionList 폴백 문자열 중복 제거(명시 props), 죽은 삼항(`signal?1:1`)·중복 에러 분기(cli_auth.rs)·미사용 options 파라미터 제거, 스트리밍 텍스트 캐시 512 상한+스트리밍 커서 텍스트 저장 생략(무한 축적 해소), composer dock 레이아웃 캐시 제거, 푸터 중첩 삼항 평탄화, Rust json! 라운드트립 제거(research_run.rs), slash 제안 선택/비선택 색 구분(DESIGN.md "selected commands = user 액센트" 정합 — 워커 B 보류 항목 해소)
  - 보류(권고로 기록): env_var_any 빈값 폴백(동작 변경, 승인 필요), TS fast-path↔Rust ux_text/ux_panels 이중 구현 통합·푸터 카피 발산(설계 판단), 스트리밍 델타당 동기 Rust 스폰 3회 감축(아키텍처), live 리포트 톱레벨 work 이중 저장(JSON 계약 고정), qa:health 중복 빌드·100ms ps 폴링(타이밍 계약), fake 서버 3종·tmux 세션 보일러플레이트·테스트 픽스처 3중 통합(워커 중단으로 미적용, 저위험이나 규모 있음)

- [x] T6 UX 실화면 검수·개선 (7/4 14:04 ~ 22:59 완료)
  - [x] 실화면 검수 완료 (14:09): 종합 3.5/5. 캡처 9종 `.unclecode/qa/ux-review-2026-07-04/`. pass: 폭 정렬(100col)·팔레트/대비·busy 스피너 단일성·empty state·한글 입출력. gap 7건: P1 리사이즈 잔상(72col 헤더 두 겹), P2 긴 응답 heavy card 전환, P3 스트리밍 중 부분 텍스트 미표시, P4 대시보드 empty detail 절단(…)·git unknown 라벨, P5 /context 과밀, P6 푸터 cwd 소실(TS↔Rust 카피 발산 증상), P7 slash 선택 강조 약함
  - [ ] 개선 워커 실행 중 (14:09~): P1/P2/P4/P6/P7 필수, P3 조사 후 저위험시 수정, P5 보수적. 게이트 유지 + after 캡처 증명 요구
  - 18:17 인프라 오류(PING timeout)로 중단 — 진행분: TUI 6파일+ux_text.rs 수정, terminal-resize-clear.ts 신설. 18:19 재개도 19:26 무음 중단 → 조정자 직접 마무리로 전환
  - [x] 조정자 마무리 (22:43~22:59): ① ux_text.rs Rust 소유권 오류 수정(path.clone() — work 테스트 87건 연쇄 실패 원인) ② shouldUseCompactAssistantSurface 스텁(무조건 true)을 계약 테스트가 고정한 임계값 구현으로 복원 — P2는 "짧은 응답 rail / 긴 응답 카드"가 의도된 계약으로 판정 ③ 미사용 detailWidth prop 제거
  - [x] 최종 게이트 (22:59): build OK + qa:health **14/14 PASS exit 0** (64.9s, resize=true 유지) + after 캡처 14종 생성 (.unclecode/qa/ux-review-2026-07-04-after/)
  - before→after 확증: **P1 해소** (72col 헤더 두 겹·찢김 → 단일 헤더·정상 줄바꿈), **P4 해소** (empty detail `…` 절단 → 전문 줄바꿈, git unknown → no git repo), **P6 해소** (대화 후 푸터 `~/project/unclecode` 유지), **P7 적용** (선택 bold), **P5 경미 개선** (중복 hidden 줄 정리). **P3 미확증** (after 캡처가 elapsed 0ms 시점이라 델타 미표시 — streamingAssistantText 전달 조건은 수정됨, 실증은 추후), **P2 계약 유지** (변경하려면 테스트·스모크 동반 설계 결정 필요)
  - 최종 diff: 25파일 +228/−234 + 신규 terminal-resize-clear.ts (미커밋, T5 간소화분 포함)

- [ ] T7 커밋 확정 + 최종 게이트 (7/4 23:21~)
  - [x] 2커밋 완료: `5887eeb` refactor(간소화 17파일 +90/−169), `786b16c` fix(tui) UX 개선(15파일 +529/−73). 훅 통과, 잔여 `?? .cursor/`만. origin 대비 10커밋 ahead, push 안 함.
  - [!] 발견(23:44 정정): 22:59~23:21 사이 추가 변경의 주체는 외부 세션이 아니라 **전사 동기화만 끊긴 채 계속 실행 중이던 T6 UX 워커(41f9c80b)**였음. 해당 워커가 P1을 dashboard-shell `prependListener` 방식으로 재구현+전용 테스트, P2를 "모든 응답 rail(카드 제거)"로 확정하며 계약·단위 테스트 동반 갱신, P6 푸터 cwd 불변 계약 추가, 신규 테스트 5파일 289줄. 워커 최종 보고(23:44): P1/P2/P4/P6/P7 완료, P5 보류, **P3 근본 원인 = OpenAI chat-completions 요청 바디에 `stream:true` 부재 (아키텍처 수준, 미수정 — 후속 과제)**. 조정자 판단 오류 교훈: 전사 mtime 정체 ≠ 워커 사망.
  - [x] 커밋 트리 게이트 재실행 결과 (23:26): **FAIL** — runtime QA의 context contrast 스모크 타임아웃. `/context` 후 "Context opened."는 뜨지만 Context expanded 오버레이가 렌더되지 않음. 22:59 워크트리에선 통과했으므로 786b16c에 포함된 외부 세션 변경이 회귀 원인 (용의: compact 스텁/오버레이 라인 처리/resize-clear prependListener의 Ink 상호작용)
- [x] T8 오버레이 회귀 수정 + 디자인·스피너 고도화 (7/4 23:29~23:41 완료, 사용자 스크린샷 지시)
  - 회귀 근본 원인: `/context` 제출 후 한 프레임 동안 composer에 남은 `/context` 때문에 slash picker가 Context expanded 패널을 override → overlay 미렌더. `work-shell-panels.ts`에서 Context expanded 우선순위 보장으로 수정 + 계약 테스트 고정
  - 스피너 1000ms→100ms(DESIGN.md Motion 동기화), 배지 suffix 제거(`◇ You`/`◈ UncleCode`), 시스템 피드백 muted 통일, /context 오버레이 컴팩트 행(64자 절단 규칙) 재구성
  - 게이트: qa:health 14/14 PASS(71.4s), test:tui 79/79. after 캡처 `.unclecode/qa/ux-review-2026-07-05-design/`. 7파일 +77/−27 미커밋
  - 후속 제안(보류): context-packet-view 중복 정본화, omo 한글 요약 display-width 절단, resize-clear race 재현 시 Ink repaint 정합
  - [x] 커밋 완료 (7/5 00:05): `3fe23ea` fix(tui): keep context overlay above slash picker and refine motion design. 훅 통과, 워크트리 클린(.cursor/만). **origin 대비 11커밋 ahead, push 대기**
  - 사용자 지적: 디자인·스피너 세련되지 않음. 범위: ① 회귀 수정(최우선) ② 스피너 1000ms → 80~120ms + DESIGN.md Motion 갱신 ③ /context 오버레이 과밀 재구성 ④ 엔트리 배지 message/reply 중복 라벨 정리 ⑤ 시스템 피드백 줄 스타일 통일. DESIGN.md 수정 이번엔 허용(디자인 개정 지시). 게이트+after 캡처 증명 요구
  - [x] 회귀 원인: `/context` 제출 직후 composer에 `/` 입력이 남아 slash picker(Commands)가 `Context expanded` 엔진 패널을 덮어씀 → `resolveWorkShellActivePanel`에서 fallback이 Context expanded일 때 slash override 차단
  - [x] 스피너 1000ms → 100ms (`WORK_SHELL_SPINNER_INTERVAL_MS`), DESIGN.md Motion 표 갱신
  - [x] 오버레이 컴팩트 행 재구성 (`work-shell-context-packet.ts`): Sources 팩트 라인 유지, 그룹 `label · count · 64자 요약`, hidden 1줄, Context·/Controls·/UncleCode· 노이즈 제거
  - [x] 배지 message/reply 제거, system 피드백 muted+dim glyph
  - [x] 게이트: qa:health 14/14 PASS (71.4s), after 캡처 `.unclecode/qa/ux-review-2026-07-05-design/`
  - diff: 7파일 +77/−27 (미커밋)

- [ ] T9 Fable 전용 종합 고도화 사이클 (7/5 00:22~, 사용자 지시: fable로만, 런북·디자인 UI/UX·워크플로우·메모리·컨텍스트·슬래시 제대로 고도화)
  - **Planner 재계획 (7/5 01:45, 사용자: planner → executor gogo)**
  - 순서: A1→A2→A3→A4(동일 워커 연속) → B1→B4(순차) → T10 통합 게이트+커밋
  - 규칙: 워커는 qa:health 전체 금지. A는 `test:work`(openai-provider), `node scripts/runtime-qa/tui-openai-stream-smoke.mjs`, `test:tui`, 계약 `tui-work-shell`만. B는 context-broker/orchestrator 단위 테스트만.
  - [ ] **T9-A1 스트리밍 근본 수정** (워커 A, 진행 중 — 워킹트리 6파일 +578/−16)
    - 산출: `runtime.ts` live fetch+`stream:true`+SSE trace, fake 서버 chunk delay, `tui-openai-stream-smoke.mjs`, provider 테스트 3건
    - 성공 기준: `cargo build` 후 openai-provider 29/29, stream 스모크 PASS(partial+cursor+final+cleared), tui-suite에 wired
    - 커밋 단위: `feat(providers): stream OpenAI chat completions with live SSE traces`
  - [ ] **T9-A2 슬래시 발견성·인자 힌트** (워커 A, A1 직후)
    - 대상: `work-shell-slash.ts`, `work-shell-panels.ts`, `work-shell-view.tsx`(composer hint)
    - 개선: (a) `/` 단독·부분 토큰 prefix 매칭 정렬 강화 (b) 선택 항목에 인자 placeholder 힌트(예: `/model <id>`, `/mode set <profile>`) (c) no-match 카피·footer hint DESIGN.md 톤 정합 (d) repl/orchestrator 슬래시 테스트 보강
    - 성공 기준: 기존 repl+orchestrator slash 테스트 그린, 신규 hint/매칭 테스트 ≥2
  - [ ] **T9-A3 Ink truncate-end 한글·이모지** (워커 A)
    - 대상: `work-shell-view.tsx`, `dashboard-components.tsx`, `text-width.ts` — `wrap="truncate-end"` 사용처를 display-width 절단으로 교체 또는 Ink Text에 pre-truncated 문자열 주입
    - 성공 기준: `tui-korean-smoke` hangulResidual=false 유지, 신규/기존 truncate 계약 테스트 그린
  - [x] **T9-A4 워크플로우·컴포저·대화 UX** (워커 A 2차 브리프, A3 직후) → `8a3ef52`
    - 산출: dedicated composer hint row, busy/queue dock accent, `resolveWorkShellComposerHint`, footer hint 분리
    - 성공 기준: test:tui 86/86, contract tui-work-shell 46/46, TUI tsc OK (full `npm run build` blocked by Worker B context-broker WIP)
  - [ ] **T9-B1 context-packet 단일 정본** (워커 B, A4 완료 후)
    - `context-packet-view.ts` ↔ `work-shell-context-packet.ts` 중복 제거, orchestrator가 broker view import
    - 성공 기준: context-broker+orchestrator 테스트 그린, diff 단일 소스
  - [ ] **T9-B2 컨텍스트 한글 display-width** (워커 B)
    - omo/요약 라인 `truncateForDisplayWidth` 적용, 64자 규칙과 정합
  - [ ] **T9-B3 메모리 투명성** (워커 B)
    - 스코프·인용·freshness 라벨, prefetch degrade 경로 실증(단위/스모크)
  - [ ] **T9-B4 런북 재대조** (워커 B)
    - T9 변경(stream/slash/context) 반영, Last validated 갱신
  - [ ] **T10 통합** (조정자): qa:health 14/14, 커밋 분할(A1/A2-A4/B), scratchpad 완료 선언
  - [+] 사용자 추가 지시 (00:25): 스피너·입력창·대화·입력→큐→busy→응답→idle — T9-A4에 편입

## Current Status / Progress Tracking

- 2026-07-05 01:45: Planner가 T9를 A1–A4 + B1–B4 + T10으로 재분해. Executor 즉시 T9-A1(스트리밍 미커밋 6파일) 검증·커밋부터 착수.
- 2026-07-05 02:xx: T9-C1 TUI design pass 완료 — conversation rail 단일화, status `│` 그룹, prompt deck 경량화, footer cwd+context chip only. test:tui 86/86, contract 46/46.
- 2026-07-05 02:xx: Executor 완료 — A1 `51d5aed`(stream+smoke 29/29+PASS), A2/A3 `2ac2f76`(slash hints+display-width tests), B1/B2 context-broker 통합 커밋 직전. A4/B3/B4 보류. T10 qa:health 실행 예정.
- 2026-07-03 21:1x: 조정자(Fable 5)가 초기 조사 완료. behind 2 확인, ff-pull 실행. 워커 A/B(composer-2.5-fast) 백그라운드 발사.
- 2026-07-03 21:28: 워커 A 완료. 산출물: `docs/audits/2026-07-03-worktree-audit.md` 신규, 런북 갱신(QA 표면 맵, 7/3 검증 기록, Known issues, Runbook 제품 경계). qa:health 85.8s exit 1 — 11항목 통과, runtime QA 1건 실패(tui-basic-smokes.mjs:56, 풀스크린 TUI 헤더에 truecolor 전경색 `38;2;15;23;42m` 부재), live provider QA는 fail-fast로 미실행. Cloud/local 정합성 OK (Node 22.22.0, Cargo 1.94.1).

## Executor's Feedback or Assistance Requests

- [T1→T2 인계] runtime QA 실패는 워커 B 영역: 풀스크린 TUI 헤더 전경색이 truecolor로 방출되지 않아 라이트 터미널 대비 게이트 실패. → **워커 B가 해소 보고**: 근본 원인은 tmux `capture-pane -e`가 `FORCE_COLOR` 없이는 truecolor ANSI를 캡처하지 못하는 것. `tui-context-contrast-smoke.mjs`·`tui-basic-smokes.mjs`에 `FORCE_COLOR=3` 적용 후 통과.
- [T2 결과 요약] 실제 폭 버그 2건 TDD 수정: `work-shell-auth-panels.ts:150` `compactContextValue`가 raw `.length`/`.slice`로 한글 중간 절단 가능 → `truncateForDisplayWidth`로 교체; `dashboard-primitives.tsx:66` `RoundedPanel` 상단 테두리 +1칸 넘침 → 정확히 width칸으로 수정. tests/tui+contracts 197/197, tsc, 한글/대비/기본 스모크 모두 통과. 보류 항목: Ink `wrap="truncate-end"` 내부 절단, slash suggestion 색상(의도 불명), 이모지/ZWJ 심화.
- [T3 게이트 결과 — 완료] `npm run qa:health` 14항목 전체 PASS, exit 0 (53.8s). runtime QA 증거: geminiTool/openaiTool/anthropicTool/toolFinalGate/lightContrast/spinner/queueDrain/resize/idleStable/latencyOk 모두 true, hangulResidual=false, duplicateBusy=false. live provider QA는 이번엔 fail-fast를 지나 실행됐고 예상된 외부 auth 차단 상태(openai-oauth-codex-runtime-not-api-ready)로 "blocked recorded" 처리 — 런북에 문서화된 정상 복구 경로(자격증명 갱신 후 qa:live). 리포트: .unclecode/qa/runtime-qa-latest.json, .unclecode/qa/live-provider-latest.json.
- [Planner 교차검증] T1 산출 문서 존재 확인, T2 수정이 T1의 게이트 실패를 실제 해소함을 qa:health 재실행으로 확인. 본 사이클 완료 선언. 커밋은 사용자 지시가 없어 하지 않음 — 감사 문서의 "커밋 분할 제안" 8단위 참고.

## Lessons

- 로컬 미커밋 변경 감사는 클라우드 에이전트로 불가 (원격 스냅샷만 접근 가능) → 로컬 워커 사용.
- `git show`가 이 저장소에서 ~90초 걸릴 수 있음 (대형 팩파일 추정). 타임아웃 여유 필요.
- 서브에이전트 인프라가 네트워크 오류(DNS ENOTFOUND, 생성 타임아웃)로 반복 실패할 수 있음 → 워커의 부분 산출물(워킹트리 diff)은 남아 있으므로, 조정자가 diff 전수 검수 + 검증 게이트를 백그라운드 셸로 직접 완주하는 폴백이 유효.
- 단, **전사(transcript) mtime이 멈췄다고 워커가 죽은 것이 아님** (동기화 지연일 수 있음). 실제로 T6 워커는 오류 알림 후에도 계속 작업해 나중에 정상 완료 보고를 보냈고, 그 사이 조정자 검증과 레이스가 발생했음. 폴백 개입 전에 워크트리 mtime(파일 변경 지속 여부)로 활동성을 확인할 것.
- `qa:health`가 typecheck·lint·work/cli/tui 테스트를 이미 포함하므로 별도 단위 테스트 게이트를 중복 실행할 필요 없음.
- JSON 리포트 필드·타이밍 상수는 계약 테스트/런북이 고정한 외부 계약 — 간소화 대상에서 제외하는 정책이 유효했음 (qa:health 재실행으로 확인).
