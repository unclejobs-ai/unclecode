# mmbridge × UncleCode MCP integration handoff

> Date: 2026-04-24
> Status: merged to `main` in both repos; minimum real MCP lane is live
> Scope: mmbridge host-facing MCP surface, UncleCode project-local MCP registration, relative stdio path hardening, minimal work-shell runtime lane, and harness review

## Why this handoff exists

This work crossed two repos and two concerns at once:
1. make the integration real, not registry-only
2. check whether mmbridge is actually being built with decent harness engineering discipline

The implementation is done and merged, but this is exactly the kind of cross-repo change that becomes expensive if the next session loses the thread.

This handoff records:
- what shipped
- what is genuinely good about the current harness
- what is still weak or incomplete
- what should not be casually regressed
- where the next executor should start

---

## Executive summary

Short version:
- Yes, mmbridge is now on a credible harness-engineering track.
- No, it is not “finished” as a harness-heavy system yet.
- The strongest part is the layered verification shape: local scripts + CI + weekly smoke + release gate + focused package tests.
- The weakest part is still true end-to-end host execution coverage across the mmbridge ↔ UncleCode boundary.

Practical judgment:
- foundation: good
- discipline trend: clearly improving
- current maturity: solid early/mid-stage, not yet fully industrialized

---

## What shipped

### mmbridge

Merged commit:
- `03b0bf5` — `Expose mmbridge MCP host integration surface (#3)`

Primary changes:
- `packages/mcp/src/tools.ts`
  - added/normalized host-facing MCP tools
  - made main operational tools consistently accept `projectDir`
- `packages/mcp/test/tools.test.ts`
  - locked the host-facing MCP surface with regression coverage
- `README.md`
  - documented MCP host integration as the recommended host path

Net effect:
- mmbridge can now present a cleaner host-facing control plane over MCP
- host launches are less dependent on hidden `cwd` assumptions
- `gate`, `handoff`, and `doctor` are part of the explicit host story now

### UncleCode

Merged commit:
- `cda3ddf` — `Add project-local mmbridge MCP execution to UncleCode (#2)`

Primary changes:
- `.mcp.json`
  - project-local registration for `mmbridge`
- `scripts/run-mmbridge-mcp.mjs`
  - stable local launcher with layered resolution
- `packages/mcp-host/src/index.ts`
  - relative stdio path resolution hardened against config-file location
- `apps/unclecode-cli/src/mmbridge-mcp.ts`
  - tiny stdio MCP client for real tool calling
- `apps/unclecode-cli/src/operational.ts`
  - wired explicit operational actions
- `packages/orchestrator/src/command-registry.ts`
  - slash/discoverability exposure for the minimal lane
- tests
  - contract + integration + slash + inline-action coverage for the bridge

Net effect:
- UncleCode no longer just lists mmbridge; it can execute a minimum useful MCP-backed lane
- the first stable operational slice is real:
  - `/mmbridge context`
  - `/mmbridge review`
  - `/mmbridge gate`

---

## Architecture truth now

### System picture

```text
+-----------------------------+       stdio MCP        +------------------------------+
| UncleCode                   | <--------------------> | mmbridge                     |
|                             |                        |                              |
| .mcp.json                   |                        | @mmbridge/mcp                |
| scripts/run-mmbridge-mcp    |                        | packages/mcp/src/tools.ts    |
| mcp-host path normalization |                        | host-facing tool definitions |
| mmbridge-mcp.ts client      |                        | projectDir-aware handlers    |
| operational action routing  |                        | gate / handoff / doctor      |
| slash discoverability       |                        | context / review / research  |
+-----------------------------+                        +------------------------------+
```

### Verification picture

```text
Layer 1: package/unit guards
- mmbridge MCP tool definition tests
- UncleCode MCP host contract tests
- UncleCode action/slash tests

Layer 2: local integration checks
- `unclecode mcp list`
- `unclecode doctor`
- focused integration tests against stdio MCP

Layer 3: repo harness
- mmbridge: `lint` + `typecheck` + `test` + `build`
- mmbridge: weekly smoke workflow
- mmbridge: release workflow gated by validation steps

Layer 4: missing / still weak
- true cross-repo CI that actually performs a host-to-mmbridge MCP tool call end-to-end
- more realistic product-level runtime smoke under the host shell
```

---

## What is genuinely good about the harness engineering

### 1) The verification stack is layered, not fake

This is the biggest positive.

mmbridge now has:
- root scripts for `lint`, `typecheck`, `test`, `build`, `smoke`
- CI workflow running `lint -> typecheck -> test -> build`
- weekly smoke workflow running built CLI checks
- release workflow gated on validation before publish

Relevant files:
- `~/project/mmbridge/package.json`
- `~/project/mmbridge/.github/workflows/ci.yml`
- `~/project/mmbridge/.github/workflows/doctor.yml`
- `~/project/mmbridge/.github/workflows/release.yml`

This is proper harness thinking because it separates:
- correctness checks
- regression checks
- operational smoke
- release gating

### 2) The integration path is structurally correct

The important design call was correct:
- do not shell out to mmbridge CLI from random UncleCode slash handlers
- do not fake native integration with string parsing
- use MCP as the real host contract

That matters because it preserves:
- typed tool boundaries
- stable host/tool separation
- cleaner future capability discovery
- less brittle path/process handling

### 3) Relative config hardening solved a real host failure mode

This is easy to underestimate but important.

Fixing stdio relative-path resolution against the MCP config file directory means project-local MCP configs are now much less fragile.

Without that fix, `.mcp.json` would appear to work in one shell and fail in another depending on cwd.

This is harness engineering in the good sense: fixing environment-sensitive failure classes before they become flaky support debt.

### 4) The tests are focused on real failure modes, not vanity coverage

Good examples from this pass:
- project-local relative stdio path resolution
- project MCP registration showing up in `mcp list`
- doctor reflecting non-zero MCP host count
- inline action execution for the actual mmbridge MCP lane
- slash/discoverability exposure for that lane
- mmbridge MCP surface lock for host-facing tools

This is better than broad but shallow “test count” optimism.

### 5) mmbridge host surface is getting more explicit

Adding `projectDir` support consistently is a strong sign.

Cross-host systems get unreliable fast when they quietly depend on launcher cwd.
Explicit `projectDir` support is the right contract boundary.

---

## What is still weak or incomplete

### 1) The biggest missing piece is cross-repo end-to-end smoke

Current truth:
- each repo has good focused checks
- UncleCode has integration tests around the bridge
- mmbridge has package-level MCP tests

Still missing:
- one automated path that boots UncleCode, launches the project-local mmbridge MCP server, and performs at least one real `tools/call` end-to-end in CI-like conditions

That is the main gap if we are judging “proper harness engineering” strictly.

Recommended next step:
- add one hermetic end-to-end smoke using a known-safe mmbridge MCP tool such as `context_packet`, `doctor`, or `gate`
- make it run from the host side, not only from package-local tests

### 2) mmbridge smoke is credible, but still somewhat CLI-centric

Current smoke in mmbridge is useful:
- build CLI
- run `doctor`
- run `context tree`
- run `context packet`
- run `gate`

But this mostly proves mmbridge itself.
It does not prove that a host using MCP can drive it correctly.

Recommended next step:
- add a host-facing smoke lane, either in UncleCode or a tiny fixture host

### 3) Release gate validates doctor, but not the host contract

`release.yml` currently proves:
- lint
- typecheck
- test
- build
- `doctor`

That is good, but if MCP host integration is now strategic, release confidence should also include at least one host-facing MCP contract assertion.

### 4) Compatibility between the two repos is still implicit

Right now compatibility is “kept honest” by active local work and focused tests.
That is good enough for now, but not yet excellent.

Still missing:
- a lightweight compatibility matrix or version note
- a single documented compatibility contract between UncleCode and mmbridge MCP surface
- an automated signal when one repo changes a relied-on MCP tool shape

### 5) Product-level runtime proof is intentionally minimal

This pass intentionally stopped at the minimum real lane.
That was the right scoping decision.
But it also means:
- UncleCode does not yet have a generic MCP runtime for arbitrary tools
- discoverability is partial, not systemic
- richer provenance/product UX for MCP-origin results is still a follow-up

This is not a bug in the scope.
It is just not “done done.”

---

## Current evaluation: good points vs improvement points

### Well done

1. mmbridge now has a believable harness skeleton
   - root validation scripts
   - CI gate
   - smoke workflow
   - release gate

2. The host integration direction is correct
   - MCP, not shell glue

3. The tests cover actual failure classes
   - path resolution
   - project MCP registration
   - runtime action wiring
   - MCP host surface regression

4. `projectDir` explicitness improved host determinism

5. The scope was disciplined
   - minimal real runtime lane first
   - no fake “full MCP support” claims

### Needs improvement

1. add one true host-driven end-to-end MCP smoke path
2. turn cross-repo compatibility into a more explicit contract
3. extend host-facing docs and diagrams so the integration model is obvious
4. grow from minimum explicit actions toward a generic MCP runtime only after the host contract is stable
5. keep checking that release gates cover what users actually rely on, not just internal package health

---

## Important files and why they matter

### UncleCode
- `~/project/unclecode/.mcp.json`
  - project-local mmbridge registration
- `~/project/unclecode/scripts/run-mmbridge-mcp.mjs`
  - local resolution strategy for env override / sibling build / PATH fallback
- `~/project/unclecode/packages/mcp-host/src/index.ts`
  - relative stdio path normalization
- `~/project/unclecode/apps/unclecode-cli/src/mmbridge-mcp.ts`
  - stdio MCP client for explicit tool calls
- `~/project/unclecode/apps/unclecode-cli/src/operational.ts`
  - operational routing entry
- `~/project/unclecode/packages/orchestrator/src/command-registry.ts`
  - slash exposure
- `~/project/unclecode/docs/plans/2026-04-23-unclecode-mmbridge-mcp-integration-and-hardening.md`
  - execution plan for this pass

### mmbridge
- `~/project/mmbridge/packages/mcp/src/tools.ts`
  - canonical host-facing tool definitions and dispatch
- `~/project/mmbridge/packages/mcp/test/tools.test.ts`
  - regression lock for host surface
- `~/project/mmbridge/package.json`
  - root harness commands including `smoke`
- `~/project/mmbridge/.github/workflows/ci.yml`
  - baseline CI gate
- `~/project/mmbridge/.github/workflows/doctor.yml`
  - weekly smoke workflow
- `~/project/mmbridge/.github/workflows/release.yml`
  - release validation gate
- `~/project/mmbridge/README.md`
  - MCP host integration guidance

---

## Verification that was run for this pass

### UncleCode
- `npm run build --silent`
- `node bin/unclecode.cjs mcp list`
- `node bin/unclecode.cjs doctor`
- `node --conditions=source --import tsx --test tests/contracts/mcp-host.contract.test.mjs`
- `node --conditions=source --import tsx --test tests/orchestrator/work-shell-slash-mmbridge.test.mjs`
- `node --conditions=source --import tsx --test --test-name-pattern="mmbridge MCP actions" tests/commands/tui-action-runner.test.mjs`
- `node --test tests/integration/unclecode-mcp.integration.test.mjs tests/integration/unclecode-mmbridge-mcp.integration.test.mjs`

### mmbridge
- `pnpm -C packages/mcp run test`
- `pnpm run build`
- PR CI rerun after formatting fix

### Important note
UncleCode still has unrelated dirty local files outside this integration slice. Do not mix new work with those without intent.

---

## Do-not-regress rules

1. Keep mmbridge operational actions MCP-backed.
   - Do not regress to ad-hoc CLI shell parsing.

2. Keep relative stdio MCP paths resolved against config-file location.
   - Do not reintroduce cwd-dependent project config behavior.

3. Keep `projectDir` as the host-facing contract for mmbridge operational tools.
   - Do not drift back toward hidden cwd assumptions.

4. Do not oversell UncleCode as having a full generic MCP runtime yet.
   - Current truth is a minimum real lane, not complete MCP-native tooling.

5. Keep harness checks honest.
   - Do not replace targeted failure-mode tests with vague high-level smoke only.

---

## Recommended next execution order

### Priority 1 — Add a true host-driven end-to-end smoke

Goal:
- prove one real UncleCode -> stdio MCP -> mmbridge `tools/call` path automatically

Suggested target:
- `mmbridge_doctor` or `mmbridge_context_packet`

Acceptance:
- runs from host side
- launches via project-local `.mcp.json`
- succeeds in a clean temp workspace fixture

### Priority 2 — Make the compatibility contract explicit

Add a short living doc or test fixture that answers:
- which mmbridge MCP tools UncleCode depends on
- required input fields
- expected output shape assumptions
- what is considered breaking

### Priority 3 — Improve product discoverability after runtime truth, not before

Then expand:
- help/palette/discoverability
- provenance display
- richer operator-facing messaging

Only after that should generic MCP runtime work be considered.

---

## Quick start for the next executor

### Repo state
- `~/project/mmbridge`
  - branch: `main`
  - status at merge time: clean
- `~/project/unclecode`
  - branch: `main`
  - status at merge time: dirty for unrelated files plus this handoff doc

### First commands to rerun

```bash
cd ~/project/mmbridge
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke

cd ~/project/unclecode
npm run build --silent
node bin/unclecode.cjs mcp list
node bin/unclecode.cjs doctor
node --conditions=source --import tsx --test tests/contracts/mcp-host.contract.test.mjs
node --test tests/integration/unclecode-mcp.integration.test.mjs tests/integration/unclecode-mmbridge-mcp.integration.test.mjs
```

---

## Bottom-line judgment

If the question is:
- “Is mmbridge being built with real harness engineering discipline?”

The answer is:
- yes, increasingly so
- especially after the harness hardening and this MCP host-integration pass
- but the next bar to clear is true host-driven end-to-end smoke, not more self-contained package checks

In one sentence:
- the architecture direction is right, the harness shape is good, and the biggest remaining gap is cross-repo execution proof.

---

## Addendum — 2026-04-24 post-merge

The Priority 1 "true host-driven end-to-end smoke" gap called out in the original text was closed immediately after this doc landed, and the closure itself exposed that the "minimum real MCP lane" was not actually functional at merge time. Recording the correction here so the next maintainer does not trust the Executive Summary in isolation.

### What we found

While adding the host-driven smoke, empirical probing confirmed that `apps/unclecode-cli/src/mmbridge-mcp.ts` had been hand-rolling LSP-style `Content-Length` framing, but the real `@mmbridge/mcp` server uses `@modelcontextprotocol/sdk`'s `StdioServerTransport` which speaks newline-delimited JSON. Every real `tools/call` invocation was silently dropped by the server's line-based `ReadBuffer`. The fake MCP server used in `tests/commands/tui-action-runner.test.mjs` used the same broken framing, so the existing tests passed against a fake that mirrored the broken client. None of the three shipped operational actions (`/mmbridge context`, `/mmbridge review`, `/mmbridge gate`) could reach the real server.

### What changed after this doc

mmbridge (3 follow-up commits):
- `9cd1ee2` Add host-driven MCP E2E smoke for mmbridge (SDK Client + stdio server)
- `c9f7e9f` Harden MCP smoke: transport-leak guard, timeouts, non-null assertion
- `be47769` Simplify MCP smoke: use SDK TextContent type

unclecode (4 follow-up commits):
- `c34b8aa` Fix mmbridge MCP stdio framing (LSP → NDJSON) and add host-driven E2E smoke
- `f083728` Harden mmbridge MCP client and E2E smoke with timeouts and lifecycle fixes
- `9860396` Simplify mmbridge MCP client: correct timeout race and cleaner skip
- `bf8b557` Simplify mmbridge MCP client: drop redundant Buffer copy and snapshot

### Revised status

- The operational MCP lane is now actually functional end-to-end, not just structurally wired. Verified by `tests/integration/unclecode-mmbridge-mcp-e2e.integration.test.mjs` which spawns `scripts/run-mmbridge-mcp.mjs`, performs `initialize` + `tools/list` + `tools/call mmbridge_doctor`, and asserts response shape.
- mmbridge's `smoke:mcp` script locks the host-facing contract on the mmbridge side independently.
- Default per-request timeout raised to 10 minutes so real `mmbridge_review` / `mmbridge_gate` LLM dispatches do not misleadingly fail fast. Callers may override per-invocation via `input.timeoutMs`, or pass a non-positive value to disable.

### What the original "Still missing" list should read now

1. Priority 1 (true host-driven E2E smoke) — done on the unclecode side; mmbridge has a peer smoke too.
2. Priority 2 (explicit cross-repo compatibility contract) — still open.
3. Priority 3 (richer discoverability / generic MCP runtime) — still open, and should still wait until the contract is explicit.
4. Release gate in mmbridge now covers host-facing MCP surface via `smoke:mcp`; still not integrated into a cross-repo gate.

### Do-not-regress additions

- Keep stdio framing aligned with `@modelcontextprotocol/sdk` (NDJSON). Never reintroduce `Content-Length` headers on this transport.
- Fake MCP servers in tests must mirror real SDK framing, not the client's current implementation.
- The E2E smoke must actually perform `tools/call`, not just `tools/list`. A surface-only assertion hid the framing bug for one full merge cycle.
