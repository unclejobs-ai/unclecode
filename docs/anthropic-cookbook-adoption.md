# Anthropic Cookbook adoption matrix

This audit covers the official [Claude Cookbooks repository](https://github.com/anthropics/claude-cookbooks/tree/main), [Claude Cookbook](https://platform.claude.com/cookbook/), and [Korean Claude Platform documentation](https://platform.claude.com/docs/ko/home).

## Architecture boundary

UncleCode remains the only runtime. It owns providers, tools, policy, context, sessions, traces, artifacts, execution, and UI. SCC remains the in-process Quality Engine for PDCA, standards, gates, review, refine/pivot, and evolve. Anthropic Managed Agents, Agent SDK persistence, memory stores, or a second daemon/MCP/event store are not adopted.

## Adoption priorities

| Priority | Official pattern | Current state | UncleCode adaptation | Proof required |
|---|---|---|---|---|
| P0 | Prompt caching and pricing | Cache breakpoints and usage buckets exist; old cost calculation priced all cache tokens as ordinary input | Keep stable prefixes byte-stable; price ordinary input, reads, 5-minute writes, and 1-hour writes separately; add billing reconciliation | Cold/warm multi-turn cache ratio, TTFT, exact provider usage buckets, invoice/Console reconciliation |
| P0 | Automatic compaction and context editing | Context Desk/CRP are inspectable projections, but Anthropic conversation history is still replayed in full | Add provider-side compaction behind a profile flag while keeping UncleCode's durable ledger, SCC graph, approvals, evidence, and artifact hashes authoritative | 50/100/200-turn canary tasks for objective, corrections, paths, failures, approval, stage, and artifact-hash recall |
| P0 | Executable held-out evaluations | SCC gates and 40 case definitions exist; offline fixture scores are not empirical product proof | Generate real artifacts from frozen environments, use deterministic graders first, calibrated blind graders only where necessary, and keep runtime critic evidence separate | 3-5 trials, confidence intervals, domain regression limits, cost/completion, stale-evidence and false-pass rates |
| P0 | Indirect prompt-injection defense | Tool execution is fail-closed and policy-owned; open-world outputs lack generalized trust metadata and screening | Frame source/trust metadata, deterministically screen open-world web/MCP/document output before consequential actions, and preserve policy as final authority | Adversarial repository/web/MCP corpus with attack-success and false-positive rates |
| P1 | Strict tool use | Local schema parsing and policy exist; Anthropic `strict` is not exposed | Enable wire-level strict schemas only for compatible tools; retain local authorization, containment, and semantic validation | Malformed/missing/extra/wrong-enum/path-traversal corpus |
| P1 | Coordinator / evaluator-optimizer | Planner → bounded workers → independent critic → promote already implements the useful pattern | Keep balanced prewalk, isolate role histories, avoid N+1 calls for simple work, and define reviewer independence explicitly | Matched solo/static/dynamic routes with equal rubric, budget, retries, cancellation, quality, latency, and cost |
| P2 | Tool search | Current core tool catalog is small | Add only when plugin/MCP schema tokens make deferred loading measurably cheaper; do not create an SCC registry | 12/100/500/1000-tool selection accuracy, schema tokens, search calls, cache stability, p95 latency |
| P2 | Programmatic tool calling | Not shipped; a bounded local design exists | Experimental read-only/idempotent high-fanout path only, with `allowed_callers`, full nested traces, retention gating, timeout/output caps, and no write/shell/approval tools | Direct-vs-PTC deterministic workloads, 100% trace and blocked-tool coverage, secret-leak and cleanup checks |

## Rejected cargo-cult patterns

- Cache hits do not reduce context-window usage; caching is not compaction.
- A model-generated program is not a security sandbox.
- A different model name alone is not independent review evidence.
- Cookbook cost or latency ratios are examples, not UncleCode product claims.
- Evaluators cannot change their evaluator, policy, benchmark, or acceptance rubric and then approve themselves.
- PTC cannot call write, delete, shell, approval, promotion, credential-bearing, or nested-agent tools.
- Compaction cannot delete the durable audit trail or SCC evidence needed to invalidate stale verdicts.

## Release rule

A pattern is enabled by default only when its held-out comparison improves the targeted quality/cost/latency metric, introduces no domain regression beyond the configured threshold, preserves policy and evidence invariants, and records its provider/runtime trace in UncleCode-owned storage. Otherwise it remains experimental or is removed.
