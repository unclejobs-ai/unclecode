# Agent Console Control Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an UncleCode-native Agent Console with a bounded default HUD, accurate agent/job/statusline facts, and `Alt+A` inspect/steer/cancel/continuation controls for session-owned Work Shell executor agents.

**Architecture:** Extend the existing immutable `AgentConsoleSnapshot` and trace reducer; do not introduce a second worker registry, job manager, Todo store, or tool ledger. `WorkAgent` owns executor lifecycles through a focused run controller, `WorkShellEngine` adapts that runtime to the public control port and UI state, and the TUI renders the same snapshot as either a concise HUD or responsive console overlay.

**Tech Stack:** Node.js 22.22.x, TypeScript 5.9, React 19, Ink 6, Rust 2024 with Cargo 1.85+, Node test runner, existing Rust command router and UX helpers. No new dependency.

## Global Constraints

- Preserve all pre-existing dirty-worktree changes; never stage or revert unrelated hunks.
- Keep `AgentConsoleSnapshot` as the only session-scoped source for WorkGraph, tool activity, agents, jobs, and usage.
- Keep `unclecode team run` and `packages/tui/src/shell-state.ts` outside this feature.
- Keep the default conversation free of raw worker prompts, raw tool output, provider frames, internal routing JSON, and secrets.
- Keep exactly one animated spinner, owned by `WorkShellStatusBlock`.
- Default HUD limits: three WorkGraph rows and four active agent rows, with `+N` overflow.
- Agent states: `queued | running | waiting | completed | failed | cancelled | interrupted`.
- Job states: `queued | running | completed | failed | cancelled | interrupted`.
- Console breakpoint: two panes at 84 columns or wider; one pane with `Tab` switching below 84 columns.
- Control semantics: FIFO steer at the next provider-turn boundary, confirmed cancel, and continuation as a new linked run.
- Persist only bounded safe projections. Old snapshots decode with empty agent/job arrays; unrecoverable active state becomes interrupted on resume.
- Omit unknown context windows and costs. Never manufacture `$0.00` from missing pricing data.
- Git facts refresh outside render functions no more than once per second.
- Use existing CJK display-width helpers.
- Build package output before `npm run check` because `@unclecode/*` subpath exports resolve through `dist-work`/`dist`.
- Use Node `>=22.18.0 <26`; if needed prepend `$HOME/.nvm/versions/node/v22.22.2/bin` to `PATH`.
- Use Cargo `>=1.85`.
- Known unrelated failures remain out of scope: `tests/contracts/orchestrator-multi-agent.contract.test.mjs` naming and the environment-sensitive `tests/work/tools.test.mjs` cwd assertion.

---

### Task 1: Lifecycle, usage, and control contracts

**Files:**
- Modify: `packages/contracts/src/agent-console.ts:79-239,426-539`
- Modify: `packages/contracts/src/trace.ts:9-31,37-199,280-311`
- Modify: `tests/contracts/agent-console.contract.test.mjs`
- Modify: `tests/contracts/trace.contract.test.mjs`

**Interfaces:**
- Consumes: existing `AgentConsoleSnapshot`, `ToolActivity`, `WorkGraph`, `ExecutionTraceEvent`, and parser conventions.
- Produces: `AgentRunStatus`, `AgentRunUsage`, `AgentRun`, `AsyncJobStatus`, `AsyncJob`, `AgentControlReceipt`, `AgentControlPort`, `AgentConsoleTab`, lifecycle trace events, `UsageRecordedTraceEvent`, and `markUnrecoverableAgentConsoleWorkInterrupted(snapshot)`.

```ts
export type AgentRunUsage = {
  readonly eventIds: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly costUsd?: number;
};

export type AgentControlPort = {
  steer(agentRunId: string, message: string): Promise<AgentControlReceipt>;
  cancel(agentRunId: string): Promise<AgentControlReceipt>;
  continue(agentRunId: string, message?: string): Promise<AgentControlReceipt>;
};
```

- [ ] **Step 1: Write failing snapshot round-trip and resume tests**

Add a fixture with one running agent, one linked running job, scoped tool activity, and one main usage entry. Assert `parseAgentConsoleSnapshot` restores every safe field, strips an injected `rawPrompt`, and defaults missing `agents`/`jobs` to empty arrays for an old snapshot.

```js
const parsed = parseAgentConsoleSnapshot({
  profileId: "build",
  activity: [{
    id: "tool:1",
    toolCallId: "call-1",
    toolName: "read_file",
    kind: "read",
    intent: "Reading source",
    status: "running",
    startedAt: 10,
    agentRunId: "run-1",
  }],
  agents: [{
    id: "run-1",
    displayName: "ExecutionMap",
    agentType: "executor",
    status: "running",
    startedAt: 10,
    rawPrompt: "must disappear",
  }],
  jobs: [{
    id: "job-1",
    type: "work-node",
    label: "Map execution",
    status: "running",
    agentRunId: "run-1",
    queuedAt: 9,
    startedAt: 10,
  }],
  mainUsage: { eventIds: ["usage-main-1"], costUsd: 0.25 },
});
assert.equal(parsed?.agents[0]?.id, "run-1");
assert.equal("rawPrompt" in (parsed?.agents[0] ?? {}), false);
assert.equal(parsed?.activity[0]?.agentRunId, "run-1");
```

Call `markUnrecoverableAgentConsoleWorkInterrupted(parsed)` and assert active agents/jobs become `interrupted`, settled records stay unchanged, and the input object is not mutated.

- [ ] **Step 2: Run focused contract tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/agent-console.contract.test.mjs tests/contracts/trace.contract.test.mjs
```

Expected: FAIL because the new fields, statuses, events, and resume helper do not exist.

- [ ] **Step 3: Add required snapshot types and safe parsers**

Make `agents` and `jobs` required arrays on the runtime `AgentConsoleSnapshot`. Keep parser compatibility by treating absent persisted fields as `[]`. Add bounded parsing helpers that reconstruct only named fields, cap agents/jobs at 128 records each, cap usage event IDs at 256, and apply `boundToolActivityPreview` to tool previews. Add optional `agentRunId` to `ToolActivity`.

```ts
export type AgentConsoleSnapshot = {
  readonly profileId: ContextProfileId;
  readonly manifest?: PersistedPromptManifest;
  readonly pendingDecision?: AskUserQuestionRequest;
  readonly workGraph?: WorkGraph;
  readonly activity: readonly ToolActivity[];
  readonly agents: readonly AgentRun[];
  readonly jobs: readonly AsyncJob[];
  readonly mainUsage?: AgentRunUsage;
};
```

`createAgentConsoleSnapshot` must copy and bound every array rather than retaining caller references. `parseAgentConsoleSnapshot` must reject unknown statuses and malformed timestamps, but an absent legacy field is not malformed.

- [ ] **Step 4: Add lifecycle and usage trace events**

Add these exact `ExecutionTraceEvent` members and names:

```ts
"job.queued"
"job.settled"
"agent.run.started"
"agent.run.settled"
"usage.recorded"
```

`agent.run.started` carries `eventId`, `runId`, `jobId`, `displayName`, `agentType`, optional lineage, and `startedAt`. `agent.run.settled` carries `eventId`, `runId`, `jobId`, terminal status, timestamps, and bounded summary/error text. `usage.recorded` carries `eventId`, optional `agentRunId`, and optional positive token/cost counters. Add optional `agentRunId` and `asyncJobId` scoping to provider tool events without making it required for main-agent events.

- [ ] **Step 5: Implement interrupted-on-resume normalization**

Return the original snapshot when no active record changes. Otherwise create one new snapshot where agent `queued|running|waiting` and job `queued|running` states become `interrupted` with `completedAt` set to the supplied `now` argument.

```ts
export function markUnrecoverableAgentConsoleWorkInterrupted(
  snapshot: AgentConsoleSnapshot,
  now = Date.now(),
): AgentConsoleSnapshot;
```

- [ ] **Step 6: Run contract suites**

Run:

```bash
npm run test:contracts
```

Expected: all contract tests pass except the documented unrelated orchestrator classifier naming failure if the full wildcard reaches it in this checkout. The two focused files must pass.

- [ ] **Step 7: Commit only task-owned hunks**

```bash
git add -p packages/contracts/src/agent-console.ts packages/contracts/src/trace.ts tests/contracts/agent-console.contract.test.mjs tests/contracts/trace.contract.test.mjs
git commit -m "feat(console): define agent and job lifecycle contracts"
```

Before committing, inspect the staged diff and unstage any pre-existing unrelated hunk.

### Task 2: Canonical lifecycle reducer

**Files:**
- Modify: `packages/orchestrator/src/work-shell-agent-console.ts:20-291`
- Modify: `tests/orchestrator/work-shell-agent-console.test.mjs`

**Interfaces:**
- Consumes: Task 1 lifecycle events and `AgentConsoleSnapshot` types.
- Produces: idempotent agent/job/usage projection through the existing `applyTraceEventToAgentConsole(snapshot, event)` function.

- [ ] **Step 1: Write failing reducer transition tests**

Add one event sequence:

```js
const queued = applyTraceEventToAgentConsole(initial, {
  type: "job.queued",
  eventId: "event-job-1",
  jobId: "job-1",
  jobType: "work-node",
  label: "Map runtime",
  queuedAt: 10,
});
const running = applyTraceEventToAgentConsole(queued, {
  type: "agent.run.started",
  eventId: "event-run-1",
  runId: "run-1",
  jobId: "job-1",
  displayName: "RuntimeMap",
  agentType: "executor",
  startedAt: 20,
});
const cancelled = applyTraceEventToAgentConsole(running, {
  type: "agent.run.settled",
  eventId: "event-run-2",
  runId: "run-1",
  jobId: "job-1",
  status: "cancelled",
  startedAt: 20,
  completedAt: 30,
  summary: "Cancelled by operator.",
});
assert.equal(cancelled.agents[0]?.status, "cancelled");
assert.equal(cancelled.jobs[0]?.status, "cancelled");
```

Assert replaying each event returns the same object reference. Assert a settled agent cannot return to running, completion cannot precede start, an unknown job link is ignored, and a scoped `tool.started` updates only the linked agent's `currentActivity`.

Add usage tests proving the same `eventId` contributes once, scoped usage lands on `AgentRun.usage`, unscoped usage lands on `mainUsage`, and zero/negative/NaN counters are ignored.

- [ ] **Step 2: Run the reducer test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-agent-console.test.mjs
```

Expected: FAIL on the first `job.queued` assertion.

- [ ] **Step 3: Implement lifecycle reduction before tool reduction**

Add pure helpers in this order:

```ts
applyJobLifecycleEvent(snapshot, event)
applyAgentLifecycleEvent(snapshot, event)
applyUsageEvent(snapshot, event)
applyWorkLifecycleEvent(snapshot, event)
applyToolLifecycleEvent(snapshot, event)
```

Each helper returns the same snapshot for an irrelevant, malformed, duplicate, stale, or terminal-regressing event. `agent.run.settled` updates the linked agent and job in one `createAgentConsoleSnapshot` call. Bound summary and error strings before persistence.

- [ ] **Step 4: Scope tool activity and derive current activity**

Copy `agentRunId`/`asyncJobId` only when non-empty. On `tool.started`, set the linked running agent's `currentActivity` to the existing normalized intent. On `tool.completed`, keep the activity record bounded and leave the run's current activity as the normalized completed intent until the next lifecycle event settles it.

- [ ] **Step 5: Run reducer and contract tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-agent-console.test.mjs tests/contracts/agent-console.contract.test.mjs
```

Expected: both files pass.

- [ ] **Step 6: Commit only reducer hunks**

```bash
git add -p packages/orchestrator/src/work-shell-agent-console.ts tests/orchestrator/work-shell-agent-console.test.mjs
git commit -m "feat(console): reduce agent and job lifecycle events"
```

### Task 3: Provider turn usage propagation

**Files:**
- Modify: `packages/providers/src/runtime.ts:11-15,600-655,772-827,990-1045`
- Modify: `packages/orchestrator/src/coding-agent.ts:10-30,80-89`
- Modify: `tests/work/openai-query.test.mjs`
- Modify: `tests/work/anthropic-query.test.mjs`
- Modify: `tests/work/gemini-query.test.mjs`
- Modify: `tests/work/runtime-coding-agent.test.mjs`

**Interfaces:**
- Consumes: provider response `costUsd`, existing optional `steps`, and `AgentTurnResult`.
- Produces: every built-in provider `runTurn` returns accumulated positive `costUsd` and call count `steps`; `CodingAgent` preserves those optional fields.

- [ ] **Step 1: Add failing one-step and multi-step usage tests**

For each built-in provider, reuse its injected client fixture. Assert a one-response `runTurn` returns the response cost and `steps: 1`. For OpenAI, add a two-response tool loop and assert costs sum rather than replace:

```js
assert.deepEqual(
  { steps: result.steps, costUsd: result.costUsd },
  { steps: 2, costUsd: 0.007 },
);
```

In `runtime-coding-agent.test.mjs`, use a fake provider returning `{ text: "done", steps: 2, costUsd: 0.5 }` and assert `RuntimeCodingAgent.runTurn` preserves both fields.

- [ ] **Step 2: Run focused provider tests and verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/openai-query.test.mjs tests/work/anthropic-query.test.mjs tests/work/gemini-query.test.mjs tests/work/runtime-coding-agent.test.mjs
```

Expected: FAIL because provider `runTurn` currently returns only `text`.

- [ ] **Step 3: Accumulate usage inside each provider tool loop**

Initialize `steps = 0` and `costUsd = 0` at the start of each provider `runTurn`. After every model response, increment steps and add finite positive response cost. Every final/limit return uses:

```ts
return {
  text: turnStep.text,
  steps,
  ...(costUsd > 0 ? { costUsd } : {}),
};
```

Apply the same return shape to the max-iteration fallback. Do not emit `costUsd: 0` when pricing is unknown.

- [ ] **Step 4: Preserve optional usage through CodingAgent**

Extend the orchestrator-side `AgentTurnResult` with optional `steps` and `costUsd`. Return the provider result unchanged after emitting the existing completion trace.

- [ ] **Step 5: Run provider and work-agent tests**

```bash
npm run test:providers
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/openai-query.test.mjs tests/work/anthropic-query.test.mjs tests/work/gemini-query.test.mjs tests/work/runtime-coding-agent.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit usage propagation**

```bash
git add -p packages/providers/src/runtime.ts packages/orchestrator/src/coding-agent.ts tests/work/openai-query.test.mjs tests/work/anthropic-query.test.mjs tests/work/gemini-query.test.mjs tests/work/runtime-coding-agent.test.mjs
git commit -m "feat(console): propagate provider turn cost"
```

### Task 4: Executor run controller and full controls

**Files:**
- Create: `packages/orchestrator/src/work-agent-run-controller.ts`
- Modify: `packages/orchestrator/src/work-agent.ts:1-497`
- Modify: `packages/orchestrator/src/turn-orchestrator.ts:135-230`
- Modify: `packages/orchestrator/src/index.ts`
- Create: `tests/work/work-agent-run-controller.test.mjs`
- Modify: `tests/work/work-agent.test.mjs`
- Modify: `tests/orchestrator/turn-orchestrator.test.mjs`

**Interfaces:**
- Consumes: Task 1 control/lifecycle types and Task 3 usage-bearing executor result.
- Produces: `WorkAgentControlRuntime`, `WorkAgentRunController`, per-run AbortControllers, FIFO steer mailboxes, lifecycle/usage events, and continuation execution.

```ts
export type WorkAgentControlRuntime = {
  steer(agentRunId: string, message: string): Promise<AgentControlReceipt>;
  cancel(agentRunId: string): Promise<AgentControlReceipt>;
  continueRun(source: AgentRun, message?: string): Promise<AgentControlReceipt>;
  clear(reason: string): void;
};
```

- [ ] **Step 1: Write failing deferred-agent control tests**

Build a fake executor whose first `runTurn` waits on a deferred promise and whose second call records the steer prompt. Start a controller run, call `steer("run-1", "Check cancellation cleanup")`, resolve the first call, and assert the second call receives an operator-guidance prompt before the run settles.

Add tests for:

- FIFO delivery of two steer messages;
- `not_delivered` after settlement;
- one-run cancel aborting that run without aborting a sibling;
- parent turn abort cancelling all children;
- continuation producing a new run/job with `continuationOf` and `parentRunId` set to the source ID;
- `clear()` aborting every active continuation;
- no raw steer message in lifecycle event summaries.

- [ ] **Step 2: Run the new controller test and verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/work-agent-run-controller.test.mjs
```

Expected: FAIL because `WorkAgentRunController` is missing.

- [ ] **Step 3: Implement the focused run controller**

Keep `work-agent.ts` below its current size by moving new lifecycle state into the new file. The controller owns:

```ts
type ActiveRun = {
  readonly runId: string;
  readonly jobId: string;
  readonly abortController: AbortController;
  readonly mailbox: string[];
};
```

The controller exposes `queuePlannedJobs(graphId, tasks, queuedAt)` and emits each stable `job.queued` event exactly once when the plan is accepted. `runTask` requires that planned job ID; continuation creates and queues its own linked job immediately before dispatch. `runTask` then:

1. creates a child AbortController linked to the parent signal;
2. emits `agent.run.started` and marks the linked job running;
3. scopes every executor trace event with `agentRunId` and `asyncJobId`;
4. calls `executor.runTurn`;
5. drains FIFO steer messages as additional turns on the same executor;
6. emits one `usage.recorded` per provider turn with a stable event ID;
7. emits one terminal `agent.run.settled` event;
8. clears the executor and removes the active map entry in `finally`.

The steer follow-up prompt is exact and bounded:

```ts
`Operator guidance:\n${message.trim()}\n\nContinue the assigned task. Report only the updated result.`
```

Reject blank steer input. Cap each control message at 4,000 characters before handing it to the provider; never put it into the snapshot event.

- [ ] **Step 4: Add cancellation-aware WorkGraph status resolution**

Extend `runGoalTaskExecutorPool` with:

```ts
readonly resolveResultStatus?: (result: Result) => Extract<
  WorkNodeStatus,
  "completed" | "failed" | "cancelled"
>;
```

Use it instead of the current binary success/failure status when supplied. `WorkAgent` passes `result.status`, so per-run cancellation becomes a cancelled WorkGraph node rather than a false failure.

- [ ] **Step 5: Integrate the controller into WorkAgent**

`WorkAgent` delegates executor creation and execution to `WorkAgentRunController`. On plan creation it queues one job per WorkGraph node using `${graphId}:${task.id}`. Blocked dependencies emit `job.settled` with `cancelled` and a dependency summary. Simple, research, planner, guardian, and synthesis turns emit unscoped `usage.recorded`; executor and steer turns emit scoped usage.

Expose:

```ts
getAgentControlRuntime(): WorkAgentControlRuntime
```

`clear()` must clear the direct agent and controller.

- [ ] **Step 6: Run controller, scheduler, and WorkAgent tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/work-agent-run-controller.test.mjs tests/work/work-agent.test.mjs tests/orchestrator/turn-orchestrator.test.mjs
```

Expected: all selected tests pass; existing dependency-wave behavior remains unchanged.

- [ ] **Step 7: Commit the run controller**

```bash
git add packages/orchestrator/src/work-agent-run-controller.ts tests/work/work-agent-run-controller.test.mjs
git add -p packages/orchestrator/src/work-agent.ts packages/orchestrator/src/turn-orchestrator.ts packages/orchestrator/src/index.ts tests/work/work-agent.test.mjs tests/orchestrator/turn-orchestrator.test.mjs
git commit -m "feat(console): control executor agent runs"
```

### Task 5: Engine control adapter, view state, and resume persistence

**Files:**
- Create: `packages/orchestrator/src/work-shell-agent-console-state.ts`
- Modify: `packages/orchestrator/src/work-shell-engine.ts:332-430,575-905,1351-1409,1454-1597,1929-1975,2026-2484`
- Modify: `packages/orchestrator/src/work-shell-engine-state.ts:100-145`
- Modify: `packages/orchestrator/src/work-shell-engine-trace.ts:94-149`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-session.ts:77-116,220-260`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`
- Modify: `tests/work/work-cli-resume.test.mjs`
- Modify: `tests/session-store/redaction.test.mjs`

**Interfaces:**
- Consumes: `WorkAgentControlRuntime`, Task 2 reducer, and Task 1 resume helper.
- Produces: engine-owned `AgentConsoleViewState`, public `AgentControlPort` adapter, console navigation/control methods, coalesced lifecycle persistence, and interrupted resume state.

```ts
export type AgentConsoleViewState = {
  readonly open: boolean;
  readonly tab: AgentConsoleTab;
  readonly cursor: number;
  readonly inspectorVisible: boolean;
  readonly control:
    | { readonly kind: "browse" }
    | { readonly kind: "confirm-cancel"; readonly agentRunId: string };
  readonly receipt?: AgentControlReceipt;
};
```

- [ ] **Step 1: Write failing pure view-state tests**

Test open/close, tab selection, cursor clamping after a record settles, narrow-pane inspector toggling, cancel confirmation, and selection lookup for Agents/Jobs/Plan. Put pure reducer tests beside the engine tests or in a focused `tests/orchestrator/work-shell-agent-console-state.test.mjs` if the existing file becomes unwieldy.

- [ ] **Step 2: Write failing engine control tests**

Inject a fake `WorkAgentControlRuntime`. Assert:

- `openAgentConsole("jobs")` changes only console view state;
- `steerAgent` rejects a missing/settled run before calling runtime;
- accepted steer enters a receipt and exits steer composer mode;
- confirmed cancel invokes runtime once;
- continuation looks up the persisted safe `AgentRun` and passes it to `continueRun`;
- a lifecycle snapshot change schedules one persistence call despite a burst;
- a burst of lifecycle events produces one subscriber-visible snapshot update without dropping event order;
- `dispose()` cancels the timer and clears background runs.

- [ ] **Step 3: Run focused engine tests and verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs tests/work/work-cli-resume.test.mjs tests/session-store/redaction.test.mjs
```

Expected: FAIL on missing console state and control methods.

- [ ] **Step 4: Implement pure console view state**

Create helpers `createAgentConsoleViewState`, `openAgentConsoleView`, `closeAgentConsoleView`, `selectAgentConsoleTab`, `moveAgentConsoleCursor`, `toggleAgentConsoleInspector`, `requestAgentConsoleCancel`, and `settleAgentConsoleControl`. All helpers are immutable and clamp against the current snapshot.

- [ ] **Step 5: Adapt WorkAgent controls in WorkShellEngine**

Extend `WorkShellAgent` with optional `getAgentControlRuntime()`. Build an engine-owned `AgentControlPort` that validates current snapshot state before delegating. Add engine methods used by the TUI:

```ts
openAgentConsole(tab?: AgentConsoleTab): void;
closeAgentConsole(): void;
moveAgentConsoleCursor(delta: number): void;
selectAgentConsoleTab(tab: AgentConsoleTab): void;
toggleAgentConsoleInspector(): void;
beginAgentSteer(): void;
confirmAgentCancel(confirm: boolean): Promise<void>;
continueSelectedAgent(): Promise<void>;
```

Extend `WorkShellComposerMode` with `agent-steer`. While in that mode, `handleSubmit` sends the trimmed line to the selected run instead of routing it as chat.

- [ ] **Step 6: Coalesce console rendering and persistence**

Reduce incoming lifecycle events against a private `pendingAgentConsole` snapshot so order is preserved even before React state publishes. Schedule at most one state publication per 16 ms window; terminal events still reduce against every prior pending event. Independently schedule one durable snapshot write per 50 ms window. Persist `running` when agent/job active counts are nonzero; otherwise persist `idle`. On dispose, flush the final pending snapshot before clearing both timers. Persistence failure must leave the valid in-memory snapshot intact and must not append raw technical text to chat.

- [ ] **Step 7: Normalize resumed active work**

Call `markUnrecoverableAgentConsoleWorkInterrupted` exactly once at the resume boundary before `initialAgentConsole` enters engine state. Keep `parseAgentConsoleSnapshot` as the redaction/parser gate. Add session-store assertions that secret-looking unknown fields disappear while safe agent/job summaries survive.

- [ ] **Step 8: Run engine, resume, and redaction tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs tests/work/work-cli-resume.test.mjs tests/session-store/redaction.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit engine integration**

```bash
git add packages/orchestrator/src/work-shell-agent-console-state.ts
git add -p packages/orchestrator/src/work-shell-engine.ts packages/orchestrator/src/work-shell-engine-state.ts packages/orchestrator/src/work-shell-engine-trace.ts packages/orchestrator/src/index.ts apps/unclecode-cli/src/work-runtime-session.ts tests/orchestrator/work-shell-engine.test.mjs tests/work/work-cli-resume.test.mjs tests/session-store/redaction.test.mjs
git commit -m "feat(console): wire controls and resume-safe state"
```

### Task 6: Rust-owned slash routes and busy access

**Files:**
- Modify: `rust/unclecode-core/src/command_router.rs:79-215,253-520,826-1258`
- Modify: `rust/unclecode-core/src/steer.rs`
- Modify: `rust/unclecode-core/src/ux_panels.rs:400-425`
- Modify: `packages/orchestrator/src/work-shell-engine-commands.ts:9-80`
- Modify: `packages/orchestrator/src/work-shell-engine-submit.ts:11-82`
- Modify: `packages/orchestrator/src/work-shell-engine-builtin-runtime.ts:73-183`
- Modify: `packages/orchestrator/src/work-shell-slash.ts:45-120`
- Modify: `packages/orchestrator/src/command-registry.ts`
- Create: `tests/orchestrator/work-shell-slash-agent-console.test.mjs`
- Modify: `tests/orchestrator/work-shell-engine.test.mjs`
- Modify: `tests/work/repl.test.mjs`

**Interfaces:**
- Consumes: Task 5 `openAgentConsole(tab)`.
- Produces: one builtin shape `{ kind: "agent-console", tab: "agents" | "jobs" | "plan" }` for `/agents`, `/jobs`, and `/todo`, including busy-turn routing and slash discovery.

- [ ] **Step 1: Write failing Rust route tests**

Add exact expectations:

```rust
assert_eq!(
    work_shell_builtin_submit_command("/jobs"),
    Some(json!({ "kind": "agent-console", "tab": "jobs" })),
);
```

Cover all three commands in builtin and submit-route tests. In `steer.rs`, assert the same commands return a new `open_agent_console` busy action with their tab, while unrelated slash commands remain rejected.

- [ ] **Step 2: Run focused Rust tests and verify failure**

```bash
cargo test -p unclecode-core command_router
cargo test -p unclecode-core steer
```

Expected: FAIL because routes are absent.

- [ ] **Step 3: Add the Rust route and busy decision**

Map:

```text
/agents -> { kind: "agent-console", tab: "agents" }
/jobs   -> { kind: "agent-console", tab: "jobs" }
/todo   -> { kind: "agent-console", tab: "plan" }
```

Add `open_agent_console { line, tab }` to the busy decision JSON. Update busy-panel copy to state that queue, cancel, and console commands work while busy; other slash commands are not queued.

- [ ] **Step 4: Add TS validation and engine dispatch**

Add the discriminated builtin variant once. Both validators must require a valid tab. `executeWorkShellBuiltinSubmit` receives `openAgentConsole(tab)` and calls it without appending a conversation entry.

Add busy-decision parsing/handling in `work-shell-engine.ts` so `/agents`, `/jobs`, and `/todo` open immediately during a running turn.

- [ ] **Step 5: Add slash suggestions and JS seam tests**

Add Korean descriptions to the existing registry/suggestion source:

```text
/agents — 에이전트 실행 상태와 transcript를 엽니다
/jobs   — 백그라운드 job 상태를 엽니다
/todo   — 현재 WorkGraph 진행 상태를 엽니다
```

Assert all commands appear in suggestions and route to the expected tab. Update the exhaustive Work Shell slash map in `tests/work/repl.test.mjs`.

- [ ] **Step 6: Build Rust once, then run seam tests**

```bash
cargo build -p unclecode
UNCLECODE_RUST_BIN=target/debug/unclecode node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-slash-agent-console.test.mjs tests/orchestrator/work-shell-engine.test.mjs tests/work/repl.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit routing changes**

```bash
git add -p rust/unclecode-core/src/command_router.rs rust/unclecode-core/src/steer.rs rust/unclecode-core/src/ux_panels.rs packages/orchestrator/src/work-shell-engine-commands.ts packages/orchestrator/src/work-shell-engine-submit.ts packages/orchestrator/src/work-shell-engine-builtin-runtime.ts packages/orchestrator/src/work-shell-slash.ts packages/orchestrator/src/command-registry.ts packages/orchestrator/src/work-shell-engine.ts tests/orchestrator/work-shell-slash-agent-console.test.mjs tests/orchestrator/work-shell-engine.test.mjs tests/work/repl.test.mjs
git commit -m "feat(console): route agent console commands"
```

### Task 7: Default HUD and responsive Agent Console renderer

**Files:**
- Create: `packages/tui/src/work-shell-agent-console-model.ts`
- Create: `packages/tui/src/work-shell-agent-console-view.tsx`
- Modify: `packages/tui/src/work-shell-view.tsx:1694-1804,1963-2076,2188-2499`
- Modify: `packages/tui/src/index.tsx`
- Create: `tests/tui/work-shell-agent-console-model.test.mjs`
- Create: `tests/tui/work-shell-agent-console-render.test.mjs`
- Modify: `tests/tui/work-shell-context-inspector-render.test.mjs:1090-1190`
- Modify: `tests/orchestrator/agent-console-preview.test.mjs`

**Interfaces:**
- Consumes: `AgentConsoleSnapshot`, `AgentConsoleViewState`, existing palette values, and `text-width.ts` helpers.
- Produces: pure HUD selectors, `WorkShellAgentConsoleHud`, and `WorkShellAgentConsoleOverlay`.

```ts
export function selectWorkGraphHudRows(snapshot: AgentConsoleSnapshot, width: number): readonly string[];
export function selectActiveAgentHudRows(snapshot: AgentConsoleSnapshot, now: number, width: number): readonly string[];
export function selectAgentConsoleRows(snapshot: AgentConsoleSnapshot, tab: AgentConsoleTab): readonly AgentConsoleRow[];
export function formatAgentConsoleTotalCost(snapshot: AgentConsoleSnapshot): string | undefined;
```

- [ ] **Step 1: Write failing pure model tests**

Assert:

- WorkGraph sorts active/blocked/requires-action/failed before pending/completed;
- default WorkGraph renders three rows and `+N`;
- default agents include only `running|waiting`, render four rows and `+N`;
- display names and activities truncate by display width, including Korean text;
- total cost equals main usage plus each agent usage once;
- unknown/zero-only usage returns `undefined`;
- Jobs and Agents console lists retain settled records.

- [ ] **Step 2: Write failing render tests at 100 and 80 columns**

Use `renderDebugFrame` and `waitForSettledFrame`. At 100 columns, assert roster and inspector are simultaneously visible. At 80 columns, assert only the selected pane is visible and the frame contains no raw prompt/output sentinel.

Render a running snapshot and assert the default shell contains goal progress and agent rows but not the existing detailed tool-ledger header or diff preview.

- [ ] **Step 3: Run focused TUI tests and verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-concurrency=1 tests/tui/work-shell-agent-console-model.test.mjs tests/tui/work-shell-agent-console-render.test.mjs tests/tui/work-shell-context-inspector-render.test.mjs tests/orchestrator/agent-console-preview.test.mjs
```

Expected: FAIL because the model and renderer do not exist and the current default view still renders detailed tool rows.

- [ ] **Step 4: Implement pure selectors and bounded transcript projection**

Build the selected agent inspector from safe snapshot facts only:

- display name/type/status/timing/lineage;
- matching `ToolActivity.agentRunId` entries with existing bounded previews;
- final `summary` or `errorSummary`;
- usage when positive.

The transcript label is a filtered timeline, not a raw provider transcript. Do not read provider history or system prompts.

- [ ] **Step 5: Implement the responsive overlay**

Use existing Ink `Box`/`Text`, palette tokens, ledger glyphs, and display-width helpers. At width `>=84`, render a 38% roster and remaining inspector separated by one divider. Below 84, render the roster unless `inspectorVisible` is true. Always show tabs and key hints; never depend on color alone for status.

- [ ] **Step 6: Replace the detailed default ledger cleanly**

Remove `formatWorkShellAgentConsoleActivityLines` and its detailed tool-ledger rendering from `work-shell-view.tsx`. Render the bounded WorkGraph and active-agent HUD components instead. Update old tests rather than preserving an alias or compatibility wrapper.

- [ ] **Step 7: Run model and render suites**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-concurrency=1 tests/tui/work-shell-agent-console-model.test.mjs tests/tui/work-shell-agent-console-render.test.mjs tests/tui/work-shell-context-inspector-render.test.mjs tests/orchestrator/agent-console-preview.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit the renderer**

```bash
git add packages/tui/src/work-shell-agent-console-model.ts packages/tui/src/work-shell-agent-console-view.tsx tests/tui/work-shell-agent-console-model.test.mjs tests/tui/work-shell-agent-console-render.test.mjs
git add -p packages/tui/src/work-shell-view.tsx packages/tui/src/index.tsx tests/tui/work-shell-context-inspector-render.test.mjs tests/orchestrator/agent-console-preview.test.mjs
git commit -m "feat(tui): render Agent Console and summary HUD"
```

### Task 8: Alt+A and console keyboard controls

**Files:**
- Create: `packages/tui/src/work-shell-agent-console-input.ts`
- Modify: `packages/tui/src/work-shell-input.ts`
- Modify: `packages/tui/src/work-shell-hooks.ts:280-330,429-545,940-980`
- Modify: `packages/tui/src/work-shell-pane.tsx:150-240`
- Modify: `packages/tui/src/composer.tsx:450-525`
- Modify: `packages/tui/src/index.tsx`
- Modify: `tests/tui/work-shell-keyboard.test.mjs`
- Create: `tests/tui/work-shell-agent-console-keyboard.test.mjs`

**Interfaces:**
- Consumes: Task 5 engine methods and Task 7 renderer.
- Produces: deterministic console key resolution, Composer suppression, and Alt+A toggle.

```ts
export type AgentConsoleInputAction =
  | { readonly kind: "close" }
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | { readonly kind: "tab"; readonly tab: AgentConsoleTab }
  | { readonly kind: "toggle-inspector" }
  | { readonly kind: "begin-steer" }
  | { readonly kind: "request-cancel" }
  | { readonly kind: "confirm-cancel"; readonly confirmed: boolean }
  | { readonly kind: "continue" };
```

- [ ] **Step 1: Write failing resolver tests**

Pin precedence:

1. slash picker consumes its keys first;
2. `Alt+A` toggles the console from any non-secure composer state;
3. an open console with an empty composer consumes `j/k`, arrows, `Tab`, `Enter`, `s`, `x`, `r`, and `Esc`;
4. cancel confirmation consumes only `y/n/Esc`;
5. `agent-steer` composer mode allows printable text and submit while `Esc` cancels the mode;
6. secure API-key entry never leaks keystrokes to the console.

- [ ] **Step 2: Write failing Ink keyboard tests**

Use the existing PassThrough stdin harness. Send the terminal Alt+A sequence (`ESC` followed by `a`), assert the console opens and the draft stays unchanged, then drive `j`, `s`, a steer message, Enter, `x`, `n`, `x`, `y`, and `r`. Assert each fake engine method receives the selected run once.

- [ ] **Step 3: Run keyboard tests and verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-concurrency=1 tests/tui/work-shell-agent-console-keyboard.test.mjs tests/tui/work-shell-keyboard.test.mjs
```

Expected: FAIL because Alt+A currently reaches Composer as printable `a` and console actions are absent.

- [ ] **Step 4: Implement the pure action resolver**

Follow `resolveWorkShellContextInspectorAction` rather than expanding the Rust general input state machine. Accept the Ink `key.meta` flag and normalized input string. Return `undefined` for unowned keys.

- [ ] **Step 5: Wire controller precedence and Composer suppression**

Intercept Alt+A before the existing Context Inspector and general Rust action resolver. When the console owns the keyboard, dispatch to engine methods and pass suppression props to Composer so the same bytes are not inserted. In `agent-steer` mode, Composer owns printable text and Enter; the controller owns Escape.

- [ ] **Step 6: Run keyboard and composer suites**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-concurrency=1 tests/tui/work-shell-agent-console-keyboard.test.mjs tests/tui/work-shell-keyboard.test.mjs tests/tui/work-shell-composer-workflow.test.mjs
```

Expected: all selected tests pass and normal typing remains unchanged.

- [ ] **Step 7: Commit keyboard control**

```bash
git add packages/tui/src/work-shell-agent-console-input.ts tests/tui/work-shell-agent-console-keyboard.test.mjs
git add -p packages/tui/src/work-shell-input.ts packages/tui/src/work-shell-hooks.ts packages/tui/src/work-shell-pane.tsx packages/tui/src/composer.tsx packages/tui/src/index.tsx tests/tui/work-shell-keyboard.test.mjs
git commit -m "feat(tui): control Agent Console with Alt+A"
```

### Task 9: Busy counts, Git facts, context, and cost footer

**Files:**
- Modify: `packages/tui/src/facts.ts`
- Modify: `packages/tui/src/work-shell-footer-fast-paths.ts:7-79`
- Modify: `packages/tui/src/work-shell-pane.tsx:150-210`
- Modify: `packages/tui/src/work-shell-view.tsx:1694-1877,2188-2499`
- Modify: `tests/tui/work-shell-footer-budget.test.mjs`
- Modify: `tests/tui/work-shell-live-activity.test.mjs`
- Modify: `tests/tui/work-shell-pane-helpers.test.mjs`

**Interfaces:**
- Consumes: Task 7 active-count and total-cost selectors.
- Produces: `GitFacts`, cached `readGitFacts(cwd, now?)`, one external-system sync hook in the pane, busy count rendering, and responsive footer priority.

```ts
export type GitFacts = {
  readonly branch?: string;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
};
```

- [ ] **Step 1: Write failing Git parser/cache tests**

Inject porcelain text covering staged-only, unstaged-only, both-column changes, rename, conflict, and untracked files. Assert each file increments each applicable category once. Inject a command spy and assert two reads inside 1,000 ms execute once while a read after the TTL executes again.

- [ ] **Step 2: Write failing status/footer formatter tests**

Assert exact facts:

```text
⠋ GPT-5.6-Sol · 집중 작업 · 4 agents · 4 jobs · Reading context · 16s
~/project/unclecode · main *90 +2 ?34          25.3%/272K · $1.16
```

Also assert zero agent/job counts and unknown cost are omitted, path truncates before dirty counts, widths below 84 retain project basename, compact branch/dirty state, and context percentage, and elapsed labels never move backward when the wall clock changes.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-concurrency=1 tests/tui/work-shell-footer-budget.test.mjs tests/tui/work-shell-live-activity.test.mjs tests/tui/work-shell-pane-helpers.test.mjs
```

Expected: FAIL on Git count, cost, and agent/job count assertions.

- [ ] **Step 4: Replace coarse Git status with structured cached facts**

Use `execFileSync("git", ["status", "--porcelain=v1", "--branch"], ...)`, not a shell command string. Parse the branch header and XY columns. Cache by cwd and timestamp. A repository error returns zero counts with no branch; it does not throw into rendering.

- [ ] **Step 5: Sync Git facts outside render**

In `WorkShellPane`, use one effect because Git is an external process. Read once on cwd change and refresh at 1,000 ms only while the main turn or any agent/job is active. Clean up the interval. Rendering receives state only and never calls Git.

- [ ] **Step 6: Add counts and monotonic time to the sole status spinner**

Pass active agent/job counts into `WorkShellStatusBlock`. Treat background agent/job activity as busy for this block even when the main turn is idle, but do not create another timer. Anchor one clock at `{ wall: Date.now(), monotonic: performance.now() }` and derive display time as `wall + performance.now() - monotonic`; use that same active-work timer for main-turn and agent elapsed labels. Compose status facts in model/mode, counts, normalized activity, elapsed order and preserve the existing auth-warning behavior.

- [ ] **Step 7: Extend footer priority**

`formatWorkShellFooterLineFast` accepts `gitFacts` and `costUsd`. Build left facts from path, branch, and nonzero `*N +N ?N`. Build right facts from budget and positive cost. At narrow widths, compact path to basename before removing optional cost; never remove dirty markers before path compaction.

- [ ] **Step 8: Run focused TUI tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-concurrency=1 tests/tui/work-shell-footer-budget.test.mjs tests/tui/work-shell-live-activity.test.mjs tests/tui/work-shell-pane-helpers.test.mjs
```

Expected: all selected tests pass with one spinner.

- [ ] **Step 9: Commit status and footer changes**

```bash
git add -p packages/tui/src/facts.ts packages/tui/src/work-shell-footer-fast-paths.ts packages/tui/src/work-shell-pane.tsx packages/tui/src/work-shell-view.tsx tests/tui/work-shell-footer-budget.test.mjs tests/tui/work-shell-live-activity.test.mjs tests/tui/work-shell-pane-helpers.test.mjs
git commit -m "feat(tui): show live agent and workspace status"
```

### Task 10: Deterministic offline smoke and final verification

**Files:**
- Create: `scripts/runtime-qa/tui-agent-console-smoke.mjs`
- Modify: `scripts/unclecode-runtime-qa.mjs`
- Modify: `scripts/runtime-qa/tui-basic-smokes.mjs`
- Modify: only test/source files identified by failures caused by this feature

**Interfaces:**
- Consumes: completed runtime, routing, TUI, and fake-provider test harness.
- Produces: an offline end-to-end Agent Console smoke check and final repository evidence.

- [ ] **Step 1: Add the failing runtime smoke scenario**

Use the existing fake provider and tmux helpers. Drive this exact flow:

1. submit the deterministic complex-work fixture that starts two executor jobs;
2. wait for `2 agents` and `2 jobs` in the status line;
3. send Alt+A and wait for Agents roster plus inspector;
4. steer the first run and wait for an accepted receipt;
5. select the second run, request cancel, and confirm `y`;
6. wait for cancelled state and one remaining active run;
7. wait for the remaining run to complete and active counts to disappear;
8. reopen `/jobs` and assert both settled records remain visible;
9. resume the session fixture and assert no running phantom remains.

Use settled-frame or output-pattern waits, not fixed sleeps. Capture the terminal frame on failure through the existing runtime-QA artifact path.

- [ ] **Step 2: Build prerequisites and run the smoke to verify failure**

```bash
npm run build --silent
cargo build -p unclecode
npm run qa:runtime
```

Expected before smoke registration is complete: FAIL at the first missing Agent Console assertion. After implementation: all runtime QA checks pass without provider keys.

- [ ] **Step 3: Run focused suites in dependency order**

```bash
npm run test:contracts
npm run test:providers
npm run test:session-store
npm run test:orchestrator
npm run test:tui
npm run test:cli
```

Expected: all named suites pass, excluding only a separately observed pre-existing failure with unchanged evidence.

- [ ] **Step 4: Run Rust checks and tests**

```bash
npm run rust:check
npm run rust:test
```

Expected: Cargo workspace check and tests pass.

- [ ] **Step 5: Format new files, then lint, build, and typecheck**

Format only files created by this feature; project-wide write-formatting would modify unrelated dirty-worktree files.

```bash
npx biome format --write packages/orchestrator/src/work-agent-run-controller.ts packages/orchestrator/src/work-shell-agent-console-state.ts packages/tui/src/work-shell-agent-console-model.ts packages/tui/src/work-shell-agent-console-view.tsx packages/tui/src/work-shell-agent-console-input.ts tests/work/work-agent-run-controller.test.mjs tests/orchestrator/work-shell-slash-agent-console.test.mjs tests/tui/work-shell-agent-console-model.test.mjs tests/tui/work-shell-agent-console-render.test.mjs tests/tui/work-shell-agent-console-keyboard.test.mjs scripts/runtime-qa/tui-agent-console-smoke.mjs
npm run lint
npm run build --silent
npm run check
npm run provenance:check
npm run node:check
```

Expected: all commands pass. Re-run focused tests if formatting changes executable source.

- [ ] **Step 6: Run the Work Shell smoke path directly**

```bash
npm run qa:runtime
```

Expected: the new two-agent inspect/steer/cancel/resume scenario passes and the runtime QA report records it.

- [ ] **Step 7: Review the final user-visible frame**

Inspect the captured 100-column and 80-column frames. Verify one spinner, bounded HUD rows, readable Korean/CJK widths, no raw prompt/output, correct footer priority, and no duplicate tool ledger. Correct only defects observed in these frames.

- [ ] **Step 8: Commit smoke and cleanup changes**

```bash
git add scripts/runtime-qa/tui-agent-console-smoke.mjs
git add -p scripts/unclecode-runtime-qa.mjs scripts/runtime-qa/tui-basic-smokes.mjs
git commit -m "test(console): cover Agent Console end to end"
```

- [ ] **Step 9: Request final code review**

Run the repository's code-review skill against the complete task-owned diff. Resolve Critical and Warning findings, re-run the smallest affected verification, then re-run `npm run build --silent && npm run check`.
