#!/usr/bin/env node

import { shouldLaunchDefaultWorkSession } from "./startup-paths.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (
    shouldLaunchDefaultWorkSession({
      args,
      stdinIsTTY: process.stdin.isTTY ?? false,
      stdoutIsTTY: process.stdout.isTTY ?? false,
    })
  ) {
    await (await import("./interactive-shell.js")).launchWorkEntrypoint([]);
    return;
  }

  const { maybeRunFastCliPath } = await import("./fast-cli.js");
  if (await maybeRunFastCliPath(args)) {
    return;
  }

  const slashInput = args[0]?.startsWith("/") ? args.join(" ") : undefined;
  const routedArgs = slashInput
    ? (await import("./command-router.js")).routeSlashCommand(slashInput, {
        workspaceRoot: process.cwd(),
        ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
      })
    : args;
  const { createUncleCodeProgram } = await import("./program.js");
  const program = createUncleCodeProgram();

  if (routedArgs.length === 0) {
    program.outputHelp();
    return;
  }

  await program.parseAsync([process.argv[0] ?? "node", process.argv[1] ?? "unclecode", ...routedArgs]);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
