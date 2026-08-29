# Task 9 report — single persistent runtime and cooperative pause

Date: 2026-08-29

## Outcome

Task 9 replaces the per-TUI/split-registry runtime with one authenticated, detached UncleCode owner service. The owner process holds every live `WorkShellEngine`, session factory, policy/approval path, follow-up queue, AgentOps/session persistence, SCC quality projection, event journal, revision clock, and control-room HTTP/SSE endpoint. TUI and standalone server processes are attach-only clients. No SCC daemon, SCC MCP process, `.data` run state, fixed port, or second control registry is introduced.

The Work Shell now has an explicit cooperative pause controller. Pause acknowledgement occurs only after a durable safe-boundary checkpoint; it does not abort the turn, answer an approval, pause the follow-up queue, or create a replacement turn. Resume releases the same suspended continuation once. Cancel remains AbortSignal-based and distinct.

## Owner, discovery, and IPC protocol

- Discovery protocol: `unclecode-runtime-owner/1`, version 1.
- The atomic 0600 lease records owner UUID, OS PID, host boot identity, ephemeral loopback endpoint, token-file reference, and start time. The bearer token is never placed in the lease.
- The claim is an exclusive `wx` lock with claimant PID/boot identity. Simultaneous first clients converge on one owner; dead/stale claims are recoverable. A live PID is insufficient: protocol, owner UUID, boot identity, and exact `/health` response must all match.
- The first client starts a detached `runtime-owner-service`; it never becomes the owner itself. The build emits this entry in both package `dist` and the real `dist-work` Rust bridge tree. Provider/runtime configuration crosses a small environment allowlist; unrelated application secrets do not.
- The owner binds port 0 on loopback. The old per-TUI 17677/EADDRINUSE/silent-disable path and the standalone server's split listener/registry are gone. `unclecode-server` attaches to and reports the existing owner endpoint instead of proxying or listening again.
- Session RPCs are authenticated list/create/attach/read/invoke operations. One owner factory supports multiple workspaces and multiple simultaneous sessions. Session IDs cannot be rebound across workspaces.
- The remote TUI engine is explicitly non-thenable, polls an owner snapshot only while subscribed, serializes mutations, and detaches without stopping the owner. One autonomous revision conflict is refreshed and retried with the exact same idempotency key and payload.

## Revisions and idempotency

- A single per-session owner clock is shared by the engine RPC and control-room adapter. Engine publications and accepted controls cannot advance split counters.
- Every mutation carries `expectedRevision` and an exact idempotency key. A stale conflict does not bind the key. An accepted key replays the original response without executing again; reuse with a changed fingerprint fails closed.
- A two-client same-revision race executes exactly one accepted mutation. The loser receives `revision_conflict`. The explicit contract test also proves autonomous owner updates, conflict/retry payload stability, exact accepted replay, and changed-payload rejection.
- The Task 9 seam intentionally stops short of Task 10 replay-ledger/cache internals; bounded in-memory receipts remain replaceable behind the same protocol.

## Cooperative pause safety

`WorkShellPauseController` owns `idle | running | pause_pending | paused | cancelled | completed` independently of AbortSignal. Its checkpoints are:

- before and after provider calls;
- before and after policy and approval boundaries;
- before and after tool dispatch;
- between WorkGraph nodes;
- between SCC refine/pivot quality iterations;
- before completion.

Provider calls and irreversible tool handlers are non-interruptible regions. A request there remains `pause_pending`; the controller persists the outer completed boundary before publishing `paused`. While paused, it issues no provider request, tool/node dispatch, quality iteration, queue drain, or completion. Pending approvals, attachments, context evidence, WorkGraph/SCC state, turn ID, and queued follow-ups remain on the same engine. Concurrent pause callers share one acknowledgement and resume releases once. Cancel running/paused work is separate and aborts the continuation.

## Persistence, restart, and cleanup

- The owner watches durable session persistence receipts and republishes them through its bounded journal/SSE stream.
- Restart discovery walks real `*.checkpoint.json` files recursively. A checkpoint already completed remains resumable/projectable. Orphaned `running`, `pause_pending`, or `paused` work is marked failed with `non_resumable_owner_restart`; it is never advertised as a live turn that no process can continue.
- SCC phase, gate, iteration, WorkGraph, reviewer/evidence state, and creator/evolution history continue through the UncleCode checkpoint/read model. No parallel SCC event store exists.
- TUI/client disposal removes polling timers/listeners only. Owner shutdown stops the HTTP listener, persistence watcher, every engine/subscription, and its own lease. Real tests kill first-client/TUI processes with SIGKILL and verify the detached owner remains; explicit SIGTERM then removes the lease and closes the listener. Readiness, exit, and cleanup waits are bounded.

## RED → GREEN evidence

1. Provider pause initially completed/aborted the turn. Controller and engine tests now prove `pause_pending → after_provider → durable paused → same continuation`, one provider call.
2. Approval pause initially lost or answered the pending decision. The decision remains pending across pause/resume.
3. An irreversible tool initially could claim pause mid-effect. The timing test proves pending until handler settlement, then pause at `after_tool`.
4. Queue drain initially could pass the suspended turn. A queued follow-up remains queued and drains exactly once only after the original turn resumes.
5. Discovery tests initially had no owner identity or stale recovery. They now cover simultaneous claim, dead PID, stale boot, incompatible protocol, foreign endpoint, and live-PID/wrong-health rejection.
6. The initial remote proxy became a Promise thenable and hung its test process. `then` is explicitly absent; cleanup regression exits naturally.
7. The first implementation left the first TUI as the process owner. Real SIGKILL evidence failed the persistence requirement. Startup now hands the atomic claim to a detached owner service; two simultaneous OS clients converge on it.
8. The real Rust bridge initially failed because computed service code was absent from `dist-work`. The work build now explicitly emits the owner-service entry.
9. The real Ctrl+O smoke exposed an autonomous-revision race that terminated Ink with `Engine revision changed`. Mutations are serialized and one stale revision refresh/retry preserves the same key/payload.
10. The existing TUI quality assertion expected the ambiguous text `branch+worktree present`; Task 8's truthful current/historical distinction renders `current branch+worktree present`. The fixture now asserts the authoritative wording.
11. A forced owner-startup timeout initially left its detached service alive. The launcher now reaps that exact child with bounded TERM/KILL fallback; the real-process regression observes no matching service after rejection.

## Verification

- `npm run build --silent`: pass.
- `cargo build --quiet -p unclecode`: pass.
- `npm run test:orchestrator --silent`: 537 pass, 0 fail.
- `npm run test:server --silent`: 51 pass, 0 fail.
- `npm run test:cli --silent`: 109 pass, 0 fail.
- `npm run test:work --silent`: 444 pass, 0 fail, 7 platform skips.
- `npm run test:tui --silent`: 498 pass, 0 fail, including the authoritative `current branch+worktree present` history/current wording and the two prompt-ownership regressions.
- `npm run test:contracts --silent`: 273 pass, 0 fail.
- `npm run check --silent`: pass.
- `npm run lint --silent`: pass (`Checked 100 files`; no fixes applied).
- `git diff --check`: pass.
- `cargo test --workspace`: 514 pass, 0 fail (88 CLI/bin + 1 integration + 425 core).
- Detached owner process tests: 4 pass, including first-client SIGKILL, exact reattach, simultaneous first clients, timed-out-startup reaping, and explicit cleanup.
- Runtime owner discovery/session/process/control focused tests: pass, including real child process restart/checkpoint recovery and exact idempotency.
- Task 4 quality workspace focused suite after wording correction: 14 pass, 0 fail.
- Built tmux smoke: `bin → Rust → Node → Ink → detached owner` passed. It proved prompt input, Korean locale projection, Ctrl+O draft preservation/tool-history-only behavior, TUI pane loss, same PID/endpoint/session reattach, monotonic revision preservation, and listener/lease cleanup. PIDs/endpoints were ephemeral and are not retained here.
- Final process audit found no Task 9 owner-service, runtime-QA, or UncleCode tmux process after explicit shutdown. The built smoke independently verified the endpoint stopped accepting connections and both lease and listener were removed.

## Changed ownership surfaces

New Task 9 modules include the pause controller/execution context, owner discovery/client/service/engine RPC, remote TUI adapter, detached launcher, process fixtures, and focused runtime-owner/TUI smoke tests. Integration changes touch WorkShell engine/session/persistence/agent/tool checkpoints, contract session states, server routes/read model/CLI, TUI engine injection, CLI startup, the work build entry list, and narrowly related test fixtures.

Task 9 is split into reviewable commits:

- `52ed257` — persistent owner/discovery/IPC primitives, cooperative pause controller, and focused process/contract tests.
- `8c4a50b` — attach-only TUI/server cutover, owner-service work build entry, remote adapter injection, and integration fixtures.
- `ce9ceff` — bounded cleanup and real-process regression for a timed-out detached owner startup.
- `8f486ee` — initial Task 9 verification and architecture report.
- `ce9e5cd` — committed the previously missing owner control attachment so clean heads are self-contained.
- `f0d4a1e` — one shared per-session mutation arbiter with pending receipts, fingerprints, atomic revision admission, and preemptive cancellation.
- `f324308` — one shared pause transition/persist/suspension gate across overlapping checkpoints and approvals.
- `677fe1d` — monotonic remote publication plus an explicit identity-stable retry allowlist.
- `66f9c1b` — async owner/engine shutdown that aborts and boundedly settles active provider/tool work.
- `df0bfa9` — persisted and restored the single owner session revision.
- `0c4970e` — hardened lock, process identity, token directory/file, symlink, lease publication, and startup failure paths.
- `055117c` and `f91e0c0` — removed client-side agent construction; TUI/server attachments carry serializable configuration only.
- `4e6e0e6` — persisted the complete safe-boundary pause checkpoint through the Rust/session path.
- `bd254aa` — bounded client fetch cancellation and remote detach regression.
- `c5a6710` — deterministic detached-child startup/exit settlement, long request bounds, and concurrent first-client recovery.
- `fb06a33` — prompt-owner stabilization: explicit steer reset epoch, monotonic local draft/cursor acknowledgement, and authoritative Agent Console compose ownership.

Exact files contained in those Task 9 commits:

```text
.superpowers/sdd/2026-08-28-unclecode-scc-integration/task-9-report.md
apps/unclecode-cli/src/remote-work-shell-engine.ts
apps/unclecode-cli/src/runtime-owner-launcher.ts
apps/unclecode-cli/src/runtime-owner-service.ts
apps/unclecode-cli/src/work-runtime.ts
apps/unclecode-server/src/cli.ts
apps/unclecode-server/src/control-room.ts
apps/unclecode-server/src/index.ts
apps/unclecode-server/src/persistent-runtime.ts
apps/unclecode-server/src/runtime-engine-rpc.ts
apps/unclecode-server/src/runtime-owner-client.ts
apps/unclecode-server/src/runtime-owner-discovery.ts
apps/unclecode-server/src/runtime-owner.ts
packages/contracts/src/engine.ts
packages/orchestrator/src/execution-pause.ts
packages/orchestrator/src/index.ts
packages/orchestrator/src/work-shell-pause-controller.ts
packages/tui/src/dashboard-render.tsx
scripts/runtime-qa/runtime-owner-client-fixture.mjs
scripts/runtime-qa/runtime-owner-fixture.mjs
scripts/runtime-qa/runtime-owner-tui-smoke.mjs
tests/cli/remote-work-shell-engine.test.mjs
tests/cli/runtime-owner-detached.test.mjs
tests/contracts/event.contract.test.mjs
tests/contracts/unclecode-cli.contract.test.mjs
tests/orchestrator/work-shell-pause-controller.test.mjs
tests/unclecode-server/cli-startup.test.mjs
tests/unclecode-server/evolution-transport.e2e.test.mjs
tests/unclecode-server/runtime-owner-discovery.test.mjs
tests/unclecode-server/runtime-owner-process.test.mjs
tests/unclecode-server/runtime-owner-sessions.test.mjs
tsconfig.work.json
```

The integration worktree also contains pre-existing user and Task 7/8 changes. Mixed WorkShell checkpoint, tool/agent, and Task 8 wording-fixture hunks were deliberately preserved rather than reset or claimed wholesale; their branch-wide integration remains visible in the working tree.

## Independent-review fix round 1 closure

Every initial Critical, Important, and Minor finding is mapped to a committed correction and focused evidence:

| Finding | Closure | Evidence |
|---|---|---|
| Clean head missing `work-shell-control` and pause hunks | `ce9e5cd`, `4e6e0e6` | synthetic clean checkout build; focused engine/persistence/Rust pause tests |
| Engine/control duplicate execution and split revisions | `f0d4a1e` | async same-key executes once; engine/control race; same-revision winner exactly once; changed fingerprint conflicts; accepted key exact-replays |
| Pause lost wakeup/approval overlap | `f324308` | two overlapping checkpoints share one persistence and are released by one resume; approval remains pending |
| Late stale remote publication | `677fe1d` | a late lower revision is rejected by poll and invocation publication |
| Unsafe decision retry | `677fe1d` | only stable methods retry; changed decision identity surfaces conflict |
| Cancel blocked behind pause | `f0d4a1e`, `f324308` | cancel during `pause_pending` preempts and settles without waiting for resume |
| Live provider/tool shutdown | `66f9c1b` | owner shutdown aborts, waits boundedly, and disposes live provider/tool continuations |
| Restart revision reset/split clock | `df0bfa9` | durable restored revision remains monotonic through restart and autonomous publication |
| Incomplete durable pause receipt | `4e6e0e6` | turn/boundary, node/attempt, SCC stage/gate/iteration, decision, context, attachment, artifact refs round-trip and flush before pause acknowledgement |
| Truncated locks/PID reuse | `0c4970e` | real filesystem empty/truncated lock recovery, process-start mismatch, stale claim, and live wrong-identity cases |
| Insecure/symlinked token | `0c4970e` | 0700 parent, atomic 0600 no-follow token, parent/token symlink rejection, insecure legacy rejection |
| Duplicate factory/client agent construction | `055117c`, `f91e0c0` | concurrent different-key session creation constructs once; bootstrap/remote clients are attachment/config only |
| Spawn/lease publication cleanup | `0c4970e`, `c5a6710` | spawn error, nonzero/signal exit, lease-publish failure, TERM→KILL settlement, simultaneous first clients, bounded failure cleanup |
| Unbounded fetch/detach poll | `bd254aa`, `c5a6710` | request timeout/AbortController and detach-aborts-poll tests exit naturally |
| Missing report accounting | this report | includes `8f486ee` and every fix-round commit above |

Final fix-round commands and results:

```text
npm run build --silent && npm run check --silent && npm run lint --silent
  exit 0; Checked 100 files; no fixes applied

npm run test:tui --silent
  498 pass, 0 fail, 178.485s

npm run test:contracts --silent
  273 pass, 0 fail

npm run test:work --silent
  444 pass, 0 fail, 7 supported-platform containment skips, 90.700s

cargo test --workspace
  514 pass, 0 fail

node --disable-warning=ExperimentalWarning --conditions=source --import tsx \
  scripts/runtime-qa/runtime-owner-tui-smoke.mjs
  pass: bin -> Rust -> Node -> Ink -> detached owner; revision increased after reattach;
  Korean prompt/locale and Ctrl+O tool-history-only draft preservation passed;
  explicit shutdown removed owner listener and lease
```

The final synthetic staged/committed TUI tree built cleanly and its focused suite passed 48/48. That suite includes delayed controlled-parent acknowledgement with rapid subsequent input, stale cursor rejection, first-character Agent Console ownership over hidden telemetry, Escape draft disposal, Ctrl+O, queue, and all six entry/reflow tests. Startup diagnostics deliberately use ignored detached stdio after handoff to prevent inherited-pipe EPIPE and terminal-handle leaks; failed startup still reports deterministic exit code/signal, while bounded lease/health evidence remains the diagnostic source.

## Concerns and follow-up seams

- A crashed owner cannot resume an arbitrary JavaScript provider/tool stack. Restart projection therefore fails such turns honestly and retains evidence instead of fabricating resumability. Cross-process continuation replay belongs to a future durable workflow design, not Task 9.
- Receipts and journals are bounded, owner-memory structures with stable interfaces. Task 10 can replace their internals without changing the TUI/web control contract.
- The owner intentionally remains long-lived until explicit shutdown; no default idle timeout is applied while it may hold resumable sessions. Cleanup ownership is explicit and tested.
