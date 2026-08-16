import { createEmbeddedWorkPaneController } from "@unclecode/tui";
import { runRustCommandSync } from "@unclecode/orchestrator";
import type {
  EmbeddedWorkDashboardSnapshot,
  EmbeddedWorkPaneRenderOptions,
} from "@unclecode/tui";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  EmbeddedWorkPaneLoadInput,
  TuiHomeState,
} from "./session-center-bootstrap.js";

const CLI_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));

type WorkShellDashboardSnapshot =
  EmbeddedWorkDashboardSnapshot<TuiHomeState>;

export type WorkModule = {
  runWorkCli?: (args: readonly string[]) => Promise<void>;
  loadWorkShellDashboardProps?: (
    args: readonly string[],
  ) => Promise<WorkShellDashboardSnapshot>;
  smokeWorkShellRuntime?: (args: readonly string[]) => Promise<readonly string[]>;
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
  readonly engine?: string;
  readonly tools?: boolean;
  readonly help?: boolean;
};

export function buildWorkCommandArgs(
  promptParts: readonly string[],
  options: WorkCommandArgOptions,
): string[] {
  return parseRustArgsArray(
    runRustCommandSync(
      ["rust", "work-runtime", "build-command-args"],
      process.cwd(),
      JSON.stringify({ promptParts, options }),
    ),
  );
}

export function withWorkCwd(
  forwardedArgs: readonly string[],
  callerCwd: string,
): readonly string[] {
  return parseRustArgsArray(
    runRustCommandSync(
      ["rust", "work-runtime", "with-cwd"],
      process.cwd(),
      JSON.stringify({ forwardedArgs, callerCwd }),
    ),
  );
}

export function resolveWorkEntrypointModuleUrls(): readonly string[] {
  return parseRustPathsArray(
    runRustCommandSync(
      ["rust", "work-runtime", "entrypoint-paths"],
      process.cwd(),
      JSON.stringify({ cliSourceDir: CLI_SOURCE_DIR }),
    ),
  ).map((entry) => pathToFileURL(entry).href);
}

export async function loadWorkEntrypointModule(
  moduleUrl?: string,
): Promise<WorkModule> {
  const moduleUrls = moduleUrl === undefined ? resolveWorkEntrypointModuleUrls() : [moduleUrl];
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

function parseRustArgsArray(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { args?: unknown }).args) ||
    !(parsed as { args: unknown[] }).args.every((item) => typeof item === "string")
  ) {
    throw new Error("Rust work-runtime command returned an invalid args payload.");
  }
  return (parsed as { args: string[] }).args;
}

function parseRustPathsArray(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { paths?: unknown }).paths) ||
    !(parsed as { paths: unknown[] }).paths.every((item) => typeof item === "string")
  ) {
    throw new Error("Rust work-runtime command returned an invalid paths payload.");
  }
  return (parsed as { paths: string[] }).paths;
}
