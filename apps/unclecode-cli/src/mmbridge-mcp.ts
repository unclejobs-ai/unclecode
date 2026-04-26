import { loadMcpHostRegistry } from "@unclecode/mcp-host";
import type { McpServerConfig } from "@unclecode/contracts";
import { spawn } from "node:child_process";

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

export async function runMmbridgeMcpTool(input: {
  workspaceRoot: string;
  toolName:
    | "mmbridge_context_packet"
    | "mmbridge_review"
    | "mmbridge_gate"
    | "mmbridge_handoff"
    | "mmbridge_doctor";
  args: Record<string, unknown>;
  userHomeDir?: string;
  onProgress?: (line: string) => void;
  timeoutMs?: number;
}): Promise<readonly string[]> {
  const config = resolveMmbridgeServerConfig({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const timeoutMs = input.timeoutMs ?? DEFAULT_MMBRIDGE_MCP_TIMEOUT_MS;

  const child = spawn(config.command, [...(config.args ?? [])], {
    cwd: input.workspaceRoot,
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrText = "";
  let timer: NodeJS.Timeout | null = null;

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

  const armTimeout = () => {
    clearTimer();
    if (timeoutMs <= 0) return;
    timer = setTimeout(() => {
      if (pending.size === 0) return;
      failPending(new Error(`mmbridge MCP request timed out after ${timeoutMs}ms. ${stderrText}`.trim()));
      child.kill("SIGTERM");
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(encodeFrame(payload), "utf8");
    armTimeout();
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const notify = (method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(encodeFrame({ jsonrpc: "2.0", method, params }), "utf8");
  };

  child.stdin.on("error", () => {});

  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf(0x0a);
      if (newlineIndex < 0) return;
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

  child.on("error", (error) => failPending(error instanceof Error ? error : new Error(String(error))));
  child.on("close", (code) => {
    if (pending.size > 0) {
      failPending(new Error(`mmbridge MCP process exited early with code ${code ?? 0}. ${stderrText}`.trim()));
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
    child.stdin.end();
    child.kill("SIGTERM");
  }
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
