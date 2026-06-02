# OpenShell Adapter Design

> Date: 2026-06-01
> Status: implemented adapter spike for sandbox-theory Phase 3
> Scope: runtime-broker adapter and fake CLI lifecycle validation

## Current External Facts

OpenShell is an alpha, single-player runtime for autonomous agents. Its public
README describes sandboxed execution with declarative YAML policy for file,
network, credential, and infrastructure protection:
https://github.com/NVIDIA/OpenShell

The CLI quickstart requires a reachable OpenShell gateway, at least one compute
driver, and the local OpenShell CLI:
https://docs.nvidia.com/openshell/get-started/quickstart

OpenShell sandboxes are created and connected through gateway-backed CLI
commands such as `openshell sandbox create -- claude`, and the gateway must be
registered or selected before sandbox commands run:
https://docs.nvidia.com/openshell/sandboxes/manage-sandboxes

OpenShell supports Docker, Podman, MicroVM, and Kubernetes compute drivers, with
driver-specific gateway configuration and different isolation properties:
https://docs.nvidia.com/openshell/reference/sandbox-compute-drivers

## Design Decision

Do not make OpenShell a core UncleCode dependency. Treat it as an optional
hardened runtime adapter behind the already-declared `openshell` runtime mode.

The adapter must be fail-closed:

- If `openshell` is not installed, return `ADAPTER_UNAVAILABLE`.
- If no gateway is selected or reachable, return `ADAPTER_UNAVAILABLE`.
- If no explicit execution policy profile is supplied, deny side-effecting team
  mini-loop tools before they execute.
- If policy translation fails, do not create or reuse a sandbox.
- If sandbox create/connect/exec output cannot be parsed, mark the runtime
  container failed rather than falling back to local execution.

## Proposed Ownership

The first implementation should live in `packages/runtime-broker`, not in the
TUI or CLI app.

Recommended files:

- `packages/runtime-broker/src/openshell-adapter.ts`
- `packages/runtime-broker/src/index.ts`
- `tests/runtime-broker/openshell-adapter.test.mjs`
- `docs/proposals/2026-06-01-openshell-adapter-design.md`

Implemented test coverage currently lives in
`tests/runtime-broker/sandbox-escalation.test.mjs` to keep runtime escalation
coverage in one suite.

The team mini-loop already has its own policy seam. Runtime-broker should own
sandbox lifecycle; team mini-loop should own tool-level policy decisions.

## Adapter Interface

`OpenShellAdapter` should implement the same behavior shape as existing
runtime-broker adapters:

- `spawn(command, args)` creates or reuses an OpenShell sandbox and executes the
  command inside it.
- `kill(containerId)` deletes or stops the OpenShell sandbox associated with the
  runtime container.
- `health()` reports whether CLI, gateway, and configured compute driver are
  available.
- `onEvent/removeEventListener` emit lifecycle events compatible with existing
  runtime UI.

Initial config should be explicit:

```ts
export type OpenShellAdapterConfig = {
  readonly gatewayName?: string;
  readonly sandboxNamePrefix?: string;
  readonly sandboxImage?: string;
  readonly policyPath?: string;
  readonly providers?: readonly string[];
  readonly uploadWorkspace?: boolean;
  readonly sandboxWorkspace?: string;
  readonly downloadPaths?: readonly {
    readonly sandboxPath: string;
    readonly localPath: string;
  }[];
  readonly workingDirectory: string;
  readonly environment?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly captureOutput?: boolean;
};
```

Do not auto-create broad policies from UncleCode state. Generate or apply only
the policy file supplied by config until policy translation is implemented and
tested.

## Policy Translation Boundary

UncleCode execution policy and OpenShell YAML policy are not the same object.
The translation layer should be explicit and testable.

Mapping v1:

- `filesystem.read` maps to read-only workspace mounts or OpenShell file policy
  once supported by the selected driver.
- `filesystem.write` maps to scoped write paths only.
- `shell.run` maps to whether command execution is allowed in the sandbox, not
  to host shell permission.
- `network.egress` maps to OpenShell network policy host/method/path entries.
- `secret.read` maps to provider credential injection only; raw secrets should
  not be copied into the sandbox filesystem.
- `inference.request` maps to OpenShell managed provider or privacy-router
  routing where configured.

Non-goal for v1: infer network hosts by parsing arbitrary shell strings.

## Lifecycle

1. `createRuntimeBroker({ runtimeMode: "openshell" })` constructs
   `OpenShellAdapter` only if config enables it.
2. `spawn()` checks `openshell --help` or equivalent CLI availability.
3. Adapter selects the configured gateway and treats selection failure as
   `ADAPTER_UNAVAILABLE`.
4. Adapter passes explicit policy and provider flags to sandbox creation when
   configured.
5. Adapter creates a sandbox with a deterministic name prefix and isolated
   workspace.
6. Adapter optionally uploads the local working directory into the configured
   sandbox workspace.
7. Adapter executes command in the sandbox through `sandbox exec -n`.
8. Adapter optionally downloads configured artifact paths.
9. Adapter records stdout/stderr/exit state and latency in the returned
   `RuntimeContainer`.
10. Adapter deletes or stops the sandbox on completion, `kill()`, or terminal
    failure.

## Test Plan

Required tests before implementation is accepted:

- Missing CLI returns `ADAPTER_UNAVAILABLE`.
- Missing gateway returns `ADAPTER_UNAVAILABLE`.
- `openshell` mode never falls back to local execution.
- Configured policy path is passed to sandbox creation before execution.
- Configured provider flags are passed to sandbox creation.
- Workspace upload and artifact download hooks are invoked when configured.
- Sandbox create failure returns an adapter error without local fallback.
- Command output, exit code, and timestamps are captured consistently with
  local/docker adapters.
- `health()` reports local adapter independently from OpenShell availability.

Current validation uses a fake OpenShell CLI so the repo can verify command
sequence and failure behavior without requiring an installed alpha gateway. A
real gateway smoke test remains environment-specific.

## Rollout

1. Keep current recognized-but-unsupported `openshell` behavior as the default.
2. Add adapter behind explicit runtime-broker config. Done.
3. Add CLI config only after runtime-broker tests pass.
4. Add policy translation only after a static YAML policy path works.
5. Add TUI approval/retry loops after policy.denied metadata is persisted.

## Open Questions

- Should UncleCode manage one sandbox per team worker or one sandbox per team
  run?
- Should sandbox workspace sync happen through OpenShell file transfer, git
  checkout, or mounted volume?
- Which OpenShell command gives the most stable machine-readable sandbox ID?
- How should provider credentials be injected without duplicating raw secrets in
  UncleCode session logs?
