# pi 엔진 전환 · 레거시 프로바이더 런타임 정리 백로그

작성: 2026-08-08
상태: 백로그 (지금 실행하지 않음)

## 배경

`@unclecode/pi-bridge`가 pi-mono 런타임(`@earendil-works/pi-ai`) 위에서 `LlmProvider` 계약을 구현하고,
`unclecode work --engine pi` 경로가 Rust 워크 셸 → node `work-pi-turn` 헬퍼 → pi-bridge로 연결됐다.
OpenAI 인증은 Codex OAuth(`~/.codex/auth.json`)를 pi `openai-codex` 프로바이더로 태운다.

그 결과 기존 자체 프로바이더 런타임과 기능이 겹친다.

| 레이어 | 파일 | 규모 | 상태 |
| --- | --- | --- | --- |
| 자체 프로바이더 런타임 | `packages/providers/src/runtime.ts` | 3,124 LOC | 네이티브 엔진 기본값 |
| pi 브리지 | `packages/pi-bridge/src/*` | ~600 LOC | `--engine pi` 전용 |

## 현재 상태 (2026-08-08)

- 기본 엔진은 **pi**다. `--engine native` 또는 `UNCLECODE_WORK_ENGINE=native`로만 레거시 경로를 탄다.
- OpenAI 인증은 `~/.codex/auth.json`의 Codex OAuth를 pi `openai-codex` 프로바이더로 태운다.
  API 키 없이 동작하며, 토큰 갱신은 `CodexCredentialStore`가 원본 파일에 원자적으로 기록한다.
- 런처는 `~/.local/bin/unclecode` → `bin/unclecode.cjs` 심링크. node 버전에 묶이지 않는다.

## 정리 조건 (전부 충족 전에는 손대지 않는다)

1. `--engine pi`로 실제 코딩 세션(도구 사용 포함) 1주 이상 무사고 운용
2. OpenAI 외 anthropic/gemini 경로도 pi 브리지로 실사용 검증
3. 트레이스/비용 집계(`assistant.delta`, `tool.*`, `costUsd`)가 네이티브 경로와 동등함을 확인
4. 세션 재개·컴팩션·첨부 이미지 경로 회귀 테스트 통과

## 정리 절차 (조건 충족 후)

1. ~~`--engine`의 기본값을 `pi`로 전환~~ (2026-08-08 완료) — `native` 폴백은 한 릴리스 유지
2. 폴백 기간 종료 후 `packages/providers/src/runtime.ts`의 HTTP/툴 루프 경로를 제거
   - 제거 전 `git tag legacy-provider-runtime-<date>`로 되돌림 지점을 남긴다
   - Rust `provider_mini_loop` 의존부(`rust/unclecode-core/src/team_mini_loop.rs`)도 같은 파도에서 정리
3. 남길 것: OpenAI OAuth 상태 해석(`openai-auth.ts`, `openai-status.ts`), 모델 레지스트리, 비용 테이블
4. 제거 후 `npm run test` 전체 + `cargo test --workspace` 통과 확인

## 지금 하지 않는 이유

pi 경로는 라이브 턴 검증 표본이 아직 부족하다. 자체 런타임을 먼저 지우면 인증/모델 이슈가 생겼을 때
되돌릴 실행 경로가 사라진다. 조건 1~4가 채워질 때까지 두 경로를 병행 유지한다.
