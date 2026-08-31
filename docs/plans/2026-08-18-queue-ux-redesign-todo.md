# 2026-08-18 Unclecode Queue UX 재설계 TODO

> Historical intake record. Current implementation and acceptance status are tracked in
> `2026-08-31-tui-p0-stability-hierarchy.md`; unchecked items below are not a current release checklist.

## P1 — Queue의 의미와 조작 방식을 명확하게 재설계

### 사용자 확인 문제

현재 Queue 디자인은 사용자가 다음을 즉시 이해하기 어렵다.

- 지금 무엇이 실행 중인지
- 입력한 메시지가 바로 실행되는지 대기열에 들어가는지
- 어떤 항목이 다음에 실행되는지
- 왜 멈췄는지
- 대기 항목을 어떻게 취소·삭제·재정렬하는지
- `/queue`, Agent Console의 Jobs, 백그라운드 agent 작업이 서로 어떻게 다른지

기존의 `대기 / 진행 / 막힘 / 완료` 미니 칸반은 상태를 많이 보여 주지만, 실제 queue 관리보다 작업 보드처럼 보여 개념을 흐릴 수 있다. 특히 read-only 패널이면 사용자가 상태는 보면서도 바로 해결할 수 없다.

## 제품 결정

### Queue의 단일 정의

- [ ] Queue를 **현재 turn이 끝난 뒤 순서대로 실행될 사용자 follow-up 요청 목록**으로 명확히 정의.
- [ ] Agent/Job의 비동기 실행 목록과 Queue를 UI·용어·데이터 모델에서 분리.
- [ ] `Done`은 queue가 아니라 history이므로 기본 Queue 화면에서 제거하거나 별도 최근 완료 영역으로 축소.
- [ ] `Blocked`가 queue item 상태인지 전체 queue 상태인지 구분하고, 전체 pause 이유는 상단 상태로 표현.
- [ ] busy 중 Enter의 동작을 `send now`가 아니라 `queue follow-up`으로 명확히 표시.

## 정보 구조

- [ ] 상단에 한 줄 상태: `Running`, `Paused`, `Idle` 중 하나와 현재 작업 요약.
- [ ] 본문은 실행 순서가 명확한 단일 리스트로 표시: `Next`, `#2`, `#3`.
- [ ] 각 항목에 안정적인 id, 한 줄 preview, 생성 시각 또는 대기 시간, attachment 유무를 표시.
- [ ] pause/blocked 상태이면 원인과 해결 행동을 같은 영역에 표시.
- [ ] 항목이 없을 때는 칸반의 빈 4열 대신 `Queue empty · new messages run immediately`처럼 다음 동작을 설명.
- [ ] 좁은 터미널에서도 순서와 핵심 action이 잘리지 않도록 단일 열을 기본 레이아웃으로 검토.

## 직접 조작

- [ ] Queue 패널을 read-only에서 실제 관리 화면으로 전환.
- [ ] 커서 이동 후 개별 항목 삭제.
- [ ] 전체 clear 전에 삭제될 개수를 보여 주고 확인.
- [ ] 항목을 위/아래로 이동하여 실행 순서 변경.
- [ ] paused queue의 resume 제공.
- [ ] 선택 항목 상세 preview 제공. 첨부 파일이 있으면 종류와 개수를 표시.
- [ ] destructive action과 단순 닫기 키를 분리하고 하단에 현재 가능한 키만 표시.

## 메인 화면과의 연결

- [ ] busy 중 composer 라벨을 `Queue a follow-up…`처럼 동적으로 변경.
- [ ] 제출 직후 `Queued #N` 피드백과 현재 대기 개수를 한 번만 표시.
- [ ] 메인 화면의 queue indicator를 선택하면 동일한 Queue 화면이 열리게 함.
- [ ] queue가 pause되면 경고와 resume action을 컴포저 가까이에 표시.
- [ ] 현재 항목이 시작될 때 queue에서 running으로 원자적으로 전환되어 중복·유실처럼 보이지 않게 함.
- [ ] interrupt, cancel, clear, resume의 차이를 UI 문구로 명확히 구분.

## 명령 체계

- [ ] `/queue`는 조회·관리의 단일 진입점으로 유지.
- [ ] `/queue clear`, `/queue remove <id>`, `/queue move <id> up|down`, `/queue resume`의 필요성을 검토하고 UI action과 동일한 backend command를 사용.
- [ ] `/jobs`는 비동기 agent/job 실행, `/queue`는 현재 세션 follow-up이라는 차이를 `/help`에 명시.
- [ ] busy 중 허용되는 queue 관련 명령과 일반 slash command의 동작 차이를 설명.

## 한글·스크롤 연계

- [ ] 한글 queue preview의 폭 계산, 줄바꿈, truncation이 음절을 깨뜨리지 않게 함.
- [ ] 항목이 화면 높이를 넘으면 Queue 내부 스크롤이 확실히 동작.
- [ ] 메인 transcript 스크롤과 Queue 패널 스크롤의 입력 소유권을 명확히 분리.
- [ ] `PageUp/PageDown`, 방향키, Esc가 어떤 영역을 조작하는지 footer에 표시.

## 검증

- [ ] idle 제출은 즉시 실행되고 busy 제출은 정확히 한 번 queue에 추가되는 엔진 테스트.
- [ ] 순서 보존, 개별 삭제, clear, reorder, pause/resume 테스트.
- [ ] interrupt 직후 queue가 pause되고 resume 후 다음 항목이 한 번만 실행되는 race 테스트.
- [ ] attachment가 포함된 queued item의 보존 테스트.
- [ ] 60/80/100/120열 및 긴 한글 preview 렌더 테스트.
- [ ] Queue 내부에 많은 항목이 있을 때 키보드 스크롤 및 선택 유지 테스트.
- [ ] 실제 tmux 부트에서 busy → 3개 입력 → 순서 확인 → 재정렬 → 하나 삭제 → resume → 실행 순서 확인 스모크.
- [ ] `/queue`와 `/jobs`를 번갈아 열어도 상태가 섞이지 않는 통합 테스트.

## 완료 기준

1. 처음 보는 사용자가 Queue가 무엇이고 다음에 무엇이 실행되는지 즉시 이해한다.
2. Queue 화면 안에서 조회뿐 아니라 삭제·재정렬·clear·resume을 수행할 수 있다.
3. Queue와 Jobs/Agents의 역할이 명확히 분리된다.
4. busy 제출, interrupt, pause, resume 과정에서 항목이 중복되거나 유실되지 않는다.
5. 한글과 작은 터미널에서도 순서·상태·조작 방법이 명확하다.
6. 자동화 테스트와 실제 부트 체인 스모크가 모두 통과한다.

## 관련 문서 및 TODO

- `docs/design/work-queue-board-t15.md`
- `docs/plans/2026-08-18-scroll-usability-hotfix-todo.md`
- `docs/plans/2026-08-18-korean-terminal-support-hotfix-todo.md`
- `docs/plans/2026-08-18-approval-policy-ui-hotfix-todo.md`

기존 Queue 패널이 렌더되고 상태 열 네 개가 보인다는 사실만으로 완료 처리하지 않는다. **사용자가 대기 순서를 이해하고 화면 안에서 직접 관리할 수 있어야** 재설계를 완료한 것으로 본다.
