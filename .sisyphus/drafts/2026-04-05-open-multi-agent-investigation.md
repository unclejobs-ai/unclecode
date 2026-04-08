# Open Multi-Agent Investigation

- Target repo: `https://github.com/JackChen-me/open-multi-agent`
- Local clone: `/tmp/open-multi-agent`
- Commit reviewed: `d59898ce3da004ea2f2ea28e6c431e3acce97028`
- Package version reviewed: `@jackchen_me/open-multi-agent@1.0.1`
- Investigation mode: parallel analysis lanes over docs/API/orchestrator/runtime/observability/tests

## Executive summary
Open Multi-Agent is a **small, focused TypeScript multi-agent SDK** with strong ergonomics around:
- auto-decomposition (`runTeam()`)
- explicit DAG execution (`runTasks()`)
- light shared-memory/message-bus primitives
- concurrency controls
- trace callbacks
- examples-first onboarding

It is **not** a direct product-shape match for UncleCode.
It explicitly declines several areas that UncleCode treats as core:
- durable persistence / checkpointing
- MCP integration
- UI/dashboard surface
- long-lived resumable workflows

### Bottom line
- **Good reference for:** orchestration ergonomics, trace API design, small-core discipline, examples, lightweight scheduler/runtime patterns.
- **Bad reference for:** session durability, resume/fork, MCP governance, product CLI surfaces, work-shell/TUI identity, install/setup/doctor operations.

## What the project actually is
From `README.md` and `src/index.ts`, the product centers on three entrypoints:
- `runAgent()` — single-agent one-shot
- `runTasks()` — explicit pipeline / DAG
- `runTeam()` — coordinator decomposes a goal into tasks, executes, synthesizes result

Public API is intentionally compact and centered on:
- `OpenMultiAgent`
- `Agent`
- `Team`
- `TaskQueue`
- `MessageBus`
- `SharedMemory`
- `AgentPool` / `Semaphore`
- `defineTool()` / `ToolExecutor`
- `createAdapter()`

This is a **framework/SDK** posture, not a local product shell posture.

## Explicit non-goals
`DECISIONS.md` is unusually valuable because it makes scope boundaries explicit.

The project intentionally says **no** to:
1. agent handoffs
2. persistence / checkpointing
3. A2A protocol
4. MCP integration
5. dashboard / visualization

This is strategically coherent for them.
It also means any direct architectural borrowing into UncleCode must be selective.

## Lane A — Surface / API / docs / examples audit
### Strengths
- README is clear, compact, and concrete.
- The “three ways to run” framing is excellent.
- Examples are numerous and productively named.
- Public API is legible enough to understand in one read.
- Architecture diagram is simple and honest.
- Non-goals are documented instead of hand-waved.

### Weaknesses
- The framework assumes users are willing to trust coordinator decomposition quality.
- Documentation is SDK-consumer oriented, not operator/product-user oriented.
- There is no serious operational guidance for long-lived runs because that is not the target.
- No install/setup/doctor equivalent surface.

### UncleCode takeaway
UncleCode should steal their:
- concise “three modes / three entrypoints” explanation pattern
- examples-first onboarding strategy
- explicit non-goals / won't-do documentation style

## Lane B — Orchestrator / task graph / scheduler audit
### Findings
`src/orchestrator/orchestrator.ts` uses a simple but effective shape:
- create coordinator
- decompose goal into JSON task specs
- build `TaskQueue`
- auto-assign via `Scheduler`
- dispatch pending tasks in parallel via `AgentPool`
- collect results
- synthesize via coordinator

`TaskQueue` is one of the strongest pieces:
- event-driven lifecycle
- dependency unblocking
- cascade failure
- skip / skipRemaining
- explicit terminal states

`Scheduler` supports:
- `round-robin`
- `least-busy`
- `capability-match`
- `dependency-first`

### Strengths
- Clean separation between queue, scheduler, pool, and agent runtime.
- Bounded concurrency is first-class.
- Dependency-first scheduling is a useful lightweight heuristic.
- Approval gate is inserted at batch boundaries instead of via ad-hoc interrupts.

### Weaknesses
- Coordinator decomposition depends on model JSON obedience.
- No durable event log or replay path.
- No policy-engine authority comparable to UncleCode’s intended governance model.
- No trust-zone or approval-intent semantics beyond the approval callback.
- Assignee matching is heuristic, mostly prompt/keyword based.

### UncleCode takeaway
Potentially worth adopting/adapting:
- explicit scheduler strategies as pluggable policy-free heuristics
- queue-level eventing and clearer batch-boundary approval logic
- cleaner decomposition of orchestrator vs queue vs pool responsibilities

Not safe to copy directly:
- model-generated task decomposition as the default high-trust planning authority
- approval model without stronger policy contracts

## Lane C — Agent runtime / tools / memory / approvals audit
### Agent runtime
`Agent` + `AgentRunner` are compact and good:
- lazy adapter creation
- persistent history for `prompt()`
- fresh history for `run()`
- optional structured output
- optional loop detection
- abort-signal wiring

### Tools
`ToolExecutor`:
- zod validation
- bounded batch execution via semaphore
- error isolation into structured tool results
- abort pre-checks

This is solid small-framework design.

### Memory
`SharedMemory` is intentionally simple:
- namespaced by agent
- in-memory only
- summary rendering for prompt injection

Useful, but dramatically shallower than UncleCode’s durable session/memory goals.

### Approvals
Approval is callback-driven after task batches.
This is simpler than UncleCode’s desired policy/intent/trust-zone model.
Good ergonomics; weaker governance.

### UncleCode takeaway
Adoptable ideas:
- optional loop-detection hooks in agent runtime
- clearer structured tool-result discipline
- semaphore-guarded batch tool execution patterns
- small shared scratch-memory primitives for ephemeral team coordination

Not enough for UncleCode by itself:
- durable recall
- resumable checkpoints
- secret-safe session persistence
- MCP capability governance

## Lane D — Providers / observability / test quality audit
### Providers
Factory supports:
- anthropic
- openai
- copilot
- gemini
- grok
- openai-compatible baseURL path for local models

The provider layer is pragmatic and lightweight.
UncleCode is more product-opinionated and auth-heavy.

### Observability
This is one of the most borrowable parts.
`onTrace` emits spans for:
- llm calls
- tool calls
- tasks
- agents

Design wins:
- optional callback means nearly zero surface cost when unused
- `runId` correlation
- per-span timing and token usage
- tests verify callback failures do not break execution

### Tests
Tests are broad and focused around behavior:
- orchestrator
- scheduler
- approval
- task retry
- trace
- shared memory
- tool executor
- loop detection

One caveat from this investigation session:
- `npm test` could not be run immediately in the cloned workspace because local deps were not installed (`vitest: command not found`)
- that is an environment issue, not a repo-quality verdict

### UncleCode takeaway
Very strong inspiration for:
- support/debug trace event shape
- making observability optional and cheap by default
- keeping failure of observer callbacks non-fatal

## Speed / responsiveness lessons for UncleCode
User requirement: UncleCode should feel fast like pi.
Open Multi-Agent gives several good reminders here.

### 1. Keep the hot path thin
Their public entrypoint is tiny and lazy.
UncleCode should keep default `unclecode` startup on the thinnest path possible.

### 2. Lazy-load expensive subsystems
They lazily create adapters.
UncleCode should do the same for:
- provider auth refresh work
- MCP startup
- heavy TUI secondary panels
- optional traces/profiling

### 3. Optional observability must be near-zero overhead
Their `onTrace` path is pay-for-play.
UncleCode should avoid expensive timing/trace assembly unless debug/support/profiling is requested.

### 4. Bound concurrency everywhere
They use `Semaphore` and `AgentPool` explicitly.
UncleCode should keep bounded workers, bounded tool concurrency, and bounded event rendering.

### 5. Don’t let durability poison first-response latency
This is where UncleCode must be careful.
Open Multi-Agent is fast partly because it avoids persistence.
UncleCode cannot remove persistence, but should:
- defer non-critical persistence work
- coalesce event writes when safe
- separate immediate UI response from slower archival work
- avoid full session-store scans on every interaction

### 6. Examples are part of perceived product speed
Good docs/examples reduce cognitive latency.
Open Multi-Agent is strong here.
UncleCode should improve examples and “how to start work fast” docs.

## Feature matrix — Open Multi-Agent vs UncleCode
| Area | Open Multi-Agent | UncleCode | Who is stronger? |
|---|---|---|---|
| Product shape | TS SDK/framework | local-first CLI/platform | Different categories |
| Goal→task auto-orchestration | strong | partial/bounded | OMA |
| Explicit task DAG | strong | partial | OMA |
| Scheduler strategies | present | limited surface | OMA |
| Shared memory | in-memory only | stronger durability direction | UncleCode |
| Session persistence/resume | explicitly out of scope | core requirement | UncleCode |
| MCP integration | explicitly out of scope | core direction | UncleCode |
| Policy governance | lightweight approval callback | stronger intended governance model | UncleCode intent |
| Setup/doctor/auth operations | absent | present | UncleCode |
| Product UX/TUI/work-shell | absent | present | UncleCode |
| Trace observability | strong, simple | improving | OMA currently cleaner |
| Example onboarding | strong | weaker currently | OMA |
| Release/provenance/cutover | not productized this way | present | UncleCode |

## What UncleCode should adopt
### Adopt now
1. **Trace callback model cleanup**
   - add a simple structured trace/event subscriber model
   - make it optional and cheap by default
2. **Examples-first docs pass**
   - work shell quickstart
   - research flow
   - session resume flow
   - auth/setup/doctor flow
3. **Sharper orchestrator boundaries**
   - separate queue / scheduler / pool responsibilities more explicitly
4. **Optional scheduler heuristics**
   - at least `dependency-first` and `least-busy` semantics for bounded workers
5. **Loop detection in work/research runtime**
   - especially repeated tool-call / repeated-output protection

### Adopt later
1. message-bus-style explicit agent communication primitives
2. shared scratch-memory for ephemeral worker coordination
3. more SDK-friendly public surfaces around orchestration

### Do not copy directly
1. no-persistence stance
2. no-MCP stance
3. approval callback as sole policy authority
4. coordinator-generated task graph as default high-trust control plane

## Concrete UncleCode TODOs triggered by this investigation
- [ ] Add a lightweight trace event contract for work/research/orchestrator/tool runs
- [ ] Add examples docs comparable to Open Multi-Agent’s example clarity
- [ ] Evaluate introducing scheduler strategies for bounded worker execution
- [ ] Add loop-detection guardrails for repeated tool/output cycles
- [ ] Ensure observability paths are optional and cheap on the hot path
- [ ] Audit startup path so work-first `unclecode` avoids loading non-critical surfaces early

## Final verdict
Open Multi-Agent is worth studying seriously, but **as a narrow orchestration-framework reference, not as a full UncleCode template**.

If UncleCode wants to feel fast like pi, the biggest lessons are not “become Open Multi-Agent.”
The lessons are:
- keep the hot path tiny
- load lazily
- make traces optional
- bound concurrency tightly
- document workflows clearly
- keep durable/platform-heavy features off the immediate interaction path
