# OpenAI Codex + OpenAI API Split Design

> **Status (2026-07):** ABANDONED design — the explicit split was never implemented; the runtime branches internally on a single `openai` provider id instead. See the matching plan (`docs/plans/2026-04-07-openai-codex-provider-implementation.md`) for details. Kept as a record of the design space.

## Goal
Make UncleCode's OpenAI story honest and reliable by splitting the current overloaded `openai` path into two first-class provider experiences:

- **OpenAI Codex** — ChatGPT/Codex-backed OAuth using the Codex backend
- **OpenAI API** — API-key-backed usage against OpenAI's public API

This design matches the behavior already proven in `claw-dev` and Hermes Agent while preserving a clean path for standard OpenAI API usage.

## Problem
Today UncleCode treats all OpenAI access as one provider:

- auth/status code assumes OpenAI OAuth should yield `model.request`
- runtime code sends requests to `https://api.openai.com/v1/chat/completions`
- login code can reuse Codex/ChatGPT-derived auth context
- users see `OpenAI` in the UI even when the token/runtime semantics differ

That creates a mismatch:

- **Codex/ChatGPT OAuth tokens** work for `chatgpt.com/backend-api/codex`
- the same tokens do **not** satisfy UncleCode's current `openai-api` assumptions
- result: confusing `401/403`, `insufficient-scope`, and login flows that appear successful but cannot power the active runtime

## External Evidence
### claw-dev
- Reuses Codex/ChatGPT login state
- Routes OAuth-backed requests to `https://chatgpt.com/backend-api/codex/responses`
- Does not model this as standard OpenAI public API auth

### Hermes Agent
- Treats `openai-codex` as a separate provider
- Uses a distinct base URL: `https://chatgpt.com/backend-api/codex`
- Stores and refreshes Codex OAuth independently from API-key providers
- Exposes the distinction in auth/provider UX

## Approaches Considered

### Approach A — Keep one `openai` provider and auto-branch internally
**Summary:** Preserve a single provider id and silently switch auth/runtime behavior depending on whether OAuth or API key is active.

**Pros**
- Smallest outward surface change
- Fewer visible provider names

**Cons**
- Harder to reason about failures and status output
- Model lists, auth labels, and docs stay ambiguous
- Increases hidden coupling between runtime selection and credential shape
- Recreates the same confusion that caused the current bug

### Approach B — Split into `openai-codex` and `openai-api` providers
**Summary:** Introduce explicit provider identities, explicit labels, explicit auth flows, and smart auto-selection when the user has not chosen one.

**Pros**
- Honest UX and clearer errors
- Matches proven patterns in Hermes/claw-dev
- Easier tests and lower auth/runtime coupling
- Lets each provider evolve independently

**Cons**
- Larger one-time migration
- Requires compatibility shims for existing `openai` config/CLI usage

### Approach C — Make Codex the new default `openai`, demote API mode to an advanced path
**Summary:** Collapse the UX around Codex OAuth and treat the public API path as secondary.

**Pros**
- Best OAuth-first UX for current user preference

**Cons**
- Too opinionated for an OSS launcher that already documents API-key usage
- Makes standard OpenAI API use feel like a second-class path
- Harder migration for existing users/scripts

## Recommended Direction
**Adopt Approach B.**

UncleCode should treat **OpenAI Codex** and **OpenAI API** as separate providers with distinct runtime contracts, while auto-selecting the best one when the user has not pinned a provider.

## Approved Product Behavior

### Provider identities
Introduce two explicit provider experiences:

- **OpenAI Codex**
  - auth: Codex/ChatGPT OAuth
  - transport/runtime: `chatgpt.com/backend-api/codex`
  - default auth route: `/auth login`
- **OpenAI API**
  - auth: API key
  - transport/runtime: `api.openai.com/v1`
  - default auth route: `/auth key` or explicit API-key login

### Smart default selection
When the user has not explicitly chosen a provider:

1. If valid Codex OAuth exists → select **OpenAI Codex**
2. Else if valid OpenAI API key exists → select **OpenAI API**
3. Else show setup guidance that mentions both paths explicitly

### UI labels
Never collapse these into a single ambiguous `OpenAI` label in auth-sensitive surfaces.
Use explicit labels:

- `OpenAI Codex`
- `OpenAI API`

### `/auth login` behavior
`/auth login` becomes a **smart login** command:

1. Prefer OpenAI Codex OAuth if that route is available
2. If Codex OAuth is unavailable and the active provider is OpenAI API, guide to API-key entry
3. Result summaries and panels must say which provider was authenticated

### Backward compatibility
For one migration window:

- existing `openai` config/CLI values remain accepted as a legacy alias
- normalize legacy `openai` → `openai-api`
- new UI/docs use explicit names only

## Architecture

### 1) Contracts layer
Add provider ids for the new split:

- `openai-api`
- `openai-codex`

Keep a temporary compatibility alias for legacy `openai` at CLI/config parsing boundaries only.
Do **not** keep `openai` as the canonical runtime identity.

### 2) Providers/auth layer
Split the current OpenAI auth helpers into two lanes.

#### OpenAI API lane
- current API-key support remains here
- current `model.request` scope checks remain here for any future public-API OAuth path
- current credential file may remain `~/.unclecode/credentials/openai.json` or be renamed to `openai-api.json`

#### OpenAI Codex lane
- new credential file should be provider-specific, e.g. `~/.unclecode/credentials/openai-codex.json`
- auth flow uses Codex-compatible OAuth/device flow
- refresh logic is provider-specific
- runtime auth resolution must never require `model.request`
- success criteria are: valid access token, refresh token when present, usable Codex backend auth

### 3) Runtime layer
Introduce a Codex-backed runtime provider separate from the current OpenAI public-API provider.

#### OpenAI API runtime
- keep `https://api.openai.com/v1/chat/completions`
- keep current tool-call behavior

#### OpenAI Codex runtime
- talk to `https://chatgpt.com/backend-api/codex` / responses-compatible surfaces
- reuse the compat shaping already proven in `scripts/anthropic-compat-proxy.ts` and shared response helpers where possible
- ensure provider trace events report `provider: openai-codex`

### 4) CLI / TUI layer
All user-facing auth and provider displays must understand the split.

Affected UX:
- `unclecode auth login`
- `unclecode auth status`
- setup/doctor text
- work shell header + auth panel
- mode/provider selection surfaces
- slash command help and error summaries

### 5) Smart config resolution
Provider resolution should become a small explicit function that chooses:
- user-pinned provider first
- then valid Codex OAuth
- then valid OpenAI API key
- then the existing non-OpenAI provider defaults

This logic should live in one place and feed both:
- interactive TUI startup
- non-interactive work/runtime startup

## Data Flow

### OpenAI Codex path
1. User runs `unclecode auth login`
2. UncleCode starts Codex OAuth/device flow
3. Credentials are stored under the Codex-specific auth store
4. Startup/auth resolution detects valid Codex OAuth
5. Provider auto-select chooses `openai-codex`
6. Runtime uses Codex backend endpoints

### OpenAI API path
1. User runs API-key login or sets `OPENAI_API_KEY`
2. Credentials are resolved from env or stored API-key auth
3. Provider auto-select chooses `openai-api` if Codex OAuth is absent
4. Runtime uses `api.openai.com/v1`

## Error Handling

### OpenAI Codex errors
Translate errors toward provider-specific guidance:
- expired/revoked OAuth → `OpenAI Codex login expired. Run /auth login.`
- missing Codex auth → `OpenAI Codex not signed in.`
- backend 401/403 → `OpenAI Codex rejected current OAuth. Re-login to Codex.`

Do **not** mention `model.request` for this provider.

### OpenAI API errors
Retain API-specific guidance:
- missing API key
- invalid API key
- insufficient-scope public-API OAuth (if supported later)

## Testing Strategy

### Contract tests
- provider ids/capabilities include `openai-api` and `openai-codex`
- legacy `openai` is normalized only at compat boundaries

### Provider tests
- OpenAI Codex auth resolution accepts Codex OAuth tokens without `model.request`
- OpenAI API auth resolution still requires API-key/public-API rules
- status formatting distinguishes the two providers

### Runtime tests
- OpenAI Codex runtime targets Codex backend URL
- OpenAI API runtime still targets `api.openai.com/v1`
- trace events expose correct provider ids

### CLI/TUI tests
- smart provider selection chooses Codex first, API second
- `/auth login` chooses Codex OAuth path by default
- setup/doctor/auth panels use explicit provider labels
- existing `openai` alias remains accepted during migration

## Migration Notes
- Existing users with `OPENAI_API_KEY` should continue to work with minimal change
- Existing users with reusable Codex auth should stop seeing misleading `insufficient-scope` failures once the provider split lands
- Documentation should be updated to describe `OpenAI Codex` vs `OpenAI API` explicitly

## Non-Goals
- Supporting a new public OpenAI OAuth client for the public API in this change
- Reworking non-OpenAI providers
- Removing the local compat proxy in this phase

## Success Criteria
- A user with only Codex/ChatGPT OAuth can start UncleCode and land on **OpenAI Codex** without 401/403 scope confusion
- A user with only `OPENAI_API_KEY` lands on **OpenAI API**
- `auth status`, setup, doctor, and work-shell UI clearly say which OpenAI provider is active
- Legacy `openai` config remains accepted during the migration window
