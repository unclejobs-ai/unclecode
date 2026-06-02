import {
  runWorkShellInlineCommand,
} from "@unclecode/orchestrator";
import {
  createManagedWorkShellDashboardProps,
  formatWorkShellError,
  renderManagedWorkShellDashboard,
  type EmbeddedWorkDashboardSnapshot,
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
): EmbeddedWorkDashboardSnapshot<TuiShellHomeState> {
  return createManagedWorkShellDashboardProps(
    createManagedDashboardInput(session, {
      resolveWorkShellInlineCommand,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    }),
  );
}

export function createWorkShellDashboardProps(
  agent: StartReplAgent,
  options: StartReplOptions,
): EmbeddedWorkDashboardSnapshot<TuiShellHomeState> {
  return createManagedDashboardProps({ agent, options });
}

export async function startRepl(
  agent: StartReplAgent,
  options: StartReplOptions,
): Promise<void> {
  const effectiveOptions: StartReplOptions = {
    ...options,
    launchWorkSession:
      options.launchWorkSession ??
      ((forwardedArgs: readonly string[] = []) => runWorkCli(forwardedArgs)),
  };

  await renderManagedWorkShellDashboard(
    createManagedDashboardInput(
      { agent, options: effectiveOptions },
      {
        resolveWorkShellInlineCommand,
        ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
      },
    ),
  );
}

export async function loadWorkShellDashboardProps(
  argv: readonly string[] = [],
): Promise<EmbeddedWorkDashboardSnapshot<TuiShellHomeState>> {
  const session = await loadWorkCliBootstrap({ argv });
  if (session.prompt) {
    throw new Error("Cannot build work-shell dashboard props for prompt mode.");
  }

  return createManagedDashboardProps(session);
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
  if (!researchLines.some((line) => /Research status|Latest research/i.test(line))) {
    throw new Error("Research status smoke did not return a status result.");
  }
  lines.push("Research status action connected");

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
