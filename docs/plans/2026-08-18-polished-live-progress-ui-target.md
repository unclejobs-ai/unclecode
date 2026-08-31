# 2026-08-18 Unclecode 세련된 Live Progress UI 목표

> Historical design input. The authoritative hierarchy and implementation status are tracked in
> `2026-08-31-tui-p0-stability-hierarchy.md`.

## 사용자 레퍼런스에서 채택할 방향

Queue를 별도 칸반 보드처럼 보여 주기보다, 메인 작업 화면에서 **현재 실행 계획과 진행률을 컴팩트한 체크리스트로 지속 노출**한다. Queue 자체는 “다음 사용자 요청 목록”으로 유지하고, 아래 진행 목록은 WorkGraph/Plan 상태로 분리한다.

## 목표 레이아웃

```text
✓ Phase 1: 도구체인 잠금
○ Phase 2: engine 타입 분리 2/5
○ Phase 3: queue UX 정리
… +6 more · 3/9 done · 6 pending · Ctrl+T expand

⠋ Loading 25s · Enter queue · Ctrl+X steer · Ctrl+O tool history · Esc stop
────────────────────────────────────────────────────────────────────
> 
────────────────────────────────────────────────────────────────────
```

스크롤된 상태:

```text
↓ Fn+Right latest · ↑ 409 earlier rows · Fn+Up · ↓ 76 newer rows · Fn+Down
```

## 시각 디자인

- [ ] 완료 항목: 초록 `✓`, muted text, 취소선.
- [ ] 진행 항목: accent spinner 또는 채워진 원, 현재 단계만 강조.
- [ ] 대기 항목: 빈 원 `○`, 기본 text.
- [ ] 실패/막힘: 빨간 `×` 또는 warning diamond, 한 줄 원인과 복구 action.
- [ ] 기본 화면에는 현재 항목 주변 3개만 표시하고 나머지는 `… +N more`로 접음.
- [ ] `Ctrl+T`로 전체 진행 목록 확장/축소.
- [ ] `3/9 done · 6 pending`처럼 숫자 요약을 항상 제공.
- [ ] spinner/status와 progress 목록을 컴포저 바로 위에 배치.
- [ ] 구분선, 여백, accent 색을 일관되게 사용하고 중복 spinner/status 행을 만들지 않음.

## 정보 구조 분리

- [ ] **Live Progress / Plan:** 현재 요청을 완료하기 위한 내부 단계와 진행률.
- [ ] **Queue:** 현재 요청이 끝난 다음 실행할 사용자 follow-up 순서.
- [ ] **Jobs/Agents:** 백그라운드 또는 병렬 실행 단위.
- [ ] 세 개를 동일한 `queued/running/done` 용어로 뭉개지 않고 제목·아이콘·단축키를 분리.
- [ ] Live Progress의 완료 항목은 현재 turn 안에서만 유지하고, 장기 history를 queue에 섞지 않음.

## 상호작용

- [ ] `Enter`: busy 중에는 follow-up을 Queue에 추가하고 즉시 `Queued #N` 피드백.
- [ ] `Ctrl+T`: Live Progress 확장/축소.
- [x] `Ctrl+O`: 기존 단일 `minimal | verbose` trace mode를 전환해 이미 기록된 툴 호출 이력을 compact ↔ expanded로 다시 투영한다. Work/Plan/Sessions/Context를 열지 않고 draft, scroll, overlay 입력 소유권을 보존하며 반복 토글에도 transcript 행을 복제하지 않는다. Quality 상세는 `/review`와 Plan inspector가 소유한다.
- [ ] `Ctrl+X`: steer가 실제 지원될 때만 표시.
- [ ] `Esc`: 현재 실행 중단. 스크롤 상태에서는 최신 복귀와 충돌하지 않도록 우선순위를 명확히 함.
- [ ] Queue 관리 화면은 `/queue`; 진행 단계 상세는 `/todo` 또는 Agent Console Plan tab으로 연결.

## 스크롤 UX

- [ ] 스크롤 시 단순 `entries above` 대신 `earlier rows / newer rows`를 함께 표시.
- [ ] 현재 위치에서 최신으로 가는 단축키를 명시.
- [ ] macOS 키보드에서 실제 입력 가능한 `Fn+Up/Fn+Down`과 PageUp/PageDown을 함께 지원.
- [ ] 새 출력이 도착해도 사용자가 과거를 읽고 있으면 위치를 유지.
- [ ] 최신 위치에서는 자동 follow를 재개.
- [ ] 한글 다중 행의 실제 cell width를 기준으로 earlier/newer row 수를 계산.

## 응답·툴 블록 표현

- [ ] assistant 결과는 Markdown heading, bullet, inline code, 파일 경로를 명확한 계층으로 렌더.
- [ ] 변경 파일 목록은 path와 상태(`신규`, `삭제`, `수정`)가 시각적으로 정렬되게 함.
- [ ] 툴 호출은 트리 구조를 유지하되 긴 command/path는 핵심만 남기고 상세에서 전체 표시.
- [ ] 각 작업 묶음 사이에 한 줄 여백을 두되 화면 밀도가 과도하게 낮아지지 않게 함.
- [ ] 한글 자간이 벌어지지 않도록 grapheme/cell-width 기반 정렬만 사용.

## 검증

- [ ] 9개 단계 중 3개 완료, 1개 진행, 5개 대기 상태의 기본/확장 렌더 골든 테스트.
- [ ] 완료 취소선, 실패 원인, 진행 spinner, `+N more` 집계 테스트.
- [ ] Live Progress, Queue, Jobs 상태가 서로 섞이지 않는 모델/통합 테스트.
- [ ] 긴 한글 출력에서 스크롤 인디케이터의 earlier/newer row 수 정확성 테스트.
- [ ] 60/80/100/140열 레이아웃 테스트.
- [ ] 실제 tmux 부트에서 tool history 확장/축소, queue 추가, 스크롤, 최신 복귀 스모크.

## 완료 기준

1. 메인 화면만 보고 현재 단계, 전체 진행률, 남은 작업을 이해할 수 있다.
2. Live Progress와 Queue와 Jobs의 역할이 혼동되지 않는다.
3. 진행 목록은 컴팩트하지만 필요할 때 전체와 상세를 열 수 있다.
4. 스크롤 위치와 최신 복귀 방법이 항상 보인다.
5. 한글과 좁은 터미널에서도 시각적 계층과 정렬이 유지된다.

## 연계 문서

- `docs/plans/2026-08-18-queue-ux-redesign-todo.md`
- `docs/plans/2026-08-18-scroll-usability-hotfix-todo.md`
- `docs/plans/2026-08-18-korean-terminal-support-hotfix-todo.md`
- `docs/superpowers/specs/2026-08-09-agent-console-control-surface-design.md`
