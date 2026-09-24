import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ToolDefinition, ToolResult, ToolRuntime } from "./tools.js";
import type { ToolExecutionRequest } from "./tool-executor.js";

export const RUN_CODE_TOOL_NAME = "run_code";

const RUN_CODE_TIMEOUT_MS = 120_000;
const RUN_CODE_MAX_TOOL_CALLS = 200;
const RUN_CODE_OUTPUT_LIMIT = 20_000;
// A blocking prompt from inside a script is not a conversation; the model asks directly.
const CODE_MODE_EXCLUDED_TOOLS = new Set(["ask_user", RUN_CODE_TOOL_NAME]);
// Node's permission model has no network switch; on macOS the OS sandbox denies it.
const DARWIN_NETWORK_DENY_PROFILE = "(version 1)(allow default)(deny network*)";

/**
 * Runs inside `node --permission` with no grants (no fs, no child processes), from `-e`
 * so it needs no file read. The model's code runs as an async function body in a vm
 * context whose only way out is `tools.*`, answered by the host over IPC.
 */
const RUNNER_SOURCE = String.raw`
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const send = process.send.bind(process);
delete process.send;
const pending = new Map();
let nextId = 0;
const logs = [];
const format = (value) => typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
const callTool = (name, input) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  send({ type: "call", id, name, input: input === undefined ? {} : JSON.parse(JSON.stringify(input)) });
});
process.on("message", (message) => {
  if (message.type === "result") {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.isError) waiter.reject(new Error(message.content));
    else waiter.resolve(message.content);
    return;
  }
  if (message.type !== "run") return;
  // Every name reaches the host, which alone decides what is callable.
  const tools = new Proxy({}, { get: (_target, name) => typeof name === "string" ? (input) => callTool(name, input) : undefined });
  const console = { log: (...args) => logs.push(args.map(format).join(" ")) };
  console.error = console.log;
  console.warn = console.log;
  // Globals, not parameters: code that declares its own "tools" shadows instead of failing.
  const context = vm.createContext({ tools, console });
  Promise.resolve()
    .then(() => vm.runInContext(stripTypeScriptTypes("(async () => {\n" + message.code + "\n})"), context, { timeout: 5000 })())
    .then(
      (value) => send({ type: "done", value: value === undefined ? null : JSON.parse(JSON.stringify(value)), logs }),
      (error) => send({ type: "done", error: error instanceof Error ? error.message : String(error), logs }),
    );
});
`;

/** One tool call made by run_code's code, reported so traces and quality gates see it. */
export type CodeModeNestedCall =
  | {
    readonly phase: "started";
    readonly callId: string;
    readonly toolName: string;
    readonly input: Record<string, unknown>;
    readonly startedAt: number;
  }
  | {
    readonly phase: "completed";
    readonly callId: string;
    readonly toolName: string;
    readonly input: Record<string, unknown>;
    readonly startedAt: number;
    readonly completedAt: number;
    readonly isError: boolean;
    readonly output: string;
  };

type CodeModeOptions = {
  readonly timeoutMs?: number;
  readonly onNestedCall?: (call: CodeModeNestedCall) => void;
};

type RunnerMessage =
  | { readonly type: "call"; readonly id: number; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: "done"; readonly value?: unknown; readonly error?: string; readonly logs: readonly string[] };

function isRunnerMessage(value: unknown): value is RunnerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "call" || type === "done";
}

function schemaToTs(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "unknown";
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `Array<${schemaToTs(node.items)}>`;
    case "object": {
      const properties = typeof node.properties === "object" && node.properties !== null
        ? Object.entries(node.properties as Record<string, unknown>)
        : [];
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      if (properties.length === 0) return "Record<string, unknown>";
      return `{ ${properties.map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${schemaToTs(value)}`).join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

function describeRunCode(tools: readonly ToolDefinition[]): string {
  const api = tools
    .map((tool) => `  /** ${tool.description.replace(/\*\//g, "* /").split("\n")[0]} */\n  ${tool.name}(input: ${schemaToTs(tool.input_schema)}): Promise<string>;`)
    .join("\n");
  return [
    "Run code that calls the other tools programmatically and returns only what matters.",
    "Prefer this over run_shell and over a sequence of individual tool calls whenever a task needs",
    "more than two calls (loops over files, chained lookups, counting, filtering or aggregating",
    "output): one run_code call replaces the round-trips, and intermediate output stays out of the",
    "conversation. Example:",
    "  const names = (await tools.list_files({ path: \".\" })).split(\"\\n\")",
    "    .filter((line) => line.startsWith(\"file \")).map((line) => line.slice(5));",
    "  const texts = await Promise.all(names.map((path) => tools.read_file({ path })));",
    "  return texts.map((t, i) => ({ file: names[i], chars: t.length }));",
    "`code` is the body of an async function (JavaScript or TypeScript): use await, and `return` a",
    "JSON-serializable value. `tools` is already in scope; do not redeclare it.",
    "Each call returns the tool's text output and throws on a tool error. console.log is captured.",
    "The code has no filesystem, network, or process access of its own; only these tools:",
    "declare const tools: {",
    api,
    "};",
  ].join("\n");
}

function runCodeDefinition(tools: readonly ToolDefinition[]): ToolDefinition {
  return {
    name: RUN_CODE_TOOL_NAME,
    description: describeRunCode(tools),
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Async function body (JavaScript) that calls tools.* and returns a result." },
      },
      required: ["code"],
    },
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        riskLevel: "medium",
      },
      resources: [],
    },
  };
}

function spawnRunner(): ReturnType<typeof spawn> {
  const nodeArgs = ["--permission", "--max-old-space-size=256", "--disable-warning=ExperimentalWarning", "-e", RUNNER_SOURCE];
  const [command, args] = process.platform === "darwin"
    ? ["/usr/bin/sandbox-exec", ["-p", DARWIN_NETWORK_DENY_PROFILE, process.execPath, ...nodeArgs]]
    : [process.execPath, nodeArgs];
  // Only PATH crosses: the owner's env carries provider keys.
  return spawn(command, args, { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
}

function formatResult(done: Extract<RunnerMessage, { type: "done" }>, callCounts: Map<string, number>): ToolResult {
  const sections = [done.error === undefined ? JSON.stringify(done.value, null, 2) : `Error: ${done.error}`];
  if (done.logs.length > 0) sections.push(`console:\n${done.logs.join("\n")}`);
  const summary = [...callCounts].map(([name, count]) => `${name} ×${count}`).join(", ");
  sections.push(`(tool calls: ${summary || "none"})`);
  let content = sections.join("\n\n");
  if (content.length > RUN_CODE_OUTPUT_LIMIT) {
    content = `${content.slice(0, RUN_CODE_OUTPUT_LIMIT)}\n… truncated ${content.length - RUN_CODE_OUTPUT_LIMIT} chars; return less.`;
  }
  return done.error === undefined ? { content } : { isError: true, content };
}

async function runCode(
  inner: ToolRuntime,
  request: ToolExecutionRequest,
  options: CodeModeOptions & { readonly timeoutMs: number },
): Promise<ToolResult> {
  const { timeoutMs, onNestedCall } = options;
  const runId = randomUUID().slice(0, 8);
  const code = request.input.code;
  if (typeof code !== "string" || code.trim().length === 0) {
    return { isError: true, content: "run_code needs a non-empty `code` string." };
  }
  const callable = inner.definitions.filter((tool) => !CODE_MODE_EXCLUDED_TOOLS.has(tool.name));
  const callableNames = new Set(callable.map((tool) => tool.name));
  const callCounts = new Map<string, number>();
  let totalCalls = 0;
  const child = spawnRunner();
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });

  return await new Promise<ToolResult>((resolve) => {
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ isError: true, content: `run_code stopped at the ${Math.round(timeoutMs / 1000)} s time limit.` }),
      timeoutMs,
    );
    const onAbort = () => finish({ isError: true, content: "run_code was cancelled." });
    request.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => finish({ isError: true, content: `run_code could not start its sandbox: ${error.message}` }));
    child.on("exit", (exitCode, signal) => finish({
      isError: true,
      content: `run_code sandbox exited early (${exitCode ?? signal}).${stderr ? `\n${stderr.trim()}` : ""}`,
    }));
    child.on("message", (message: unknown) => {
      if (!isRunnerMessage(message)) return;
      if (message.type === "done") {
        finish(formatResult(message, callCounts));
        return;
      }
      const reply = (result: ToolResult) => {
        if (!settled) child.send({ type: "result", id: message.id, isError: result.isError ?? false, content: result.content });
      };
      if (!callableNames.has(message.name)) {
        reply({ isError: true, content: `${message.name} is not available in run_code.` });
        return;
      }
      if (++totalCalls > RUN_CODE_MAX_TOOL_CALLS) {
        reply({ isError: true, content: `run_code is limited to ${RUN_CODE_MAX_TOOL_CALLS} tool calls.` });
        return;
      }
      callCounts.set(message.name, (callCounts.get(message.name) ?? 0) + 1);
      const call = { callId: `run_code:${runId}:${totalCalls}`, toolName: message.name, input: message.input, startedAt: Date.now() };
      onNestedCall?.({ phase: "started", ...call });
      inner.executor
        .execute({ toolName: message.name, input: message.input, cwd: request.cwd, signal: request.signal })
        .then(
          (result) => result,
          (error: unknown): ToolResult => ({ isError: true, content: error instanceof Error ? error.message : String(error) }),
        )
        .then((result) => {
          onNestedCall?.({ phase: "completed", ...call, completedAt: Date.now(), isError: result.isError ?? false, output: result.content });
          reply(result);
        });
    });
    child.send({ type: "run", code });
  });
}

/**
 * Code Mode: adds `run_code`, which runs model-written JavaScript against the other tools
 * as a typed API. Every nested call goes through `inner.executor`, so the policy gate,
 * permission rules, and approvals are unchanged; only the code's result reaches the model.
 */
export function createCodeModeToolRuntime(inner: ToolRuntime, options: CodeModeOptions = {}): ToolRuntime {
  const runOptions = { ...options, timeoutMs: options.timeoutMs ?? RUN_CODE_TIMEOUT_MS };
  const callable = inner.definitions.filter((tool) => !CODE_MODE_EXCLUDED_TOOLS.has(tool.name));
  return {
    // First, so models weigh it before reaching for individual calls.
    definitions: [runCodeDefinition(callable), ...inner.definitions],
    executor: {
      execute: (request) => request.toolName === RUN_CODE_TOOL_NAME
        ? runCode(inner, request, runOptions)
        : inner.executor.execute(request),
    },
  };
}
