import path from "node:path";
import type { ReactNode } from "react";
import { fileURLToPath, pathToFileURL } from "node:url";

export { shouldLaunchDefaultWorkSession } from "./startup-paths.js";

const CLI_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CLI_SOURCE_DIR, "../../..");
const WORK_ENTRYPOINT = path.join(
  REPO_ROOT,
  "dist-work",
  "apps",
  "unclecode-cli",
  "src",
  "work-entry.js",
);

type WorkModule = {
  runWorkCli?: (args: readonly string[]) => Promise<void>;
  loadWorkShellDashboardProps?: (args: readonly string[]) => Promise<{
    renderWorkPane?: SessionCenterRenderOptions["renderWorkPane"];
  }>;
};

type OperationalModule = typeof import("./operational.js");
type TuiHomeState = Awaited<ReturnType<OperationalModule["buildTuiHomeState"]>>;

type SessionCenterRenderOptions = {
  readonly workspaceRoot: string;
  readonly modeLabel?: string;
  readonly initialView?: "work" | "sessions" | "mcp" | "research";
  readonly authLabel?: string;
  readonly sessionCount?: number;
  readonly mcpServerCount?: number;
  readonly mcpServers?: readonly { name: string; transport: string; scope: string; trustTier: string; originLabel: string }[];
  readonly latestResearchSessionId?: string | null;
  readonly latestResearchSummary?: string | null;
  readonly latestResearchTimestamp?: string | null;
  readonly researchRunCount?: number;
  readonly initialSelectedSessionId?: string | undefined;
  readonly sessions?: TuiHomeState["sessions"];
  readonly contextLines?: readonly string[];
  readonly bridgeLines?: readonly string[];
  readonly memoryLines?: readonly string[];
  readonly runAction?: ((input: { actionId: string; prompt?: string; onProgress?: ((line: string) => void) | undefined }) => Promise<readonly string[]>) | undefined;
  readonly runSession?: ((sessionId: string) => Promise<readonly string[]>) | undefined;
  readonly launchWorkSession?: ((forwardedArgs?: readonly string[]) => Promise<void>) | undefined;
  readonly renderWorkPane?: ((controls: {
    openSessions: () => void;
    syncHomeState: (homeState: Partial<TuiHomeState>) => void;
  }) => ReactNode) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiHomeState>) | undefined;
};

type SharedBootstrapDependencies = {
  readonly loadWorkModule?: (() => Promise<WorkModule>) | undefined;
  readonly buildHomeState?: OperationalModule["buildTuiHomeState"] | undefined;
  readonly renderShell?: ((options: SessionCenterRenderOptions) => Promise<void>) | undefined;
  readonly runAction?: OperationalModule["runTuiSessionCenterAction"] | undefined;
  readonly runSession?: OperationalModule["buildResumeSummary"] | undefined;
};

async function loadOperationalModule(): Promise<OperationalModule> {
  return import("./operational.js");
}

export function withWorkCwd(forwardedArgs: readonly string[], callerCwd: string): readonly string[] {
  if (forwardedArgs.includes("--cwd")) {
    return forwardedArgs;
  }

  return ["--cwd", callerCwd, ...forwardedArgs];
}

export async function loadWorkEntrypointModule(moduleUrl = pathToFileURL(WORK_ENTRYPOINT).href): Promise<WorkModule> {
  return import(moduleUrl) as Promise<WorkModule>;
}

export async function launchWorkEntrypoint(
  forwardedArgs: readonly string[],
  input?: {
    callerCwd?: string;
    loadModule?: (() => Promise<WorkModule>) | undefined;
  },
): Promise<void> {
  const argsWithCwd = withWorkCwd([...forwardedArgs], input?.callerCwd ?? process.cwd());
  const module = await (input?.loadModule ?? (() => loadWorkEntrypointModule()))();

  if (typeof module.runWorkCli !== "function") {
    throw new Error("work entrypoint does not export runWorkCli()");
  }

  await module.runWorkCli(argsWithCwd);
}

async function loadEmbeddedWorkPane(
  workspaceRoot: string,
  initialSelectedSessionId: string | undefined,
  loadWorkModule?: (() => Promise<WorkModule>) | undefined,
): Promise<Pick<SessionCenterRenderOptions, "renderWorkPane"> | undefined> {
  const module = await (loadWorkModule ?? (() => loadWorkEntrypointModule()))().catch(() => undefined);
  if (typeof module?.loadWorkShellDashboardProps !== "function") {
    return undefined;
  }

  const args = initialSelectedSessionId?.startsWith("work-")
    ? ["--cwd", workspaceRoot, "--session-id", initialSelectedSessionId]
    : ["--cwd", workspaceRoot];
  const props = await module.loadWorkShellDashboardProps(args);
  return props.renderWorkPane ? { renderWorkPane: props.renderWorkPane } : undefined;
}

export async function launchSessionCenter(
  input: {
    workspaceRoot?: string;
    env?: NodeJS.ProcessEnv;
    userHomeDir?: string | undefined;
    initialSelectedSessionId?: string | undefined;
    contextLines?: readonly string[] | undefined;
  } = {},
  deps?: SharedBootstrapDependencies,
): Promise<void> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const env = input.env ?? process.env;
  const userHomeDir = input.userHomeDir ?? env.HOME;
  const operational = deps?.buildHomeState && deps?.runAction && deps?.runSession
    ? undefined
    : await loadOperationalModule();
  const buildHomeState = deps?.buildHomeState ?? operational?.buildTuiHomeState;
  const renderShell = deps?.renderShell ?? (await import("@unclecode/tui")).renderTui;
  const runAction = deps?.runAction ?? operational?.runTuiSessionCenterAction;
  const runSession = deps?.runSession ?? operational?.buildResumeSummary;

  if (!buildHomeState || !runAction || !runSession) {
    throw new Error("interactive shell failed to load operational helpers");
  }

  const createHomeState = () =>
    buildHomeState({
      workspaceRoot,
      env,
      ...(userHomeDir ? { userHomeDir } : {}),
    });

  const homeState = await createHomeState();
  const embeddedWorkPane = await loadEmbeddedWorkPane(
    workspaceRoot,
    input.initialSelectedSessionId,
    deps?.loadWorkModule,
  );

  await renderShell({
    workspaceRoot,
    modeLabel: homeState.modeLabel,
    authLabel: homeState.authLabel,
    sessionCount: homeState.sessionCount,
    mcpServerCount: homeState.mcpServerCount,
    mcpServers: homeState.mcpServers,
    latestResearchSessionId: homeState.latestResearchSessionId,
    latestResearchSummary: homeState.latestResearchSummary,
    latestResearchTimestamp: homeState.latestResearchTimestamp,
    researchRunCount: homeState.researchRunCount,
    ...(input.initialSelectedSessionId ? { initialSelectedSessionId: input.initialSelectedSessionId } : {}),
    sessions: homeState.sessions,
    initialView: "sessions",
    contextLines: input.contextLines ?? [],
    bridgeLines: homeState.bridgeLines,
    memoryLines: homeState.memoryLines,
    runAction: ({ actionId, prompt, onProgress }) =>
      runAction({
        actionId,
        workspaceRoot,
        env,
        ...(prompt ? { prompt } : {}),
        ...(onProgress ? { onProgress } : {}),
        ...(userHomeDir ? { userHomeDir } : {}),
      }),
    runSession: (sessionId) =>
      runSession({
        workspaceRoot,
        env,
        sessionId,
      }),
    launchWorkSession: (forwardedArgs = []) =>
      launchWorkEntrypoint(forwardedArgs, {
        callerCwd: workspaceRoot,
        ...(deps?.loadWorkModule ? { loadModule: deps.loadWorkModule } : {}),
      }),
    ...(embeddedWorkPane?.renderWorkPane ? { renderWorkPane: embeddedWorkPane.renderWorkPane } : {}),
    refreshHomeState: createHomeState,
  });
}

export async function launchInteractiveSurface(
  input:
    | {
        kind: "work";
        forwardedArgs: readonly string[];
        callerCwd?: string | undefined;
      }
    | {
        kind: "center";
        workspaceRoot?: string | undefined;
        env?: NodeJS.ProcessEnv | undefined;
        userHomeDir?: string | undefined;
        initialSelectedSessionId?: string | undefined;
        contextLines?: readonly string[] | undefined;
      },
  deps?: SharedBootstrapDependencies,
): Promise<void> {
  if (input.kind === "work") {
    await launchWorkEntrypoint(input.forwardedArgs, {
      ...(input.callerCwd ? { callerCwd: input.callerCwd } : {}),
      ...(deps?.loadWorkModule ? { loadModule: deps.loadWorkModule } : {}),
    });
    return;
  }

  await launchSessionCenter(
    {
      ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.userHomeDir !== undefined ? { userHomeDir: input.userHomeDir } : {}),
      ...(input.initialSelectedSessionId !== undefined ? { initialSelectedSessionId: input.initialSelectedSessionId } : {}),
      ...(input.contextLines !== undefined ? { contextLines: input.contextLines } : {}),
    },
    deps,
  );
}
