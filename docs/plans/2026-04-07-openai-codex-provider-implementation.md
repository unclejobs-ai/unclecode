# OpenAI Codex + OpenAI API Split Implementation Plan

> **Status (2026-07):** ABANDONED — the explicit provider-id split (`openai-codex`/`openai-api`) was never implemented. The runtime instead branches *internally* on the single `openai` provider id (`packages/providers/src/runtime.ts`, `apiReady`/`codex` fields in `openai-status.ts`). PR #1 ("Prefer reusable Codex OAuth") was closed 2026-07 for the same reason. Kept as a decision record of the design space explored.

> **For agentic workers:** Implement this plan with the repo's standard execution workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class `OpenAI Codex` and `OpenAI API` provider paths, with Codex OAuth preferred when available and explicit UI/auth/runtime separation between the two.

**Architecture:** Treat `openai-codex` and `openai-api` as separate runtime contracts. Keep a temporary alias for legacy `openai` at parsing boundaries only, add a provider-specific Codex auth store and runtime path, and update setup/auth/TUI surfaces to show explicit provider labels and smart auto-selection.

**Tech Stack:** TypeScript, Ink, Commander, Node test runner, workspace packages (`contracts`, `providers`, `orchestrator`, `tui`, `config-core`), local compat proxy

---

## Chunk 1: Provider taxonomy + smart selection contracts

### Task 1: Add failing contract tests for split OpenAI providers
**Files:**
- Modify: `tests/contracts/tui-work-shell.contract.test.mjs`
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`
- Modify: `tests/work/work-runtime.test.mjs`
- Modify: `tests/work/openai-provider.test.mjs`
- Modify: `packages/contracts/src/providers.ts`
- Modify: `packages/providers/src/types.ts`

- [ ] **Step 1: Write failing tests that expect explicit provider ids `openai-api` and `openai-codex`.**
- [ ] **Step 2: Write failing tests that lock legacy `openai` as a parse-time alias only, not the canonical runtime label.**
- [ ] **Step 3: Run targeted tests to verify failure is due to missing provider split behavior.**
  Run: `node --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs tests/contracts/unclecode-cli.contract.test.mjs tests/work/work-runtime.test.mjs tests/work/openai-provider.test.mjs`
- [ ] **Step 4: Update provider/type contracts with the minimal new ids and transitional alias handling.**
- [ ] **Step 5: Re-run the targeted tests and keep them green.**

### Task 2: Add a single smart OpenAI provider resolver
**Files:**
- Add: `packages/providers/src/openai-provider-selection.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `packages/providers/src/types.ts`
- Modify: `tests/providers/openai-auth.test.mjs`
- Modify: `tests/providers/openai-status.test.mjs`

- [ ] **Step 1: Write failing tests that prefer Codex OAuth over API key when both exist.**
- [ ] **Step 2: Write failing tests that choose OpenAI API when Codex OAuth is absent but API key exists.**
- [ ] **Step 3: Run the targeted provider tests and verify the failure is due to the missing resolver.**
  Run: `node --conditions=source --import tsx --test tests/providers/openai-auth.test.mjs tests/providers/openai-status.test.mjs`
- [ ] **Step 4: Implement a focused resolver that returns `{ providerId, authLabel, authIssueLines }` for OpenAI startup decisions.**
- [ ] **Step 5: Re-run the targeted provider tests and keep them green.**

---

## Chunk 2: OpenAI Codex auth lane

### Task 3: Add a provider-specific Codex credential store and status path
**Files:**
- Add: `packages/providers/src/openai-codex-credential-store.ts`
- Add: `packages/providers/src/openai-codex-status.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `tests/providers/openai-credential-store.test.mjs`
- Add: `tests/providers/openai-codex-status.test.mjs`

- [ ] **Step 1: Write failing tests for reading/writing a Codex-specific credential file.**
- [ ] **Step 2: Write failing tests for Codex status output that does not require `model.request`.**
- [ ] **Step 3: Run the targeted provider tests and confirm failure is due to missing Codex-specific storage/status.**
  Run: `node --conditions=source --import tsx --test tests/providers/openai-credential-store.test.mjs tests/providers/openai-codex-status.test.mjs`
- [ ] **Step 4: Implement the smallest dedicated Codex store/status helpers.**
- [ ] **Step 5: Re-run the targeted tests and keep them green.**

### Task 4: Add failing tests for Codex OAuth resolution and refresh semantics
**Files:**
- Modify: `tests/providers/openai-oauth.test.mjs`
- Add: `tests/providers/openai-codex-auth.test.mjs`
- Modify: `packages/providers/src/openai-oauth.ts`

- [ ] **Step 1: Write failing tests that Codex OAuth accepts usable Codex tokens without `model.request`.**
- [ ] **Step 2: Write failing tests that Codex OAuth stores to the Codex-specific auth path.**
- [ ] **Step 3: Write failing tests for expired/revoked Codex token messaging distinct from OpenAI API scope errors.**
- [ ] **Step 4: Run the targeted tests and confirm failure is due to shared OpenAI assumptions.**
  Run: `node --conditions=source --import tsx --test tests/providers/openai-oauth.test.mjs tests/providers/openai-codex-auth.test.mjs`
- [ ] **Step 5: Split Codex flow helpers from public-API OpenAI helpers with the minimum interface changes required.**
- [ ] **Step 6: Re-run the targeted tests and keep them green.**

### Task 5: Add a Codex auth login command path in CLI/operational surfaces
**Files:**
- Modify: `apps/unclecode-cli/src/program.ts`
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: `tests/commands/tui-action-runner.test.mjs`
- Modify: `tests/integration/unclecode-auth-login.integration.test.mjs`
- Modify: `tests/integration/unclecode-auth-status.integration.test.mjs`

- [ ] **Step 1: Write failing tests that `/auth login` prefers Codex OAuth when available.**
- [ ] **Step 2: Write failing tests that auth status/setup guidance says `OpenAI Codex` vs `OpenAI API`.**
- [ ] **Step 3: Run the targeted command/integration tests to verify failure is due to missing split auth routing.**
  Run: `node --conditions=source --import tsx --test tests/commands/tui-action-runner.test.mjs tests/integration/unclecode-auth-login.integration.test.mjs tests/integration/unclecode-auth-status.integration.test.mjs`
- [ ] **Step 4: Implement the smallest CLI/operational routing changes needed to surface Codex auth separately.**
- [ ] **Step 5: Re-run the targeted tests and keep them green.**

---

## Chunk 3: Runtime/provider split

### Task 6: Add failing runtime tests for `openai-codex` transport
**Files:**
- Modify: `tests/work/openai-provider.test.mjs`
- Add: `tests/providers/openai-codex-runtime.test.mjs`
- Modify: `packages/providers/src/runtime.ts`
- Modify: `packages/providers/src/model-registry.ts`

- [ ] **Step 1: Write failing tests that `openai-codex` uses the Codex backend URL instead of `api.openai.com/v1`.**
- [ ] **Step 2: Write failing tests that model registry and reasoning support work for the new provider id.**
- [ ] **Step 3: Run the targeted runtime/provider tests and confirm failure is due to missing runtime split.**
  Run: `node --conditions=source --import tsx --test tests/work/openai-provider.test.mjs tests/providers/openai-codex-runtime.test.mjs`
- [ ] **Step 4: Implement the smallest runtime/provider split needed to support `openai-codex` alongside `openai-api`.**
- [ ] **Step 5: Re-run the targeted tests and keep them green.**

### Task 7: Thread split provider ids through work-runtime parsing and startup
**Files:**
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Modify: `packages/providers/src/runtime.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `tests/work/work-runtime.test.mjs`
- Modify: `tests/work/repl.test.mjs`

- [ ] **Step 1: Write failing tests that provider parsing accepts `openai-api` and `openai-codex`.**
- [ ] **Step 2: Write failing tests that startup auto-select prefers Codex OAuth, then API key.**
- [ ] **Step 3: Run the targeted work-shell tests and confirm failure is due to missing startup/provider selection support.**
  Run: `node --conditions=source --import tsx --test tests/work/work-runtime.test.mjs tests/work/repl.test.mjs`
- [ ] **Step 4: Implement the minimal parsing and startup wiring changes.**
- [ ] **Step 5: Re-run the targeted tests and keep them green.**

---

## Chunk 4: UI labels, setup, doctor, and auth guidance

### Task 8: Make TUI labels and auth panels explicit
**Files:**
- Modify: `packages/tui/src/work-shell-view.tsx`
- Modify: `packages/tui/src/work-shell-panels.ts`
- Modify: `packages/tui/src/work-shell-formatters.ts`
- Modify: `tests/contracts/tui-work-shell.contract.test.mjs`
- Modify: `tests/work/repl.test.mjs`

- [ ] **Step 1: Write failing tests that headers/panels say `OpenAI Codex` and `OpenAI API`, not generic `OpenAI` in auth-sensitive contexts.**
- [ ] **Step 2: Write failing tests for Codex-specific 401/403 guidance that does not mention `model.request`.**
- [ ] **Step 3: Run the targeted TUI/work tests and verify failure is due to missing label split.**
  Run: `node --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs tests/work/repl.test.mjs`
- [ ] **Step 4: Implement the smallest label/formatter/panel changes needed.**
- [ ] **Step 5: Re-run the targeted tests and keep them green.**

### Task 9: Update setup/doctor/help text to describe both OpenAI paths
**Files:**
- Modify: `apps/unclecode-cli/src/fast-setup.ts`
- Modify: `apps/unclecode-cli/src/fast-doctor.ts`
- Modify: `apps/unclecode-cli/src/operational.ts`
- Modify: `README.md`
- Modify: `tests/contracts/tui-dashboard.contract.test.mjs`
- Modify: `tests/contracts/tui-shell.contract.test.mjs`

- [ ] **Step 1: Write failing tests that setup/help text explains `OpenAI Codex` OAuth and `OpenAI API` key paths distinctly.**
- [ ] **Step 2: Run the targeted dashboard/help tests and verify failure is due to outdated OpenAI wording.**
  Run: `node --conditions=source --import tsx --test tests/contracts/tui-dashboard.contract.test.mjs tests/contracts/tui-shell.contract.test.mjs`
- [ ] **Step 3: Update operational/setup/README text with the minimum wording changes.**
- [ ] **Step 4: Re-run the targeted tests and keep them green.**

---

## Chunk 5: Compatibility, migration, and full verification

### Task 10: Preserve legacy `openai` aliases while steering new users to explicit names
**Files:**
- Modify: `apps/unclecode-cli/src/program.ts`
- Modify: `apps/unclecode-cli/src/work-runtime.ts`
- Modify: `packages/providers/src/runtime.ts`
- Modify: `tests/integration/unclecode-auth-login.integration.test.mjs`
- Modify: `tests/contracts/unclecode-cli.contract.test.mjs`

- [ ] **Step 1: Write failing tests that existing `--provider openai` still works but resolves to `openai-api`.**
- [ ] **Step 2: Write failing tests that docs/UX prefer explicit provider names even while the alias remains accepted.**
- [ ] **Step 3: Run the targeted tests and verify failure is due to missing compatibility normalization.**
  Run: `node --conditions=source --import tsx --test tests/integration/unclecode-auth-login.integration.test.mjs tests/contracts/unclecode-cli.contract.test.mjs`
- [ ] **Step 4: Add the smallest compatibility shim required.**
- [ ] **Step 5: Re-run the targeted tests and keep them green.**

### Task 11: End-to-end verification sweep
**Files:**
- No new production files unless failures require tiny follow-up fixes

- [ ] **Step 1: Run provider/auth suites.**
  Run: `npm run test:providers --silent`
- [ ] **Step 2: Run orchestrator/work/TUI suites that cover auth/provider surfaces.**
  Run: `node --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs tests/work/*.test.mjs tests/contracts/*.test.mjs`
- [ ] **Step 3: Run command/integration suites that cover auth/setup/help flows.**
  Run: `node --conditions=source --import tsx --test tests/commands/*.test.mjs && npm run build --silent && node --test tests/integration/unclecode-auth-*.test.mjs`
- [ ] **Step 4: Run typecheck.**
  Run: `npm run check --silent`
- [ ] **Step 5: Record any remaining migration risks in the final handoff notes.**

---

## Expected changed-file map

### Contracts / provider metadata
- `packages/contracts/src/providers.ts`
- `packages/providers/src/types.ts`
- `packages/providers/src/model-registry.ts`

### OpenAI auth / status / storage
- `packages/providers/src/openai-auth.ts`
- `packages/providers/src/openai-oauth.ts`
- `packages/providers/src/openai-status.ts`
- `packages/providers/src/openai-credential-store.ts`
- `packages/providers/src/openai-codex-credential-store.ts` (new)
- `packages/providers/src/openai-codex-status.ts` (new)
- `packages/providers/src/openai-provider-selection.ts` (new)

### Runtime
- `packages/providers/src/runtime.ts`
- `scripts/anthropic-compat-proxy.ts`

### CLI / TUI / operational
- `apps/unclecode-cli/src/program.ts`
- `apps/unclecode-cli/src/operational.ts`
- `apps/unclecode-cli/src/work-runtime.ts`
- `apps/unclecode-cli/src/fast-setup.ts`
- `apps/unclecode-cli/src/fast-doctor.ts`
- `packages/tui/src/work-shell-view.tsx`
- `packages/tui/src/work-shell-panels.ts`
- `packages/tui/src/work-shell-formatters.ts`

### Documentation
- `README.md`
- `docs/specs/2026-04-07-openai-codex-provider-design.md`

## Handoff notes for executor
- Do **not** collapse `openai-codex` and `openai-api` back into one runtime identity.
- Keep `model.request` checks attached to OpenAI API semantics only.
- Prefer reuse of existing response-shaping helpers from `scripts/anthropic-compat-proxy.ts` rather than inventing a second Codex protocol adapter from scratch.
- Keep diffs narrow and delete ambiguity rather than adding parallel naming layers.
- Preserve one-release compatibility for legacy `openai` CLI/config usage.
