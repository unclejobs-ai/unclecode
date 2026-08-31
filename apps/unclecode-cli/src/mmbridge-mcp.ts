import { loadMcpHostRegistry } from "@unclecode/mcp-host";
import type { McpServerConfig } from "@unclecode/contracts";
import {
  createOwnedProcessGroupController,
  type OwnedProcessGroupController,
} from "@unclecode/orchestrator/process-group-settlement";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2025-11-25";

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code?: number; message?: string };
  readonly method?: string;
  readonly params?: Record<string, unknown>;
};

function encodeFrame(message: JsonRpcRequest): string {
  return `${JSON.stringify(message)}\n`;
}

function extractTextContent(result: Record<string, unknown> | undefined): readonly string[] {
  const content = Array.isArray(result?.content) ? result.content : [];
  const lines: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
      lines.push(...item.text.split("\n"));
    }
  }
  return lines.length > 0 ? lines : [JSON.stringify(result ?? {}, null, 2)];
}

function formatNotificationLine(message: JsonRpcResponse): string | null {
  if (message.method !== "notifications/message") {
    return null;
  }
  const params = message.params ?? {};
  const level = typeof params.level === "string" ? params.level.toUpperCase() : "INFO";
  const data = typeof params.data === "string" ? params.data : JSON.stringify(params.data ?? "");
  return `[${level}] ${data}`;
}

function resolveMmbridgeServerConfig(input: {
  workspaceRoot: string;
  userHomeDir?: string;
}): Extract<McpServerConfig, { type: "stdio" }> {
  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const entry = registry.byName.get("mmbridge");
  if (!entry) {
    throw new Error("mmbridge MCP server is not configured. Add it to .mcp.json or ~/.unclecode/mcp.json.");
  }
  if (entry.config.type !== "stdio") {
    throw new Error(`mmbridge MCP transport ${entry.config.type} is not supported yet. Use stdio.`);
  }
  return entry.config;
}

// Default must exceed worst-case mmbridge tool runtime. mmbridge_review and
// mmbridge_gate dispatch to LLM adapters that routinely take 60-180s+; 10min
// leaves headroom for slow adapters while still bounding true hangs. Callers
// may override via input.timeoutMs, or pass 0/negative to disable.
const DEFAULT_MMBRIDGE_MCP_TIMEOUT_MS = 600_000;
const MMBRIDGE_HEALTH_TIMEOUT_MS = 15_000;
const MMBRIDGE_SHUTDOWN_GRACE_MS = 1_000;
const MAX_MMBRIDGE_STDOUT_BUFFER_BYTES = 1024 * 1024;
const MAX_MMBRIDGE_STDERR_BYTES = 256 * 1024;
const MAX_MMBRIDGE_FRAME_BYTES = 512 * 1024;

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9._-]{4,}\b/g, "sk-***")
    .replace(/\bghp_[A-Za-z0-9_]{4,}\b/g, "ghp_***")
    .replace(/\b(xox[baprs]-)[A-Za-z0-9-]{4,}\b/g, "$1***")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{4,}\b/gi, "$1***")
    .replace(/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;"'}]+/gi, "$1$2***");
}

async function shutdownMcpChild(
  child: ChildProcessWithoutNullStreams,
  processGroup: OwnedProcessGroupController,
): Promise<void> {
  child.stdin.end();
  await processGroup.terminate();
}

type MmbridgeToolName =
  | "mmbridge_context_packet"
  | "mmbridge_review"
  | "mmbridge_gate"
  | "mmbridge_handoff"
  | "mmbridge_doctor";

const MMBRIDGE_TOOL_TIMEOUTS_MS: Record<MmbridgeToolName, number> = {
  mmbridge_context_packet: 120_000,
  mmbridge_review: 600_000,
  mmbridge_gate: 600_000,
  mmbridge_handoff: 120_000,
  mmbridge_doctor: 120_000,
};

const REQUIRED_MMBRIDGE_TOOLS: readonly MmbridgeToolName[] = [
  "mmbridge_context_packet",
  "mmbridge_review",
  "mmbridge_gate",
  "mmbridge_handoff",
  "mmbridge_doctor",
];

function getMmbridgeToolTimeoutMs(toolName: MmbridgeToolName): number {
  return MMBRIDGE_TOOL_TIMEOUTS_MS[toolName] ?? DEFAULT_MMBRIDGE_MCP_TIMEOUT_MS;
}

export async function runMmbridgeMcpTool(input: {
  workspaceRoot: string;
  toolName: MmbridgeToolName;
  args: Record<string, unknown>;
  userHomeDir?: string;
  onProgress?: (line: string) => void;
  timeoutMs?: number;
}): Promise<readonly string[]> {
  const config = resolveMmbridgeServerConfig({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const timeoutMs = input.timeoutMs ?? getMmbridgeToolTimeoutMs(input.toolName);

  const child = spawn(config.command, [...(config.args ?? [])], {
    cwd: input.workspaceRoot,
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const processGroup = createOwnedProcessGroupController({
    child,
    label: "mmbridge MCP",
    forceKillDelayMs: MMBRIDGE_SHUTDOWN_GRACE_MS,
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | null = null;
  let fatalError: Error | undefined;

  const failPending = (error: Error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const failSession = (error: Error) => {
    if (fatalError) return;
    fatalError = error;
    failPending(error);
    void processGroup.terminate().catch(() => undefined);
  };

  const armTimeout = () => {
    clearTimer();
    if (timeoutMs <= 0) return;
    timer = setTimeout(() => {
      if (pending.size === 0) return;
      failSession(new Error(
        `mmbridge MCP request timed out after ${timeoutMs}ms. ${redactDiagnosticText(stderrBuffer.toString("utf8"))}`.trim(),
      ));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(encodeFrame(payload), "utf8");
      armTimeout();
    });
  };

  const notify = (method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(encodeFrame({ jsonrpc: "2.0", method, params }), "utf8");
  };

  child.stdin.on("error", () => {});

  child.stderr.on("data", (chunk) => {
    if (fatalError) return;
    const remaining = MAX_MMBRIDGE_STDERR_BYTES - stderrBuffer.length;
    if (remaining > 0) {
      stderrBuffer = Buffer.concat([stderrBuffer, chunk.subarray(0, remaining)]);
    }
    if (chunk.length > remaining) {
      failSession(new Error(
        `mmbridge MCP stderr exceeded ${MAX_MMBRIDGE_STDERR_BYTES} bytes. ${redactDiagnosticText(stderrBuffer.toString("utf8"))}`.trim(),
      ));
    }
  });

  child.stdout.on("data", (chunk) => {
    if (fatalError) return;
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    if (stdoutBuffer.length > MAX_MMBRIDGE_STDOUT_BUFFER_BYTES) {
      stdoutBuffer = stdoutBuffer.subarray(0, MAX_MMBRIDGE_STDOUT_BUFFER_BYTES);
      failSession(new Error(
        `mmbridge MCP stdout buffer exceeded ${MAX_MMBRIDGE_STDOUT_BUFFER_BYTES} bytes. ${redactDiagnosticText(stderrBuffer.toString("utf8"))}`.trim(),
      ));
      return;
    }
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf(0x0a);
      if (newlineIndex < 0) return;
      if (newlineIndex > MAX_MMBRIDGE_FRAME_BYTES) {
        stdoutBuffer = Buffer.alloc(0);
        failSession(new Error(`mmbridge MCP frame exceeded ${MAX_MMBRIDGE_FRAME_BYTES} bytes.`));
        return;
      }
      const line = stdoutBuffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
      if (line.length === 0) continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }

      if (typeof message.id === "number" && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (pending.size === 0) {
          clearTimer();
        } else {
          armTimeout();
        }
        if (message.error) {
          entry?.reject(new Error(message.error.message ?? `MCP ${message.method ?? "request"} failed`));
        } else {
          entry?.resolve(message);
        }
        continue;
      }

      const progressLine = formatNotificationLine(message);
      if (progressLine) {
        input.onProgress?.(progressLine);
      }
    }
  });

  child.on("error", (error) => failSession(error instanceof Error ? error : new Error(String(error))));
  child.on("exit", (code) => {
    if (pending.size > 0) {
      failSession(new Error(
        `mmbridge MCP process exited early with code ${code ?? 0}. ${redactDiagnosticText(stderrBuffer.toString("utf8"))}`.trim(),
      ));
    }
  });

  try {
    await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "unclecode", version: "0.1.0" },
    });
    notify("notifications/initialized", {});
    const response = await request("tools/call", {
      name: input.toolName,
      arguments: input.args,
    });
    const resultLines = extractTextContent(response.result);
    if (response.result?.isError === true) {
      throw new Error(resultLines.join("\n") || `${input.toolName} failed`);
    }
    return resultLines;
  } finally {
    clearTimer();
    await shutdownMcpChild(child, processGroup);
  }
}

export async function runMmbridgeMcpHealthCheck(input: {
  workspaceRoot: string;
  userHomeDir?: string;
  timeoutMs?: number;
}): Promise<{
  readonly command: string;
  readonly args: readonly string[];
  readonly reachable: boolean;
  readonly tools: readonly string[];
  readonly missingTools: readonly string[];
  readonly error?: string;
}> {
  const config = resolveMmbridgeServerConfig({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const timeoutMs = input.timeoutMs ?? MMBRIDGE_HEALTH_TIMEOUT_MS;
  const child = spawn(config.command, [...(config.args ?? [])], {
    cwd: input.workspaceRoot,
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const processGroup = createOwnedProcessGroupController({
    child,
    label: "mmbridge MCP health check",
    forceKillDelayMs: MMBRIDGE_SHUTDOWN_GRACE_MS,
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | null = null;
  let fatalError: Error | undefined;

  const failPending = (error: Error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const failSession = (error: Error) => {
    if (fatalError) return;
    fatalError = error;
    failPending(error);
    void processGroup.terminate().catch(() => undefined);
  };

  const armTimeout = () => {
    clearTimer();
    if (timeoutMs <= 0) return;
    timer = setTimeout(() => {
      if (pending.size === 0) return;
      failSession(new Error(`mmbridge MCP health check timed out after ${timeoutMs}ms. Diagnostics hidden.`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(encodeFrame({ jsonrpc: "2.0", id, method, params }), "utf8");
      armTimeout();
    });
  };

  const notify = (method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(encodeFrame({ jsonrpc: "2.0", method, params }), "utf8");
  };

  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => {
    if (fatalError) return;
    const remaining = MAX_MMBRIDGE_STDERR_BYTES - stderrBuffer.length;
    if (remaining > 0) {
      stderrBuffer = Buffer.concat([stderrBuffer, chunk.subarray(0, remaining)]);
    }
    if (chunk.length > remaining) {
      failSession(new Error(`mmbridge MCP health stderr exceeded ${MAX_MMBRIDGE_STDERR_BYTES} bytes. Diagnostics hidden.`));
    }
  });
  child.stdout.on("data", (chunk) => {
    if (fatalError) return;
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    if (stdoutBuffer.length > MAX_MMBRIDGE_STDOUT_BUFFER_BYTES) {
      stdoutBuffer = stdoutBuffer.subarray(0, MAX_MMBRIDGE_STDOUT_BUFFER_BYTES);
      failSession(new Error(
        `mmbridge MCP health stdout buffer exceeded ${MAX_MMBRIDGE_STDOUT_BUFFER_BYTES} bytes. Diagnostics hidden.`,
      ));
      return;
    }
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf(0x0a);
      if (newlineIndex < 0) return;
      if (newlineIndex > MAX_MMBRIDGE_FRAME_BYTES) {
        stdoutBuffer = Buffer.alloc(0);
        failSession(new Error(`mmbridge MCP health frame exceeded ${MAX_MMBRIDGE_FRAME_BYTES} bytes. Diagnostics hidden.`));
        return;
      }
      const line = stdoutBuffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
      if (line.length === 0) continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }

      if (typeof message.id === "number" && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (pending.size === 0) {
          clearTimer();
        } else {
          armTimeout();
        }
        if (message.error) {
          entry?.reject(new Error(message.error.message ?? `MCP ${message.method ?? "request"} failed`));
        } else {
          entry?.resolve(message);
        }
      }
    }
  });
  child.on("error", (error) => failSession(error instanceof Error ? error : new Error(String(error))));
  child.on("exit", (code) => {
    if (pending.size > 0) {
      failSession(new Error(`mmbridge MCP process exited early with code ${code ?? 0}. Diagnostics hidden.`));
    }
  });

  try {
    await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "unclecode", version: "0.1.0" },
    });
    notify("notifications/initialized", {});
    const response = await request("tools/list");
    const tools = extractToolNames(response.result);
    const missingTools = REQUIRED_MMBRIDGE_TOOLS.filter((toolName) => !tools.includes(toolName));
    return {
      command: config.command,
      args: config.args ?? [],
      reachable: true,
      tools,
      missingTools,
    };
  } catch (error) {
    return {
      command: config.command,
      args: config.args ?? [],
      reachable: false,
      tools: [],
      missingTools: REQUIRED_MMBRIDGE_TOOLS,
      error: "health check failed; diagnostics hidden",
    };
  } finally {
    clearTimer();
    await shutdownMcpChild(child, processGroup);
  }
}

function extractToolNames(result: Record<string, unknown> | undefined): readonly string[] {
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools
    .map((tool) => (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string" ? tool.name : null))
    .filter((toolName): toolName is string => toolName !== null)
    .sort((left, right) => left.localeCompare(right));
}

export function buildMmbridgeContextSummary(lines: readonly string[]): readonly string[] {
  const joined = lines.join("\n");
  return [
    "mmbridge context ready.",
    ...(joined ? joined.split("\n").slice(0, 8) : []),
  ];
}

export function buildMmbridgeReviewReport(lines: readonly string[]): readonly string[] {
  const joined = lines.join("\n");
  return [
    "mmbridge review finished.",
    ...(joined ? joined.split("\n").slice(0, 12) : []),
  ];
}

export function buildMmbridgeGateReport(lines: readonly string[]): readonly string[] {
  const joined = lines.join("\n");
  return [
    "mmbridge gate finished.",
    ...(joined ? joined.split("\n").slice(0, 10) : []),
  ];
}

export function buildMmbridgeHandoffReport(lines: readonly string[]): readonly string[] {
  const joined = lines.join("\n");
  return [
    "mmbridge handoff ready.",
    ...(joined ? joined.split("\n").slice(0, 12) : []),
  ];
}

export function buildMmbridgeDoctorReport(lines: readonly string[]): readonly string[] {
  const joined = lines.join("\n");
  return [
    "mmbridge doctor finished.",
    ...(joined ? joined.split("\n").slice(0, 12) : []),
  ];
}

export function buildMmbridgeHealthReport(input: Awaited<ReturnType<typeof runMmbridgeMcpHealthCheck>>): readonly string[] {
  return [
    "mmbridge health",
    `Reachable: ${input.reachable ? "yes" : "no"}`,
    `Command: ${redactDiagnosticText(input.command)}`,
    `Args: ${input.args.length === 0 ? "none" : `${input.args.length} configured (hidden)`}`,
    `Tools: ${input.tools.length > 0 ? input.tools.join(", ") : "none"}`,
    `Required tools: ${input.missingTools.length === 0 ? "all present" : `missing ${input.missingTools.join(", ")}`}`,
    ...(input.error ? [`Error: ${redactDiagnosticText(input.error)}`] : []),
  ];
}
