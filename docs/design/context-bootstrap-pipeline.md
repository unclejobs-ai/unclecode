# Context Bootstrap Pipeline

**Status:** design proposal (audit-backed, 2026-07-05)  
**Scope:** session bootstrap for `unclecode work` — ingest workspace context sources into a canonical `.unclecode` store, classify, then present through existing `ContextPacketView` / Work Shell surfaces.

## Problem statement

UncleCode's product value is **context loading done well**: skills, AGENTS.md, CLAUDE.md, Cursor rules, MCP config, agents, and memory must be discovered at session bootstrap, stored in one canonical place, classified (included / excluded / warnings), and surfaced to the model and `/context` — not dumped raw.

Today, several sources are read **live at bootstrap** into in-memory strings with partial classification. There is **no** `.unclecode` bootstrap store, and several user-expected sources are **not loaded at all**.

This document is grounded in code audit (paths cited below). It proposes a **minimal, incremental** path that reuses existing broker + packet view infrastructure.

---

## Phase 1 — Audit (what exists today)

### `.unclecode/` directory conventions

`.unclecode/` is **gitignored** (`.gitignore` line 12). It is used for **runtime/config/state**, not context bootstrap:

| Path | Purpose | Code reference |
|------|---------|----------------|
| `.unclecode/config.json` | Project mode/model config | `packages/config-core/src/resolver.ts`, `rust/unclecode-core/src/mode.rs` |
| `.unclecode/extensions/*.json` | Extension manifest overlays | `rust/unclecode-core/src/command_router.rs` |
| `.unclecode/plugins/` | In-process TS plugins (trust-gated) | `packages/plugin-host/src/index.ts` |
| `.unclecode/trust.json` | Plugin trust grant | `packages/plugin-host/src/index.ts` |
| `.unclecode/sop/<peer>/<slug>.md` | Procedural runbooks | `packages/memory-bus/src/procedural-store.ts` |
| `.unclecode/qa/*` | QA evidence JSON | `scripts/runtime-qa/constants.mjs` |
| `.unclecode/research-runs.jsonl` | Research ledger | `rust/unclecode-core/src/research_run.rs` |
| `.unclecode/todos/<sessionId>.json` | Session todos | `packages/orchestrator/src/aci/quick-tools.ts` |
| `~/.unclecode/state/` | Session store root | `packages/session-store/src/root.ts` |
| `~/.unclecode/mcp.json` | User MCP registry | `packages/mcp-host/src/index.ts`, `rust/unclecode-core/src/mcp_host.rs` |
| `~/.unclecode/UNCLECODE.md` | User guidance file | `rust/unclecode-core/src/context_guidance.rs:147` |
| `~/.unclecode/credentials/` | Provider credentials | `packages/providers/src/openai-auth.ts` |

**Gap:** no `.unclecode/context/` (or similar) canonical bootstrap artifact. Context is assembled ephemerally per session start.

### `packages/context-broker/` — current responsibilities

| Module | Role | Wired to Work Shell? |
|--------|------|----------------------|
| `workspace-guidance.ts` | Node wrapper → Rust `context guidance`; caches by `cwd::home` | Yes — bootstrap |
| `workspace-skills.ts` | `listAvailableSkills`, `loadNamedSkill` via Rust `context skills` / `skill-load` | Partial — project skills auto-injected into guidance; user skills on-demand |
| `context-packet.ts` | Repo map, hotspots, token budget, freshness (`assembleContextPacket`) | **No** for work shell — used by `research-bundle.ts` + tests only |
| `context-packet-view.ts` | **Single canonical formatter** for packet preview, compact `/context` lines, prompt prefix | Yes — via orchestrator re-export |
| `omo-context.ts` | `.omo/ulw-loop` goal summaries; excludes raw ledger/evidence | Yes — `resolveContextPacket` |
| `context-memory.ts` | Scoped memory + project bridge via session-store | Yes — engine context load |
| `memory-prefetch.ts` | Session+project prefetch with 2s timeout, degrade to empty | Yes — `work-shell-engine-context.ts` |
| `memory-transparency.ts` | Freshness labels, cite lines for `/context` | Yes — prefetch + fallback formatting |
| `repo-map.ts`, `freshness.ts`, `hotspot.ts` | Research / packet assembly helpers | Research path only today |

Runbook cross-reference: `docs/runbooks/unclecode-normalization-runbook.md` (Context packet + memory sections).

### How guidance files load today

**Discovery (Rust, source of truth):** `rust/unclecode-core/src/context_guidance.rs`

- Files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `UNCLECODE.md` (+ `*.local.md` variants)
- Walk: cwd → filesystem root; plus `~/.unclecode/UNCLECODE.md`
- Also: `.sisyphus/rules/*.md` (not `.cursor/rules`)
- Dedup: SHA-256 content hash; conflicts: heuristic tests/approval directives
- **Project skills:** Node pre-reads project-scope skills (`workspace-guidance.ts:263–280`), passes JSON to Rust; full skill bodies appended to `systemPromptAppendix`

**Node entry:** `loadCachedWorkspaceGuidance` → `loadWorkspaceGuidance` → `unclecode rust context guidance`

**Bootstrap wiring:** `apps/unclecode-cli/src/work-runtime-bootstrap.ts`

- `guidance.systemPromptAppendix` merged into provider `systemPrompt` (lines 396–415)
- `guidance.contextSummaryLines` → Work Shell `contextSummaryLines` (lines 498–507)
- `/context` reload: `reloadWorkspaceContext` → `buildWorkShellContextSummary({ forceRefresh: true })` (lines 521–530)

**Not loaded anywhere in UncleCode (verified grep):**

- `.cursor/rules/**`, `.cursorrules`
- `.cursor/skills/**` (Cursor skill paths)
- `.claude/skills/**`, `.claude/rules/**` (Leonxlnx subtree only)

### Skills loading today

**Discovery paths (Rust):** `rust/unclecode-core/src/context_skills.rs`

- `<cwd>/.codex/skills/**/SKILL.md`
- `~/.codex/skills/**/SKILL.md`
- `~/.agents/skills/**/SKILL.md` (minus legacy superpowers filter)
- **Not scanned:** `.cursor/skills`, `.claude/skills`, project-local `.claude/skills`

**API:**

- `listAvailableSkills(cwd, homeDir)` — metadata list
- `loadNamedSkill(name, cwd, homeDir)` — on-demand full content + attempt trace
- Orchestrator injects defaults: `work-shell-engine.ts:582–583` (empty stubs if unset)
- Work shell wires real implementations from bootstrap

**Bootstrap behavior:** only **project-scope** skills are embedded in guidance system prompt at session start. User skills appear in `/skills` list but are **not** auto-injected.

### MCP loading today

| Layer | Behavior |
|-------|----------|
| Registry | `loadMcpHostRegistry` reads `~/.unclecode/mcp.json` + `<workspace>/.mcp.json` (`packages/mcp-host/src/index.ts:230–238`) |
| Doctor | Rust `doctor --json` reports `mcpHost` verdict (`apps/unclecode-cli/src/fast-doctor.ts`) |
| CLI | `unclecode mcp list`, `/mcp list` slash |
| mmbridge | Resolves `mmbridge` server from registry; spawns stdio MCP (`apps/unclecode-cli/src/mmbridge-mcp.ts:48–63`) |
| Work Shell context | MCP **count/names** in Session Center home state only — **not** in `ContextPacketView` or `systemPromptAppendix` at bootstrap |

### Orchestrator Work Shell context path

```
loadWorkCliBootstrap (work-runtime-bootstrap.ts)
  → contextSummaryLines, contextPacketSourceMetadata, resolveContextPacket
  → WorkAgent / WorkShellEngine

loadInitialWorkShellContextState (work-shell-engine-context.ts)
  → listProjectBridgeLines + prefetchScopedMemory
  → collapsed context panel

reloadWorkShellContextState / reloadWorkspaceContext
  → refresh guidance summaries + bridge + memory

resolveContextPacket (bootstrap closure)
  → createContextPacketView (context-broker)
  → buildWorkShellCompactContextPacketPreviewLines (orchestrator re-export)
  → /context overlay (work-shell-builtins.ts)
```

Packet formatting is unified in broker (`context-packet-view.ts`); orchestrator must not fork (already enforced per T9-B1).

### Session store / memory-bus

- **Session store:** `~/.unclecode/state/` (override: `UNCLECODE_SESSION_STORE_ROOT`)
- **Project bridge + project memory:** session-store project memories (`context-memory.ts:87–123`)
- **Session/user/agent memory:** JSONL under store root (`context-memory.ts:17–41`)
- **Procedural SOPs:** `.unclecode/sop/` via memory-bus — **not** wired into Work Shell bootstrap today
- **Prefetch:** `memory-prefetch.ts` — 2s timeout; `degraded` → empty lines (no user-visible warning in packet yet)

### Context classification today (partial)

`ContextPacketView` (`packages/contracts/src/context-packet-view.ts`) supports `included`, `excluded`, `warnings`.

Built in `work-runtime-bootstrap.ts:createWorkShellContextPacketResolver`:

- **Included:** provider prompt metadata, workspace summary lines (sanitized), bridge, memory, trace, OMO goals
- **Excluded:** OMO raw artifacts (ledger, evidence) with rollup when >6 items
- **Warnings:** OMO ambiguity (multiple active sessions, malformed JSON)
- **Workspace guidance raw text:** deliberately **withheld** from packet — safe preview only (`WORKSPACE_GUIDANCE_SAFE_PREVIEW`, lines 149–175)

This is classification without persistence — recomputed on each `resolveContextPacket` call.

---

## Phase 2 — Gap analysis

| Source | Loaded today? | Where stored | User-visible? | Gap |
|--------|---------------|--------------|-----------------|-----|
| AGENTS.md / CLAUDE.md / GEMINI.md / UNCLECODE.md | Yes (live read) | In-memory cache `workspaceGuidanceCache`; full text in `systemPromptAppendix` | Summary in `/context`; raw in model system prompt | No `.unclecode` snapshot; no file watcher freshness; Cursor rules not included |
| `*.local.md` guidance variants | Yes | Same as above | Same | Not distinguished in packet (only summary lines) |
| `.sisyphus/rules/*.md` | Yes | Same | Summary lines | Non-standard path; `.cursor/rules` missing |
| Cursor rules (`.cursor/rules`, `.cursorrules`) | **No** | — | — | User expectation; only mentioned in Leonxlnx `/init` prompt |
| Project skills (`.codex/skills`) | Yes (project scope) | Embedded in guidance appendix | "Loaded skills" summary | Full content in every turn's system prompt — no selective include |
| User skills (`~/.codex`, `~/.agents`) | List only | On-demand via `loadNamedSkill` | `/skills` panel | Not in bootstrap store; `.cursor/skills` not scanned |
| MCP config (`.mcp.json`, `~/.unclecode/mcp.json`) | Registry only | Config files on disk | Session Center MCP list; doctor verdict | Not classified into context packet; server tools not summarized at bootstrap |
| mmbridge | On slash/MCP call | External MCP process | `/mmbridge *` commands | Not part of bootstrap ingest |
| Extension manifests (`.unclecode/extensions`) | Yes (overlay + summary) | Disk + manifest cache | Up to 2 summary lines in context | Not in `ContextPacketView` items |
| Config prompt (`explainUncleCodeConfig`) | Yes | Rendered string | Packet metadata item | Not snapshotted under `.unclecode` |
| Repo map / hotspots (`assembleContextPacket`) | **No** (work shell) | — | — | Research-only; user may expect code context at bootstrap |
| OMO goals | Yes | `.omo/ulw-loop/` | Packet included + excluded rollup | Good pattern to reuse |
| Scoped memory (session/project) | Yes (prefetch) | Session store + JSONL | Memory lines in packet if prefetch ok | Degraded prefetch → **silent empty**; no warning in packet |
| Procedural SOP (`.unclecode/sop/`) | **No** | Disk | — | Not in bootstrap pipeline |
| Agents / subagent definitions | **No** | `.cursor/agents`, team refs | — | Not discovered |
| Plugins (`.unclecode/plugins`) | Hooks only at runtime | Disk | Trust error if untrusted | Not context-classified |

---

## Phase 3 — Design proposal (minimal, incremental)

### Principle

1. **Ingest first** → write canonical bootstrap artifact under `.unclecode/context/`
2. **Classify** → map artifacts into `ContextPacketView` included/excluded/warnings (reuse `createContextPacketView`)
3. **Present** → existing formatters (`buildWorkShellCompactContextPacketPreviewLines`, `formatContextPacketPromptPrefix`)
4. **No big bang** — wrap existing loaders; add missing source adapters one at a time

### Target bootstrap flow

```mermaid
flowchart TD
  A[Session start: unclecode work] --> B[Discover sources]
  B --> C[Write .unclecode/context/bootstrap.json]
  C --> D[Classify → ContextPacketView]
  D --> E[Model prefix: formatContextPacketPromptPrefix]
  D --> F[TUI: /context compact overlay]
  D --> G[System prompt: selective appendix]
  H[/context reload or file change] --> B
```

### Proposed `.unclecode/context/` layout (v1)

```
.unclecode/context/
  bootstrap.json          # manifest: sessionId, generatedAt, fingerprint, source index
  sources/                # optional: copied or symlinked snapshots (content-addressed by hash)
    <sha256>.md           # normalized text snapshots for audit/diff
```

`bootstrap.json` schema (sketch):

- `version`, `sessionId`, `workspaceRoot`, `generatedAt`, `worktreeFingerprint`
- `sources[]`: `{ id, kind, path, scope, sha256, bytes, includedInModel, includedInView, reason }`
- `warnings[]`, `conflicts[]` (from existing guidance conflict detection)
- `packetViewId` — hash linking to last `ContextPacketView`

**Important:** `.unclecode/` stays gitignored. Bootstrap store is **local session cache**, not committed SSOT.

### Classification rules (align with existing packet behavior)

| Kind | Model system prompt | ContextPacketView | Notes |
|------|--------------------|-------------------|-------|
| Guidance md files | Append with `## name (path)` headers (existing) | Summary lines only; raw withheld (existing) | Add Cursor rules as new kind |
| Project skills | **Change default:** metadata in bootstrap.json; full body on `/skill` or explicit include | List in included with path + summary | Reduces prompt bloat |
| User skills | Exclude unless pinned in bootstrap manifest | Included as catalog entry | |
| MCP servers | Exclude raw config secrets | Included: name, transport, origin, tool count if cheap | |
| Memory | Summaries only (existing) | Included with cite + freshness (existing) | Surface prefetch `degraded` as warning |
| OMO | Goal summaries only (existing) | Existing included/excluded split | Keep |
| Repo map / hotspots | Phase 2+ optional slice | Included summary line | Use `assembleContextPacket` subset |

### Reuse map (do not rewrite)

| New step | Reuse |
|----------|-------|
| Ingest guidance | `rust/unclecode-core/src/context_guidance.rs` + Node cache clear |
| Ingest skills | `context_skills.rs` + `listAvailableSkills` |
| Ingest MCP | `loadMcpHostRegistry` |
| Ingest memory | `prefetchScopedMemory` + `listScopedMemoryEntries` |
| Ingest OMO | `loadOmoContextSnapshot` |
| Classify + format | `createContextPacketView`, `context-packet-view.ts` |
| Work Shell wiring | `work-runtime-bootstrap.ts`, `work-shell-engine-context.ts` |

### Priority order (user-aligned)

1. **Bootstrap ingest → `.unclecode/context/bootstrap.json`** — manifest only first (no behavior change except audit trail)
2. **Classification completeness** — warnings for prefetch degrade, MCP summary items, extension items in packet
3. **TUI `/context` transparency** — show bootstrap generation time, source counts, excluded reasons (reuse compact overlay)
4. **MCP/skills wiring gaps** — Cursor rules adapter; `.cursor/skills` scan; optional `.claude/skills` alias

### Out of scope (this design pass)

- Replacing Rust guidance with pure Node
- Committing bootstrap artifacts to git
- Loading all skill bodies into every turn
- `qa:health` changes

---

## Executor task breakdown (T11)

Each task is one PR-sized step with verifiable success criteria.

### T11-E1 — Bootstrap manifest writer (read-only ingest)

**Goal:** On `loadWorkCliBootstrap`, write `.unclecode/context/bootstrap.json` listing all sources currently loaded (guidance paths, skill paths, extension names, MCP server names, memory prefetch status).

**Touch:** `apps/unclecode-cli/src/work-runtime-bootstrap.ts`, new `packages/context-broker/src/bootstrap-manifest.ts` (or similar)

**Success criteria:**

- Starting `unclecode work` creates/updates `.unclecode/context/bootstrap.json`
- Manifest lists same guidance `sources[]` as Rust guidance JSON
- Unit test: temp workspace → bootstrap → parse manifest → paths match fixtures
- No change to model prompt behavior yet

### T11-E2 — Wire manifest into ContextPacketView metadata

**Goal:** Add packet items for extensions, MCP registry, bootstrap generation stamp; add warning when `prefetchScopedMemory` returns `degraded`.

**Touch:** `work-runtime-bootstrap.ts`, `work-shell-engine-context.ts`, tests in `tests/context-broker/memory-prefetch.test.mjs`

**Success criteria:**

- `/context` overlay shows MCP server count and extension names as included items
- Prefetch timeout produces visible warning in packet (not silent empty)
- Existing context-packet-view tests green

### T11-E3 — Cursor rules ingest adapter

**Goal:** Discover `.cursor/rules/**/*.mdc` and `.cursorrules`; store in bootstrap manifest; append to guidance classification (summary in view, optional appendix section).

**Touch:** new `packages/context-broker/src/cursor-rules.ts`, Rust optional or Node-only discovery, `context_guidance.rs` or parallel ingest

**Success criteria:**

- Fixture with `.cursor/rules/foo.mdc` appears in bootstrap.json and contextSummaryLines
- Raw rule text follows same withhold pattern as other guidance in packet view
- Test covers missing rules dir (no error)

### T11-E4 — Skills catalog vs inject split

**Goal:** Stop embedding all project skill bodies in default system prompt; bootstrap manifest lists skills; inject on `/skill` or explicit pin file `.unclecode/context/pinned-skills.json`.

**Touch:** `context_guidance.rs` / `workspace-guidance.ts`, slash handler

**Success criteria:**

- Default bootstrap: skill **names** in context, not full SKILL.md bodies
- `/skill <name>` still loads via `loadNamedSkill`
- Token estimate in packet drops measurably in fixture repo with large skills

### T11-E5 — Cursor skills path scan

**Goal:** Extend `context_skills.rs` to also scan `~/.cursor/skills/**/SKILL.md` and `<cwd>/.cursor/skills/**/SKILL.md` with scope labels.

**Touch:** `rust/unclecode-core/src/context_skills.rs`, `tests/context-broker/workspace-skills.test.mjs` (if exists) or new test

**Success criteria:**

- `listAvailableSkills` returns cursor skill in fixture
- Documented in bootstrap manifest under `kind: skill`

### T11-E6 — Reload invalidates bootstrap store

**Goal:** `reloadWorkspaceContext` and `clearCachedWorkspaceGuidance` regenerate bootstrap.json; optional content-hash skip if unchanged.

**Touch:** `work-runtime-bootstrap.ts`, manifest writer

**Success criteria:**

- Edit AGENTS.md → `/context` reload → bootstrap.json `generatedAt` updates
- Test: two reloads without file change may skip rewrite (if implemented) OR always rewrite (document chosen behavior)

### T11-E7 — Runbook + scratchpad sync

**Goal:** Update `docs/runbooks/unclecode-normalization-runbook.md` bootstrap section; mark T11 complete in scratchpad.

**Success criteria:**

- Runbook describes `.unclecode/context/bootstrap.json` and verification commands
- No `qa:health` requirement for this doc-only task

---

## Verification commands (operator)

```bash
# Guidance + skills (existing)
node -e "import('@unclecode/context-broker').then(m => m.loadCachedWorkspaceGuidance({ cwd: process.cwd() }).then(console.log))"

# MCP registry (existing)
node bin/unclecode.cjs mcp list

# Doctor MCP verdict (existing)
node bin/unclecode.cjs doctor --json | jq '.verdicts.mcpHost, .labels.mcpHost'

# After T11-E1
test -f .unclecode/context/bootstrap.json && jq '.sources | length' .unclecode/context/bootstrap.json
```

---

## References

- Spec (partial, pre-dates GEMINI/UNCLECODE): `docs/specs/2026-04-05-unclecode-tui-orchestration-redesign.md` §8
- Runbook: `docs/runbooks/unclecode-normalization-runbook.md`
- Roadmap note: `docs/plans/2026-06-01-agent-skill-mcp-minimalism-roadmap.md`
