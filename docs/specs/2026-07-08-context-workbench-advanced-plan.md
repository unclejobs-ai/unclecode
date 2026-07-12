# Context Workbench Advanced Plan

Date: 2026-07-08
Status: Research-backed implementation plan

## Decision

UncleCode `/context` should become a next-provider-request control surface, not a decorative dashboard. The user should be able to inspect what will reach the model, mutate source visibility, and receive proof that the next prompt changed.

## External Patterns

- `ctx-forge`: live prompt preview, fuzzy file inclusion, exclude-aware assembly, and token hotspot warnings.
- `pi-context-tree`: reversible crop/branch/merge, top context consumers, and a health gauge with source attribution.
- `agentmemory`: context injection is explicit opt-in and budgeted, not silently appended to every turn.
- `agent-context-budget`: preflight keep/summarize/drop recommendations with duplicate and low-signal detection.
- GitHub Copilot CLI: `/context` breaks the window into prompt, tools, messages, free space, and buffer.

## Product Rules

- The product object is the next provider-request packet.
- Preview must be generated from the same formatter used for provider prompt injection.
- Source action labels are allowed only when the key path mutates CRP state and the next provider prompt.
- Every source mutation needs a receipt with source id, action, resulting packet id, and undo availability.
- Token displays must distinguish exact, estimated, and unknown.
- Raw ledgers, secrets, and verbose evidence stay local unless explicitly included.

## Current Baseline

- `ContextPacketView.preview` is formatter-derived, so `/context` preview and provider prefix share one source.
- Work Shell bootstrap uses CRP-backed packet resolution through `context_sources`.
- Work Shell exposes a CRP mutator for `pin`, `unpin`, `forget`, and `include`.
- AgentOps migrations initialize context source tables and redaction covers Google `AIza...` keys.

## Next Implementation Slices

1. Add source-action receipts with before/after state and packet id transition.
2. Surface only wired action keys in the TUI workbench; no decorative include/exclude labels.
3. Add packet invalidation UI when submit refreshes away from the inspected packet.
4. Add budget lane attribution: top token consumers, unknown estimate count, stale/expired count.
5. Add preflight copy: keep, summarize, hold back, and why.

## Acceptance Tests

- Bootstrap context packets have `crp-...` ids.
- `forget` removes a source from `formatContextPacketPromptPrefix`; `include` restores it.
- Raw `.omo` ledger content never appears in provider prompt.
- Missing token estimates never render as fake `~0t`.
- Source action keys are absent unless a mutator exists.
