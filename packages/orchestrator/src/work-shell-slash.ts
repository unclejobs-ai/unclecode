import { getProviderAdapter, type ProviderId } from "@unclecode/providers";

import { createWorkShellCommandRegistry } from "./command-registry.js";
import { loadExtensionSlashCommands } from "./extension-registry.js";

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

export function resolveWorkShellSlashCommand(
  input: string,
  options?: WorkShellSlashOptions,
): readonly string[] | undefined {
  const exact = getWorkShellCommandRegistry(options).resolve(input);
  if (exact) {
    return exact;
  }

  const normalized = input.trim().replace(/\s+/g, " ");
  if (normalized.startsWith("/auth login --api-key ")) {
    return normalized.slice(1).split(" ");
  }

  const promptCommand = resolvePromptStyleCommand(normalized, "/review", "review")
    ?? resolvePromptStyleCommand(normalized, "/commit", "commit");
  if (promptCommand) {
    return promptCommand;
  }

  const researchCommand = resolveResearchCommand(normalized);
  if (researchCommand) {
    return researchCommand;
  }

  return undefined;
}

export function getWorkShellSlashSuggestions(
  input: string,
  options?: WorkShellSlashOptions,
): readonly { readonly command: string; readonly description: string }[] {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const registry = getWorkShellCommandRegistry(options);
  const extraEntries = [
    {
      command: "/auth key",
      description: "Open secure API key entry in this shell.",
    },
  ];

  const entries = [
    ...registry.list().map((entry) => ({ command: entry.command, description: entry.metadata.description })),
    ...extraEntries,
  ];
  const authPreferredOrder = new Map([
    ["/auth status", 0],
    ["/auth login", 1],
    ["/auth key", 2],
    ["/auth logout", 3],
    ["/auth browser", 4],
    ["/browser", 5],
  ]);

  if (normalized === "/auth" || normalized.startsWith("/auth ")) {
    return entries
      .filter((entry) => entry.command.startsWith("/auth") || entry.command === "/browser")
      .sort(
        (left, right) =>
          (authPreferredOrder.get(left.command) ?? 99) -
          (authPreferredOrder.get(right.command) ?? 99),
      )
      .filter(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.command === entry.command) === index,
      );
  }

  if (normalized === "/model" || normalized.startsWith("/model ")) {
    return getModelSuggestions(normalized, entries, options);
  }

  const scored = entries
    .map((entry) => {
      const command = entry.command.toLowerCase();
      const startsWith = command.startsWith(normalized);
      const includes = command.includes(normalized);
      const tokenMatch = normalized.split(" ").every((token) => command.includes(token));
      const score = startsWith ? 0 : includes ? 1 : tokenMatch ? 2 : -1;
      return { ...entry, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.command.length - right.command.length ||
        left.command.localeCompare(right.command),
    );

  return scored.filter((entry, index) => scored.findIndex((candidate) => candidate.command === entry.command) === index);
}

export function shouldBlockSlashSubmit(
  input: string,
  options?: WorkShellSlashOptions,
): boolean {
  const normalized = input.trim();
  if (!normalized.startsWith("/")) {
    return false;
  }

  return resolveWorkShellSlashCommand(normalized, options) === undefined && getWorkShellSlashSuggestions(normalized, options).length > 0;
}

function resolvePromptStyleCommand(
  normalized: string,
  command: "/review" | "/commit",
  kind: "review" | "commit",
): readonly string[] | undefined {
  if (normalized === command) {
    return ["prompt", kind];
  }

  if (!normalized.startsWith(`${command} `)) {
    return undefined;
  }

  const args = normalized.slice(command.length).trim().split(" ").filter((token) => token.length > 0);
  return ["prompt", kind, ...args];
}

function getModelSuggestions(
  normalized: string,
  entries: readonly { readonly command: string; readonly description: string }[],
  options?: WorkShellSlashOptions,
): readonly { readonly command: string; readonly description: string }[] {
  const provider = options?.provider ?? "openai-api";
  const currentModel = options?.currentModel ?? "gpt-5.4";
  const dynamic = listProviderModelSuggestions(provider, currentModel);
  const modelEntries = [
    ...entries.filter((entry) => entry.command === "/model" || entry.command === "/model list"),
    ...dynamic,
  ];
  return modelEntries.filter((entry) => entry.command.toLowerCase().startsWith(normalized));
}

function formatModelSuggestionDescription(input: {
  model: string;
  currentModel: string;
  support: ReturnType<ReturnType<typeof getProviderAdapter>["getReasoningSupport"]>;
}): string {
  if (input.support.status === "unsupported") {
    return input.model === input.currentModel
      ? "Current · Warning · reasoning unsupported"
      : "Warning · reasoning unsupported";
  }
  const prefix = input.model === input.currentModel ? "Current" : "Default";
  return `${prefix} · default ${input.support.defaultEffort} · supports ${input.support.supportedEfforts.join(", ")}`;
}

function listProviderModelSuggestions(
  provider: ProviderId,
  currentModel: string,
): readonly { readonly command: string; readonly description: string }[] {
  try {
    const registry = getProviderAdapter(provider).getModelRegistry();
    return [...new Set([currentModel, ...registry.models])].slice(0, 8).map((model) => {
      const support = getProviderAdapter(provider).getReasoningSupport({ modelId: model });
      return {
        command: `/model ${model}`,
        description: formatModelSuggestionDescription({ model, currentModel, support }),
      };
    });
  } catch {
    return [{ command: `/model ${currentModel}`, description: "Current model" }];
  }
}

function resolveResearchCommand(normalized: string): readonly string[] | undefined {
  if (normalized === "/research") {
    return ["research", "run"];
  }

  if (!normalized.startsWith("/research ")) {
    return undefined;
  }

  const tail = normalized.slice("/research".length).trim();
  if (tail.length === 0) {
    return ["research", "run"];
  }
  if (tail === "status") {
    return ["research", "status"];
  }

  return ["research", "run", ...tail.split(" ").filter((token) => token.length > 0)];
}
