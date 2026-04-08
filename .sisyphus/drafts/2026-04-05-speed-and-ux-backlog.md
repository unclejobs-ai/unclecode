# UncleCode Speed + UX Backlog

## Top 5 priorities
1. **Work-first interaction latency**
   - keep default `unclecode` on the thinnest startup path
   - lazy-load non-critical panels, auth refresh work, and MCP-heavy surfaces

2. **Session center → work shell convergence**
   - session center should feel like a doorway into live work, not a dead launcher
   - keyboard model should be arrows/Tab/Enter/Esc first, vim keys second

3. **Durable chat session visibility**
   - work shell sessions must appear in Recent Sessions
   - resume surface should include conversation-oriented sessions, not only research runs

4. **Attachment + input parity with pi-grade tools**
   - add first-class `@path` handling for files, images, and directories instead of relying mostly on pasted image-path detection
   - verify mixed prompt + attachment parsing for natural text plus `@file` / `@image` references
   - confirm non-image file references become readable context instead of silently doing nothing
   - audit pasted image/file references against pi behavior and close the remaining gaps

5. **Input stability and shell calmness**
   - eliminate layout jitter while typing by reducing hidden/bottom/side panel reflow and keeping the composer area visually stable
   - reserve or stabilize panel height/placement so slash suggestions and auth status do not make the whole screen jump

6. **Auth flow consistency**
   - browser OAuth from TUI/session center must actually complete auth, not only print a URL
   - auth label/status should refresh immediately after success
   - device-code login should be demoted from the main session-center quick actions unless browser OAuth is unavailable
   - auth feedback should be short, obvious, and non-spammy inside Activity/Inspector
   - inline `/auth login` failures must never crash or exit the work shell; show operator guidance inline instead
   - typing partial auth slash commands like `/auth` must surface clear next-step suggestions instead of degenerating into a model prompt
   - when the user is already signed in, browser login surfaces should feel helpful/product-like rather than dumping raw CLI phrasing like `Already signed in via oauth-file...`
   - if the current auth source is `api-key-env` / `api-key-file`, the work shell must explain that browser OAuth is a separate sign-in path, not a generic fix button
   - the auth card should distinguish clearly between:
     - already signed in via API key
     - already signed in via OAuth
     - OAuth browser login unavailable because `OPENAI_OAUTH_CLIENT_ID` is missing
     - auth refresh required / expired credentials
   - `/auth login` inside the work shell should become a product surface with explicit next actions (`browser`, `api key`, `logout`, `status`) instead of feeling like a raw command passthrough error
   - auth launcher success text and actual provider runtime must agree; if the shell says `Auth: oauth-file`, the next real model turn must not fall through into a 401 without an immediate state correction / refresh-needed explanation
   - auth success/failure copy should preserve operator trust: never show a reassuring signed-in card and then silently fail on the next normal prompt
- device OAuth still feels too manual compared with tools like OpenClaw; evaluate a more product-like recovery path that opens a direct verification URL, reduces code transcription friction, or otherwise avoids the current "browser opens but still asks for terminal code" experience where possible
- verify OAuth and API-key integration as one real product system: auth success must update runtime state immediately, the next normal model turn must use the new credentials, and `/auth` surfaces must report the actual active route (`browser-oauth`, `device-oauth`, `api-key-file`, `api-key-env`) honestly

7. **Readable status surfaces**
   - footer/header/status panels should separate runtime, model, mode, auth, approvals, and workers clearly
   - avoid ambiguous labels like bare `v22.22.0`
   - stop the current `Note / Context / You / Step` transcript from visually collapsing into a muddy wall; stronger role hierarchy, spacing, grouping, and color contrast are needed
   - `You`, `Answer`, `Step`, and `Note` should be visually distinct at a glance like pi-grade terminal tools, not just different words with nearly identical weight
   - redesign the context panel with a cleaner information architecture inspired by high-signal terminal tools like yazi: explicit sections, stronger contrast, and less repeated low-value text
- fix the long-conversation layout failure where the right-side context/auth panel stays pinned in the upper-right and becomes effectively unreadable as transcript length grows; the main work surface should prioritize conversation width first
- evaluate replacing the always-visible right sidebar with a better long-session pattern: fullscreen conversation by default, a toggleable `/context` overlay/drawer, or a wide-terminal-only secondary pane
   - slash command discoverability must be first-class: visible suggestions/autocomplete when typing `/`, not hidden knowledge
   - live image preview in the work shell must avoid terminal ghosting / stale-frame artifacts; broken preview is worse than no preview
- add a first-class model picker / `/model` surface so model choice and reasoning level are both visible and directly controllable inside the work shell rather than mostly implicit in startup/config
- audit reasoning UX so the current model, supported reasoning levels, active override/default source, and failure mode are obvious without reading config internals

## Immediate execution plan
### Operator feedback additions
- keep the direct work shell as the default `unclecode` path, but continue treating `center` as a designed launcher/resume hub rather than a throwaway screen
- continue tightening the launcher information hierarchy instead of removing useful launcher affordances
- show attachment state in the composer before submit so pasted images feel intentional, not hidden

### Phase A — unblock broken UX
- fix session-center navigation traps
- make browser OAuth action complete end-to-end
- persist work-shell chat sessions into session-store
- clarify footer/runtime labels

### Phase B — make the product feel faster
- audit startup path for unnecessary synchronous work
- make traces/profiling fully pay-for-play
- reduce session-center rendering noise and front-load the composer/work action

### Phase C — readability / polish pass
- tighten panel hierarchy and spacing
- demote low-signal status text
- improve key-hint copy around primary vs secondary shortcuts
- prevent empty research submissions and approval spam from polluting Activity
- redesign transcript role blocks so `You`, `Answer`, `Step`, and `Note` are immediately scannable
- make slash command discovery feel native with inline suggestions/autocomplete
- rebuild context panel presentation so it reads like an operator sidebar, not a debug dump

### Phase D — screenshot-driven UX corrections
- remove live terminal-image ghosting/stale-frame corruption from the work shell preview path
- prevent partial slash commands such as `/auth` from being sent to the model when the user intent is clearly command discovery
- replace awkward auth re-entry copy (`Already signed in via oauth-file`) with a product-quality signed-in state panel and next actions
- audit repeated `Loaded guidance: AGENTS.md, AGENTS.md` / duplicated context lines and dedupe the presentation layer
- benchmark the result against yazi/pi-grade terminal readability: calm chrome, strong selection/section contrast, compact but obvious hierarchy
- fix the current auth confusion visible in screenshots where the shell reports `API key · env` but `/auth login` falls through to a browser-OAuth-specific missing-client-id error; the UI must explain this state cleanly and propose the right next step
- fix the newer auth/runtime mismatch visible in screenshots where `/auth login` reports `Already signed in` / `Auth: oauth-file` but the next normal prompt still fails with `401`; status cards, runtime auth resolution, and provider requests must converge on one truth
- upgrade transcript presentation so `You`, `Answer`, `Step`, and `Note` use clearly differentiated blocks/borders/spacing instead of blending into one gray text wall
- make the auth panel/action copy feel like one coherent product flow rather than a mix of shell transcript + raw CLI stderr
- investigate whether OpenClaw-style URL extraction / direct browser continuation can be adopted for OAuth recovery so the user is not forced into manual device-code copying when a smoother route is technically available
- when the work pane is embedded inside the launcher shell, it must render as the primary fullscreen work surface rather than stacking duplicate dashboard chrome and pushing the composer off-screen
- redesign long-session context visibility so auth/context/tools are not trapped in a fixed upper-right panel; test options including:
  - default fullscreen conversation with on-demand context overlay
  - bottom drawer for context/auth/tool state
  - auto-collapse of the side panel unless the terminal is wide enough
  - explicit panel toggle / focus mode for transcript-first work
- stop the remaining input-screen shaking seen while typing by stabilizing panel transitions and reducing layout movement around the composer
- add explicit `@path` attachment UX and tests for files/images/directories to reach pi-like operator expectations

## Current status
- Phase A is now substantially implemented in the current branch.
- Phase B and C remain the next high-leverage follow-ups.
