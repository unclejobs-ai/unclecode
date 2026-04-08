# UncleCode Architecture Spec

## TL;DR
- UncleCode v1 is a **new engine-first root CLI**, not a wrapper over the vendored Claude client.
- It is a **public OSS, local-first coding agent platform** with a GPT-branded shell, a hidden capability-based provider core, hybrid runtime isolation, MCP-native tooling, bounded multi-agent orchestration, durable state, and a first-class but default-safe research mode.
- The implementation target is a **TypeScript workspace** with hard subsystem boundaries, contract-first development, and clean-room provenance.

## Product Position

### Core promise
Build a terminal-native coding agent that feels like a stronger successor to Claude/Codex-style tools, but with:
- clearer policy boundaries,
- better persistent state,
- better multi-agent orchestration,
- stronger MCP governance,
- safer runtime isolation,
- and a more opinionated GPT-first UX.

### V1 product stance
- **Primary audience**: local power users and OSS developers
- **Primary interface**: terminal CLI + TUI shell
- **Primary brand**: UncleCode
- **Primary provider UX**: OpenAI/Codex-first
- **Core compatibility stance**: internal provider abstraction allowed, but non-OpenAI support is an advanced/internal layer, not the product headline

### V1 non-goals
- No hosted SaaS control plane
- No plugin marketplace
- No remote collaboration/sync service
- No legacy transcript compatibility requirement with Claude/Codex formats
- No wrapper-first architecture around vendored Claude core
- No mandatory tri-model synthesis by default

## Guiding Decisions
- **Architecture type**: engine-first platform
- **Operating modes**: base/default mode plus `ultrawork`, `search`, and `analyze` as first-class runtime profiles
- **Runtime isolation**: local subprocess/worktree by default; escalate to Docker/E2B-style sandbox when policy requires it
- **Auth model**: OAuth device/browser flow + API key fallback + org/project context
- **Research mode**: built-in, but read-only by default with explicit escalation for write/exec/network
- **MCP scope in v1**: MCP client-first with bootstrap, config merge, capability enforcement, and lifecycle control; no marketplace/hosted registry
- **Persistence model**: append-only JSONL event log + checkpoints + SQLite-backed recall/project memory
- **OS target**: macOS/Linux first-class; Windows best-effort in v1
- **UI stack**: event-stream-driven TypeScript TUI shell with renderer isolation for future higher-performance replacement

## Implementation Defaults Locked For V1
- **Workspace/build**: npm workspaces + TypeScript project references
- **Shell command parser**: Commander for top-level CLI commands
- **Interactive TUI shell**: Ink-based renderer in v1, fed only by engine events
- **Lint/format**: Biome
- **Local structured store**: `better-sqlite3` for the SQLite-backed recall/project-memory layer
- **Secure credential storage**: `keytar` for OS keychain access, with strict local file fallback only when keychain is unavailable
- **Sandbox backend**: local Docker-compatible adapter in v1; E2B remains a future adapter target, not a required v1 dependency
- **Repo-map strategy**: git-aware changed-file/hotspot graph + top-level symbol extraction for first-class languages in the repo; no required external ctags dependency in v1

## Operating Modes

### Mode model
UncleCode should treat modes as **structured operating profiles**, not ad-hoc prompt snippets. A mode can influence:
- prompt sections,
- exploration depth,
- delegation bias,
- output verbosity,
- approval strictness,
- verification requirements,
- TUI badges and session metadata.

### V1 modes
1. **default**
   - balanced execution mode
   - normal retrieval, normal delegation, standard verification

2. **ultrawork**
   - maximum-precision execution mode
   - stronger certainty protocol, stricter completion checks, mandatory manual QA, narrower scope discipline

3. **search**
   - research-max mode
   - aggressive parallel exploration, broader repo/doc search, delayed execution until search synthesis is complete

4. **analyze**
   - reasoning-first mode
   - forces context-gathering before deep execution, emphasizes synthesis and specialist consultation for hard problems

### Activation rules
- explicit CLI flag: `unclecode --mode <name>`
- explicit shell command: `unclecode mode set <name>`
- explicit slash command: `/mode <name>`
- optional project default in config
- session override persists in checkpoint metadata until changed

### Non-rule
- modes may bias routing and prompt structure, but they must **not** bypass policy-engine checks, trust zones, or capability manifests.

## Why the current repo is not the target architecture
- The root `src/index.ts`, `src/cli.tsx`, `src/agent.ts`, `src/providers.ts`, `src/tools.ts`, `src/config.ts` form a small clean-room seed, but not a full platform.
- The nested `Leonxlnx-claude-code/` tree contains stronger patterns for commands, query orchestration, MCP, skills, and agents, but the current integration depends on brittle launcher/config/branding shims.
- Therefore UncleCode should **port patterns, not preserve the existing wrapper-vendored coupling**.

## Source Pattern Adoption

### Reuse directly as design patterns
- Claude-code-derived command typing, command registry, query engine separation, tool orchestration, skills loading, agent/worktree/session seams
- OpenCode plan/build mode split and persistent-session mindset
- OpenHands action/observation runtime model and sandbox discipline
- Hermes closed learning loop, iteration budgets, context compression, recall model
- oh-my-* durable state dir, hooks, role prompts, workflow overlays, setup/doctor, HUD concepts
- pi-mono event-stream runtime and session forking model
- mmbridge adapter registry, context packet assembly, freshness gates
- autoresearch living research docs, JSONL logs, ideas backlog, benchmark/check split
- Aider repo-map/git-aware context reduction
- Cline permission-gated plan/act reliability

### Adapt, not copy
- tmux/team orchestration
- differential high-performance TUI rendering
- hidden multi-provider core
- autonomous research workflows
- stage-contract/PDCA gating
- state MCP patterns
- E2B sandbox escalation

### Inspiration only
- mascot-heavy branding
- tri-model-by-default synthesis
- mandatory deep interview on every task
- updater/distribution assumptions tied to other ecosystems
- heavy user-personality modeling

## Canonical System Decomposition

### 1. `apps/unclecode-cli`
The executable entrypoint.

Responsibilities:
- parse CLI arguments,
- bootstrap auth/session/config,
- start TUI or one-shot mode,
- dispatch to setup/doctor/auth/config commands,
- never own business logic.

### 2. `packages/contracts`
Single source of truth for:
- event schema,
- trust zones,
- approval intents,
- provider capability contract,
- MCP capability manifest,
- session checkpoint types,
- command/skill/tool contracts.

This package must be built before any runtime implementation.

### 3. `packages/config-core`
Configuration and prompt assembly layer.

Responsibilities:
- load and merge built-in, plugin, project, user, env, flag, and session settings,
- assemble prompts structurally from declared sections,
- expose effective config/prompt inspection for debugging.

### 4. `packages/context-broker`
Large-context control layer.

Responsibilities:
- repo map generation,
- hotspot and diff summarization,
- freshness gating,
- token-budgeted context packet assembly,
- research/session bundle preparation.

### 5. `packages/policy-engine`
The only authority that decides **allow / prompt / deny**.

Inputs:
- action intent,
- trust zone,
- current mode,
- user config,
- session overrides.

Outputs:
- policy decision,
- required approval text,
- escalation requirement,
- logging metadata.

This prevents hidden bypass paths across built-in tools, MCP tools, subagents, and runtime backends.

### 6. `packages/session-store`
Persistent state layer.

Must store:
- append-only JSONL session event logs,
- periodic checkpoints,
- SQLite recall index,
- project memory,
- research artifacts/ideas backlog,
- redacted audit metadata.

Design rule:
- transcripts are canonical for replay,
- checkpoints are optimization artifacts,
- memory is separately queryable and project-scoped.

### 7. `packages/runtime-broker`
Execution abstraction.

Backends:
- local subprocess,
- local git worktree session,
- sandbox adapter interface,
- future E2B-style remote sandbox adapter.

V1 behavior:
- local default,
- sandbox escalation for destructive, networked, or long-running tasks.

### 8. `packages/providers`
Provider/auth layer.

Submodules:
- auth contract,
- OpenAI OAuth device/browser flow,
- API-key fallback,
- provider capability resolver,
- model registry,
- internal compatibility adapters.

Important rule:
- business logic targets **capabilities**, not raw vendor APIs.

### 9. `packages/mcp-host`
MCP client and governance layer.

Responsibilities:
- config loading/merge,
- connection lifecycle,
- auth plumbing,
- capability manifest enforcement,
- source provenance labels,
- built-in vs local vs remote MCP trust tiers.

### 10. `packages/orchestrator`
Core execution engine.

Responsibilities:
- query loop,
- command router,
- tool orchestration,
- bounded worker fan-out,
- cancellation/timeouts,
- background tasks,
- research-mode execution,
- context packet assembly,
- repo-map integration.

### 11. `packages/tui`
Terminal renderer only.

Responsibilities:
- consume engine events,
- render streaming output,
- show status/HUD/approvals,
- capture user input,
- manage view state,
- never own orchestration or policy.

## Trust Zones and Policy Model

### Trust zones
1. System policy and built-in contracts
2. User input
3. Workspace/repo content
4. Tool output from local runtime
5. Tool output from MCP/plugin servers
6. Model output
7. Secrets/auth store
8. Sandbox runtime

### Intent classes
- read filesystem
- mutate filesystem
- run local subprocess
- run sandbox subprocess
- access network
- use remote MCP
- access credentials
- spawn subagent
- persist memory/state

### Approval model
- intent-based, not tool-name-based
- every action path calls the same policy engine
- subagents inherit reduced authority by default
- research mode begins read-only

## Prompt and Config Precedence

Frozen precedence chain:
1. built-in defaults/contracts
2. built-in mode profiles
3. installed extensions/plugins
4. project config
5. user config
6. environment variables
7. CLI flags
8. session overrides

Design rules:
- no opaque string concatenation as the primary prompt model
- prompts are assembled structurally from sections
- effective config/prompt must be inspectable in a debug surface
- mode profiles are declarative overlays, not raw prompt dumps
- every effective prompt/config inspection must show the active mode and which constraints it injected

## Session and Memory Model

### Session artifacts
- `events.jsonl` — canonical append-only log
- `checkpoint.json` — resumable derived state
- `memory.db` — recall/project-memory index
- `artifacts/` — evidence, reports, research outputs
- `ideas.md` — deferred ideas backlog
- `session.json` — current mode, provider, runtime, and policy metadata snapshot

### Session behaviors
- resume after crash without duplicating approved tool calls
- fork a session from a prior checkpoint/event
- attach/re-attach background work
- isolate project memory by repo identity

## Command, Skill, and Workflow Model

### Command categories
- shell commands (`unclecode auth login`, `unclecode doctor`)
- slash commands (`/model`, `/mode`, `/mcp`, `/agents`, `/memory`, `/research`)
- keyword/intent triggers for advanced workflows

### Skill model
- markdown-defined, frontmatter-backed skills
- project-local + user-global scopes
- explicit triggers and capability declarations

### Workflow model
- workflows are first-class orchestrator actions, not shell-script hacks
- review/research/security pipelines can be exposed as tools
- PDCA/stage contracts are available, but only for complex modes that benefit from them
- search/analyze/ultrawork are mode overlays over the same engine, not separate products or separate orchestrators

## Research Mode

### V1 design
- built-in feature, not separate product
- starts read-only
- uses repo-map + context-packet assembly + freshness gates
- maintains `research.md`, `ideas.md`, `runs.jsonl` style artifacts
- can escalate into execution only via explicit policy approval

### Why this matters
This lets UncleCode absorb the best parts of `pi-autoresearch`, `karpathy/autoresearch`, `Hermes`, and `mmbridge` without turning every normal coding session into a runaway autonomous loop.

## TUI and ASCII UX

### V1 principles
- UncleCode-first visual identity
- strong ASCII/statusline feel
- streaming-first UX
- separate views for transcript, approvals, workers, MCP status, and research state
- render from append-only events with backpressure handling
- current active mode must always be visible in the shell HUD/statusline

### V1 implementation choice
- stay in TypeScript for engine/UI compatibility
- structure renderer so future migration to a lower-level/high-performance terminal layer remains possible

## Setup, Doctor, and Productization

V1 must include:
- `unclecode auth login`
- `unclecode auth status`
- `unclecode doctor`
- `unclecode mode set`
- `unclecode mode status`
- `unclecode setup`
- `unclecode sessions`
- `unclecode resume`
- `unclecode research`

Why:
- public OSS local CLI products live or die on setup clarity and state recoverability.

## Clean-Room and Provenance Rules

### Allowed
- public OSS reference patterns
- behaviorally similar but newly implemented contracts
- selective reuse of code only where provenance is clear and license-compatible

### Not allowed
- direct dependence on leaked/proprietary code assumptions
- preserving vendored Claude-specific global-state coupling
- ambiguous provenance around prompts, registries, or orchestration internals

Every major subsystem in the implementation plan must be labeled as one of:
- rewritten from scratch,
- clean-room adaptation,
- licensed reuse,
- inspiration only.

## V1 Scope Freeze

### Must ship in v1
- new root CLI and package boundaries
- contracts + policy engine
- four-mode operating-profile system (`default`, `ultrawork`, `search`, `analyze`)
- event log + checkpoint + memory store
- local runtime broker + sandbox escalation interface
- OpenAI OAuth + API key fallback
- MCP bootstrap/config/governance
- bounded multi-agent orchestration
- repo-map/context packet support
- TUI shell and setup/doctor flows
- research mode with read-only default

### Deferred from v1
- plugin marketplace
- hosted sync
- collaborative sessions
- universal cross-provider parity UI
- remote-first runtime control plane
- fully automatic self-learning skill authoring by default

## Recommended Build Order
1. contracts
2. policy engine
3. session store
4. runtime broker
5. provider/auth layer
6. MCP governance layer
7. orchestrator core
8. TUI shell
9. research mode
10. performance hardening and polish
