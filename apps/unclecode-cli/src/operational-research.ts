import { formatMcpHostRegistry, loadMcpHostRegistry } from "@unclecode/mcp-host";
import { runRustCommand } from "@unclecode/orchestrator";

const RESEARCH_LATENCY_THRESHOLDS = {
  firstEventMsBudget: 1_500,
  totalMsBudget: 3_000,
  bundleMsBudget: 1_500,
  mcpStartMsBudget: 500,
  executorMsBudget: 1_500,
} as const;


export function buildResearchStatusReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
}): Promise<string> {
  return runRustCommand(["research", "status"], input.workspaceRoot, undefined, {
    ...input.env,
    ...(input.userHomeDir ? { HOME: input.userHomeDir } : {}),
  }).then((output) => output.trimEnd());
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
          `Command: ${config.command}`,
          `Args: ${(config.args ?? []).join(" ") || "none"}`,
          `Env keys: ${Object.keys(config.env ?? {}).length}`,
        ]
      : "url" in config
        ? [
            `URL: ${config.url}`,
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
