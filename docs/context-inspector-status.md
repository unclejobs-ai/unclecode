# `/context` and Context Lifecycle Ledger — Status

> Last updated: 2026-07-13
> Companion design: [`docs/design/context-inspector-redesign.md`](design/context-inspector-redesign.md)
> Protocol: [`docs/design/crp-context-runbook-protocol.md`](design/crp-context-runbook-protocol.md)

## Current status

The Context Inspector and lifecycle ledger are implemented end to end. `/context`
opens an ephemeral inspector without adding chat history. The inspector reads
from the CRP SQL store, supports cursor navigation and source detail, and applies
pin, unpin, hold-back, include, accept, reject, and undo through the same store
used to assemble the next provider prompt.

The normal collapsed Context panel now includes `Inspect sources · /context`.
The expanded inspector uses `/context` to refresh and Esc to close; Ctrl+O
continues to open the session surface.

## Lifecycle guarantees

Every provider-bound context packet follows this state machine:

```text
previewed A
   │ source mutation
   ▼
invalidated A ──► previewed B ──► submitted B ──► provider invocation
                                      │
                                      ├─► assistant turn / bridge
                                      └─► memory lineage(origin receipt B)

accepted optimizer mutation ──► previewed C
resume ──► invalidated C + exclusion of memory with non-submitted provenance
```

- A preview receipt is written before a provider call and submitted for one
  session and turn before invocation.
- A source mutation invalidates the active preview. The next resolution creates
  a replacement preview.
- Optimizer suggestions are deterministic. Reject is read-only; accept retires
  sibling suggestions and applies the corresponding CRP mutation or refresh.
- Promoted memory requires a submitted receipt from the same session and turn.
- Promotion is atomic across lineage and content persistence. If content
  persistence fails, the new lineage is superseded and its predecessor is
  restored to active in one SQL transaction.
- Resume invalidates stale previews and supersedes active memory whose origin
  receipt is missing, cross-project, or not submitted.
- Late work from an interrupted or superseded turn cannot publish a bridge or
  promote memory.

## Privacy boundaries

`ContextPacketViewItem` is the public UI/provider DTO. Its constructor copies a
fixed allowlist and drops internal source fields, including stored condensed
history metadata and arbitrary future fields.

Receipt `source_refs_json` accepts only:

- `sourceId`
- `category`
- `sha256`
- `trustTier`
- `salience`
- `includedInModel`

Raw source content, labels, reasons, previews, and internal metadata are rejected
at receipt persistence. Context source writes are redacted before SQL storage.
Session snapshots are sanitized before Rust persistence. The end-to-end
lifecycle test scans every text column in `context_sources`,
`context_packet_receipts`, `context_policy_suggestions`, and `memory_lineage`
and rejects the raw secret fixture.

## Performance budgets

`tests/work/context-lifecycle-performance.test.mjs` measures:

| Path | Budget |
|---|---:|
| Cold CRP store creation plus first packet resolve | 1,500 ms |
| Five repeated packet refreshes | 2,500 ms |
| 500-source cold resolve | 3,000 ms |
| Longest instrumented per-turn synchronous wall-time operation | 50 ms |

Large packet-source imports yield between bounded 4-item batches. Resolver
phase boundaries also yield before continuing synchronous SQL-backed work.

## Verification map

| Contract | Primary coverage |
|---|---|
| Receipt state machine and metadata-only persistence | `tests/agentops-db/context-sources.test.mjs` |
| Memory promotion, rollback, and transparency | `tests/context-broker/context-memory.test.mjs` |
| Resume reconciliation and project isolation | `tests/work/work-runtime.test.mjs` |
| Provider preflight, turn cancellation, post-turn ordering | `tests/orchestrator/work-shell-engine.test.mjs` |
| Public packet DTO allowlist | `tests/context-broker/context-packet-view.test.mjs` |
| Full A → B → C lifecycle and secret scan | `tests/work/context-lifecycle.e2e.test.mjs` |
| Cold, refresh, large-source, and event-loop budgets | `tests/work/context-lifecycle-performance.test.mjs` |

## Remaining non-lifecycle polish

The ledger is no longer the blocker for future Context Inspector polish.
Potential follow-up work is presentation-only: a full-height modal layout,
richer held-back explanations, and tighter visual containment for very large
source sets. Those changes must preserve the state, provenance, privacy, and
latency contracts above.
