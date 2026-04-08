import type { CommandMetadata } from "@unclecode/contracts";

export type RegisteredSlashCommand = {
  readonly command: string;
  readonly routeTo: readonly string[];
  readonly metadata: CommandMetadata;
};

export class CommandRegistry {
  private readonly entries: readonly RegisteredSlashCommand[];

  constructor(entries: readonly RegisteredSlashCommand[]) {
    this.entries = entries.map((entry) => ({
      ...entry,
      command: normalizeSlashInput(entry.command),
    }));
  }

  list(): readonly RegisteredSlashCommand[] {
    return this.entries;
  }

  resolve(input: string): readonly string[] | undefined {
    const normalized = normalizeSlashInput(input);

    const exact = this.entries.find((entry) => entry.command === normalized);
    if (exact) {
      return exact.routeTo;
    }

    const exactAlias = this.entries.find((entry) =>
      entry.metadata.aliases?.some((alias) => normalizeSlashInput(alias) === normalized),
    );
    if (exactAlias) {
      return exactAlias.routeTo;
    }

    const slashBody = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    if (slashBody.length < 3) {
      return undefined;
    }

    const prefixMatches = this.entries.filter((entry) =>
      entry.command.startsWith(normalized) || entry.metadata.aliases?.some((alias) => normalizeSlashInput(alias).startsWith(normalized)),
    );

    return prefixMatches.length === 1 ? prefixMatches[0]?.routeTo : undefined;
  }
}

const builtinLocal = (description: string, aliases?: readonly string[]): CommandMetadata => ({
  name: description,
  description,
  type: "local",
  source: "builtin",
  ...(aliases ? { aliases } : {}),
  userInvocable: true,
});

const builtinPrompt = (description: string, aliases?: readonly string[]): CommandMetadata => ({
  name: description,
  description,
  type: "prompt",
  source: "builtin",
  ...(aliases ? { aliases } : {}),
  userInvocable: true,
});

export function createCliSlashCommandRegistry(extraEntries: readonly RegisteredSlashCommand[] = []): CommandRegistry {
  return new CommandRegistry([
    {
      command: "/help",
      routeTo: ["--help"],
      metadata: builtinLocal("Show the shell help surface."),
    },
    {
      command: "/work",
      routeTo: ["work"],
      metadata: builtinLocal("Launch the real coding assistant entrypoint."),
    },
    {
      command: "/doctor",
      routeTo: ["doctor"],
      metadata: builtinLocal("Run the doctor surface."),
    },
    {
      command: "/sessions",
      routeTo: ["sessions"],
      metadata: builtinLocal("List resumable local sessions."),
    },
    {
      command: "/mode status",
      routeTo: ["mode", "status"],
      metadata: builtinLocal("Show the active mode and its source."),
    },
    {
      command: "/mode set <mode>",
      routeTo: ["mode", "set", "<mode>"],
      metadata: {
        ...builtinLocal("Persist a mode in project config."),
        argumentHint: "<mode>",
      },
    },
    {
      command: "/research status",
      routeTo: ["research", "status"],
      metadata: builtinLocal("Show research-mode status."),
    },
    {
      command: "/mcp list",
      routeTo: ["mcp", "list"],
      metadata: builtinLocal("List merged MCP servers."),
    },
    ...extraEntries,
  ]);
}

export function createWorkShellCommandRegistry(extraEntries: readonly RegisteredSlashCommand[] = []): CommandRegistry {
  return new CommandRegistry([
    {
      command: "/doctor",
      routeTo: ["doctor"],
      metadata: builtinLocal("Run the doctor surface."),
    },
    {
      command: "/auth status",
      routeTo: ["auth", "status"],
      metadata: builtinLocal("Show the current auth surface status."),
    },
    {
      command: "/auth login",
      routeTo: ["auth", "login"],
      metadata: builtinLocal("Start the best available OAuth login.", ["/auth browser", "/browser"]),
    },
    {
      command: "/auth browser",
      routeTo: ["auth", "login", "--browser"],
      metadata: builtinLocal("Open browser auth login.", ["/auth login", "/browser"]),
    },
    {
      command: "/browser",
      routeTo: ["auth", "login", "--browser"],
      metadata: builtinLocal("Open browser auth login.", ["/auth login", "/auth browser"]),
    },
    {
      command: "/auth logout",
      routeTo: ["auth", "logout"],
      metadata: builtinLocal("Clear stored local auth credentials."),
    },
    {
      command: "/reload",
      routeTo: ["reload"],
      metadata: builtinLocal("Reload workspace guidance, skills, and extension context."),
    },
    {
      command: "/model",
      routeTo: ["model"],
      metadata: builtinLocal("Show the current model and available model picks."),
    },
    {
      command: "/model list",
      routeTo: ["model", "list"],
      metadata: builtinLocal("List available models and reasoning support."),
    },
    {
      command: "/mcp list",
      routeTo: ["mcp", "list"],
      metadata: builtinLocal("List merged MCP servers."),
    },
    {
      command: "/mode status",
      routeTo: ["mode", "status"],
      metadata: builtinLocal("Show the active mode and its source."),
    },
    {
      command: "/research",
      routeTo: ["research", "run"],
      metadata: builtinPrompt("Run a local research pass for the given topic or workspace question."),
    },
    {
      command: "/research status",
      routeTo: ["research", "status"],
      metadata: builtinLocal("Show the latest local research status."),
    },
    {
      command: "/review",
      routeTo: ["prompt", "review"],
      metadata: builtinPrompt("Review the current changes, risks, and missing verification."),
    },
    {
      command: "/commit",
      routeTo: ["prompt", "commit"],
      metadata: builtinPrompt("Draft a Lore-protocol commit message for the current changes."),
    },
    ...extraEntries,
  ]);
}

function normalizeSlashInput(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}
