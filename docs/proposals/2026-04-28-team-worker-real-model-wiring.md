# Team-Worker Real Model Wiring — Design Note

**Date**: 2026-04-28
**Status**: Deferred (needs dedicated session)
**Scope**: How `apps/unclecode-cli/src/team-worker.ts` switches from a 1-step
publish stub to a real loop driven by an LLM provider.

## Why this is not a "thin adapter"

The two contracts have an impedance mismatch:

| | Runtime / LlmProvider | MiniLoopModelClient |
|---|---|---|
| State | Stateful: internal `messages[]`, `clear()` to reset | Stateless: caller passes full message history per call |
| Surface | `runTurn(prompt) → AgentTurnResult{text}` | `query(messages) → {content, actions[], costUsd}` |
| Tools | Provider-side handlers run inside `runTurn` | Caller decides whether to execute `actions[]`, observation goes back via message log |
| History | Provider trusted to maintain | Caller (MiniLoopAgent) is canonical |

A naive adapter that calls `clear()` + replays history each step:

- Quadratic token cost (n² over the run).
- Breaks prompt cache across providers that key on a stable prefix.
- Drift the moment `MiniLoopHooks` injects a message — caller view and
  provider view diverge silently.

A naive adapter that trusts the provider's internal state assumes the caller
never reorders, edits, or injects — which `MiniLoopHooks.onBeforeStep`,
`onAfterStep`, and `onSubmit` are explicitly allowed to do.

## Two valid paths

### (a) New stateless query path in `@unclecode/providers`

Add `queryOnce({ messages, model, reasoning, ... }) → MiniLoopModelResponse`
alongside `runTurn`. Direct provider HTTP call, no internal state. Pros:
keeps `runTurn` callers (work-shell-engine, work-runtime, coding-agent,
work-runtime-dashboard) untouched. Cons: duplicates auth, retry, redaction,
trace plumbing across both paths.

### (b) Stateless mode on the existing Runtime

Add `query({ messages })` to `LlmProvider` interface. Implementations skip
the internal `messages[]`. Single source of truth; all current `runTurn`
callers keep working. Cons: every implementation (OpenAIProvider,
AnthropicProvider, GeminiProvider) gains a parallel code path.

**Recommendation**: (b). Single source of truth wins long-term; the work is
front-loaded but bounded. Requires test coverage for each provider's
stateless path.

## Tool-action surfacing

Both paths must answer: how does a model's tool intent come out as
`MiniLoopAction[]` instead of being executed in-process?

For OpenAI Responses API and Chat Completions, the API already returns
tool-call objects. The provider just stops calling `ToolHandler` for
mini-loop calls and instead returns the raw tool-call shape. New flag on the
query call: `executeTools: false`.

For Anthropic and Gemini, same idea — return `tool_use` blocks unexecuted.

Required code changes:
- `LlmProvider.query({ messages, executeTools: false })` returns
  `MiniLoopModelResponse` directly.
- Provider implementations skip `toolRuntime.handlers[name](...)` invocation
  when `executeTools === false`.

## ACI executor for the worker

`team-worker.ts` needs a `MiniLoopToolExecutor` that maps action names to
the existing ACI helpers in `packages/orchestrator/src/aci/`:

| action.tool | ACI helper |
|---|---|
| `run_shell` | `execFile`-based shell runner with `cwd`-pinned output capture |
| `read_file` | `aci/file-viewer.ts:openFile` (already 100-line window) |
| `write_file` | `aci/file-editor.ts:editFile` (line-anchored) |
| `apply_patch` | `aci/apply-patch.ts:applyPatch` |
| `search_text` | `aci/search.ts:searchDir` |
| `list_files` | `aci/quick-tools.ts` listing helper |

Path containment via `assertWithinWorkspace` is already wired into each ACI
helper, so the executor inherits the path safety story for free.

## Persona model selection

`MiniLoopConfig` already has `model?: string` and `reasoningEffort?`. The
worker reads `getPersonaConfig(persona).model` and falls back to env
(`UNCLECODE_TEAM_WORKER_MODEL`). Provider auto-detection via the model
string (claude-* → Anthropic, gemini-* → Gemini, gpt-* → OpenAI) is already
in `packages/providers` — reuse it.

## Test plan

- Unit tests with a fake `LlmProvider.query` that returns canned
  `MiniLoopModelResponse` shapes. No real network.
- Integration test gated by `UNCLECODE_TEAM_WORKER_LIVE=1` env that runs
  one tiny task end-to-end against a real model. Skipped in CI by default.
- Cost guardrail: persona budgets already capped via `costLimitUsd`; the
  test must fail if the live test approaches the cap.

## Out of scope for this proposal

- Multi-step worker ↔ coordinator handoff via `team_handoff` checkpoint.
  Today the worker emits one `team_step` per loop iteration and exits.
- Real MMBridge wiring (mmbridge_review / mmbridge_gate) at submission
  time. The hooks exist (`buildMmBridgeHooks`); wiring requires a real
  `MmBridgeClient` (the `McpMmBridgeClient` scaffold was deleted in the
  Task 32 simplify pass and should be re-introduced together with the
  real model client, since both need apps/unclecode-cli plumbing).

## Acceptance criteria

1. `unclecode team run --dispatch --lanes 1 --persona coder "<task>"`
   completes a real loop against a configured provider, with at least
   one `run_shell` action and a `team_step` per step.
2. `team inspect <runId> --verify` reports `Chain: VERIFIED`.
3. Worker exits with the agent's submit marker on the last stdout line.
4. Cost per worker stays within `getPersonaConfig(persona).costLimitUsd`.
5. Unit tests cover at least: model returns no actions (clean exit),
   model returns one action that the executor runs, model exhausts the
   step budget.
