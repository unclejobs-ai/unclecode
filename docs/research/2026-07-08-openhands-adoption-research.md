# OpenHands 차용 전수조사 보고서

작성일: 2026-07-08  
대상: UncleCode, OpenHands/OpenHands, OpenHands/software-agent-sdk, OpenHands/agent-canvas  
질문: OpenHands에 있는 것을 UncleCode에 차용하면 좋은가. 단, UncleCode의 독특한 context management가 메인이 되어야 한다.

## 0. 결론

차용하면 좋아지는 것은 분명하다. 다만 OpenHands 전체를 가져오는 것이 아니라, OpenHands가 잘 분리한 실행 계약과 운영 경계를 UncleCode의 next model-call packet 중심 구조 밑으로 흡수해야 한다.

OpenHands의 강점은 agent control center를 가능하게 하는 뼈대다. Agent/Agent Server, Agent Canvas, tool contract, declared resource locking, event log, condenser, workspace abstraction, automation/backend registry가 비교적 명확하게 나뉘어 있다. UncleCode가 그대로 복제하면 또 하나의 web agent dashboard가 된다. UncleCode가 이기려면 "무슨 agent를 띄웠나"보다 "다음 모델 호출에 무엇이 들어가고, 무엇이 빠지고, 왜 그런가"를 더 잘 보여줘야 한다.

추천은 네 단계다.

1. 바로 차용: typed tool/action/observation contract, tool risk hints, declared resources, conservative parallel execution, secure persistence patterns.
2. 변형 차용: event log와 condenser는 prompt owner가 아니라 UncleCode context packet의 evidence/source provider로 둔다.
3. 조건부 차용: workspace abstraction, Agent Server, backend registry, ACP adapter, automations UI는 remote/cloud/control-center가 필요해질 때만 도입한다.
4. 피해야 할 것: Agent Canvas UI 전체 복제, LiteLLM/Python SDK를 core provider stack으로 끌어오기, OpenHands markdown memory를 UncleCode memory의 중심으로 삼기.

한 줄로 줄이면:

> OpenHands의 실행/운영 contract는 빌리고, 기억과 판단의 중심은 UncleCode의 `/context`, `ContextPacketView`, next model-call packet에 남긴다.

## 1. 조사 범위와 근거

2026-07-08에 세 저장소를 shallow clone해서 HEAD를 확인했다.

| 저장소 | 조사한 HEAD |
| --- | --- |
| `OpenHands/OpenHands` | `2dc45f5e0d193c979def9d40ec6cbbc05e582e7e` |
| `OpenHands/software-agent-sdk` | `91f8b9403c16c30edee2f86cff634c38234c8a27` |
| `OpenHands/agent-canvas` | `847b0a8e9598a39f35eaec1c8701c3477dc2e6c9` |

주요 외부 근거:

- OpenHands main README: self-hosted developer control center, Agent Canvas transition, Agent/Agent Server source split. [README](https://github.com/OpenHands/OpenHands/blob/2dc45f5e0d193c979def9d40ec6cbbc05e582e7e/README.md)
- OpenHands config template: default condenser, runtime/sandbox, prompt-extension, history truncation controls. [config.template.toml](https://github.com/OpenHands/OpenHands/blob/2dc45f5e0d193c979def9d40ec6cbbc05e582e7e/config.template.toml)
- SDK source: agent base, event store, conversation state, condenser, tool contract, parallel executor, workspaces, persistence, skills. [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk/tree/91f8b9403c16c30edee2f86cff634c38234c8a27)
- Agent Canvas source: backend registry, ACP, automation surfaces, local/cloud routing. [agent-canvas](https://github.com/OpenHands/agent-canvas/tree/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9)

UncleCode 기준선은 현재 checkout의 source와 문서를 기준으로 삼았다.

- 핵심 제품 객체는 next model-call packet. [persistent-context-architecture.md](../design/persistent-context-architecture.md)
- bootstrap은 live read + partial classification에서 `.unclecode/context/bootstrap.json` manifest까지 구현되어 있고, malformed manifest reload는 crash 대신 무시한다. [context-bootstrap-pipeline.md](../design/context-bootstrap-pipeline.md)
- TUI PRD는 포함, 제외, 압축, stale, missing context를 정직하게 보여주는 `/context` 중심 UX를 요구한다. [context-management-optimized-tui-prd.md](../specs/2026-06-04-context-management-optimized-tui-prd.md)
- 현재 source의 authoritative path는 `ContextPacketView`, `context-packet-view.ts`, `work-runtime-bootstrap.ts`, bootstrap manifest, AgentOps `context_sources`, CRP providers/selectors, memory/OMO/guidance loaders다.

## 2. UncleCode에서 지켜야 할 중심축

| UncleCode 축 | 현재 상태 | OpenHands와의 차이 |
| --- | --- | --- |
| Next model-call packet | `ContextPacketView`가 included/excluded/warnings와 prompt prefix를 만든다. | OpenHands는 conversation/event/condenser view가 중심이다. |
| `/context` inspectability | packet preview와 compact overlay가 있다. | OpenHands Canvas는 control center 성격이 강하고, packet steering은 UncleCode가 더 강하게 가져갈 수 있다. |
| Repo-local context persistence | `.unclecode/context/bootstrap.json` manifest와 AgentOps `context_sources` store가 있다. malformed bootstrap reload와 source redaction도 검증했다. | OpenHands는 `.openhands`/server persistence가 강하지만, source inclusion 자체를 제품 객체로 세우지는 않는다. |
| Skills/guidance/memory | guidance, skills, memory, OMO가 흩어진 loader로 들어온다. | OpenHands는 AgentSkills/plugins compatibility가 넓다. UncleCode는 catalog + selective include가 필요하다. |
| Terminal-first UX | TUI가 primary surface다. | Agent Canvas web UI를 따라가면 차별점이 약해진다. |

따라서 차용 원칙은 이렇다.

1. 모든 외부 설계는 `ContextPacketView` source, excluded item, warning, preview 중 하나로 번역되어야 한다.
2. condenser나 event log가 prompt를 직접 장악하면 안 된다. 최종 조립권은 UncleCode packet builder에 둔다.
3. OpenHands의 backend/control-center surface는 나중 문제다. 지금은 context fidelity를 먼저 올린다.
4. Python/LiteLLM stack은 core에 넣지 않는다. 계약과 패턴만 가져온다.

## 3. OpenHands 전수조사

### 3.1 Main repo

OpenHands main repo는 이제 제품 런처와 Agent Canvas 관문에 가깝다. README는 "self-hosted developer control center"로 포지셔닝하고, OpenHands, Claude Code, Codex, Gemini, ACP-compatible agents를 local/remote/cloud backend에서 다룬다고 설명한다. 동시에 Agent/Agent Server source는 `software-agent-sdk`, Agent Canvas source는 `agent-canvas`로 이동 중이라고 안내한다.

차용 판단: 직접 vendor 대상이 아니다. 제품 포지션, deployment split, condenser/runtime config만 참고한다.

### 3.2 SDK agent model

`software-agent-sdk`의 `AgentBase`는 agent를 실행 상태와 분리된 configuration으로 둔다. LLM, tools, MCP config, default tools, agent context, condenser 같은 구성을 agent definition에 붙인다.

좋은 점:

- agent profile과 runtime state를 분리해 재현성과 persistence가 좋아진다.
- tool, MCP, condenser, identity hook을 한곳에서 구성한다.
- agent server와 local conversation이 같은 agent definition을 공유하기 쉽다.

UncleCode 적용:

- `mode/model/auth/tool policy/context policy`를 agent profile 성격의 config object로 분리하는 것은 가치가 있다.
- 단, `agent_context`를 단순 prompt appendix로 키우면 안 된다. UncleCode에서는 agent context도 packet source로 분류되어야 한다.

판정: 부분 채택.

### 3.3 Event log, conversation state, branching

SDK의 `EventLog`는 append-only event list, branch path, parent stamping, persistence를 제공한다. `ConversationState`는 status, confirmation, activated/invoked skills, leaf event, active branch를 가진다.

좋은 점:

- resume/audit이 강해진다.
- fork/branch된 conversation을 표현할 수 있다.
- waiting for confirmation, paused, stuck 같은 상태를 UI/control plane과 맞추기 좋다.

UncleCode 적용:

- EventLog를 context의 상위 진실로 두지 말고 evidence ledger로 둔다.
- `/context`에는 "이 packet이 어떤 event/branch까지 근거로 삼았는가"를 보여준다.
- active branch/fork metadata는 session-store나 AgentOps에 들어갈 수 있다.

판정: 변형 채택.

### 3.4 Context condenser

OpenHands condenser는 growing history를 줄이기 위한 interface다. `LLMSummarizingCondenser`, rolling/noop/view 계열이 있고, condensation result가 event/view에 반영된다. main config도 default LLM summarizing condenser와 history truncation을 설정 대상으로 둔다.

좋은 점:

- condenser가 interface로 분리되어 있다.
- token/size threshold, keep-first, LLM summary 같은 전략을 조합할 수 있다.
- condensation도 conversation state에 남길 수 있다.

UncleCode 적용:

- condenser output은 `condensed-history` 같은 packet source가 되어야 한다.
- source에는 summary, source event ids, compression method, input/output estimate, recompute reason, freshness가 있어야 한다.
- raw transcript는 default included가 아니라 held-back 또는 preview-on-demand가 맞다.

판정: 강한 변형 채택. UncleCode의 thesis는 "compress"보다 "select, explain, steer"다.

### 3.5 Tool contract와 parallel execution

SDK tool system은 `Action`, `Observation`, `ToolDefinition`, annotations, declared resources, tool executor를 분리한다. `DeclaredResources`는 unknown resource를 보수적으로 serialize하고, file editor 같은 tool은 `file:<path>` key를 선언한다. `ParallelToolExecutor`는 resource conflict가 없는 action을 병렬화할 수 있다.

좋은 점:

- 병렬 tool execution을 안전하게 늘릴 수 있다.
- read/write/destructive/open-world 같은 hint를 permission과 UI에 연결하기 쉽다.
- resource key는 context freshness에도 연결된다.

UncleCode 적용:

- ACI/local tools에 risk hint, observation visibility, declared resources를 붙인다.
- 같은 file/resource를 만지는 tool call은 직렬화하고, 서로 다른 read-only call은 병렬화한다.
- tool output raw/full/truncated 여부도 packet source나 warning으로 보여준다.

판정: 즉시 채택 후보 1순위.

### 3.6 Workspace/runtime abstraction

SDK는 local, Docker, remote API workspace를 분리한다. Docker workspace는 container agent server와 통신하고, remote API workspace는 API URL/key/session/resource policy를 가진다.

UncleCode 적용:

- 지금 UncleCode는 local TUI가 primary이므로 Docker/remote를 core에 넣을 필요는 없다.
- 하지만 team mode, background automation, cloud runner를 하려면 `WorkspaceProvider` style interface가 필요하다.
- workspace state도 packet source가 되어야 한다. branch, dirty files, sandbox mode, backend, env forwarding policy가 보이면 좋다.

판정: later 채택.

### 3.7 Agent Server와 worktree per conversation

Agent Server는 HTTP/WebSocket API 뒤에 agent runtime을 세우는 long-running boundary다. conversation별 worktree/branch 격리도 제공한다.

UncleCode 적용:

- long-running background task, remote/browser/desktop automation에는 service boundary가 좋다.
- 현재 Work Shell path에 바로 넣으면 복잡도가 크다.
- worktree per task는 parallel background work isolation에 유용하다.

판정: later.

### 3.8 Persistence와 secrets hygiene

OpenHands server persistence는 directory validation, secure directory mode, lock/atomic JSON write, encrypted settings/secrets store 같은 운영 패턴을 갖는다.

UncleCode 적용:

- `.unclecode/` write path와 AgentOps/session artifacts에 atomic write와 filename validation을 더 일관되게 적용한다.
- context packet source classification 단계에서 secret-shaped content는 raw withheld 또는 redacted preview가 되어야 한다.

판정: 즉시 채택.

### 3.9 Security risk와 confirmation policy

OpenHands는 low/medium/high/unknown risk와 confirmation policy를 갖고, analyzer failure를 보수적으로 다룬다.

UncleCode 적용:

- `default/yolo/ultrawork` mode와 tool permission을 risk level로 설명하면 `/context`와 transcript가 더 믿을 만해진다.
- unknown/destructive/open-world action은 prompt 또는 yolo policy로 명시해야 한다.

판정: 채택.

### 3.10 Skills, plugins, microagents

OpenHands skills는 `SKILL.md`, scripts, references, assets, triggers, MCP tools, AgentSkills format, legacy mapping을 다룬다. installed skills와 plugin marketplace 흐름도 있다.

UncleCode 적용:

- OpenHands/AgentSkills 호환성은 "catalog parser"로 흡수한다.
- full body를 매 turn prompt에 넣는 방식은 피한다.
- scripts/references/assets/triggers는 bootstrap manifest와 packet metadata로 들어가야 한다.

판정: 호환성만 채택.

### 3.11 Agent Canvas

Agent Canvas는 React/TypeScript web control center다. local/cloud backend registry, ACP agents, automation service, settings, launcher packaging을 가진다.

UncleCode 적용:

- backend registry와 active backend snapshot은 cloud/local daemon 단계에서 유용하다.
- ACP adapter는 interoperability layer로 좋다.
- 하지만 UI 전체 복제는 비채택이다. UncleCode primary UX는 TUI packet inspector다.

판정: UI는 비채택, backend/ACP patterns는 later.

## 4. 차용 후보 판정표

| OpenHands 구성요소 | UncleCode 적합도 | 판정 | UncleCode식 적용 |
| --- | --- | --- | --- |
| ToolDefinition / Action / Observation | 매우 높음 | 채택 | ACI/tool registry contract로 도입 |
| ToolAnnotations risk hints | 높음 | 채택 | permission, trace, `/context` row에 표시 |
| DeclaredResources | 매우 높음 | 채택 | file/resource lock, freshness invalidation |
| ParallelToolExecutor | 높음 | 채택 | conflict-free tool calls only parallel |
| Secure persistence | 매우 높음 | 채택 | `.unclecode`, AgentOps, session artifacts hardening |
| Security risk policy | 높음 | 채택 | mode/policy explanation surface |
| EventLog append-only | 높음 | 변형 채택 | packet provenance/evidence ledger |
| Active branch/fork | 중간 | 변형 채택 | session provenance and worktree isolation |
| LLMSummarizingCondenser | 높음 | 변형 채택 | `condensed-history` packet source |
| Rolling/noop/view condenser | 중간 | 변형 채택 | configurable packet source reducer |
| AgentSkills resources/triggers | 높음 | 호환 채택 | catalog + selective include |
| MCP/plugin bundles | 중간 | 변형 채택 | raw schema dump 금지, summary source로 등록 |
| Workspace local/docker/remote | 중간 | later | `WorkspaceProvider` when remote runner exists |
| Agent Server | 중간 | later | background/cloud tasks only |
| Backend registry | 중간 | later | daemon/cloud runner selector |
| ACP adapter | 중간 | 조건부 | external agent result as packet source |
| Automations | 중간 | later | context-aware automation detail |
| Agent Canvas full UI | 낮음 | 비채택 | TUI `/context`가 primary |
| LiteLLM provider layer | 낮음 | 비채택 | current provider stack 유지 |

## 5. UncleCode-first 통합 설계

### 5.1 OpenHands condenser는 packet source provider가 되어야 한다

OpenHands condenser는 history 압축에 강하다. UncleCode에서는 다음 질문에 답해야 한다.

- 어떤 source가 다음 model call에 들어가는가.
- 왜 들어가는가.
- 어떤 raw artifact가 held back 되었는가.
- summary가 stale하거나 secret-risk면 어떻게 보이는가.
- 사용자가 inspect/include/exclude/compress할 수 있는가.

따라서 condenser output은 prompt fragment가 아니라 packet source가 되어야 한다.

```ts
type CondensedHistoryPacketSource = {
  readonly id: string;
  readonly category: "runtime";
  readonly label: "Session history compact";
  readonly reason: string;
  readonly preview: string;
  readonly tokenEstimate: number;
  readonly metadata: {
    readonly compression: "llm-summary" | "rolling" | "masking" | "recent-window";
    readonly sourceEventIds: readonly string[];
    readonly recomputeReason: string;
    readonly stale: boolean;
  };
};
```

현재 checkout의 `ContextPacketViewItem`에는 metadata/action fields가 아직 없으므로, 첫 구현은 label/reason/preview/warning만으로 시작하고 나중에 contract를 확장하는 편이 안전하다.

### 5.2 EventLog는 기억이 아니라 증거 원장이다

EventLog는 모든 것을 넣는 prompt history가 아니라 packet provenance의 근거가 되어야 한다.

| OpenHands object | UncleCode mapping |
| --- | --- |
| EventLog | AgentOps/session evidence ledger |
| active branch | packet provenance branch |
| Condensation event | compressed runtime source |
| Action/Observation | tool trace source |
| Skill invoked | skill salience hint |
| Confirmation status | packet warning/risk badge |

### 5.3 Tool/resource metadata도 context다

Declared resource key는 concurrency만을 위한 정보가 아니다. 예를 들어 `file:packages/context-broker/src/context-packet-view.ts`를 write tool이 선언하면 UncleCode는 다음을 할 수 있다.

- 해당 file summary freshness를 stale로 표시한다.
- 같은 파일을 만지는 parallel write를 막는다.
- `/context`에 "included summary is stale after edit"를 표시한다.
- tool raw output은 held back, summary만 included로 둔다.

즉 tool contract 차용은 UncleCode의 context management를 직접 강화한다.

### 5.4 Skill/plugin compatibility는 catalog로 흡수한다

OpenHands-style skills/plugins는 다음 규칙을 따라야 한다.

- discovery 결과는 bootstrap manifest source로 남긴다.
- default included는 catalog summary다.
- full body는 pinned skill, explicit `/skill`, high-salience selector decision일 때만 들어간다.
- scripts/references/assets/MCP tools는 resource catalog로 보인다.

### 5.5 Automations도 context-aware가 되어야 한다

OpenHands automation list/toggle UI를 그대로 베끼는 것은 약하다. UncleCode식 automation은 run detail에 다음을 보여줘야 한다.

- 어떤 runbook과 memory가 쓰였는가.
- 어떤 changed files와 evidence가 packet에 들어갔는가.
- 어떤 raw logs가 held back 되었는가.
- 어떤 risk policy와 confirmation decision이 있었는가.

## 6. 현재 checkout 기준 로드맵

### Phase A: 연구 보고서 정본화

상태: 이 문서로 완료.

성공 기준:

- OpenHands main, SDK, Canvas의 current HEAD를 pin한다.
- UncleCode current source baseline을 과장하지 않는다.
- 차용/비채택/변형 채택 판정을 남긴다.

### Phase B: bootstrap manifest writer

상태: 구현됨. 이번 hardening slice에서 malformed `bootstrap.json` reload는 `undefined`로 처리해 context path crash를 막고, `test:context-broker`로 고정했다.

목표: `.unclecode/context/bootstrap.json`을 생성해 live context discovery를 audit 가능한 artifact로 만든다.

작업:

- source manifest writer는 현재 `context-bootstrap.ts`에 있다.
- source id, kind, path, sha256, bytes, included reason, warnings를 기록한다.
- 다음 보강은 atomic write와 stale/invalid manifest repair policy다.

성공 기준:

- broker helper가 manifest를 생성하고 packet supplement를 만든다.
- `/context` packet item에 bootstrap manifest stamp가 보인다.
- `npm run test:context-broker`가 manifest, malformed reload, packet supplement behavior를 고정한다.

### Phase C: packet warning completeness

목표: "silent empty context"를 없앤다.

작업:

- memory prefetch degraded/timeout을 `ContextPacketViewWarning`으로 올린다.
- MCP config summary를 packet included/excluded item으로 추가한다.
- extension manifest summary도 packet item으로 분리한다.

성공 기준:

- 사용자는 `/context`에서 memory/MCP/extensions가 왜 포함되거나 빠졌는지 본다.
- raw config secrets는 model prefix에 들어가지 않는다.

### Phase D: OpenHands-style tool contract

목표: tool execution과 context freshness를 같은 resource model로 묶는다.

작업:

- contract에 tool risk hints와 declared resource shape를 추가한다.
- file read/write/apply patch/search/shell tool에 conservative resource declaration을 붙인다.
- provider/tool scheduler는 unknown resource를 단독 실행으로 둔다.

성공 기준:

- 같은 파일 write는 직렬화된다.
- 서로 다른 safe read는 병렬화 가능하다.
- `/context` 또는 trace에서 risky/unknown/destructive tool state가 보인다.

### Phase E: condenser as packet source

목표: OpenHands condenser를 UncleCode packet source로 재해석한다.

작업:

- `runtime` 또는 `condensed-history` category를 contract에 추가할지 결정한다.
- recent-window summary부터 시작하고, LLM summary는 provider key가 있을 때만 optional.
- source event ids, recompute reason, stale state, preview path를 둔다.

성공 기준:

- 긴 session history가 raw dump로 model에 들어가지 않는다.
- summary가 stale하면 warning이 뜬다.
- raw trace는 held back 또는 inspector-only다.

### Phase F: skills/plugins compatibility

목표: OpenHands/AgentSkills ecosystem을 UncleCode bootstrap catalog로 흡수한다.

작업:

- `.cursor/rules`, `.cursorrules` adapter.
- `.cursor/skills`, AgentSkills-style scripts/references/assets metadata scan.
- plugin/MCP/hook command catalog source.

성공 기준:

- compatible repo를 열면 `/context`에서 skill/catalog source가 보인다.
- full body injection은 explicit/pinned path로만 일어난다.

## 7. 리스크

### 리스크 1: OpenHands source 이동 중

main repo 자체가 Agent Canvas transition을 안내한다. 직접 vendor copy는 위험하다. SHA-pinned source를 보고 contract만 가져오는 편이 안전하다.

### 리스크 2: stack mismatch

OpenHands SDK는 Python 중심이고 Agent Canvas는 React web app이다. UncleCode는 Node/Rust monorepo와 terminal UX가 중심이다. Python Agent Server나 LiteLLM을 core에 넣으면 UncleCode의 build/runtime 복잡도가 급증한다.

### 리스크 3: condenser hallucination

LLM summary는 정보 손실과 왜곡 위험이 있다. UncleCode는 summary를 "압축된 source"로 표시하고, raw evidence path와 stale warning을 유지해야 한다.

### 리스크 4: UI 방향 혼선

OpenHands Canvas를 따라가면 UncleCode가 web dashboard 경쟁으로 들어간다. 지금은 `/context`와 next-call packet을 더 밀어야 한다.

### 리스크 5: raw MCP/plugin dump

MCP schema와 plugin metadata를 그대로 prompt에 넣으면 context 품질이 떨어진다. 반드시 catalog, salience, on-demand load를 거친다.

## 8. 최종 권고

우선순위는 다음이다.

1. Packet warning completeness: memory/MCP/extensions/guidance의 inclusion/exclusion 이유를 더 정직하게 보여준다.
2. Tool contract: risk hints와 declared resources를 추가한다.
3. Condenser source: history compression을 packet source로 편입한다.
4. Event provenance: append-only evidence ledger를 packet provenance로 연결한다.
5. Skills/plugins compatibility: full injection이 아니라 catalog-first로 흡수한다.
6. Bootstrap manifest hardening: atomic write, stale/invalid repair policy, source diff receipt.
7. Runtime/control-center: workspace/Agent Server/Canvas/automation은 later.

UncleCode의 메인은 계속 하나다.

> 모델을 더 많이 부르는 제품이 아니라, 모델이 무엇을 보게 되는지 사용자가 통제할 수 있는 제품이어야 한다.

## 9. Source index

### OpenHands main

- [OpenHands README at `2dc45f5`](https://github.com/OpenHands/OpenHands/blob/2dc45f5e0d193c979def9d40ec6cbbc05e582e7e/README.md)
- [OpenHands config template at `2dc45f5`](https://github.com/OpenHands/OpenHands/blob/2dc45f5e0d193c979def9d40ec6cbbc05e582e7e/config.template.toml)
- [OpenHands pyproject at `2dc45f5`](https://github.com/OpenHands/OpenHands/blob/2dc45f5e0d193c979def9d40ec6cbbc05e582e7e/pyproject.toml)

### OpenHands SDK

- [SDK README at `91f8b94`](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/README.md)
- [Agent base](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/agent/base.py)
- [Event log](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/conversation/event_store.py)
- [Conversation state](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/conversation/state.py)
- [Condenser base](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/context/condenser/base.py)
- [LLM summarizing condenser tests](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/tests/sdk/context/condenser/test_llm_summarizing_condenser.py)
- [Tool contract](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/tool/tool.py)
- [Parallel executor](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/agent/parallel_executor.py)
- [File editor declared resources](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-tools/openhands/tools/file_editor/definition.py)
- [Workspace base](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/workspace/base.py)
- [Docker workspace](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-workspace/openhands/workspace/docker/workspace.py)
- [Remote API workspace](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-workspace/openhands/workspace/remote_api/workspace.py)
- [Persistence store](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-agent-server/openhands/agent_server/persistence/store.py)
- [Skills](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/skills/skill.py)
- [Installed skills](https://github.com/OpenHands/software-agent-sdk/blob/91f8b9403c16c30edee2f86cff634c38234c8a27/openhands-sdk/openhands/sdk/skills/installed.py)

### Agent Canvas

- [Agent Canvas README at `847b0a8`](https://github.com/OpenHands/agent-canvas/blob/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9/README.md)
- [Agent Canvas architecture](https://github.com/OpenHands/agent-canvas/blob/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9/docs/architecture.md)
- [Launcher](https://github.com/OpenHands/agent-canvas/blob/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9/bin/agent-canvas.mjs)
- [Automation dev launcher](https://github.com/OpenHands/agent-canvas/blob/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9/scripts/dev-with-automation.mjs)
- [Backend registry storage](https://github.com/OpenHands/agent-canvas/tree/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9/src/api/backend-registry)
- [ACP service tests](https://github.com/OpenHands/agent-canvas/blob/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9/__tests__/api/acp-service/acp-service.api.test.ts)
- [Automation service tests](https://github.com/OpenHands/agent-canvas/blob/847b0a8e9598a39f35eaec1c8701c3477dc2e6c9/__tests__/api/automation-service.test.ts)
