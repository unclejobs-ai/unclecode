# Task 12 report — Herdr HOST and Aside CLI/REPL acceptance

- Date: 2026-08-30
- Frozen UncleCode snapshot: `5d91eafd`
- Status: PASS
- Browser constraint: PASS — no `official.browser` pane was opened

## Outcome

The frozen build passed the requested host acceptance in Herdr without opening a Herdr Browser pane. Herdr was used only as the terminal/runtime host. Web inspection used one Aside REPL and one tab. The run exercised the built UncleCode path and the in-process SCC Quality Engine; it did not launch an SCC daemon, SCC MCP process or alternate SCC store.

The verified ownership remained:

```text
one persistent UncleCode owner
  -> session / orchestrator / policy
    -> SCC Quality Engine + WorkGraph
      -> attached TUI and Aside-observed web control room
```

## Initial host boundary

The acceptance began with these pre-existing Herdr panes:

```text
w1A:p14
w22:pN
w2J:pC
w2J:pG
```

No `official.browser` view was present or created. Test activity used an owned HOST terminal pane and Aside rather than a Herdr browser pane.

## Herdr HOST runtime QA

Runtime QA ran from `06:06:13Z` through `06:08:28Z` against frozen `5d91eafd` and passed 35/35 checks.

Verified through the actual `bin -> Rust -> Node -> Ink` chain:

- ASCII prompt input and committed Korean/IME input;
- Gemini, OpenAI and Anthropic runtime/provider gates;
- English request/product guidance remaining English and Korean request/product guidance remaining Korean;
- `Ctrl+O` toggling tool history only while retaining the composer draft;
- queue behavior, single-spinner/status presentation, PageUp navigation and Escape handling;
- information hierarchy at 60, 80, 100 and 140 columns;
- no `Stop hook failed` product leakage;
- no X, Twitter, Tweet or embed product chrome.

Detach/reattach preserved one owner and one session:

| Evidence | Value |
| --- | --- |
| Owner PID | `78004` |
| Session | `work-c3eb` |
| Revision before/after | `7 -> 11` |

The monotonic revision and shared session show that the second TUI attached to the existing owner instead of creating a competing runtime.

## Aside web acceptance

The web control room was exercised with one persistent Aside REPL and one tab.

Verified behavior:

- an invalid bearer token was rejected;
- valid authentication opened the control room without exposing the token in report output;
- Korean and English document language/title changed with the authoritative locale;
- pause and resume controls operated against the shared owner;
- Runs, Run Detail, Quality, Context, Agents & Jobs, Artifacts, Evolve and System were reachable;
- System projected plugin, memory and cache evidence;
- cache telemetry showed 12 hits, 3 misses, an 80% hit rate;
- a disallowed origin returned `403`;
- `Last-Event-ID` replay returned event `2`;
- active subscription count returned `1 -> 0` after detach;
- iframe, X and Twitter surface counts were all zero.

Security approval, quality evidence and runtime/user controls remained separate control-room surfaces. SCC appeared as the built-in Quality Engine rather than a second product/runtime.

## Cleanup and leak inventory

After acceptance:

- the exact original Herdr pane inventory was restored: `w1A:p14`, `w22:pN`, `w2J:pC`, `w2J:pG`;
- the Aside test tab/REPL session was closed;
- active web subscriptions returned to zero;
- test-owned UncleCode/Aside/host processes were gone;
- test-owned temporary resources were gone;
- no `official.browser` pane existed;
- no test-owned SCC daemon, plugin host, socket, worktree or spill resource remained.

Only test-owned resources were cleaned. User-owned panes and workspace files were preserved.

## Limitations and relation to Task 11

This acceptance proves the requested built host/UI path at frozen `5d91eafd`. It does not turn the offline held-out fixture into live-provider evidence. Task 11 correctly remains `unproven` until its independent final reviews and immutable full verification matrix are recorded. No merge, release, publish, deploy or external write was performed.
