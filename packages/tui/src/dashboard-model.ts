import type { ReactNode } from "react";

import {
  buildEmbeddedWorkSessionUpdate,
  type OpenEmbeddedWorkSession,
} from "@unclecode/contracts";

import type {
  SessionCenterSession,
} from "./dashboard-actions.js";
import type { TuiShellHomeState, TuiShellState } from "./shell-state.js";

export type TuiDashboardHomeState = {
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
  readonly sessions: readonly SessionCenterSession[];
  readonly bridgeLines?: readonly string[];
  readonly memoryLines?: readonly string[];
};

export type TuiRenderOptions<
  HomeState extends TuiDashboardHomeState = TuiShellHomeState
> = {
  readonly workspaceRoot?: string;
  readonly modeLabel?: string;
  readonly authLabel?: string;
  readonly sessionCount?: number;
  readonly mcpServerCount?: number;
  readonly mcpServers?: readonly { name: string; transport: string; scope: string; trustTier: string; originLabel: string }[];
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
  readonly dispose?: (() => void | Promise<void>) | undefined;
};

export type EmbeddedWorkDashboardSnapshot<
  HomeState extends TuiDashboardHomeState = TuiShellHomeState,
> = Pick<
  TuiRenderOptions<HomeState>,
  | "modeLabel"
  | "authLabel"
  | "sessionCount"
  | "mcpServerCount"
  | "mcpServers"
  | "sessions"
  | "contextLines"
  | "bridgeLines"
  | "memoryLines"
  | "renderWorkPane"
  | "dispose"
>;

export type EmbeddedWorkPaneRenderOptions<
  HomeState extends TuiDashboardHomeState = TuiShellHomeState,
> = EmbeddedWorkDashboardSnapshot<HomeState> & Pick<
  TuiRenderOptions<HomeState>,
  "openEmbeddedWorkSession"
>;

export function extractEmbeddedHomeStatePatch<
  HomeState extends TuiDashboardHomeState = TuiShellHomeState,
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
    ...(props.sessions !== undefined ? { sessions: props.sessions } : {}),
    ...(props.bridgeLines !== undefined ? { bridgeLines: props.bridgeLines } : {}),
    ...(props.memoryLines !== undefined ? { memoryLines: props.memoryLines } : {}),
  } as Partial<HomeState>;
}

export function buildEmbeddedWorkPaneRenderOptions<
  HomeState extends TuiDashboardHomeState = TuiShellHomeState,
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
  HomeState extends TuiDashboardHomeState = TuiShellHomeState,
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
  let currentSnapshot: EmbeddedWorkDashboardSnapshot<HomeState> | undefined;
  const disposedSnapshots = new WeakSet<object>();
  let disposed = false;

  const disposeSnapshot = async (
    snapshot: EmbeddedWorkDashboardSnapshot<HomeState> | undefined,
  ): Promise<void> => {
    if (!snapshot || disposedSnapshots.has(snapshot)) return;
    disposedSnapshots.add(snapshot);
    await snapshot.dispose?.();
  };

  const loadPane = async (forwardedArgs: readonly string[] = []) => {
    if (disposed) throw new Error("Embedded Work pane controller is closed.");
    const props = await input.loadSnapshot(forwardedArgs);
    const previousSnapshot = currentSnapshot;
    currentSnapshot = props;
    currentRenderWorkPane = props?.renderWorkPane;
    currentContextLines = props?.contextLines;
    currentHomeStatePatch = props
      ? extractEmbeddedHomeStatePatch(props)
      : undefined;
    if (previousSnapshot !== props) {
      await disposeSnapshot(previousSnapshot);
    }
    return props;
  };

  await loadPane(
    input.initialSelectedSessionId?.startsWith("work-")
      ? ["--session-id", input.initialSelectedSessionId]
      : [],
  );

  if (!currentRenderWorkPane) {
    disposed = true;
    const snapshot = currentSnapshot;
    currentSnapshot = undefined;
    await disposeSnapshot(snapshot);
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

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const snapshot = currentSnapshot;
    currentSnapshot = undefined;
    currentRenderWorkPane = undefined;
    currentContextLines = undefined;
    currentHomeStatePatch = undefined;
    await disposeSnapshot(snapshot);
  };

  return {
    ...buildEmbeddedWorkPaneRenderOptions<HomeState>({
      homeStatePatch: currentHomeStatePatch ?? {},
      ...(currentContextLines ? { contextLines: currentContextLines } : {}),
      renderWorkPane,
      openEmbeddedWorkSession,
    }),
    dispose,
  };
}

export function createSessionCenterDashboardRenderOptions<
  HomeState extends TuiDashboardHomeState = TuiShellHomeState,
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
    ...(input.embeddedWorkPane?.dispose
      ? { dispose: input.embeddedWorkPane.dispose }
      : {}),
  };
}
