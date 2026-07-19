# Programmatic Tool Calling Design

Date: 2026-07-19
Status: Approved for implementation

## Decision

UncleCode will keep provider-native structured tool calls as its default execution path. It will add one bounded `eval` tool for programmatic tool calling. The tool will run single-shot JavaScript or Python code in a child process and let that code invoke the current session's tools through an authenticated local bridge.

This design copies the useful boundary from OMP and Hermes without replacing UncleCode's Node and Rust runtime split. OMP keeps its agent loop and tool registry in TypeScript, then exposes Python and JavaScript through an eval backend. Hermes keeps normal function calling and adds `execute_code` for loops, filtering, retries, and multi-call programs.

Sources:

- OMP agent loop: https://github.com/can1357/oh-my-pi/blob/main/packages/agent/src/agent-loop.ts
- OMP eval tool: https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/eval.ts
- OMP Python prelude and tool proxy: https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/eval/py/prelude.py
- OMP Python bridge: https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/eval/py/tool-bridge.ts
- Hermes dispatcher: https://github.com/NousResearch/hermes-agent/blob/main/model_tools.py
- Hermes programmatic execution: https://github.com/NousResearch/hermes-agent/blob/main/tools/code_execution_tool.py

## Goals

1. Let a model perform three or more related tool calls with local filtering, branching, retries, and loops inside one provider iteration.
2. Keep intermediate tool results out of the model context unless the program prints or displays them.
3. Preserve UncleCode's existing Rust dispatch validation, tool handlers, cancellation, and provider trace events for each nested call.
4. Measure whether the new path cuts context volume and provider turns enough to justify its process and bridge overhead.
5. Avoid a required Python dependency. JavaScript is always available through the repository's Node 22 requirement; Python is advertised only when a usable `python3` exists.

## Non-goals

- Rewriting the provider loop, orchestrator, or tool registry in Python.
- Replacing normal tool calls for one-step work, user interaction, or calls that need model reasoning over the complete result.
- Building a persistent notebook kernel in the first release.
- Running nested subagents from eval.
- Treating Python or JavaScript execution as a security sandbox.
- Adding a third-party runtime or package.

## Approaches considered

### Replace native calls with Python

This would move tool dispatch, policy, and tracing into a Python host. It would duplicate the current TypeScript and Rust boundaries, add packaging work, and discard resource-aware dispatch already covered by provider tests. It offers no programmatic-tool advantage that a child runner and bridge cannot provide.

### Add a declarative DAG tool

A JSON DAG could express parallel calls and dependencies without arbitrary code. It would be easier to constrain, but it would need a new expression language for filtering, parsing, branching, and retries. OMP and Hermes avoid that language-design cost by using familiar code.

### Add a bounded eval tool

A single tool owns child-process lifecycle, output limits, and bridge registration. User code calls the existing tools by name. The provider loop remains unchanged. This approach adds one execution surface and reuses current dispatch behavior. It is the selected design.

## Public tool contract

The model sees one tool:

```ts
{
  name: "eval",
  input_schema: {
    type: "object",
    properties: {
      language: { enum: ["js", "py"] },
      code: { type: "string" },
      title: { type: "string" },
      timeout: { type: "number", minimum: 1, maximum: 300 }
    },
    required: ["language", "code"]
  }
}
```

The runtime removes `py` from the advertised enum when `python3` cannot execute a version probe. JavaScript code receives an asynchronous proxy:

```js
const result = await tool.read_file({ path: "package.json" });
display(JSON.parse(result).name);
```

Python code receives a synchronous proxy:

```python
result = tool.read_file(path="package.json")
display(json.loads(result)["name"])
```

Both runners provide `display(value)`. Printed output and displayed values form the final result. Nested tool results remain in the child unless the program emits them.

## Runtime flow

1. The provider emits an `eval` call through the normal tool schema.
2. The provider's existing dispatcher validates and starts the outer call.
3. The eval handler checks the arbitrary-execution gate, input, language availability, and timeout.
4. The handler starts a loopback HTTP server on `127.0.0.1` with a random bearer token.
5. The handler starts a child runtime with a scrubbed environment and the session working directory.
6. The child sends `{name, args}` requests to the bridge.
7. The bridge rejects unavailable tools, `eval`, `ask_user`, and requests above the call limit.
8. The bridge serializes nested requests. Each request re-enters the provider's normal Rust dispatch plan and emits its own start/finish trace.
9. The handler kills the child on timeout, cancellation, output overflow, or protocol failure.
10. The handler returns final stdout/display output plus a compact metrics footer.

Nested calls are serialized in the first release. Hermes serializes calls over its local RPC transport, and serial execution avoids a second resource-lock scheduler. Normal top-level tool batches keep their existing resource-aware concurrency.

## Execution boundary

`eval` has the same authority as shell execution. The handler requires `UNCLECODE_ALLOW_RUN_SHELL=1`. This prevents the feature from weakening the current default, where shell execution is disabled.

The child environment contains only the variables needed to start the runtime and connect to the bridge. Variable names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, `CREDENTIAL`, or `DSN` are removed. The bridge token is the sole secret passed to the child and expires when the eval call ends.

The bridge allowlist comes from the active runtime definitions and handlers. It excludes:

- `eval`, to prevent recursion
- `ask_user`, because a blocked child cannot own interactive UI
- names without a current handler

The child can still use its language standard library and access resources allowed by the operating-system account. The tool metadata therefore marks eval as destructive, non-idempotent, open-world, high-risk, and an opaque exclusive resource. The implementation will not describe it as a sandbox.

## Limits

- Default timeout: 30 seconds
- Maximum timeout: 300 seconds
- Maximum nested tool calls: 50
- Maximum request body: 1 MiB
- Maximum captured stdout: 50 KiB
- Maximum captured stderr: 10 KiB
- One child and one bridge registration per eval call
- No persistent state between eval calls

The handler returns deterministic errors for disabled execution, unavailable Python, unknown tools, recursion, timeout, cancellation, malformed bridge requests, call-limit exhaustion, and non-zero child exit.

## Internal interfaces

`ToolHandlerOptions` gains one optional nested-dispatch function. Provider execution supplies it for every handler:

```ts
type NestedToolRequest = {
  name: string;
  input: Record<string, unknown>;
  callId: string;
};

type ToolHandlerOptions = {
  signal?: AbortSignal;
  dispatchTool?: (request: NestedToolRequest) => Promise<ToolResult>;
};
```

The provider implementation builds `dispatchTool` by calling the same single-action path used for model-emitted tools. That path runs the Rust dispatch plan, emits trace events, invokes the handler, and converts the outcome back into `ToolResult`.

The eval package owns:

- dynamic tool definition construction
- language capability probing
- environment scrubbing
- bridge lifecycle and request validation
- JavaScript and Python runner source
- child lifecycle, output capture, and limits
- per-run metrics

`packages/orchestrator/src/tools.ts` only adds the generated definition and handler to the existing runtime maps. The feature does not add more execution logic to that file.

## Metrics

Every eval result records:

- language
- elapsed milliseconds
- child startup milliseconds
- nested tool-call count
- successful and failed nested call counts
- total intermediate result characters
- final returned characters
- context reduction ratio: `1 - returned / intermediate`, clamped to `[-1, 1]`
- timeout, cancellation, truncation, and exit status

Provider trace coverage is a release invariant: every nested request that reaches dispatch must produce one start event and one finish event with the nested call ID.

A deterministic benchmark script compares direct and programmatic execution on these workloads:

1. Read three files and return one selected field from each.
2. Search multiple inputs and return only matching records.
3. Branch on one tool result before issuing the next call.
4. Exercise an unavailable tool and verify a bounded error.
5. Produce oversized output and verify truncation.

The benchmark emits JSON containing:

- success rate
- wall-clock p50 and p95
- provider-iteration count modeled by each path
- tool-call count
- intermediate and returned character counts
- context reduction ratio
- trace completeness
- policy/allowlist rejection count

Acceptance thresholds:

- 100% success on deterministic workloads
- 100% nested trace completeness
- 100% rejection of blocked tools and recursion
- no secret test fixture in child output
- no orphan child after timeout or cancellation
- at least 70% context reduction on the filtering workload
- programmatic host overhead reported, not hidden; no pass/fail latency threshold in the first release

The benchmark does not claim model-quality or token-cost gains. A live-provider benchmark can add those claims later when a real provider key and a fixed prompt suite are available.

## Tests

Unit and integration tests will cover:

- schema and high-risk metadata
- shell gate
- Python capability detection
- environment scrubbing
- JavaScript and Python tool proxy calls
- nested Rust dispatch and trace propagation
- blocked names and maximum call count
- timeout, abort, output caps, and child cleanup
- final-output filtering and metrics
- provider loop continuation after eval returns

The implementation will run focused orchestrator and provider tests, the deterministic benchmark, TypeScript build/check, and runtime QA.

## Rollout

The first release ships behind the existing `UNCLECODE_ALLOW_RUN_SHELL=1` gate. Direct tool calls remain the documented default for one or two calls, edits that need model inspection, and interactive work. The eval description directs models to use it for three or more calls with local processing.

Persistence, parallel nested calls, subagents, and a dedicated OS sandbox require separate evidence and designs. They are excluded from this change.
