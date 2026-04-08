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
  await renderManagedWorkShellDashboard(
    createManagedDashboardInput(
      { agent, options },
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
