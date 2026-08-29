import { runWorkShellInlineCommand } from "@unclecode/orchestrator";
import { randomUUID } from "node:crypto";
import {
  RuntimeOwnerClient,
  defaultRuntimeOwnerPaths,
  ensureRuntimeOwner,
  probeRuntimeOwner,
} from "@unclecode/server";
import {
  createEmbeddedWorkPaneController,
  createManagedWorkShellDashboardProps,
  formatWorkShellError,
  renderEmbeddedWorkShellPaneDashboard,
  type EmbeddedWorkDashboardSnapshot,
  type TuiRenderOptions,
  type TuiShellHomeState,
} from "@unclecode/tui";

import {
  parseArgs,
  printHelp,
  printTools,
} from "./work-runtime-args.js";
import {
  loadWorkCliBootstrap,
} from "./work-runtime-bootstrap.js";
import {
  createManagedDashboardInput,
  type ManagedDashboardSession,
  type StartReplAgent,
  type StartReplOptions,
} from "./work-runtime-dashboard.js";
import { createRemoteWorkShellEngine } from "./remote-work-shell-engine.js";
import { spawnDetachedRuntimeOwner } from "./runtime-owner-launcher.js";

export { loadWorkCliBootstrap } from "./work-runtime-bootstrap.js";
export { loadResumedWorkSession } from "./work-runtime-session.js";
export type { StartReplAgent, StartReplOptions } from "./work-runtime-dashboard.js";

export const resolveWorkShellInlineCommand = (
  args: readonly string[],
  runInlineCommand: (
    args: readonly string[],
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<readonly string[]>,
  onProgress?: ((line: string) => void) | undefined,
): Promise<{ readonly lines: readonly string[]; readonly failed: boolean }> =>
  runWorkShellInlineCommand(
    args,
    runInlineCommand,
    formatWorkShellError,
    onProgress,
  );

export function createManagedDashboardProps(
  session: ManagedDashboardSession,
  paneEngine?: object,
): TuiRenderOptions<TuiShellHomeState> {
  return createManagedWorkShellDashboardProps(
    {
      ...createManagedDashboardInput(withDefaultWorkSessionLaunch(session), {
      resolveWorkShellInlineCommand,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
      }),
      ...(paneEngine ? { paneEngine: paneEngine as never } : {}),
    },
  );
}

export function createWorkShellDashboardProps(
  agent: StartReplAgent,
  options: StartReplOptions,
): TuiRenderOptions<TuiShellHomeState> {
  return createManagedDashboardProps({ agent, options });
}

function withDefaultWorkSessionLaunch(
  session: ManagedDashboardSession,
): ManagedDashboardSession {
  return {
    agent: session.agent,
    options: {
      ...session.options,
      launchWorkSession:
        session.options.launchWorkSession ??
        ((forwardedArgs: readonly string[] = []) => runWorkCli(forwardedArgs)),
    },
  };
}

function withWorkSessionCwd(
  forwardedArgs: readonly string[],
  cwd: string,
): readonly string[] {
  if (forwardedArgs.includes("--cwd")) {
    return forwardedArgs;
  }
  return ["--cwd", cwd, ...forwardedArgs];
}

export async function startRepl(
  agent: StartReplAgent,
  options: StartReplOptions,
): Promise<void> {
  const requestedSessionId = options.sessionId ?? `work-${randomUUID()}`;
  const session = withDefaultWorkSessionLaunch({
    agent,
    options: {
      ...options,
      sessionId: requestedSessionId,
    },
  });
  const paths = defaultRuntimeOwnerPaths(process.env.HOME);
  const lease = await ensureRuntimeOwner({
    leasePath: paths.leasePath,
    lockPath: paths.lockPath,
    health: probeRuntimeOwner,
    startOwner: () => spawnDetachedRuntimeOwner({
      leasePath: paths.leasePath,
      tokenPath: paths.tokenPath,
    }),
  });
  const client = await RuntimeOwnerClient.connect(lease);
  const created = await client.createRuntimeSession({
    sessionId: requestedSessionId,
    projectPath: options.cwd,
    provider: options.provider,
    model: options.model,
    ...(options.reasoning.effort !== "unsupported" ? { reasoning: options.reasoning.effort } : {}),
    resume: options.sessionId !== undefined,
    idempotencyKey: `tui-${randomUUID()}`,
  });
  if (!created.ok) {
    throw new Error(created.message);
  }
  const attached = await client.attachRuntimeSession(created.session.sessionId);
  if (!attached.ok) throw new Error(attached.message);
  const ownerSessionId = attached.session.sessionId;
  const remoteEngine = await createRemoteWorkShellEngine(client, ownerSessionId);
  const initialProps = createManagedDashboardProps(
    { ...session, options: { ...session.options, sessionId: ownerSessionId } },
    remoteEngine,
  );
  const embeddedWorkPane = await createEmbeddedWorkPaneController<TuiShellHomeState>({
    loadSnapshot: async (forwardedArgs = []) => {
      if (forwardedArgs.length === 0) {
        return initialProps;
      }
      return loadWorkShellDashboardProps(
        withWorkSessionCwd(forwardedArgs, session.options.cwd),
      );
    },
  });

  await renderEmbeddedWorkShellPaneDashboard({
    ...initialProps,
    ...(embeddedWorkPane ?? {}),
  });
}

export async function loadWorkShellDashboardProps(
  argv: readonly string[] = [],
): Promise<EmbeddedWorkDashboardSnapshot<TuiShellHomeState>> {
  const session = await loadWorkCliBootstrap({ argv });
  if (session.prompt) {
    throw new Error("Cannot build work-shell dashboard props for prompt mode.");
  }

  const homeState = session.options.refreshHomeState
    ? await session.options.refreshHomeState()
    : session.options.homeState;
  return createManagedDashboardProps({
    ...session,
    options: {
      ...session.options,
      homeState,
    },
  });
}

export async function smokeWorkShellRuntime(
  argv: readonly string[] = [],
): Promise<readonly string[]> {
  const session = await loadWorkCliBootstrap({ argv });
  if (session.prompt) {
    throw new Error("Cannot smoke-test interactive TUI with a prompt.");
  }

  const input = createManagedDashboardInput(
    { agent: session.agent, options: {
      ...session.options,
      launchWorkSession:
        session.options.launchWorkSession ??
        ((forwardedArgs: readonly string[] = []) => runWorkCli(forwardedArgs)),
    } },
    {
      resolveWorkShellInlineCommand,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    },
  );
  const props = createManagedWorkShellDashboardProps(input);
  const lines = ["Work shell TUI smoke OK"];

  if (!props.renderWorkPane) {
    throw new Error("renderWorkPane is not connected.");
  }
  if (!props.runAction) {
    throw new Error("runAction is not connected.");
  }
  if (!props.runSession) {
    throw new Error("runSession is not connected.");
  }
  if (!props.launchWorkSession) {
    throw new Error("launchWorkSession is not connected.");
  }

  const mcpServerName = props.mcpServers?.[0]?.name;
  const mcpLines = await props.runAction({
    actionId: "mcp-inspect",
    ...(mcpServerName ? { prompt: mcpServerName } : {}),
  });
  if (!mcpLines.some((line) => /MCP server inspect|No MCP server selected/i.test(line))) {
    throw new Error("MCP inspect smoke did not return an inspect result.");
  }
  lines.push("MCP inspect action connected");

  const researchLines = await props.runAction({ actionId: "research-status" });
  if (!researchLines.some((line) => /Work context status|Context brief status|Latest context/i.test(line))) {
    throw new Error("Work context status smoke did not return a status result.");
  }
  lines.push("Work context status action connected");

  if (props.sessions?.[0]) {
    const resumeLines = await props.runSession(props.sessions[0].sessionId);
    if (!resumeLines.some((line) => /Resume|Resuming session|Workspace context|Context/i.test(line))) {
      throw new Error("History resume smoke did not return session context.");
    }
    lines.push("History resume action connected");
  } else {
    lines.push("History resume action connected (no saved sessions)");
  }

  return lines;
}

export async function runWorkCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const { showHelp, showTools } = parseArgs([...argv]);
  if (showHelp) {
    printHelp();
    return;
  }
  if (showTools) {
    printTools();
    return;
  }

  const session = await loadWorkCliBootstrap({ argv });
  if (session.prompt) {
    const result = await session.agent.runTurn(session.prompt);
    process.stdout.write(`${result.text}\n`);
    return;
  }

  await startRepl(session.agent, session.options);
}
