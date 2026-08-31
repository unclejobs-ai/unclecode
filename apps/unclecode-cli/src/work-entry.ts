import pc from "picocolors";
import { pathToFileURL } from "node:url";

export {
  runWorkCli,
  loadResumedWorkSession,
  loadWorkShellDashboardProps,
  smokeWorkShellRuntime,
} from "./work-runtime.js";
import { runWorkCli } from "./work-runtime.js";
import { parseArgs } from "./work-runtime-args.js";

export async function resolveWorkEntrypointArgs(
  argv: readonly string[],
  input: {
    readonly stdinIsTTY: boolean;
    readonly readStdin: () => Promise<string>;
  },
): Promise<readonly string[] | undefined> {
  const parsed = parseArgs([...argv]);
  if (input.stdinIsTTY || parsed.prompt || parsed.showHelp || parsed.showTools) {
    return [...argv];
  }
  const prompt = await input.readStdin();
  return prompt.trim().length > 0 ? [...argv, prompt] : undefined;
}

async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main(): Promise<void> {
  const argv = await resolveWorkEntrypointArgs(process.argv.slice(2), {
    stdinIsTTY: process.stdin.isTTY ?? false,
    readStdin: readProcessStdin,
  });
  if (argv) await runWorkCli(argv);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${pc.red(`Error: ${message}`)}\n`);
    process.exitCode = 1;
  });
}
