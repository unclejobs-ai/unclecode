import { runRustCommandSync } from "@unclecode/orchestrator";

type HarnessStatus = {
  readonly configPath: string;
  readonly exists: boolean;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly approvals: string | null;
  readonly trustLevel: string | null;
  readonly multiAgent: boolean;
  readonly statusLine: readonly string[];
  readonly mcpServers: readonly string[];
};

type HarnessApplyChange = {
  readonly key: string;
  readonly value: string;
  readonly changed: boolean;
};

export function inspectHarnessStatus(cwd: string): HarnessStatus {
  const fields = parseRustHarnessStatus(
    runRustCommandSync(["rust", "harness", "inspect", cwd], process.cwd()),
  );
  return {
    configPath: fields.single.configPath ?? "",
    exists: fields.single.exists === "true",
    model: normalizeOptional(fields.single.model),
    reasoningEffort: normalizeOptional(fields.single.reasoningEffort),
    approvals: normalizeOptional(fields.single.approvals),
    trustLevel: normalizeOptional(fields.single.trustLevel),
    multiAgent: fields.single.multiAgent === "true",
    statusLine: fields.repeated.statusLine ?? [],
    mcpServers: fields.repeated.mcpServer ?? [],
  };
}

export function applyHarnessPreset(cwd: string, preset: HarnessPresetId): readonly HarnessApplyChange[] {
  const stdout = runRustCommandSync(["rust", "harness", "apply", preset, cwd], process.cwd());
  return parseRustHarnessApply(stdout);
}

export function getRustStartupProbe(): { readonly probe: string; readonly elapsedMs: number } {
  const fields = parseRustKeyValueLines(
    runRustCommandSync(["rust", "perf", "startup"], process.cwd()),
  );
  return {
    probe: fields.get("probe") ?? "native-startup",
    elapsedMs: Number.parseFloat(fields.get("elapsedMs") ?? "0"),
  };
}

function parseRustHarnessStatus(stdout: string): {
  readonly single: Record<string, string>;
  readonly repeated: Record<string, string[]>;
} {
  const single: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const separator = line.indexOf("\t");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = unescapeField(line.slice(separator + 1));
    if (key === "statusLine" || key === "mcpServer") {
      repeated[key] = [...(repeated[key] ?? []), value];
    } else {
      single[key] = value;
    }
  }
  return { single, repeated };
}

function unescapeField(value: string): string {
  let output = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      output += char === "n" ? "\n" : char === "t" ? "\t" : char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    output += char;
  }
  return escaped ? `${output}\\` : output;
}

function normalizeOptional(value: string | undefined): string | null {
  return value?.trim() ? value : null;
}

function parseRustHarnessApply(stdout: string): readonly HarnessApplyChange[] {
  const changes: HarnessApplyChange[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("change\t")) {
      continue;
    }
    const fields = parseTabbedFields(line);
    const key = fields.get("key");
    const value = fields.get("value");
    if (!key || value === undefined) {
      continue;
    }
    changes.push({
      key,
      value,
      changed: fields.get("changed") === "true",
    });
  }
  return changes;
}

function parseTabbedFields(line: string): Map<string, string> {
  return new Map(
    line
      .split("\t")
      .slice(1)
      .map((field) => {
        const separator = field.indexOf("=");
        return separator < 0
          ? []
          : [field.slice(0, separator), unescapeField(field.slice(separator + 1))];
      })
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}

export function formatHarnessStatusLines(status: HarnessStatus): readonly string[] {
  if (!status.exists) {
    return [
      `Config: ${status.configPath} (not found)`,
      "",
      "No .codex/config.toml found.",
      "Run 'unclecode harness init' or create the config manually.",
    ];
  }

  return [
    `Config: ${status.configPath}`,
    "",
    `Model: ${status.model ?? "default"}`,
    `Reasoning: ${status.reasoningEffort ?? "default"}`,
    `Approvals: ${status.approvals ?? "user"}`,
    `Trust: ${status.trustLevel ?? "default"}`,
    `Multi-agent: ${status.multiAgent ? "enabled" : "disabled"}`,
    `MCP servers: ${status.mcpServers.length > 0 ? status.mcpServers.join(", ") : "none"}`,
    `Status line: ${status.statusLine.length > 0 ? status.statusLine.join(", ") : "default"}`,
  ];
}

export function formatHarnessExplainLines(): readonly string[] {
  return [
    "UncleCode harness controls how the agent runtime behaves.",
    "",
    "Profiles:",
    "  yolo    — Low friction. Medium reasoning, auto-approve local workspace tools.",
    "            Remote/MCP/background tasks still require approval.",
    "  default — Balanced. User approval for all tool execution.",
    "",
    "The harness reads from .codex/config.toml and applies overlays",
    "for model, reasoning effort, approval policy, and TUI status line.",
    "",
    "Commands:",
    "  unclecode harness status  — Show current harness configuration",
    "  unclecode harness apply yolo — Apply the YOLO low-friction preset",
    "  unclecode harness explain — Show this help",
  ];
}

export const HARNESS_PRESET_IDS = [
  "yolo",
  "team-coder",
  "team-builder",
  "team-hardener",
  "team-auditor",
  "team-agentless",
] as const;

export type HarnessPresetId = (typeof HARNESS_PRESET_IDS)[number];

export function isHarnessPresetId(value: string): value is HarnessPresetId {
  return (HARNESS_PRESET_IDS as readonly string[]).includes(value);
}

export function getHarnessPresetPatch(preset: HarnessPresetId): Record<string, string> {
  const stdout = runRustCommandSync(["rust", "harness", "preset", preset], process.cwd());
  return Object.fromEntries(
    stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("patch\t"))
      .map((line) => parseTabbedFields(line))
      .map((fields) => [fields.get("key"), fields.get("value")])
      .filter((entry): entry is [string, string] => Boolean(entry[0]) && entry[1] !== undefined),
  );
}

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}
