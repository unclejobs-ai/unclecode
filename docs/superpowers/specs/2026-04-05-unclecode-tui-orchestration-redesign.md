# UncleCode TUI + Agent Orchestration Redesign Spec (v2)

> **Date**: 2026-04-05 (revised after 5-tool review)
> **Status**: Draft v2
> **Scope**: TUI UX, Agent Orchestration, Slash Commands, Plugin/Skill System, Cross-CLI Interop
> **Vision**: Pi-like speed + unprecedented agent orchestration power
> **Nature**: Migration/consolidation plan, NOT greenfield redesign

## 1. Problem Statement

### Actual Current State (fact-checked)

| Area | What exists today | Real problem |
|------|-------------------|-------------|
| **Paste** | `ink-text-input` in work shell (`src/cli.tsx:708`). Bundle client has `BaseTextInput` with `usePasteHandler` including image+text paste. | Work shell doesn't use the bundle's paste-capable input. Reuse, not rewrite. |
| **Multi-agent** | `src/agent.ts` emits fake orchestrator steps (coordinator/planner/executor/reviewer) around a single provider call. `packages/orchestrator` only handles research workflows. | Fake traces exist for UI — real orchestration engine is missing. Must clean shim before adding progressive disclosure. |
| **TUI layout** | Fixed 70/30 split, 12-entry chat limit in work shell. Session center has its own full layout system in `packages/tui`. | Rigid, but two complete rendering surfaces exist — need unification, not rebuild. |
| **Slash commands** | Work shell: 4 inline commands in `resolveWorkShellSlashCommand()`. CLI: 8 commands in `command-router.ts`. Contracts: full `CommandMetadata` interface with types (prompt/local/local-jsx) and sources (builtin/mcp/plugin/bundled/skills/managed). | Commands are scattered across 3 layers. Contracts are solid. Need consolidation, not greenfield registry. |
| **Plugin/skill types** | `packages/contracts/src/commands.ts` already defines `CommandSource`, `SkillSource`, `SkillMetadata`. `packages/config-core` supports plugin overlays. | Infrastructure contracts exist. Runtime loading/registration is missing. |
| **CLAUDE.md/AGENTS.md** | `src/workspace-guidance.ts` already loads both files, walks up directory tree, injects as `systemPromptAppendix` with `## {name} ({path})` headers. Shows in `/context`. | Partial implementation. Missing: GEMINI.md, UNCLECODE.md, conflict resolution, `.claude/settings.json`. |
| **Shell transition** | Session center (`packages/tui`) and work shell (`src/cli.tsx`) are separate Ink apps. Work shell spawns as child process via `spawn(node, [WORK_ENTRYPOINT])`. | Jarring `\u001Bc` screen clear + process spawn. Need single-process unification. |

### What this spec is NOT
- ~~Greenfield CommandRegistry from scratch~~ → Consolidate 3 existing layers using contracts that already exist
- ~~Build paste handling from zero~~ → Port bundle client's `usePasteHandler` pattern to work shell
- ~~Design command types~~ → Already defined in `packages/contracts/src/commands.ts`
- ~~Define plugin overlay system~~ → Already in `packages/config-core/src/types.ts`

### Design Principles
- **Fast by default**: First response under 500ms perceived latency
- **Progressive disclosure**: Hide orchestration complexity until needed
- **Consolidate, don't duplicate**: Reuse existing contracts, port proven patterns from bundle client
- **Interoperable**: Extend existing AGENTS.md/CLAUDE.md loading, don't replace
- **Single Source of Truth**: `apps/unclecode-cli` + `packages/*` is the final product. Root `src/*` is phased out.

---

## 2. SoT Decision + Cutover Strategy

### Final product path: `apps/unclecode-cli` + `packages/*`

Current root `src/*` / `dist-work` code is **transitional** and will be absorbed into packages.

### Cutover plan:

| Root file | Target package | Migration strategy |
|-----------|---------------|-------------------|
| `src/agent.ts` (CodingAgent) | `packages/orchestrator` | Extract as `WorkAgent`, remove fake trace shim |
| `src/cli.tsx` (App component) | `packages/tui` | Merge into unified shell as WorkView |
| `src/config.ts` | `packages/config-core` | Already has equivalent; wire through |
| `src/providers.ts` | `packages/providers` | Already has equivalent; remove root copy |
| `src/tools.ts` | `packages/orchestrator/src/tools.ts` | Move tool definitions (co-locate with engine that uses them) |
| `src/workspace-guidance.ts` | `packages/context-broker` | Extend existing context assembly |
| `src/index.ts` (entry) | `apps/unclecode-cli/src/program.ts` | Absorb work launch into CLI program |
| `src/context-memory.ts` | `packages/session-store` | Already has memory; wire through |

### Phase 0 prerequisite:
Before any feature work, prepare for the spawn removal (actual removal happens in Phase 3):
- `apps/unclecode-cli/src/work-launcher.ts` currently spawns a separate Node process
- Phase 0: Identify all call sites, document shared bootstrap requirements
- Phase 1a: Extract `WorkShellEngine` so the spawn target's logic is packageable
- Phase 3: Replace `spawn()` with in-process engine call, delete `work-launcher.ts`
- The engine owns agent setup, config loading, and the turn loop

---

## 3. Architecture Overview

```
                    ┌─────────────────────────────────────────────┐
                    │           UncleCode Shell (single Ink app)  │
                    │  ┌─────────────────────────────────────┐    │
                    │  │         Input Layer                  │    │
                    │  │  Port usePasteHandler from bundle    │    │
                    │  │  Kitty keyboard (auto mode)          │    │
                    │  └──────────────┬──────────────────────┘    │
                    │                 │                            │
                    │  ┌──────────────▼──────────────────────┐    │
                    │  │       Command Router                 │    │
                    │  │  Consolidate 3 existing layers       │    │
                    │  │  using contracts CommandMetadata      │    │
                    │  └──────────────┬──────────────────────┘    │
                    │                 │                            │
                    │  ┌──────────────▼──────────────────────┐    │
                    │  │       WorkShellEngine                │    │
                    │  │  Extracted from cli.tsx submit       │    │
                    │  │  Owns agent, turns, memory, bridge   │    │
                    │  └──────────────┬──────────────────────┘    │
                    │                 │                            │
                    │  ┌──────────────▼──────────────────────┐    │
                    │  │       Orchestrator (future)          │    │
                    │  │  Real coordinator → planner →        │    │
                    │  │  executor pool (replaces fake shim)  │    │
                    │  └──────────────┬──────────────────────┘    │
                    │                 │                            │
                    │  ┌──────────────▼──────────────────────┐    │
                    │  │       Render Layer                   │    │
                    │  │  [Work] [Sessions] [MCP] [Research]  │    │
                    │  │  Progressive: minimal ↔ verbose      │    │
                    │  └─────────────────────────────────────┘    │
                    └─────────────────────────────────────────────┘
                    
External (existing infrastructure):
  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────┐
  │ contracts    │  │ config-core  │  │MCP Servers│  │CLAUDE/AGENTS │
  │(CommandMeta) │  │(plugin ovly) │  │(stdio/http)│ │(.md - exists)│
  └──────────────┘  └──────────────┘  └──────────┘  └──────────────┘
```

---

## 4. Input Layer — Selective Reuse from Bundle Client

### What exists in bundle client (`Leonxlnx-claude-code/src/components/BaseTextInput.tsx`):
- `usePasteHandler` hook with bracket paste mode
- `onPaste(text)` callback for large text (>800 chars)
- `onImagePaste(base64, mediaType, filename, dimensions)` for image paste
- `onIsPastingChange(isPasting)` state notification
- During paste: suppresses Enter to prevent premature submission

### Migration plan (selective reuse):
1. **Port `usePasteHandler` pattern** — Extract the hook logic, adapt for UncleCode's simpler needs (no image paste initially)
2. **Build `<Composer>` component** using ported paste handler + `useInput` from Ink:
   ```tsx
   <Composer
     value={input}
     onChange={setInput}
     onSubmit={handleSubmit}
     placeholder="Type naturally. Esc sessions · /help"
     multiline={true}
     disabled={isBusy}
   />
   ```
3. **Kitty keyboard**: Use `kittyKeyboard: { mode: 'auto' }` (heuristic detection, not forced)
4. **Fallback**: `\\` at end of line for terminals without Kitty support

### Terminal compatibility:
| Terminal | Bracket paste (`usePaste`) | Kitty keyboard (Shift+Enter) |
|----------|---------------------------|------------------------------|
| Kitty | ✅ | ✅ |
| WezTerm | ✅ | ✅ |
| Ghostty | ✅ | ✅ |
| iTerm2 | ✅ | ❌ (use `\\` fallback) |
| Terminal.app | ✅ | ❌ (use `\\` fallback) |
| Windows Terminal | ✅ | ⚠️ opt-in |

---

## 5. Progressive Disclosure TUI

### Phase 0 prerequisite: Clean up fake orchestrator traces
Current `src/agent.ts` emits fake coordinator/planner/executor/reviewer steps around a single API call. If progressive disclosure renders these, the UX lies about what the engine actually does.

**Before adding verbose mode:**
1. Remove fake orchestrator.step events from `CodingAgent.runTurn()`
2. Replace with honest trace: `turn.started` → `provider.calling` → `turn.completed`
3. Real orchestrator steps only appear when real orchestration exists (Phase 4)

### Two rendering modes (user-controlled):

| Mode | When | What shows |
|------|------|-----------|
| **Minimal** (default) | Simple queries, fast responses | Input → streaming answer. No step trace. Like Pi. |
| **Verbose** | User toggles `/v`, or mode is `ultrawork` | Input → real orchestration steps → answer. Like Claude Code. |

### Mode switching (explicit, never auto):
- `/verbose` or `/v` → switch to verbose mode
- `/minimal` or `/m` → switch to minimal mode
- `ultrawork` mode → verbose automatically (explicit user choice)
- Mode persists per session
- **Progress indicator thresholds** (from Nielsen Norman UX research):
  - **>2s**: Show indeterminate spinner (`● thinking...`)
  - **>10s**: Show elapsed time (`● thinking... 12s`)
  - This is NOT auto-escalation — just a progress signal.
- **No auto-detection of complexity for display mode**. Display mode is always user-controlled.

### Layout — Minimal mode:
```
┌─ UncleCode · OpenAI · gpt-5.4 · search ─────────────────┐
│                                                           │
│  You: Fix the auth bug in login.ts                        │
│                                                           │
│  ● thinking...                                            │
│                                                           │
│  Answer: I found the issue in `login.ts:42`...            │
│                                                           │
│  > _                                                      │
└───────────────────────────────────────────────────────────┘
```

### Layout — Verbose mode:
```
┌─ UncleCode · OpenAI · gpt-5.4 · ultrawork ──────────────┐
│                                                          │
│  You: Refactor the entire auth system                    │
│                                                          │
│  Step ─────────────────────────────────────────────       │
│  → coordinator Scheduling turn                           │
│  ✓ planner 120ms Prepared 3-task plan                    │
│  → executor[1] Reading auth/login.ts                     │
│  → executor[2] Reading auth/oauth.ts                     │
│  ✓ executor[1] 340ms Refactored login flow               │
│                                                          │
│  Context ────────────────────────────────────────────     │
│  Loaded AGENTS.md, CLAUDE.md                             │
│  Mode: ultrawork · Auth: api-key · Workers: 1/3          │
│                                                          │
│  > _                                                     │
└──────────────────────────────────────────────────────────┘
```

---

## 6. Agent Orchestration Architecture

### Current state (honest assessment)
- `src/agent.ts`: Single-turn loop with fake trace events. NOT an orchestrator.
- `packages/orchestrator`: Research-mode only (bootstrap → MCP profile → execute → cleanup).

### Intent Classifier (local heuristic, <10ms, no LLM call)

```typescript
function classifyIntent(input: string, mode: ModeProfile): "simple" | "complex" | "research" {
  if (mode.name === "ultrawork") return "complex";
  if (mode.name === "search" || mode.name === "analyze") return "research";
  if (input.startsWith("/")) return "simple";
  
  const filePathCount = (input.match(/[\w\-./]+\.\w{1,5}/g) ?? []).length;
  const complexKeywords = /\b(refactor|migrate|rewrite|redesign|rebuild|all files|entire|every)\b/i;
  
  if (filePathCount >= 3 || complexKeywords.test(input)) return "complex";
  return "simple"; // default fast path
}
```

**Key principle: default to simple, never auto-escalate without user consent.**

### Target architecture (Phase 4):

```
Orchestrator
├── Coordinator (classifyIntent → route)
│   ├── "simple" → direct WorkAgent.runTurn() (current fast path, no overhead)
│   ├── "complex" → Planner → Executor Pool
│   └── "research" → existing research orchestrator (extended)
│
├── Planner (decomposes complex tasks)
│   ├── Task graph with dependencies
│   └── Budget allocation (tokens, time, workers)
│
├── Executor Pool (bounded in-process workers)
│   ├── Max 5 (ultrawork), max 3 (search), max 1 (default)
│   ├── File ownership registry (read=free, write=claim)
│   └── Results aggregated by coordinator
│
├── Guardian (auto-review on completion)
│   └── lint/typecheck/test subset
│
└── Event Bus → TUI render layer
```

### Why in-process workers (not subprocesses):
- LLM API calls are I/O-bound — single V8 thread handles many concurrent calls fine
- Shared memory: file ownership registry, context, tool definitions — no serialization
- Lower latency: no spawn/IPC overhead (~300-500ms per child process)
- Workers share agent config, provider setup, system prompt

### Bounded concurrency details:

**Token budget overflow**: Worker receives truncation signal → 500 tokens to wrap up → force-stop → partial result to coordinator.

**File ownership locking**:
```typescript
class FileOwnershipRegistry {
  claim(workerId: string, filePath: string): boolean;
  release(workerId: string, filePath: string): void;
  releaseAll(workerId: string): void;
}
// Read: any worker. Write: must claim first. Conflict → wait or coordinator resequences.
```

**Event backpressure**:
- Priority: `critical` (approvals, errors) > `high` (tool completions) > `low` (progress ticks)
- <10 events/sec: render all
- 10-50/sec: coalesce consecutive `low` events
- >50/sec: batch `high` per 200ms tick. `critical` always immediate.

---

## 7. Slash Command Consolidation

### What exists today (3 layers):

| Layer | Location | Commands | Architecture |
|-------|----------|----------|-------------|
| Work shell inline | `src/cli.tsx:260` | `/doctor`, `/auth status`, `/mcp list`, `/mode status` | Flat if-chain, returns string[] tokens |
| CLI command router | `apps/unclecode-cli/src/command-router.ts` | 8 commands including `/help`, `/work`, `/research status` | `parseSlashCommand()` → typed `ParsedSlashCommand` |
| Contracts | `packages/contracts/src/commands.ts` | Type definitions: `CommandMetadata`, `CommandType`, `CommandSource`, `SkillMetadata` | Rich metadata with source tracking |

### Consolidation plan (not greenfield):

1. **Promote contracts to runtime registry**: `CommandMetadata` already has `name`, `description`, `type` (prompt/local/local-jsx), `source` (builtin/mcp/plugin/bundled/skills/managed), `aliases`, `userInvocable`. Build a `CommandRegistry` class that accepts `CommandMetadata` entries.

2. **Migrate existing commands**: Register the 8 CLI commands + 4 work shell commands into the registry with their existing behavior.

3. **Command resolution** (explicit aliases > prefix):
   - Exact match first
   - Explicit aliases (declared in `CommandMetadata.aliases`)
   - Prefix match: 3+ characters only, unambiguous only
   - Tab completion as primary discovery UX

4. **Plugin/skill command injection**: Registry accepts new `CommandMetadata` from plugin loading (Phase 5).

### Built-in command table:

| Command | Type | Source | Current location |
|---------|------|--------|-----------------|
| `/help` | local | builtin | CLI router |
| `/doctor` | local | builtin | CLI router + work shell |
| `/auth status` | local | builtin | work shell |
| `/mode [set\|status]` | local | builtin | CLI router |
| `/mcp list` | local | builtin | CLI router + work shell |
| `/sessions` | local | builtin | CLI router |
| `/reasoning [low\|med\|high]` | local | builtin | work shell |
| `/verbose` `/v` | local | builtin | NEW |
| `/minimal` `/m` | local | builtin | NEW |
| `/context` | local | builtin | work shell |
| `/tools` | local | builtin | work shell |
| `/remember [scope] <text>` | local | builtin | work shell |
| `/memories` | local | builtin | work shell |
| `/clear` | local | builtin | work shell |
| `/exit` | local | builtin | work shell |
| `/commit` | prompt | builtin | NEW |
| `/review` | prompt | builtin | NEW |
| `/research <topic>` | prompt | builtin | NEW (currently only `research run` CLI subcommand + `/research status` in slash router) |

---

## 8. CLAUDE.md / AGENTS.md / Cross-CLI Interop

### Current state (already partially implemented):
- `src/workspace-guidance.ts` loads `AGENTS.md` and `CLAUDE.md`
- Walks up directory tree from cwd
- Injects as `systemPromptAppendix` with `## {name} ({path})` headers
- Shows loaded files in `/context` summary lines

### What Phase 2 adds:
- `GEMINI.md` and `UNCLECODE.md` loading (add to `GUIDANCE_FILE_NAMES`)
- `*.local.md` variants (gitignored, personal overrides)
- Same-tier conflict resolution rules
- `/context` diagnostic with per-directive source attribution

### Loading hierarchy (lowest → highest priority):
1. `~/.unclecode/UNCLECODE.md` (user defaults)
2. Project root `AGENTS.md` → `CLAUDE.md` → `GEMINI.md` → `UNCLECODE.md`
3. Subdirectory-level context files (same walk-up logic as current `discoverGuidanceSources`)
4. `*.local.md` variants (gitignored, highest)

### Discovery rules (concrete):
- **File names searched**: `["AGENTS.md", "CLAUDE.md", "GEMINI.md", "UNCLECODE.md"]`
- **Directory walk**: From cwd upward to filesystem root (existing `discoverGuidanceSources` behavior)
- **`.local.md` naming**: `CLAUDE.local.md`, `AGENTS.local.md`, etc. Searched in same directories.
- **Symlink dedup**: Hash file content (SHA-256). If two files produce same hash, include only the higher-priority one and note dedup in `/context` output.
- **Encoding**: UTF-8 only. Non-UTF-8 files silently skipped with warning in `/context`.

### Same-tier conflict resolution:
**Fixed load order within same tier**: `AGENTS.md` → `CLAUDE.md` → `GEMINI.md` → `UNCLECODE.md`

1. **Machine-readable directives** (mode, tool allowlists): later file wins
2. **Free-text instructions**: ALL appended with section headers (existing behavior in `workspace-guidance.ts`)
3. **When no UNCLECODE.md exists**: CLAUDE.md wins over AGENTS.md

### `/context` diagnostic (enhanced):
```
Context files loaded:
  AGENTS.md (project, /path/to/project) — 42 lines
  CLAUDE.md (project, /path/to/project) — 128 lines
  
Conflict detected:
  AGENTS.md says "tests optional" vs CLAUDE.md says "TDD required"
  → CLAUDE.md wins (load order). Override with UNCLECODE.md if needed.
```

---

## 9. Unified Shell — Single Ink App with Views

### Migration plan (not rebuild):

**Step 1**: Extract `WorkShellEngine` from `src/cli.tsx` `submit` callback
- Move bridge publishing, session memory, session snapshots, trace wiring
- Engine API: `handleSubmit(input)`, `handleSlashCommand(input)`, `getState()`

**Step 2**: Create shared bootstrap
- Provider setup, config loading, agent initialization happen once in `apps/unclecode-cli`
- Both Session Center view and Work View receive the same engine instance

**Step 3**: Merge into single Ink app with view tabs
```
┌─ UncleCode ──────────────────────────────────────────────┐
│  [Work] [Sessions] [MCP] [Research]          Esc=toggle  │
│─────────────────────────────────────────────────────────  │
│  (Current view content)                                  │
│  > _                                                     │
└──────────────────────────────────────────────────────────┘
```

**Step 4**: Remove `work-launcher.ts` spawn path

### Navigation:
- `Esc` — Toggle Work ↔ Sessions
- `Ctrl+1/2/3/4` — Direct view switch
- `Tab` — Toggle context panel in Work view

### Input focus rules per view:
| View | Composer state | Keyboard priority |
|------|---------------|------------------|
| **Work** | Active, full input | Composer captures all keystrokes except Esc, Ctrl+1-4, Tab |
| **Sessions** | Disabled (greyed) | Arrow keys navigate list, Enter resumes session, `/` activates composer for slash commands only |
| **MCP** | Disabled | Arrow keys navigate server list, Enter toggles detail |
| **Research** | Active (research prompt) | Same as Work but routed to research engine |

**Conflict resolution**: View navigation keys (`Esc`, `Ctrl+1-4`) always win over composer input. Composer only captures printable characters + Enter + Backspace when active.

---

## 10. Plugin + Skill System

### What exists:
- `packages/contracts`: `SkillMetadata` with name, description, source, version, paths
- `packages/config-core`: Plugin overlay support in config hierarchy
- Bundle client: Full plugin manager in `Leonxlnx-claude-code/src/commands/plugin/`

### What to build (selective reuse of bundle patterns):

**Plugin manifest** (`plugin.json`, aligned with Claude Code schema):
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Custom workflow extensions",
  "author": { "name": "...", "url": "..." },
  "license": "MIT",
  "commands": "./commands/",
  "skills": "./skills/",
  "agents": "./agents/",
  "hooks": "./hooks.json",
  "mcpServers": "./mcp.json",
  "userConfig": {
    "api_token": { "description": "API auth token", "sensitive": true }
  }
}
```

**Skill loading (progressive disclosure)**:
1. Scan: read frontmatter only (~30 tokens per skill)
2. Match: check triggers against current task
3. Load: full content only when matched
4. Apply: inject into system prompt

**Loading order**:
1. Built-in skills (shipped with UncleCode)
2. User global plugins (`~/.unclecode/plugins/`)
3. Project plugins (`.unclecode/plugins/`)

---

## 11. Implementation Priority (revised phase order)

### Phase 0 — SoT cutover prep + fake trace cleanup (1 day)
0. Remove fake orchestrator.step events from `CodingAgent.runTurn()` — replace with honest trace
1. Fix stale closure bug in `submit` dep array
2. Document cutover table (Section 2) as tracked migration tickets

### Phase 1a — Extract WorkShellEngine + remove execFile (1 day)
3. Extract business logic from `cli.tsx` submit callback → `WorkShellEngine` class
   - **Target location**: `packages/orchestrator/src/work-shell-engine.ts` (not root `src/*`)
   - Engine owns: agent turn loop, bridge publishing, session memory, trace wiring, slash command dispatch
   - Export from `@unclecode/orchestrator`
4. Replace `execFile` inline command pattern (`src/index.ts:120-127`)
   - Currently spawns a separate Node process for `/doctor`, `/auth status`, `/mcp list`
   - Replace with direct import of operational functions from `apps/unclecode-cli`
   - **Done**: `submit` is <20 lines, all logic in engine, no `execFile` for inline commands

### Phase 1b — Composer with ported paste handling (2-3 days)
4. Port `usePasteHandler` pattern from bundle client `BaseTextInput`
5. Build `<Composer>` component with paste + Kitty auto mode + history
6. Replace `ink-text-input` in work shell
   - **Done**: paste works, multiline works, existing flows preserved

### Phase 2 — Command consolidation + context interop (2-3 days)
7. Build `CommandRegistry` using existing `CommandMetadata` contracts
8. Migrate 3 scattered command layers into single registry
9. Move guidance loading into `packages/context-broker`, add GEMINI.md / UNCLECODE.md / conflict resolution, and point CLI/runtime callers to the new loader
   - Keep `src/workspace-guidance.ts` as a temporary shim only until the cutover is complete, then delete it
10. Add `/verbose` `/minimal` toggle

### Phase 3 — Unified shell (2-3 days)
11. Create shared bootstrap (provider, config, agent init — once)
12. Merge Session Center + Work Shell into single Ink app with view tabs
13. Remove `work-launcher.ts` spawn path
    - **Done**: `unclecode` launches single process, no screen flash

### Phase 4 — Real orchestration engine (3-5 days)
14. Build real coordinator with intent classifier (<10ms heuristic)
15. Implement planner with task graph
16. Build bounded executor pool with file ownership
17. Wire real orchestration events to verbose TUI
18. Add guardian auto-review

### Phase 5 — Plugin/skill loading + polish (2-3 days)
19. Plugin manifest loading + skill scanner
20. Plugin command injection into CommandRegistry
21. Startup latency measurement + budget
22. Doctor surface for all new subsystems

---

## 12. Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Input handling | Port `usePasteHandler` from bundle client | Proven paste handling, not reinventing |
| Kitty keyboard | `mode: 'auto'` (heuristic, not forced) | iTerm2/Terminal.app don't support Kitty |
| Command system | Consolidate 3 layers using existing contracts | `CommandMetadata` already has everything needed |
| Shell architecture | Single process, view-based | Eliminates child process spawn jank |
| Orchestration | In-process worker pool | I/O-bound API calls, shared context, no IPC overhead |
| Fake traces | Clean up BEFORE progressive disclosure | UX must not lie about engine capability |
| Context files | Extend existing `workspace-guidance.ts` | Already loads 2 files; add 2 more + conflict rules |
| Plugin format | Align with Claude Code `plugin.json` | Ecosystem compatibility |
| SoT | `apps/unclecode-cli` + `packages/*` | Root `src/*` phased out per cutover table |
| Bundle reuse | Selective (paste handler, plugin patterns) | Don't duplicate; don't wholesale copy |

---

## 13. Risks + Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Cutover breaks existing `unclecode` command | Users can't launch | Keep `src/index.ts` as thin shim until Phase 3 complete |
| Ported paste handler has bundle-specific deps | Build fails | Extract hook logic only, not entire component tree |
| CommandRegistry migration misses edge cases | Commands break | Run existing integration tests after each command migration |
| Worker concurrency bugs | Data races | File ownership registry + policy engine for all writes |
| Phase 4 scope (real orchestration) | Delays everything | Phases 0-3 deliver value independently — ship incrementally |

---

## 14. Success Criteria

### Runtime smoke matrix (cutover verification):

| Test | Command / Action | Expected |
|------|-----------------|----------|
| Launch | `unclecode` | Single Ink app, Work view active, no child process spawn |
| Launch work | `unclecode work` | Same unified shell, Work view |
| Launch center | `unclecode center` | Same unified shell, Sessions view |
| Paste | Paste 5-line code block in composer | All lines captured, no premature submit |
| Multiline | Type `\\` + Enter in iTerm2 | Line continuation works |
| Slash command | `/doctor` | Doctor output from consolidated CommandRegistry |
| Context | `/context` | Shows AGENTS.md + CLAUDE.md with file paths and conflict info |
| Sessions toggle | Press `Esc` in Work view | Sessions view appears, no screen flash |
| View switch | `Ctrl+2` in any view | Sessions view, composer disabled |
| Auth flow | `unclecode auth login --browser` | OAuth completes end-to-end |
| Simple query | Type "hello" in default mode | Response in <500ms, no orchestration traces |
| Verbose | `/v` then type "hello" | Honest trace (turn.started → provider.calling → turn.completed) |
| Ultrawork | Set ultrawork mode, complex prompt | Real coordinator/planner/executor traces (Phase 4) |

### Structural criteria:
- [ ] No business logic in React components (all in `WorkShellEngine`)
- [ ] No fake orchestrator.step events in `CodingAgent`
- [ ] All commands registered via `CommandRegistry` (no scattered if-chains)
- [ ] Every exported function in root `src/*` has been migrated to its target in `packages/*` (per cutover table in Section 2)
