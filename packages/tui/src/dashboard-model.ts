import type { ReactNode } from "react";

import {
  buildEmbeddedWorkSessionUpdate,
  type OpenEmbeddedWorkSession,
} from "@unclecode/contracts";

import type { SessionCenterSession } from "./dashboard-actions.js";
import type { TuiShellHomeState, TuiShellState } from "./shell-state.js";

export type TuiRenderOptions<
  HomeState extends {
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
    readonly sessions: readonly SessionCenterSession[];
    readonly bridgeLines?: readonly string[];
    readonly memoryLines?: readonly string[];
  } = TuiShellHomeState
> = {
  readonly workspaceRoot?: string;
  readonly modeLabel?: string;
  readonly authLabel?: string;
  readonly sessionCount?: number;
  readonly mcpServerCount?: number;
  readonly mcpServers?: readonly { name: string; transport: string; scope: string; trustTier: string; originLabel: string }[];
  readonly latestResearchSessionId?: string | null;
  readonly latestResearchSummary?: string | null;
  readonly latestResearchTimestamp?: string | null;
  readonly researchRunCount?: number;
  readonly initialSelectedSessionId?: string | undefined;
  readonly initialView?: TuiShellState["view"] | undefined;
  readonly renderWorkPane?: ((controls: {
    openSessions: () => void;
    syncHomeState: (homeState: Partial<HomeState>) => void;
  }) => ReactNode) | undefined;
  readonly sessions?: HomeState["sessions"];
  readonly contextLines?: readonly string[];
  readonly bridgeLines?: readonly string[];
  readonly memoryLines?: readonly string[];
  readonly runAction?: ((input: { actionId: string; prompt?: string; onProgress?: ((line: string) => void) | undefined }) => Promise<readonly string[]>) | undefined;
  readonly runSession?: ((sessionId: string) => Promise<readonly string[]>) | undefined;
  readonly launchWorkSession?: ((forwardedArgs?: readonly string[]) => Promise<void>) | undefined;
  readonly openEmbeddedWorkSession?: OpenEmbeddedWorkSession<HomeState> | undefined;
  readonly refreshHomeState?: (() => Promise<HomeState>) | undefined;
};

export type EmbeddedWorkDashboardSnapshot<
  HomeState extends {
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
    readonly sessions: readonly SessionCenterSession[];
    readonly bridgeLines?: readonly string[];
    readonly memoryLines?: readonly string[];
  } = TuiShellHomeState,
> = Pick<
  TuiRenderOptions<HomeState>,
  | "modeLabel"
  | "authLabel"
  | "sessionCount"
  | "mcpServerCount"
  | "mcpServers"
  | "latestResearchSessionId"
  | "latestResearchSummary"
  | "latestResearchTimestamp"
  | "researchRunCount"
  | "sessions"
  | "contextLines"
  | "bridgeLines"
  | "memoryLines"
  | "renderWorkPane"
>;

export type EmbeddedWorkPaneRenderOptions<
  HomeState extends {
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
    readonly sessions: readonly SessionCenterSession[];
    readonly bridgeLines?: readonly string[];
    readonly memoryLines?: readonly string[];
  } = TuiShellHomeState,
> = EmbeddedWorkDashboardSnapshot<HomeState> & Pick<
  TuiRenderOptions<HomeState>,
  "openEmbeddedWorkSession"
>;

export function extractEmbeddedHomeStatePatch<
  HomeState extends {
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
    readonly sessions: readonly SessionCenterSession[];
    readonly bridgeLines?: readonly string[];
    readonly memoryLines?: readonly string[];
  } = TuiShellHomeState,
>(props: EmbeddedWorkDashboardSnapshot<HomeState>): Partial<HomeState> {
  return {
    ...(props.modeLabel !== undefined ? { modeLabel: props.modeLabel } : {}),
    ...(props.authLabel !== undefined ? { authLabel: props.authLabel } : {}),
    ...(props.sessionCount !== undefined
      ? { sessionCount: props.sessionCount }
      : {}),
    ...(props.mcpServerCount !== undefined
      ? { mcpServerCount: props.mcpServerCount }
      : {}),
    ...(props.mcpServers !== undefined ? { mcpServers: props.mcpServers } : {}),
    ...(props.latestResearchSessionId !== undefined
      ? { latestResearchSessionId: props.latestResearchSessionId }
      : {}),
    ...(props.latestResearchSummary !== undefined
      ? { latestResearchSummary: props.latestResearchSummary }
      : {}),
    ...(props.latestResearchTimestamp !== undefined
      ? { latestResearchTimestamp: props.latestResearchTimestamp }
      : {}),
    ...(props.researchRunCount !== undefined
      ? { researchRunCount: props.researchRunCount }
      : {}),
    ...(props.sessions !== undefined ? { sessions: props.sessions } : {}),
    ...(props.bridgeLines !== undefined ? { bridgeLines: props.bridgeLines } : {}),
    ...(props.memoryLines !== undefined ? { memoryLines: props.memoryLines } : {}),
  } as Partial<HomeState>;
}

export function buildEmbeddedWorkPaneRenderOptions<
  HomeState extends {
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
    readonly sessions: readonly SessionCenterSession[];
    readonly bridgeLines?: readonly string[];
    readonly memoryLines?: readonly string[];
  } = TuiShellHomeState,
>(input: {
  readonly homeStatePatch: Partial<HomeState>;
  readonly contextLines?: readonly string[];
  readonly renderWorkPane: NonNullable<TuiRenderOptions<HomeState>["renderWorkPane"]>;
  readonly openEmbeddedWorkSession: NonNullable<
    TuiRenderOptions<HomeState>["openEmbeddedWorkSession"]
  >;
}): EmbeddedWorkPaneRenderOptions<HomeState> {
  return {
    ...(input.homeStatePatch.modeLabel !== undefined
      ? { modeLabel: input.homeStatePatch.modeLabel }
      : {}),
    ...(input.homeStatePatch.authLabel !== undefined
      ? { authLabel: input.homeStatePatch.authLabel }
      : {}),
    ...(input.homeStatePatch.sessionCount !== undefined
      ? { sessionCount: input.homeStatePatch.sessionCount }
      : {}),
    ...(input.homeStatePatch.mcpServerCount !== undefined
      ? { mcpServerCount: input.homeStatePatch.mcpServerCount }
      : {}),
    ...(input.homeStatePatch.mcpServers !== undefined
      ? { mcpServers: input.homeStatePatch.mcpServers }
      : {}),
    ...(input.homeStatePatch.latestResearchSessionId !== undefined
      ? { latestResearchSessionId: input.homeStatePatch.latestResearchSessionId }
      : {}),
    ...(input.homeStatePatch.latestResearchSummary !== undefined
      ? { latestResearchSummary: input.homeStatePatch.latestResearchSummary }
      : {}),
    ...(input.homeStatePatch.latestResearchTimestamp !== undefined
      ? { latestResearchTimestamp: input.homeStatePatch.latestResearchTimestamp }
      : {}),
    ...(input.homeStatePatch.researchRunCount !== undefined
      ? { researchRunCount: input.homeStatePatch.researchRunCount }
      : {}),
    ...(input.homeStatePatch.sessions !== undefined
      ? { sessions: input.homeStatePatch.sessions }
      : {}),
    ...(input.homeStatePatch.bridgeLines !== undefined
      ? { bridgeLines: input.homeStatePatch.bridgeLines }
      : {}),
    ...(input.homeStatePatch.memoryLines !== undefined
      ? { memoryLines: input.homeStatePatch.memoryLines }
      : {}),
    ...(input.contextLines ? { contextLines: input.contextLines } : {}),
    renderWorkPane: input.renderWorkPane,
    openEmbeddedWorkSession: input.openEmbeddedWorkSession,
  } as EmbeddedWorkPaneRenderOptions<HomeState>;
}

export async function createEmbeddedWorkPaneController<
  HomeState extends {
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
    readonly sessions: readonly SessionCenterSession[];
    readonly bridgeLines?: readonly string[];
    readonly memoryLines?: readonly string[];
  } = TuiShellHomeState,
>(input: {
  readonly initialSelectedSessionId?: string;
  readonly loadSnapshot: (
    forwardedArgs?: readonly string[],
  ) => Promise<EmbeddedWorkDashboardSnapshot<HomeState> | undefined>;
}): Promise<EmbeddedWorkPaneRenderOptions<HomeState> | undefined> {
  let currentRenderWorkPane:
    | TuiRenderOptions<HomeState>["renderWorkPane"]
    | undefined;
  let currentContextLines: readonly string[] | undefined;
  let currentHomeStatePatch: Partial<HomeState> | undefined;

  const loadPane = async (forwardedArgs: readonly string[] = []) => {
    const props = await input.loadSnapshot(forwardedArgs);
    currentRenderWorkPane = props?.renderWorkPane;
    currentContextLines = props?.contextLines;
    currentHomeStatePatch = props
      ? extractEmbeddedHomeStatePatch(props)
      : undefined;
    return props;
  };

  await loadPane(
    input.initialSelectedSessionId?.startsWith("work-")
      ? ["--session-id", input.initialSelectedSessionId]
      : [],
  );

  if (!currentRenderWorkPane) {
    return undefined;
  }

  const renderWorkPane: NonNullable<TuiRenderOptions<HomeState>["renderWorkPane"]> =
    (controls) => currentRenderWorkPane?.(controls) ?? null;
  const openEmbeddedWorkSession: NonNullable<
    TuiRenderOptions<HomeState>["openEmbeddedWorkSession"]
  > = async (forwardedArgs = []) => {
    await loadPane(forwardedArgs);
    return buildEmbeddedWorkSessionUpdate<HomeState>({
      forwardedArgs,
      ...(currentContextLines ? { contextLines: currentContextLines } : {}),
      ...(currentHomeStatePatch ? { homeState: currentHomeStatePatch } : {}),
    });
  };

  return buildEmbeddedWorkPaneRenderOptions<HomeState>({
    homeStatePatch: currentHomeStatePatch ?? {},
    ...(currentContextLines ? { contextLines: currentContextLines } : {}),
    renderWorkPane,
    openEmbeddedWorkSession,
  });
}

export function createSessionCenterDashboardRenderOptions<
  HomeState extends {
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
    readonly sessions: readonly SessionCenterSession[];
    readonly bridgeLines?: readonly string[];
    readonly memoryLines?: readonly string[];
  } = TuiShellHomeState,
>(input: {
  readonly workspaceRoot: string;
  readonly homeState: HomeState;
  readonly embeddedWorkPane?: EmbeddedWorkPaneRenderOptions<HomeState> | undefined;
  readonly initialSelectedSessionId?: string;
  readonly contextLines?: readonly string[];
  readonly runAction?: TuiRenderOptions<HomeState>["runAction"];
  readonly runSession?: TuiRenderOptions<HomeState>["runSession"];
  readonly launchWorkSession?: TuiRenderOptions<HomeState>["launchWorkSession"];
  readonly refreshHomeState?: (() => Promise<HomeState>) | undefined;
}): TuiRenderOptions<HomeState> {
  const bridgeLines =
    input.embeddedWorkPane?.bridgeLines ?? input.homeState.bridgeLines;
  const memoryLines =
    input.embeddedWorkPane?.memoryLines ?? input.homeState.memoryLines;

  return {
    workspaceRoot: input.workspaceRoot,
    modeLabel: input.embeddedWorkPane?.modeLabel ?? input.homeState.modeLabel,
    authLabel: input.embeddedWorkPane?.authLabel ?? input.homeState.authLabel,
    sessionCount:
      input.embeddedWorkPane?.sessionCount ?? input.homeState.sessionCount,
    mcpServerCount:
      input.embeddedWorkPane?.mcpServerCount ??
      input.homeState.mcpServerCount,
    mcpServers: input.embeddedWorkPane?.mcpServers ?? input.homeState.mcpServers,
    latestResearchSessionId:
      input.embeddedWorkPane?.latestResearchSessionId ??
      input.homeState.latestResearchSessionId,
    latestResearchSummary:
      input.embeddedWorkPane?.latestResearchSummary ??
      input.homeState.latestResearchSummary,
    latestResearchTimestamp:
      input.embeddedWorkPane?.latestResearchTimestamp ??
      input.homeState.latestResearchTimestamp,
    researchRunCount:
      input.embeddedWorkPane?.researchRunCount ??
      input.homeState.researchRunCount,
    ...(input.initialSelectedSessionId
      ? { initialSelectedSessionId: input.initialSelectedSessionId }
      : {}),
    sessions: input.embeddedWorkPane?.sessions ?? input.homeState.sessions,
    initialView:
      input.embeddedWorkPane?.renderWorkPane &&
      input.initialSelectedSessionId?.startsWith("work-")
        ? "work"
        : "sessions",
    contextLines:
      input.contextLines ?? input.embeddedWorkPane?.contextLines ?? [],
    ...(bridgeLines !== undefined ? { bridgeLines } : {}),
    ...(memoryLines !== undefined ? { memoryLines } : {}),
    ...(input.runAction ? { runAction: input.runAction } : {}),
    ...(input.runSession ? { runSession: input.runSession } : {}),
    ...(input.launchWorkSession
      ? { launchWorkSession: input.launchWorkSession }
      : {}),
    ...(input.embeddedWorkPane?.renderWorkPane
      ? { renderWorkPane: input.embeddedWorkPane.renderWorkPane }
      : {}),
    ...(input.embeddedWorkPane?.openEmbeddedWorkSession
      ? {
          openEmbeddedWorkSession:
            input.embeddedWorkPane.openEmbeddedWorkSession,
        }
      : {}),
    ...(input.refreshHomeState
      ? { refreshHomeState: input.refreshHomeState }
      : {}),
  };
}
