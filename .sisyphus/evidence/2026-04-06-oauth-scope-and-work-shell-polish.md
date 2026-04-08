# 2026-04-06 OAuth Scope and Work Shell Polish

## Root cause found on the current machine
The current machine is reusing `~/.codex/auth.json`, but that OAuth access token is not usable for UncleCode's OpenAI API work surface.

### Direct evidence
- `node apps/unclecode-cli/dist/index.js auth status`
  - `source: oauth-file`
  - `expiresAt: insufficient-scope`
  - `expired: yes`
- direct probe with the current Codex token:
  - `GET https://api.openai.com/v1/models` -> `403` with missing scope info
  - `POST https://api.openai.com/v1/chat/completions` -> `401` with `missing_scope` / `model.request`

This means the earlier UX bug was not just copy drift. The token existed, but it lacked the `model.request` scope needed for UncleCode's work-shell API calls.

## Product fixes shipped

### OAuth/auth correctness
- `packages/providers/src/openai-auth.ts`
  - now detects OAuth JWT scope claims and rejects tokens that lack `model.request`
  - now distinguishes `codex-auth-file` from `unclecode-auth-file`
- `packages/providers/src/openai-status.ts`
  - reports `expiresAt: insufficient-scope`
  - marks insufficient-scope auth as unusable (`isExpired: true`)
- `src/config.ts`
  - returns a clear insufficient-scope error instead of pretending OAuth is valid
- `src/providers.ts`
  - OpenAI HTTP failures now include response bodies, allowing `missing_scope` to surface instead of a blind `401`
- `apps/unclecode-cli/src/program.ts`
  - `auth login --browser` now says when saved OAuth exists but lacks the scope required for UncleCode API calls
- `apps/unclecode-cli/src/operational.ts`
  - session-center/work-shell browser login path now reports the same insufficient-scope reality
- `packages/orchestrator/src/work-shell-engine.ts`
  - 401/403 runtime failures refresh auth state immediately

### Work-shell design polish
- `packages/tui/src/work-shell-view.tsx`
  - role labels now use `Prompt / Answer / Action / Status`
  - system/status blocks are visually separated more clearly
- `packages/tui/src/work-shell-panels.ts`
  - auth cards now avoid overclaiming with `Saved browser OAuth found` instead of falsely reassuring `Already signed in`
  - compact context panel now renders as a clearer checklist-like `Focus` block
  - auth panel distinguishes insufficient-scope from refresh-needed

## Verification
- targeted batch:
  - `node --conditions=source --import tsx --test tests/providers/openai-auth.test.mjs tests/providers/openai-status.test.mjs tests/contracts/tui-work-shell.contract.test.mjs tests/commands/tui-action-runner.test.mjs tests/integration/unclecode-auth-login.integration.test.mjs tests/work/repl.test.mjs`
  - result: `92 / 92 pass`
- full gates:
  - `npm run lint --silent`
  - `npm run check --silent`
  - `npm run build --silent`
  - `npm run test:integration --silent`
  - result: `45 / 45 pass`

## Current machine outcome
The current machine no longer lies about Codex OAuth reuse:
- it reports the saved OAuth as present but unusable for UncleCode API work
- it points to the real working routes:
  - `unclecode auth login --api-key-stdin`
  - `OPENAI_API_KEY`
  - proper browser OAuth with `OPENAI_OAUTH_CLIENT_ID`
