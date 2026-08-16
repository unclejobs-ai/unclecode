# UncleCode Agent Console Control Surface Design

**Date:** 2026-08-09
**Status:** Approved for implementation planning
**Direction:** UncleCode hybrid — concise default HUD plus a full `Alt+A` control surface

## 1. Goal

Give Work Shell users immediate, accurate visibility into parallel work without turning the default conversation into an orchestration log.

The default shell shows only:

- one busy line with elapsed time and active agent/job counts;
- a bounded WorkGraph progress summary;
- up to four active agent summaries;
- a responsive footer containing workspace, Git, context, and cost facts that actually exist.

`Alt+A` opens a full Agent Console where the operator can inspect filtered transcripts, steer running agents, cancel work, and start linked continuation runs. `/agents`, `/jobs`, and `/todo` open the corresponding console views.

## 2. Success Criteria

The feature is complete when all of the following are true:

1. A Work Shell turn with parallel workers displays correct live agent and job counts from one canonical snapshot.
2. WorkGraph progress and active agent summaries are visible without raw worker prompts, raw tool output, internal routing JSON, or duplicate spinners.
3. `Alt+A` opens a responsive Agent Console with Agents, Jobs, and Plan views.
4. The operator can inspect a safe transcript projection, steer a running agent at its next safe boundary, confirm and cancel an agent with its owned job, and create a linked continuation run from a settled agent.
5. Session resume marks non-resumable active work as interrupted rather than pretending it is still running.
6. Git, context, cost, and agent/job footer facts disappear when unknown; the UI never invents zero values.
7. The feature works without a new dependency and without any third-party orchestration integration.

## 3. Product Decisions

### 3.1 Selected direction

Use the hybrid design:

- concise live summaries in the default Work Shell;
- detailed orchestration state only in the Agent Console;
- full controls in the first delivery, not a view-only intermediate release.

### 3.2 Existing principles retained

The design preserves the current Work Shell contract:

- one animated spinner while busy;
- final assistant synthesis remains the primary conversation output;
- raw subtask JSON, worker metadata, reasoning deltas, and tool output stay out of the conversation rail;
- the footer does not repeat model, mode, or auth facts already owned by the status strip;
- CJK and narrow-terminal behavior use existing display-width helpers.

### 3.3 Non-goals

- Reimplementing OMP or depending on OMP packages.
- Exposing raw system prompts, complete tool output, secrets, or provider protocol frames.
- Folding the separate `unclecode team run` dashboard into the session-scoped Work Shell console.
- Reviving a disposed provider session while pretending its runtime still exists.
- Adding a second Todo model beside the existing WorkGraph.
- Adding a second tool activity model beside the existing `ToolActivity[]` projection.

## 4. Architecture

### 4.1 Single source of truth

Extend the existing `AgentConsoleSnapshot`; do not create independent HUD, footer, and overlay registries.

Existing fields remain authoritative:

- `workGraph` — plan and Todo progress;
- `activity` — bounded tool activity projection;
- `pendingDecision` — operator interaction state;
- `manifest` — safe context manifest metadata.

Add lifecycle projections and a deduplicated usage ledger:

```ts
type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

type AgentRunUsage = {
  readonly eventIds: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly costUsd?: number;
};

type AgentRun = {
  readonly id: string;
  readonly displayName: string;
  readonly agentType: string;
  readonly status: AgentRunStatus;
  readonly currentActivity?: string;
  readonly parentRunId?: string;
  readonly continuationOf?: string;
  readonly transcriptRef?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly summary?: string;
  readonly errorSummary?: string;
  readonly usage?: AgentRunUsage;
};

type AsyncJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

type AsyncJob = {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly status: AsyncJobStatus;
  readonly agentRunId?: string;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly summary?: string;
  readonly errorSummary?: string;
};

type AgentConsoleLifecycleProjection = {
  readonly agents: readonly AgentRun[];
  readonly jobs: readonly AsyncJob[];
  readonly mainUsage?: AgentRunUsage;
};
```

`AgentConsoleSnapshot` owns `agents`, `jobs`, and `mainUsage`. Per-agent usage stays on `AgentRun.usage`; session totals derive from `mainUsage` plus the agent entries. Counts, HUD rows, tabs, and status facts are derived from this snapshot. No consumer maintains its own counter or cost accumulator.

### 4.2 Lifecycle event projection

The orchestrator emits worker and background-job lifecycle events. `work-shell-agent-console` reduces them into the snapshot alongside existing tool and WorkGraph events.

Required invariants:

- every task-owned job has at most one `agentRunId`;
- event replay is idempotent by stable event/run/job IDs;
- usage replay is idempotent by stable `eventIds`; a provider turn contributes to either `mainUsage` or one `AgentRun.usage`, never both;
- agent-scoped tool activity records its optional `agentRunId` so the inspector can filter without copying tool output;
- terminal states never transition back to running;
- completion timestamps are monotonic relative to start timestamps;
- a continuation receives a new run ID and records `continuationOf`;
- cancelling an agent and its owned active job is one reducer transition from the UI's perspective;
- lifecycle bursts are coalesced before Ink rendering, but durable journal order remains deterministic.

### 4.3 Persistence boundary

Persist only the safe projection in `AgentConsoleSnapshot`:

- status, lineage, timestamps, bounded summaries, bounded usage, and transcript references;
- no secrets, raw system prompts, raw worker assignments, provider frames, or raw tool output.

A transcript reference resolves to a filtered agent transcript projection. That projection may contain user-visible assistant text, bounded diagnostics, and normalized tool activity, but excludes the worker system prompt and unbounded tool results.

On session resume:

- settled states remain settled;
- active `queued`, `running`, and `waiting` runs that cannot be reattached become `interrupted`;
- associated non-resumable active jobs become `interrupted`;
- the UI never displays phantom running counts.

### 4.4 Control port

Define the control contract before runtime implementations:

```ts
type AgentControlReceipt = {
  readonly status: "accepted" | "not_delivered" | "rejected";
  readonly message: string;
};

type AgentControlPort = {
  steer(agentRunId: string, message: string): Promise<AgentControlReceipt>;
  cancel(agentRunId: string): Promise<AgentControlReceipt>;
  continue(agentRunId: string, message?: string): Promise<AgentControlReceipt>;
};
```

Semantics:

- `steer` appends to a per-agent FIFO mailbox and delivers at the next safe boundary; it does not mutate an in-flight tool call.
- steer received after settlement returns `not_delivered`; it is never silently dropped.
- `cancel` aborts the agent runtime and its owned active job, then records the terminal transition.
- `continue` creates a new agent run with prior safe summary, evidence references, and lineage. It does not fake resurrection of a disposed provider session.

## 5. Default Work Shell UX

### 5.1 Busy status line

Retain `WorkShellStatusBlock` as the only owner of the busy spinner.

Example:

```text
⠋ 00:16 · 4 agents · 4 jobs · 실행 경로 분석 중
```

Rules:

- one spinner total;
- elapsed duration uses a monotonic clock;
- agent count includes `running` and `waiting` session-owned agents;
- job count includes `queued` and `running` session-owned jobs;
- activity text is a normalized operator-facing phrase, not a raw tool name or path;
- zero counts are omitted rather than rendered as noise.

### 5.2 WorkGraph summary

Show the WorkGraph summary only when a graph exists and has open or failed work.

Example:

```text
Runtime safety · 0/6
├─ ◐ Safety Core
├─ ○ Filesystem Safety
└─ ○ Runtime Isolation · +3
```

Rules:

- the header shows goal and completed/total nodes;
- active, blocked, requires-action, and failed nodes sort before pending and completed nodes;
- render at most three node rows in the default shell;
- summarize hidden rows with `+N`;
- never render private node prompts or internal IDs in the default shell.

### 5.3 Agent summary

Show only active agents in the default summary.

Example:

```text
Agents · 4 active                          Alt+A inspect
├─ ExecutionMap       read       2m06s
├─ RuntimePathMap     search     2m06s
├─ QaMap              read       2m06s
└─ Persistence        search       16s
```

Rules:

- at most four rows;
- use stable display names, normalized activity, and elapsed time;
- internal IDs, parent IDs, retry internals, prompts, and output remain inspector-only;
- when no agent is active, the block disappears;
- failed agents remain available in the Agent Console even after the default summary disappears.

### 5.4 Detailed tool activity

The default shell does not render a second detailed tool ledger beside the agent summary. Existing `ToolActivity[]` remains the data source for current activity and the Agent Console inspector.

Final user-relevant tool effects may still appear through the established filtered conversation/system feedback path. Raw tool traces do not.

## 6. Footer and Status Facts

The status strip continues to own:

- model;
- mode;
- auth;
- busy state.

The footer becomes a responsive left/right composition:

```text
~/project/unclecode · main *90 +2 ?34          25.3%/272k · $1.16
```

Git markers:

- `*N` — unstaged tracked files;
- `+N` — staged files;
- `?N` — untracked files.

Rules:

- left priority: project path, branch, dirty counts;
- right priority: context percentage/window, session-total cost;
- truncate the path before dropping safety-relevant dirty indicators;
- below 84 columns, reduce to project basename, compact branch/dirty state, and context percentage;
- omit unknown context window and unknown cost rather than displaying fake values;
- session cost aggregates main and agent usage once by stable usage/event IDs;
- Git facts use a cwd-scoped cache with at most one refresh per second; rendering never shells out on every keystroke.

## 7. Agent Console UX

### 7.1 Entry points

- `Alt+A` — open or close the Agent Console on its last selected tab;
- `/agents` — open the Agents tab;
- `/jobs` — open the Jobs tab;
- `/todo` — open the Plan tab backed by WorkGraph.

These commands open one shared console component. They do not create separate implementations.

### 7.2 Responsive layout

At 84 columns and above:

- left pane: roster or plan/job list;
- right pane: selected item inspector.

Below 84 columns:

- list occupies the screen;
- `Tab` toggles the inspector;
- wrapped content uses existing display-width helpers.

### 7.3 Tabs

#### Agents

Roster fields:

- status;
- display name and agent type;
- current normalized activity;
- elapsed or settled duration;
- unread steer/receipt count when nonzero.

Inspector fields:

- lineage;
- status and timing;
- filtered transcript;
- bounded tool activity and diagnostics;
- usage when known;
- continuation and evidence references.

#### Jobs

List fields:

- status;
- type and label;
- linked agent display name;
- queued/running duration;
- settled summary.

The inspector shows bounded diagnostic detail and ownership. It never embeds unbounded job output.

#### Plan

The Plan tab renders the existing WorkGraph:

- goal and approval;
- node status;
- dependencies;
- file ownership;
- acceptance criteria;
- evidence references.

No second Todo persistence format is introduced.

### 7.4 Controls

- `j`/`k`, arrows — select row;
- `Tab` — toggle inspector on narrow terminals;
- `Enter` — focus selected transcript/detail;
- `s` — enter a steer message for a running/waiting agent;
- `x` — request cancellation; require `y/n` confirmation;
- `r` — create a continuation from a completed, failed, cancelled, or interrupted run;
- `Esc` — close nested input/confirmation first, then close the console.

Cancellation confirmation names the agent and linked job. A rejected or failed control action remains visible as a friendly receipt; it does not optimistically change counters.

## 8. Error Handling and Safety

- Default Work Shell errors are concise, user-facing lines.
- Stack traces, raw provider errors, and bounded technical diagnostics live in the inspector only.
- A failed agent remains inspectable and cannot be mistaken for completed work.
- Unknown or malformed lifecycle events are rejected without replacing the last valid snapshot.
- Control messages are treated as operator input, not system instructions.
- Transcript and diagnostic rendering passes through existing sanitization and display-width boundaries.
- No token, credential, environment secret, or authorization header enters Agent Console persistence or logs.
- The feature adds no dependency.

## 9. Performance

- Agent/job lifecycle events update the reducer incrementally; do not rescan full session history on each event.
- Coalesce rapid progress updates before setting Ink state.
- Memoize derived HUD rows by snapshot identity and terminal width.
- Use monotonic elapsed-time calculations and one shared UI timer while active work exists.
- Git state refresh is cached and throttled outside render functions.
- Transcript details load on selection rather than preloading every agent transcript.

## 10. Verification Strategy

### 10.1 Contract tests

- Agent and job state transitions.
- Job-to-agent ownership invariant.
- Parent/child and continuation lineage.
- Replay idempotency and deterministic ordering.
- Resume conversion from active to interrupted.
- Safe bounded snapshot parsing and persistence.
- Usage deduplication.

### 10.2 Orchestrator tests

- Spawn publishes linked agent/job events.
- Ordered steer delivery at a safe boundary.
- `not_delivered` receipt after settlement.
- Cancel propagation reaches agent AbortController and owned job.
- Continuation creates a new run with prior lineage and safe summary.
- Concurrent lifecycle events settle to correct counts.

### 10.3 TUI tests

- One spinner only.
- Busy-line count omission and pluralization.
- WorkGraph row cap and `+N` summary.
- Agent row cap and activity normalization.
- Footer Git/context/cost priority and narrow-width truncation.
- 84-column console breakpoint.
- Agent, Jobs, and Plan tab keyboard behavior.
- Cancel confirmation and steer input state.
- No raw worker prompt, raw tool output, secret, or internal routing JSON in the default screen.
- CJK display-width behavior.

### 10.4 Smoke scenario

Use a deterministic offline worker fixture:

1. Start two linked agents and jobs.
2. Observe the busy line, WorkGraph summary, and two agent rows.
3. Open `Alt+A` and inspect both agents.
4. Steer one agent and observe an accepted receipt at its next safe boundary.
5. Cancel the other agent and confirm its linked job settles once.
6. Let the first agent complete.
7. Confirm running counts return to zero, the default agent block disappears, and both settled runs remain inspectable.
8. Resume the session and confirm no phantom running state.

## 11. Expected Code Boundaries

The implementation plan should stay within the existing boundaries:

- `packages/contracts/src/agent-console.ts` — public projection and control types;
- `packages/orchestrator/src/work-shell-agent-console.ts` — lifecycle reducer;
- Work Shell runtime execution/lifecycle modules — event publication and control port implementation;
- `packages/tui/src/work-shell-view.tsx` and focused extracted components — summary HUD and console rendering;
- `packages/tui/src/work-shell-pane.tsx`, hooks, and input modules — `Alt+A` and control input state;
- `packages/orchestrator/src/work-shell-slash.ts` plus the Rust command router — `/agents`, `/jobs`, `/todo` routing;
- existing session-store projection path — safe persistence and resume;
- focused contract, orchestrator, TUI, CLI, and smoke tests.

Do not add a new UI state store, Todo file format, job manager, or provider abstraction unless implementation discovery proves the existing owner cannot satisfy a named invariant.

## 12. Rollback

The persisted reader tolerates absent `agents`, `jobs`, and `mainUsage` fields during rollout, while the runtime snapshot and new writer always emit canonical arrays. If the UI must be rolled back, existing WorkGraph and ToolActivity behavior remains readable. Once the full feature is verified, remove any superseded default detailed tool-ledger rendering rather than leaving two competing views.
