# Agent Skill and MCP Minimalism Roadmap

> Date: 2026-06-01
> Status: phase 1 cleanup completed; phase 3 first mmbridge health slice completed
> Scope: repo-local agent skills, Claude/Codex local state, plugin surfaces, and MCP/mmbridge integration

## Decision

Keep mmbridge, but reduce everything around agent skills and extension surfaces to the minimum useful set.

The current problem is not that UncleCode has MCP. The problem is that several agent ecosystems are mixed into the repo-local context:

- repo-local `.codex/skills` exposes legacy automation skills as project skills
- `.claude` contains ignored Claude Code memory/handoff state
- `Leonxlnx-claude-code` is a large tracked reference/bundled client tree
- `packages/plugin-host` exists as an executable plugin host, while the active work-shell path mainly uses JSON extension manifests
- `.mcp.json` contains only `mmbridge`, which is useful and should stay, but needs better operator UX and verification

The cleanup should happen in three phases. Do not collapse all of this into one large deletion pass.

## Evidence Snapshot

Observed before cleanup on 2026-06-01:

- `.codex` is ignored local state but contains repo-local skills and runtime logs.
- `target/debug/unclecode rust context skills list "$PWD" "$HOME"` reports 102 skills total: 28 project scoped, 74 user scoped.
- The project scoped skills include legacy automation skills such as `autopilot`, `team`, `ultrawork`, `ralph`, `ask-claude`, `ask-gemini`, `doctor`, and `configure-notifications`.
- `rust/unclecode-core/src/context_skills.rs` scans `cwd/.codex/skills`, `home/.codex/skills`, and `home/.agents/skills`.
- `packages/context-broker/src/workspace-guidance.ts` injects project-scoped skills into workspace guidance.
- `.mcp.json` configures one project MCP server: `mmbridge`.
- `target/debug/unclecode mcp list` reports `mmbridge | stdio | project | project config`.
- `packages/orchestrator/src/extension-registry.ts` reads extension manifest JSON through Rust, not through `packages/plugin-host`.
- `rust/unclecode-core/src/command_router.rs` reads `.unclecode/extensions/*.json` from project and user locations.
- `target/debug/unclecode rust command extension-manifests "$PWD" "$HOME"` currently returns no overlays or summaries.
- `Leonxlnx-claude-code` is tracked, large, and excluded from TypeScript checking.

Post-cleanup verification on 2026-06-01:

- repo-local `.codex/skills` has been removed.
- repo-local `.codex/prompts`, `.codex/agents`, `.codex/rules`, history, logs, and sessions have been removed.
- repo-local `.claude/agent-memory` and `.claude/handoffs` have been removed.
- related ignored `.data` planning state has been removed.
- full workspace search for legacy automation tokens returns no text matches, excluding vendored binary/demo render artifacts.
- `target/debug/unclecode rust context skills list "$PWD" "$HOME"` reports zero project-scoped skills.

## Phase 1: Local Skill and State Minimalism

Goal: stop repo-local agent state from contaminating UncleCode's runtime context.

Status: completed for the current workspace state. Follow-up code hardening is still useful so the same files cannot silently reappear as project context later.

Tasks:

- Remove or archive repo-local `.codex/skills` entries that are not UncleCode project requirements. Completed locally.
- Keep system skills out of project guidance unless explicitly requested.
- Add a project-skill allowlist or ignore policy so `cwd/.codex/skills` does not automatically become trusted UncleCode context.
- Keep `/skills` useful, but separate `project` skills from `user` and `tooling` skills in the UI/reporting.
- Clean ignored local state: `.codex/.tmp`, `.codex/log*`, `.codex/tmp`, `.claude/agent-memory`, `.claude/handoffs`, and stale `.unclecode/work-queues`. Completed for legacy automation state found in this pass.
- Document that `.claude` and `.codex` are local operator state, not source-of-truth project configuration.

Suggested implementation shape:

- Change skill discovery to support a narrow project-skill policy.
- Default policy should ignore repo-local `.codex/skills` unless an explicit marker/config enables them.
- Continue reading user skills for `/skills`, but do not inject user skills into workspace guidance.
- Add a focused test around workspace guidance proving ignored local skills are not injected.

Acceptance criteria:

- Workspace guidance no longer injects legacy automation skills from repo-local `.codex/skills`.
- `/skills` still lists available user skills clearly.
- `npm run test:context-broker` and relevant Rust context skill tests pass.
- No mmbridge behavior changes in this phase.

## Phase 2: Large Surface Reduction

Goal: remove or isolate large compatibility/reference surfaces that are not part of the active UncleCode product path.

This phase should happen after Phase 1 proves the runtime context is clean.

Tasks:

- Audit `Leonxlnx-claude-code` one final time for live imports or launcher dependencies.
- If it is reference-only, move it out of the main repo path, archive it, or convert it into an explicit external reference/submodule.
- Update README/docs that describe `Leonxlnx-claude-code` as a primary layout item if that is no longer true.
- Decide whether `packages/plugin-host` is still a product requirement.
- If executable plugins are not part of the near-term product, remove `packages/plugin-host`, `test:plugin-host`, and related workspace/lockfile entries.
- Keep JSON extension manifests only if they are still useful for low-risk config overlays and slash commands.
- Rename "plugin" wording in extension manifest docs/tests if executable plugin support is removed, so the distinction is explicit.

Acceptance criteria:

- The repository no longer carries large tracked reference code unless it has a documented active purpose.
- Build/test config does not include dead packages.
- Extension manifests are either retained as a small declarative feature or removed completely.
- Any removal has a clear migration note.

## Phase 3: Keep and Improve mmbridge

Goal: keep mmbridge as the one serious MCP integration, but make it operationally cleaner, safer, and easier to verify.

This phase should not remove `.mcp.json` unless the replacement keeps mmbridge equally easy to use.

First implementation slice:

- Added a lightweight `/mmbridge health` action that performs MCP initialize plus `tools/list` without running review/gate work.
- Split default timeouts so context/handoff/doctor use shorter defaults while review/gate keep the long-running default.
- Improved `scripts/run-mmbridge-mcp.mjs` diagnostics for missing env override paths and failed PATH fallback.
- Rebuilt the sibling `../mmbridge` MCP package after clearing stale build metadata so UncleCode can reach `../mmbridge/packages/mcp/dist/index.js`.
- Verified real project health: `Reachable: yes`, required mmbridge tools all present.

Tasks:

- Keep the project-local `mmbridge` MCP entry.
- Improve `scripts/run-mmbridge-mcp.mjs` diagnostics so failures show which resolution path failed: env override, sibling repo build, or PATH fallback. Implemented.
- Add a fast `unclecode mmbridge doctor` path that verifies config, launcher resolution, protocol handshake, and tool listing.
- Make `/mcp list` distinguish "configured" from "reachable" when possible.
- Add a lightweight MCP health command that does not run expensive review/gate work. Implemented as `/mmbridge health`.
- Keep `/mmbridge context`, `/mmbridge review`, `/mmbridge gate`, `/mmbridge handoff`, and `/mmbridge doctor`, but make errors concise and actionable.
- Add a cross-repo smoke test path that can be skipped when the sibling `../mmbridge` build is unavailable.
- Consider a timeout profile per tool instead of one shared 10-minute default. Implemented first split.
- Make projectDir handling explicit in every mmbridge call from UncleCode.

Acceptance criteria:

- `unclecode mcp list` still shows the project `mmbridge` server.
- `unclecode mmbridge doctor` or equivalent proves the server is reachable without running a full review.
- MCP failure messages tell the operator exactly what to fix.
- Existing mmbridge slash commands continue to route and execute.
- Integration tests cover config listing, fake stdio server execution, and error surfacing.

## Non-Goals

- Do not remove mmbridge.
- Do not add more MCP servers as part of this cleanup.
- Do not replace mmbridge with ad-hoc shell subprocess glue.
- Do not keep broad executable plugin support only because it exists.
- Do not preserve repo-local skills just because they are convenient for a different agent stack.

## Working Rule Going Forward

UncleCode should have one small, explicit extension story:

- project guidance: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `UNCLECODE.md`
- project skills: opt-in and narrow
- MCP: mmbridge first, additional servers only by explicit need
- extension manifests: declarative only, unless executable plugins become a real product goal
- local agent state: ignored, disposable, and not automatically injected into runtime context
