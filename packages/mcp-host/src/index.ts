import {
  MCP_TRANSPORTS,
  type McpConfigScope,
  type McpTransport,
  type ScopedMcpServerConfig,
} from "@unclecode/contracts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface McpHostDescriptor {
  readonly serverName: string;
  readonly transport: Extract<McpTransport, "stdio" | "http">;
}

export type McpHostTrustTier = "project" | "user";

export type McpHostRegistryEntry = {
  readonly name: string;
  readonly config: ScopedMcpServerConfig;
  readonly scope: McpConfigScope;
  readonly transport: McpTransport;
  readonly trustTier: McpHostTrustTier;
  readonly originLabel: string;
};

export type McpHostRegistry = {
  readonly entries: readonly McpHostRegistryEntry[];
  readonly byName: ReadonlyMap<string, McpHostRegistryEntry>;
};

export type McpResearchProfile = {
  readonly profileName: "research-default";
  readonly serverNames: readonly string[];
};

export type StartedMcpProfile = {
  readonly profileName: string;
  readonly connectedServerNames: readonly string[];
  readonly connections: readonly {
    name: string;
    transport: Extract<McpTransport, "stdio" | "http">;
    state: "connected" | "failed";
    pid: number | null;
  }[];
};

type McpRuntimeConnection = StartedMcpProfile["connections"][number];

export const MCP_HOST_SUPPORTED_TRANSPORTS = MCP_TRANSPORTS;

function getOriginLabel(scope: McpConfigScope): string {
  switch (scope) {
    case "project":
    case "local":
      return "project config";
    case "user":
      return "user config";
    case "enterprise":
    case "managed":
      return "managed config";
    case "dynamic":
      return "dynamic config";
    case "claudeai":
      return "claudeai config";
    default:
      return `${scope} config`;
  }
}

function getTrustTier(scope: McpConfigScope): McpHostTrustTier {
  return scope === "project" || scope === "local" || scope === "enterprise" || scope === "managed"
    ? "project"
    : "user";
}

function toRegistryEntry(name: string, config: ScopedMcpServerConfig): McpHostRegistryEntry {
  return {
    name,
    config,
    scope: config.scope,
    transport: config.type,
    trustTier: getTrustTier(config.scope),
    originLabel: getOriginLabel(config.scope),
  };
}

export function createMcpHostRegistry(input: {
  readonly userServers?: Readonly<Record<string, ScopedMcpServerConfig>>;
  readonly projectServers?: Readonly<Record<string, ScopedMcpServerConfig>>;
}): McpHostRegistry {
  const merged = new Map<string, McpHostRegistryEntry>();

  for (const [name, config] of Object.entries(input.userServers ?? {})) {
    merged.set(name, toRegistryEntry(name, config));
  }

  for (const [name, config] of Object.entries(input.projectServers ?? {})) {
    merged.set(name, toRegistryEntry(name, config));
  }

  const entries = [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));

  return {
    entries,
    byName: new Map(entries.map((entry) => [entry.name, entry])),
  };
}

export function getResearchMcpProfile(
  registry: McpHostRegistry,
  input: { readonly enabledServerNames?: readonly string[] } = {},
): McpResearchProfile {
  const requestedNames = input.enabledServerNames ?? registry.entries.map((entry) => entry.name);
  const serverNames = requestedNames.filter((name) => registry.byName.has(name));

  return {
    profileName: "research-default",
    serverNames,
  };
}

export function createMcpHostController(registry: McpHostRegistry) {
  const childProcesses = new Map<string, ReturnType<typeof spawn>>();

  return {
    async startProfile(profile: McpResearchProfile): Promise<StartedMcpProfile> {
      const connections: McpRuntimeConnection[] = [];

      for (const name of profile.serverNames) {
        const entry = registry.byName.get(name);
        if (!entry) {
          continue;
        }

        if (entry.transport === "http" && entry.config.type === "http") {
          connections.push({ name: entry.name, transport: "http", state: "connected", pid: null });
          continue;
        }

        if (entry.transport === "stdio" && entry.config.type === "stdio") {
          const child = spawn(entry.config.command, [...(entry.config.args ?? [])], {
            env: { ...process.env, ...(entry.config.env ?? {}) },
            stdio: "pipe",
          });
          childProcesses.set(entry.name, child);
          connections.push({ name: entry.name, transport: "stdio", state: "connected", pid: child.pid ?? null });
        }
      }

      return {
        profileName: profile.profileName,
        connectedServerNames: connections.map((connection: McpRuntimeConnection) => connection.name),
        connections,
      };
    },
    async stopProfile(profile: StartedMcpProfile): Promise<void> {
      for (const connection of profile.connections) {
        const child = childProcesses.get(connection.name);
        if (!child) {
          continue;
        }
        child.kill("SIGTERM");
        childProcesses.delete(connection.name);
      }
    },
    list(): McpHostRegistry {
      return registry;
    },
  };
}

type McpConfigFile = {
  readonly mcpServers?: Readonly<Record<string, Omit<ScopedMcpServerConfig, "scope">>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toScopedConfig(
  config: Omit<ScopedMcpServerConfig, "scope">,
  scope: McpConfigScope,
): ScopedMcpServerConfig {
  return { ...config, scope } as ScopedMcpServerConfig;
}

function readMcpConfigFile(filePath: string, scope: McpConfigScope): Readonly<Record<string, ScopedMcpServerConfig>> {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const servers = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : {};

  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      toScopedConfig(config as Omit<ScopedMcpServerConfig, "scope">, scope),
    ]),
  );
}

export function loadMcpHostRegistry(input: {
  readonly workspaceRoot: string;
  readonly userHomeDir?: string;
}): McpHostRegistry {
  const userHomeDir = input.userHomeDir ?? homedir();
  const userServers = readMcpConfigFile(path.join(userHomeDir, ".unclecode", "mcp.json"), "user");
  const projectServers = readMcpConfigFile(path.join(input.workspaceRoot, ".mcp.json"), "project");

  return createMcpHostRegistry({ userServers, projectServers });
}

export function formatMcpHostRegistry(registry: McpHostRegistry): string {
  if (registry.entries.length === 0) {
    return "MCP servers\nNo MCP servers configured.";
  }

  return [
    "MCP servers",
    ...registry.entries.map((entry) =>
      `${entry.name} | ${entry.transport} | ${entry.trustTier} | ${entry.originLabel}`,
    ),
  ].join("\n");
}
