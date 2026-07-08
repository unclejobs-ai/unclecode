# OpenHands 차용 전수조사 보고서

작성일: 2026-07-07  
대상: UncleCode, OpenHands/OpenHands, OpenHands/software-agent-sdk, OpenHands/agent-canvas  
질문: OpenHands에 있는 것을 UncleCode에 차용하면 좋은가. 단, UncleCode의 독특한 context management가 메인이 되어야 한다.

## 0. 결론

OpenHands는 지금 "하나의 에이전트 구현체"라기보다 세 덩어리로 갈라지고 있다. 첫째, `OpenHands/OpenHands`는 Agent Canvas와 자동화/런처 중심의 상위 제품 저장소가 되고 있다. 둘째, 실제 agent/runtime 핵심은 `OpenHands/software-agent-sdk`로 이동했다. 셋째, UI/control-center는 `OpenHands/agent-canvas`로 분리되었다. OpenHands README도 Agent/Agent Server와 Canvas 소스가 별도 저장소로 이동 중이라고 명시한다. 따라서 UncleCode가 OpenHands를 차용한다면 "OpenHands 전체를 가져오기"가 아니라, SDK와 Canvas에 흩어진 좋은 설계 부품을 UncleCode의 context-first 구조에 맞게 흡수하는 전략이 맞다.

가장 중요한 판단은 이렇다. OpenHands의 핵심 강점은 실행 환경, tool/action contract, event log, condenser, Agent Server/Canvas 경계, ACP/automation control surface다. 반면 UncleCode의 핵심 강점은 이미 `next model-call packet`을 제품 중심 객체로 두는 점, `.unclecode`/AgentOps/CRP 기반 context source ledger, `/context` inspector, pin/forget/include 같은 사용자 조작 가능성이다. OpenHands의 condenser는 "커진 대화 기록을 줄이는 장치"이고, UncleCode의 CRP는 "무엇이 다음 모델 호출에 들어가야 하는지 선택, 설명, 조작하는 장치"다. 이 차이를 잃으면 UncleCode의 독자성이 사라진다.

추천은 네 단계다.

1. 바로 차용: typed Action/Observation tool contract, declared resource locking, secure atomic persistence, security risk/confirmation policy.
2. 변형 차용: OpenHands EventLog/branching과 condenser를 CRP의 하위 provider로 편입한다. condenser가 직접 prompt를 지배하지 않게 한다.
3. 조건부 차용: workspace abstraction, Agent Server, Canvas backend registry, ACP adapter, automations UI는 UncleCode가 remote/cloud/control-center로 확장할 때 도입한다.
4. 피해야 할 것: Agent Canvas 전체 UI 복제, OpenHands식 markdown/microagent memory를 UncleCode memory의 중심으로 삼는 것, LiteLLM/Python SDK를 UncleCode core provider 계층으로 통째로 끌어오는 것.

## 1. 조사 범위와 근거

### 외부 저장소

2026-07-07에 세 저장소를 shallow clone해서 HEAD를 고정하고 읽었다.

| 저장소 | 조사한 HEAD |
| --- | --- |
| `OpenHands/OpenHands` | `cc80397ecdbb646be4d6578034a36ec399faa92e` |
| `OpenHands/software-agent-sdk` | `91f8b9403c16c30edee2f86cff634c38234c8a27` |
| `OpenHands/agent-canvas` | `3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3` |

2026-07-08에 원격 HEAD를 다시 확인했다. `OpenHands/software-agent-sdk`는 여전히 `91f8b9403c16c30edee2f86cff634c38234c8a27`이었고, 핵심 SDK 판단은 그대로 유효하다. `OpenHands/OpenHands`는 `2dc45f5e0d193c979def9d40ec6cbbc05e582e7e`로 이동했지만 diff 범위는 MCP config formatting/tests, live status app conversation service, dependency lockfile 중심이었다. `OpenHands/agent-canvas`는 `847b0a8e9598a39f35eaec1c8701c3477dc2e6c9`로 이동했지만 diff 범위는 automation debug/run-log UI, conversation creation tracking, temporary PR screenshot cleanup 중심이었다. 따라서 아래 판단은 SHA-pinned source를 기준으로 하되, 최신 HEAD 재확인 결과가 결론을 뒤집지는 않았다.

주요 외부 근거:

- OpenHands README: 제품 포지션, 저장소 분리 안내, Agent Canvas/Agent Server 관계. [OpenHands README](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/README.md)
- OpenHands configuration: condenser 종류, sandbox/runtime 설정. [config.template.toml](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/config.template.toml)
- SDK docs: architecture, event, condenser, workspace, tool system, security, skill, plugin, conversation persistence. [SDK architecture overview](https://docs.openhands.dev/sdk/arch/overview), [event system](https://docs.openhands.dev/sdk/arch/events), [condenser](https://docs.openhands.dev/sdk/arch/condenser), [workspace](https://docs.openhands.dev/sdk/arch/workspace), [tool system](https://docs.openhands.dev/sdk/arch/tool-system), [security](https://docs.openhands.dev/sdk/arch/security), [skills](https://docs.openhands.dev/sdk/arch/skill), [plugins](https://docs.openhands.dev/sdk/guides/plugins)
- SDK source: agent, tool, condenser, event log, state, workspace, Agent Server, persistence, security, skills. Source links are cited in the component sections.
- Agent Canvas source: architecture, backend registry, ACP probing, automation service. [Agent Canvas architecture](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/docs/architecture.md)

### UncleCode 기준선

UncleCode 쪽은 다음 문서와 코드를 기준으로 삼았다.

- README의 UncleCode 차별점: persistent shared context, runbook-driven agent memory, bootstrap/classify/packet flow. [README.md](../../README.md)
- context architecture: 핵심 제품 객체를 다음 모델 호출 패킷으로 정의. [persistent-context-architecture.md](../design/persistent-context-architecture.md)
- bootstrap pipeline: skills, guidance, Cursor rules, MCP, memory를 raw dump가 아니라 classify된 packet으로 다루는 설계. [context-bootstrap-pipeline.md](../design/context-bootstrap-pipeline.md)
- CRP: `context_sources` SQL ledger, `ContextSelector`, salience, pin/forget/include. [crp-context-runbook-protocol.md](../design/crp-context-runbook-protocol.md)
- Context Inspector status: `/context` overlay, pin/unpin/forget/include store mutation. [context-inspector-status.md](../context-inspector-status.md)
- bootstrap implementation: `BootstrapSourceRecord`, included/excluded/warnings packet supplement, guidance/skills/cursor/MCP/memory ingest. [context-bootstrap.ts](../../packages/context-broker/src/context-bootstrap.ts)
- AgentOps store API: context source pin/unpin/forget/include methods. [store.ts](../../packages/agentops-db/src/store.ts)

## 2. UncleCode의 기준선: OpenHands보다 지켜야 할 것

UncleCode는 이미 OpenHands와 다른 중심축을 가지고 있다.

| UncleCode 축 | 현재 근거 | OpenHands와의 차이 |
| --- | --- | --- |
| 다음 모델 호출 패킷 | PRD와 architecture 문서가 `next model-call packet`을 핵심 제품 객체로 둔다. | OpenHands는 event history와 condenser가 중심이다. |
| inspectable context | `/context`가 included/excluded/warnings, held back, pin/forget/include를 보여주는 방향이다. | OpenHands condenser summary는 유용하지만 사용자 조작 가능한 source ledger는 아니다. |
| repo-local persistent context | `.unclecode/`, AgentOps DB, scoped memory, bootstrap snapshot이 있다. | OpenHands는 conversation persistence와 `.openhands` store가 강하지만 context selection 자체를 제품 객체로 세우지는 않는다. |
| runbook/procedural memory | `.unclecode/sop`, memory-bus, context-broker가 절차 기억을 다룬다. | OpenHands의 repo memory/microagents는 markdown skill 성격이 강하다. |
| MCP/skills를 packet source로 분류 | bootstrap은 guidance, skills, Cursor rules, MCP metadata, scoped memory를 source record로 수집한다. | OpenHands skill/plugin 호환성은 넓지만, UncleCode식 salience와 packet inspectability가 더 강한 차별점이다. |

따라서 OpenHands에서 가져올 모든 것은 다음 원칙을 통과해야 한다.

1. CRP `context_sources`에 provenance, salience, inclusion reason을 남길 수 있어야 한다.
2. `/context` inspector에서 사용자가 왜 포함/제외됐는지 볼 수 있어야 한다.
3. condenser나 event log가 model prompt를 직접 장악하지 않고, CRP selector가 최종 조립권을 가져야 한다.
4. 새 dependency와 새 UI 표면은 UncleCode의 Node/Rust monorepo, TUI 중심 UX, no-new-dependency 원칙과 맞아야 한다.

## 3. OpenHands 전수조사

### 3.1 OpenHands main repository

현 OpenHands main repo는 제품 런처와 Canvas/automation 쪽으로 이동하고 있다. README는 OpenHands를 self-hosted developer control center로 설명하고, OpenHands/Claude Code/Codex/Gemini/ACP-compatible agents를 하나의 UI에서 다룬다고 말한다. 동시에 Agent와 Agent Server source는 `software-agent-sdk`, Agent Canvas source는 `agent-canvas`로 옮겼다고 안내한다. [OpenHands README](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/README.md)

`pyproject.toml`도 `openhands-sdk`, `openhands-agent-server`, `openhands-tools` 패키지를 의존성으로 끌어온다. 즉, main repo만 읽고 agent core를 판단하면 안 된다. [pyproject.toml](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/pyproject.toml)

차용 판단: main repo는 "아이디어 출처"이고, 직접 차용 대상은 아니다. condenser config, sandbox config, automation packaging 정도만 참고한다. 특히 `config.template.toml`의 condenser variants는 전략 카탈로그로 유용하다. [config.template.toml](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/config.template.toml)

### 3.2 SDK agent model

`software-agent-sdk`의 `AgentBase`는 agent를 stateless configuration으로 정의한다. LLM, tools, MCP config, default tools, agent context, condenser 등을 config field로 둔다. [agent/base.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/agent/base.py)

좋은 점:

- agent를 실행 상태와 분리해서 재현성과 persistence가 좋다.
- default tools, custom tools, MCP config, condenser가 한 객체에 묶인다.
- `SOUL.md` 같은 identity hook이 있어 개인화/정체성 파일을 별도 레이어로 뺀다.

UncleCode 적용:

- UncleCode도 "agent profile"을 CRP와 분리된 config object로 명확히 두면 좋다.
- 단, `agent_context`를 단순 문자열 appendix로 키우는 방식은 피해야 한다. UncleCode에서는 agent context도 `context_sources`의 한 source category가 되어야 한다.

차용 판단: 부분 채택. agent config schema의 명확성은 좋지만, prompt appendix 중심 확장은 UncleCode thesis와 맞지 않는다.

### 3.3 Event log, conversation state, branching

OpenHands SDK의 event docs는 immutable, type-safe event framework와 append-only log를 강조한다. Source에서도 `EventLog`가 branch path, append lock, JSON persistence를 가진다. [event_store.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/conversation/event_store.py)

`ConversationState`는 status, confirmation, activated/invoked skills, leaf event id, active branch, append event parent stamping, lazy view를 가진다. [state.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/conversation/state.py)

좋은 점:

- append-only event log는 audit과 resume에 강하다.
- active branch와 parent event id는 conversation fork와 alternate path를 표현하기 좋다.
- waiting for confirmation, stuck, paused 같은 상태가 UI/control plane과 잘 맞는다.

UncleCode 적용:

- EventLog를 CRP의 상위 진실로 두면 안 된다. 대신 "context evidence provider"로 편입한다.
- event branch는 `/context` inspector에서 "현재 packet이 어떤 branch/event까지 근거로 삼는지" 보여주는 provenance로 좋다.
- UncleCode의 AgentOps DB와 session store에 active branch/fork metadata를 넣는 것은 가치가 있다.

차용 판단: 변형 채택. append-only event와 branching은 가져오되, final prompt assembly는 CRP가 계속 담당한다.

### 3.4 Context condenser

OpenHands condenser는 growing context를 줄이기 위한 장치다. 공식 docs는 `LLMSummarizingCondenser`, rolling/noop/pipeline/view 등을 설명한다. Source의 `CondenserBase`는 event view를 줄인 list로 만들고, condensation이 필요하면 condensation action을 emit하도록 설계되어 있다. [condenser docs](https://docs.openhands.dev/sdk/arch/condenser), [base.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/context/condenser/base.py)

`LLMSummarizingCondenser`는 별도 LLM, `max_size`, `keep_first`, token/request/event threshold, minimum progress 등을 갖고 summary prompt를 렌더링한다. [llm_summarizing_condenser.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py)

`View`는 LLM에 넣을 수 있는 linear ordered event list를 만들며, condensation event와 condensation request를 view에 반영한다. [view.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/context/view/view.py)

좋은 점:

- condenser를 interface로 분리하고 pipeline으로 연결할 수 있다.
- hard/soft threshold를 나눠 context budget pressure를 다룬다.
- condensation event를 event log에 남겨 resume/audit이 가능하다.

UncleCode 적용:

- `context_compact` provider로 가져온다. 입력은 event history나 source content이고, 출력은 CRP `context_sources` row다.
- summary row에는 `source_kind=condensed-history`, `content`, `summary`, `salience`, `provenance_event_ids`, `expires_at`, `recompute_reason` 같은 metadata가 필요하다.
- condenser가 직접 "이 summary를 prompt에 넣어라"라고 결정하지 않고, `ContextSelector`가 최종 included/heldBack를 정해야 한다.

차용 판단: 강한 변형 채택. UncleCode의 독자성은 "condense"가 아니라 "select, explain, steer"에 있다.

### 3.5 Tool system과 parallel execution

OpenHands tool system은 `Action`, `Observation`, `ToolDefinition`, `ToolExecutor`, annotations, schema validation, MCP export를 명확히 분리한다. [tool.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/tool/tool.py), [tool-system docs](https://docs.openhands.dev/sdk/arch/tool-system)

특히 `ToolAnnotations`는 MCP spec과 유사한 `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`를 갖고, `DeclaredResources`는 tool action이 어떤 resource를 만지는지 선언한다. [tool.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/tool/tool.py)

`ParallelToolExecutor`는 같은 resource를 만지는 tool은 직렬화하고, 다른 resource는 병렬 실행한다. resource 선언이 없는 tool은 안전하게 보수적으로 처리한다. [parallel_executor.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/agent/parallel_executor.py)

File editor는 normalized `file:{path}` resource를 선언해 같은 파일 편집 충돌을 막는다. [file_editor/definition.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-tools/openhands/tools/file_editor/definition.py)

Terminal observation은 cwd, python interpreter, exit code, truncated output/full output path 등을 LLM content에 반영한다. [terminal/definition.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-tools/openhands/tools/terminal/definition.py)

UncleCode 적용:

- ACI/tool registry에 `declaredResources`, `riskHints`, `llmVisibleOutputPolicy`를 추가할 가치가 크다.
- 병렬 tool call을 안전하게 늘릴 때 resource lock contract가 필요하다.
- `/context`에도 tool output이 raw로 들어갔는지, truncated summary만 들어갔는지 source row로 보여줄 수 있다.

차용 판단: 즉시 채택 후보 1순위. dependency 없이 설계만 포팅 가능하다.

### 3.6 Workspace/runtime abstraction

OpenHands workspace docs는 local, Docker, remote API workspace를 분리한다. [workspace docs](https://docs.openhands.dev/sdk/arch/workspace)

`BaseWorkspace`는 execute_command, upload/download, git_changes/diff, pause/resume을 추상화한다. [workspace/base.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/workspace/base.py)

`LocalWorkspace`는 host에서 직접 명령을 실행한다. [workspace/local.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/workspace/local.py)

`DockerWorkspace`는 container 안에 Agent Server를 띄우고 HTTP API로 통신한다. port allocation, volume/env, health check, GPU/network config가 있다. [docker/workspace.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-workspace/openhands/workspace/docker/workspace.py)

`APIRemoteWorkspace`는 runtime API URL/key, image policy, session id, resource factor, keep alive, pause-on-close 등을 갖는다. [remote_api/workspace.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-workspace/openhands/workspace/remote_api/workspace.py)

UncleCode 적용:

- 로컬 TUI가 기본인 UncleCode에는 당장 Docker/Remote를 core로 넣을 필요가 없다.
- 하지만 team mode, background automation, cloud workspace를 고려하면 `WorkspaceProvider` interface는 필요하다.
- workspace state도 CRP source가 되어야 한다. 예: current branch, dirty files, sandbox mode, worktree path, forwarded env policy.

차용 판단: 조건부 채택. runtime 확장 단계에서 adapter pattern만 가져온다.

### 3.7 Agent Server와 worktree per conversation

Agent Server docs는 SDK를 HTTP/WebSocket API 뒤에 세우는 long-running service로 설명한다. [Agent Server docs](https://docs.openhands.dev/sdk/arch/agent-server)

Source의 `conversation_service.py`는 conversation별 git worktree를 만들고 `openhands/<conversation_id>` branch를 사용한다. [conversation_service.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-agent-server/openhands/agent_server/conversation_service.py)

UncleCode 적용:

- background task, long-running automation, remote browser/desktop 같은 기능에는 service boundary가 좋다.
- 하지만 UncleCode의 현재 TUI 흐름에서는 Agent Server를 넣으면 복잡도가 커진다.
- conversation worktree는 "병렬 작업 격리"에는 매우 유용하다. Codex desktop thread/worktree 모델과도 잘 맞는다.

차용 판단: later. 지금은 worktree isolation 패턴만 설계 후보로 둔다.

### 3.8 Persistence와 secrets hygiene

OpenHands Agent Server store는 filename validation, secure directory mode, file lock, atomic JSON write, encrypted settings/secrets store를 갖는다. [persistence/store.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-agent-server/openhands/agent_server/persistence/store.py)

UncleCode 적용:

- AgentOps DB와 `.unclecode` JSON artifacts에 atomic write와 file lock 패턴을 더 체계적으로 적용할 수 있다.
- secrets가 context source로 들어오지 않게 source classification 단계에서 redaction policy를 더 강하게 둘 수 있다.

차용 판단: 즉시 채택. 구현 범위가 작고 안전 이득이 크다.

### 3.9 Security risk와 confirmation policy

OpenHands security docs와 source는 `LOW`, `MEDIUM`, `HIGH`, `UNKNOWN` risk와 confirmation policy를 가진다. analyzer가 실패하면 보수적으로 HIGH 취급한다. [security docs](https://docs.openhands.dev/sdk/arch/security), [analyzer.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/security/analyzer.py), [risk.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/security/risk.py)

UncleCode 적용:

- UncleCode의 yolo/default/approval 정책에 risk levels를 붙이면 설명력이 좋아진다.
- tool action이 context source를 mutate하는 경우, 예를 들어 `/context forget`이나 file edit, 위험도를 inspector에 표시할 수 있다.

차용 판단: 채택. OpenHands의 level model은 단순하고 재사용 가능하다.

### 3.10 Skills, plugins, microagents

OpenHands skill docs는 trigger 기반 context injection, dynamic content, MCP tools, third-party `.cursorrules`, `agents.md`를 다룬다. [skill docs](https://docs.openhands.dev/sdk/arch/skill)

Source의 `Skill`은 `SKILL.md`, scripts, references, assets, triggers, MCP tools, AgentSkills format, legacy mappings를 지원한다. `.cursorrules`, `agents.md`, `claude.md`, `gemini.md`도 third-party format으로 다룬다. [skill.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/skills/skill.py)

Installed skills는 user cache와 marketplace install/enable/disable/list/load 흐름을 가진다. [installed.py](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/skills/installed.py)

UncleCode 적용:

- UncleCode는 이미 skill progressive disclosure와 project/user skills를 갖고 있다. OpenHands에서 가져올 것은 "호환 catalog parser"다.
- `scripts/references/assets`, triggers, MCP tools metadata를 `BootstrapSourceRecord`로 흡수하면 좋다.
- OpenHands의 markdown repo memory를 UncleCode memory의 중심으로 삼으면 안 된다. 이는 CRP보다 약하다.

차용 판단: 호환성만 채택. UncleCode의 context selector와 pinned skills가 우선이다.

### 3.11 LLM abstraction과 profiles

OpenHands LLM docs는 LiteLLM 기반 다중 provider, retries, telemetry/cost, Responses API, env/JSON config, secret redaction을 설명한다. [LLM docs](https://docs.openhands.dev/sdk/arch/llm)

Agent Canvas settings에는 active conversation 중 LLM profile switch와 memory condenser setting도 있다. [LLM settings](https://docs.openhands.dev/openhands/usage/settings/llm-settings)

UncleCode 적용:

- UncleCode는 자체 provider package와 Rust/Node runtime을 이미 갖고 있다. LiteLLM을 core로 들여오면 stack이 흔들린다.
- profile concept, cost telemetry, redaction discipline은 참고할 만하다.
- model switch도 context packet에 "이 packet은 어떤 model/profile로 갈 것인가"를 표시하면 UncleCode만의 강점이 된다.

차용 판단: 개념 채택, implementation은 비채택.

### 3.12 Agent Canvas

Agent Canvas architecture 문서는 Canvas의 책임을 UI rendering, frontend state, API call translation, packaging으로 제한하고, action execution/sandbox/credential/automation backend는 비책임으로 둔다. [architecture.md](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/docs/architecture.md)

`agent-canvas`는 Node 22+, React 19, React Router 7, generated TypeScript clients, multiple library exports, CLI launcher를 가진다. [package.json](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/package.json)

Launcher는 local backend/automation/frontend를 한 번에 띄우고, local API key를 frontend에 주입하거나 `--public`에서는 주입하지 않게 한다. [bin/agent-canvas.mjs](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/bin/agent-canvas.mjs)

UncleCode 적용:

- web control center를 만들 때 backend registry, local/cloud split, auth header split은 좋다.
- 지금 UncleCode의 차별화는 TUI 안의 context inspector와 next-call packet이다. Canvas 전체 복제는 제품 초점을 흐린다.
- React 소스는 `useEffect`를 settings/route initialization에 많이 쓴다. UncleCode의 React Effect Discipline을 적용한다면 그대로 베끼면 안 된다.

차용 판단: UI 전체는 비채택. backend registry와 packaging pattern만 later.

### 3.13 Backend registry와 active backend store

Canvas backend registry는 local/cloud backend, host, api key를 localStorage에 보관하고 launcher-provided local backend를 seed/sync한다. [storage.ts](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/backend-registry/storage.ts)

`active-store.ts`는 no-backend sentinel, fallback, active backend snapshot/subscription을 제공한다. [active-store.ts](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/backend-registry/active-store.ts)

Auth는 local이면 `X-Session-API-Key`, cloud면 bearer token을 쓴다. [auth.ts](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/backend-registry/auth.ts)

UncleCode 적용:

- UncleCode가 local daemon, remote daemon, cloud runner를 모두 다루게 되면 거의 그대로 필요한 모델이다.
- active backend도 context source가 되어야 한다. "현재 packet은 어느 backend/runtime으로 갈 것인가"를 사용자가 볼 수 있어야 한다.

차용 판단: later 채택.

### 3.14 ACP agents

OpenHands Canvas는 ACP-compatible external agents를 JSON-RPC stdio로 붙인다. Claude Code, Codex, Gemini CLI auth probing도 제공한다. [ACP docs](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents), [acp-service.api.ts](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/acp-service/acp-service.api.ts)

UncleCode 적용:

- UncleCode가 다른 에이전트를 호출하는 control plane이 되려면 ACP adapter는 가치가 있다.
- 하지만 UncleCode core는 다른 agent runner가 아니라 context-native coding assistant여야 한다.
- ACP agent 결과도 CRP source로 들어와야 하며, raw transcript는 heldBack, summary/evidence만 included가 기본이어야 한다.

차용 판단: 조건부 채택. interoperability layer로만 둔다.

### 3.15 Automations

OpenHands docs는 PR review, repo monitor, Slack channel monitor 같은 prebuilt automations를 설명한다. [prebuilt automations](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations)

Canvas automation service API는 list/get/update/delete/dispatch/list runs/toggle/download/health를 local sidecar 또는 cloud proxy로 호출한다. [automation-service.api.ts](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/automation-service/automation-service.api.ts)

UncleCode 적용:

- automation은 UncleCode context memory와 결합할 때 강하다. 예: "PR review automation이 어떤 runbook, memory, context source를 썼는지" inspector에서 보여주기.
- 단순 automation list/toggle UI는 OpenHands의 영역이고, 차별화가 약하다.

차용 판단: later. context-aware automation으로 재해석해야 한다.

## 4. 차용 후보 판정표

| OpenHands 구성요소 | UncleCode 적합도 | 판정 | UncleCode식 적용 |
| --- | --- | --- | --- |
| ToolDefinition / Action / Observation schema | 매우 높음 | 채택 | ACI/tool registry에 typed action/observation, validation, LLM output policy 추가 |
| ToolAnnotations risk hints | 높음 | 채택 | destructive/readOnly/idempotent/openWorld를 permission, `/context`, trace에 표시 |
| DeclaredResources + ParallelToolExecutor | 매우 높음 | 채택 | file/resource별 tool lock으로 병렬 tool call 안정화 |
| Secure atomic JSON/file lock | 매우 높음 | 채택 | `.unclecode`, AgentOps, settings/secrets store에 적용 |
| SecurityRisk + confirmation policy | 높음 | 채택 | yolo/default/approval policy를 risk level로 설명 |
| EventLog append-only + active branch | 높음 | 변형 채택 | CRP provenance/evidence source로 편입. prompt owner로 두지 않음 |
| Conversation status model | 중간 | 변형 채택 | TUI/daemon 상태: paused, waiting confirmation, stuck, finished |
| LLMSummarizingCondenser | 높음 | 변형 채택 | CRP `condensed-history` provider. selector가 최종 포함 결정 |
| PipelineCondenser | 중간 | 변형 채택 | summary, masking, recent-window를 provider chain으로 구성 |
| AgentSkills metadata/resources/triggers | 높음 | 호환 채택 | skills catalog parser 확장. full injection은 pinned/explicit only |
| `.cursorrules`, `agents.md`, `claude.md`, `gemini.md` compatibility | 높음 | 채택 | bootstrap source discovery 강화 |
| MCP/plugin bundles | 중간 | 변형 채택 | raw tool schema dump 금지. CRP source/provider로 요약 등록 |
| Workspace abstraction local/docker/remote | 중간 | later | runtime-broker 설계 때 도입 |
| Agent Server HTTP/WebSocket boundary | 중간 | later | long-running remote/team 작업 때만 |
| Conversation worktree per task | 높음 | later | parallel background work isolation에 사용 |
| Backend registry local/cloud | 중간 | later | web/control-center를 만들 때 |
| ACP adapter | 중간 | 조건부 | interoperability adapter. UncleCode core로 격상 금지 |
| Automations list/toggle/run/health | 중간 | later | context-aware automation으로 재설계 |
| Agent Canvas web UI 전체 | 낮음 | 비채택 | TUI context inspector가 우선. UI 패턴만 참고 |
| LiteLLM provider layer | 낮음 | 비채택 | UncleCode provider stack 유지. profile/cost idea만 참고 |
| OpenHands repo memory/microagents를 중심 memory로 사용 | 낮음 | 비채택 | CRP/AgentOps가 상위. markdown memory는 input source only |

## 5. Context management 중심 통합 설계

### 5.1 OpenHands condenser는 하위 provider가 되어야 한다

OpenHands의 condenser는 대화 history 압축에 강하다. 하지만 UncleCode가 원하는 것은 history 압축만이 아니다. UncleCode의 질문은 매 턴마다 다음과 같다.

- 어떤 source가 다음 model call에 들어가는가.
- 왜 들어가는가.
- 어떤 source가 held back 되었는가.
- 사용자가 pin/forget/include로 조작할 수 있는가.
- source가 stale, compressed, large, secret-risk, low-salience인지 알 수 있는가.

따라서 OpenHands식 condenser를 그대로 prompt pipeline에 넣지 말고, 다음 형태로 CRP provider를 만든다.

```ts
type CondensedHistorySource = {
  id: string;
  kind: "condensed-history";
  sourceEventIds: string[];
  content: string;
  summary: string;
  salience: number;
  includedInModel: boolean;
  reason: string;
  compression: {
    method: "llm-summary" | "recent-window" | "masking";
    inputTokensEstimate: number;
    outputTokensEstimate: number;
    model?: string;
  };
};
```

이 source는 `context_sources`에 들어가고, `ContextSelector`가 포함 여부를 결정한다. `/context` inspector는 "history compressed by LLM summary, 41 events summarized, 9 recent events kept" 같은 식으로 보여준다.

### 5.2 EventLog는 "기억"이 아니라 "증거 원장"이다

OpenHands EventLog는 강력하지만, 그것만으로는 UncleCode의 독자적인 context management가 되지 않는다. EventLog는 모든 일이 일어난 순서를 저장하고, CRP는 그 중 어떤 의미 단위가 다음 call에 들어갈지 선택한다.

권장 mapping:

| OpenHands object | UncleCode mapping |
| --- | --- |
| EventLog | AgentOps/session evidence ledger |
| active branch | context source provenance branch |
| Condensation event | `condensed-history` source row |
| Action/Observation | tool evidence source or trace source |
| Skill invoked | skill source salience update |
| Confirmation status | risk/context inspector badge |

### 5.3 Tool/resource metadata도 context다

OpenHands의 declared resource lock은 단순 concurrency 기능을 넘어 context 품질에도 연결된다. 예를 들어 file edit tool이 `file:packages/context-broker/src/context-bootstrap.ts`를 선언하면 UncleCode는 다음을 할 수 있다.

- 해당 file source의 freshness를 invalidate한다.
- `/context`에서 "included file summary is stale after edit" 경고를 낸다.
- 같은 파일을 만지는 병렬 tool call을 serialize한다.
- tool result raw output을 heldBack에 두고 요약만 included로 올린다.

즉 tool system 포팅은 context management 강화로 바로 이어진다.

### 5.4 Skill/plugin 호환성은 catalog로만 흡수한다

OpenHands AgentSkills, plugins, `.cursorrules`, `agents.md` compatibility는 UncleCode bootstrap을 넓히는 데 좋다. 하지만 full body를 매 턴 prompt에 넣으면 UncleCode의 packet inspectability가 약해진다.

권장 규칙:

- 모든 skill/plugin은 먼저 `kind=skill`, `kind=plugin`, `kind=workspace-guidance` source record로 들어간다.
- `trigger`가 맞아도 default는 summary/catalog만 included다.
- full body는 pinned skill, explicit command, high-salience selector decision일 때만 included다.
- references/assets/scripts는 별도 resource로 catalog에 남기고, 필요할 때 load한다.

### 5.5 Automations도 context-aware가 되어야 한다

OpenHands automation은 control surface로 좋다. UncleCode가 따라가야 할 차별점은 "automation이 context를 어떻게 썼는지"다.

예:

- PR review automation run detail에 "사용된 runbook, memory, changed files, heldBack raw logs, risk policy"를 보여준다.
- automation별 context profile을 둔다. 예: PR review는 changed files + project rules + security runbook, repo monitor는 recent commits + historical issues.
- 자동화 결과가 memory에 무엇을 write했는지 inspector에서 확인하고 forget/include할 수 있다.

## 6. 권장 로드맵

### 구현 상태: 2026-07-07

Phase 1의 첫 조각으로 OpenHands식 `ToolAnnotations`, declared resource contract, metadata-driven provider dispatch grouping을 UncleCode에 반영했다.

- `@unclecode/contracts`에 `ToolMetadata`, `ToolAnnotations`, `ToolDeclaredResource`, risk/resource/observation enum을 추가했다.
- runtime ACI tool definitions(`list_files`, `read_file`, `write_file`, `delete_file`, `search_text`, `run_shell`)이 risk hint, resource template, observation visibility를 선언한다.
- team mini-loop default tools(`run_shell`, `read_file`, `write_file`, `search_text`, `list_files`, `apply_patch`)도 같은 metadata surface를 갖는다.
- Rust team mini-loop default tool JSON에도 동일 metadata를 실어 TypeScript/Rust 기본 tool schema drift를 막았다.
- provider tool loop는 한 응답에 여러 tool call이 들어왔을 때 declared resource가 충돌하지 않는 tool을 같은 그룹에서 병렬 실행한다.
- `run_shell`, `apply_patch`, metadata 없는 tool처럼 resource를 정적으로 알 수 없는 opaque tool은 보수적으로 단독 그룹으로 실행한다.
- `/tools` surface는 각 tool의 risk level과 resource template을 함께 표시한다. 예: `read_file`은 `risk low · resources read file:{path}`, `run_shell`은 `risk unknown · resources execute shell:* (opaque)`.
- `.unclecode/todos` quick-tool persistence는 session id를 안전한 filename으로 변환하고 temp-file write 후 rename하는 atomic write path를 사용한다. traversal-shaped session id가 `.unclecode/todos` 밖으로 나가지 않는 테스트를 추가했다.
- `@unclecode/policy-engine`은 `resolveToolConfirmationDecision`을 export한다. 기본 `risky` policy는 low-risk read-only tool은 allow, high/unknown/destructive/open-world/missing-metadata tool은 prompt로 판정한다. `always`/`never` policy도 계약으로 고정했다.
- Phase 3의 첫 조각으로 `@unclecode/contracts`에 `SkillResourceMetadata`와 `script`/`reference`/`asset` kind를 추가했다. context-broker skill discovery는 `SKILL.md` 옆 `scripts/`, `references/`, `assets/` 파일을 resource catalog로 스캔한다.
- bootstrap skill source record는 skill 본문이나 reference를 무작정 prompt에 주입하지 않고, resource 개수와 byte 합을 summary/hash/bytes에 반영한다. 예: `resources: scripts 1, references 1, assets 1`.
- `ContextPacketViewItem`에 human-visible badge contract를 추가했다. context packet preview와 `/context` inspector-facing preview text는 `[catalog]`, `[resources]`, `[held raw]`, `[metadata only]` 같은 source badge를 보여주지만, provider-bound prompt prefix에는 badge text를 넣지 않는다.
- bootstrap packet supplement는 manifest/model-ready/catalog/resources/metadata-only/held-raw badge를 붙여, skill과 MCP 같은 OpenHands식 ecosystem source가 왜 model-ready인지 또는 held-back인지 사람 쪽 surface에서 보이게 한다.
- `ToolDeclaredResource`에는 serializable resolver id를 추가했고, `apply-patch-files` resolver가 `*** Add/Update/Delete File:`와 `*** Move to:` patch header에서 파일 resource key를 추출한다. provider scheduler는 같은 파일 patch/read를 직렬화하고 서로 다른 파일 patch는 병렬 실행할 수 있다.
- team mini-loop의 `apply_patch` metadata와 Rust default tool JSON은 이제 opaque `patch:*`가 아니라 `file:<patch files>` + `apply-patch-files` resolver를 선언한다.
- `context_sources` schema v4는 redacted badge JSON을 저장한다. runtime CRP provider는 work-shell trace line에서 tool/risk/resource 신호를 badge로 추출하고, selector는 trust/freshness/rank/hash badge 뒤에 저장 badge를 병합한다. 따라서 `/context`/packet row에서 최근 tool action이 `risk high`, `resource write` 같은 맥락으로 보인다.
- Phase 2의 첫 실제 조각으로 `condensed-history` source kind와 `createCondensedHistoryProvider`를 추가했다. work-shell CRP runtime은 trace line을 `runtime` provider와 `condensed-history` provider 양쪽에 공급한다.
- condensed history provider는 최근 8개 trace line은 runtime row로 남기고, 그보다 앞선 trace history를 `recent-window` 방식의 compressed row 하나로 요약한다. 이 row는 `compressed`, `recent-window`, `events N` badge를 갖고, provider-bound prompt에는 선택된 요약 content만 들어간다.
- `context_sources` schema v5는 redacted `metadata_json`을 저장한다. `condensed-history` metadata는 `sourceEventIds`, `summary`, `recomputeReason`, compacted/recent event count, compression method, input/output token estimate, optional model field를 갖는다.
- `ContextPacketViewItem`도 같은 metadata를 들고 간다. 따라서 `/context`와 packet projection은 이 row가 어떤 trace들을 얼마나 압축했는지 알 수 있지만, 최종 included/heldBack 결정은 여전히 `ContextSelector`가 한다.
- `/context` inspector의 expanded row와 workbench Preview lane은 `condensed-history` metadata를 사람이 읽을 수 있는 detail line으로 펼친다. 현재 노출되는 값은 compression method/model, compacted/recent count, input/output token estimate, summary, recompute reason, provenance trace-id sample이다.
- `condensed-history` row가 CRP freshness 기준으로 stale/expired가 되면 packet warning과 expanded row warning이 동시에 뜬다. warning message는 provider-bound prompt에는 raw detail을 싣지 않고, `/context`에서 refresh 필요성을 사람이 볼 수 있게 한다.
- `condensed-history` metadata는 compacted trace의 bounded raw preview도 저장한다. 이 raw preview는 redacted metadata로 보관되고 `/context` expanded row에서만 펼쳐져, summary가 무엇을 접었는지 사람이 확인할 수 있다.

이 단계는 이제 tool action risk/resource를 `/context` row badge로 연결하고, 긴 trace history를 CRP source ledger 안의 compressed row로 다룬다. 아직 shell command를 실제 파일/네트워크/process resource로 정밀 파싱하거나, 모든 `.unclecode`/AgentOps write path를 file-lock 기반으로 통일하는 단계까지 완성한 것은 아니다. Phase 2도 아직 LLM summary condenser, pipeline/masking condenser, append-only event log 기반 provenance까지 끝난 것은 아니다. 대신 compressed row의 summary/metadata expand, stale summary warning, bounded raw preview expand는 완료되어 `/context`에서 어떤 trace가 얼마나 압축됐고 refresh가 필요한지 확인할 수 있다. Phase 3도 아직 triggers salience, plugin bundle MCP/hooks/commands catalog까지 끝난 것은 아니다. 대신 "어떤 tool이 어떤 resource를 읽고/쓰고/삭제/실행하는가", "opaque shell처럼 정적 선언이 불가능한 tool은 무엇인가", "어떤 observation을 model에 full로 보여줄지 summary로 둘지", "skill 주변에 어떤 scripts/references/assets가 있는가", "어떤 source가 catalog/held raw/model-ready/metadata-only인가", "최근 tool action이 어떤 risk/resource badge를 가졌는가", "어떤 trace history가 compressed row로 압축됐는가"가 코드에서 조회 가능하고 provider dispatch, `/tools` surface, confirmation-policy helper, bootstrap source summary, human `/context` preview text와 packet row metadata에 실제 반영된다. 또한 quick-tool todo persistence는 contained filename과 atomic rename으로 hardened 되었다.

### Phase 1: dependency 없이 바로 가져올 수 있는 primitives

목표: UncleCode의 context management를 더 안전하고 빠르게 만든다.

작업:

- ACI/tool registry에 `ToolAnnotations`와 `DeclaredResources` 개념 추가.
- file/shell/context mutation tools에 resource key 선언.
- tool call scheduler에 resource lock 도입.
- `.unclecode`/AgentOps JSON write 경로에 atomic write, file lock, filename validation audit.
- SecurityRisk enum과 confirmation policy를 Rust/Node contract로 정의.
- `/context` row에 risk, stale, compressed, source kind badge를 붙일 수 있는 contract 정리.

성공 기준:

- 같은 파일 편집 tool call은 직렬화되고 다른 파일 읽기는 병렬 가능하다.
- tool output raw/full/truncated가 context source로 추적된다.
- dangerous/unknown action은 confirmation policy로 설명된다.

### Phase 2: condenser를 CRP provider로 편입

목표: OpenHands의 condenser 장점을 UncleCode packet inspectability 아래에 둔다.

작업:

- `condensed-history` context source kind 추가.
- event/session history를 입력으로 받는 `context_compact` provider 구현.
- condensation output에 provenance event ids, model, input/output estimate, reason 저장.
- `/context` inspector에서 compressed row expand 제공.
- pin/forget/include가 condensed source에도 작동하게 한다.

성공 기준:

- 긴 세션에서 raw history를 줄여도 사용자가 무엇이 압축됐는지 볼 수 있다.
- summary가 stale해지면 경고가 뜬다.
- condenser가 prompt를 직접 결정하지 않는다.

### Phase 3: skills/plugins compatibility 확장

목표: OpenHands/AgentSkills ecosystem을 UncleCode bootstrap source로 흡수한다.

작업:

- `SKILL.md` resources: scripts/references/assets metadata scan.
- `.cursorrules`, `.cursor/rules`, `agents.md`, `claude.md`, `gemini.md` 호환 source mapping 정리.
- skill triggers를 salience hint로 변환하되, full injection은 selector가 결정.
- plugin bundle의 MCP servers/hooks/commands를 raw dump 없이 catalog source로 등록.

성공 기준:

- OpenHands/AgentSkills style repo가 UncleCode에서 context catalog로 보인다.
- `/context`에서 skill이 왜 included/heldBack인지 설명된다.

### Phase 4: runtime/control-center 확장

목표: OpenHands의 runtime/Canvas 장점을 UncleCode 확장면으로만 도입한다.

작업:

- WorkspaceProvider interface: local first, remote/docker later.
- conversation worktree isolation for background jobs.
- backend registry: local daemon/cloud runner 구분.
- ACP adapter: Codex/Claude/Gemini/OpenHands를 external agent로 호출 가능하게 하되 결과를 CRP source로 수집.
- automation API: health/list/run/toggle/detail, but run detail에 context packet provenance 포함.

성공 기준:

- UncleCode가 다른 agent를 제어할 수 있어도 핵심 UI는 "이 agent/result가 어떤 context를 썼는가"를 보여준다.

## 7. 리스크와 반론

### 리스크 1: OpenHands 코드 이동 중

OpenHands README와 source 구조상 main repo는 transition 중이다. 문서도 `context/skills`와 `sdk/skills` 위치가 섞여 보이는 흔적이 있다. 직접 vendor copy는 위험하다. SHA-pinned source를 근거로 설계만 가져오는 편이 낫다.

### 리스크 2: stack mismatch

OpenHands SDK는 Python 중심이고 Canvas는 React/TypeScript web app이다. UncleCode는 Node.js + Rust monorepo다. LiteLLM, Python Agent Server, Docker workspace를 core에 넣으면 build/test/runtime 복잡도가 크게 증가한다.

### 리스크 3: condenser hallucination

LLM summary condenser는 정보 손실과 왜곡 위험이 있다. UncleCode가 이를 채택한다면 summary를 "압축된 source"로 표시하고, raw event ids와 expand path를 유지해야 한다.

### 리스크 4: UI 방향 혼선

OpenHands Agent Canvas는 훌륭한 web control center지만, UncleCode의 현재 차별점은 TUI에서 next-call packet을 보이고 조작하는 것이다. Canvas를 따라가면 "또 하나의 web agent dashboard"가 될 수 있다.

### 리스크 5: MCP/plugin raw dump

OpenHands plugin/MCP support는 범용성에 강하다. 하지만 UncleCode CRP 문서가 지적하듯 MCP schema를 그대로 context에 밀어 넣으면 context 품질이 떨어진다. 반드시 catalog, salience, on-demand load를 거쳐야 한다.

## 8. 최종 권고

UncleCode가 OpenHands에서 배워야 할 것은 "agent control center" 자체가 아니라, 그 control center를 가능하게 하는 경계와 contract다.

우선순위는 다음이다.

1. Tool contract: typed action/observation, risk hints, declared resources.
2. Safe execution: resource locking, atomic persistence, confirmation policy.
3. Context compression: OpenHands condenser를 CRP provider로 편입.
4. Context provenance: event log/branching을 source evidence로 편입.
5. Ecosystem ingestion: AgentSkills/plugins/ACP를 catalog source로 흡수.
6. Runtime expansion: workspace/Agent Server/Canvas/automation은 context-native control plane이 준비된 뒤 도입.

한 줄로 정리하면:

> OpenHands의 실행/도구/런타임 뼈대는 차용하되, 기억과 판단의 중심은 UncleCode의 CRP, `/context`, next model-call packet에 남겨야 한다.

## 9. Source index

### OpenHands main

- [OpenHands README at `cc80397`](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/README.md)
- [OpenHands pyproject at `cc80397`](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/pyproject.toml)
- [OpenHands config template at `cc80397`](https://github.com/OpenHands/OpenHands/blob/cc80397ecdbb646be4d6578034a36ec399faa92e/config.template.toml)

### OpenHands SDK

- [SDK README at `91f8b94`](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/README.md)
- [Agent base](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/agent/base.py)
- [Agent action batch](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/agent/agent.py)
- [Parallel tool executor](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/agent/parallel_executor.py)
- [Tool definitions](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/tool/tool.py)
- [File editor tool](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-tools/openhands/tools/file_editor/definition.py)
- [Terminal tool](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-tools/openhands/tools/terminal/definition.py)
- [Condenser base](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/context/condenser/base.py)
- [LLM summarizing condenser](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py)
- [View model](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/context/view/view.py)
- [Event log](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/conversation/event_store.py)
- [Conversation state](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/conversation/state.py)
- [Workspace base](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/workspace/base.py)
- [Docker workspace](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-workspace/openhands/workspace/docker/workspace.py)
- [Remote API workspace](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-workspace/openhands/workspace/remote_api/workspace.py)
- [Agent Server API](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-agent-server/openhands/agent_server/api.py)
- [Conversation service](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-agent-server/openhands/agent_server/conversation_service.py)
- [Agent Server persistence store](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-agent-server/openhands/agent_server/persistence/store.py)
- [Security analyzer](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/security/analyzer.py)
- [Skills](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/skills/skill.py)
- [Installed skills](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/skills/installed.py)

### Agent Canvas

- [Agent Canvas README at `3fc9828`](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/README.md)
- [Agent Canvas architecture](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/docs/architecture.md)
- [Canvas launcher](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/bin/agent-canvas.mjs)
- [Backend registry storage](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/backend-registry/storage.ts)
- [Active backend store](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/backend-registry/active-store.ts)
- [Backend auth](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/backend-registry/auth.ts)
- [ACP service](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/acp-service/acp-service.api.ts)
- [Automation service](https://github.com/OpenHands/agent-canvas/blob/3fc98289e3b7bd15d2e2aaeba05c4f9dd99aace3/src/api/automation-service/automation-service.api.ts)

### Official docs

- [SDK architecture overview](https://docs.openhands.dev/sdk/arch/overview)
- [SDK design principles](https://docs.openhands.dev/sdk/arch/design)
- [Event system](https://docs.openhands.dev/sdk/arch/events)
- [Context condenser](https://docs.openhands.dev/sdk/arch/condenser)
- [Context condenser guide](https://docs.openhands.dev/sdk/guides/context-condenser)
- [Conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)
- [Workspace architecture](https://docs.openhands.dev/sdk/arch/workspace)
- [Tool system](https://docs.openhands.dev/sdk/arch/tool-system)
- [Agent Server architecture](https://docs.openhands.dev/sdk/arch/agent-server)
- [Skill architecture](https://docs.openhands.dev/sdk/arch/skill)
- [Plugin guide](https://docs.openhands.dev/sdk/guides/plugins)
- [Security architecture](https://docs.openhands.dev/sdk/arch/security)
- [LLM architecture](https://docs.openhands.dev/sdk/arch/llm)
- [Agent Canvas overview](https://docs.openhands.dev/openhands/usage/agent-canvas/overview)
- [ACP agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents)
- [Prebuilt automations](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations)
- [LLM settings](https://docs.openhands.dev/openhands/usage/settings/llm-settings)
