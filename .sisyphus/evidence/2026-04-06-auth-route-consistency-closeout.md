# 2026-04-06 auth route consistency closeout

## Scope
- final auth-route clarity passes for the work-first shell
- consistent `Route · Browser OAuth` / `Route · Device OAuth` presentation across:
  - `/auth` launcher
  - remembered auth launcher state
  - refined `/auth status` panels
  - refresh-needed and insufficient-scope OAuth states
- preserve existing product-copy structure while injecting route facts without collapsing layout spacing

## Product outcome
Auth surfaces now make the actual recovery path explicit instead of implying a generic OAuth flow.

### Browser-available shells
- show `Route · Browser OAuth`
- this now applies to:
  - signed-out guidance
  - API-key-active guidance
  - saved OAuth guidance
  - refresh-needed OAuth guidance
  - remembered launcher status

### Browser-unavailable shells
- show `Route · Device OAuth`
- this now applies to:
  - signed-out guidance
  - API-key-active guidance
  - saved OAuth guidance
  - refresh-needed OAuth guidance
  - insufficient-scope OAuth guidance
  - remembered launcher status

## Implementation notes
- `packages/tui/src/work-shell-panels.ts`
  - expanded preferred auth-route normalization to cover OAuth-labelled states as well as unsigned/API-key states
  - added route injection for remembered `Current` launcher panels when the route line is absent
  - preserved blank-line structure when normalizing remembered auth panels so product card spacing stays stable
  - refined `/auth status` product panels to emit route lines for refresh-needed, insufficient-scope, and saved OAuth states
- `tests/work/repl.test.mjs`
  - added/updated expectations for route visibility in remembered auth panels and refined auth-status panels

## Fresh verification

### Targeted auth/work shell verification
- `node --conditions=source --import tsx --test tests/work/repl.test.mjs tests/contracts/tui-work-shell.contract.test.mjs` ✅ (`64 / 64 pass` observed)

### Broader source suites
- `node --conditions=source --import tsx --test tests/commands/*.test.mjs tests/orchestrator/*.test.mjs tests/tui/*.test.mjs tests/work/*.test.mjs tests/contracts/*.test.mjs tests/providers/*.test.mjs` ✅ (`312 / 312 pass` observed)

### Build / typecheck / built integration
- `npm run build --silent` ✅
- `npm run check --silent` ✅
- `node --test tests/integration/*.test.mjs` ✅ (`48 / 48 pass` observed)

## Conclusion
The remaining auth UX tail is now in a closeout state:
- route/device/browser messaging is materially more honest and consistent
- the work shell stays open and actionable even when saved OAuth is stale or missing scope
- auth recovery paths are easier to read at a glance without adding extra chrome

## Honest remaining caveats
- starting a brand-new browser PKCE flow on this machine still requires `OPENAI_OAUTH_CLIENT_ID`
- reusable local Codex OAuth can still exist but remain unusable for UncleCode API work when it lacks `model.request`
- any further work here would be optional polish, not a core correctness gap
