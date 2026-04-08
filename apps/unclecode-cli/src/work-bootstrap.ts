import { createEmbeddedWorkPaneController } from "@unclecode/tui";
import type {
  EmbeddedWorkDashboardSnapshot,
  EmbeddedWorkPaneRenderOptions,
} from "@unclecode/tui";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  EmbeddedWorkPaneLoadInput,
  TuiHomeState,
} from "./session-center-bootstrap.js";

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
const LOCAL_DIST_DIR = path.basename(CLI_SOURCE_DIR) === "dist"
  ? CLI_SOURCE_DIR
  : path.resolve(CLI_SOURCE_DIR, "../dist");
const LOCAL_DIST_WORK_ENTRYPOINT = path.join(LOCAL_DIST_DIR, "work-entry.js");

type WorkShellDashboardSnapshot =
  EmbeddedWorkDashboardSnapshot<TuiHomeState>;

export type WorkModule = {
  runWorkCli?: (args: readonly string[]) => Promise<void>;
  loadWorkShellDashboardProps?: (
    args: readonly string[],
  ) => Promise<WorkShellDashboardSnapshot>;
};

export type WorkLaunchInput = {
  readonly callerCwd?: string;
  readonly loadModule?: (() => Promise<WorkModule>) | undefined;
};

export type WorkCommandArgOptions = {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly tools?: boolean;
  readonly help?: boolean;
};

export function buildWorkCommandArgs(
  promptParts: readonly string[],
  options: WorkCommandArgOptions,
): string[] {
  const forwardedArgs: string[] = [];
  if (options.help) forwardedArgs.push("--help");
  if (options.tools) forwardedArgs.push("--tools");
  if (options.cwd) forwardedArgs.push("--cwd", options.cwd);
  if (options.provider) forwardedArgs.push("--provider", options.provider);
  if (options.model) forwardedArgs.push("--model", options.model);
  if (options.reasoning) forwardedArgs.push("--reasoning", options.reasoning);
  if (options.sessionId) forwardedArgs.push("--session-id", options.sessionId);
  forwardedArgs.push(...promptParts);
  return forwardedArgs;
}

export function withWorkCwd(
  forwardedArgs: readonly string[],
  callerCwd: string,
): readonly string[] {
  if (forwardedArgs.includes("--cwd")) {
    return forwardedArgs;
  }

  return ["--cwd", callerCwd, ...forwardedArgs];
}

export function resolveWorkEntrypointModuleUrls(): readonly string[] {
  return [WORK_ENTRYPOINT, LOCAL_DIST_WORK_ENTRYPOINT]
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .filter((entry) => existsSync(entry))
    .map((entry) => pathToFileURL(entry).href);
}

export async function loadWorkEntrypointModule(
  moduleUrl = pathToFileURL(WORK_ENTRYPOINT).href,
): Promise<WorkModule> {
  const moduleUrls = moduleUrl === pathToFileURL(WORK_ENTRYPOINT).href
    ? resolveWorkEntrypointModuleUrls()
    : [moduleUrl];
  let lastError: unknown;

  for (const candidateUrl of moduleUrls) {
    try {
      return await import(candidateUrl) as Promise<WorkModule>;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Unable to load any built work entrypoint module.");
}

function resolveWorkModuleLoader(
  loadModule?: (() => Promise<WorkModule>) | undefined,
): () => Promise<WorkModule> {
  return loadModule ?? (() => loadWorkEntrypointModule());
}

export async function launchWorkEntrypoint(
  forwardedArgs: readonly string[],
  input?: WorkLaunchInput,
): Promise<void> {
  const argsWithCwd = withWorkCwd(
    [...forwardedArgs],
    input?.callerCwd ?? process.cwd(),
  );
  const loadModule = resolveWorkModuleLoader(input?.loadModule);
  const module = await loadModule();

  if (typeof module.runWorkCli !== "function") {
    throw new Error("work entrypoint does not export runWorkCli()");
  }

  await module.runWorkCli(argsWithCwd);
}

export async function loadEmbeddedWorkPane(input: EmbeddedWorkPaneLoadInput<WorkModule>): Promise<EmbeddedWorkPaneRenderOptions<TuiHomeState> | undefined> {
  const loadModule = resolveWorkModuleLoader(input.loadWorkModule);
  const module = await loadModule().catch(() => undefined);
  if (typeof module?.loadWorkShellDashboardProps !== "function") {
    return undefined;
  }

  return createEmbeddedWorkPaneController<TuiHomeState>({
    ...(input.initialSelectedSessionId !== undefined
      ? { initialSelectedSessionId: input.initialSelectedSessionId }
      : {}),
    loadSnapshot: async (forwardedArgs = []) =>
      module.loadWorkShellDashboardProps?.(
        withWorkCwd(forwardedArgs, input.workspaceRoot),
      ),
  });
}
