import type { CommandMetadata } from "@unclecode/contracts";

export type RegisteredSlashCommand = {
  readonly command: string;
  readonly routeTo: readonly string[];
  readonly metadata: CommandMetadata;
  /**
   * Exact-only commands are reachable by their full name and aliases, never by
   * a unique prefix. The Agent Console commands use it so `/agent`, `/job`, and
   * `/tod` fail closed instead of resolving to a route the CLI cannot run.
   * `command_router::resolve_builtin` enforces the same rule on the Rust side.
   */
  readonly exactOnly?: boolean;
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
      !entry.exactOnly
      && (entry.command.startsWith(normalized) || entry.metadata.aliases?.some((alias) => normalizeSlashInput(alias).startsWith(normalized))),
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
      metadata: builtinLocal("Show current mode and config source."),
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
      metadata: builtinLocal("Show Work context status."),
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
      command: "/context",
      routeTo: ["context"],
      metadata: builtinLocal("Inspect the context packet for the next answer.", ["/con"]),
    },
    {
      command: "/cache",
      routeTo: ["cache"],
      metadata: builtinLocal("Inspect prompt-cache reuse, writes, and token savings."),
    },
    {
      command: "/agents",
      routeTo: ["agents"],
      metadata: builtinLocal("에이전트 실행 상태와 transcript를 엽니다"),
      exactOnly: true,
    },
    {
      command: "/jobs",
      routeTo: ["jobs"],
      metadata: builtinLocal("백그라운드 job 상태를 엽니다"),
      exactOnly: true,
    },
    {
      command: "/todo",
      routeTo: ["todo"],
      metadata: builtinLocal("현재 WorkGraph 진행 상태를 엽니다"),
      exactOnly: true,
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
      command: "/mmbridge context",
      routeTo: ["mmbridge", "context"],
      metadata: builtinLocal("Assemble mmbridge context for the current workspace via MCP."),
    },
    {
      command: "/mmbridge review",
      routeTo: ["mmbridge", "review"],
      metadata: builtinLocal("Run an mmbridge review for the current workspace via MCP."),
    },
    {
      command: "/mmbridge gate",
      routeTo: ["mmbridge", "gate"],
      metadata: builtinLocal("Check mmbridge review freshness for the current workspace via MCP."),
    },
    {
      command: "/mmbridge handoff",
      routeTo: ["mmbridge", "handoff"],
      metadata: builtinLocal("Show the latest mmbridge handoff artifact via MCP."),
    },
    {
      command: "/mmbridge health",
      routeTo: ["mmbridge", "health"],
      metadata: builtinLocal("Check mmbridge MCP handshake and tool availability."),
    },
    {
      command: "/mmbridge doctor",
      routeTo: ["mmbridge", "doctor"],
      metadata: builtinLocal("Inspect mmbridge adapter/runtime readiness via MCP."),
    },
    {
      command: "/mode status",
      routeTo: ["mode", "status"],
      metadata: builtinLocal("Show current mode and config source."),
    },
    {
      command: "/research",
      routeTo: ["research", "run"],
      metadata: builtinPrompt("Refresh local Work context for the given topic or workspace question."),
    },
    {
      command: "/research status",
      routeTo: ["research", "status"],
      metadata: builtinLocal("Show the latest local Work context status."),
    },
    {
      command: "/cancel",
      routeTo: ["cancel"],
      metadata: builtinLocal("Interrupt the active turn and pause queued follow-ups.", ["/interrupt", "/stop"]),
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
