# Programmatic Tool Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OMP-inspired `eval` tool that runs bounded JavaScript or Python programs, dispatches nested session tools through UncleCode's existing provider path, and reports deterministic evaluation metrics.

**Architecture:** Provider-native tool calls remain the default. `eval` starts one child process and one authenticated loopback bridge per call. Nested calls re-enter the Rust dispatch plan and provider trace path, while the child returns only printed or displayed output plus run metrics.

**Tech Stack:** Node.js 22 child processes and HTTP server, TypeScript 5.9, optional system `python3`, Rust-backed provider dispatch, Node test runner, existing npm workspaces. No new dependency.

## Global Constraints

- Keep Node/TypeScript as the orchestration host and Rust as the dispatch and ACI boundary.
- Require `UNCLECODE_ALLOW_RUN_SHELL=1` before arbitrary JavaScript or Python execution.
- JavaScript is required; Python is optional and must pass a `python3` version probe.
- Limit each run to 50 nested calls, 50 KiB stdout, 10 KiB stderr, and 300 seconds.
- Exclude `eval` and `ask_user` from nested dispatch.
- Serialize nested calls in v1.
- Preserve one provider start and finish trace per nested call.
- Add no dependency and no persistent kernel.

---

### Task 1: Nested provider dispatch contract

**Files:**
- Modify: `packages/providers/src/runtime.ts:180-218,2684-2742`
- Test: `tests/providers/programmatic-tool-dispatch.test.mjs`

**Interfaces:**
- Consumes: existing `ToolDefinition`, `ToolHandler`, `ToolResult`, `ProviderTraceListener`, and `executeProviderToolDispatches` behavior.
- Produces: exported `NestedToolRequest` and optional `ToolHandlerOptions.dispatchTool(request)` that returns a `ToolResult` through Rust validation and provider tracing.

- [ ] **Step 1: Write the failing nested-dispatch trace test**

Create `tests/providers/programmatic-tool-dispatch.test.mjs` with a two-step fake OpenAI response. Its outer `eval` handler must call `options.dispatchTool({ name: "read_file", input: { path: "a.txt" }, callId: "nested-read-1" })`. Assert that the returned content is `nested-ok`, the turn ends with `done`, and trace events include one start and one finish for `nested-read-1`.

```js
const outerHandler = async (_input, _cwd, options) => {
  assert.equal(typeof options.dispatchTool, "function");
  return await options.dispatchTool({
    name: "read_file",
    input: { path: "a.txt" },
    callId: "nested-read-1",
  });
};
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/providers/programmatic-tool-dispatch.test.mjs
```

Expected: FAIL because `dispatchTool` is undefined.

- [ ] **Step 3: Add the typed nested-dispatch interface**

Extend the provider runtime types:

```ts
export type NestedToolRequest = {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly callId: string;
};

export type ToolHandlerOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly dispatchTool?: ((request: NestedToolRequest) => Promise<ToolResult>) | undefined;
};
```

Pass definitions into `executeProviderToolAction`. Build `dispatchTool` as a closure that invokes `executeProviderToolDispatches` with one action and converts its single outcome into `{ content, isError }`. Reject a missing outcome and preserve the parent abort signal and trace listener.

```ts
const nestedOptions: ToolHandlerOptions = {
  signal: options.signal,
  dispatchTool: async (request) => {
    const [outcome] = await executeProviderToolDispatches(
      provider,
      [{ tool: request.name, input: request.input, callId: request.callId }],
      definitions,
      handlers,
      cwd,
      traceListener,
      options,
    );
    if (!outcome) throw new Error(`Nested tool produced no outcome: ${request.name}`);
    return { content: outcome.content, ...(outcome.isError ? { isError: true } : {}) };
  },
};
```

- [ ] **Step 4: Run provider tests**

Run:

```bash
npm run test:providers
```

Expected: all provider tests pass, including resource-aware batching and the nested trace contract.

### Task 2: Eval runner and bridge

**Files:**
- Create: `packages/orchestrator/src/eval/types.ts`
- Create: `packages/orchestrator/src/eval/runner-sources.ts`
- Create: `packages/orchestrator/src/eval/runtime.ts`
- Test: `tests/work/eval-runtime.test.mjs`

**Interfaces:**
- Consumes: `ToolHandlerOptions.dispatchTool`, `AbortSignal`, cwd, language, source, timeout.
- Produces: `runEvalProgram(input): Promise<EvalRunResult>`, `detectEvalLanguages()`, and stable metrics.

```ts
export type EvalLanguage = "js" | "py";

export type EvalRunMetrics = {
  language: EvalLanguage;
  durationMs: number;
  startupMs: number;
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  intermediateChars: number;
  returnedChars: number;
  contextReductionRatio: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type EvalRunResult = {
  output: string;
  stderr: string;
  exitCode: number;
  metrics: EvalRunMetrics;
};
```

- [ ] **Step 1: Write failing runtime tests**

Cover these observable contracts in `tests/work/eval-runtime.test.mjs`:

1. JavaScript calls `tool.read_file`, filters the result, and emits only the selected value.
2. Python does the same when `python3` is available; skip only when the probe returns false.
3. `eval` and `ask_user` nested names are rejected.
4. The 51st nested call is rejected.
5. An abort kills a long-running child within three seconds.
6. Output beyond 50 KiB is truncated and marked in metrics.
7. a fixture variable named `UNCLECODE_TEST_SECRET_TOKEN` is absent in the child.

Use a fake `dispatchTool` that returns controlled strings and records requests. Do not call real workspace tools in unit tests.

- [ ] **Step 2: Run runtime tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/eval-runtime.test.mjs
```

Expected: FAIL because the eval runtime modules do not exist.

- [ ] **Step 3: Implement runner source strings**

`runner-sources.ts` exports `JAVASCRIPT_RUNNER_SOURCE` and `PYTHON_RUNNER_SOURCE`.

The JavaScript runner must:

- read one JSON envelope from stdin
- construct an async `tool.<name>(args)` proxy
- POST bridge requests with the bearer token
- expose `display(value)` and a bounded console
- run the supplied source through `AsyncFunction`
- write program output to stdout and errors to stderr

The Python runner must:

- read the same envelope
- construct a synchronous `tool.<name>(dict?, **kwargs)` proxy with `urllib.request`
- expose `display(value)`
- execute compiled source with `json` and `tool` in globals
- print tracebacks to stderr and exit non-zero

- [ ] **Step 4: Implement language detection and environment scrubbing**

`detectEvalLanguages()` always returns `js`; it adds `py` only when `spawnSync("python3", ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)"])` succeeds. Cache the result.

Build the child environment from an allowlist of `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TMP`, `TEMP`, `SYSTEMROOT`, `WINDIR`, and `COMSPEC`, then add the bridge URL and token. Drop every other inherited variable, including all credential-like names.

- [ ] **Step 5: Implement the bounded bridge and child lifecycle**

`runEvalProgram` must:

- validate language availability and timeout
- start an HTTP server on `127.0.0.1` with a random token
- accept only `POST /v1/tool`, bearer auth, JSON bodies below 1 MiB
- reject `eval`, `ask_user`, malformed names, and calls after 50
- queue bridge dispatches with a promise chain
- assign `eval-${runId}-${index}` call IDs
- count intermediate result characters and success/failure outcomes
- spawn `process.execPath` for JS and `python3 -I -S -c <runner>` for Python
- write the input envelope to stdin
- cap stdout and stderr while still draining both streams
- terminate the child on timeout or abort
- close the server in `finally`
- return output, exit status, and metrics

- [ ] **Step 6: Run runtime tests**

Run the focused test from Step 2.

Expected: all runtime contracts pass with Python tests either passing or explicitly skipped because Python is unavailable.

### Task 3: Register the eval tool

**Files:**
- Create: `packages/orchestrator/src/eval/index.ts`
- Modify: `packages/orchestrator/src/tools.ts:1-34,126-299,486-509`
- Modify: `packages/orchestrator/src/index.ts:37`
- Modify: `tests/orchestrator/tool-metadata.test.mjs`
- Test: `tests/work/eval-tool.test.mjs`

**Interfaces:**
- Consumes: `runEvalProgram`, language detection, existing `ToolDefinition` and `ToolHandler` types.
- Produces: `createEvalToolDefinition()`, `createEvalToolHandler()`, and a registered `eval` tool.

- [ ] **Step 1: Write failing schema and gate tests**

Add assertions that `eval` has high-risk, destructive, non-idempotent, open-world metadata, requires confirmation, and owns one opaque `eval:*` execute resource. Add handler tests for the shell gate and a successful JavaScript nested call.

```js
await assert.rejects(
  () => runtime.handlers.eval({ language: "js", code: 'display("x")' }, process.cwd(), { dispatchTool }),
  /UNCLECODE_ALLOW_RUN_SHELL=1/,
);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/tool-metadata.test.mjs tests/work/eval-tool.test.mjs
```

Expected: FAIL because eval is not registered.

- [ ] **Step 3: Implement the eval definition and handler factory**

`createEvalToolDefinition()` advertises detected languages and includes OMP/Hermes-derived guidance: use direct tools for one or two calls; use eval for three or more calls with filtering, loops, branching, or retries. The metadata must be:

```ts
metadata: {
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    riskLevel: "high",
    requiresConfirmation: true,
    reason: "Executes arbitrary JavaScript or Python in the workspace process account.",
  },
  resources: [{
    kind: "eval",
    mode: "execute",
    template: "eval:*",
    declared: false,
  }],
}
```

The handler validates `language`, `code`, `title`, and timeout. It requires `UNCLECODE_ALLOW_RUN_SHELL=1` and `options.dispatchTool`. It returns final output plus a compact JSON metrics footer and sets `isError` on non-zero exit.

- [ ] **Step 4: Integrate without growing tools.ts logic**

Keep eval implementation in `src/eval`. In `createToolRuntime`, create the eval definition and handler after ask-user and web-search handlers, then append them to the returned arrays/maps. Export the eval public types and factory from `src/index.ts`.

Do not place eval in the static `toolHandlers` map because it needs the fully assembled session runtime. Do not let nested dispatch resolve `eval` or `ask_user`.

- [ ] **Step 5: Run orchestrator and work tests**

Run:

```bash
npm run test:orchestrator
npm run test:work
```

Expected: new eval tests pass. Ignore only the documented pre-existing `pwd` checkout-name assertion if it reproduces unchanged.

### Task 4: Deterministic benchmark and smoke path

**Files:**
- Create: `scripts/qa/programmatic-tool-calling-benchmark.mjs`
- Modify: `package.json`
- Test: `tests/performance/programmatic-tool-calling.test.mjs`

**Interfaces:**
- Consumes: `runEvalProgram` and fake deterministic tools.
- Produces: `npm run qa:programmatic-tools` and a JSON report suitable for CI artifacts.

- [ ] **Step 1: Write the failing benchmark contract test**

The test runs the benchmark script with `--iterations 3 --json` and asserts:

- five workloads are present
- success rate is 1
- trace completeness is 1
- blocked-call rejection count is at least 1
- filtering context reduction is at least 0.7
- p50 and p95 are non-negative numbers

- [ ] **Step 2: Run the performance test and verify failure**

Run:

```bash
npm run test:performance -- --test-name-pattern="programmatic tool calling"
```

Expected: FAIL because the benchmark script and npm command do not exist.

- [ ] **Step 3: Implement the benchmark**

Implement direct and programmatic versions of five deterministic workloads from the design spec. Use fake tools and the real eval bridge. Record each run with `performance.now()`. Sort durations and calculate nearest-rank p50/p95. Emit this shape:

```json
{
  "iterations": 3,
  "summary": {
    "successRate": 1,
    "traceCompleteness": 1,
    "blockedRejections": 1
  },
  "workloads": [
    {
      "name": "filter-records",
      "direct": { "p50Ms": 0, "p95Ms": 0, "intermediateChars": 0, "returnedChars": 0 },
      "programmatic": { "p50Ms": 0, "p95Ms": 0, "intermediateChars": 0, "returnedChars": 0, "contextReductionRatio": 0 }
    }
  ]
}
```

Add:

```json
"qa:programmatic-tools": "npm run build --silent && node scripts/qa/programmatic-tool-calling-benchmark.mjs --iterations 20 --json"
```

- [ ] **Step 4: Run the benchmark smoke test**

Run:

```bash
npm run qa:programmatic-tools
```

Expected: exit 0, JSON report, success rate 1, trace completeness 1, filtering context reduction at least 0.7. Record the observed p50/p95 instead of claiming a target.

### Task 5: End-to-end verification and documentation

**Files:**
- Modify: `README.md` in the runtime/tool usage section
- Verify: all files changed by Tasks 1-4

**Interfaces:**
- Consumes: completed eval feature and benchmark output.
- Produces: documented opt-in usage and verification evidence.

- [ ] **Step 1: Smoke the real runtime handler**

Build TypeScript, create a runtime with a fake interaction bridge, set `UNCLECODE_ALLOW_RUN_SHELL=1`, and invoke eval with JavaScript that calls `read_file` three times and prints one selected line. Confirm the final result excludes unprinted intermediate contents.

- [ ] **Step 2: Document the bounded usage contract**

Add one README section with:

- the `UNCLECODE_ALLOW_RUN_SHELL=1` requirement
- direct-call versus eval selection rule
- JavaScript and Python examples
- timeout, output, and call-count limits
- the `npm run qa:programmatic-tools` command
- a statement that eval is arbitrary code execution, not a sandbox

- [ ] **Step 3: Run formatting and focused checks**

Run:

```bash
npm run format
npm run build
npm run check
npm run test:providers
npm run test:orchestrator
npm run test:performance
npm run qa:programmatic-tools
npm run qa:runtime
```

Expected: all new contracts pass. Report any documented pre-existing test failure separately and verify it is unchanged.

- [ ] **Step 4: Run Rust verification when the cross-runtime path is exercised**

Run:

```bash
npm run rust:check
```

Expected: Cargo workspace check passes. No Rust source change is planned, but nested dispatch still calls the Rust provider command path.
