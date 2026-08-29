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

## Verification

- `npm run build --silent`: pass.
- `cargo build --quiet -p unclecode`: pass.
- `npm run test:orchestrator --silent`: 536 pass, 0 fail.
- `npm run test:server --silent`: 40 pass, 0 fail.
- `npm run test:cli --silent`: 101 pass, 0 fail.
- `npm run test:work --silent`: 444 pass, 0 fail, 7 platform skips.
- Detached owner process tests: 3 pass, including first-client SIGKILL, exact reattach, simultaneous first clients, and explicit cleanup.
- Runtime owner discovery/session/process/control focused tests: pass, including real child process restart/checkpoint recovery and exact idempotency.
- Task 4 quality workspace focused suite after wording correction: 14 pass, 0 fail.
- Built tmux smoke: `bin → Rust → Node → Ink → detached owner` passed. It proved prompt input, Korean locale projection, Ctrl+O draft preservation/tool-history-only behavior, TUI pane loss, same PID/endpoint/session reattach, monotonic revision preservation, and listener/lease cleanup. PIDs/endpoints were ephemeral and are not retained here.
- Full TUI/check/lint/contracts and final leak/diff checks: recorded in the final verification update below.

## Changed ownership surfaces

New Task 9 modules include the pause controller/execution context, owner discovery/client/service/engine RPC, remote TUI adapter, detached launcher, process fixtures, and focused runtime-owner/TUI smoke tests. Integration changes touch WorkShell engine/session/persistence/agent/tool checkpoints, contract session states, server routes/read model/CLI, TUI engine injection, CLI startup, the work build entry list, and narrowly related test fixtures.

## Concerns and follow-up seams

- A crashed owner cannot resume an arbitrary JavaScript provider/tool stack. Restart projection therefore fails such turns honestly and retains evidence instead of fabricating resumability. Cross-process continuation replay belongs to a future durable workflow design, not Task 9.
- Receipts and journals are bounded, owner-memory structures with stable interfaces. Task 10 can replace their internals without changing the TUI/web control contract.
- The owner intentionally remains long-lived until explicit shutdown; no default idle timeout is applied while it may hold resumable sessions. Cleanup ownership is explicit and tested.
