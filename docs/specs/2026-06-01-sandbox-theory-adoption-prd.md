# UncleCode Sandbox Theory Adoption PRD

> Date: 2026-06-01
> Status: active `/goal` execution contract
> Owner: UncleCode runtime/orchestrator
> Scope: policy-first sandbox theory, not a wholesale OpenShell dependency

## Summary

UncleCode should adopt sandbox theory as a product and runtime discipline:
the orchestrator plans and explains work, but every meaningful side effect
passes through an explicit execution policy boundary. This PRD defines the
target model, staged rollout, and continuation hook for implementing that
boundary without breaking the default fast local workflow.

This is inspired by OpenShell's core ideas - default-deny execution,
filesystem/network/credential/inference separation, policy denial visibility,
and operator approval loops - but it is not a request to replace UncleCode's
TUI, session center, provider runtime, or team orchestration with OpenShell.

## Problem

UncleCode already has strong orchestration primitives:

- Rust-native CLI and work shell migration
- provider loops for OpenAI, Anthropic, and Gemini
- team worker lanes and runtime modes
- ACI tools for file, shell, search, and patch operations
- trace contracts and session persistence

The missing product layer is a unified model for what an agent is allowed to do.
Today, local speed and tool execution are productive, but the system does not
present one canonical policy contract that covers shell execution, filesystem
mutation, network egress, credentials, and inference routing.

As UncleCode adds team workers, delegated runtimes, and optional hardened
sandboxes, the risk increases:

- a worker can run shell commands with too much implicit trust
- side effects are harder to explain after context compaction
- network and credential behavior is not visible as a first-class capability
- future Docker/OpenShell/E2B modes can diverge unless the policy model is
  defined before adapters grow

## Goals

1. Define a canonical execution policy vocabulary across filesystem, shell,
   network, secrets, and inference.
2. Make denials visible as high-signal trace events instead of generic errors.
3. Keep default local UncleCode fast while adding audit/enforce rollout modes.
4. Allow future runtime backends such as OpenShell without binding UncleCode core
   to OpenShell alpha APIs.
5. Give future agents a compact continuation hook that survives context
   compaction and points to the next checklist item.

## Non-Goals

- Do not reintroduce legacy hidden `superpowers` auto-loading or meta-skill
  execution. The repo explicitly removed that behavior.
- Do not make `unclecode work` sandbox-only by default.
- Do not replace the current TUI/session center/orchestrator surfaces.
- Do not add new dependencies in the initial contract slice.
- Do not claim strong OS-level security from TypeScript-only checks.
- Do not implement an OpenShell adapter before the policy and trace contracts
  are stable.

## Product Principles

- Default fast path stays local.
- Risky work gets explicit runtime and capability labels.
- Denials are actionable: capability, reason, matched rule, and remediation path.
- Policy is append-only and auditable where possible.
- Runtime adapters enforce; orchestrator and TUI explain.
- A compacted context can resume from documents and goal state, not hidden
  prompts.

## Users

- Primary developer: wants UncleCode to stay fast for normal repo work.
- Operator: wants to see and approve risky side effects.
- Team-run conductor: wants worker isolation and reproducible checkpoints.
- Future hardened-runtime user: wants Docker/OpenShell-style sandboxing for
  high-risk tasks or external API work.

## Capability Model

The initial capability set is intentionally small and stable:

- `filesystem.read`
- `filesystem.write`
- `shell.run`
- `network.egress`
- `secret.read`
- `inference.request`

These capabilities map onto OpenShell-style policy domains while staying native
to UncleCode:

- Filesystem: read/write path access and workspace boundaries.
- Shell/process: command execution, timeout, output caps, and runtime mode.
- Network: host/method intent, provider endpoints, and future egress gates.
- Secrets: credential lookup, injection, redaction, and raw-key exposure.
- Inference: provider calls, model routing, proxy policy, and local model paths.

## Runtime Model

Runtime modes should be treated as execution backends, not agent identities.

- `local`: default fast path.
- `docker`: existing container escalation path.
- `e2b`: existing declared but unsupported future mode.
- `openshell`: future declared backend for OpenShell-managed sandboxes.

The first slice only declares `openshell` as a recognized runtime seam. It must
fail closed until an adapter exists.

## Policy Modes

- Audit: record capability use and denials but avoid blocking the default local
  path.
- Prompt: ask the operator before widening a capability.
- Enforce: deny by default unless a rule matches.

The policy engine can continue using existing `allow | prompt | deny` decisions.
The execution policy contract adds capability-specific context around those
decisions.

## Required Trace Behavior

Policy denials must emit `policy.denied` as a high-signal event with:

- capability
- reason
- matched rule
- source
- runtime mode
- optional tool name
- optional request id
- timestamp

This lets the TUI, session logs, and future handoff summaries distinguish an
expected security denial from a broken tool.

## UX Requirements

- The operator should see: what was blocked, why, and what can be approved.
- The agent should receive a concise, non-leaky denial observation.
- The transcript must not expose raw secrets or internal policy state dumps.
- The status/trace surfaces should prefer one-line summaries first, with detail
  available through panels or logs.

## Implementation Phases

### Phase 0 - Contract and Handoff

- [x] Create this PRD.
- [x] Create a goal checklist with a context resume hook.
- [x] Add canonical execution capability and policy profile types.
- [x] Add `policy.denied` trace contract.
- [x] Declare `openshell` as a future runtime seam that fails closed.
- [x] Add targeted contract/runtime tests.

### Phase 1 - Audit Instrumentation

- [x] Emit policy observations around `run_shell`.
- [x] Emit policy observations around write/apply-patch paths.
- [x] Add team-step metadata for policy denials.
- [x] Add TUI copy for concise denial display.

### Phase 2 - Enforcement Boundary

- [x] Route team mini-loop ACI tool execution through an optional policy
  evaluator.
- [x] Add filesystem read/write path rule matching.
- [x] Add shell command capability matching.
- [x] Keep local mode permissive by default but observable.
- [x] Wire a concrete profile into production team mini-loop callsites.

### Phase 3 - Runtime Backends

- [x] Add an `OpenShellAdapter` design doc before code.
- [x] Add an `OpenShellAdapter` spike behind a feature flag.
- [x] Keep `openshell` mode adapter-unavailable until configured.
- [x] Add policy translation notes for OpenShell YAML.
- [x] Validate file sync hooks, provider credential flags, and command execution
  latency through a fake OpenShell CLI lifecycle test.

### Phase 4 - Approval Loop

- [ ] Add durable policy revision records.
- [ ] Add operator approval UI for blocked capabilities.
- [ ] Add retry semantics after approval.
- [ ] Add rollback/reset guidance for widened policy.

## Acceptance Criteria

- Contract tests expose the capability vocabulary and trace event type.
- Runtime tests prove `openshell` mode is recognized, fails closed without
  explicit config, and never falls back to local execution when the OpenShell
  CLI or sandbox lifecycle fails.
- Team runtime constants can carry `openshell` without dispatching it yet.
- The PRD and checklist are enough to resume work after context compaction.
- No hidden superpowers workflow is reintroduced.

## Risks

- Too much enforcement too early will slow normal UncleCode use.
- Adapter work before policy contracts will create runtime-specific drift.
- Treating TypeScript checks as a security sandbox would be misleading.
- OpenShell alpha churn can leak into UncleCode if used as a core dependency.

## Decision

Proceed with sandbox theory as a first-class UncleCode direction. Implement the
contract and observability seam first, then enforce progressively. Keep OpenShell
as an optional hardened backend candidate, not the default runtime.
