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

export type SessionCenterAction = {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly description: string;
};

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
    label: "R Research",
    command: "unclecode research run",
    description: "Start a fresh local research pass for the current workspace.",
  },
  {
    id: "doctor",
    label: "D Doctor",
    command: "unclecode doctor",
    description: "Check auth, runtime, session-store, and MCP readiness.",
  },
] as const;

export function getWorkspaceDisplayName(workspacePath: string): string {
  const segments = workspacePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  return segments.at(-1) ?? workspacePath;
}

export function formatSessionHeadline(session: SessionCenterSession): string {
  if (session.taskSummary && session.taskSummary.trim().length > 0) {
    return session.taskSummary.trim();
  }
  if (session.sessionId.startsWith("research-")) {
    return "Research session";
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
  sessions: readonly SessionCenterSession[];
}): SessionCenterModel {
  return {
    title: UNCLECODE_COMMAND_NAME,
    subtitle:
      "Resume recent work. Use Work to continue or connect auth with Browser, Key, or Logout.",
    modeLabel: input.modeLabel,
    authLabel: input.authLabel,
    sessionCount: input.sessionCount ?? input.sessions.length,
    mcpServerCount: input.mcpServerCount ?? 0,
    mcpServers: input.mcpServers ?? [],
    latestResearchSessionId: input.latestResearchSessionId ?? null,
    latestResearchSummary: input.latestResearchSummary ?? null,
    latestResearchTimestamp: input.latestResearchTimestamp ?? null,
    researchRunCount: input.researchRunCount ?? 0,
    primarySessions: input.sessions.slice(0, 6),
    utilityActions: SESSION_CENTER_ACTIONS,
    emptyState:
      "Press W to open work. Sessions will appear here after your first run.",
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
