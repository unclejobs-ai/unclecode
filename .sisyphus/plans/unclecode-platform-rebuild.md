# UncleCode Engine-First Platform Rebuild

## TL;DR
> **Summary**: Rebuild the current wrapper-plus-vendored-client repo into UncleCode, a new engine-first OpenAI/Codex-first local OSS coding-agent CLI with durable state, hybrid runtime isolation, MCP-native tooling, bounded multi-agent orchestration, and a first-class research workflow.
> **Deliverables**:
> - new workspace/package architecture
> - contract-first engine, policy, session, runtime, provider, MCP, orchestrator, and TUI subsystems
> - OpenAI/Codex-style OAuth + API-key auth
> - setup/doctor/session/research command surface
> - clean-room provenance and migration/cutover plan
> **Effort**: XL
> **Parallel**: YES - 4 waves
> **Critical Path**: 1 → 2 → 6 → 7/8/10 → 12 → 14 → 16 → 17

## Context
### Original Request
Transform the current Claude-oriented CLI/wrapper into a GPT-first CLI/platform with slash commands, MCP, agent orchestration, ASCII/TUI identity, Codex/OpenHands/OpenCode-inspired runtime ideas, OAuth support, and major design improvements.

### Interview Summary
- Product form: full platform rebuild
- Product target: public OSS local CLI
- Positioning: UncleCode-branded, OpenAI/Codex-first UX with hidden multi-provider core allowed
- Runtime model: hybrid local-first with sandbox escalation
- Operating model: base/default mode plus `ultrawork`, `search`, and `analyze` must be integrated naturally into the same engine
- Core strategy: new first-class root CLI, not a reskinned vendored core
- Research mode: first-class feature, but bounded and policy-controlled
- Auth: Codex/OpenAI-style OAuth support plus API-key fallback
- User expectation: exhaustive reference-driven redesign, not cosmetic rebranding

### Metis Review (gaps addressed)
- Freeze one policy authority across CLI/runtime/agents/plugins
- Make event log + checkpoint + redaction + replay metadata canonical
- Use intent-based approvals and explicit trust zones
- Separate provider capability contract from raw vendor APIs
- Treat MCP/plugin surfaces as governed capability domains, not trusted extensions
- Keep TUI as an event consumer, not business-logic owner
- Add clean-room provenance tracking to prevent wrapper/vendored-core drift

## Work Objectives
### Core Objective
Ship a decision-complete rebuild plan for converting the repository into a modular UncleCode platform whose core engine, policy, session, runtime, auth, MCP, orchestration, and TUI layers are implemented as first-class packages instead of wrapper glue.

### Deliverables
- npm-workspace package topology for UncleCode
- contracts package for events, policies, capabilities, commands, and sessions
- mode-profile system for `default`, `ultrawork`, `search`, and `analyze`
- policy engine with trust-zone matrix and deterministic allow/prompt/deny results
- JSONL event store + checkpoints + SQLite project memory/recall
- local runtime broker + sandbox escalation interface
- provider/auth subsystem with OAuth device flow and API-key fallback
- MCP bootstrap/config/governance subsystem
- command router, skills layer, orchestrator, and research mode
- event-driven TUI shell with setup/doctor/session/research surfaces
- migration/cutover/provenance documentation

### Definition of Done (verifiable conditions with commands)
- `npm run lint` passes for the new workspace
- `npm run check` passes for all TypeScript packages
- `npm run build` produces the UncleCode CLI packages without vendored-core coupling
- `node --test tests/**/*.test.mjs` passes for compatibility/contract integration coverage
- `npm run test:contracts` passes for event/policy/provider/MCP/runtime contracts
- `npm run test:integration` passes for session resume, auth fallback, MCP gating, and agent orchestration
- `npm run unclecode -- --version` reports the new CLI identity
- `npm run unclecode -- doctor` reports a healthy local installation with actionable failures when unhealthy

### Must Have
- new engine-first root CLI
- TypeScript npm workspace boundaries
- contract-test-first implementation order
- four-mode operating-profile system integrated into command/config/orchestrator/TUI surfaces
- durable `.unclecode/` state conventions
- project-scoped memory and session resume/fork
- OpenAI OAuth + API-key fallback
- MCP capability enforcement and provenance labeling
- hybrid runtime isolation
- bounded multi-agent orchestration and research mode
- clear clean-room provenance for reused/adapted/inspiration-only areas

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- no wrapper-first design around `Leonxlnx-claude-code/claw-dev-launcher.js`
- no brittle branding patching like `Leonxlnx-claude-code/patch-branding.js`
- no hidden bypass path around the policy engine
- no plugin marketplace, hosted sync, or remote control plane in v1
- no mandatory tri-model synthesis by default
- no subjective/manual-only acceptance criteria
- no unverifiable “looks right” UI-only completion claims

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: **TDD**
- Framework: Node `node:test` for repo-native contract/integration coverage, TypeScript workspace checks via `tsc`, and Biome for lint/format discipline
- QA policy: Every task below includes at least one happy-path and one failure/edge-path scenario
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: workspace foundation, contracts, config/prompt precedence + mode profiles, session storage, repo-map/context broker

Wave 2: policy engine, provider/auth, runtime broker, sandbox escalation, MCP governance

Wave 3: command/skill router + mode switching, orchestrator/query engine, agent runtime + research mode, TUI shell, setup/doctor/session flows

Wave 4: performance/observability hardening, migration/cutover, provenance cleanup, release surface validation

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1 | - | 2,3,4,5 |
| 2 | 1 | 6,7,8,10,11,12,13 |
| 3 | 1 | 6,11,14,15 |
| 4 | 1,2 | 12,13,15,16,17 |
| 5 | 1,2 | 12,13 |
| 6 | 2,3 | 8,10,12,13,14 |
| 7 | 2,3 | 12,14,15,17 |
| 8 | 2,6 | 9,12,13,15 |
| 9 | 2,6,8 | 12,13,15 |
| 10 | 2,6 | 11,12,13,14 |
| 11 | 2,3,10 | 12,13,14,15 |
| 12 | 2,4,5,6,7,8,10,11 | 13,14,15,16,17 |
| 13 | 4,5,6,8,9,10,11,12 | 14,15,16 |
| 14 | 3,6,7,10,11,12,13 | 15,16,17 |
| 15 | 4,7,8,9,11,12,14 | 16,17 |
| 16 | 4,12,13,14,15 | 17 |
| 17 | 4,7,12,14,15,16 | F1-F4 |

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 5 tasks → unspecified-high / deep
- Wave 2 → 5 tasks → unspecified-high / deep / writing
- Wave 3 → 5 tasks → unspecified-high / deep / visual-engineering
- Wave 4 → 2 tasks → deep / writing

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [ ] 1. Scaffold UncleCode workspace and package boundaries

  **What to do**: Replace the single-package root with npm workspaces and TypeScript project references. Create `apps/unclecode-cli` plus `packages/contracts`, `packages/config-core`, `packages/context-broker`, `packages/policy-engine`, `packages/session-store`, `packages/runtime-broker`, `packages/providers`, `packages/mcp-host`, `packages/orchestrator`, and `packages/tui`. Use Commander for top-level shell commands, Ink for the interactive TUI package boundary, add root scripts for `lint`, `check`, `build`, `test:contracts`, `test:integration`, and `unclecode` execution, and standardize lint/format on Biome. Keep the existing vendored directories present only as reference inputs, not runtime dependencies.
  **Must NOT do**: Do not preserve `bin/claw-dev.cjs` or `Leonxlnx-claude-code/claw-dev-launcher.js` as the new primary runtime path. Do not delete the vendored reference trees in this task.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: workspace restructuring touches root config, scripts, and package topology.
  - Skills: `[]` — why needed: no additional execution skill beyond normal implementation discipline.
  - Omitted: `['frontend-design']` — why not needed: this is package architecture, not UI work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2,3,4,5 | Blocked By: none

  **References**:
  - Pattern: `package.json` — current root script surface that must be replaced by workspace scripts.
  - Pattern: `tsconfig.json` — current TypeScript baseline to evolve into project references.
  - Pattern: `src/index.ts` — current small root entrypoint that informs the new CLI package boundary.
  - Pattern: `Leonxlnx-claude-code/src/main.tsx` — reference for a real CLI bootstrap boundary.
  - External: `https://github.com/badlogic/pi-mono` — monorepo package-boundary inspiration.

  **Acceptance Criteria**:
  - [ ] `npm install` completes with the workspace topology intact.
  - [ ] `npm run check` resolves all workspace projects and fails only on real type issues.
  - [ ] `npm run build` emits build artifacts for every new package without depending on the vendored Claude launcher.
  - [ ] `npm run lint` runs through a single repo-wide Biome configuration.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Workspace bootstrap succeeds
    Tool: Bash
    Steps: Run `npm install && npm run check && npm run build` from repo root.
    Expected: Workspaces resolve, project references compile, and no command shells into `Leonxlnx-claude-code/claw-dev-launcher.js`.
    Evidence: .sisyphus/evidence/task-1-workspace-bootstrap.txt

  Scenario: Broken workspace dependency is surfaced clearly
    Tool: Bash
    Steps: Temporarily remove one package reference in a controlled test branch and run `npm run check`.
    Expected: The check fails with a deterministic package-resolution or project-reference error instead of a silent partial build.
    Evidence: .sisyphus/evidence/task-1-workspace-error.txt
  ```

  **Commit**: YES | Message: `chore(workspace): scaffold unclecode package boundaries` | Files: `package.json`, `tsconfig.json`, `apps/**`, `packages/**`, `biome.json`

- [ ] 2. Define canonical contracts package

  **What to do**: Implement `packages/contracts` as the first source of truth for engine events, trust zones, approval intents, provider capabilities, MCP capability manifests, session checkpoints, command types, skill metadata, mode-profile contracts (`default`, `ultrawork`, `search`, `analyze`), and background-task lifecycle states. Add contract fixtures and tests before any subsystem implementation depends on them.
  **Must NOT do**: Do not put business logic in this package. Do not let downstream packages redefine contract shapes locally.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task locks the type system and all subsystem interfaces.
  - Skills: `[]` — why needed: core architecture work.
  - Omitted: `['webapp-testing']` — why not needed: no browser/UI interaction yet.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 4,5,6,7,8,10,11,12,13 | Blocked By: 1

  **References**:
  - Pattern: `Leonxlnx-claude-code/src/types/command.ts` — command-type separation reference.
  - Pattern: `Leonxlnx-claude-code/src/Tool.ts` — tool contract/reference model.
  - Pattern: `Leonxlnx-claude-code/src/QueryEngine.ts` — session/query abstraction seam.
  - Pattern: `shared/openaiRuntimeOptions.js` — capability/options normalization inspiration.
  - External: `https://github.com/unclejobs-ai/mmbridge` — adapter contract inspiration.
  - External: `https://github.com/unclejobs-ai/second-claude-code` — stage-contract modeling inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/contracts/*.test.mjs` passes for event, policy-intent, provider-capability, MCP-manifest, mode-profile, and session-checkpoint fixtures.
  - [ ] `npm run check` confirms no contract duplication leaks into downstream packages.
  - [ ] Contract exports are consumed by at least one smoke-test fixture from each planned subsystem package.

  **QA Scenarios**:
  ```
  Scenario: Contract fixtures validate cross-package imports
    Tool: Bash
    Steps: Run `node --test tests/contracts/*.test.mjs && npm run check`.
    Expected: Contract fixtures pass and downstream smoke imports compile without redefining local shapes.
    Evidence: .sisyphus/evidence/task-2-contracts.txt

  Scenario: Invalid capability manifest is rejected
    Tool: Bash
    Steps: Run a fixture test that feeds an MCP or provider manifest with a missing required capability field.
    Expected: Validation fails with a deterministic schema error and no permissive fallback.
    Evidence: .sisyphus/evidence/task-2-contracts-error.txt
  ```

  **Commit**: YES | Message: `test(contracts): define unclecode canonical interfaces` | Files: `packages/contracts/**`, `tests/contracts/**`

- [ ] 3. Implement config-core and prompt precedence inspector

  **What to do**: Build `packages/config-core` to load and merge built-in defaults, built-in mode profiles, plugin overlays, project config, user config, environment variables, CLI flags, and session overrides in the frozen precedence order. Expose an “effective config/prompt” inspector for debugging and support. Structure prompts into sections instead of raw string concatenation, and treat `default`, `ultrawork`, `search`, and `analyze` as declarative overlays rather than pasted prompt blobs.
  **Must NOT do**: Do not allow hidden prompt mutations by plugins or commands outside the precedence chain. Do not bury effective config state in opaque caches.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: precedence bugs create system-wide unpredictability.
  - Skills: `['ai-prompt-config']` — why needed: prompt layering quality and structure.
  - Omitted: `['frontend-design']` — why not needed: no visual design yet.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 6,7,11,14,15 | Blocked By: 1

  **References**:
  - Pattern: `src/config.ts` — current small env/config loader.
  - Pattern: `Leonxlnx-claude-code/src/utils/config.ts` — central config-system reference.
  - Pattern: `Leonxlnx-claude-code/src/skills/loadSkillsDir.ts` — skill/config source layering reference.
  - External: `https://github.com/Yeachan-Heo/oh-my-codex` — operating contract + prompt overlay inspiration.
  - External: `https://github.com/unclejobs-ai/second-claude-code` — stage-contract and prompt-gating inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/config/effective-config.test.mjs` passes for precedence ordering, active-mode visibility, and override visibility.
  - [ ] `node --test tests/config/effective-prompt.test.mjs` passes for structural prompt assembly and mode overlay injection.
  - [ ] `npm run unclecode -- config explain` prints the effective sources for a resolved setting/prompt section.

  **QA Scenarios**:
  ```
  Scenario: Effective config reflects precedence order
    Tool: Bash
    Steps: Create test fixtures for project config, user config, env, and CLI flag overrides; run `node --test tests/config/effective-config.test.mjs`.
    Expected: The resolved setting follows built-in < plugin < project < user < env < flag < session order and the inspector reports the winning source.
    Evidence: .sisyphus/evidence/task-3-config.txt

  Scenario: Hidden prompt mutation is rejected
    Tool: Bash
    Steps: Run a negative fixture where a plugin attempts to inject an undeclared prompt section outside the allowed contract.
    Expected: The merge fails with a contract error instead of silently altering the system prompt.
    Evidence: .sisyphus/evidence/task-3-config-error.txt

  Scenario: Mode overlay is inspectable
    Tool: Bash
    Steps: Run a fixture that activates `--mode ultrawork` and execute `npm run unclecode -- config explain`.
    Expected: The inspector shows the active mode and exactly which output/verification/delegation constraints were injected by that mode.
    Evidence: .sisyphus/evidence/task-3-config-mode.txt
  ```

  **Commit**: YES | Message: `feat(config): add precedence engine and effective inspector` | Files: `packages/config-core/**`, `tests/config/**`, `apps/unclecode-cli/**`

- [ ] 4. Build session store, checkpoints, and project memory

  **What to do**: Implement `packages/session-store` with append-only JSONL event logs per session, resumable checkpoints, `better-sqlite3`-backed recall/project memory, redaction rules, and research artifact directories. Support session fork/resume, project-scoped memory isolation, and persisted active-mode metadata across resumes.
  **Must NOT do**: Do not make checkpoints the source of truth. Do not persist raw secrets or unredacted tool outputs.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: persistence/replay is a foundational reliability boundary.
  - Skills: `[]` — why needed: subsystem architecture and persistence logic.
  - Omitted: `['manual-review']` — why not needed: this is implementation planning, not review output.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 12,13,15,16,17 | Blocked By: 1,2

  **References**:
  - Pattern: `Leonxlnx-claude-code/src/utils/sessionStorage.ts` — session persistence seam.
  - Pattern: `Leonxlnx-claude-code/src/utils/sessionRestore.ts` — restore path reference.
  - Pattern: `shared/openaiAuth.js` — sensitive-state handling inspiration.
  - External: `https://github.com/badlogic/pi-mono` — JSONL session forking reference.
  - External: `https://github.com/davebcn87/pi-autoresearch` — append-only research log and ideas-backlog inspiration.
  - External: `https://github.com/nousresearch/hermes-agent` — SQLite recall/memory reference.

  **Acceptance Criteria**:
  - [ ] `node --test tests/session-store/*.test.mjs` passes for append, checkpoint, resume, fork, redaction, and project-memory isolation.
  - [ ] `npm run test:integration -- session-resume` passes for crash-and-resume without duplicate tool execution.
  - [ ] A fixture session can be replayed from events and reaches the same derived checkpoint state.

  **QA Scenarios**:
  ```
  Scenario: Session resume from checkpoint after crash
    Tool: Bash
    Steps: Run `npm run test:integration -- session-resume` against a fixture that crashes after partial event write.
    Expected: Resume rebuilds state from event log + checkpoint and does not duplicate the last approved tool action.
    Evidence: .sisyphus/evidence/task-4-session-resume.txt

  Scenario: Secret redaction prevents unsafe persistence
    Tool: Bash
    Steps: Run `node --test tests/session-store/redaction.test.mjs` with fixture outputs containing API-key/token patterns.
    Expected: Redacted artifacts persist safe placeholders only; raw secrets never appear in stored events or memory rows.
    Evidence: .sisyphus/evidence/task-4-session-redaction.txt
  ```

  **Commit**: YES | Message: `feat(session): implement event log checkpoint and memory store` | Files: `packages/session-store/**`, `tests/session-store/**`, `.unclecode/**`

- [ ] 5. Add repo-map and context-broker subsystem

  **What to do**: Implement `packages/context-broker` to build a git-aware repo map, hotspot summary, token-budgeted context packets, freshness signals, and research/session context bundles. Use it as the only path for large-context assembly into the orchestrator.
  **Must NOT do**: Do not feed whole-repo file dumps directly into model context. Do not let stale context packets bypass freshness checks.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: context quality and budget discipline directly control product performance.
  - Skills: `[]` — why needed: architectural subsystem work.
  - Omitted: `['webapp-testing']` — why not needed: no browser coverage.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 12,13 | Blocked By: 1,2

  **References**:
  - Pattern: `shared/providerModels.js` — catalog/normalization inspiration.
  - External: `https://github.com/Aider-AI/aider` — repo-map and git-aware context winner.
  - External: `https://github.com/unclejobs-ai/mmbridge` — context packet assembler reference.
  - External: `https://github.com/davebcn87/pi-autoresearch` — freshness/check separation inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/context-broker/*.test.mjs` passes for repo-map generation, freshness gating, token-budget trimming, and packet provenance labeling.
  - [ ] Context packets include changed-files, hotspots, policy-relevant signals, and bounded token estimates.
  - [ ] Stale git or memory state causes an explicit freshness-gate failure, not silent degraded context.

  **QA Scenarios**:
  ```
  Scenario: Repo map produces bounded context packet
    Tool: Bash
    Steps: Run `node --test tests/context-broker/repo-map.test.mjs` on a medium-size fixture repo.
    Expected: The packet includes git-aware hotspots and stays within the declared token budget.
    Evidence: .sisyphus/evidence/task-5-context.txt

  Scenario: Stale packet is blocked
    Tool: Bash
    Steps: Modify the fixture repo after packet generation, then run `node --test tests/context-broker/freshness.test.mjs`.
    Expected: The broker raises a freshness error and requires regeneration before orchestration continues.
    Evidence: .sisyphus/evidence/task-5-context-error.txt
  ```

  **Commit**: YES | Message: `feat(context): add repo map and freshness-gated context packets` | Files: `packages/context-broker/**`, `tests/context-broker/**`

- [ ] 6. Implement policy engine and trust-zone matrix

  **What to do**: Build `packages/policy-engine` so every action path resolves through a deterministic allow/prompt/deny engine keyed by trust zone, action intent, operating mode (`default`, `ultrawork`, `search`, `analyze`), runtime mode, and user/session overrides. Add a machine-readable trust-zone matrix and approval-message generator.
  **Must NOT do**: Do not hardcode approvals inside individual tools, commands, or providers. Do not grant full parent authority to subagents by default.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: policy consistency is the main safety boundary across the entire platform.
  - Skills: `[]` — why needed: architecture and safety design.
  - Omitted: `['frontend-design']` — why not needed: no UI styling work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 8,10,12,13,14 | Blocked By: 2,3

  **References**:
  - Pattern: `Leonxlnx-claude-code/src/services/tools/toolOrchestration.ts` — batching/serial-mutation orchestration seam.
  - Pattern: `Leonxlnx-claude-code/src/tools/AgentTool/AgentTool.tsx` — subagent authority and lifecycle seam.
  - External: `https://github.com/cline/cline` — permission-gated plan/act reference.
  - External: `https://github.com/unclejobs-ai/second-claude-code` — hard-gate/stage decision inspiration.
  - External: `https://github.com/lastmile-ai/mcp-agent` — capability-governed MCP orchestration reference.

  **Acceptance Criteria**:
  - [ ] `node --test tests/policy-engine/*.test.mjs` passes for every trust-zone/action/mode combination defined by the matrix.
  - [ ] A subagent fixture inherits reduced authority unless explicitly delegated broader capabilities.
  - [ ] Every downstream subsystem can request a policy decision through one shared interface.

  **QA Scenarios**:
  ```
  Scenario: Intent-based decision matrix is deterministic
    Tool: Bash
    Steps: Run `node --test tests/policy-engine/*.test.mjs`.
    Expected: The same trust-zone/action/mode tuple always yields the same allow/prompt/deny result and approval text.
    Evidence: .sisyphus/evidence/task-6-policy.txt

  Scenario: Unauthorized subagent escalation is denied
    Tool: Bash
    Steps: Run a fixture that attempts filesystem mutation or network access from a reduced-authority subagent without delegation.
    Expected: The policy engine returns deny or prompt and the action does not execute.
    Evidence: .sisyphus/evidence/task-6-policy-error.txt
  ```

  **Commit**: YES | Message: `feat(policy): add trust-zone matrix and approval engine` | Files: `packages/policy-engine/**`, `tests/policy-engine/**`

- [ ] 7. Build provider adapters and auth subsystem

  **What to do**: Implement `packages/providers` with a capability-first adapter interface, OpenAI OAuth device/browser login, API-key fallback, org/project context support, `keytar`-backed credential storage with strict file fallback, model registry, and explicit capability mismatch errors. Keep non-OpenAI adapters behind advanced configuration and do not market them as the primary UX in v1.
  **Must NOT do**: Do not couple orchestration logic to raw OpenAI response semantics. Do not store refresh tokens in plaintext when a keychain is available.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: auth/provider logic is security-sensitive and touches multiple contracts.
  - Skills: `['ai-prompt-config']` — why needed: precise provider/system prompt capability negotiation.
  - Omitted: `['using-git-worktrees']` — why not needed: task is adapter/auth design, not worktree management.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 12,14,15,17 | Blocked By: 2,3

  **References**:
  - Pattern: `shared/openaiAuth.js` — existing OpenAI/Codex auth-resolution seam.
  - Pattern: `shared/openaiResponsesCompat.js` — vendor-shape translation inspiration.
  - Pattern: `shared/openaiRuntimeOptions.js` — reasoning/service-tier normalization inspiration.
  - Test: `tests/openaiAuth.test.mjs` — auth fallback regression coverage starting point.
  - Test: `tests/openaiResponsesCompat.test.mjs` — compatibility translation reference.
  - External: `https://platform.openai.com/docs/api-reference/authentication` — auth contract reference.
  - External: `https://datatracker.ietf.org/doc/html/rfc8628` — device-flow reference.

  **Acceptance Criteria**:
  - [ ] `node --test tests/providers/*.test.mjs` passes for OAuth login, refresh, API-key fallback, and capability mismatch handling.
  - [ ] `npm run unclecode -- auth status` reports active auth source, org/project context, and expiry state without leaking secrets.
  - [ ] Provider adapters expose one common capability contract consumed by the orchestrator.

  **QA Scenarios**:
  ```
  Scenario: OAuth login and API-key fallback both satisfy one contract
    Tool: Bash
    Steps: Run `node --test tests/providers/auth-contract.test.mjs` with OAuth fixture and env-based API-key fixture.
    Expected: Both fixtures produce the same provider-auth state shape and downstream capability resolver input.
    Evidence: .sisyphus/evidence/task-7-auth.txt

  Scenario: Expired or malformed token is handled safely
    Tool: Bash
    Steps: Run `node --test tests/providers/token-refresh.test.mjs` with an expired access token and invalid refresh token fixture.
    Expected: Refresh failure surfaces an actionable auth error, secrets remain redacted, and no silent fallback occurs.
    Evidence: .sisyphus/evidence/task-7-auth-error.txt
  ```

  **Commit**: YES | Message: `feat(providers): add auth abstraction and openai-first adapters` | Files: `packages/providers/**`, `tests/providers/**`

- [ ] 8. Implement local runtime broker and worktree execution path

  **What to do**: Build `packages/runtime-broker` with a local subprocess runner, git-worktree-aware workspace handling, cancellation, stdout/stderr capture, deterministic environment scoping, and policy-engine integration. The broker must expose one runtime contract that later sandbox adapters can satisfy.
  **Must NOT do**: Do not let tools shell out directly around the broker. Do not bind runtime ownership to the TUI.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: execution is central to safety, correctness, and future sandbox parity.
  - Skills: `[]` — why needed: subsystem architecture and runtime control.
  - Omitted: `['frontend-design']` — why not needed: no UI work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 9,12,13,15 | Blocked By: 2,6

  **References**:
  - Pattern: `src/index.ts` — current local CLI execution entrypoint.
  - Pattern: `Leonxlnx-claude-code/src/utils/worktree.ts` — worktree seam reference.
  - Pattern: `Leonxlnx-claude-code/src/setup.ts` — session/workspace bootstrap reference.
  - External: `https://github.com/badlogic/pi-mono` — evented runtime/session boundary inspiration.
  - External: `https://github.com/OpenHands/OpenHands` — runtime contract and observation-loop inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/runtime-broker/local-runtime.test.mjs` passes for subprocess execution, cancellation, environment scoping, and worktree selection.
  - [ ] Every local tool fixture routes through the broker contract instead of direct shell access.
  - [ ] Runtime events are emitted in the canonical contracts format.

  **QA Scenarios**:
  ```
  Scenario: Local runtime executes via canonical broker
    Tool: Bash
    Steps: Run `node --test tests/runtime-broker/local-runtime.test.mjs`.
    Expected: Commands execute with captured output, deterministic cwd/env, and canonical runtime events.
    Evidence: .sisyphus/evidence/task-8-runtime.txt

  Scenario: Cancelled subprocess is terminated cleanly
    Tool: Bash
    Steps: Run `node --test tests/runtime-broker/cancellation.test.mjs` with a long-running fixture command.
    Expected: Cancellation stops the process, records partial output safely, and releases any temporary worktree lock.
    Evidence: .sisyphus/evidence/task-8-runtime-error.txt
  ```

  **Commit**: YES | Message: `feat(runtime): implement local broker and worktree path` | Files: `packages/runtime-broker/**`, `tests/runtime-broker/**`

- [ ] 9. Add sandbox escalation interface and first sandbox adapter

  **What to do**: Extend the runtime broker with a sandbox adapter contract and implement the first escalated backend for risky/networked/long-running tasks. Default to a Docker CLI-driven local sandbox adapter, but keep the adapter boundary compatible with future E2B-like providers. Wire escalation decisions exclusively through the policy engine.
  **Must NOT do**: Do not make sandboxing the default path for trivial read-only/local actions. Do not add a hosted control plane in v1.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: hybrid isolation is a defining system boundary.
  - Skills: `[]` — why needed: runtime and safety work.
  - Omitted: `['using-superpowers']` — why not needed: already applied at session level.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 13,15 | Blocked By: 2,6,8

  **References**:
  - Pattern: `Leonxlnx-claude-code/src/tools/AgentTool/AgentTool.tsx` — spawned execution lifecycle inspiration.
  - External: `https://github.com/OpenHands/OpenHands` — sandbox execution model reference.
  - External: `https://github.com/e2b-dev/e2b` — sandbox-escalation and isolation reference.
  - External: `https://github.com/lastmile-ai/mcp-agent` — governed remote-execution inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/runtime-broker/sandbox-escalation.test.mjs` passes for local-default, policy-triggered escalation, and sandbox result normalization.
  - [ ] The same runtime request shape can be executed locally or in sandbox without downstream orchestrator changes.
  - [ ] Escalated actions are visibly labeled in session events and audit metadata.

  **QA Scenarios**:
  ```
  Scenario: Risky action escalates into sandbox
    Tool: Bash
    Steps: Run `node --test tests/runtime-broker/sandbox-escalation.test.mjs` using a fixture classified as networked/destructive.
    Expected: Policy returns escalation, broker launches sandbox adapter, and the final runtime event clearly records sandbox provenance.
    Evidence: .sisyphus/evidence/task-9-sandbox.txt

  Scenario: Sandbox backend failure does not silently downgrade
    Tool: Bash
    Steps: Run a fixture where the sandbox adapter cannot start and execute `node --test tests/runtime-broker/sandbox-failure.test.mjs`.
    Expected: The action fails with a clear escalation/runtime error; it is not retried unsafely on the local backend.
    Evidence: .sisyphus/evidence/task-9-sandbox-error.txt
  ```

  **Commit**: YES | Message: `feat(runtime): add sandbox escalation adapter` | Files: `packages/runtime-broker/**`, `tests/runtime-broker/**`

- [ ] 10. Implement MCP bootstrap, config merge, and capability governance

  **What to do**: Build `packages/mcp-host` to load MCP definitions from project/user/built-in sources, merge configs deterministically, manage connections, assign trust tiers, enforce capability manifests, and label every MCP-derived result with provenance and policy requirements. Include auth plumbing where MCP servers require it.
  **Must NOT do**: Do not treat all MCP servers as equally trusted. Do not expose remote MCP tools without explicit capability declarations and provenance labels.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: MCP is a major extension and trust boundary.
  - Skills: `[]` — why needed: protocol/governance architecture.
  - Omitted: `['mcp-builder']` — why not needed: this task consumes/manages MCP, not building a new external server.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 11,12,13,14 | Blocked By: 2,6

  **References**:
  - Pattern: `Leonxlnx-claude-code/src/services/mcp/client.ts` — client transport seam.
  - Pattern: `Leonxlnx-claude-code/src/services/mcp/config.ts` — config merge seam.
  - Pattern: `Leonxlnx-claude-code/src/services/mcp/auth.ts` — auth path inspiration.
  - Pattern: `Leonxlnx-claude-code/src/commands/mcp/index.ts` — `/mcp` command surface reference.
  - External: `https://github.com/lastmile-ai/mcp-agent` — MCP-native orchestration winner.
  - External: `https://github.com/Yeachan-Heo/oh-my-codex` — MCP bootstrap inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/mcp-host/*.test.mjs` passes for config merge, trust-tier assignment, capability enforcement, auth flow, and provenance labeling.
  - [ ] `npm run unclecode -- mcp list` reports server origin, capabilities, and trust tier.
  - [ ] Unauthorized MCP capabilities are blocked before tool invocation.

  **QA Scenarios**:
  ```
  Scenario: MCP config sources merge deterministically
    Tool: Bash
    Steps: Run `node --test tests/mcp-host/config-merge.test.mjs` with built-in, user, and project config fixtures.
    Expected: Merge order matches the frozen precedence rules and the resulting registry is inspectable.
    Evidence: .sisyphus/evidence/task-10-mcp.txt

  Scenario: Disallowed MCP capability is blocked
    Tool: Bash
    Steps: Run `node --test tests/mcp-host/capability-gate.test.mjs` with a fixture server requesting undeclared filesystem or network capabilities.
    Expected: The server or tool is denied before invocation and the denial is recorded with provenance.
    Evidence: .sisyphus/evidence/task-10-mcp-error.txt
  ```

  **Commit**: YES | Message: `feat(mcp): add config merge and capability governance` | Files: `packages/mcp-host/**`, `tests/mcp-host/**`

- [ ] 11. Build command router, slash-command system, and skills layer

  **What to do**: Implement the command surface for `unclecode` shell commands, slash commands, and optional keyword-triggered advanced workflows. Use Commander for shell commands, a dedicated router for slash commands, and support markdown/frontmatter skills in project-local and user-global scopes with explicit capability declarations and discoverable help surfaces. Add first-class mode switching/status for `default`, `ultrawork`, `search`, and `analyze` through both shell and slash surfaces.
  **Must NOT do**: Do not scatter command parsing across UI components. Do not allow skill-triggered hidden side effects outside the policy engine and command router.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: the command system is the primary product surface and must remain predictable.
  - Skills: `[]` — why needed: command/skills architecture.
  - Omitted: `['frontend-design']` — why not needed: textual command UX, not visual polish.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 12,13,14,15 | Blocked By: 2,3,10

  **References**:
  - Pattern: `src/cli.tsx` — current tiny slash-command shell.
  - Pattern: `Leonxlnx-claude-code/src/commands.ts` — main command registry reference.
  - Pattern: `Leonxlnx-claude-code/src/skills/loadSkillsDir.ts` — skill loading reference.
  - Pattern: `Leonxlnx-claude-code/src/tools/SkillTool/SkillTool.ts` — skill invocation bridge reference.
  - External: `https://github.com/Yeachan-Heo/oh-my-claudecode` — keyword-trigger and task-size-awareness inspiration.
  - External: `https://github.com/Yeachan-Heo/oh-my-codex` — durable state + workflow-layer command surface inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/commands/*.test.mjs` passes for slash command parsing, shell command routing, skill loading, mode switching, scope resolution, and help generation.
  - [ ] `npm run unclecode -- help` and `npm run unclecode -- /help` expose consistent command metadata.
  - [ ] `npm run unclecode -- mode status` and `/mode` expose the active mode and available modes.
  - [ ] Keyword-triggered advanced workflows are explicit in logs/help and remain disableable.

  **QA Scenarios**:
  ```
  Scenario: Slash commands and skills resolve predictably
    Tool: Bash
    Steps: Run `node --test tests/commands/*.test.mjs` with fixtures for shell commands, slash commands, and skill-backed commands.
    Expected: Resolution order is deterministic and each command exposes its source/scope metadata.
    Evidence: .sisyphus/evidence/task-11-commands.txt

  Scenario: Natural-language trigger does not silently hijack user intent
    Tool: Bash
    Steps: Run `node --test tests/commands/keyword-trigger.test.mjs` with an ambiguous prompt fixture.
    Expected: The router either stays in plain prompt mode or explicitly announces the advanced workflow activation; no silent mode switch occurs.
    Evidence: .sisyphus/evidence/task-11-commands-error.txt

  Scenario: Mode switching is explicit and persistent
    Tool: Bash
    Steps: Run `npm run unclecode -- mode set search && npm run unclecode -- mode status` and the equivalent `/mode analyze` fixture.
    Expected: The mode changes explicitly, persists in session metadata, and never switches implicitly from plain chat alone.
    Evidence: .sisyphus/evidence/task-11-commands-mode.txt
  ```

  **Commit**: YES | Message: `feat(commands): add router slash commands and skills` | Files: `apps/unclecode-cli/**`, `packages/orchestrator/**`, `tests/commands/**`

- [ ] 12. Implement the orchestrator, query engine, and background task loop

  **What to do**: Build `packages/orchestrator` as the heart of UncleCode. It must own query turns, tool batching rules, context-packet injection, provider negotiation, policy checks, command switching, active-mode behavior (`default`, `ultrawork`, `search`, `analyze`), background tasks, cancellation, and event emission for the TUI. Keep orchestration bounded, deterministic, and replayable.
  **Must NOT do**: Do not let the TUI or commands directly own long-lived state transitions. Do not permit arbitrary worker fan-out without budget and timeout controls.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this is the central engine subsystem with the most coupling.
  - Skills: `[]` — why needed: engine architecture and coordination.
  - Omitted: `['webapp-testing']` — why not needed: terminal runtime only.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: 13,14,15,16,17 | Blocked By: 2,4,5,6,7,8,10,11

  **References**:
  - Pattern: `src/agent.ts` — current minimal agent façade.
  - Pattern: `src/providers.ts` — current model/tool loop seam.
  - Pattern: `Leonxlnx-claude-code/src/query.ts` — query-loop reference.
  - Pattern: `Leonxlnx-claude-code/src/QueryEngine.ts` — engine abstraction reference.
  - Pattern: `Leonxlnx-claude-code/src/services/tools/toolOrchestration.ts` — batching/serial-execution reference.
  - External: `https://github.com/badlogic/pi-mono` — event-stream runtime winner.
  - External: `https://github.com/unclejobs-ai/mmbridge` — review/research pipeline-as-tool inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/orchestrator/*.test.mjs` passes for turn execution, cancellation, background tasks, context injection, mode-aware routing, and event ordering.
  - [ ] `npm run test:integration -- orchestrator` passes with provider, runtime, MCP, and session fixtures wired through the same engine.
  - [ ] The orchestrator emits replayable event sequences that can rebuild the same derived state after resume.

  **QA Scenarios**:
  ```
  Scenario: End-to-end turn flows through one orchestrator
    Tool: Bash
    Steps: Run `npm run test:integration -- orchestrator`.
    Expected: Prompt -> context packet -> policy check -> provider/tool loop -> runtime/MCP results -> persisted events all occur through the canonical orchestrator path.
    Evidence: .sisyphus/evidence/task-12-orchestrator.txt

  Scenario: Cancelled background task stops cleanly
    Tool: Bash
    Steps: Run `node --test tests/orchestrator/background-cancel.test.mjs` with a long-running worker fixture.
    Expected: Cancellation terminates the worker, closes the runtime handle, and records a final cancelled event without orphaned state.
    Evidence: .sisyphus/evidence/task-12-orchestrator-error.txt

  Scenario: Search and analyze bias execution differently without changing core safety
    Tool: Bash
    Steps: Run fixtures under `search` and `analyze` modes that require broader retrieval before action.
    Expected: Search mode increases retrieval/delegation bias, analyze mode enforces synthesis-first flow, and both still route through the same policy and runtime contracts.
    Evidence: .sisyphus/evidence/task-12-orchestrator-modes.txt
  ```

  **Commit**: YES | Message: `feat(orchestrator): implement query engine and task loop` | Files: `packages/orchestrator/**`, `tests/orchestrator/**`

- [ ] 13. Add bounded multi-agent orchestration and first-class research mode

  **What to do**: Extend the orchestrator with bounded worker fan-out, reduced-authority subagents, iteration budgets, research-mode stages, freshness gates, `research.md`/`ideas.md`/run-log artifacts, and explicit escalation paths from read-only research into write/exec/network actions. Research mode must be first-class but default-safe. `search` mode should maximize retrieval breadth, while `analyze` mode should maximize synthesis before deep action, and `ultrawork` should enforce strict completion/verification behavior.
  **Must NOT do**: Do not make autonomous write or network behavior the default in research mode. Do not allow unbounded parallel workers.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task combines autonomy, safety, and orchestration semantics.
  - Skills: `[]` — why needed: subsystem behavior design.
  - Omitted: `['systematic-debugging']` — why not needed: this is planned implementation work, not a live bug session.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 14,15,16 | Blocked By: 4,5,6,8,9,10,11,12

  **References**:
  - Pattern: `Leonxlnx-claude-code/src/tools/AgentTool/AgentTool.tsx` — subagent lifecycle seam.
  - Pattern: `Leonxlnx-claude-code/src/coordinator/coordinatorMode.ts` — coordinator/worker orchestration inspiration.
  - External: `https://github.com/nousresearch/hermes-agent` — iteration budgets, learning loop, and privilege separation.
  - External: `https://github.com/davebcn87/pi-autoresearch` — living session doc/run-log ideas.
  - External: `https://github.com/karpathy/autoresearch` — branch-per-session and keep/discard discipline inspiration.
  - External: `https://github.com/unclejobs-ai/mmbridge` — research/review pipeline-as-tool inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/agents/*.test.mjs` passes for worker fan-out limits, reduced-authority inheritance, cancellation, and escalation requests.
  - [ ] `node --test tests/research-mode/*.test.mjs` passes for read-only default, freshness gating, artifact generation, and explicit escalation flow.
  - [ ] `npm run unclecode -- research status` reports current stage, freshness state, and pending escalations.

  **QA Scenarios**:
  ```
  Scenario: Research mode stays read-only until escalated
    Tool: Bash
    Steps: Run `node --test tests/research-mode/read-only-default.test.mjs`.
    Expected: Research tasks can inspect files/context and generate artifacts, but write/exec/network actions require explicit escalation through the policy engine.
    Evidence: .sisyphus/evidence/task-13-research.txt

  Scenario: Worker budget prevents runaway fan-out
    Tool: Bash
    Steps: Run `node --test tests/agents/worker-budget.test.mjs` with a fixture that attempts to over-spawn parallel workers.
    Expected: The orchestrator enforces the fan-out cap, records the denial, and keeps parent state consistent.
    Evidence: .sisyphus/evidence/task-13-research-error.txt
  ```

  **Commit**: YES | Message: `feat(agents): add bounded workers and research mode` | Files: `packages/orchestrator/**`, `tests/agents/**`, `tests/research-mode/**`

- [ ] 14. Build the event-driven TUI shell and UncleCode identity surface

  **What to do**: Implement `packages/tui` as an Ink-based event-stream consumer with transcript, approvals, workers, MCP status, session state, and research views. Add UncleCode branding, ASCII/statusline treatment, help surfaces, and performance-safe rendering with input responsiveness under stream load. The HUD/statusline must always show the active mode (`default`, `ultrawork`, `search`, `analyze`) and mode-specific execution state. Keep rendering logic isolated from orchestration.
  **Must NOT do**: Do not move engine logic into React/TUI components. Do not rely on manual-only visual inspection as the main acceptance path.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: terminal UX, layout, and rendering quality are central here.
  - Skills: `['frontend-design']` — why needed: disciplined interface and visual-system thinking, even in TUI form.
  - Omitted: `['canvas-design']` — why not needed: no static poster/graphic work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 15,16,17 | Blocked By: 3,6,7,10,11,12,13

  **References**:
  - Pattern: `src/cli.tsx` — current REPL shell and ASCII welcome surface.
  - Pattern: `Leonxlnx-claude-code/src/replLauncher.tsx` — REPL mount reference.
  - Pattern: `Leonxlnx-claude-code/src/utils/theme.ts` — theme system reference.
  - Pattern: `Leonxlnx-claude-code/src/constants/figures.ts` — glyph/icon reference.
  - External: `https://github.com/Yeachan-Heo/oh-my-claudecode` — HUD/statusline inspiration.
  - External: `https://github.com/badlogic/pi-mono` — event-stream TUI behavior inspiration.
  - External: `https://github.com/ratatui-rs/ratatui` — performance/rendering inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/tui/*.test.mjs` passes for view-state reducers, event rendering, approval prompts, worker/MCP status transitions, and mode HUD rendering.
  - [ ] `npm run test:integration -- tui-streaming` passes for input responsiveness under streaming/event load.
  - [ ] `npm run unclecode` shows UncleCode-specific branding and exposes transcript, approvals, workers, MCP, and research views.

  **QA Scenarios**:
  ```
  Scenario: TUI remains responsive while events stream
    Tool: Bash
    Steps: Run `npm run test:integration -- tui-streaming` with a fixture that emits transcript, worker, and tool events at high frequency.
    Expected: Input remains usable, render state stays consistent, and event backlog is coalesced without freezing the shell.
    Evidence: .sisyphus/evidence/task-14-tui.txt

  Scenario: Approval prompt cannot be bypassed via render race
    Tool: Bash
    Steps: Run `node --test tests/tui/approval-race.test.mjs` while injecting concurrent engine events.
    Expected: The approval view persists until a deterministic decision is captured; no background event auto-dismisses it.
    Evidence: .sisyphus/evidence/task-14-tui-error.txt

  Scenario: Active mode is always visible in the HUD
    Tool: Bash
    Steps: Run a fixture that switches between `default`, `ultrawork`, `search`, and `analyze` during a session.
    Expected: The statusline updates immediately and the rendered shell never hides the active mode from the operator.
    Evidence: .sisyphus/evidence/task-14-tui-mode.txt
  ```

  **Commit**: YES | Message: `feat(tui): add event-driven shell and unclecode branding` | Files: `packages/tui/**`, `tests/tui/**`, `apps/unclecode-cli/**`

- [ ] 15. Ship setup, doctor, auth-status, sessions, and resume surfaces

  **What to do**: Add user-facing operational commands: `unclecode setup`, `unclecode doctor`, `unclecode auth status`, `unclecode mode set`, `unclecode mode status`, `unclecode sessions`, `unclecode resume`, and `unclecode research status`. These surfaces must explain environment readiness, missing auth, MCP issues, runtime capability availability, resumable sessions, and active operating mode.
  **Must NOT do**: Do not make users inspect raw config/session files for normal troubleshooting. Do not hide capability failures behind vague generic errors.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: these commands are essential for public OSS product usability.
  - Skills: `[]` — why needed: operational UX and command integration.
  - Omitted: `['manual-review']` — why not needed: not a review task.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 16,17 | Blocked By: 4,7,8,9,11,12,14

  **References**:
  - Pattern: `README.md` — current install/verification/troubleshooting surface to replace.
  - Pattern: `tests/packageBin.test.mjs` — CLI launcher regression reference.
  - Pattern: `Leonxlnx-claude-code/src/commands/config/index.ts` — config-command reference.
  - External: `https://github.com/Yeachan-Heo/oh-my-codex` — setup/doctor flow inspiration.
  - External: `https://github.com/unclejobs-ai/second-claude-code` — operational hooks/status inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/cli/*.test.mjs` passes for setup, doctor, auth status, mode status/set, sessions listing, and resume flows.
  - [ ] `npm run unclecode -- doctor` reports pass/fail per subsystem with actionable remediation text.
  - [ ] `npm run unclecode -- sessions` lists resumable sessions with provenance and status metadata.

  **QA Scenarios**:
  ```
  Scenario: Doctor reports healthy environment clearly
    Tool: Bash
    Steps: Run `npm run unclecode -- doctor` in a fully configured fixture environment.
    Expected: Output includes package health, auth state, runtime availability, MCP health, and session-store status as explicit pass results.
    Evidence: .sisyphus/evidence/task-15-doctor.txt

  Scenario: Missing auth or runtime dependency yields actionable failure
    Tool: Bash
    Steps: Remove the required auth fixture or sandbox dependency and run `node --test tests/cli/doctor-failure.test.mjs`.
    Expected: Doctor/setup returns a precise missing-dependency or missing-auth explanation instead of a generic startup crash.
    Evidence: .sisyphus/evidence/task-15-doctor-error.txt

  Scenario: Mode status exposes the current operating profile
    Tool: Bash
    Steps: Run `npm run unclecode -- mode set ultrawork && npm run unclecode -- mode status`.
    Expected: Output shows `ultrawork` as active, identifies whether it came from flag/config/session, and confirms persistence scope.
    Evidence: .sisyphus/evidence/task-15-mode-status.txt
  ```

  **Commit**: YES | Message: `feat(cli): add setup doctor and session surfaces` | Files: `apps/unclecode-cli/**`, `tests/cli/**`, `README.md`

- [ ] 16. Harden performance, observability, and backpressure behavior

  **What to do**: Add performance counters, event coalescing, stream backpressure controls, resume-latency instrumentation, repo-map caching, and profiling hooks. Set explicit thresholds for cold start, first streamed token/event, resume latency, and high-volume event rendering.
  **Must NOT do**: Do not ship “high performance” as an unmeasured claim. Do not optimize by bypassing canonical event or policy paths.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task spans engine, session, and TUI runtime characteristics.
  - Skills: `[]` — why needed: systemic performance hardening.
  - Omitted: `['frontend-design']` — why not needed: this is performance/observability, not visual design.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: 17 | Blocked By: 4,12,13,14,15

  **References**:
  - Pattern: `tests/openaiRuntimeOptions.test.mjs` — existing options/perf-adjacent regression style.
  - External: `https://github.com/badlogic/pi-mono` — stream/event performance inspiration.
  - External: `https://github.com/ratatui-rs/ratatui` — rendering/backpressure inspiration.
  - External: `https://github.com/Aider-AI/aider` — repo-map efficiency inspiration.

  **Acceptance Criteria**:
  - [ ] `npm run test:integration -- performance` passes the agreed cold-start, first-event, and resume-latency thresholds.
  - [ ] `node --test tests/performance/*.test.mjs` passes for backpressure, repo-map caching, and event coalescing behavior.
  - [ ] `npm run unclecode -- doctor --verbose` can print subsystem latency counters for support/debugging.

  **QA Scenarios**:
  ```
  Scenario: Performance thresholds are measurable and pass
    Tool: Bash
    Steps: Run `npm run test:integration -- performance` on a controlled fixture repository.
    Expected: Cold start, first event, and resume latency all meet the declared thresholds and are emitted in machine-readable output.
    Evidence: .sisyphus/evidence/task-16-performance.txt

  Scenario: Event flood does not freeze the shell
    Tool: Bash
    Steps: Run `node --test tests/performance/backpressure.test.mjs` with a high-volume synthetic event stream.
    Expected: Backpressure coalesces low-priority events, preserves approvals/input responsiveness, and avoids unbounded memory growth.
    Evidence: .sisyphus/evidence/task-16-performance-error.txt
  ```

  **Commit**: YES | Message: `feat(perf): add observability and backpressure controls` | Files: `packages/orchestrator/**`, `packages/tui/**`, `tests/performance/**`

- [ ] 17. Cut over from Claw Dev to UncleCode and finalize provenance

  **What to do**: Replace the top-level product identity, launcher scripts, docs, and release surface so the repo boots into UncleCode instead of Claw Dev. Remove vendored-core runtime dependence, retain public-reference provenance notes, and document which modules were rewritten, clean-room adapted, licensed reused, or used only as inspiration.
  **Must NOT do**: Do not leave `claw-dev` as the real primary command. Do not carry forward brittle branding patches or ambiguous provenance around Claude-derived areas.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this task combines release-surface cleanup, docs, and provenance clarity.
  - Skills: `[]` — why needed: documentation and cutover planning.
  - Omitted: `['frontend-design']` — why not needed: this is productization/documentation, not UI rendering.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: F1-F4 | Blocked By: 4,7,12,14,15,16

  **References**:
  - Pattern: `README.md` — current product/install surface to replace.
  - Pattern: `bin/claw-dev.cjs` — launcher entrypoint to retire or alias temporarily.
  - Pattern: `tests/packageBin.test.mjs` — bin-surface regression coverage.
  - Pattern: `Leonxlnx-claude-code/patch-branding.js` — brittle branding approach to eliminate.
  - External: `https://github.com/Yeachan-Heo/oh-my-codex` — durable workspace-state/productization inspiration.

  **Acceptance Criteria**:
  - [ ] `node --test tests/release-surface/*.test.mjs` passes for bin name, version output, install docs, and provenance manifest checks.
  - [ ] `npm run unclecode -- --version` and `npm run unclecode -- help` report UncleCode branding only.
  - [ ] A provenance manifest exists and maps every major subsystem to rewritten / clean-room adapted / licensed reuse / inspiration only.

  **QA Scenarios**:
  ```
  Scenario: UncleCode is the visible product surface
    Tool: Bash
    Steps: Run `npm run unclecode -- --version && npm run unclecode -- help && node --test tests/release-surface/bin.test.mjs`.
    Expected: CLI output, docs, and bin tests all reference UncleCode as the primary surface; no runtime dependency on `claw-dev` remains.
    Evidence: .sisyphus/evidence/task-17-cutover.txt

  Scenario: Provenance gaps are rejected
    Tool: Bash
    Steps: Run `node --test tests/release-surface/provenance.test.mjs` with a fixture that omits provenance labeling for one subsystem.
    Expected: The test fails and blocks release until the missing provenance entry is added.
    Evidence: .sisyphus/evidence/task-17-cutover-error.txt
  ```

  **Commit**: YES | Message: `chore(release): cut over product surface to unclecode` | Files: `README.md`, `bin/**`, `apps/unclecode-cli/**`, `tests/release-surface/**`, `docs/provenance/**`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [ ] F1. Plan Compliance Audit — oracle
  **What to do**: Dispatch `oracle` against the completed work and this exact plan file. The review must check that every shipped subsystem, command, and artifact maps back to a planned task and that no required task was skipped.
  **Pass condition**: Oracle returns explicit approval with no missing planned deliverables and no untracked scope expansion.
  **Evidence**: `.sisyphus/evidence/f1-plan-compliance.md`

  ```
  Scenario: Plan compliance audit
    Tool: task(subagent_type="oracle")
    Steps: Review completed diffs, produced evidence artifacts, and `.sisyphus/plans/unclecode-platform-rebuild.md`; verify task-by-task coverage and missing-work detection.
    Expected: Oracle returns APPROVE and writes a compliance summary naming any deviations or confirming none.
    Evidence: .sisyphus/evidence/f1-plan-compliance.md
  ```

- [ ] F2. Code Quality Review — unspecified-high
  **What to do**: Dispatch a high-effort code review agent over the final diff, with emphasis on architecture boundaries, type safety, policy bypasses, persistence mistakes, and test quality.
  **Pass condition**: Reviewer returns approval with no unresolved critical or warning-level findings.
  **Evidence**: `.sisyphus/evidence/f2-code-quality.md`

  ```
  Scenario: Code quality audit
    Tool: task(category="unspecified-high")
    Steps: Review final changed files plus contract/integration tests; inspect for policy bypasses, hidden state mutation, weak typing, dead code, and missing failure-path coverage.
    Expected: Reviewer returns APPROVE with no critical or warning-level defects left open.
    Evidence: .sisyphus/evidence/f2-code-quality.md
  ```

- [ ] F3. Real Manual QA — unspecified-high (+ playwright if UI)
  **What to do**: Run an agent-driven end-to-end walkthrough that simulates manual product use from install/setup through auth, doctor, session resume, command routing, MCP interaction, and research mode. Use Playwright only if any browser-assisted auth or UI path exists.
  **Pass condition**: The agent walkthrough completes the defined user journeys and edge journeys without human intervention, recording concrete outputs/screens if applicable.
  **Evidence**: `.sisyphus/evidence/f3-agent-walkthrough.md`, optional `.sisyphus/evidence/f3-agent-walkthrough.png`

  ```
  Scenario: Agent-driven product walkthrough
    Tool: task(category="unspecified-high") + Playwright/Bash when required
    Steps: Execute install/setup, `unclecode auth status`, `unclecode doctor`, `unclecode sessions`, `unclecode resume`, one slash-command flow, one MCP flow, and one research-mode flow using the built product.
    Expected: All user journeys succeed, any browser-assisted OAuth steps are captured, and failures are reported as actionable defects rather than vague breakage.
    Evidence: .sisyphus/evidence/f3-agent-walkthrough.md
  ```

- [ ] F4. Scope Fidelity Check — deep
  **What to do**: Dispatch `deep` to verify that the final implementation still matches the approved v1 scope freeze: local-first OSS CLI, GPT-branded UX, hybrid isolation, MCP client-first, bounded research mode, and no marketplace/hosted control-plane creep.
  **Pass condition**: Reviewer returns approval that the shipped system matches v1 scope and all deferred items remain deferred.
  **Evidence**: `.sisyphus/evidence/f4-scope-fidelity.md`

  ```
  Scenario: Scope fidelity review
    Tool: task(category="deep")
    Steps: Compare the final deliverable set to the plan’s Must Have / Must NOT Have / deferred-v1 boundaries.
    Expected: Reviewer returns APPROVE and confirms no hidden SaaS, marketplace, wrapper-first, or uncontrolled multi-provider scope creep entered the build.
    Evidence: .sisyphus/evidence/f4-scope-fidelity.md
  ```

## Commit Strategy
- Use small, subsystem-bounded commits.
- Prefer one contract or one runtime boundary per commit.
- Never mix policy/auth/runtime/TUI changes into the same commit unless the task explicitly couples them.
- Preserve a provenance note in commit body or companion docs for any reused/adapted pattern from public references.

## Success Criteria
- UncleCode is no longer operationally dependent on wrapper patching against vendored Claude internals.
- The runtime path for local and sandbox execution is unified under one broker contract.
- Session replay, checkpoint recovery, and project memory are deterministic and test-covered.
- Provider auth, MCP access, and agent execution all flow through the same policy authority.
- The TUI remains responsive under streaming and multi-agent event load.
- Research mode is powerful but safe by default.
