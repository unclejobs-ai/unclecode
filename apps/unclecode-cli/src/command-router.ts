import { createCliSlashCommandRegistry, loadExtensionSlashCommands } from "@unclecode/orchestrator";

export type ParsedSlashCommand =
  | {
      readonly kind: "plain";
      readonly raw: string;
    }
  | {
      readonly kind: "slash";
      readonly name: string;
      readonly args: readonly string[];
      readonly raw: string;
    };

function normalizeSlashInput(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function getCliSlashCommandRegistry(options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }) {
  return createCliSlashCommandRegistry(loadExtensionSlashCommands(options));
}

function getCliSlashCommands(options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }) {
  return getCliSlashCommandRegistry(options).list();
}

export function parseSlashCommand(input: string): ParsedSlashCommand {
  const raw = input.trim();

  if (!raw.startsWith("/")) {
    return { kind: "plain", raw };
  }

  const tokens = raw.slice(1).split(/\s+/).filter((token) => token.length > 0);
  const [name = "", ...args] = tokens;

  return {
    kind: "slash",
    name,
    args,
    raw,
  };
}

export function routeSlashCommand(input: string, options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }): readonly string[] {
  const parsed = parseSlashCommand(input);

  if (parsed.kind === "plain") {
    return [];
  }

  const exact = getCliSlashCommandRegistry(options).resolve(normalizeSlashInput(parsed.raw));
  if (exact) {
    return exact;
  }

  if (parsed.name === "mode" && parsed.args[0] === "set" && parsed.args[1]) {
    return ["mode", "set", parsed.args[1]];
  }

  return [parsed.name, ...parsed.args];
}

export function formatSlashCommandHelp(options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }): string {
  return [
    "Slash commands",
    ...getCliSlashCommands(options).map((entry) => `${entry.command} — ${entry.metadata.description}`),
  ].join("\n");
}
