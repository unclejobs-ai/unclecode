import pc from "picocolors";
import { pathToFileURL } from "node:url";

export {
  runWorkCli,
  loadResumedWorkSession,
  loadWorkShellDashboardProps,
} from "./work-runtime.js";
import { runWorkCli } from "./work-runtime.js";

async function main(): Promise<void> {
  await runWorkCli(process.argv.slice(2));
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
