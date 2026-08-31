# 2026-08-18 Unclecode TUI 스크롤 사용성 핫픽스 TODO

> Historical intake record. Current implementation and acceptance status are tracked in
> `2026-08-31-tui-p0-stability-hierarchy.md`; unchecked items below are not a current release checklist.

## 사용자 확인 문제

긴 응답이 터미널 높이를 넘어가도 과거 내용을 위로 올려 볼 수 없다. 현재 문서상 `PageUp`/`PageDown` 스크롤백이 존재하더라도, 실제 Unclecode 실행 화면에서 사용자가 발견하거나 정상 조작할 수 없으면 **스크롤 미지원과 동일한 P0 사용성 결함**으로 취급한다.

## 우선순위

### P0 — 실제 실행 화면에서 스크롤 복구

- [ ] 첨부 화면과 동일한 실제 부트 체인(`bin → rust → node dist`)에서 긴 대화 재현.
- [ ] `PageUp`/`PageDown` 입력이 어느 계층에서 유실되는지 확인하고 앱 소유 트랜스크립트 스크롤로 연결.
- [ ] 노트북 키보드의 `Fn+↑`/`Fn+↓`가 보내는 Home/PageUp 계열 입력도 확인.
- [ ] 위로 이동하면 `↑ N entries above · PageUp/PageDown scroll · Esc newest` 인디케이터가 즉시 보이게 함.
- [ ] `PageDown`과 `Esc`로 최신 응답에 복귀하며, 새 출력 도착 시 사용자가 위를 읽는 동안 강제로 맨 아래로 점프하지 않게 함.
- [ ] 긴 사용자 메시지·긴 어시스턴트 답변·다중 행 툴 결과가 섞여도 줄이 잘리거나 스크롤 범위가 잘못 계산되지 않게 함.

### P1 — 일반적인 스크롤 조작 지원

- [ ] 마우스 휠/트랙패드 스크롤을 앱 트랜스크립트 스크롤에 연결할 수 있는지 조사하고 구현.
- [ ] 마우스 이벤트 지원이 터미널별로 불안정하면 `Ctrl+U`/`Ctrl+D` 또는 동등한 보조 키를 제공.
- [ ] 입력창에 초안이 있어도 스크롤 키가 초안을 훼손하지 않게 함.
- [ ] Context Desk·Agent Console 등 자체 스크롤 영역이 열려 있을 때는 포커스된 영역이 입력을 우선 소유하게 함.

### P1 — 발견 가능성

- [ ] 대화가 한 화면을 넘는 순간 컴포저 근처에 짧은 스크롤 힌트를 노출.
- [ ] `/help`에 실제 지원 키와 최신 복귀 키를 명시.
- [ ] 터미널 네이티브 스크롤백이 alt-screen 때문에 동작하지 않는다는 점을 사용자에게 강요하지 말고, 앱 내부 조작만으로 해결 가능하게 함.

## 회귀 테스트

- [ ] TUI 단위 테스트: 짧은 대화에서는 no-op, 긴 대화에서는 PageUp/PageDown/Esc 이동.
- [ ] 행 가중 테스트: 단일 행과 다중 행 엔트리의 실제 렌더 높이를 기준으로 offset/viewport 계산.
- [ ] 입력 충돌 테스트: 작성 중 초안, busy 상태, 오버레이 열린 상태.
- [ ] tmux 런타임 스모크: 작은 높이의 pane에서 12턴 이상 생성 → PageUp → 과거 항목 및 인디케이터 확인 → Esc → 최신 복귀.
- [ ] 가능하면 마우스 휠 escape sequence를 포함한 런타임 테스트 추가.
- [ ] `src` 테스트뿐 아니라 최신 `dist`를 빌드한 사용자 실행 경로에서 검증.

## 완료 기준

1. 첨부 화면처럼 응답이 화면을 넘은 상태에서 사용자가 과거 내용을 실제로 읽을 수 있다.
2. 키보드만으로 위/아래 이동과 최신 복귀가 확실히 동작한다.
3. 지원 가능한 터미널에서는 마우스 휠/트랙패드도 동작한다.
4. 스크롤 중 새 출력, 다중 행 툴 블록, 창 크기 변경으로 위치가 튀거나 내용이 사라지지 않는다.
5. 자동화된 TUI 테스트와 실제 부트 체인 스모크가 모두 통과한다.

## 관련 기존 계획

- `docs/glm-hammer/plans/2026-08-15-tui-main-ux-overhaul.md` Task 11
- `docs/glm-hammer/plans/2026-08-16-tui-tool-trace-stability.md` Task 3 / Task 7

기존 계획의 “PageUp 스모크 존재”를 완료 증거로 간주하지 않는다. **사용자 실행 환경에서 실제로 스크롤할 수 있다는 재현 증거**가 있어야 이 TODO를 닫는다.
