# UncleCode Quality Engine compatibility matrix

UncleCode owns execution, providers, tools, policy, context, sessions, traces, artifacts, and user interfaces. Second Claude Code (SCC) supplies host-neutral PDCA and quality decisions through the built-in **Quality Engine**. UncleCode does not start an SCC MCP server, daemon, event log, or `.data` store.

## Supported combinations

| UncleCode | SCC component | Status | Integration boundary |
|---|---|---|---|
| `0.1.x` integration branch | `@second-claude/core` `4.0.0` | Supported and pinned | Prebuilt tarball at `vendor/second-claude/second-claude-core-4.0.0.tgz` |
| `0.1.x` integration branch | SCC Claude/Codex v4 adapters | Supported outside UncleCode | Adapters call the same core; UncleCode still uses its built-in integration |
| `0.1.x` integration branch | SCC v3 `.data` | Read-only migration preview | `npm run scc:import-v3:dry-run -- --source <path> --workspace <path>` |
| `0.1.x` integration branch | SCC v3 MCP/daemon inside UncleCode | Not supported | Would create a second runtime and duplicate persistence |

Pinned core SHA-256:

```text
a541566920e0326d66dd2204cb3331d717e73f64da60608b879bfd5f9c8673d7
```

The package is installed from built bytes and does not compile during installation. For local SCC development, build and pack SCC first, then use `SECOND_CLAUDE_CORE_TARBALL=<tarball> npm run core:use-local`. The override is intentionally non-persistent.

## Runtime behavior

| Concern | Owner | Contract |
|---|---|---|
| Plan/Do/Check/Act and quality decisions | Quality Engine (`@second-claude/core`) | `minimal`, `standard`, `deep`, and `creator` profiles; `explore`, `plan`, `work`, `critic`, and `promote` stages |
| Work graph, routing, lifecycle, and recovery | UncleCode orchestrator | Decision hooks run for every turn, including direct/minimal turns |
| Models and providers | UncleCode providers | Balanced prewalk records frontier, commodity, critic, and fallback routes; fallback-only review is `unproven` |
| Security approval | UncleCode policy engine | Separate from quality gates and user product decisions; the web control room cannot widen policy |
| Session and trace persistence | UncleCode session-store and agentops-db | No SCC JSONL or `.data/pdca-active.json` is created by UncleCode |
| Run artifacts | UncleCode workspace | `.unclecode/artifacts/<run-id>/`; verdict evidence is bound to artifact hashes |
| TUI and web | UncleCode | Same runtime projection; web is analysis/control, TUI is the primary work surface |

`promote` is a completion and handoff stage. It does not deploy, push, merge, publish, or release. Main-branch merge and release remain human-approved operations.

## SCC v3 migration preview

The importer is deliberately dry-run only:

- recursively inspects regular files under the selected `.data` directory with bounded file, directory, and byte limits;
- rejects symbolic links and paths that escape `.data`;
- maps legacy phases, gates, reviewer evidence, event counts, and artifact hashes into planned UncleCode session-store, agentops-db, and artifact records;
- marks Check/Act records without reviewer evidence as `unproven`;
- rejects external artifact references, conflicting target records, malformed records, and oversized inputs instead of producing a partial plan;
- emits a deterministic agentops migration receipt plan that skips an identical receipt and rejects target collisions;
- never includes raw artifact or event payloads in its report and retains only bounded event counts;
- fingerprints the source tree before and after inspection and reports whether it remained unchanged;
- has no `--apply` mode and writes neither the source nor the destination.

Use `--json` to obtain the versioned `unclecode.scc-v3-import-plan/v1` report. Redirecting stdout is the caller's explicit responsibility and is not an importer-side mutation.

## Release gate

An integration release requires all of the following from the exact pinned artifacts:

1. SCC core and adapter tests, UncleCode Node tests, Rust tests, type checks, build, and UI smoke tests pass.
2. The shared SCC core contract fixture passes in both repositories.
3. Quality traces prove lifecycle stage, route, reviewer identity, and artifact freshness; missing independence is visible as `unproven`.
4. Stop-hook failures identify the owning external plugin and exact diagnostic payload; the built-in Quality Engine is not reported as an SCC workspace hook.
5. No unauthorized external write, deployment, main push, merge, or release occurs.
6. Held-out quality/cost targets are reported separately. They are not inferred from unit tests and cannot be claimed without the configured providers and benchmark corpus.
