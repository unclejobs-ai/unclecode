# UncleCode Team Mode + mini-SWE-agent Feasibility Proposal

**Date:** 2026-04-28
**Status:** Draft for review
**Scope:** Architecture + phased plan. No code in this doc; only contracts, file paths, and acceptance criteria.

---

## 0. TL;DR

0. **Two-Layer 정정 (사용자 지적)**: 멀티 모델 CLI 오케스트레이션 = **Layer A (Claude Code 여기)**, UncleCode = Layer B 의 peer worker CLI 1개. 본 doc 의 (1) UncleCode 자체 강화 + (2) Layer A 오케스트레이션 설계는 분리된 두 작업. (§1)
1. **mini-SWE-agent 100 LOC 자체는 가져올 가치 없음.** 가져올 것은 4가지 디자인 결정: append-only message log, stateless subprocess per action, output-marker exit, 설정 분리.
2. **새 클래스 `MiniLoopAgent`** 를 `packages/orchestrator/src/mini-loop-agent.ts` 에. Pi-fast hot path. 기존 `WorkAgent` 그대로 유지.
3. **MMBridge 철학 계승**: review/security/gate/handoff 를 step boundary hook 으로 attach (루프 안 baked-in X).
4. **OMX/OMO 스타일 CLI 표면**: `unclecode team run <obj> --persona builder --lanes 3` — 단, 본 표면은 UncleCode 가 standalone 일 때 기능. Layer A 가 호출할 때는 RUN_ID env 만으로 join.
5. **Persistent bindings (§5.5)**: RUN_ID 한 개가 manifest + checkpoint NDJSON + per-worker NDJSON + reviews + UDS + mmbridge session 묶음. 기존 SessionCheckpoint + context-broker + openai-credential-store 80% 커버. 추가: disk-backed ownership registry + team-run-store + UDS.
6. **SSOT (§5.6)**: 카테고리마다 권한자 1명, 인용=`(key, versionHash)`, write=prevTipHash CAS, log=sha256 chain. 코드 ground truth = git working tree.
7. **ACI 채택 (§5.7)**: line-anchored edit + linter guardrail + summarized search (50 cap) + observation collapsing. **고수준 mini-SWE-agent + 저수준 SWE-agent ACI 의 합성.** GPT-4 era 데이터 (12.5% Verified) 는 historical 참고만 — 현재 SOTA Claude Opus 4.7 = 87.6%, GPT-5.3-Codex = 85.0%. 모델-비특이적 우위 확보 목적.
8. **CLI Distinct-Advantage Matrix (§5.8, NEW)**: 각 CLI 강점 명시 — Claude Code (1M ctx + hook + conductor), Codex (async/bg), Cursor 3 (IDE+Design Mode), Aider (git commit), Gemini (cheap+large), Kimi (research), **UncleCode (Pi-fast 421ms + OSS + OpenAI-OAuth + GPT lane worker)**. Layer A 가 의도별 routing.
9. **Agentless × Agentic Hybrid (§5.9, NEW)**: Agentless (FSE 2025, 32.67% Lite at $0.68) + Kimi-Dev (NeurIPS 2025, 60.4% Verified, agentless-skill-prior+agent). UncleCode 에 `agentless-fix` persona 추가 → cheap localize 부터 시작, fail 시 agentic mini-loop escalate. 비용 급감.

---

## 1. Two-Layer Architecture — 누가 어디서 무엇을 (CRITICAL)

이전 draft 의 카테고리 오류 수정. 사용자 지적: "멀티 모델 CLI 오케스트레이션 = 클코(여기). UncleCode 는 GPT임."

### 1.A Layer 분리

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER A — CONDUCTOR  (Claude Code, this session, claude-opus-4-7)   │
│   * 1M context, hook system, 4% of GitHub commits (March 2026)       │
│   * 이미 부착: mmbridge MCP, hermes-fanout, codex-rescue, OMX, agent  │
│     teams, claude-mem, second-claude-code skills                      │
│   * 역할: 사용자 의도 파싱 → 멀티 CLI 디스패치 → 결과 통합 → 사용자 보고  │
│   * SSOT 권한자: 이 layer 의 conversation + tool result log           │
└──────────────────────────────────────────────────────────────────────┘
              │ shell / MCP / process tool
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER B — PEER WORKER CLIs (각자 단일-CLI 강점 보유)                  │
│                                                                        │
│  UncleCode  │ Codex CLI  │ Aider  │ Cursor CLI  │ Gemini CLI  │  ...  │
│  GPT/Codex  │ GPT-5.3-Codex│git-native│IDE+terminal│large+cheap│       │
│  Pi-fast    │ async/bg   │commit  │ Design Mode │ research  │         │
│  OSS, OAuth │ AGENTS.md  │ workflow│ /worktree  │ multimodal│         │
└──────────────────────────────────────────────────────────────────────┘
              │ runs against
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER C — SHARED ARTIFACTS (workspace, git tree, RUN_ROOT)          │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.B 본 문서의 진짜 두 가지 일

이 proposal 은 **두 개의 분리된 작업**을 다룬다. 한 곳에 묶지 말 것.

| 작업 | 어디서 구현 | 누가 이득 |
|---|---|---|
| **(1) UncleCode 자체를 Pi-fast + ACI + mini-loop 로 강화** | `/Users/parkeungje/project/unclecode` 코드 변경 | UncleCode 단독 사용자 + Layer A 가 호출했을 때 빠른 응답 |
| **(2) Layer A (Claude Code) 에서 UncleCode/Codex/Aider/Gemini 등을 한 팀처럼 오케스트레이션** | `~/.claude/` 의 skill / agent / hook 설정 + mmbridge / hermes prompt 정의 | Layer A 사용자 (현재 사용자) |

이전 draft 는 (1) 안에 (2) 를 욱여넣음 → 카테고리 오류. 이번 개정에서 분리.

### 1.C 본 문서 scope

- **§5.5 Persistent bindings, §5.6 SSOT, §5.7 ACI** → 둘 다 적용 (Layer B 의 worker 무결성 + Layer A 의 conductor 가 신뢰할 수 있는 truth)
- **§3 Team scaffold (다이어그램)** → Layer A 차원으로 reframe. UncleCode 자신은 단순 worker CLI.
- **§4 CLI 표면** → UncleCode 가 worker 역할로서 expose 해야 할 hooks (RUN_ID env, JSON output, exit codes, manifest write)
- **§5.8 CLI Distinct-Advantage Matrix (NEW)** → Layer A 가 어떤 일을 어떤 CLI 에게 보낼지 결정 표
- **§5.9 Agentless × Agentic Hybrid (NEW)** → 비싼 agent 없이 cheap localize 부터 시작, escalate

---

## 1. 현재 UncleCode 표면 정리 (실측)

| 레이어 | 위치 | 역할 |
|---|---|---|
| CLI entry | `apps/unclecode-cli/src/index.ts` | TTY 분기 → fast-cli → command-router → commander program |
| Fast hot path | `apps/unclecode-cli/src/fast-cli.ts` | `auth status`, `doctor`, `setup`, `mode status`, `sessions`, `config explain` 만 lazy-import 로 즉시 응답 |
| Subcommands | `apps/unclecode-cli/src/program.ts:530-782` | `center setup doctor sessions resume tui work config auth mode research mcp harness` |
| Harness | `apps/unclecode-cli/src/harness.ts` | `.codex/config.toml` parser, `yolo` preset patch |
| Engine | `packages/orchestrator/src/coding-agent.ts:35` `CodingAgent` | provider-abstracted single-turn agent |
| Work loop | `packages/orchestrator/src/work-shell-engine*.ts` (16 modules) | TUI work shell with builtins, commands, panels, traces |
| Multi-agent foundation | `packages/orchestrator/src/turn-orchestrator.ts:18` `classifyWorkIntent`, `runBoundedExecutorPool` | bounded pool with file-ownership claim/release |
| Tools | `packages/orchestrator/src/tools.ts` | `list_files`, `read_file`, `write_file`, `search_text`, `run_shell` (env-gated) |
| Runtime broker | `packages/runtime-broker/src/local-adapter.ts:48` | spawn / kill / health, RuntimeContainer ≡ Environment 추상 |
| Contracts | `packages/contracts/src/runtime.ts` | `RuntimeMode = "local" \| "docker" \| "e2b"` |
| Policy | `packages/policy-engine/src/{decision-table,delegation,overrides}.ts` | tool-allow rules, mode overlays |
| MMBridge MCP | `apps/unclecode-cli/src/mmbridge-mcp.ts` + `scripts/run-mmbridge-mcp.mjs` | bridge 호출 wiring |
| Hermes 외부 | `~/.claude/plugins/marketplaces/second-claude-code/references/hermes/` | external operator skillpack — Hermes runs OUTSIDE, calls in via shell |
| OMX integration | root `package.json` scripts + `AGENTS.md` (omx:generated) | `omx exec`, `omx setup`, openclaw gateway |

**중요 사실 (advisor가 짚어준 것):**
- `AGENTS.md`는 OMX가 generate함 (`<!-- omx:generated:agents-md -->`). **수정 surface 로 쓰지 말 것** — overlay 가 덮어씀. 통합 surface는 `prompts/*.md`(OMX 지정) 또는 우리 contracts 안.
- "hermes -p coder & -p builder" 는 Hermes CLI 의 literal flag 가 아니다. Hermes operator-prompt **role profile** 로 해석해야 한다 (PROMPTS.md 의 Bug Fix / Feature Delivery / Security Hardening 패턴 = persona). `external-coding-supervisor` skill 이 single write-capable + read-only reviewer + mmbridge gate 의 역할 분리를 강제함.

---

## 2. mini-SWE-agent 전수조사

### 2.1 가져올 것 (4가지 디자인 결정)

소스 검증 (`SWE-agent/mini-SWE-agent`, main, 2026-04-27 기준):

```python
# agents/default.py 핵심
while True:
    self.step()                          # query() + execute_actions()
    if self.messages[-1]["role"] == "exit": break
# - messages 는 append-only
# - step_limit / cost_limit 외에 hidden state 없음
```

```python
# environments/local.py 핵심
result = subprocess.run(command, shell=True, cwd=cwd,
                        env=os.environ | self.config.env,
                        timeout=timeout, ...)
# 첫 줄이 "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" 이면 raise Submitted
```

| 디자인 결정 | UncleCode 매핑 |
|---|---|
| **Append-only message log** | `MiniLoopAgent.messages: ChatMessage[]` (push only); 기존 `WorkAgent` 의 stateful turn 과 분리 |
| **Stateless subprocess per action** | `LocalAdapter.spawn()` 매 액션마다 새 container — 이미 그렇게 동작. `RuntimeMode = "docker" \| "e2b"` 로 swap만 하면 sandbox 됨 |
| **Output-marker exit** | `UNCLECODE_SUBMIT_MARKER` env (default `__UNCLECODE_SUBMIT__`) → 첫 줄 매칭 시 loop 종료 + payload 추출 |
| **jinja + pydantic 분리 설정** | TS 쪽은 zod + 단순 string template literal 로 충분 (mustache/handlebars 도입 X). 설정 schema는 `packages/contracts/src/mini-loop.ts` 에 zod 로 |

### 2.2 거부할 것

- **litellm 의존성** — UncleCode 는 이미 자체 provider abstraction 가짐 (`packages/providers/`, OpenAI/Codex/Anthropic). Python 도입 안 함.
- **jinja2 / pydantic** 직접 포팅 — TS 생태계 도구로 대체.
- **interactive.py 의 prompt_user** — TUI 가 이미 그 역할.
- **swebench batch runner** — 우리 use case 아님.
- **`shell=True` 그대로** — 보안 리스크. `LocalAdapter` 의 `spawn(command, args[])` 인터페이스 유지 (이미 더 안전).

### 2.3 결과: 100 줄 이하의 새 모듈

- `packages/orchestrator/src/mini-loop-agent.ts` (~150 LOC 예상, 테스트 제외)
- `packages/contracts/src/mini-loop.ts` (config schema, ~40 LOC)

기존 `WorkAgent` (316 LOC) 를 대체하지 않는다. 짧은 직선 task 의 hot path 로 공존.

---

## 3. Team Mode — 팀 스캐폴드 아키텍처

> 사용자 요구사항: "단순히 서브에이전트처럼 단일로 작업하는게 아닌, 팀 모드로 내가 지시한 각 CLI 가 연동해서 스캐폴드 구조를 둔 오케스트레이션 팀단위로 작업해야 해."

### 3.1 팀 역할 (4 종)

```
┌──────────────────────────────────────────────────────────────────┐
│ COORDINATOR (Hermes operator persona, external)                  │
│   - "-p coder"  : single-objective implementation routing         │
│   - "-p builder": multi-step delivery routing                     │
│   읽기: 사용자 의도, 정책, 게이트 결과                              │
│   쓰기: 워커 디스패치 명령, 최종 사용자 보고                          │
└──────────────────────────────────────────────────────────────────┘
                             │ shell call
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│ SCAFFOLD (UncleCode CLI, this repo)                              │
│   `unclecode team run <objective> [--persona ...] [--lanes N]`   │
│   읽기: workspace, .codex/config.toml, modes                      │
│   쓰기: .data/team-runs/<run_id>/ artifacts                       │
└──────────────────────────────────────────────────────────────────┘
            │                              │                  │
            ▼                              ▼                  ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ WORKER (mini-loop)  │  │ WORKER (codex/omx)  │  │ REVIEWER (mmbridge) │
│  MiniLoopAgent      │  │  omx exec --lane N  │  │  mmbridge_review    │
│  via LocalAdapter   │  │  via Bash spawn     │  │  mmbridge_gate      │
│  - bounded steps    │  │  - sandbox modes    │  │  mmbridge_security  │
│  - file ownership   │  │  - parallel lanes   │  │  - read-only        │
│  WRITE: 1 worker    │  │  WRITE: 1 worker    │  │  - never write      │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
            │                              │                  │
            └──────────────┬───────────────┴──────────────────┘
                           ▼
              ┌──────────────────────────┐
              │ MEMORY BUS               │
              │  context-broker pkg      │
              │  + mmbridge_context_     │
              │    packet                │
              │ append-only event log    │
              └──────────────────────────┘
```

### 3.2 팀 안전 규칙 (Hermes OPERATIONS.md 에서 계승)

1. **한 run 안에서 write 권한은 1 워커만 가짐.** 나머지는 read-only.
2. **MMBridge gate 가 fail 이면 자동 accept 금지.** Coordinator 가 명시적 corrective pass 를 디스패치.
3. **Standard read order 강제**: `summary.md → manifest.json → mmbridge-gate.json → mmbridge-review.json → per-role/result.json → raw stdout`.
4. **File ownership registry** (`packages/orchestrator/src/file-ownership-registry.ts` 이미 존재) 가 워커간 write conflict 차단.
5. **워커는 자신의 `containerId` lane 안에서만 동작.** Cross-lane 파일 이동은 reviewer 통과 후만.

### 3.3 라이프사이클

```
T0  CLI: `unclecode team run "fix auth token expiry" --persona coder`
T1  Scaffold: 정책 평가 (policy-engine), .data/team-runs/<run_id>/manifest.json 생성
T2  Scaffold: WORKER 1 (mini-loop, write) spawn — fix + regression test
T3  Worker: MiniLoopAgent 루프 시작 → step → step → submit marker
T4  Scaffold: REVIEWER spawn — mmbridge_review + mmbridge_gate (read-only)
T5  Gate result → summary.md → coordinator 에게 반환
T6  Coordinator (Hermes) 가 accept / corrective / narrow follow-up 결정
```

### 3.4 Persona = mini-loop config preset

| Persona | step_limit | tools | gate | targeting |
|---|---|---|---|---|
| `coder` | 12 | read/write/search/run_shell | mmbridge_review | 단일 결함 + regression test |
| `builder` | 24 | + plan, + multi-file-write | mmbridge_gate strict | feature slice |
| `hardener` | 16 | + security scan | mmbridge_security | 보안 패치 |
| `auditor` | 8 | read-only | mmbridge_review | 비파괴 분석 보고만 |

Persona 정의: `packages/orchestrator/src/personas/<id>.ts` (system_template + step_limit + allow-list + gate_id).

---

## 4. CLI 표면 — OMX/OMO 스타일

### 4.1 새 subcommand 트리

```
unclecode team
  run <objective>            # 팀 부팅 + 동기 실행
    --persona <id>           # coder|builder|hardener|auditor
    --lanes N                # 병렬 워커 수 (file ownership 으로 충돌 방지)
    --runtime local|docker|e2b
    --gate strict|warn|off
    --timeout-ms N
    --record <run_id>        # .data/team-runs/<run_id> 강제 지정
  status [run_id]            # 진행 중 run 상태
  ls                         # 최근 run 목록
  resume <run_id>            # 미완료 run 재개
  inspect <run_id>           # standard read order 로 artifact 출력
  abort <run_id>             # SIGTERM 워커 + 상태 마킹

unclecode persona
  list                       # 등록된 persona
  show <id>                  # persona spec
  apply <id>                 # 현재 mode 에 persona overlay 부착

unclecode mini
  run <prompt>               # 팀 없이 mini-loop 단독 실행 (디버깅용)
    --steps N
    --runtime local|docker|e2b
    --marker <string>
```

기존 subcommand 와 충돌 없음. `harness apply yolo` 와 자유 조합 가능.

### 4.2 Fast-path 추가

`apps/unclecode-cli/src/fast-cli.ts:11` `resolveFastCliPath` 에 다음 추가:
- `team status` (no args) — `.data/team-runs/_index.json` 만 읽어 lazy-print
- `persona list` — 정적 목록

목적: Hermes coordinator 가 1회 호출당 100ms 미만 응답을 기대 → 풀 commander 부트스트랩 회피.

### 4.3 Hermes 측 entry script

`scripts/hermes-team-run.mjs` (새) — 사용 패턴:

```bash
node scripts/hermes-team-run.mjs run '{
  "persona": "builder",
  "objective": "...",
  "lanes": 2,
  "gate": "strict"
}'
```

내부적으로 `unclecode team run` 호출 + artifact 경로를 Hermes 가 기대하는 `.data/external-runs/...` 형태로 mirror. 기존 `references/hermes/PROMPTS.md` 의 Operator Prompt 들을 그대로 재사용 가능.

---

## 5. MMBridge 철학 계승

### 5.1 부착 지점 (loop boundary hook)

`MiniLoopAgent` 는 `LoopHooks` 를 받음:

```typescript
type LoopHooks = {
  onBeforeStep?: (state: LoopState) => Promise<void>;
  onAfterStep?: (state: LoopState, action: Action, observation: Observation) => Promise<HookDecision>;
  onSubmit?: (state: LoopState, payload: string) => Promise<HookDecision>;
};

type HookDecision = { kind: "continue" } | { kind: "halt"; reason: string }
                  | { kind: "inject"; message: ChatMessage };
```

| 훅 | MMBridge 호출 | 효과 |
|---|---|---|
| `onAfterStep` (write tool 직후) | `mmbridge_review` async, fire-and-forget | 백그라운드 리뷰 트레이스만 적재 |
| `onAfterStep` (run_shell 결과) | `mmbridge_security` 만약 risky pattern | halt + reason injection |
| `onSubmit` | `mmbridge_gate` synchronous | gate fail 시 halt → coordinator 에게 corrective signal |
| Worker 종료 | `mmbridge_handoff` | 다음 worker / coordinator 에게 context_packet 전달 |

### 5.2 Loop 안에 baked-in 안 함

루프 자체는 mini-SWE-agent 처럼 dumb 하게 유지. MMBridge 는 attach 또는 detach 가능한 plugin. Pi-fast persona (`auditor`) 는 모든 hook off → 순수 루프 속도.

### 5.3 Context packet shape

`packages/contracts/src/team.ts` (new):

```typescript
export type TeamContextPacket = {
  readonly runId: string;
  readonly persona: PersonaId;
  readonly objective: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly artifacts: ReadonlyArray<{ path: string; sha256: string }>;
  readonly gateResults: ReadonlyArray<MmGateResult>;
  readonly handoffNotes?: string;
};
```

`mmbridge_context_packet` 호출 시 이 shape 으로 직렬화. Hermes coordinator 가 동일 shape 을 read-order 1 의 `summary.md` 와 함께 읽음.

---

## 5.5 Persistent Bindings — 세션 공유 구조

> 사용자 요구: "persistent bindings 구조로 세션을 공유해야 하자너? 잘 구상해보라."

팀 모드는 **여러 CLI 프로세스가 동시에 같은 작업 단위**를 본다 (Hermes coordinator + unclecode worker N + mmbridge reviewer M). 단일 sub-agent 가 아니므로, **하나의 binding key 가 모든 참여자를 같은 상태에 묶어야** 한다. 임시 인메모리로는 안 됨 — process boundary 를 넘어가야 한다.

### 5.5.1 기존 자원 (이미 있음)

| 자원 | 위치 | 역할 |
|---|---|---|
| `SessionCheckpoint` append-only log | `packages/contracts/src/session.ts:43` | 6 종 checkpoint type — state/metadata/task_summary/mode/worktree/approval |
| `SessionModeCheckpoint.mode = "coordinator" \| "normal"` | 같은 파일 | **이미 coordinator 분기 contract 존재** |
| `session-store/` package | `packages/session-store/src/{paths,store,redaction,validators,project-memory-db}.ts` | filesystem-backed checkpoint store + sqlite memory db |
| `context-broker/` package | `packages/context-broker/src/{context-packet,context-memory,freshness}.ts` | context packet 조립, 메모리 bridge, freshness check |
| `openai-credential-store` | `packages/providers/src/openai-credential-store.ts` | OAuth 자격증명 filesystem 캐시 — 이미 process 간 공유됨 |
| `file-ownership-registry` | `packages/orchestrator/src/file-ownership-registry.ts` | runtime claim/release — but in-process only |

**대부분의 인프라는 이미 있다.** Team 모드를 위한 binding 은 (1) 새 checkpoint type 추가, (2) 다중 프로세스 contention 해결, (3) live event push 채널 추가 — 이 셋만 하면 됨.

### 5.5.2 Binding Key 모델

```
RUN_ID  =  "tr_<unix_ms>_<rand6>"     (e.g., tr_1714234567_a3f9c2)
SESSION_ID  =  inherits or new

bindings:
  RUN_ID  →  .data/team-runs/<RUN_ID>/        (artifacts root)
  RUN_ID  →  session-store checkpoint stream   (state machine)
  RUN_ID  →  .data/team-runs/<RUN_ID>/ipc.sock (live IPC, optional)
  RUN_ID  →  context-broker context-packet     (rolling memory)
  RUN_ID  →  mmbridge_sessions session_id      (bridge memory)
  RUN_ID  →  workers[*].containerId            (runtime-broker)
```

**환경 전파**: 모든 워커는 `UNCLECODE_TEAM_RUN_ID=<RUN_ID>` 와 `UNCLECODE_TEAM_RUN_ROOT=<abs_path>` 두 env 만 받으면 즉시 같은 run 에 bind. Hermes / OMX / 외부 호출자도 동일 변수로 진입.

### 5.5.3 새 checkpoint type 2 종

`packages/contracts/src/session.ts` 의 `SESSION_CHECKPOINT_TYPES` 에 추가:

```typescript
"team_run"      // run 시작/종료/상태전이
"team_step"     // 워커 step 단위 (mini-loop step + tool action)
```

```typescript
export type TeamRunCheckpoint = {
  readonly type: "team_run";
  readonly runId: string;
  readonly persona: PersonaId;
  readonly status: "started" | "running" | "gated" | "accepted" | "corrective" | "aborted";
  readonly objective: string;
  readonly lanes: number;
  readonly timestamp: string;
};

export type TeamStepCheckpoint = {
  readonly type: "team_step";
  readonly runId: string;
  readonly workerId: string;
  readonly stepIndex: number;
  readonly action?: { tool: string; argHash: string };       // PII redaction via redaction.ts
  readonly observationHash?: string;
  readonly costUsd?: number;
  readonly timestamp: string;
};
```

기존 `SessionCheckpoint` union 에 합류 → 기존 store/load API 가 그대로 동작. **하위호환**: `SESSION_CHECKPOINT_TYPES` 에 항목 추가만이므로 기존 reader 는 unknown type 무시 (validators.ts 의 fallback).

### 5.5.4 디렉터리 레이아웃 (cold persistence)

```
.data/team-runs/<RUN_ID>/
  manifest.json              # run spec (objective, persona, lanes, gate, runtime, createdAt)
  checkpoints.ndjson         # SessionCheckpoint append-only log (single writer per fsync window)
  workers/
    <worker_id>/
      messages.ndjson        # MiniLoopAgent.messages (append-only, per-worker)
      ownership.json         # claimed paths snapshot (for resume)
      result.json            # final exit_status, submission, cost
      stdout.log
      stderr.log
  reviews/
    mmbridge-review.json
    mmbridge-gate.json
    mmbridge-security.json
  context/
    context-packet.json      # context-broker assembled packet (latest)
    handoff.json             # mmbridge_handoff payload (latest)
  summary.md                 # human-readable, generated last
  ipc.sock                   # OPTIONAL Unix domain socket for live events
  .lock                      # advisory file lock for single coordinator
```

**모든 append-only.** Write contention 은 `checkpoints.ndjson` 에서만 발생 → 단일 coordinator 프로세스가 fsync. 워커는 자기 `workers/<id>/` 안에서만 write (file-ownership-registry 보장).

### 5.5.5 Live IPC (hot path, optional)

Cold (filesystem) 만으로는 워커 → coordinator 진행 상황 streaming 이 polling 이 됨. Live 가 필요할 때:

- **Unix domain socket**: `.data/team-runs/<RUN_ID>/ipc.sock`
- **Wire format**: NDJSON line per event, 같은 `SessionCheckpoint` shape
- **두 채널 동시**: Live socket 으로 push + 같은 event 를 cold log 에 fsync. Crash 시 cold log 가 truth.
- **Pi-fast 원칙**: socket 은 lazy create — `--live` flag 또는 TUI attach 시에만. Headless `team run` 은 cold-only 가 default → bootstrap 비용 0.

```
Worker(MiniLoopAgent) ──ndjson──▶ ipc.sock ──▶ Coordinator (Hermes/CLI/TUI)
        │                                              │
        └──── fsync ───▶ checkpoints.ndjson ◀──────────┘  (cold mirror, source of truth)
```

### 5.5.6 다중 프로세스 동시성 규약

| 행위자 | Read | Write |
|---|---|---|
| Coordinator (CLI scaffold root) | 모든 path | `manifest.json`, `checkpoints.ndjson` (exclusive), `summary.md` |
| Worker N | `manifest.json`, `context/context-packet.json` | 자기 `workers/<id>/*` 만 |
| Reviewer (mmbridge) | 모든 path | `reviews/*.json` 만 |
| Hermes external | 모든 path | NONE — read-only observer |

**File lock**: `.lock` 은 advisory `flock(LOCK_EX)` — coordinator 시작 시 획득, 종료 시 해제. 두 coordinator 동시 실행 차단. 워커는 lock 무관.

**Concurrent worker write 차단**: `file-ownership-registry` 가 이미 in-process registry — team 모드를 위해 **disk-backed registry** 로 확장 (`workers/<id>/ownership.json` + per-path lock file). 워커가 path 를 claim 할 때 `<RUN_ROOT>/locks/<sha256(path)>.lock` 을 try-create + write workerId. 이미 존재하면 wait 또는 abort.

### 5.5.7 Provider auth binding

이미 `openai-credential-store.ts` 가 `~/.config/unclecode/openai-credentials.json` 등 filesystem 캐시를 사용 → 모든 워커 프로세스가 별도 OAuth 없이 즉시 사용. 새 메커니즘 불필요.

**예외**: 워커별로 다른 model / reasoning 을 쓸 때. → Persona 정의가 `model`, `reasoning_effort` 를 declare. CLI 가 `--model` env 로 전파. credential 자체는 공유.

### 5.5.8 Resume 시나리오

```
$ unclecode team run "..." --persona builder --record tr_x  (T0, started)
$ # crash / SIGINT at T1
$ unclecode team resume tr_x
   1) read .data/team-runs/tr_x/manifest.json
   2) replay checkpoints.ndjson → in-memory state
   3) per worker: read workers/<id>/messages.ndjson, restore MiniLoopAgent.messages
   4) re-claim ownership.json paths via disk registry (skip if held by another live pid)
   5) continue from last checkpoint (gated, running, etc.)
```

기존 `unclecode resume <sessionId>` (program.ts:560) 와 contract 호환. Resume 은 **새 체크포인트로 redirect**, 원본 log 는 immutable.

### 5.5.9 Hermes / OMX 와의 binding

Hermes 가 `unclecode team run` 을 spawn 하면:

1. CLI 가 RUN_ID 생성 → stdout 첫 줄에 `RUN_ID=tr_xxx` print
2. Hermes 가 그 RUN_ID 로 즉시 `unclecode team status tr_xxx` polling 가능 (fast-path, 100ms 이하)
3. Hermes 의 standard read order (OPERATIONS.md) 가 그대로 적용:
   - `summary.md` → `manifest.json` → `reviews/mmbridge-gate.json` → `reviews/mmbridge-review.json` → `workers/<id>/result.json`
4. OMX worker 도 같은 RUN_ID 로 join — `omx exec --run-id tr_xxx` (oh-my-codex side 에서 env 만 읽으면 됨, 우리 변경 불필요)
5. mmbridge MCP 가 RUN_ID 를 자기 `mmbridge_sessions.session_id` 와 매핑 → `mmbridge_context_packet` 호출 시 같은 packet 을 반환

### 5.5.10 신규 contract / API

- `packages/contracts/src/team.ts`
  - `TeamRunManifest`, `TeamRunCheckpoint`, `TeamStepCheckpoint`, `TeamContextPacket` (이미 5.3 에서 정의), `TeamRunStatus` enum
- `packages/session-store/src/team-run-store.ts` (new)
  - `createTeamRun(spec) → RunId`
  - `appendCheckpoint(runId, checkpoint)`
  - `readCheckpoints(runId, fromIndex?)` — generator
  - `lockRun(runId) / unlockRun(runId)` — advisory flock
  - `attachLiveSocket(runId) / detachLiveSocket(runId)` — UDS lifecycle
- `packages/orchestrator/src/team-binding.ts` (new)
  - `bindToRun(runId, role: "coordinator" \| "worker" \| "reviewer")` → `TeamBinding`
  - `TeamBinding.publish(checkpoint)` — both cold log + (optional) live socket
  - `TeamBinding.subscribe(types[])` — async iterator over events

### 5.5.11 위험 / 결정사항

1. **NDJSON write 충돌**: 단일 coordinator fsync 원칙으로 해결. 워커는 자기 파일에만 write.
2. **Socket cleanup**: `process.on('exit')` + 시작 시 stale socket 검출 (PID still alive?). 실패 시 socket 무시하고 cold-only fallback.
3. **PII redaction**: `session-store/redaction.ts` 가 이미 있음. team_step checkpoint 의 `argHash` / `observationHash` 는 raw 가 아닌 SHA-256. raw 는 워커 NDJSON 안에만 (redaction 통과 후).
4. **Cross-machine**: 본 design 은 single-host 가정. 추후 e2b / remote runtime 시 socket 대신 NATS/JetStream 등으로 swap (contract 동일).
5. **SESSION_CHECKPOINT_TYPES tuple expansion 호환**: `as const` 튜플은 type-level 변경 → 모든 consumer 재컴파일 필요. validators.ts 가 unknown type 을 reject 하지 않는지 사전 확인 (Phase A 의 contract test).

### 5.5.12 한 줄 요약

> Run ID 한 개가 manifest.json + checkpoints.ndjson + workers/ + reviews/ + ipc.sock + mmbridge session 을 모두 묶는 **single binding key**. 기존 SessionCheckpoint append-only log + context-broker + openai-credential-store 가 80% 커버. 추가 코드는 disk-backed file ownership registry + team-run-store + UDS live channel 셋이면 끝.

---

## 5.6 SSOT — Single Source of Truth (anti-silo, anti-hallucination)

> 사용자 요구: "SSOT 조건도 있어야지. 사일로 막아 할루시네이션 방지. 에이전틱 루프 있어도, 전체 공유해도."

5.5 의 persistent bindings 만으로는 부족하다. 모든 워커가 같은 파일을 read 할 수 있어도, 각자 **자기 메모리 안의 사본** 위에서 추론하면 서로 다른 사실을 주장 가능 → silo 생성, 할루시네이션 누적. SSOT 는 **"무엇이 진실인지에 대한 단일 권한자"** 를 데이터 카테고리별로 명시한다.

### 5.6.1 SSOT 카테고리 — 권한자 매핑

각 사실 카테고리는 **하나의 권한자(canonical owner)** 를 가진다. 다른 모든 참여자는 그 권한자를 통해서만 사실을 인용할 수 있다.

| 카테고리 | 권한자 (SSOT) | 인용 키 | 갱신자 |
|---|---|---|---|
| **코드 상태** | git working tree | `path@sha256(blob)` 또는 `git_object_id` | 워커 (write 권한 1개) |
| **Run 상태 머신** | `checkpoints.ndjson` (cold log) | `checkpointIndex@sha256(line)` | 코디네이터만 |
| **Worker 메시지 트레이스** | `workers/<id>/messages.ndjson` | `(workerId, lineIndex)` | 해당 워커만 |
| **Context packet** | `context/context-packet.json` | `packetId = sha256(contents)` | context-broker |
| **MMBridge 게이트/리뷰 결과** | `reviews/*.json` | filename + sha256 | mmbridge MCP |
| **Provider 자격증명** | `~/.config/unclecode/openai-credentials.json` | filesystem path | auth flow only |
| **정책 결정** | policy-engine evaluation 결과 (immutable per call) | `decisionId = sha256(input+output)` | policy-engine |
| **워크스페이스 가이드라인** | `.sisyphus/rules/` (이미 Phase 7 에서 auto-load) | filename + sha256 | 사용자만 |
| **세션 메타데이터** | `SessionCheckpoint` log | checkpoint type=`metadata` 의 마지막 entry | 코디네이터만 |
| **MMBridge session memory** | mmbridge MCP server side | `mmbridge_sessions.session_id` | mmbridge bridge |

핵심 원칙: **"누가 알고 있느냐"가 아니라 "어디 적혀 있느냐"가 진실이다.** 어떤 에이전트도 "내가 기억하기로는..." 만으로 주장 불가.

### 5.6.2 5 가지 anti-hallucination 규약

#### (1) Read-by-citation 강제

워커가 사실을 인용할 때 항상 `(SSOT key, version hash)` 를 함께 기록한다. `MiniLoopAgent` 의 message format:

```typescript
type CitedClaim = {
  claim: string;
  citations: ReadonlyArray<{
    sourceType: "code" | "checkpoint" | "context-packet" | "review" | "memory";
    sourceKey: string;     // e.g., "src/auth.ts@a3f9c2"
    versionHash: string;   // sha256
  }>;
};
```

미인용 claim 은 정책 위반으로 마킹. mmbridge_gate 가 cite-coverage 검증 (예: 50% 미만 시 warn).

#### (2) Write-with-prevHash (CAS)

모든 checkpoint write 는 `prevTipHash` 를 포함:

```typescript
{ type: "team_step", ..., prevTipHash: "sha256(이전 마지막 line)" }
```

`appendCheckpoint` 가 현재 tip 이 `prevTipHash` 와 다르면 **reject** + reload 강제. 두 코디네이터가 동시 write 하려 해도 한 쪽만 성공. (`.lock` 으로 1차 차단, hash 로 2차 무결성.)

#### (3) Hash chain in checkpoints.ndjson

각 line 은:

```
{ ...checkpoint, lineHash: "sha256(prevLineHash || canonicalJSON(this))" }
```

전체 log 가 tamper-evident chain. `team inspect <runId>` 에 `--verify` 옵션 → 첫 줄부터 chain 검증, mismatch 시 빨간색 표시.

#### (4) Freshness gate before action

워커가 도구를 호출하기 직전 (`onBeforeStep` 훅), 사용 중인 context-packet 의 `packetId` 가 현재 tip 과 동일한지 검사:

```
if context_broker.currentPacketId(runId) != worker.heldPacketId:
   inject system message "Context refreshed; reread before action"
   reload packet
   restart step (워커는 새 packet 으로 다시 추론)
```

`packages/context-broker/src/freshness.ts` (이미 존재) 의 `checkFreshness` / `assertFreshContext` API 를 그대로 활용.

#### (5) Closed-loop verification

자연어 주장이 아닌 **검증가능한 명령으로 닫힌 루프** 를 만든다. 워커가 "tests pass" 를 주장하려면 다음을 한 step 에 모두 포함해야 함:

```
1. command: <test command>
2. observation: stdout + exitCode
3. claim: "tests pass" + citation pointing to (workerId, stepIndex)
```

`mmbridge_gate` 가 claim 의 citation 을 따라가 같은 stepIndex 의 observation.exitCode 가 0 인지 자동 verify. exitCode != 0 인데 "pass" 주장하면 gate fail.

### 5.6.3 코드 상태 SSOT — git working tree

코드에 대한 모든 추론의 ground truth 는 **현재 git working tree**, in-memory cache 가 아니다.

- 워커가 파일 read 시 `team-binding.readCode(path)` 사용
  - 내부적으로 `fs.readFile(path)` + `crypto.createHash('sha256').update(content)` 동시 수행
  - 반환: `{ content, sha256, mtime }`
- claim 인용 시 `path@sha256(blob)` 형식
- 다른 워커가 같은 path 를 다른 sha256 으로 인용 → **divergence detected** → 어느 쪽이든 stale → freshness gate 가 강제 reload
- `git rev-parse HEAD` + `git status --porcelain=v2` 의 결과를 `manifest.json.codeState` 에 기록 (run 시작/종료 시점)

### 5.6.4 사일로 차단 룰

| 시나리오 | 잘못된 동작 | SSOT 룰 |
|---|---|---|
| 워커가 자기 메시지 history 에서 "어제 봤던 X" 사용 | 근거 없음 → 할루시네이션 | citation 없으면 inject "must cite SSOT" |
| 코디네이터가 워커 stdout 만 보고 진단 | 워커 메모리 ≠ 진실 | reviews/, checkpoints.ndjson 만 truth |
| 두 워커가 같은 path 다른 버전 인용 | divergence | freshness gate 가 fail-fast |
| Hermes 가 자기 prompt history 로 결정 | external silo | RUN_ROOT artifact 만 read |
| MMBridge 가 캐시된 review 재사용 | stale | review 마다 packetId 검증 |
| OMX 워커가 자기 lane 의 caching agent | divergence | RUN_ROOT 의 context-packet 강제 reload |

### 5.6.5 전체 공유 vs SSOT — 충돌 해결

"전체 공유해도" 라는 요구는 SSOT 와 충돌 안 됨. **모두에게 공유** = 모두가 같은 권한자를 본다는 뜻이지, 모두가 같이 write 한다는 뜻 아님. 공유 메커니즘 → §5.5 의 RUN_ROOT + UDS socket. SSOT → 같은 RUN_ROOT 안에서도 **write 권한자가 카테고리별로 1명**.

```
공유:    All  ──read──▶  RUN_ROOT
SSOT:    Cat C ──write──▶ canonical file/store
         All others       cite, never write
```

### 5.6.6 Conflict 해결 rule

두 정보 출처가 충돌하면 (워커 A: "test X passes", 리뷰어: "test X failed"):

1. **Recency 로 판단 안 함** — 더 늦게 적힌 것이 옳다는 가정 금지
2. **카테고리 owner 우선** — "테스트 실행 결과" 의 owner 는 마지막 실행한 워커의 observation. 리뷰어는 그 observation 의 sha256 을 인용하지 않으면 무효
3. **재실행 강제** — 양 쪽 인용이 다른 versionHash 를 가리키면 코디네이터가 freshness gate fail → 워커 재실행 (동일 명령, 새 observation)
4. **결과 immutable** — 새 observation 은 새 stepIndex. 이전 것 덮어쓰기 안 함. log 는 진화함, 진실은 단조증가

### 5.6.7 신규 contract / API

- `packages/contracts/src/ssot.ts` (new)
  - `CitedClaim`, `Citation`, `SsotCategory` enum, `VersionedRef`
- `packages/orchestrator/src/team-binding.ts` (5.5 와 통합)
  - `readCode(path) → { content, sha256, mtime }`
  - `cite(category, key) → VersionedRef` (현재 tip 반환)
  - `verifyCitation(ref) → boolean` (still current?)
- `packages/orchestrator/src/hooks/citation-enforcer.ts` (new)
  - `onAfterStep` 훅 — message 에 미인용 사실 주장 검출, inject system reminder
- `packages/session-store/src/team-run-store.ts` 확장
  - `appendCheckpoint(runId, checkpoint)` 가 자동으로 `prevTipHash`, `lineHash` 부착
  - `verifyChain(runId) → { ok, brokenAt? }`

### 5.6.8 사용자에 보이는 부분

```
$ unclecode team inspect tr_xxx --verify
RUN_ID: tr_xxx
Manifest: ok
Checkpoint chain: VERIFIED (47 entries, head=a3f9c2..)
Citations:  142 / 145 claims cited (97.9%)
Divergences: 0
Freshness:  packet up-to-date (id=b2e1f0..)
Gates:      mmbridge-gate=PASS, mmbridge-review=PASS, mmbridge-security=WARN(1)
```

```
$ unclecode team inspect tr_xxx --verify
...
Divergences: 1 detected
  - "src/auth.ts" cited as a3f9c2 by worker-1 step 7
                   cited as 7d4e1b by worker-2 step 12
  - Resolution: rerun worker-2 step 12 with current SSOT (sha256=7d4e1b)
```

### 5.6.9 한 줄 요약

> 데이터 카테고리마다 권한자(canonical owner) 를 못박고, 모든 인용은 `(key, versionHash)` 페어 — 모든 write 는 prevTipHash CAS — 모든 claim 은 검증가능한 observation 에 닫힌 citation 을 갖는다. 전체 공유는 read 만 — write 는 owner 가 1명.

---

## 5.7 ACI 설계 (SWE-agent NeurIPS 2024 채택)

> 사용자 요청: SWE-agent 논문 (arXiv:2405.15793v3) 도 확인. mini-SWE-agent 는 이 논문 저자들이 만든 후속 — pure bash 로 회귀. 본 논문은 GPT-4 Turbo 시대의 ACI 설계 근거를 실증함. **두 접근의 장점을 합친다.**

### 5.7.1 논문 핵심 결과 (ACI = Agent-Computer Interface)

| 항목 | 수치 / 근거 |
|---|---|
| SWE-bench full pass@1 | **12.47%** (286/2294) — GPT-4 Turbo + ACI |
| SWE-bench Lite pass@1 | **18.00%** (54/300) |
| HumanEvalFix pass@1 | **88.3%** |
| Shell-only 대비 ACI 효과 | **+64% relative** (GPT-4 Turbo) |
| 평균 해결 비용 / step (success) | $1.21 / 12 steps (median) |
| 평균 실패 비용 / step (failure) | $2.52 / 21 steps (mean) |
| 93% 의 resolved 인스턴스 | budget 소진 전 submit |
| Failed edit 회복률 | 첫 시도 90.5%, 1회 실패 후 57.2% |

**중요한 음성 결과**: Iterative search (Vim/VSCode 스타일 next/prev) 가 검색 도구 없는 것보다 **나쁨** (12.0% vs 15.7%) — agent 가 결과를 끝까지 다 보느라 budget exhaust. → **검색은 항상 summarized + 결과 cap 강제**.

### 5.7.2 4 ACI 설계 원칙 (논문 §2)

1. **Actions should be simple and easy to understand.** 짧은 옵션, 간결한 docstring.
2. **Actions should be compact and efficient.** 파일 nav + edit 같은 고빈도 op 을 단일 action 으로 통합.
3. **Environment feedback should be informative but concise.** 핵심 정보만, 불필요 detail 제거.
4. **Guardrails mitigate error propagation.** linter 가 syntax error 자동 검출, 잘못된 edit revert.

### 5.7.3 우리 `tools.ts` vs SWE-agent ACI — 갭 분석

현재 `packages/orchestrator/src/tools.ts` (확인됨):
- `list_files` ≈ SWE-agent `find_file` (단, 결과 cap 없음)
- `read_file` — 파일 전체 read (페이지네이션 없음)
- `write_file` — 전체 덮어쓰기 (line-range edit 없음)
- `search_text` — `rg` wrapper (결과 cap 없음)
- `run_shell` — env-gated bash 실행

**누락 (논문 검증):**
- File Viewer 상태 (open file + window position)
- Line-anchored `edit start end replacement`
- Linter guardrail on edit (논문: +3.0% absolute)
- Search result cap (논문: 50)
- Observation collapsing (last 5 full, 그 이전은 1-line summary)
- "command produced no output" 명시 메시지

### 5.7.4 채택할 것 (Phase B 추가)

`packages/orchestrator/src/aci/` 신규 모듈:

```
aci/
  file-viewer.ts      # open / scroll_up / scroll_down / goto, 100-line window, line numbers prepended
  file-editor.ts      # edit(start, end, replacement) — file viewer state 기반, multi-line atomic
  linter-guardrail.ts # python: flake8 --isolated --select=F821,F822,F831,E111-113,E999,E902
                       # ts: tsc --noEmit + biome check, revert on syntax error
                       # other: best-effort skip
  search.ts           # find_file / search_file / search_dir, 50 result cap with "refine query" suggestion
  observation-collapser.ts  # MiniLoopAgent.messages 의 -5 이전 obs 를 1-line 으로 collapse
```

Persona 별 ACI tool 노출:

| Persona | tools |
|---|---|
| `coder` | file-viewer + file-editor (linter on) + search + run_shell |
| `builder` | + multi-file editor batch (with linter) |
| `hardener` | + search 강화 (security pattern), no run_shell |
| `auditor` | search + file-viewer (read-only), edit/run_shell 없음 |
| `mini` (debug only) | mini-SWE-agent 스타일 pure bash — ACI 없이도 동작 검증용 |

### 5.7.5 budget 캘리브레이션 (2024 + 2025-2026 통합)

GPT-4 Turbo 시대 SWE-agent 논문 (2024): median 12 steps / $1.21 for solved. **단, 그 시점 Verified 12.5%.** 현재 (April 2026) Opus 4.7 87.6%, GPT-5.3-Codex 85.0%.

→ 모델이 강해지면서 step 당 효율 ↑, 같은 step 수로 더 많이 해결. 그러나 cost 는 token price 가 변동 → 계속 재캘리브.

| Persona | step_limit | cost_limit_usd | 모델 default | 근거 |
|---|---|---|---|---|
| `coder` | 12 | 0.80 | gpt-5.3-codex / opus 4.7 | 강한 모델은 더 빨리 끝남, 보수적 budget |
| `builder` | 20 | 2.00 | gpt-5.3-codex / opus 4.7 | feature delivery 는 step 더 필요 |
| `hardener` | 14 | 1.50 | gpt-5.3-codex (security trained) | targeted change |
| `auditor` | 6 | 0.30 | gemini 3.1 pro (cheap+large) | read-only, large context 우선 |
| `agentless-fix` (§5.9) | N/A | 0.20 | gpt-5.3-codex | no loop, 2-phase |
| `mini` (debug) | 12 | 0.50 | any | ACI 우회, 비교용 |

**원칙**: SOTA 모델은 더 적은 step 으로 해결. 강한 모델 + 짧은 budget 으로 시작, fail 시 더 강한 모델 / 더 긴 budget 으로 escalate (Layer A 가 결정).

논문 데이터 (12 steps median) 는 weak model 의 lower bound. 강한 모델은 더 짧게 잡고 escalate 패턴 권장.

### 5.7.6 Observation collapsing — context 관리

논문 §3 (context management):
- prior 5 observations 만 full
- 그 이전은 1-line summary (예: "Output collapsed for brevity (123 lines)")
- 첫 번째 error message 만 keep, 후속 retry error 는 모두 제거
- 빈 출력에는 "Your command ran successfully and did not produce any output" 명시

UncleCode 적용:
- `MiniLoopAgent.messages` 에 `meta.collapsed = true` flag
- step boundary 마다 `observation-collapser.ts` 가 -5 이전 obs 를 collapse
- collapsed obs 는 SSOT citation 시 원본 NDJSON line 의 `versionHash` 를 유지 (인용 가능, 표시만 짧음)

### 5.7.7 Editing guardrail — failed-edit cascade 차단

논문: 51.7% trajectories 가 1+ failed edit, 1회 실패 후 회복률 57.2% 로 급락.

대책:
- `file-editor.ts` 의 edit 은 linter 통과 시에만 commit
- linter fail 시 inject 되는 message 3 부분 (논문 검증):
  1. 어떤 error 였는지 (type)
  2. edit 했을 경우 어떻게 보였을지 (preview)
  3. 원본 file content snippet (편집 위치 ±5 lines)
- `agent` 가 같은 edit 을 N 번 연속 fail 하면 hooks 가 halt + reason="cascading-edit-failure" 로 corrective signal

### 5.7.8 mini-SWE-agent 와 SWE-agent 차이 — 우리 입장

| 항목 | SWE-agent (논문) | mini-SWE-agent (후속) | UncleCode 채택 |
|---|---|---|---|
| 도구 | ACI (file viewer/editor/search/linter) | bash only | **ACI 채택** (논문 +64% 근거) |
| Edit | line-anchored + linter | bash sed/redirect | **line-anchored + linter** |
| Search | summarized + 50 cap | grep/find/ls | **summarized + cap** |
| Loop | ReAct (thought + action) | append-only messages | **append-only** (단순함) |
| State | persistent shell session | stateless subprocess | **stateless** (sandbox 용이) |
| Context | collapse old obs (5) | full history | **collapse old obs** |
| Submit | `submit` command | output marker line | **marker line** (mini 가 더 단순) |
| Sandbox | Docker | Docker/Podman/swap-in | **runtime-broker swap** |

요약: **고수준 디자인은 mini-SWE-agent (단순한 loop + stateless subprocess + marker exit), 저수준 도구는 SWE-agent (ACI + linter guardrail + summarized search + observation collapse).**

이는 mini-SWE-agent 가 GPT-4 Turbo 한계를 다음 세대 LM (Claude 3.5+) 으로 우회한 결과인데, 우리는 **모델-비특이적** 으로 가야 함 → 두 개를 모두 흡수.

### 5.7.9 신규 파일 추가 (Phase B 보강)

기존 §8 file list 에 추가:

| 신규 |
|---|
| `packages/orchestrator/src/aci/file-viewer.ts` |
| `packages/orchestrator/src/aci/file-editor.ts` |
| `packages/orchestrator/src/aci/linter-guardrail.ts` |
| `packages/orchestrator/src/aci/search.ts` |
| `packages/orchestrator/src/aci/observation-collapser.ts` |
| `tests/orchestrator/aci/file-editor.test.mjs` (linter revert) |
| `tests/orchestrator/aci/observation-collapser.test.mjs` |

### 5.7.10 한 줄 요약

> 논문은 ACI (line-anchored edit + linter guardrail + summarized search + observation collapse) 가 GPT-4 Turbo 에서 +64% 효과를 실증함. UncleCode 는 **고수준 = mini-SWE-agent 단순 루프, 저수준 = SWE-agent ACI 도구** 로 둘을 합친다. 모델-비특이적 우위 확보.

---

## 5.8 CLI Distinct-Advantage Matrix — 어떤 CLI 가 무엇에 강한가

> 사용자: "그 CLI 만의 장점이 나와야해. 뭐가 좋은지 말야."

Layer A (Claude Code 여기) 가 의도 파싱 후 어느 worker 에게 무엇을 보낼지 결정하는 **routing table**. 2026 년 4월 시점 실증 데이터 기반.

### 5.8.1 SOTA 벤치마크 현황 (April 2026)

| 시스템 | SWE-bench Verified | SWE-bench Pro | 비고 |
|---|---|---|---|
| Claude Opus 4.7 (1M ctx) | **87.6%** | 64.3% | leader, hook system, 4% GitHub commits/Mar |
| GPT-5.3-Codex | 85.0% | — | async background, AGENTS.md |
| Claude Opus 4.6 | 80.8% | — | Sonnet 4.6 base, /fast mode |
| Gemini 3.1 Pro | 80.6% | — | multimodal |
| MiniMax M2.5 | 80.2% | — | |
| ForgeCode + Opus 4.6 | (Terminal-Bench 81.8%) | — | top harness on Terminal-Bench |
| Kimi-Dev (open-source) | 60.4% (workflow) / 48.6% (agent) | — | hybrid agentless+agent |
| SWE-agent-LM-32B (SWE-Smith) | 40.2% | — | open-source SOTA training |
| **Agentless** (FSE 2025) | 32.67% Lite, $0.68 | — | 두 단계: localize + repair |

**중요**: SWE-bench Pro 에서는 톱 모델이 23-64% — 본 매트릭스가 합리적 routing 의 근거. 한 CLI 에 다 맡기면 안 됨.

### 5.8.2 CLI 별 distinct advantage

| CLI | 핵심 강점 | 약점 / 비용 | Layer A 가 보낼 작업 | 비고 |
|---|---|---|---|---|
| **Claude Code (this)** | 1M context, supervised in-loop, hook 시스템, MCP 가장 풍부, 87.6% Verified | 동기적 (사용자 대기), Anthropic 의존 | 큰 컨텍스트 합성, 최종 통합, conductor 역할 자체, 사용자 대화 | **Layer A** |
| **Codex CLI** | async/background, 격리 sandbox, GitHub native delegation, AGENTS.md 표준, 85.0% Verified | 매 invocation 비동기 → Layer A 가 polling 필요 | "이 GitHub issue 처리해" 던져두고 잊는 작업, long-running 빌드 | OAuth+OMX wired in this session |
| **UncleCode** (our project) | **Pi-fast cold start** (421ms), OSS, OpenAI/Codex first, Codex-style harness, 본 doc 후 ACI+mini-loop | 본 PR 들 끝나기 전엔 ACI 부재, GPT 의존 | Pi-fast 단발 query, GPT-only lane, OAuth credential 공유, mini-loop 단위 작업 | UncleCode 강점 = 친속도 + OSS |
| **Aider** | git native, commit-by-commit workflow, model-agnostic | TUI 경험 약함, large context 약함 | "이 한 파일에서 함수 X 를 Y 로 바꾸고 commit 해" 같은 atomic git 단위 작업 | |
| **Cursor CLI / Cursor 3** | Design Mode (이미지→구현), parallel Agent Tabs, /worktree built-in, IDE 통합 | 외부 API 라 본 session 에 직접 invoke 불가능 (사용자 IDE 로 보내야 함) | 디자인 mockup → React 구현 같은 시각 작업 | 사용자가 IDE 에 있을 때만 |
| **Gemini CLI** | 2M context, 가장 cheap-per-token, multimodal | reasoning depth 약함 | repo-wide grep + summarize, large file 정리, 이미지 분석 | mmbridge 로 invoke |
| **Kimi (K2.5)** | BrowseComp 60.6% (Claude 37%), 깊은 web research | 코딩 약함 | 경쟁 조사, multi-source synthesis, 깊은 web 탐사 | 본 session 의 `kimi-researcher` agent |
| **OpenHands** (외부 platform) | enterprise multi-agent, 50%+ real GitHub issues | 본 session 외부, 별도 deploy | enterprise 배포 시나리오 — 본 design 의 scope 밖 | 참고만 |
| **Pi (reference)** | 가장 빠른 cold start, 최소 footprint | 정통 agent 없음 | 본 doc 가 모방하려는 속도 baseline | UncleCode 의 비교 대상 |

### 5.8.3 Routing 룰 (Layer A 가 사용할)

```
사용자 의도                            → 1차 CLI               → 2차 verifier
───────────────────────────────────────────────────────────────────────────
"여기 화면 디자인 봐줘 / 이 mockup 구현"   → Cursor 3 (IDE)        → Claude Code review
"이 issue 처리해놔, 30분 뒤 봄"           → Codex CLI (async, bg)  → Claude Code merge
"이 함수 한 줄만 고쳐서 커밋"              → Aider                 → 끝
"빠른 단발 GPT 답"                       → UncleCode (Pi-fast)    → Claude Code 합성
"전체 monorepo grep + 요약"             → Gemini CLI (cheap)     → Claude Code 정리
"이 분야 경쟁사 조사"                     → Kimi (researcher)      → Claude Code 보고서
"복잡 multi-file refactor"               → Claude Code (직접) + UncleCode worker(s)  → mmbridge gate
"보안 검토"                              → mmbridge_security      → Claude Code triage
"리뷰"                                  → mmbridge (qwen/codex/gemini fan-out) → Claude Code 종합
```

### 5.8.4 Layer A 에서 이 라우팅을 어떻게 구현하나

이미 부착된 자원만으로 가능 — 새 인프라 X:

1. `~/.claude/agents/` 에 **router agent** 추가 — 사용자 의도 분류 → CLI 선택 → 디스패치 명령 emit
2. `mmbridge_debate` / `mmbridge_review` 로 N-way fan-out (한 task 를 codex/qwen/gemini/kimi 에게 동시 query, 의견 합성)
3. `hermes-fanout` skill 로 acpx 다중 lane 실행
4. `codex-rescue` agent 로 stuck 시 codex 에게 핸드오프
5. `omx` skill 로 codex 워커 lane 분기
6. **UncleCode CLI** 는 별도 Bash invocation: `unclecode mini run "..."` → JSON output 으로 결과 capture

위 모든 호출이 본 doc 의 §5.5 RUN_ID 환경변수로 같은 RUN_ROOT 를 공유하면 **Layer C 가 SSOT** 가 됨. UncleCode 가 자기 결과를 RUN_ROOT 에 dump → mmbridge gate 가 read → Claude Code 가 종합.

### 5.8.5 UncleCode 자신의 distinct advantage 명시

지금까지 흐릿했음. 명시:

- **Pi-fast**: 421ms cold start (실측). Codex CLI 가 1-2s, Claude Code 가 3-5s 인 시장에서 단발 query 의 latency floor 점유.
- **OSS + OpenAI-OAuth-first**: ChatGPT 구독자가 API key 없이도 무료로 쓸 수 있는 OSS 코딩 CLI 의 자리. (Codex CLI 도 이 자리지만 OSS 가 아니거나 license 제약 있음.)
- **Harness customization**: `harness apply <preset>` + `.codex/config.toml` overlay → 사용자가 모델/reasoning/approval 을 패치 가능. OMX 와 호환.
- **Mini-loop 단위 작업**: 본 doc 의 §5.7 ACI 채택 후 → SWE-agent 수준 도구를 GPT 에 부착, mini-SWE-agent 의 단순함 + SWE-agent ACI 의 효과.
- **MCP-native**: mmbridge / hermes / serena / claude-mem 등을 Codex 측에서도 쓸 수 있게 wiring 해줌.
- **Team-mode 의 GPT lane**: Claude Code (Anthropic) 가 conductor 일 때 OpenAI/Codex side worker 가 필요 → UncleCode 가 그 자리.

요약: **UncleCode 는 ChatGPT 구독자의 Pi-fast 코딩 CLI + OpenAI-side team-mode worker.** 이게 Cursor/Aider/Codex CLI 가 다 못 차지한 자리.

---

## 5.9 Agentless × Agentic Hybrid (Kimi-Dev 패러다임, 2025)

> SWE-agent (2024) 와 mini-SWE-agent (2024) 외에 한 갈래 더: **Agentless** (FSE 2025).

### 5.9.1 Agentless 핵심 (Xia et al., FSE 2025)

- **Two-phase**: hierarchical localization (file → class/function → edit lines) + multi-candidate patches
- **No agent loop, no tool use** — pure LM call with structured prompts
- **결과**: SWE-bench Lite **32.67%** at **$0.68/instance** — 당시 모든 OSS agent 대비 cheaper + 더 많이 해결
- **OpenAI 채택**: o1 모델 코딩 성능 showcase 의 standard

### 5.9.2 Kimi-Dev (NeurIPS 2025)

- "Agentless training as **skill prior** for SWE-agents"
- 핵심 통찰: localize / edit / self-reflect 는 agentless 로 학습 가능한 **skill**, 그 다음 agentic SFT 로 adapt
- 결과: 60.4% Verified (workflow), 48.6% (agent) — open-source 최강
- **dichotomy 해소**: workflow vs agent 양자택일 X — 둘은 complementary

### 5.9.3 UncleCode 적용 — 비용 절감 hybrid

`packages/orchestrator/src/agentless/` 신규 모듈:

```
agentless/
  localize-hierarchical.ts   # 1) repo-map → top files
                              # 2) targeted read → top classes/functions
                              # 3) line-window selection
  candidate-generator.ts     # N candidate patches (diff format), no agent loop
  patch-validator.ts         # apply each candidate to disk → run tests → score
```

Persona 추가:

| Persona | 동작 |
|---|---|
| `agentless-fix` | Two-phase only, no agent loop, lowest cost |
| `agentless-then-agent` | agentless 시도 → fail 시 agentic mini-loop 로 escalate |
| `auditor` (기존) | + agentless localize 로 더 빨라짐 |

### 5.9.4 비용 라우팅

```
사용자 의도                  → 1차 시도            → escalate?
─────────────────────────────────────────────────────────────────
"이 버그 고쳐"                → agentless-fix       → 패치 fail 시 agentic mini-loop
"리포트 작성"                 → agentless localize  → 그대로 보고
"refactor"                   → agentic builder    → agentless 안 함 (구조 변경 큼)
"리뷰"                       → agentless localize → mmbridge_review 부착
```

근거 (Agentless 논문): 32.67% 의 Lite 인스턴스가 **agent 없이도** 풀림. 그 32% 를 cheap path 로 흡수하면 평균 비용 급감.

### 5.9.5 Phase 추가

기존 Phase A-F 에 **Phase G — Agentless lane** 추가 (선택):

- `packages/orchestrator/src/agentless/{localize-hierarchical,candidate-generator,patch-validator}.ts`
- `packages/orchestrator/src/personas/{agentless-fix,agentless-then-agent}.ts`
- `tests/orchestrator/agentless/*.test.mjs`
- 옵션: Layer A 가 `unclecode agentless run "..."` 직접 호출 가능

Phase G 는 A-F 와 독립. 늦게 해도 됨.

---

## 5.10 Memory Architecture — Honcho + mem0 + Walnut + claude-mem + context7 통합

> 사용자 요구: Honcho 개념 + mem0 + Walnut(=alive) 살리고, claude-mem + context7 를 UncleCode 에 녹여라. 팀단위 작업 가능?

### 5.10.1 5 가지 메모리 시스템 핵심

| 시스템 | 핵심 통찰 | UncleCode 적용 |
|---|---|---|
| **Honcho** (plastic-labs) | 2-layer (sync API + async background), 3 agents (Deriver=observe extract, Dialectic=answer query). Entity-centric **peer model** (user + agents + groups + ideas). "Living, thinking reservoir of synthetic data" | **peer 추상 도입** — 워커, 팀, 사용자 모두 peer. Deriver/Dialectic 패턴. |
| **mem0** (YC, arxiv 2504.19413) | Vector + Graph hybrid. Dynamic extract/consolidate/retrieve. **Token cost -90%, latency -91%**, +26% LLM-judge over OpenAI memory | semantic 메모리 store backbone. 그래프 트래버설 + similarity. |
| **Walnut (=alive)** | "Living memory" = past experiences + reflections + relationships. Personal Superintelligence Communication Network | reflections — 매 run 끝에 self-reflection 항목 적재. relationships — peer 간 fact graph edge. |
| **claude-mem** (thedotmack, 65.8K stars, v12.3.8) | 5 lifecycle hooks (SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd) → SQLite + ChromaDB. **3-layer retrieval** (search → timeline → get_observations) ~10x token savings. `<private>` redaction. | episodic 메모리 구현체로 직접 채택. UncleCode 가 같은 SQLite/Chroma 를 read/write. |
| **context7** (Upstash) | resolve-library-id + query-docs. 외부 라이브러리/API 의 source-of-truth. 학습 데이터 outdated 문제 해결. | external_doc SSOT (§5.6 카테고리 추가). ACI tool 에 `consult_docs(library, topic)` 추가. |

추가 참고:
- **CoALA** 인지 아키텍처: episodic / semantic / procedural triad
- **LinkedIn CMA** (InfoQ 2026-04): shared memory substrate across specialized agents + SOP refinement loop
- **MemAgents** (ICLR 2026 workshop)
- **Mem0 paper (arXiv 2504.19413)**: production-grade memory layer

### 5.10.2 통합 아키텍처

```
                  ┌─────────────────────────────────────┐
                  │  Identity / Peer Layer (Honcho)     │
                  │  peer = user | agent | team | run   │
                  │  Deriver  (async): observe → extract │
                  │  Dialectic(sync) : query → synthesize│
                  └─────────────────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Episodic        │  │ Semantic (mem0) │  │ Procedural      │
│ (claude-mem)    │  │ vector + graph  │  │ (SOPs, Walnut   │
│ what happened   │  │ what I know     │  │  reflections)   │
│ session/turn    │  │ entities, code  │  │ how-to,         │
│ SQLite+Chroma   │  │ facts, edges    │  │ playbooks       │
└─────────────────┘  └─────────────────┘  └─────────────────┘
                                 │
                  ┌──────────────┴──────────────┐
                  ▼                             ▼
       ┌─────────────────────┐    ┌─────────────────────┐
       │ External SSOT       │    │ Run-local SSOT      │
       │ (context7)          │    │ (§5.5 RUN_ROOT)     │
       │ libs/APIs/frameworks│    │ checkpoints +       │
       │ resolve-library-id  │    │ workers + reviews   │
       │ query-docs          │    │ sha256 chain        │
       └─────────────────────┘    └─────────────────────┘
```

### 5.10.3 신규 패키지 — `packages/memory-bus/`

```
packages/memory-bus/
  src/
    types.ts                 # Peer, MemoryQuery, MemoryResult, Observation
    peer-registry.ts         # user:<email>, agent:<persona>, team:<run_id>, run:<id>
    deriver.ts               # async LLM call: step result → observations
    dialectic.ts             # sync: synthesize answer from N stores
    episodic-store.ts        # claude-mem SQLite/Chroma reader+writer (compat)
    semantic-store.ts        # mem0 (sqlite-vss default, FalkorDB optional)
    procedural-store.ts      # .unclecode/sop/*.md filesystem
    external-doc-store.ts    # context7 MCP client wrapper
    reflection.ts            # Walnut-style end-of-run reflection generator
    private-redaction.ts     # <private> tag honored (claude-mem 호환)
    index.ts                 # unified Memory facade
```

### 5.10.4 통일된 Memory contract

```typescript
type Peer =
  | { kind: "user"; id: string }            // user:<email>
  | { kind: "agent"; persona: PersonaId }    // agent:coder
  | { kind: "team"; runId: string }          // team:tr_xxx
  | { kind: "run"; runId: string };          // run:tr_xxx (single-process)

type MemoryQuery = {
  asker: Peer;
  about?: Peer;                              // whose memory (default = asker)
  category: "episodic" | "semantic" | "procedural" | "external_doc";
  query: string;
  budget?: { tokens: number; latencyMs: number };
};

type MemoryResult = {
  citations: VersionedRef[];                 // SSOT-cited (§5.6)
  synthesized?: string;                      // Honcho Dialectic-style natural answer
  rawObservations?: Observation[];
  retrievalHash: string;                     // 결과 자체도 cite 가능
};
```

**모든 memory result 는 §5.6 SSOT citation 시스템과 호환** — agent claim 이 memory 를 인용할 때 `(queryId @ retrievalHash)` 페어 사용. 같은 query 가 다른 retrievalHash 를 반환했다면 stale → 재query 강제.

### 5.10.5 Multi-agent shared substrate (LinkedIn CMA 패턴)

| Peer 종류 | 메모리 가시성 | 예시 |
|---|---|---|
| `team:tr_xxx` | 같은 run 의 모든 워커 read+write | "이번 run 동안 worker-1 이 알아낸 사실" |
| `agent:coder` | 모든 run 에서 coder persona 의 procedural SOP 읽기 | "어떤 식으로 fix 해야 하는지 학습된 패턴" |
| `user:<email>` | 사용자 cross-session episodic | "사용자가 선호하는 코드 스타일" |
| `run:<id>` | 단일 워커 process scratchpad | working memory, 소멸 |

**격리 규칙**: 워커는 자기 `run:` peer 에 자유 write, `team:` 에는 SSOT 룰 따라 write (§5.6), `agent:` / `user:` 는 read-only. write 필요 시 Deriver 가 async 로 처리 (워커 main loop 차단 X).

### 5.10.6 Deriver 동작 (Honcho 패턴 적용)

```
worker step 완료 →
  publish step checkpoint (RUN_ROOT, 즉시) →
  enqueue deriver task (async, 별도 process or task) →
    deriver:
      1. read step's action + observation
      2. cheap LLM (gpt-5-haiku 같은) call: extract observations
         "Worker tried X, observed Y. What facts about codebase/user/task?"
      3. classify into episodic/semantic/procedural
      4. write to appropriate store with citation back to step
  return control to worker (no blocking)
```

비용: 짧은 cheap LLM call 1회 / step. 처리 안 끝나도 워커는 진행. 누락된 observation 은 다음 dialectic query 에서 graceful degradation.

### 5.10.7 Dialectic 동작 (query 시)

```
worker needs context:
  agent.queryMemory({ asker: agent.peer, category: "semantic", query: "..." })
    →
  dialectic:
    1. parse query intent
    2. fan-out to relevant stores (episodic if "지난번에", semantic if "X 가 뭐", external_doc if "<lib> API")
    3. mem0-style hybrid retrieve (vector + graph traversal)
    4. claude-mem-style 3-layer (search → timeline → get_observations) — 큰 expand 만 필요할 때만
    5. compose natural-language answer (Honcho-style) + raw citations
  return MemoryResult
```

토큰 절약: claude-mem 의 ~10x + mem0 의 ~90% 누적 → context 폭발 방지.

### 5.10.8 Reflections (Walnut 패턴)

매 run 종료 시 `reflection.ts` 가:

```
input: full RUN_ROOT (manifest, checkpoints, workers, reviews)
output:
  - "이 run 에서 잘 한 것" (procedural hint, agent SOP 에 promote 후보)
  - "이 run 에서 실패한 것" (avoidance pattern)
  - "사용자에 대해 알게 된 것" (episodic, user peer 로 적재)
  - "코드베이스에 대해 알게 된 것" (semantic graph 업데이트)
```

저장: `procedural-store` 와 `episodic-store` 에 분기 저장. 다음 run 에서 dialectic 이 query 시 재활용.

### 5.10.9 context7 → ACI 통합

`packages/orchestrator/src/aci/consult-docs.ts` 신규 — file-viewer/editor 와 동급 ACI tool:

```typescript
// agent action: { tool: "consult_docs", library: "react", topic: "useEffect cleanup" }
async function consultDocs(input: { library: string; topic: string }, runtime): Promise<ToolResult> {
  const libId = await context7.resolve_library_id(input.library);
  const docs = await context7.query_docs(libId, input.topic);
  return {
    content: docs,
    citations: [{ kind: "external_doc", source: `context7://${libId}#${sha256(docs)}` }]
  };
}
```

목적: agent 가 외부 라이브러리 API 추측하지 못하게 함. **할루시네이션 차단 (§5.6 의 보강)**.

Persona 별 노출:
- `coder`, `builder`: ON
- `hardener`: ON (security advisories 도 docs 일부)
- `auditor`: ON (read-only 라 안전)
- `agentless-fix`: OFF (no loop, 직접 patch)
- `mini`: OFF (ACI 우회)

### 5.10.10 Phase I 추가 — Memory Bus (선택, A-G 후)

```
Phase I — Memory Architecture (1-2 PR)
- packages/memory-bus/src/{types,peer-registry,deriver,dialectic,
                          episodic-store,semantic-store,procedural-store,
                          external-doc-store,reflection,private-redaction}.ts
- packages/orchestrator/src/aci/consult-docs.ts  (context7 wrapper)
- packages/contracts/src/memory.ts                (Peer, MemoryQuery, MemoryResult)
- 의존성: claude-mem 의 SQLite/Chroma path 호환 read (가능하면 같은 DB 공유)
- 통합: MiniLoopAgent 의 onBeforeStep 에 dialectic auto-context-prepend (옵션)
- 통합: MiniLoopAgent 의 onAfterStep 에 deriver async fire-and-forget
- 통합: team-runner 의 onRunEnd 에 reflection.generate() 호출
- 테스트: peer 격리, citation 무결성, deriver 비차단성, reflection 적재
```

### 5.10.11 답변: "팀단위로 여기서 작업 가능한건가 이제 멀티에이전트 모델들로?"

**예. 가능. 단 두 단계:**

**즉시 가능 (오늘부터, Layer A 만으로):**

이미 본 session (Claude Code) 에 부착된 자원:

| 자원 | 역할 |
|---|---|
| `mmbridge` MCP (12 tools: review/security/gate/handoff/debate/embrace/context_packet/...) | 멀티 LLM fan-out 의 conductor |
| `claude-mem` v12.3.8 (5 hooks + 3-layer MCP) | episodic memory cross-session |
| `context7` MCP (resolve-library-id + query-docs) | external doc SSOT |
| `agent-teams` plugin (team-spawn/feature/debug/review/delegate/shutdown) | parallel agent 부트 |
| `hermes-fanout` skill | acpx 다중 lane orchestration |
| `omx` skill (`omx exec --ephemeral --sandbox`) | codex 워커 lane |
| `second-claude-code` PDCA (research/analyze/write/review/refine/loop/batch) | knowledge work pipeline |
| `serena` MCP | semantic code search |
| `kimi-researcher` agent | depth-research lane (BrowseComp 60.6%) |
| `codex-rescue` agent | stuck 시 GPT-5-Codex 핸드오프 |
| `gemini-design-reviewer` agent | Gemini 3.1 Pro lane |
| `qwen-reviewer` / `kimi-reviewer` / `codex-reviewer` | 멀티 모델 리뷰 |

**오늘 가능한 패턴**:
```
사용자: "이 feature 추가해" →
  Claude Code (Opus 4.7) router agent →
    [parallel]
    - codex-rescue (GPT-5.3-Codex) implements
    - kimi-researcher checks similar OSS solutions
    - gemini-design-reviewer checks visual/UX implications
    →
  mmbridge_debate 로 의견 합성 →
  mmbridge_gate 로 verify →
  Claude Code 가 사용자에게 종합 보고
```

이게 **현재 오늘 가능한 멀티 모델 팀모드**. claude-mem 이 cross-session 으로 기억함.

**완전한 그림 (UncleCode 본 doc 의 Phase A-I 후):**

| Phase | 추가되는 능력 |
|---|---|
| A-C | UncleCode 자체가 mini-loop + team scaffold + RUN_ID binding |
| D | mmbridge hook + SSOT citation 강제 |
| E | Hermes operator 가 unclecode 호출 |
| F | OMX `harness apply` 통합 |
| G | Agentless lane (32% 의 cheap path) |
| **H** | **Layer A 의 router agent + RUN_ID env propagation** ← 이게 핵심 |
| **I** | **Memory bus (Honcho+mem0+Walnut+claude-mem+context7 통합)** ← 메모리 통일 |

Phase H 가 제일 중요. **본 repo 변경 없이** Claude Code 측 `~/.claude/agents/team-router.md` + `~/.claude/skills/team-orchestrator/SKILL.md` 만으로 가능. UncleCode 가 RUN_ID env 받으면 같은 RUN_ROOT 에 dump → mmbridge 가 read → conductor 가 종합.

**즉, 오늘 = 부분적으로 이미 가능. 본 doc 완성 후 = 완전한 메모리-공유 팀모드.**

---

## 6. Pi-Fast 보장

| 항목 | 기존 | 팀 모드 추가 후 |
|---|---|---|
| `unclecode doctor` cold start | 421ms (Phase 3 측정) | unchanged — fast-cli 에 `team` 합류 X |
| `unclecode mini run` cold start | n/a | <300ms 목표 (lazy-load orchestrator subset) |
| `unclecode team run --lanes 1` | n/a | <600ms 목표 (manifest write + 1 worker spawn) |
| `unclecode team status` | n/a | <100ms (fast-cli, JSON 1회 read) |

원칙:
- `team` 의 hot path 는 manifest 만 만들고 워커는 `setImmediate` 로 detach
- TUI 는 lazy import — `unclecode team run` 은 headless 가 default
- `--quiet` 시 stdout 은 run_id 단 1 줄

---

## 7. 단계별 구현 계획

### Phase A — Foundations (1 PR)
- `packages/contracts/src/mini-loop.ts` — zod schema (Persona, LoopConfig, LoopHooks, ChatMessage)
- `packages/contracts/src/team.ts` — TeamRunManifest, TeamRunCheckpoint, TeamStepCheckpoint, TeamContextPacket, TeamRunStatus (TeamRunCheckpoint/TeamStepCheckpoint 둘 다 `prevTipHash`, `lineHash` 필드 포함)
- `packages/contracts/src/ssot.ts` — `CitedClaim`, `Citation`, `SsotCategory`, `VersionedRef`
- `packages/contracts/src/session.ts` — `SESSION_CHECKPOINT_TYPES` 에 `"team_run"`, `"team_step"` 추가 (tuple expand)
- contract 테스트만 추가, runtime 변경 없음. `validators.ts` 가 unknown checkpoint type 을 reject 하지 않는지 확인하는 회귀 테스트 포함
- citation/hash chain JSON shape 의 round-trip 테스트

### Phase B — MiniLoopAgent + ACI (1 PR)
- `packages/orchestrator/src/mini-loop-agent.ts` — Environment(`LocalAdapter`) + Provider(`CodingAgentProvider`) 래핑, append-only loop, marker exit
- `packages/orchestrator/src/aci/{file-viewer,file-editor,linter-guardrail,search,observation-collapser}.ts` — SWE-agent ACI tool set (line-anchored edit + flake8/biome linter + summarized search 50 cap + obs collapse)
- `packages/orchestrator/src/personas/{coder,builder,hardener,auditor}.ts` — step/cost budget per persona, ACI tool 노출 set
- 단위 테스트: marker exit, step_limit, cost_limit, hook injection, halt, ownership claim, **linter revert on bad edit**, **search cap & refine suggestion**, **observation collapse (last 5 full)**

### Phase C — Team Scaffold + Bindings (1 PR)
- `packages/session-store/src/team-run-store.ts` — `createTeamRun`, `appendCheckpoint`, `readCheckpoints` (generator), `lockRun` (advisory flock), `attachLiveSocket` (UDS lifecycle)
- `packages/orchestrator/src/team-binding.ts` — `bindToRun(runId, role)`, publish/subscribe (cold log + optional live socket), env propagation (`UNCLECODE_TEAM_RUN_ID`, `UNCLECODE_TEAM_RUN_ROOT`)
- `packages/orchestrator/src/file-ownership-registry.ts` — disk-backed mode 추가 (per-path lock files at `<RUN_ROOT>/locks/<sha256>.lock`); 기존 in-process API 유지
- `packages/orchestrator/src/team-runner.ts` — manifest 생성, 워커 dispatch, ownership registry 결합, summary.md 생성
- `apps/unclecode-cli/src/team.ts` — `team run/status/ls/inspect/resume/abort`; `--record <run_id>` 와 `--live` flag
- `apps/unclecode-cli/src/program.ts` — `team` / `persona` / `mini` subcommand 등록
- `apps/unclecode-cli/src/fast-cli.ts` — `team status [run_id]` / `persona list` fast-path (manifest 만 read)

### Phase D — MMBridge Hook + SSOT 강제 (1 PR)
- `packages/orchestrator/src/hooks/mmbridge-hooks.ts` — review/gate/security/handoff/context_packet 콜
- `packages/orchestrator/src/hooks/citation-enforcer.ts` — onAfterStep 훅, 미인용 claim 검출 + system reminder injection
- `packages/orchestrator/src/team-binding.ts` — `readCode(path)`, `cite(category, key)`, `verifyCitation(ref)` 추가
- Persona 가 사용할 hook set 정의 — 모든 persona 에 citation-enforcer + freshness gate default-on
- `mmbridge_gate` fail → corrective signal contract; gate 가 cite-coverage 검증 포함
- `team-run-store.verifyChain(runId)` API 추가
- `unclecode team inspect <id> --verify` 옵션 구현 — chain + citation + freshness + divergence 한 번에 보고

### Phase E — Hermes 연동 (1 PR)
- `scripts/hermes-team-run.mjs` (new) — 외부 entry, artifact mirror
- `references/hermes/team-coder-skill.md`, `team-builder-skill.md` — operator-prompt
- `references/hermes/examples/team-coder.json`, `team-builder.json` — payload 템플릿
- 기존 `external-coding-supervisor` 와 공존

### Phase F — Doctor / Harness 통합 (1 PR)
- `unclecode doctor` 에 `team` 섹션 — runtime mode 가용성, 최근 run 상태
- `unclecode harness apply <persona>` 옵션 — persona 의 model/reasoning 을 `.codex/config.toml` 에 stamp (OMX 와 호환)
- `unclecode mode set yolo+builder` 같은 합성 mode 검증

각 phase 단독 mergeable. Phase A→F 순서 강제. C 까지만 가도 mini-loop 단독 사용 가능.

### Phase G — Agentless lane (선택, §5.9)
- `packages/orchestrator/src/agentless/{localize-hierarchical,candidate-generator,patch-validator}.ts`
- `packages/orchestrator/src/personas/{agentless-fix,agentless-then-agent}.ts`
- `apps/unclecode-cli/src/agentless.ts` — `unclecode agentless run "..."` 단독 cmd
- 단위 테스트: hierarchical localize 정확도, multi-candidate 생성, patch validator 채점
- A-F 와 독립. 늦게 해도 됨.

### Phase H — Layer A 통합 (Claude Code 측, optional, scope 외 가능)
- `~/.claude/agents/team-router.md` — 의도 분류 → CLI 선택 → dispatch (§5.8.3)
- `~/.claude/skills/team-orchestrator/SKILL.md` — RUN_ID env 부착 + standardized JSON output capture
- mmbridge / hermes prompt 정의 — `team-coder`, `team-builder` operator profile
- **본 repo 변경 X** — Claude Code 사용자 설정 차원. 본 doc 는 contract 만 정의, 구현은 별도 chore.

---

## 8. 파일 소유권 / 충돌 회피

신규 파일만 추가, 기존 파일 수정은 최소화:

| 신규 (~19 파일) | 수정 (4 파일) |
|---|---|
| `packages/contracts/src/{mini-loop,team,ssot}.ts` | `packages/contracts/src/index.ts` (re-export) |
| `packages/orchestrator/src/mini-loop-agent.ts` | `packages/contracts/src/session.ts` (checkpoint type tuple expand) |
| `packages/orchestrator/src/aci/{file-viewer,file-editor,linter-guardrail,search,observation-collapser}.ts` | |
| `packages/orchestrator/src/team-runner.ts` | `apps/unclecode-cli/src/program.ts` (subcommand 등록) |
| `packages/orchestrator/src/team-binding.ts` | `apps/unclecode-cli/src/fast-cli.ts` (fast-path) |
| `packages/session-store/src/team-run-store.ts` | |
| `packages/orchestrator/src/personas/{coder,builder,hardener,auditor}.ts` | |
| `packages/orchestrator/src/hooks/{mmbridge-hooks,citation-enforcer}.ts` | |
| `apps/unclecode-cli/src/team.ts` | |
| `apps/unclecode-cli/src/persona.ts` | |
| `apps/unclecode-cli/src/mini.ts` | |
| `scripts/hermes-team-run.mjs` | |
| `references/hermes/team-{coder,builder}-skill.md` | |
| `references/hermes/examples/team-{coder,builder}.json` | |
| `tests/orchestrator/mini-loop.test.mjs` | |
| `tests/orchestrator/team-runner.test.mjs` | |
| `tests/orchestrator/team-binding.test.mjs` | |
| `tests/session-store/team-run-store.test.mjs` | |
| `tests/integration/team-run.integration.test.mjs` | |
| `tests/integration/team-resume.integration.test.mjs` | |

주의: `file-ownership-registry.ts` 는 기존 파일을 **확장** (disk-backed mode 추가), 기존 API 시그니처 유지 — 위 표의 수정 4 파일에는 안 들어감 (in-place additive).

**`AGENTS.md` 는 건드리지 않는다** (OMX generated).

---

## 9. Acceptance Criteria

### Phase B 완료 조건
- [ ] `unclecode mini run "echo hi && echo __UNCLECODE_SUBMIT__"` 가 200ms 안에 종료, exit_status=Submitted
- [ ] step_limit=3 이고 marker 없는 prompt 면 `LimitsExceeded` exit
- [ ] hook injection 으로 `mmbridge_review` mock 응답이 다음 step 의 message 에 포함
- [ ] LocalAdapter 가 `runtime=docker` 일 때 mock dockerAdapter 로 swap (e2e 는 skip 가능, contract 만)
- [ ] `file-editor.edit(start, end, replacement)` 가 syntax error (예: 잘못된 indentation) 인 replacement 를 거부 + 3-part error message inject (논문 §1.7)
- [ ] `search.search_dir(query)` 가 결과 50개 초과 시 truncate + "refine query" suggestion
- [ ] `observation-collapser` 가 6 번째 step 부터 oldest obs 를 1-line 으로 collapse, sha256 versionHash 는 유지 (cite 가능)
- [ ] persona budget: `coder` step_limit=16, cost_limit_usd=1.50 으로 enforce
- [ ] `mini` persona 는 ACI 우회 (pure bash) — `--persona mini` 일 때 ACI 도구 노출 안 함

### Phase C 완료 조건
- [ ] `unclecode team run "fix bug" --persona coder --lanes 1` 가 `.data/team-runs/<id>/{manifest.json, checkpoints.ndjson, summary.md, reviews/mmbridge-gate.json}` 생성
- [ ] `--lanes 2` 일 때 file ownership registry (disk-backed) 가 동일 path write 충돌 차단; 두 lane 이 같은 host 에서 race condition 없이 직렬화
- [ ] `team status <id>` 가 fast-path (commander bypass) 로 100ms 이하
- [ ] `team abort` 가 워커 SIGTERM + manifest 의 status="killed" + advisory `.lock` release
- [ ] 두 번째 coordinator 가 같은 RUN_ID 로 진입하면 `.lock` 으로 차단 (명시적 에러 메시지)
- [ ] `team resume <id>` 가 `checkpoints.ndjson` replay → 마지막 상태 복원 → 동일 RUN_ID 로 새 step 추가
- [ ] 워커 환경에 `UNCLECODE_TEAM_RUN_ID` / `UNCLECODE_TEAM_RUN_ROOT` 가 정확히 전파됨 (외부 OMX/Codex 가 join 가능한지 smoke test)
- [ ] 두 워커가 `openai-credential-store` 를 공유 — re-auth 발생 안 함

### Phase D 완료 조건 (SSOT)
- [ ] `team inspect <id> --verify` 가 chain 을 첫 줄부터 마지막 line 까지 sha256 chain 검증
- [ ] 인위적으로 한 line 변조 → `verifyChain` 이 정확한 brokenAt index 반환
- [ ] 미인용 claim 이 포함된 worker step 에 대해 citation-enforcer 가 system reminder 를 inject (테스트 가능한 mock LLM 으로 검증)
- [ ] 두 워커가 같은 path 를 다른 sha256 으로 인용 → freshness gate 가 stale 워커 step 을 reject + reload 강제
- [ ] `mmbridge_gate` 가 "tests pass" claim 을 verify — 인용된 stepIndex 의 observation.exitCode != 0 이면 fail
- [ ] cite-coverage < 50% 인 run 에 대해 gate 가 warn 레벨 발행

### Phase E 완료 조건
- [ ] Hermes operator-prompt (PROMPTS.md 패턴) 로 `team-builder.json` 실행 → standard read order 보장
- [ ] `summary.md` 1번 read 만으로 accept/corrective 결정 가능

### Pi-fast 회귀 방지
- [ ] `unclecode doctor` cold start 가 기존 421ms ±10% 안
- [ ] `team` 추가가 `unclecode work` cold start 에 50ms 이상 영향 주지 않음 (lazy-load 검증)

---

## 10. 위험 및 미해결

1. **mini-loop 의 marker exit 가 user prompt 우연 일치 시 false-submit.** → marker 를 entropy-rich default (`__UNCLECODE_SUBMIT_${runId.slice(0,8)}__`) 로.
2. **`run_shell` 은 현재 `UNCLECODE_ALLOW_RUN_SHELL=1` env-gated.** Team 모드는 LocalAdapter 직접 사용 → 정책 재평가 필요. **결정**: Persona 가 명시적으로 `tools: ["run_shell"]` 를 declare 했을 때만, 그리고 policy-engine 의 mode 가 `yolo` 또는 `team-trusted` 일 때만 허용.
3. **Hermes 외부 의존**: 본 repo 는 Hermes binary 를 install 하지 않는다. Hermes 가 없는 환경에서 `unclecode team run` 은 standalone 으로 동작해야 함 (coordinator 자리는 CLI 자신이 fallback).
4. **OMX `AGENTS.md` overlay 와의 충돌**: OMX 가 marker-bounded 영역 안에 우리 정책을 inject 하지 않도록, `prompts/team-coder.md` / `prompts/team-builder.md` 를 OMX 의 prompts/ 로 따로 둔다.
5. **e2b runtime adapter 미구현**: contract 에는 있으나 adapter 없음. Phase B 는 local 만, docker 는 mock. e2b 는 별도 후속.

---

## 11. 다음 결정 요청

이 문서를 검토하고 다음 셋 중 하나로 답하면 진행한다:

- **GO**: Phase A 부터 즉시 구현 시작
- **GO with edits**: 어느 phase / 어느 contract 를 바꿀지 적시
- **HOLD**: 추가 조사가 필요한 항목 지정 (예: e2b 어댑터, OMX prompts 통합, Hermes operator skill 의 정확한 entrypoint)

본 제안은 기존 17-task Sisyphus plan 의 Task 13 (multi-agent foundation) 위에 얹힌다. Task 16 (performance hardening) 과는 Phase F 에서 합류.
