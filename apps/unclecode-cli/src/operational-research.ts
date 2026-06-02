import { formatMcpHostRegistry, loadMcpHostRegistry } from "@unclecode/mcp-host";
import { runRustCommand } from "@unclecode/orchestrator";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RESEARCH_LATENCY_THRESHOLDS = {
  firstEventMsBudget: 1_500,
  totalMsBudget: 3_000,
  bundleMsBudget: 1_500,
  mcpStartMsBudget: 500,
  executorMsBudget: 1_500,
} as const;


export async function buildResearchStatusReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
}): Promise<string> {
  try {
    const output = await runRustCommand(["research", "status"], input.workspaceRoot, undefined, {
      ...input.env,
      ...(input.userHomeDir ? { HOME: input.userHomeDir } : {}),
    });
    return output.trimEnd();
  } catch {
    return [
      "Research status",
      "Status: unavailable",
      "Error: research status failed; diagnostics hidden",
    ].join("\n");
  }
}

export function buildMcpListReport(input: {
  readonly workspaceRoot: string;
  readonly userHomeDir?: string;
}): string {
  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });

  return formatMcpHostRegistry(registry);
}

export function buildMcpInspectReport(input: {
  readonly workspaceRoot: string;
  readonly serverName?: string;
  readonly userHomeDir?: string;
}): string {
  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const serverName = input.serverName?.trim();
  if (!serverName) {
    return [
      "MCP server inspect",
      "Select an MCP server first.",
      "Health: not checked by inspect.",
    ].join("\n");
  }

  const entry = registry.byName.get(serverName);
  if (!entry) {
    return [
      "MCP server inspect",
      `Server not found: ${serverName}`,
      `Available: ${registry.entries.map((item) => item.name).join(", ") || "none"}`,
    ].join("\n");
  }

  const config = entry.config;
  const configLines =
    config.type === "stdio"
      ? [
          `Command: ${redactMcpDisplayValue(config.command)}`,
          `Args: ${(config.args ?? []).length} configured (hidden)`,
          `Env keys: ${Object.keys(config.env ?? {}).length}`,
        ]
      : "url" in config
        ? [
            `URL: ${redactMcpUrl(config.url)}`,
            `Headers: ${"headers" in config ? Object.keys(config.headers ?? {}).length : 0}`,
            `OAuth: ${"oauth" in config && config.oauth ? "configured" : "none"}`,
          ]
        : [`Config: ${config.type}`];

  return [
    "MCP server inspect",
    `Name: ${entry.name}`,
    `Transport: ${entry.transport}`,
    `Scope: ${entry.scope}`,
    `Trust: ${entry.trustTier}`,
    `Origin: ${entry.originLabel}`,
    "Health: not checked by inspect.",
    ...configLines,
  ].join("\n");
}

type ProjectMcpConfigFile = {
  readonly mcpServers?: Record<string, unknown>;
  readonly [key: string]: unknown;
};

function getProjectMcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".mcp.json");
}

async function readProjectMcpConfig(workspaceRoot: string): Promise<ProjectMcpConfigFile> {
  try {
    const raw = await readFile(getProjectMcpConfigPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".mcp.json must contain a JSON object.");
    }
    return parsed as ProjectMcpConfigFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeProjectMcpConfig(workspaceRoot: string, config: ProjectMcpConfigFile): Promise<string> {
  const configPath = getProjectMcpConfigPath(workspaceRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export async function addProjectMcpServer(input: {
  readonly workspaceRoot: string;
  readonly prompt?: string;
}): Promise<readonly string[]> {
  const parts = input.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  const [name, command, ...args] = parts;
  if (!name || !command) {
    return [
      "MCP add needs: name command [args...]",
      "Example: memory node ./memory-server.js",
    ];
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return ["MCP server name may only contain letters, numbers, dot, underscore, and dash."];
  }

  const config = await readProjectMcpConfig(input.workspaceRoot);
  const mcpServers = {
    ...(typeof config.mcpServers === "object" && config.mcpServers !== null
      ? config.mcpServers
      : {}),
    [name]: {
      type: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
    },
  };
  const configPath = await writeProjectMcpConfig(input.workspaceRoot, {
    ...config,
    mcpServers,
  });

  return [
    "MCP server added",
    `Name: ${name}`,
    `Config: ${configPath}`,
    "Run M to refresh the list.",
  ];
}

export async function removeProjectMcpServer(input: {
  readonly workspaceRoot: string;
  readonly serverName?: string;
  readonly userHomeDir?: string;
}): Promise<readonly string[]> {
  const serverName = input.serverName?.trim();
  if (!serverName) {
    return ["Select an MCP server first."];
  }

  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const entry = registry.byName.get(serverName);
  if (entry && entry.scope !== "project" && entry.scope !== "local") {
    return [
      "MCP server is not in this workspace config.",
      `Name: ${serverName}`,
      `Origin: ${entry.originLabel}`,
      "Edit the source config directly to remove it.",
    ];
  }

  const config = await readProjectMcpConfig(input.workspaceRoot);
  const currentServers = typeof config.mcpServers === "object" && config.mcpServers !== null
    ? { ...config.mcpServers }
    : {};
  if (!(serverName in currentServers)) {
    return [`MCP server not found in .mcp.json: ${serverName}`];
  }

  delete currentServers[serverName];
  const configPath = await writeProjectMcpConfig(input.workspaceRoot, {
    ...config,
    mcpServers: currentServers,
  });

  return [
    "MCP server removed",
    `Name: ${serverName}`,
    `Config: ${configPath}`,
    "Run M to refresh the list.",
  ];
}

function redactMcpUrl(url: string): string {
  const redacted = redactMcpDisplayValue(url);
  const queryIndex = redacted.search(/[?#]/);
  return queryIndex === -1
    ? redacted
    : `${redacted.slice(0, queryIndex)} (query hidden)`;
}

function redactMcpDisplayValue(value: string): string {
  return value.replace(
    /(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|AIza|npm_|hf_|sk-ant-api03-|sk-proj-|sk-svcacct-|sk-admin-)[A-Za-z0-9_\-.]+/g,
    "[REDACTED]",
  );
}

export async function runResearchPassData(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly userHomeDir?: string;
}): Promise<{
  readonly lines: readonly string[];
  readonly report: {
    readonly command: "research.run";
    readonly sessionId: string;
    readonly prompt: string;
    readonly status: "completed" | "failed";
    readonly summary: string;
    readonly artifactPaths: readonly string[];
    readonly metrics: {
      readonly firstEventMs: number;
      readonly totalMs: number;
      readonly bundleMs: number;
      readonly mcpStartMs: number;
      readonly executorMs: number;
    };
      readonly thresholds: typeof RESEARCH_LATENCY_THRESHOLDS;
  };
}> {
  const raw = await runRustCommand(
    ["research", "run", "--json", input.prompt],
    input.workspaceRoot,
    undefined,
    {
      ...input.env,
      ...(input.userHomeDir ? { HOME: input.userHomeDir } : {}),
    },
  );
  const report = JSON.parse(raw) as unknown;
  if (!isResearchRunReport(report)) {
    throw new Error("Rust research run returned an invalid payload.");
  }
  const lines = [
    report.status === "completed" ? "Research completed" : "Research failed",
    `Session: ${report.sessionId}`,
    `Summary: ${report.summary}`,
    ...report.artifactPaths.map((artifactPath) => `Artifact: ${artifactPath}`),
  ] as const;

  return {
    lines,
    report,
  };
}

export async function runResearchPass(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly userHomeDir?: string;
}): Promise<readonly string[]> {
  const { lines } = await runResearchPassData(input);
  return lines;
}

export function createTuiActivityEntry(input: {
  readonly actionId: string;
  readonly lines: readonly string[];
  readonly status: "completed" | "failed" | "info";
}) {
  const titleMap: Record<string, string> = {
    doctor: "Doctor",
    "mode-status": "Mode Status",
    "mode-cycle": "Mode Cycle",
    "auth-status": "Auth Status",
    "browser-login": "Browser Login",
    "device-login": "Device Login",
    "mcp-list": "MCP List",
    "new-research": "Research",
  };

  return {
    id: `${input.actionId}-${Date.now()}`,
    source: input.actionId,
    title: titleMap[input.actionId] ?? input.actionId,
    timestamp: new Date().toISOString(),
    lines: input.lines,
    tone:
      input.status === "completed"
        ? "success"
        : input.status === "failed"
          ? "warning"
          : "info",
  } as const;
}

function isResearchRunReport(value: unknown): value is {
  readonly command: "research.run";
  readonly sessionId: string;
  readonly prompt: string;
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly artifactPaths: readonly string[];
  readonly metrics: {
    readonly firstEventMs: number;
    readonly totalMs: number;
    readonly bundleMs: number;
    readonly mcpStartMs: number;
    readonly executorMs: number;
  };
  readonly thresholds: typeof RESEARCH_LATENCY_THRESHOLDS;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    command?: unknown;
    sessionId?: unknown;
    prompt?: unknown;
    status?: unknown;
    summary?: unknown;
    artifactPaths?: unknown;
    metrics?: unknown;
    thresholds?: unknown;
  };
  return (
    candidate.command === "research.run" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.prompt === "string" &&
    (candidate.status === "completed" || candidate.status === "failed") &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.artifactPaths) &&
    candidate.artifactPaths.every((artifactPath) => typeof artifactPath === "string") &&
    hasResearchMetrics(candidate.metrics) &&
    hasResearchThresholds(candidate.thresholds)
  );
}

function hasResearchMetrics(value: unknown): value is {
  readonly firstEventMs: number;
  readonly totalMs: number;
  readonly bundleMs: number;
  readonly mcpStartMs: number;
  readonly executorMs: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["firstEventMs", "totalMs", "bundleMs", "mcpStartMs", "executorMs"].every(
    (key) => typeof candidate[key] === "number",
  );
}

function hasResearchThresholds(value: unknown): value is typeof RESEARCH_LATENCY_THRESHOLDS {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["firstEventMsBudget", "totalMsBudget", "bundleMsBudget", "mcpStartMsBudget", "executorMsBudget"].every(
    (key) => typeof candidate[key] === "number",
  );
}
