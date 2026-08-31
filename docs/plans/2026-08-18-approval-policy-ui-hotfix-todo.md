# 2026-08-18 Approval Policy/UI 핫픽스 TODO

> Historical intake record. Current implementation and acceptance status are tracked in
> `2026-08-31-tui-p0-stability-hierarchy.md`; unchecked items below are not a current release checklist.

## P0 — `Always allowed: bash` 이후 재승인 요청

### 사용자 확인 문제

`Always allowed: bash`가 성공으로 표시된 뒤에도 후속 bash 실행에서 다시 `Approval needed bash`가 나타난다. 승인 카드는 `Always allow bash?`라고 표시하지만 실제 permanent rule scope는 `ln:*`로 보여, 사용자가 승인한 대상과 저장된 규칙의 의미가 일치하지 않는다. 동일한 성공 알림도 반복 노출된다.

### 작업

- [ ] 첨부 흐름대로 `Always allow bash` 선택 → 환경변수 prefix가 포함된 명령 → 내부 실행 파일이 `ln`인 명령을 실제 부트 체인에서 재현.
- [ ] 승인 의미를 shell 도구 전체(`bash`) 또는 파싱된 실행 파일/리소스(`ln:*`) 중 하나로 명확히 정하고 UI·저장·매칭을 통일.
- [ ] UI 제목, 설명, 저장 scope, 정책 판정이 동일한 canonical permission key를 사용하게 함.
- [ ] 저장 범위가 `ln:*`이면 `Always allow bash?` 대신 실제 범위를 정확히 표시.
- [ ] bash 도구 전체를 영구 허용한 경우 후속 bash 호출에서 재승인하지 않게 함.
- [ ] `export PATH=... && command`, `cd`, redirection, pipe 등 compound command의 실행 파일 추출과 정책 매칭을 일치시킴.
- [ ] 동일 승인 결과에 대한 `Always allowed: bash` 성공 행 중복을 제거.
- [ ] 이미 허용된 작업의 `Running` 상태 뒤에 늦게 승인 카드가 생기는 race/stale decision 여부를 확인하고 상태 전이를 원자적으로 처리.

### 검증

- [ ] bash 전체 영구 허용 후 다음 bash 작업은 승인 카드 없이 실행.
- [ ] 실행 파일별 허용이면 `ln:*`만 통과하고 다른 명령은 다시 묻되 UI도 `ln` 범위를 표시.
- [ ] `export`, `cd`, redirection, pipe, `&&`가 포함된 compound command 정책 테스트.
- [ ] 동일 rule 저장 및 성공 알림 dedupe 테스트.
- [ ] allow 저장 직후 현재 action과 다음 action 사이 race 회귀 테스트.
- [ ] 실제 TUI 스모크에서 성공 알림 1회, 동일 범위의 불필요한 재승인 0회 확인.

## 완료 기준

1. `Always allow` 카드의 표시 대상, 저장 scope, 다음 실행의 정책 판정이 일치한다.
2. 허용 완료 알림이 중복되지 않는다.
3. 이미 영구 허용한 동일 범위에 다시 승인 카드가 뜨지 않는다.
4. 자동화 테스트와 실제 사용자 부트 체인 검증이 모두 통과한다.

## 연계 TODO

- `docs/plans/2026-08-18-scroll-usability-hotfix-todo.md`
