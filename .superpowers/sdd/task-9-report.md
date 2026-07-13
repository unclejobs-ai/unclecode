# Task 9 Report: Wire Advice Generation and Explicit Application

## Status

DONE

## Commit

- `2e04777` `feat(context): add actionable optimizer advice`
- `18c86ec` `fix(context): rebuild condensed history once`
- `6bc4de8` `test(context): prove advice replacement preview`
- `a535863` `fix(context): close optimizer advice lifecycle`

## Implemented

- Evaluates deterministic optimizer policy only after a provider turn completes with a durable `submitted` packet receipt and the completed assistant reply snapshot persists successfully.
- Persists each receipt's evaluator output atomically through the AgentOps suggestion store and publishes receipt-scoped suggestions into `WorkShellEngineState`.
- Keeps optimizer failures isolated from provider success; the assistant reply remains present and the UI shows `Context optimizer unavailable; reply kept.`.
- Retires prior proposed suggestions as soon as a newer receipt is durably submitted, independent of later reply persistence, and retries transient stale writes for delayed superseded turns.
- Added explicit engine actions:
  - `acceptContextSuggestion(id)` resolves the suggestion as accepted before applying its mapped action.
  - `rejectContextSuggestion(id)` resolves the suggestion as rejected and performs no CRP mutation.
- Accepted action mapping:
  - `keep` -> no packet mutation.
  - `hold-back` -> existing CRP `forget` mutation, then packet refresh.
  - `refresh` -> force provider sync and packet refresh.
  - `summarize` -> rebuild condensed history from current trace lines, sync it, then refresh the packet.
- Packet-changing accepted actions synchronously stale every remaining proposal for the receipt before awaiting packet mutation or refresh.
- Added a bounded Context Optimizer UI section with compact known/unknown savings and a four-suggestion cap that reserves a source-evidence slice in 52x40 terminals.
- Added one deterministic selected-suggestion `[A] accept` / `[R] reject` control. Rendering and dispatch share the same visible candidate set and require both callbacks.
- Advice keys never intercept whitespace-only or locally pending composer drafts.
- Added production bootstrap and dashboard plumbing for generation, resolution, invalidation, and condensed-history refresh.

## Lifecycle Correction

Suggestions are generated from `submitted` receipts, and submitted receipt state is terminal by design. Therefore suggestion staleness cannot depend on a receipt transitioning to `invalidated`. `markContextPolicySuggestionsStale(receiptId)` is now an explicit lifecycle operation invoked when a newer receipt or accepted packet mutation supersedes the proposals; it still changes only `proposed` rows and leaves accepted/rejected rows untouched.

## Tests

- Added engine coverage for durable-reply gating, newer-receipt retirement, delayed-result retry, concurrent acceptance closure, prior-receipt invalidation, isolated evaluator failure, accepted/rejected behavior, and summarize refresh ordering.
- Added bootstrap integration coverage for persisted generation/resolution/invalidation and forced condensed-history provider rebuild.
- Added TUI rendering coverage for compact/unknown savings, duplicate-source selection, 52x40 row budgeting, accepted/rejected status, bounded failure copy, and no raw source content.
- Added keyboard/controller/composer coverage for dual-callback gating, visible candidate selection, whitespace drafts, and locally pending input.
- Added AgentOps batch rollback coverage plus explicit stale-transition coverage for terminal submitted receipts.

## Verification

- `npm run test:orchestrator` -> PASS, 350/350.
- `npm run test:tui` -> PASS, 142/142.
- `npm run test:agentops-db` -> PASS, 30/30.
- `npm run test:work` -> PASS, 185/185.
- `npm run build` -> PASS.
- `npm run check` -> PASS.
- LSP diagnostics on all modified TypeScript/TSX implementation files -> no new errors.
- Final Task 9 reviewer verdict after all corrections -> `No findings`.

## Notes

- Biome did not process source files because the repository configuration excludes `src/**`; formatting was kept manually consistent with surrounding code.
