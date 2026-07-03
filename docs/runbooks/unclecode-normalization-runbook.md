# UncleCode Normalization Runbook

Last validated: 2026-07-03 KST (partial — see Known issues below)

## Purpose

UncleCode's operating target is a coding tool with inspectable memory and context, not a black box. The canonical user-facing object is the next model-call context packet; all memory, OMO goal state, research artifacts, team traces, and agent operations must either be included with a reason or excluded with a reason.

## Current Health Checks

Run these from the repository root:

```bash
npm run qa:health
```

### QA surface map

| Entry script | Role | Supporting modules |
| --- | --- | --- |
| `scripts/unclecode-health-qa.mjs` | Compact fail-fast gate (`npm run qa:health`, alias `npm run qa:stability`) | `scripts/health-qa/runner.mjs` (bounded subprocess + process-tree kill), `process-tree.mjs`, `timeout-watchdog.mjs`, `summary.mjs` |
| `scripts/unclecode-runtime-qa.mjs` | Local fake-provider + tmux/tty Work Shell smoke (`npm run qa:runtime`) | `scripts/runtime-qa/constants.mjs`, `cli-helpers.mjs`, `fake-{gemini,openai,anthropic}-server.mjs`, `provider-smokes.mjs`, `tty-smoke.mjs`, `tmux-helpers.mjs`, `tui-suite-smokes.mjs`, `tui-{basic,context-contrast,korean,real-use,slash-latency}-smoke.mjs`, `report-evidence.mjs` |
| `scripts/unclecode-live-provider-qa.mjs` | Real-provider smoke with redaction (`npm run qa:live`, `npm run qa:live:record`) | `scripts/unclecode-live-provider-qa-lib.mjs`, `scripts/live-provider-qa/tool-smoke.mjs` |
| `scripts/qa/web-terminal-visual-qa.mjs` | Converts tmux/ANSI captures to HTML for manual visual review (not part of `qa:health`) | Used by contract tests and operator debugging |

Evidence artifacts:

- `.unclecode/qa/runtime-qa-latest.json` — tool-call pairing, TUI contrast/idle/latency booleans
- `.unclecode/qa/live-provider-latest.json` — text smoke, marker-backed tool smoke, auth recovery fields

Contract tests locking the harness: `tests/cli/health-*.test.mjs`, `tests/cli/runtime-*.test.mjs`, `tests/cli/live-*.test.mjs`, `tests/cli/stability-script.test.mjs`, `tests/contracts/terminal-visual-qa.contract.test.mjs`.

Expected baseline:

- `qa:health` is the compact one-command operational gate. It prints one summary line per check while still running the CLI version check, Node version check, `doctor`, `doctor --json`, MCP list, research status, type check, lint, Work/CLI/TUI tests, local runtime QA, live provider recording, native ABI self-recovery, and whitespace diff check.
- `qa:health` must be bounded: every child check runs through the shared health runner with `DEFAULT_CHECK_TIMEOUT_MS`, reports `timed out after ...ms` on timeout, terminates the child with `SIGTERM` then `SIGKILL`, and treats timeout or signal termination as failure instead of coercing it to exit 0.
- `qa:stability delegates to qa:health`; keep it as an alias instead of a separate command chain so the doctor JSON contract, live marker contract, and native ABI recovery cannot drift.
- `doctor` reports PASS for mode, runtime, session store, MCP host, and team runs. Auth can report WARN when saved Codex OAuth exists but model-call API readiness is not available; that state must remain visible rather than being treated as a pass.
- `mcp list` includes project-local `mmbridge`.
- `research status --json` reports the workspace root and profile, and does not need to start MCP servers just to show status.
- `node-version-check` accepts the current Node when it satisfies `engines.node`.
- `qa:runtime` builds the Rust CLI, starts local Gemini-compatible, OpenAI-compatible, and Anthropic-compatible providers, drives the real `bin/unclecode.cjs work` prompt path, verifies full tool-call loops for Gemini (`functionCall` -> local `run_shell` -> paired `functionResponse` -> final answer), OpenAI Chat (`tool_calls` -> local `run_shell` -> paired `tool` message -> final answer), and Anthropic Messages (`tool_use` -> local `run_shell` -> paired `tool_result` -> final answer), drives an interactive Work TTY through `/status`, `/context`, and an assistant response, asserts 100-column display width, prints a compact operator summary by default, and writes the latest full evidence report to `.unclecode/qa/runtime-qa-latest.json`. The report includes `evidence.providerToolCalls`, `evidence.tui`, and `evidence.context` so tool-call, render, and context transparency checks are machine-readable without mining raw request logs. `evidence.tui.lightTerminalContrast=true` is required; it comes from an ANSI-preserving tmux capture and proves full-screen foreground colors remain readable on a white terminal background. `evidence.tui.idleStable=true` is required; it compares two real tmux captures after the prompt deck returns to idle, normalizing only volatile reply-age text, so residual screen churn remains visible. `evidence.tui.latencyOk=true` is required; the real-use TUI smoke measures first-reply and queued-follow-up latency against the configured runtime budget so slow-path regressions are visible in the report. Each provider entry must include `protocolPaired=true` to prove the tool result belongs to the issued tool call and `finalAnswerGatedByToolResult=true` to prove the provider only returned the final answer after observing the local `run_shell` result. For Gemini specifically, the paired `functionResponse` must preserve both the call id and the function name, for example `functionResponseIdMatched=true` and `functionResponseNameMatched=true`; the function name must remain `run_shell`, not the generated call id. Use `node scripts/unclecode-runtime-qa.mjs --json` only when the full report is needed on stdout.
- A healthy local runtime summary includes `geminiTool=true`, `openaiTool=true`, `anthropicTool=true`, `toolFinalGate=true`, `lightContrast=true`, `duplicateBusy=false`, `queueDrain=true`, `resize=true`, `idleStable=true`, and `latencyOk=true`; those booleans are runtime evidence, not static configuration claims. The `toolFinalGate=true` signal proves all local provider final answers were gated by observed `run_shell` results, while the `duplicateBusy=false`, `queueDrain=true`, `resize=true`, `idleStable=true`, and `latencyOk=true` signals keep flicker/regression, prompt queue draining, terminal resize handling, post-reply idle stability, and slow-path regressions visible in `qa:health` instead of hiding them inside the JSON report.
- `qa:live:record` runs the real provider smoke with loaded `.env`, redacts credential-looking output, writes `.unclecode/qa/live-provider-latest.json`, and prints a compact operator summary by default. It reads `auth status --json` plus `doctor --json`, records blocked credential state without failing the shell, including `doctorAuth.auth.apiReady`, `doctorAuth.auth.recovery.reason`, `doctorAuth.auth.recovery.commands`, `doctorAuth.auth.recovery.verify`, `credentialRecovery.reason`, `credentialRecovery.authStatus`, and exact verification commands when auth is not API-ready. If structured auth says `apiReady=false`, the live text call is preflight-skipped with `textSmoke.work.stderr` set to `Skipped live provider call: auth-preflight-blocked`; this keeps blocked auth fast and explicit instead of spending time on a doomed model request. In `qa:health`, this appears as `liveRecovery=refresh credentials then npm run qa:live` so the operator can distinguish external auth blocking from UncleCode tool-call regressions. The report must always carry per-run proof fields under `toolCallSmoke.runId`, `toolCallSmoke.expectedText`, and `toolCallSmoke.markerPath`, even when text smoke blocks before tool execution. When credentials are API-ready, the report must pass both `textSmoke` and marker-backed `toolCallSmoke`; `toolCallSmoke.markerMatched: true` plus the per-run `toolCallSmoke.runId` marker proves the model actually used `run_shell` for this run instead of merely echoing expected text or reusing stale marker state. Use strict `npm run qa:live` when credentials are expected to pass, and use `node scripts/unclecode-live-provider-qa.mjs --json` only when the full live report is needed on stdout.
- If live OpenAI is blocked by Codex OAuth, the expected reason is `openai-oauth-codex-runtime-not-api-ready`; that is an external auth readiness state, not a local tool-call regression.
- `auth status --json` and `doctor --json` expose machine-readable auth readiness under `apiReady` / `auth.apiReady`, alongside `source` / `auth.source`, `type` / `auth.type`, `runtime` / `auth.runtime`, and `expired` / `auth.expired`. When readiness is false, `auth status --json` exposes `auth.recovery.reason`, `recovery.reason`, `recovery.commands`, and `recovery.verify`; `doctor --json` exposes the same recovery contract under `auth.recovery.reason`, `auth.recovery.commands`, and `auth.recovery.verify`, which live QA stores as `doctorAuth.auth.recovery.reason`, `doctorAuth.auth.recovery.commands`, and `doctorAuth.auth.recovery.verify` so automation and operators can use structured recovery steps instead of parsing human auth labels.
- For OpenAI, saved Codex OAuth can authenticate the app but still be `api ready: no` / `"apiReady": false` for model calls. API-ready OAuth requires browser OAuth with `OPENAI_OAUTH_CLIENT_ID` and `model.request`, or an API key through `unclecode auth login --api-key-stdin` / `OPENAI_API_KEY`.
- Plain `unclecode auth login` must not silently create Codex-derived device OAuth credentials. Use `unclecode auth login --device` only when that non-API-ready risk is intentional; otherwise use `OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser` or `unclecode auth login --api-key-stdin`.
- In the TUI, non-API-ready OAuth is surfaced as `oauth-file-api-blocked` / `OAuth blocked`; treat that as an auth recovery state, not a local tool-calling regression. The expected recovery remains API-ready browser OAuth with `OPENAI_OAUTH_CLIENT_ID`, `unclecode auth login --api-key-stdin`, or `OPENAI_API_KEY`.

If `qa:health` or `tests/context-broker/context-memory.test.mjs` fails with `ERR_DLOPEN_FAILED` and `better-sqlite3` reports a different `NODE_MODULE_VERSION`, rebuild the native module for the current Node and rerun the compact gate:

```bash
npm rebuild better-sqlite3
npm run qa:health --silent
```

### Validation record (2026-07-03 KST)

Run on dirty worktree at commit `0998d43`, Node v22.22.0, macOS host, duration 85.8s.

| Check | Result |
| --- | --- |
| cli version | PASS |
| node version | PASS |
| doctor / doctor json | PASS (auth WARN: saved Codex OAuth, `apiReady=false`) |
| mcp list | PASS |
| research status | PASS |
| typecheck | PASS |
| lint | PASS |
| work / cli / tui tests | PASS |
| runtime QA | **FAIL** |
| live provider QA | **Not run** (fail-fast after runtime QA) |
| diff whitespace | **Not run** (fail-fast) |

## Known issues (2026-07-03)

### Runtime QA — full-screen TUI foreground contrast

`npm run qa:health` fails at the runtime QA step with:

```
AssertionError [ERR_ASSERTION]: full-screen header should use an explicit readable foreground instead of inheriting a potentially faint terminal default
  at runFullTuiSmoke (scripts/runtime-qa/tui-basic-smokes.mjs:56)
  expected: /\x1b\[38;2;15;23;42mUncleCode ·/
```

The tmux ANSI capture shows the header line rendered without the expected truecolor foreground escape (`38;2;15;23;42m`, slate `#0f172a`). Unit and contract TUI tests still pass; the regression is visible only in the tmux capture gate inside `scripts/runtime-qa/tui-basic-smokes.mjs`.

**Operator impact:** `qa:health` cannot fully pass until TUI header/body paint explicit readable foregrounds on full-screen Work Shell, or the smoke expectations are intentionally revised to match a new rendering strategy.

**Workaround for other checks:** Run individual gates that passed above, or `npm run qa:runtime` after fixing the TUI paint path.

### Live provider QA — not exercised in 2026-07-03 gate run

Because `qa:health` fails fast, `qa:live:record` did not run in the 2026-07-03 validation. Re-run manually when credentials are ready:

```bash
npm run qa:live:record
cat .unclecode/qa/live-provider-latest.json
```

With saved Codex OAuth locally, expect auth preflight skip (`auth-preflight-blocked`) rather than a tool-call failure.

## Relationship to the Runbook product repo

UncleCode and the separate **Runbook** product (`~/project/runbook`, package candidate `runbookdb`) both address “what did agents do?”, but at different layers and maturity stages.

**Runbook (external product repo)** is a local-first AgentOps DB: SQLite ledger at `~/.runbook/runbook.db`, dashboard-first UX, task → run → lane → event → artifact → verification workflow, wrapper CLI for external commands, importers for team-run folders, and a planned MCP server. That repo is currently architecture/discovery scaffold — not wired into UncleCode’s runtime.

**UncleCode built-in AgentOps (`packages/orchestrator/src/agentops-recorder.ts`)** records Work Shell sessions into the in-repo `@unclecode/agentops-db` package (redacted SQLite under the agentops home dir). It is non-blocking: recorder failures must not break the work shell. Data captured includes project id (hash of workspace root), run lifecycle, and prompt-turn summaries — scoped to UncleCode work sessions, not cross-tool wrapper invocations.

**Boundary today:** No automatic sync between `~/.runbook/runbook.db` and UncleCode’s agentops DB. UncleCode does not depend on the Runbook product repo. Operators inspecting Work Shell history use agentops-db paths and JSON/doctor surfaces; operators wanting a cross-agent dashboard would use Runbook once implemented.

**Recommendation:** Treat Runbook as the cross-agent, human-dashboard ledger; keep UncleCode’s recorder as the session-scoped, redacted, fail-open telemetry for the Work Shell turn loop. If integration is desired later, prefer a one-way exporter/importer (Runbook indexing UncleCode agentops artifacts) rather than merging schemas prematurely. Document any shared field names (run id, lane, verification status) at the exporter boundary only.

## Source-Of-Truth Map

Context packet assembly:

- `packages/context-broker/src/context-packet.ts` builds the repo map, selected context files, policy signals, token budget, and freshness gate.
- `packages/context-broker/src/context-packet-view.ts` formats the model-facing preview and compact TUI indicators.
- `apps/unclecode-cli/src/work-runtime-bootstrap.ts` merges workspace guidance, bridge lines, scoped memory, runtime trace lines, and OMO summaries into the Work Shell context view.

Memory and runbook storage:

- `packages/context-broker/src/context-memory.ts` owns session/project/user/agent scoped memory writes and reads.
- `packages/memory-bus/src/procedural-store.ts` stores procedural runbooks under `.unclecode/sop/<peer>/<slug>.md`.
- `packages/memory-bus/src/dialectic.ts` synthesizes cited answers from procedural memory, external docs, and adapter-backed episodic/semantic memory.
- `packages/contracts/src/ssot.ts` defines citation categories and versioned references for non-black-box claims.

OMO and evidence:

- `.omo/ulw-loop/<session-id>/goals.json` is structured goal state.
- `.omo/ulw-loop/<session-id>/ledger.jsonl` and evidence transcripts remain local raw artifacts.
- `packages/context-broker/src/omo-context.ts` includes only active goal and criterion summaries by default, and reports ambiguity when multiple OMO sessions are active.

Team and Hermes lanes:

- `packages/orchestrator/src/team-adapters/hermes-adapter.ts` routes Hermes lanes through `acpx`.
- `references/hermes/team-coder-skill.md` and `references/hermes/team-builder-skill.md` define operator handoff contracts and standard artifact read order.
- `packages/orchestrator/src/team-runner.ts` records team-run lifecycle checkpoints and worker output.

Agent operations:

- `packages/orchestrator/src/agentops-recorder.ts` records work-shell runs and prompt-turn events, redacting secrets before storage.
- The recorder is intentionally non-blocking; failures must not break the work shell.

## Operating Loop

1. Start with visible state, not assumptions:

```bash
git status --short --branch
node bin/unclecode.cjs doctor
node bin/unclecode.cjs doctor --json
node bin/unclecode.cjs research status --json
omo ulw-loop status --json
```

2. If a Codex goal is active but OMO says `ULW_LOOP_PLAN_MISSING`, create the OMO plan for that same goal before recording evidence:

```bash
omo ulw-loop create-goals --brief "<brief>" --json
omo ulw-loop complete-goals --json
```

3. Verify the transparency surfaces:

```bash
npm run test:memory-bus
npm run test:context-broker
node --conditions=source --import tsx --test \
  tests/orchestrator/team-adapters/hermes-adapter.test.mjs \
  tests/orchestrator/team-multi-runtime.e2e.test.mjs \
  tests/orchestrator/agentops-recorder.test.mjs
npm run check
```

4. Drive the user-facing surfaces:

```bash
npm run qa:health
npm run qa:runtime
cat .unclecode/qa/runtime-qa-latest.json
node scripts/unclecode-runtime-qa.mjs --json
npm run qa:live:record
cat .unclecode/qa/live-provider-latest.json
node scripts/unclecode-live-provider-qa.mjs --allow-blocked --json
node bin/unclecode.cjs mcp list
node bin/unclecode.cjs research run "summarize current workspace" --json
node bin/unclecode.cjs team run "smoke transparent context state" --persona coder --lanes hermes::agent=codex --record smoke-transparent-context
```

Use `--dispatch` only when a real external worker run is intended and credentials/tooling are ready. Without `--dispatch`, the team command is a safe record-only smoke that exercises manifest/checkpoint creation.

## Context Transparency Rules

- Include active OMO goal and criterion summaries, not raw ledgers, in the default packet.
- Keep raw evidence paths local and inspectable; do not paste full transcripts into the model context unless a criterion requires it.
- Every memory-derived claim should cite a procedural SOP path, project-memory id, external-doc citation, or SSOT `VersionedRef`.
- Prefer section-level inclusion controls over broad all-or-nothing context injection.
- Memory prefetch must fail fast or degrade to empty context; it must not block CLI startup indefinitely.
- Scope memory by user, agent, team, run, project, and session before adding cross-session recall.
- For multi-agent work, give each lane a durable identity, append-only trace, and file-ownership boundary.

## GitHub Research Notes

Checked against GitHub on 2026-06-28 KST. These are not dependencies to copy in wholesale; they are control patterns UncleCode should either implement locally or explicitly reject.

| Source pattern | UncleCode control |
| --- | --- |
| Hermes memory providers expose Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory, and Memori behind a provider-style memory boundary. | Keep memory/context integrations behind provider-style seams. Do not weave prefetch, writeback, and tool routing directly through the core turn loop. |
| Hermes Honcho docs separate persistent user/session/peer modeling, session summary injection, semantic search, and conclusions. | Keep UncleCode context packets split between durable identity/memory facts and current-turn task context. The default `/context` surface must show included summaries, held-back raw artifacts, and warnings. |
| Hermes multi-agent architecture issue #344 proposes roles as toolset + system prompt combinations, dependency-aware workflow DAGs, parallel ready steps, result passing, synthesis, retry, replan, and decomposition. | Team traces must record coordinator/executor/reviewer work honestly, distinguish synthetic wrappers from real model calls, and retain dependency/worker identity in durable artifacts. |
| Hermes package restructure issue #14182 makes the package dependency DAG explicit and flags layer inversions as defects. | UncleCode stabilization should preserve CLI -> orchestrator/runtime -> providers/tools direction; provider code must not depend on CLI auth/UI layers except through typed runtime config. |
| Hermes Honcho cold-start issue #34070 shows a memory prefetch path hanging fresh CLI subprocesses. | UncleCode memory and research prefetch must have timeouts and degrade paths. No model turn should hang indefinitely waiting for memory or research context. |
| Hermes Honcho peer-fragmentation issue #42980 shows model-generated display names can create duplicate user peers. | UncleCode memory scope keys must be stable and explicit: project, user, agent, team, run, session, and channel. Do not derive durable identity from assistant prose. |
| `agent-memory-mcp` emphasizes local SQLite storage, source-aware retrieval, hybrid ranking, trust/freshness metadata, explainable retrieval, and DevOps-specific artifacts such as runbooks and postmortems. | UncleCode memory retrieval should keep source type, freshness/trust, and explanation fields inspectable. Runbooks, decisions, incidents, and postmortems should stay first-class artifacts instead of generic memory blobs. |
| `mcp_agent_mail` provides identities, inboxes, searchable threads, and advisory file leases over MCP + Git + SQLite. | Multi-agent coordination should expose durable identities and advisory ownership hints without making advisory leases a substitute for git conflict handling or tests. |

Primary sources:

- https://github.com/NousResearch/hermes-agent
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory-providers.md
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/honcho.md
- https://github.com/NousResearch/hermes-agent/issues/344
- https://github.com/NousResearch/hermes-agent/issues/14182
- https://github.com/NousResearch/hermes-agent/issues/34070
- https://github.com/NousResearch/hermes-agent/issues/42980
- https://github.com/ipiton/agent-memory-mcp
- https://github.com/ipiton/agent-memory-mcp/blob/main/docs/THREAT_MODEL.md
- https://github.com/ipiton/agent-memory-mcp/blob/main/docs/STEWARDSHIP.md
- https://github.com/Dicklesworthstone/mcp_agent_mail

## Escalation Checklist

- ABI mismatch: run `npm rebuild better-sqlite3`, then rerun `npm run qa:health --silent`.
- Slow research bundle: capture `research run --json` metrics; compare `bundleMs` and `totalMs` to thresholds before changing behavior.
- Multiple active OMO sessions: resolve or checkpoint stale sessions before trusting OMO summaries in the next packet.
- Hermes lane missing: install or expose `acpx` on PATH, or use non-Hermes lane specs for smoke tests.
- AgentOps unhealthy: treat it as observability degraded, not runtime fatal; inspect the redacted DB path and permissions.
