# Task 10 report — exact replay, bounded caches and memory evidence

- Date: 2026-08-30
- Implementation snapshot: `5d91eafd`
- Status: complete; the 100,000-event production-shaped scale target passed

## Outcome

The persistent UncleCode owner now uses durable indexed state for exact mutation, event and usage identity. Bounded hot journals and LRUs improve responsiveness but never decide correctness: eviction or a miss falls through to the authoritative SQLite ledger. Exact identity reuse with a changed payload/scope fails closed.

Cache observability now uses one bounded contract for hits, misses, evictions, invalidations, current entries, configured entry/byte limits and estimated retained bytes. The owner projects only summaries into System/TUI/web; it does not project keys, prompt bodies, tool output or secrets.

This work remains inside the hierarchy:

```text
persistent UncleCode runtime owner
  -> exact durable ledger + bounded hot indexes
  -> session/orchestrator/SCC state
  -> read-only System/TUI/web telemetry
```

No SCC runtime, cache daemon or client-owned correctness store was added.

## Exact replay and idempotency

- `runtime-ledger.ts` performs atomic mutation admission with canonical bounded fingerprints, one accepted revision, durable completion receipts, exact replay and changed-payload rejection.
- Crash-window admissions recover as `in_doubt`; they are not re-executed until an explicit safe reopen path accepts them.
- Usage events are atomically materialized into main/agent/route totals with an exact indexed event identity. Bounded Agent Console projections no longer retain `eventIds` arrays.
- Legacy/resumed projections retain totals without reminting event identities. Duplicate usage after owner reopen does not increment counters.
- The event journal persists sequence and replay watermarks. `Last-Event-ID` replay survives owner restart; old or future cursors return typed expiry information rather than silently dropping events.
- The in-memory SSE journal is a bounded ring. Publication remains constant bounded work after wraparound, and subscriber cleanup is observable.

Primary implementation commits include:

- `056912c` — reconnect-safe SSE replay.
- `26b4ee8` — durable SSE replay and restart sequence.
- `75077f6` — durable mutation receipts.
- `7961242` — exact durable usage identity and bounded projection.
- `0715034`, `a1d0087` — cache instrumentation, byte bounds and owner projection.

## Cache ownership and bounds

The shared telemetry contract is applied to provider derivations, workspace guidance/skills/repo maps, owner/runtime indexes and the cache summaries consumed by the control room. Additional hardening covers extension/slash/LSP state and local TUI caches.

Relevant late hardening:

- `056237e` coalesces identical repo-map misses and uses bounded backpressure; older completions cannot replace a newer generation.
- `2b01202` bounds LSP input buffering linearly.
- `a7ae07b` adds retained-byte budgets and oversized bypass for work-shell text/wrap caches.
- `f2c5296` prevents the markdown cache from retaining arbitrarily large React render trees.
- `4bd68f0` reports aggregate cache-source failures honestly instead of presenting incomplete telemetry as complete.

The TUI markdown regression that motivated the final byte cap retained about 134.7 MiB of heap when 64 one-MiB fenced inputs were admitted. The repaired caches bypass entries that exceed their budget and enforce both count and byte limits; the pathological input is covered by forced-GC tests.

## Scale and exactness evidence

The committed tests cover:

- 10,000 exact usage identities, duplicate and changed-payload attempts, owner close/reopen and a checkpoint projection below 4 KiB with no `eventIds` array;
- 10,500 completed mutation receipts replayed from SQLite after reopen under disk/heap bounds;
- 10,000 exact usage events materialized into all counter vectors;
- 20,000 durable SSE events with a 64-entry hot view, typed expired/ahead cursors, restart continuation and 100 reconnects returning active subscriptions to zero;
- 50,000 ring-buffer overwrites after a 10,000-entry fill with bounded per-event work;
- 10,000-operation LRU churn and oversized-entry rejection for retained-byte telemetry;
- repo-map cache churn, in-flight coalescing, different-head ordering and large-map byte estimation.

The Task 10 brief also requested one production-shaped path with at least 100,000 exact event publications. The final run used the same runtime-owner/cache/plugin/SSE soak and raised only `usageEvents` to `100000`:

```text
node --expose-gc --disable-warning=ExperimentalWarning --conditions=source --import tsx --input-type=module --eval 'import("./scripts/runtime-qa/runtime-memory-soak.mjs").then(async ({runRuntimeMemorySoak}) => { const report = await runRuntimeMemorySoak({ usageEvents: 100000 }); process.stdout.write(JSON.stringify(report) + "\n"); })'
```

It completed in 17.7 seconds with 100,000 exact recorded identities, 300,000 input tokens, 64 agent aggregates, one route aggregate and a 12,439,552-byte SQLite database. The duplicate sentinel remained a duplicate and the materialized totals matched exactly.

## Runtime memory and cleanup soak

Command shape:

```text
node --expose-gc --disable-warning=ExperimentalWarning --conditions=source --import tsx scripts/runtime-qa/runtime-memory-soak.mjs
```

The final production-shaped scale soak uses 768 owner sessions, 128 SSE reconnects, 1,500 cache writes, 100,000 exact usage events and 512 plugin reloads. Recorded forced-GC evidence:

| Measurement | Result | Bound/result |
| --- | ---: | --- |
| Heap delta | +2,511,800 bytes | under 32 MiB forced-GC bound |
| Active handles | 2 -> 2 | delta 0 |
| File descriptors | 13 -> 13 | delta 0 |
| Retained owner sessions before stop | 256 / 768 created | at configured cap |
| Retained owner sessions after stop | 0 | pass |
| Active SSE subscribers after reconnect cycle | 0 | pass |
| Plugin active registrations after unload/dispose | 0 | pass |

Cleanup confirmed owner stop, closed endpoint, removed lease, removed temporary root and removed temporary database. Created engines were disposed and no engine subscribers remained.

## Security and privacy

- Fingerprints are canonical and size-bounded; client-provided data cannot create an arbitrary durable identity blob.
- Telemetry includes counts and retained-byte estimates, never cache keys or values.
- System projections are bounded/redacted and distinguish unavailable/partial evidence.
- SQLite paths, tokens, plugin diagnostics and context transport have independent containment/redaction rules; Task 10 does not weaken them.

## Limitations carried to final matrix

1. The forced-GC figures are one recorded local run, not a cross-platform performance guarantee.
2. Final immutable-archive full-suite and independent-review evidence is recorded in Task 11, not inferred from the focused scale tests here.
