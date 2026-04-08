# Open Multi-Agent Competitive Investigation TODO

## Target
- Repo: `https://github.com/JackChen-me/open-multi-agent`
- Local clone: `/tmp/open-multi-agent`
- Pinned commit: `d59898ce3da004ea2f2ea28e6c431e3acce97028`
- Package: `@jackchen_me/open-multi-agent@1.0.1`

## Why this is on the list
This is a strong nearby reference for the **multi-agent orchestration SDK layer** that UncleCode may want to learn from or explicitly diverge from.

It is **not** the same product shape as UncleCode:
- Open Multi-Agent = lightweight TypeScript framework / SDK
- UncleCode = local-first OSS coding-agent CLI/platform with durable state, policy, MCP governance, auth surfaces, and work-first UX

That difference matters. We should compare subsystem-by-subsystem instead of treating it as a full product template.

## Initial readout
### Likely strengths worth studying
- `runTeam()` goal → task decomposition → dependency execution → synthesis flow
- lightweight TS-first API surface
- explicit `SharedMemory`, `MessageBus`, `TaskQueue`, `AgentPool`, `Semaphore`
- structured observability via trace callbacks
- built-in retry / approval / loop-detection features
- strong examples-driven onboarding and compact test surface
- explicit architecture non-goals in `DECISIONS.md`

### Clear non-goals / likely divergence from UncleCode
From `DECISIONS.md`, the project explicitly avoids:
- durable persistence / checkpointing
- MCP integration
- dashboard / visualization
- agent handoffs
- distributed A2A

That means it is a useful reference for orchestration ergonomics, but **not** for UncleCode's session durability, MCP-native governance, or work-shell/TUI product shape.

## Investigation tracks (agent-team split)
- [x] Track A — Surface/API/docs/examples audit
  - inspect README, examples, public API, onboarding, ergonomics
  - deliverable: concise API/UX strengths + weaknesses summary

- [x] Track B — Orchestrator/task graph/scheduler audit
  - inspect coordinator logic, task DAG execution, parallelism model, retry semantics, failure propagation
  - deliverable: comparison against UncleCode orchestrator and research-mode boundaries

- [x] Track C — Agent runtime/tooling/memory audit
  - inspect agent loop, tool execution, shared memory, approvals, loop detection, concurrency controls
  - deliverable: adopt / ignore / risky list for UncleCode

- [x] Track D — Provider/trace/test-quality audit
  - inspect provider abstraction, local-model path, observability hooks, test strategy, coverage claims
  - deliverable: evidence-backed confidence assessment and missing-hardening list

## Specific comparison questions for UncleCode
- [ ] Is `runTeam()`-style auto decomposition materially better than UncleCode's current bounded research/orchestrator entrypoints?
- [ ] Is their trace event model simpler/better than UncleCode's current support/debug surfaces?
- [ ] Can their task queue + dependency graph ideas improve UncleCode without weakening policy authority?
- [ ] Are their shared-memory/message-bus primitives worth adopting, or are they too SDK-centric for UncleCode's CLI-first architecture?
- [ ] Does their examples strategy outperform UncleCode's current product explainability/docs?
- [ ] Which ideas are good for UncleCode **only if adapted**, not copied verbatim?

## Must-capture outputs
- [ ] feature matrix: Open Multi-Agent vs UncleCode
- [ ] borrow list: adopt now / later / never
- [ ] architecture deltas: framework vs product platform
- [ ] risks: where Open Multi-Agent is stronger, weaker, or intentionally out-of-scope
- [ ] action list: concrete UncleCode follow-ups if any

## Fast initial hypotheses
- Open Multi-Agent is probably stronger in:
  - minimal SDK ergonomics
  - example clarity
  - trace-oriented instrumentation surface
  - compact orchestration abstraction

- UncleCode is probably stronger in:
  - durable session store / resume
  - operational CLI surfaces
  - auth/setup/doctor workflows
  - release/provenance/product surface
  - work-first coding-shell UX
  - MCP/client governance direction

- Open Multi-Agent is likely not a direct replacement reference for:
  - checkpointing / persistence
  - local CLI product identity
  - governed MCP host model
  - TUI/work-shell responsiveness design

## Immediate next step
1. Read `DECISIONS.md`, `README.md`, `src/index.ts`, selected examples, and targeted tests. ✅
2. Produce a subsystem comparison memo. ✅ (`.sisyphus/drafts/2026-04-05-open-multi-agent-investigation.md`)
3. Extract a concrete UncleCode TODO delta list, only if the comparison reveals real advantages. ✅
