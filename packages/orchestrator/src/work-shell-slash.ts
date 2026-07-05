import { type ProviderId } from "@unclecode/providers";

import { createWorkShellCommandRegistry } from "./command-registry.js";
import { getExtensionRegistryCacheGeneration, loadExtensionSlashCommands } from "./extension-registry.js";
import { runRustCommandSync } from "./rust-command.js";

type WorkShellSlashOptions = {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
  readonly provider?: ProviderId;
  readonly currentModel?: string;
};

type WorkShellSlashSuggestion = {
  readonly command: string;
  readonly description: string;
};

const WORK_SHELL_MODE_PROFILE_IDS = [
  "default",
  "ultrawork",
  "search",
  "analyze",
  "yolo",
  "plan",
  "build",
] as const;
const WORK_SHELL_MODE_PROFILE_DESCRIPTIONS: Readonly<Record<(typeof WORK_SHELL_MODE_PROFILE_IDS)[number], string>> = {
  default: "Switch to default work mode.",
  ultrawork: "Switch to ultrawork (focused parallel) mode.",
  search: "Switch to search mode (read-only).",
  analyze: "Switch to analyze mode (read-only).",
  yolo: "Switch to YOLO mode.",
  plan: "Switch to plan mode (edits blocked).",
  build: "Switch to build mode.",
};

const workShellSuggestionEntriesCache = new Map<string, readonly WorkShellSlashSuggestion[]>();

function getWorkShellCommandRegistry(
  options?: WorkShellSlashOptions,
) {
  return createWorkShellCommandRegistry(loadExtensionSlashCommands(options));
}

const WORK_SHELL_QUICK_PICK_COMMANDS = [
  "/context",
  "/model",
  "/auth status",
  "/queue",
  "/mode status",
  "/help",
] as const;

const WORK_SHELL_EXTRA_SUGGESTION_ENTRIES = [
  {
    command: "/auth key",
    description: "Open secure API key entry in this shell.",
  },
  {
    command: "/queue",
    description: "Show the current shell queue and active work state.",
  },
  {
    command: "/interrupt",
    description: "Alias for /cancel.",
  },
  {
    command: "/stop",
    description: "Alias for /cancel.",
  },
  {
    command: "/skills",
    description: "List available workspace skills.",
  },
  {
    command: "/tools",
    description: "List available local tools.",
  },
  {
    command: "/harness",
    description: "Show agent runtime harness and mode configuration.",
  },
  {
    command: "/reasoning",
    description: "Choose thinking depth for the next replies.",
  },
  {
    command: "/reasoning low",
    description: "Light thinking for quick checks.",
  },
  {
    command: "/reasoning medium",
    description: "Balanced thinking for normal work.",
  },
  {
    command: "/reasoning high",
    description: "Deep thinking for hard changes.",
  },
  {
    command: "/reasoning default",
    description: "Follow the current work mode default.",
  },
];
const workShellModelSuggestionCache = new Map<string, readonly WorkShellSlashSuggestion[]>();

export function listWorkShellSlashSuggestionEntries(
  options?: WorkShellSlashOptions,
): readonly WorkShellSlashSuggestion[] {
  const cacheKey = JSON.stringify({
    workspaceRoot: options?.workspaceRoot ?? process.cwd(),
    userHomeDir: options?.userHomeDir ?? "",
    extensionRegistryCacheGeneration: getExtensionRegistryCacheGeneration(),
  });
  const cached = workShellSuggestionEntriesCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const registry = getWorkShellCommandRegistry(options);
  const entries = [
    ...registry.list().flatMap((entry) => [
      { command: entry.command, description: entry.metadata.description },
      ...(entry.metadata.aliases ?? []).map((alias) => ({
        command: alias,
        description: `Alias for ${entry.command}.`,
      })),
    ]),
    ...WORK_SHELL_EXTRA_SUGGESTION_ENTRIES,
  ];
  workShellSuggestionEntriesCache.set(cacheKey, entries);
  return entries;
}

export function resolveWorkShellSlashCommand(
  input: string,
  options?: WorkShellSlashOptions,
): readonly string[] | undefined {
  const normalized = input.trim().replace(/\s+/g, " ");
  const routed = resolveWorkShellSlashCommandWithRust(normalized, options);
  if (routed.kind === "matched" || routed.kind === "dynamic") {
    return routed.route;
  }

  const extensionRoute = getWorkShellCommandRegistry(options).resolve(normalized);
  if (extensionRoute) {
    return extensionRoute;
  }

  return undefined;
}

type RustSlashRoute = {
  readonly kind: "plain" | "matched" | "dynamic" | "fallback";
  readonly route: readonly string[];
};

function resolveWorkShellSlashCommandWithRust(
  input: string,
  options?: WorkShellSlashOptions,
): RustSlashRoute {
  const raw = runRustCommandSync(
    ["rust", "command", "work-shell-route", input],
    options?.workspaceRoot ?? process.cwd(),
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !isRustRouteKind(parsed.kind) || !Array.isArray(parsed.route)) {
    throw new Error("Rust work-shell slash router returned an invalid payload.");
  }
  return {
    kind: parsed.kind,
    route: parsed.route.filter((item): item is string => typeof item === "string"),
  };
}

export function resolveWorkShellSlashArgHint(command: string): string | undefined {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized === "/model" || (normalized.startsWith("/model ") && normalized.slice("/model ".length).trim().length === 0)) {
    return "<model-id>";
  }
  if (normalized === "/mode") {
    return "status · set <profile>";
  }
  if (normalized === "/mode set" || normalized.startsWith("/mode set ")) {
    const profile = normalized.slice("/mode set".length).trim();
    return profile.length > 0 ? undefined : "default | ultrawork | search | analyze | yolo | plan | build";
  }
  if (normalized === "/reasoning" || (normalized.startsWith("/reasoning ") && normalized.split(" ").length === 1)) {
    return "low · medium · high · default";
  }
  if (normalized === "/mmbridge" || (normalized.startsWith("/mmbridge ") && normalized.split(" ").length === 1)) {
    return "context · review · gate · handoff · health · doctor";
  }
  if (normalized === "/auth" || (normalized.startsWith("/auth ") && normalized.split(" ").length === 1)) {
    return "status · login · key · logout · browser";
  }
  return undefined;
}

export function getWorkShellSlashSuggestions(
  input: string,
  options?: WorkShellSlashOptions,
): readonly WorkShellSlashSuggestion[] {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const entries = listWorkShellSlashSuggestionEntries(options);
  if (normalized === "/model" || normalized.startsWith("/model ")) {
    return getModelSuggestions(normalized, options);
  }

  return getSlashSuggestions(normalized, entries);
}

export function shouldBlockSlashSubmit(
  input: string,
  options?: WorkShellSlashOptions,
): boolean {
  const normalized = input.trim();
  const suggestions = getWorkShellSlashSuggestions(normalized, options);
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "slash-submit-block"],
      options?.workspaceRoot ?? process.cwd(),
      JSON.stringify({
        input: normalized,
        routeResolved: resolveWorkShellSlashCommand(normalized, options) !== undefined,
        suggestions,
      }),
    ),
  ) as unknown;
  if (!isRecord(parsed) || typeof parsed.shouldBlock !== "boolean") {
    throw new Error("Rust slash submit block command returned an invalid payload.");
  }
  return parsed.shouldBlock;
}

function getModelSuggestions(
  normalized: string,
  options?: WorkShellSlashOptions,
): readonly WorkShellSlashSuggestion[] {
  const provider = options?.provider ?? "openai";
  const currentModel = options?.currentModel ?? "gpt-5.5";
  const cacheKey = JSON.stringify({
    workspaceRoot: options?.workspaceRoot ?? process.cwd(),
    provider,
    currentModel,
  });
  const cached = workShellModelSuggestionCache.get(cacheKey);
  if (cached !== undefined) {
    return filterModelSuggestions(cached, normalized);
  }
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "model-suggestions", provider, currentModel, "/model"],
      options?.workspaceRoot ?? process.cwd(),
    ),
  ) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isSlashSuggestion)) {
    const fallback = [{ command: `/model ${currentModel}`, description: "Current model" }];
    workShellModelSuggestionCache.set(cacheKey, fallback);
    return filterModelSuggestions(fallback, normalized);
  }
  workShellModelSuggestionCache.set(cacheKey, parsed);
  return filterModelSuggestions(parsed, normalized);
}

function filterModelSuggestions(
  suggestions: readonly WorkShellSlashSuggestion[],
  normalized: string,
): readonly WorkShellSlashSuggestion[] {
  const query = normalized.slice("/model".length).trim().toLowerCase();
  if (query.length === 0) {
    return suggestions;
  }
  return suggestions.filter((suggestion) => {
    const command = suggestion.command.toLowerCase();
    const modelId = command.slice("/model".length).trim();
    return modelId.startsWith(query);
  });
}

function getSlashSuggestions(
  normalized: string,
  entries: readonly WorkShellSlashSuggestion[],
): readonly WorkShellSlashSuggestion[] {
  if (normalized === "/") {
    return dedupeSlashSuggestions(
      WORK_SHELL_QUICK_PICK_COMMANDS.flatMap((command) => {
        const match = entries.find((entry) => entry.command.toLowerCase() === command);
        return match ? [match] : [];
      }),
    );
  }
  if (normalized === "/auth" || normalized.startsWith("/auth ")) {
    return dedupeSlashSuggestions(
      entries
        .filter((entry) => entry.command.startsWith("/auth") || entry.command === "/browser")
        .sort((left, right) =>
          authSuggestionOrder(left.command) - authSuggestionOrder(right.command) ||
          left.command.localeCompare(right.command)),
    );
  }
  if (normalized === "/mode" || normalized.startsWith("/mode ")) {
    return [
      ...entries.filter((entry) => entry.command === "/mode status"),
      ...WORK_SHELL_MODE_PROFILE_IDS.map((mode) => ({
        command: `/mode set ${mode}`,
        description: WORK_SHELL_MODE_PROFILE_DESCRIPTIONS[mode],
      })),
    ].filter((entry) => entry.command.toLowerCase().startsWith(normalized));
  }
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  return dedupeSlashSuggestions(
    entries
      .map((entry) => {
        const command = entry.command.toLowerCase();
        if (command.startsWith(normalized)) {
          return { score: 0, entry };
        }
        if (command.includes(normalized)) {
          return { score: 1, entry };
        }
        if (tokens.every((token) => command.includes(token))) {
          return { score: 2, entry };
        }
        return undefined;
      })
      .filter((item): item is { readonly score: number; readonly entry: WorkShellSlashSuggestion } => item !== undefined)
      .sort((left, right) =>
        left.score - right.score ||
        left.entry.command.length - right.entry.command.length ||
        left.entry.command.localeCompare(right.entry.command))
      .map((item) => item.entry),
  );
}

function dedupeSlashSuggestions(entries: readonly WorkShellSlashSuggestion[]): readonly WorkShellSlashSuggestion[] {
  const seen = new Set<string>();
  const deduped: WorkShellSlashSuggestion[] = [];
  for (const entry of entries) {
    if (seen.has(entry.command)) {
      continue;
    }
    seen.add(entry.command);
    deduped.push(entry);
  }
  return deduped;
}

function authSuggestionOrder(command: string): number {
  switch (command) {
    case "/auth status":
      return 0;
    case "/auth login":
      return 1;
    case "/auth key":
      return 2;
    case "/auth logout":
      return 3;
    case "/auth browser":
      return 4;
    case "/browser":
      return 5;
    default:
      return 99;
  }
}

function isSlashSuggestion(value: unknown): value is { readonly command: string; readonly description: string } {
  if (!isRecord(value)) return false;
  return typeof value.command === "string" && typeof value.description === "string";
}

function isRustRouteKind(value: unknown): value is RustSlashRoute["kind"] {
  return value === "plain" || value === "matched" || value === "dynamic" || value === "fallback";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
