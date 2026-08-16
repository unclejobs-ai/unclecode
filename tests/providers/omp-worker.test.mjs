import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mapOmpUsage,
  OMP_WORKER_DEFAULT_MODEL,
  OMP_WORKER_RESULT_SENTINEL,
  parseOmpModelSelector,
  parseOmpWorkerRequest,
  parseOmpWorkerResultLine,
  runOmpWorkerMain,
  serializeOmpWorkerResult,
  toOmpThinkingLevel,
} from "../../packages/providers/src/omp-worker-entry.ts";
import {
  createOmpWorkerProvider,
  createOmpWorkerRunner,
} from "../../packages/providers/src/omp-worker-provider.ts";

const REASONING_MEDIUM = {
  effort: "medium",
  source: "mode-default",
  support: { status: "supported" },
};

function ompUsage(overrides = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function assistantMessage(overrides = {}) {
  return {
    role: "assistant",
    provider: "kimi-code",
    model: "k3",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    usage: ompUsage(),
    ...overrides,
  };
}

/**
 * Minimal stand-in for the OMP SDK surface the worker drives. Every seam the
 * worker touches is represented, so a test can starve exactly one of them and
 * assert the error code the worker must report.
 */
function fakeOmpRuntime(input = {}) {
  const calls = { sessionOptions: [], prompts: [], settingsCwds: [], disposed: 0, authClosed: 0 };
  const messages = input.messages ?? [assistantMessage()];
  const runtime = {
    calls,
    async createAuthStorage() {
      return {
        close() {
          calls.authClosed += 1;
        },
      };
    },
    createModelRegistry() {
      return {
        find: input.find ?? (() => ({ id: "k3", provider: "kimi-code" })),
        hasConfiguredAuth: input.hasConfiguredAuth ?? (() => true),
      };
    },
    createSessionManager(cwd) {
      return { cwd };
    },
    createSettings(cwd) {
      calls.settingsCwds.push(cwd);
      const values = {
        "retry.modelFallback": false,
        "retry.usageAwareFallback": false,
        "retry.fallbackChains": {},
      };
      return {
        cwd,
        get(path) {
          return values[path];
        },
      };
    },
    async createAgentSession(options) {
      calls.sessionOptions.push(options);
      const listeners = [];
      return {
        session: {
          subscribe(listener) {
            listeners.push(listener);
            return () => {};
          },
          async prompt(text) {
            calls.prompts.push(text);
            for (const message of messages) {
              for (const listener of listeners) {
                listener({ type: "message_end", message });
              }
            }
            return true;
          },
          getLastAssistantMessage() {
            return messages.at(-1);
          },
          async dispose() {
            calls.disposed += 1;
          },
        },
      };
    },
  };
  return runtime;
}

function workerRequest(overrides = {}) {
  return {
    prompt: "ship the feature",
    cwd: "/tmp/workspace",
    model: OMP_WORKER_DEFAULT_MODEL,
    reasoning: "medium",
    ...overrides,
  };
}

test("parseOmpWorkerRequest accepts the shared worker request shape", () => {
  assert.deepEqual(
    parseOmpWorkerRequest(JSON.stringify(workerRequest())),
    {
      prompt: "ship the feature",
      cwd: "/tmp/workspace",
      model: "kimi-code/k3",
      reasoning: "medium",
    },
  );
});

test("parseOmpWorkerRequest rejects malformed requests with OMP_PROTOCOL_ERROR", () => {
  const rejected = [
    "not json",
    JSON.stringify([]),
    JSON.stringify(workerRequest({ prompt: 12 })),
    JSON.stringify(workerRequest({ cwd: "" })),
    JSON.stringify(workerRequest({ model: "   " })),
    JSON.stringify(workerRequest({ reasoning: undefined })),
  ];
  for (const raw of rejected) {
    assert.throws(
      () => parseOmpWorkerRequest(raw),
      (error) => error.code === "OMP_PROTOCOL_ERROR",
      `expected OMP_PROTOCOL_ERROR for ${raw}`,
    );
  }
});

test("parseOmpModelSelector splits provider from model id on the first slash", () => {
  assert.deepEqual(parseOmpModelSelector("kimi-code/k3"), {
    providerId: "kimi-code",
    modelId: "k3",
  });
  assert.deepEqual(parseOmpModelSelector(" groq/openai/gpt-oss-20b "), {
    providerId: "groq",
    modelId: "openai/gpt-oss-20b",
  });
});

test("parseOmpModelSelector reports unusable selectors as OMP_MODEL_UNAVAILABLE", () => {
  for (const selector of ["k3", "/k3", "kimi-code/", ""]) {
    assert.throws(
      () => parseOmpModelSelector(selector),
      (error) => error.code === "OMP_MODEL_UNAVAILABLE",
      `expected OMP_MODEL_UNAVAILABLE for "${selector}"`,
    );
  }
});

test("toOmpThinkingLevel maps every UncleCode reasoning effort onto an OMP level", () => {
  assert.equal(toOmpThinkingLevel("none"), "off");
  assert.equal(toOmpThinkingLevel("unsupported"), "off");
  assert.equal(toOmpThinkingLevel("low"), "low");
  assert.equal(toOmpThinkingLevel("medium"), "medium");
  assert.equal(toOmpThinkingLevel("high"), "high");
  assert.equal(toOmpThinkingLevel("xhigh"), "xhigh");
  assert.equal(toOmpThinkingLevel("max"), "max");
  assert.throws(
    () => toOmpThinkingLevel("turbo"),
    (error) => error.code === "OMP_PROTOCOL_ERROR",
  );
});

test("mapOmpUsage folds every cache bucket across an OMP tool loop", () => {
  assert.deepEqual(
    mapOmpUsage([
      ompUsage({
        input: 16346,
        output: 36,
        cacheRead: 4352,
        cacheWrite: 128,
        cost: { total: 0.5 },
      }),
      ompUsage({
        input: 12,
        output: 400,
        cacheRead: 20000,
        cacheWrite: 0,
        cost: { total: 0.25 },
      }),
    ]),
    {
      inputTokens: 16358,
      outputTokens: 436,
      cacheReadTokens: 24352,
      cacheWriteTokens: 128,
      costUsd: 0.75,
    },
  );
});

test("mapOmpUsage clamps missing and nonsensical provider counters to zero", () => {
  assert.deepEqual(
    mapOmpUsage([
      { input: -5, output: Number.NaN, cacheRead: undefined, cost: { total: -1 } },
      {},
    ]),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
  );
});

test("worker result lines survive unrelated OMP stdout noise", () => {
  const success = {
    ok: true,
    result: {
      text: "done",
      provider: "kimi-code",
      model: "kimi-code/k3",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.5,
      },
    },
  };
  const stdout = [
    "some banner OMP printed",
    JSON.stringify({ type: "message_start" }),
    serializeOmpWorkerResult(success).trimEnd(),
    "",
  ].join("\n");

  assert.deepEqual(parseOmpWorkerResultLine(stdout), success);
});

test("a stdout stream without the worker sentinel is a protocol error", () => {
  assert.throws(
    () => parseOmpWorkerResultLine("nothing useful here\n"),
    (error) => error.code === "OMP_PROTOCOL_ERROR",
  );
  assert.throws(
    () => parseOmpWorkerResultLine(`${OMP_WORKER_RESULT_SENTINEL} {broken`),
    (error) => error.code === "OMP_PROTOCOL_ERROR",
  );
  assert.throws(
    () => parseOmpWorkerResultLine(`${OMP_WORKER_RESULT_SENTINEL} {"ok":false,"error":{"code":"NOPE","message":"x"}}`),
    (error) => error.code === "OMP_PROTOCOL_ERROR",
  );
});

test("runOmpWorkerMain returns the final assistant text with summed cache usage", async () => {
  const runtime = fakeOmpRuntime({
    messages: [
      assistantMessage({
        content: [{ type: "text", text: "step one" }],
        usage: ompUsage({ input: 16346, cacheRead: 4352, output: 36, cost: { total: 0.01 } }),
      }),
      assistantMessage({
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "final answer" },
        ],
        usage: ompUsage({ input: 10, cacheRead: 20000, cacheWrite: 64, output: 400, cost: { total: 0.02 } }),
      }),
    ],
  });

  const line = await runOmpWorkerMain({
    stdin: JSON.stringify(workerRequest()),
    loadRuntime: async () => runtime,
  });

  assert.deepEqual(parseOmpWorkerResultLine(line), {
    ok: true,
    result: {
      text: "final answer",
      provider: "kimi-code",
      model: "kimi-code/k3",
      usage: {
        inputTokens: 16356,
        outputTokens: 436,
        cacheReadTokens: 24352,
        cacheWriteTokens: 64,
        costUsd: 0.03,
      },
    },
  });
  assert.equal(runtime.calls.disposed, 1);
  assert.equal(runtime.calls.authClosed, 1);
});

test("runOmpWorkerMain drives OMP's own tool loop with an isolated in-memory session", async () => {
  const runtime = fakeOmpRuntime();
  await runOmpWorkerMain({
    stdin: JSON.stringify(workerRequest({ cwd: "/tmp/repo", reasoning: "max" })),
    loadRuntime: async () => runtime,
  });

  const options = runtime.calls.sessionOptions[0];
  assert.equal(options.cwd, "/tmp/repo");
  assert.equal(options.enableMCP, false);
  assert.equal(options.disableExtensionDiscovery, true);
  assert.equal(options.autoApprove, true);
  assert.deepEqual(options.skills, []);
  assert.equal(options.thinkingLevel, "max");
  assert.deepEqual(options.sessionManager, { cwd: "/tmp/repo" });
  assert.deepEqual(runtime.calls.prompts, ["ship the feature"]);
  assert.deepEqual(runtime.calls.settingsCwds, ["/tmp/repo"]);
  assert.equal(options.settings.get("retry.modelFallback"), false);
  assert.equal(options.settings.get("retry.usageAwareFallback"), false);
  assert.deepEqual(options.settings.get("retry.fallbackChains"), {});
});

test("runOmpWorkerMain reports a missing OMP install as OMP_UNAVAILABLE", async () => {
  const line = await runOmpWorkerMain({
    stdin: JSON.stringify(workerRequest()),
    loadRuntime: async () => {
      throw new Error("omp is not installed");
    },
  });

  const parsed = parseOmpWorkerResultLine(line);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "OMP_UNAVAILABLE");
  assert.match(parsed.error.message, /omp is not installed/);
});

test("runOmpWorkerMain reports an unknown selector as OMP_MODEL_UNAVAILABLE", async () => {
  const line = await runOmpWorkerMain({
    stdin: JSON.stringify(workerRequest({ model: "kimi-code/k9" })),
    loadRuntime: async () => fakeOmpRuntime({ find: () => undefined }),
  });

  const parsed = parseOmpWorkerResultLine(line);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "OMP_MODEL_UNAVAILABLE");
  assert.match(parsed.error.message, /kimi-code\/k9/);
});

test("runOmpWorkerMain reports missing credentials as OMP_AUTH_REQUIRED without naming a fallback", async () => {
  const runtime = fakeOmpRuntime({ hasConfiguredAuth: () => false });
  const line = await runOmpWorkerMain({
    stdin: JSON.stringify(workerRequest()),
    loadRuntime: async () => runtime,
  });

  const parsed = parseOmpWorkerResultLine(line);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "OMP_AUTH_REQUIRED");
  assert.match(parsed.error.message, /kimi-code/);
  assert.equal(runtime.calls.sessionOptions.length, 0);
  assert.equal(runtime.calls.authClosed, 1);
});

test("runOmpWorkerMain surfaces a failed OMP turn as OMP_TURN_FAILED", async () => {
  const line = await runOmpWorkerMain({
    stdin: JSON.stringify(workerRequest()),
    loadRuntime: async () => fakeOmpRuntime({
      messages: [
        assistantMessage({
          stopReason: "error",
          errorMessage: "upstream 529",
          content: [],
        }),
      ],
    }),
  });

  const parsed = parseOmpWorkerResultLine(line);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "OMP_TURN_FAILED");
  assert.match(parsed.error.message, /upstream 529/);
});

test("the work executor is pinned to Kimi k3 and reads no model from the environment", async () => {
  assert.equal(OMP_WORKER_DEFAULT_MODEL, "kimi-code/k3");

  const requests = [];
  const provider = createOmpWorkerProvider({
    cwd: "/tmp/repo",
    reasoning: REASONING_MEDIUM,
    // The retired `UNCLECODE_OMP_WORKER_MODEL` override must stay inert: the
    // work/executor route is fixed by contract, not by operator environment.
    env: { UNCLECODE_OMP_WORKER_MODEL: "zai/glm-5" },
    runWorker: async ({ request }) => {
      requests.push(request);
      return { ok: true, result: { text: "ok", provider: "kimi-code", model: request.model } };
    },
  });

  await provider.runTurn("route me");

  assert.deepEqual(requests.map((request) => request.model), [OMP_WORKER_DEFAULT_MODEL]);
});

test("the OMP provider maps worker usage onto UncleCode's disjoint cache buckets", async () => {
  const requests = [];
  const provider = createOmpWorkerProvider({
    cwd: "/tmp/repo",
    reasoning: REASONING_MEDIUM,
    env: {},
    runWorker: async ({ request }) => {
      requests.push(request);
      return {
        ok: true,
        result: {
          text: "executor answer",
          provider: "kimi-code",
          model: "kimi-code/k3",
          usage: {
            inputTokens: 16346,
            outputTokens: 36,
            cacheReadTokens: 4352,
            cacheWriteTokens: 128,
            costUsd: 0.0125,
          },
        },
      };
    },
  });

  assert.deepEqual(await provider.runTurn("do the work"), {
    text: "executor answer",
    usage: {
      inputTokens: 16346,
      outputTokens: 36,
      cacheReadTokens: 4352,
      cacheWriteTokens: 128,
    },
    costUsd: 0.0125,
  });
  assert.deepEqual(requests, [{
    prompt: "do the work",
    cwd: "/tmp/repo",
    model: "kimi-code/k3",
    reasoning: "medium",
  }]);
});

test("the OMP provider omits usage and cost when OMP reported none", async () => {
  const provider = createOmpWorkerProvider({
    cwd: "/tmp/repo",
    reasoning: REASONING_MEDIUM,
    env: {},
    runWorker: async () => ({
      ok: true,
      result: { text: "quiet", provider: "kimi-code", model: "kimi-code/k3" },
    }),
  });

  assert.deepEqual(await provider.runTurn("hello"), { text: "quiet" });
});

test("the OMP provider rethrows every stable worker error code and never retries elsewhere", async () => {
  for (const code of [
    "OMP_UNAVAILABLE",
    "OMP_AUTH_REQUIRED",
    "OMP_MODEL_UNAVAILABLE",
    "OMP_TURN_FAILED",
    "OMP_PROTOCOL_ERROR",
  ]) {
    const attempts = [];
    const provider = createOmpWorkerProvider({
      cwd: "/tmp/repo",
      reasoning: REASONING_MEDIUM,
      env: {},
      runWorker: async ({ request }) => {
        attempts.push(request.model);
        return { ok: false, error: { code, message: `${code} happened` } };
      },
    });

    await assert.rejects(
      () => provider.runTurn("do the work"),
      (error) => error.code === code && /happened/.test(error.message),
    );
    assert.deepEqual(attempts, ["kimi-code/k3"], "the executor must not retry on another provider");
  }
});

test("the OMP provider refuses attachments instead of silently dropping them", async () => {
  let invoked = 0;
  const provider = createOmpWorkerProvider({
    cwd: "/tmp/repo",
    reasoning: REASONING_MEDIUM,
    env: {},
    runWorker: async () => {
      invoked += 1;
      return { ok: true, result: { text: "", provider: "kimi-code", model: "kimi-code/k3" } };
    },
  });

  await assert.rejects(
    () => provider.runTurn("look", [{ type: "image", mimeType: "image/png", data: "AAA" }]),
    (error) => error.code === "OMP_PROTOCOL_ERROR",
  );
  assert.equal(invoked, 0);
});

test("updateRuntimeSettings retargets reasoning and can never re-route the pinned model", async () => {
  const requests = [];
  const provider = createOmpWorkerProvider({
    cwd: "/tmp/repo",
    reasoning: REASONING_MEDIUM,
    env: {},
    runWorker: async ({ request }) => {
      requests.push(request);
      return { ok: true, result: { text: "ok", provider: "kimi-code", model: request.model } };
    },
  });

  await provider.runTurn("first");
  // WorkAgent forwards shell-wide runtime settings straight to its executors,
  // so a model switch made anywhere else must die at this seam rather than
  // silently moving an executor turn onto another OMP selector.
  provider.updateRuntimeSettings({
    model: "  zai/glm-5  ",
    reasoning: { ...REASONING_MEDIUM, effort: "max" },
  });
  await provider.runTurn("second");
  provider.updateRuntimeSettings({ model: "anthropic/claude-opus-5" });
  provider.updateRuntimeSettings({});
  await provider.runTurn("third");

  assert.deepEqual(
    requests.map((request) => [request.model, request.reasoning]),
    [
      [OMP_WORKER_DEFAULT_MODEL, "medium"],
      [OMP_WORKER_DEFAULT_MODEL, "max"],
      [OMP_WORKER_DEFAULT_MODEL, "max"],
    ],
  );
});

test("the OMP provider never exposes an auth-token seam: OMP owns credential lookup", () => {
  const provider = createOmpWorkerProvider({
    cwd: "/tmp/repo",
    reasoning: REASONING_MEDIUM,
    env: {},
    runWorker: async () => ({ ok: true, result: { text: "", provider: "kimi-code", model: "kimi-code/k3" } }),
  });

  assert.equal(provider.updateAuthToken, undefined);
});

test("a missing Bun boundary is reported as OMP_UNAVAILABLE, not a fallback", async () => {
  const runWorker = createOmpWorkerRunner({
    env: {},
    bunPath: path.join(tmpdir(), "unclecode-omp-missing-bun"),
    workerEntryPath: path.join(tmpdir(), "unclecode-omp-missing-entry.ts"),
  });

  const result = await runWorker({
    request: workerRequest({ cwd: tmpdir() }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "OMP_UNAVAILABLE");
});

test("aborting a turn kills the Bun worker child instead of waiting it out", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "unclecode-omp-abort-"));
  try {
    // `node` stands in for `bun` so the abort path is exercised end to end
    // through the real child-process transport without needing an OMP install.
    const entryPath = path.join(workspace, "sleeping-worker.mjs");
    writeFileSync(
      entryPath,
      "process.stdin.resume();\nsetTimeout(() => {}, 60_000);\n",
      "utf8",
    );
    const provider = createOmpWorkerProvider({
      cwd: workspace,
      reasoning: REASONING_MEDIUM,
      env: {},
      bunPath: process.execPath,
      workerEntryPath: entryPath,
    });

    const controller = new AbortController();
    const pending = provider.runTurn("hang forever", [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, (error) => error.name === "AbortError");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an already-aborted signal short-circuits before any worker spawn", async () => {
  let invoked = 0;
  const provider = createOmpWorkerProvider({
    cwd: "/tmp/repo",
    reasoning: REASONING_MEDIUM,
    env: {},
    runWorker: async () => {
      invoked += 1;
      return { ok: true, result: { text: "", provider: "kimi-code", model: "kimi-code/k3" } };
    },
  });

  await assert.rejects(
    () => provider.runTurn("nope", [], { signal: AbortSignal.abort() }),
    (error) => error.name === "AbortError",
  );
  assert.equal(invoked, 0);
});

const POSIX_PROCESS_GROUPS = process.platform === "win32"
  ? "process groups are POSIX-only"
  : false;

/** Promise handle so every cancellation wait below is an event, not a poll. */
function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Liveness bus for a fake worker tree. Every stand-in process announces
 * `<label> <pid>` on a unix socket and may append further lines; the socket
 * closing *is* that process dying. Both are real events, so the cancellation
 * tests below can wait on transitions instead of sleeping and hoping.
 */
function startProcessHarness(socketPath) {
  const slots = new Map();
  const sockets = new Set();
  const slotFor = (label) => {
    let slot = slots.get(label);
    if (!slot) {
      const startedGate = deferred();
      const closedGate = deferred();
      slot = {
        startedGate,
        closedGate,
        entry: { pid: 0, notes: [], closed: closedGate.promise },
      };
      slots.set(label, slot);
    }
    return slot;
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let slot;
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (slot) {
          slot.entry.notes.push(line);
          continue;
        }
        const [label, pid] = line.split(" ");
        slot = slotFor(label);
        slot.entry.pid = Number(pid);
        slot.startedGate.resolve(slot.entry);
      }
    });
    // SIGKILLing a peer resets its connection; that reset is the signal this
    // harness is here to observe, so it must not surface as a stream throw.
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      slot?.closedGate.resolve();
    });
  });

  return {
    listening: new Promise((resolve) => server.listen(socketPath, resolve)),
    started: (label) => slotFor(label).startedGate.promise,
    async stop() {
      for (const slot of slots.values()) {
        if (slot.entry.pid > 0) {
          try {
            process.kill(slot.entry.pid, "SIGKILL");
          } catch {
            // Already gone, which is exactly what the test asserted.
          }
        }
      }
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function stubbornWorkerSource(socketPath) {
  return [
    'import { connect } from "node:net";',
    `const socket = connect(${JSON.stringify(socketPath)});`,
    'socket.on("error", () => {});',
    'socket.on("connect", () => socket.write("worker " + process.pid + "\\n"));',
    // Swallowing SIGTERM is the whole point: only the SIGKILL escalation can
    // end this worker, the way a wedged OMP tool loop would behave.
    'process.on("SIGTERM", () => socket.write("sigterm\\n"));',
    "process.stdin.resume();",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

function toolSpawningWorkerSource(socketPath, toolPath) {
  return [
    'import { spawn } from "node:child_process";',
    'import { connect } from "node:net";',
    `const socket = connect(${JSON.stringify(socketPath)});`,
    'socket.on("error", () => {});',
    'socket.on("connect", () => socket.write("worker " + process.pid + "\\n"));',
    // `stdio: "ignore"` cuts the descendant loose from the worker's pipes, so
    // it outlives a lone `child.kill()` exactly like an OMP tool child.
    `spawn(process.execPath, [${JSON.stringify(toolPath)}], { stdio: "ignore" });`,
    "process.stdin.resume();",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

function toolSource(socketPath) {
  return [
    'import { connect } from "node:net";',
    `const socket = connect(${JSON.stringify(socketPath)});`,
    'socket.on("error", () => {});',
    'socket.on("connect", () => socket.write("tool " + process.pid + "\\n"));',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

/**
 * Claim the turn's rejection the moment it exists. These tests wait on process
 * events before asserting, and a turn that rejects during that window would
 * otherwise register as an unhandled rejection with the test runner.
 */
function captureTurnFailure(turn) {
  return turn.then(
    (value) => {
      throw new Error(`expected the cancelled turn to reject, got ${JSON.stringify(value)}`);
    },
    (error) => error,
  );
}

test("a cancellation that lands before the abort listener is attached still kills the worker", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-omp-race-"));
  try {
    const entryPath = path.join(workspace, "worker.mjs");
    writeFileSync(entryPath, "process.stdin.resume();\nsetInterval(() => {}, 1000);\n", "utf8");
    const runWorker = createOmpWorkerRunner({
      env: {},
      bunPath: process.execPath,
      workerEntryPath: entryPath,
      forceKillDelayMs: 250,
    });

    // An already-aborted signal is precisely the state the transport sees when
    // cancellation lands between the provider's pre-flight check and the
    // listener registration: `addEventListener` never fires for it, so only the
    // post-registration recheck can reach the worker. Without that recheck this
    // never settles, because the stand-in worker sleeps forever.
    const result = await runWorker({
      request: workerRequest({ cwd: workspace }),
      signal: AbortSignal.abort(),
    });

    assert.equal(result.ok, false);
    // Only the child's `close` handler can produce this code, so reaching it
    // proves the worker actually exited rather than being left running.
    assert.equal(result.error.code, "OMP_PROTOCOL_ERROR");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a cancelled worker that ignores SIGTERM is escalated to SIGKILL", { skip: POSIX_PROCESS_GROUPS }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-omp-kill-"));
  const socketPath = path.join(workspace, "s");
  const harness = startProcessHarness(socketPath);
  try {
    await harness.listening;
    const entryPath = path.join(workspace, "worker.mjs");
    writeFileSync(entryPath, stubbornWorkerSource(socketPath), "utf8");
    const provider = createOmpWorkerProvider({
      cwd: workspace,
      reasoning: REASONING_MEDIUM,
      env: {},
      runWorker: createOmpWorkerRunner({
        env: {},
        bunPath: process.execPath,
        workerEntryPath: entryPath,
        forceKillDelayMs: 250,
      }),
    });

    const controller = new AbortController();
    const aborted = captureTurnFailure(
      provider.runTurn("wedge the tool loop", [], { signal: controller.signal }),
    );
    const worker = await harness.started("worker");
    controller.abort();
    await worker.closed;

    assert.equal((await aborted).name, "AbortError");
    assert.deepEqual(worker.notes, ["sigterm"]);
  } finally {
    await harness.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cancelling a turn takes OMP's tool descendants down with the worker", { skip: POSIX_PROCESS_GROUPS }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-omp-tree-"));
  const socketPath = path.join(workspace, "s");
  const harness = startProcessHarness(socketPath);
  try {
    await harness.listening;
    const entryPath = path.join(workspace, "worker.mjs");
    const toolPath = path.join(workspace, "tool.mjs");
    writeFileSync(toolPath, toolSource(socketPath), "utf8");
    writeFileSync(entryPath, toolSpawningWorkerSource(socketPath, toolPath), "utf8");
    const provider = createOmpWorkerProvider({
      cwd: workspace,
      reasoning: REASONING_MEDIUM,
      env: {},
      runWorker: createOmpWorkerRunner({
        env: {},
        bunPath: process.execPath,
        workerEntryPath: entryPath,
        forceKillDelayMs: 250,
      }),
    });

    const controller = new AbortController();
    const aborted = captureTurnFailure(
      provider.runTurn("run a tool", [], { signal: controller.signal }),
    );
    const [worker, tool] = await Promise.all([
      harness.started("worker"),
      harness.started("tool"),
    ]);
    assert.notEqual(worker.pid, tool.pid);

    controller.abort();

    // Signalling the Bun child alone would reparent the tool to init and leave
    // it running, so this wait only completes if the whole group was signalled.
    await Promise.all([worker.closed, tool.closed]);
    assert.equal((await aborted).name, "AbortError");
  } finally {
    await harness.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a worker that exits mid-write reports its own exit, not a broken request pipe", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "uc-omp-epipe-"));
  try {
    const entryPath = path.join(workspace, "worker.mjs");
    // Exits without ever reading stdin, so the request write breaks against a
    // dead pipe as soon as the kernel's 64 KiB buffer fills.
    writeFileSync(entryPath, "process.exit(3);\n", "utf8");
    const runWorker = createOmpWorkerRunner({
      env: {},
      bunPath: process.execPath,
      workerEntryPath: entryPath,
    });

    const result = await runWorker({
      request: workerRequest({ cwd: workspace, prompt: "x".repeat(4 * 1024 * 1024) }),
    });

    assert.equal(result.ok, false);
    // The EPIPE is the worker's exit surfacing on the request pipe, not a
    // transport fault, so the turn must carry the `close`-derived code instead
    // of being masked as OMP_UNAVAILABLE.
    assert.equal(result.error.code, "OMP_PROTOCOL_ERROR");
    assert.match(result.error.message, /bun exit 3/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
