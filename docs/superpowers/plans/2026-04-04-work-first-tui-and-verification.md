# Work-First TUI and Verification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `unclecode` open directly into a responsive work composer, expose model-aware reasoning controls, and close the remaining verification gaps.

**Architecture:** Keep the session-center TUI as an operational surface behind `unclecode tui`, while making the default command launch the work shell immediately. Add model reasoning metadata in the provider/config layer, thread active mode + reasoning into the work shell header and commands, and preserve supporting operational surfaces (`setup`, `doctor`, `sessions`, provenance, release checks`) as secondary flows.

**Tech Stack:** TypeScript, Ink, Commander, Node test runner, Biome, existing UncleCode workspace packages

---

## File Map

- Modify: `apps/unclecode-cli/src/program.ts` — switch default no-arg startup to work-first while preserving `tui` and operational commands.
- Modify: `src/config.ts` — derive default model/reasoning from provider + active mode and accept reasoning overrides.
- Modify: `src/providers.ts` — send reasoning settings to OpenAI requests and expose runtime capability metadata.
- Modify: `src/agent.ts` — allow runtime reasoning updates.
- Modify: `src/cli.tsx` — redesign the work shell around immediate composer focus, persistent status bar, lightweight side panels, and `/reasoning` workflow.
- Modify: `packages/contracts/src/modes.ts` and `packages/providers/src/{types.ts,model-registry.ts,index.ts}` — define mode reasoning defaults and model reasoning capability metadata.
- Add/Modify tests: `tests/work/*.mjs`, `tests/providers/*.mjs`, `tests/integration/*.test.mjs`, `tests/contracts/*.test.mjs` — lock default startup, reasoning capability, and work-first UX behavior.
- Add/Modify evidence/docs: `.sisyphus/evidence/*`, `docs/provenance/*` — record verification outcomes.

## Task 1: Lock the work-first and reasoning behavior in tests
- [ ] Add failing tests for default CLI startup selection, model-aware reasoning capability metadata, mode default reasoning, and work-shell `/reasoning` behavior.
- [ ] Run the targeted tests to confirm they fail for the expected reason.
- [ ] Implement only the minimum production changes required to satisfy the new failing tests.
- [ ] Re-run the targeted test set and keep it green.

## Task 2: Switch default `unclecode` startup to immediate work mode
- [ ] Update CLI startup logic so no-arg interactive runs launch the repo-local work entrypoint, not the session-center dashboard.
- [ ] Keep `unclecode tui` as the secondary operational/session center surface.
- [ ] Verify the help text, slash routing, and bin entrypoint still behave correctly.

## Task 3: Add model-aware reasoning controls
- [ ] Extend provider model registry data with reasoning support state and supported levels.
- [ ] Add mode default reasoning presets: `default=medium`, `ultrawork=high`, `search=low`, `analyze=high`.
- [ ] Thread reasoning through config loading and OpenAI requests.
- [ ] Add runtime `/reasoning` commands so sessions can inspect or override reasoning without hiding unsupported models.

## Task 4: Redesign the work shell around responsiveness
- [ ] Keep the composer focused by default with minimal header/status information.
- [ ] Render model, reasoning, mode, and auth status persistently.
- [ ] Add lightweight secondary panels/commands for sessions and diagnostics without making them the startup screen.
- [ ] Ensure the shell still supports `/help`, `/tools`, `/clear`, `/exit`, and the new `/reasoning` flow.

## Task 5: Close remaining verification gaps
- [ ] Update evidence/release checks for the new work-first default.
- [ ] Re-run lint, typecheck, build, contracts, providers, work tests, integration, and release-surface checks.
- [ ] Record the remaining plan gaps (F1-F4/performance evidence) with explicit status so the final verification wave is grounded.
