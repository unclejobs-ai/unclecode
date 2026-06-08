import { UNCLECODE_COMMAND_NAME } from "@unclecode/contracts";

export type DashboardAction = {
  readonly label: string;
  readonly command: string;
  readonly description: string;
  readonly category: "auth" | "config" | "workspace" | "session";
};

export type DashboardView = "browse" | "detail";

export type DashboardInputResult = {
  readonly view: DashboardView;
  readonly selectedIndex: number;
  readonly shouldExit: boolean;
  readonly exitCommand: string | undefined;
};

export type SessionCenterSession = {
  readonly sessionId: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly taskSummary: string | null;
  readonly mode?: string | null;
  readonly pendingAction?: string | null;
  readonly worktreeBranch?: string | null;
};

export type SessionCenterResearchRun = {
  readonly sessionId: string;
  readonly prompt: string;
  readonly status: "completed" | "failed" | "unknown";
  readonly summary: string;
  readonly timestamp: string | null;
};

export type SessionCenterAction = {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly description: string;
};

export type SessionCenterActionView = "work" | "sessions" | "mcp" | "research";

export type SessionCenterModel = {
  readonly title: string;
  readonly subtitle: string;
  readonly modeLabel: string;
  readonly authLabel: string;
  readonly sessionCount: number;
  readonly mcpServerCount: number;
  readonly mcpServers: readonly {
    name: string;
    transport: string;
    scope: string;
    trustTier: string;
    originLabel: string;
  }[];
  readonly latestResearchSessionId: string | null;
  readonly latestResearchSummary: string | null;
  readonly latestResearchTimestamp: string | null;
  readonly researchRunCount: number;
  readonly recentResearchRuns: readonly SessionCenterResearchRun[];
  readonly primarySessions: readonly SessionCenterSession[];
  readonly utilityActions: readonly SessionCenterAction[];
  readonly emptyState: string;
};

export type TuiActivityEntry = {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly timestamp: string;
  readonly lines: readonly string[];
  readonly tone: "info" | "success" | "warning";
};

export type ResearchDraftResult = {
  readonly value: string;
  readonly submitted: boolean;
};

export type SessionCenterFocusState = {
  readonly column: "sessions" | "actions";
  readonly sessionIndex: number;
  readonly actionIndex: number;
  readonly detailOpen: boolean;
  readonly shouldExit?: boolean | undefined;
  readonly selectedCommand?: string | undefined;
};

export const DASHBOARD_ACTIONS: ReadonlyArray<DashboardAction> = [
  {
    label: "Check Auth",
    command: "unclecode auth status",
    description:
      "Verify your OpenAI provider authentication state, token expiry, and organization context.",
    category: "auth",
  },
  {
    label: "Browser Login",
    command: "unclecode auth login --browser",
    description:
      "Start an OAuth browser-based login flow. Requires OPENAI_OAUTH_CLIENT_ID in environment.",
    category: "auth",
  },
  {
    label: "Config Explain",
    command: "unclecode config explain",
    description:
      "Inspect the resolved configuration: settings, prompt sections, and active mode overlays.",
    category: "config",
  },
  {
    label: "Browse Commands",
    command: "unclecode --help",
    description:
      "View all available CLI commands, subcommands, flags, and their descriptions.",
    category: "config",
  },
  {
    label: "Workspace Health",
    command: "unclecode doctor",
    description: "Run the local doctor surface and inspect workspace readiness.",
    category: "workspace",
  },
  {
    label: "Session Center",
    command: "unclecode center",
    description: "Open the secondary session center launcher and inspector surface.",
    category: "session",
  },
];

export const SESSION_CENTER_ACTIONS: readonly SessionCenterAction[] = [
  {
    id: "work-session",
    label: "W Work",
    command: "unclecode work",
    description: "Launch the real interactive coding assistant session.",
  },
  {
    id: "browser-login",
    label: "B Browser",
    command: "unclecode auth login --browser",
    description:
      "Launch the browser OAuth flow and wait for the callback to complete.",
  },
  {
    id: "api-key-login",
    label: "K Key",
    command: "unclecode auth login --api-key-stdin",
    description:
      "Paste an OpenAI API key to save local auth. Optional: append --org <id> --project <id>.",
  },
  {
    id: "auth-logout",
    label: "L Logout",
    command: "unclecode auth logout",
    description: "Clear locally stored UncleCode auth credentials.",
  },
  {
    id: "new-research",
    label: "N Refresh",
    command: "unclecode research run",
    description: "Refresh local workspace context for the next Work prompt.",
  },
  {
    id: "research-status",
    label: "S Latest",
    command: "unclecode research status",
    description: "Show the latest saved Work context refresh.",
  },
  {
    id: "mcp-list",
    label: "M MCP",
    command: "unclecode mcp list",
    description: "List configured MCP servers, transport, scope, trust tier, and origin.",
  },
  {
    id: "mcp-add",
    label: "A Add",
    command: "unclecode mcp add <name> <command> [args...]",
    description: "Add a stdio MCP server to this workspace .mcp.json.",
  },
  {
    id: "mcp-remove",
    label: "X Remove",
    command: "unclecode mcp remove <server>",
    description: "Remove the selected workspace MCP server from .mcp.json.",
  },
  {
    id: "mcp-inspect",
    label: "I Inspect",
    command: "unclecode mcp inspect <server>",
    description: "Inspect the selected MCP server config without starting or health-checking it.",
  },
  {
    id: "doctor",
    label: "D Doctor",
    command: "unclecode doctor",
    description: "Check auth, runtime, session-store, and MCP readiness.",
  },
] as const;

const VISIBLE_SESSION_CENTER_ACTION_IDS_BY_VIEW: Record<
  SessionCenterActionView,
  readonly string[]
> = {
  work: ["work-session", "new-research", "mcp-list", "doctor"],
  sessions: ["work-session", "new-research", "doctor"],
  mcp: ["mcp-add", "mcp-remove", "mcp-list", "mcp-inspect"],
  research: ["new-research", "research-status"],
} as const;

export function getVisibleSessionCenterActionsForView(
  view: SessionCenterActionView,
  actions: readonly SessionCenterAction[],
): readonly SessionCenterAction[] {
  const ids = VISIBLE_SESSION_CENTER_ACTION_IDS_BY_VIEW[view];
  return ids
    .map((id) => actions.find((action) => action.id === id))
    .filter((action): action is SessionCenterAction => Boolean(action));
}

export function ensureSelectedSessionCenterActionVisible(
  actions: readonly SessionCenterAction[],
  selectedAction: SessionCenterAction | undefined,
  shouldIncludeSelectedAction: boolean,
): readonly SessionCenterAction[] {
  if (!shouldIncludeSelectedAction || !selectedAction) {
    return actions;
  }
  if (actions.some((action) => action.id === selectedAction.id)) {
    return actions;
  }
  return [...actions, selectedAction];
}

export function getWorkspaceDisplayName(workspacePath: string): string {
  const segments = workspacePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  return segments.at(-1) ?? workspacePath;
}

export function formatSessionHeadline(session: SessionCenterSession): string {
  const summary = session.taskSummary
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (summary && summary.length > 0) {
    return summary;
  }
  if (session.sessionId.startsWith("research-")) {
    return "Work context snapshot";
  }
  if (session.sessionId.startsWith("work-")) {
    return "Work session";
  }
  return "Saved session";
}

export function createSessionCenterModel(input: {
  workspaceRoot: string;
  modeLabel: string;
  authLabel: string;
  sessionCount?: number;
  mcpServerCount?: number;
  mcpServers?: readonly {
    name: string;
    transport: string;
    scope: string;
    trustTier: string;
    originLabel: string;
  }[];
  latestResearchSessionId?: string | null;
  latestResearchSummary?: string | null;
  latestResearchTimestamp?: string | null;
  researchRunCount?: number;
  recentResearchRuns?: readonly SessionCenterResearchRun[];
  sessions: readonly SessionCenterSession[];
}): SessionCenterModel {
  return {
    title: UNCLECODE_COMMAND_NAME,
    subtitle:
      "Session Center. Resume recent work, open a new work session, or repair auth.",
    modeLabel: input.modeLabel,
    authLabel: input.authLabel,
    sessionCount: input.sessionCount ?? input.sessions.length,
    mcpServerCount: input.mcpServerCount ?? 0,
    mcpServers: input.mcpServers ?? [],
    latestResearchSessionId: input.latestResearchSessionId ?? null,
    latestResearchSummary: input.latestResearchSummary ?? null,
    latestResearchTimestamp: input.latestResearchTimestamp ?? null,
    researchRunCount: input.researchRunCount ?? 0,
    recentResearchRuns: input.recentResearchRuns ?? [],
    primarySessions: input.sessions.slice(0, 6),
    utilityActions: SESSION_CENTER_ACTIONS,
    emptyState:
      "No saved sessions yet. Press W to start work.",
  };
}

export function formatSessionCenterDraftValue(
  actionId: string | undefined,
  draft: string,
): string {
  if (actionId !== "api-key-login") {
    return draft;
  }

  const parts = draft.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return draft;
  }

  return ["[REDACTED]", ...parts.slice(1)].join(" ");
}

export function appendActivityEntry(
  entries: readonly TuiActivityEntry[],
  nextEntry: TuiActivityEntry,
): readonly TuiActivityEntry[] {
  return [nextEntry, ...entries].slice(0, 20);
}

export function createApprovalRequestForAction(actionId: string) {
  if (actionId === "browser-login") {
    return {
      id: "approval-browser-login",
      title: "Open Browser Login",
      detail: "Launch the browser OAuth flow and wait for the callback to complete.",
      severity: "info" as const,
    };
  }
  if (actionId === "device-login") {
    return {
      id: "approval-device-login",
      title: "Start Device Login",
      detail: "Begin the device-code login flow from this shell.",
      severity: "warning" as const,
    };
  }
  return undefined;
}
