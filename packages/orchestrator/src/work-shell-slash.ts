import { type ProviderId } from "@unclecode/providers";

import { createWorkShellCommandRegistry } from "./command-registry.js";
import { loadExtensionSlashCommands } from "./extension-registry.js";
import { runRustCommandSync } from "./rust-command.js";

type WorkShellSlashOptions = {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
  readonly provider?: ProviderId;
  readonly currentModel?: string;
};

function getWorkShellCommandRegistry(
  options?: WorkShellSlashOptions,
) {
  return createWorkShellCommandRegistry(loadExtensionSlashCommands(options));
}

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

export function listWorkShellSlashSuggestionEntries(
  options?: WorkShellSlashOptions,
): readonly { readonly command: string; readonly description: string }[] {
  const registry = getWorkShellCommandRegistry(options);
  return [
    ...registry.list().flatMap((entry) => [
      { command: entry.command, description: entry.metadata.description },
      ...(entry.metadata.aliases ?? []).map((alias) => ({
        command: alias,
        description: `Alias for ${entry.command}.`,
      })),
    ]),
    ...WORK_SHELL_EXTRA_SUGGESTION_ENTRIES,
  ];
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

export function getWorkShellSlashSuggestions(
  input: string,
  options?: WorkShellSlashOptions,
): readonly { readonly command: string; readonly description: string }[] {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const entries = listWorkShellSlashSuggestionEntries(options);
  if (normalized === "/model" || normalized.startsWith("/model ")) {
    return getModelSuggestions(normalized, options);
  }

  return getSlashSuggestions(normalized, entries, options);
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
): readonly { readonly command: string; readonly description: string }[] {
  const provider = options?.provider ?? "openai";
  const currentModel = options?.currentModel ?? "gpt-5.5";
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "model-suggestions", provider, currentModel, normalized],
      options?.workspaceRoot ?? process.cwd(),
    ),
  ) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isSlashSuggestion)) {
    return [{ command: `/model ${currentModel}`, description: "Current model" }];
  }
  return parsed;
}

function getSlashSuggestions(
  normalized: string,
  entries: readonly { readonly command: string; readonly description: string }[],
  options?: WorkShellSlashOptions,
): readonly { readonly command: string; readonly description: string }[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "slash-suggestions", normalized],
      options?.workspaceRoot ?? process.cwd(),
      JSON.stringify(entries),
    ),
  ) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isSlashSuggestion)) {
    return [];
  }
  return parsed;
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
