import {
  explainUncleCodeConfig,
  formatUncleCodeConfigExplanation,
} from "@unclecode/config-core";
import {
  HARNESS_PRESET_IDS,
  applyHarnessPreset,
  formatHarnessExplainLines,
  formatHarnessStatusLines,
  inspectHarnessStatus,
  isHarnessPresetId,
} from "./harness.js";
import {
  MODE_PROFILE_IDS,
  UNCLECODE_COMMAND_NAME,
} from "@unclecode/contracts";
import type { ModeProfileId, PersonaId, TeamLaneRuntime } from "@unclecode/contracts";
import {
  loadExtensionConfigOverlays,
  runRustCommand,
  runRustCommandPassthrough,
  runRustCommandSync,
} from "@unclecode/orchestrator";
import {
  buildOpenAIAuthorizationUrl,
  completeOpenAIBrowserLogin,
  completeOpenAICodexDeviceLogin,
  completeOpenAIDeviceLogin,
  createOpenAIPkcePair,
  formatOpenAIAuthStatus,
  resolveOpenAIAuthStatus,
  resolveReusableOpenAIOAuthClientId,
} from "@unclecode/providers";
import { Command, Option } from "commander";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import {
  buildDoctorReport,
  buildDoctorReportData,
  addProjectMcpServer,
  buildMcpInspectReport,
  buildMcpListReport,
  buildResearchStatusReport,
  buildSetupReport,
  formatModeSetReport,
  formatModeStatusReport,
  formatSessionsReport,
  listSessions,
  persistProjectMode,
  removeProjectMcpServer,
  runResearchPassData,
} from "./operational.js";
import { shouldLaunchDefaultWorkSession } from "./startup-paths.js";
import { buildWorkCommandArgs, launchWorkEntrypoint } from "./work-bootstrap.js";

const UNCLECODE_CLI_VERSION = "0.1.0";

type BrowserOAuthCallbackInput = {
  readonly redirectUri: string;
};

type ResolvedOpenAIAuthStatus = Awaited<
  ReturnType<typeof resolveOpenAIAuthStatus>
>;

type WorkCommandOptions = {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly tools?: boolean;
  readonly help?: boolean;
  readonly smoke?: boolean;
};

type ConfigExplainCommandOptions = {
  readonly mode?: string;
  readonly model?: string;
};

type ConfigExplainCliFlags = {
  readonly mode?: ModeProfileId;
  readonly model?: string;
};

type AuthLoginCommandOptions = {
  readonly browser?: boolean;
  readonly device?: boolean;
  readonly apiKeyStdin?: boolean;
  readonly apiKey?: string;
  readonly org?: string;
  readonly project?: string;
  readonly print?: boolean;
};

type AuthLoginRuntimeContext = {
  readonly browserClientId?: string;
  readonly reusableClientId?: string;
  readonly deviceClientId?: string;
  readonly shouldUseDevice: boolean;
  readonly redirectUri: string;
  readonly baseUrl?: string;
};

type AuthLoginMethod = "api-key-stdin" | "device" | "browser" | "saved-auth";

type AuthLoginMethodSelection = {
  readonly method: AuthLoginMethod;
  readonly error?: string;
};

type ApiKeyStdinLoginInput = {
  readonly options: AuthLoginCommandOptions;
};

type DeviceAuthLoginInput = {
  readonly runtimeContext: AuthLoginRuntimeContext;
  readonly credentialsPath: string;
};

type BrowserAuthLoginInput = {
  readonly runtimeContext: AuthLoginRuntimeContext;
  readonly options: AuthLoginCommandOptions;
  readonly credentialsPath: string;
};

type DoctorCommandOptions = {
  readonly verbose?: boolean;
  readonly json?: boolean;
};

type ResumeCommandOptions = {
  readonly verbose?: boolean;
  readonly json?: boolean;
};

type ResearchRunCommandOptions = {
  readonly json?: boolean;
};

async function waitForBrowserOAuthCallback(input: BrowserOAuthCallbackInput): Promise<string> {
  const redirect = new URL(input.redirectUri);
  const hostname = redirect.hostname;
  const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
  const pathname = redirect.pathname || "/";

  return await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", input.redirectUri);
      if (requestUrl.pathname !== pathname) {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("UncleCode login received. You can return to the terminal.\n");
      server.close();
      resolve(requestUrl.toString());
    });

    server.on("error", reject);
    server.listen(port, hostname, () => undefined);
  });
}

async function readApiKeyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("`unclecode auth login --api-key-stdin` expects the API key on stdin.");
  }

  return await new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.once("end", () => resolve(raw.trim()));
    process.stdin.once("error", reject);
  });
}

function resolveOpenAICredentialsPath(): string {
  return process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim() ||
    path.join(os.homedir(), ".unclecode", "credentials", "openai.json");
}

async function resolveAuthLoginRuntimeContext(options: AuthLoginCommandOptions): Promise<AuthLoginRuntimeContext> {
  const browserClientId = process.env.OPENAI_OAUTH_CLIENT_ID?.trim();
  const reusableClientId = await resolveReusableOpenAIOAuthClientId({ env: process.env });
  const deviceClientId = reusableClientId ?? browserClientId;
  const shouldUseDevice = Boolean(
    options.device || (!options.browser && !options.print && !browserClientId && deviceClientId),
  );
  const redirectUri =
    process.env.OPENAI_OAUTH_REDIRECT_URI?.trim() || "http://localhost:7777/callback";
  const baseUrl = process.env.OPENAI_OAUTH_BASE_URL?.trim();

  return {
    ...(browserClientId ? { browserClientId } : {}),
    ...(reusableClientId ? { reusableClientId } : {}),
    ...(deviceClientId ? { deviceClientId } : {}),
    shouldUseDevice,
    redirectUri,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

async function handleApiKeyStdinLogin(input: ApiKeyStdinLoginInput): Promise<boolean> {
  if (input.options.apiKey?.trim()) {
    throw new Error("Passing API keys on argv is disabled. Use `unclecode auth login --api-key-stdin` and pipe the key on stdin.");
  }

  if (!input.options.apiKeyStdin) {
    return false;
  }

  if (input.options.browser || input.options.device) {
    throw new Error("Choose exactly one auth login method: OAuth browser, device login, or --api-key-stdin.");
  }

  const apiKey = await readApiKeyFromStdin();
  if (!apiKey) {
    throw new Error("No API key received on stdin.");
  }

  await runRustCommand(
    ["rust", "auth", "save-api-key", input.options.org?.trim() || "-", input.options.project?.trim() || "-"],
    process.cwd(),
    apiKey,
    process.env,
  );
  process.stdout.write("API key login saved.\n");
  process.stdout.write("Source: api-key-file\n");
  return true;
}

async function handleSavedAuthLogin(): Promise<boolean> {
  const status = await resolveOpenAIAuthStatus({ env: process.env });
  if (status.activeSource !== "none" && !status.isExpired) {
    process.stdout.write("Saved auth found.\n");
    process.stdout.write(`Auth: ${status.activeSource}\n`);
    process.stdout.write("Use `unclecode auth status` to inspect it. The next model request will verify provider access.\n");
    return true;
  }

  if (status.activeSource !== "none" && status.expiresAt === "insufficient-scope") {
    throw new Error("Saved OAuth was found but it lacks model.request scope for UncleCode API calls. Use unclecode auth login --api-key-stdin, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID.");
  }

  return false;
}

function selectAuthLoginMethod(options: AuthLoginCommandOptions, runtimeContext: AuthLoginRuntimeContext): AuthLoginMethodSelection {
  if (options.apiKeyStdin) {
    return { method: "api-key-stdin" };
  }

  if (!runtimeContext.browserClientId && !runtimeContext.deviceClientId) {
    return { method: "saved-auth" };
  }

  if ((options.browser || options.print) && !runtimeContext.browserClientId) {
    return {
      method: "browser",
      error: "Browser OAuth needs OPENAI_OAUTH_CLIENT_ID. Reused Codex auth can start device OAuth instead. Run `unclecode auth login --device`.",
    };
  }

  if (runtimeContext.shouldUseDevice) {
    return { method: "device" };
  }

  return { method: "browser" };
}

async function runDeviceAuthLogin(input: DeviceAuthLoginInput): Promise<void> {
  const deviceLoginClientId = input.runtimeContext.deviceClientId;
  if (!deviceLoginClientId) {
    throw new Error("Device OAuth requires a client id.");
  }

  process.stdout.write("Starting device login…\n");

  if (!input.runtimeContext.browserClientId && input.runtimeContext.reusableClientId) {
    await completeOpenAICodexDeviceLogin({
      clientId: deviceLoginClientId,
      credentialsPath: input.credentialsPath,
      ...(input.runtimeContext.baseUrl ? { baseUrl: input.runtimeContext.baseUrl } : {}),
      onDeviceCode: (info) => {
        process.stdout.write(`Please visit ${info.verificationUri} and enter code: ${info.userCode}\n`);
      },
    });
  } else {
    await completeOpenAIDeviceLogin({
      clientId: deviceLoginClientId,
      scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
      credentialsPath: input.credentialsPath,
      ...(input.runtimeContext.baseUrl ? { baseUrl: input.runtimeContext.baseUrl } : {}),
      onDeviceCode: (info) => {
        process.stdout.write(`Please visit ${info.verificationUri} and enter code: ${info.userCode}\n`);
      },
    });
  }

  process.stdout.write("Login successful.\n");
}

async function runBrowserAuthLogin(input: BrowserAuthLoginInput): Promise<void> {
  const browserPkceClientId = input.runtimeContext.browserClientId;
  if (!browserPkceClientId) {
    throw new Error("Browser OAuth needs OPENAI_OAUTH_CLIENT_ID. Reused Codex auth can start device OAuth instead. Run `unclecode auth login --device`.");
  }

  const pkce = createOpenAIPkcePair();
  const url = buildOpenAIAuthorizationUrl({
    clientId: browserPkceClientId,
    redirectUri: input.runtimeContext.redirectUri,
    state: pkce.state,
    codeChallenge: pkce.codeChallenge,
    scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
    ...(input.runtimeContext.baseUrl ? { baseUrl: input.runtimeContext.baseUrl } : {}),
  });

  if (input.options.print) {
    process.stdout.write(`${url.toString()}\n`);
    return;
  }

  process.stdout.write(`${url.toString()}\n`);
  process.stdout.write(`Waiting for OAuth callback on ${input.runtimeContext.redirectUri}\n`);

  const callbackUrl = await waitForBrowserOAuthCallback({
    redirectUri: input.runtimeContext.redirectUri,
  });
  await completeOpenAIBrowserLogin({
    clientId: browserPkceClientId,
    redirectUri: input.runtimeContext.redirectUri,
    callbackUrl,
    expectedState: pkce.state,
    codeVerifier: pkce.codeVerifier,
    credentialsPath: input.credentialsPath,
    ...(input.runtimeContext.baseUrl ? { baseUrl: input.runtimeContext.baseUrl } : {}),
  });
  process.stdout.write("Login successful.\n");
}

function formatLogoutResult(status: ResolvedOpenAIAuthStatus): readonly string[] {
  if (status.activeSource === "none") {
    return ["Signed out.", "Auth: none"];
  }

  return ["Local credentials cleared.", `Auth: ${status.activeSource}`];
}

async function handleRootCommand(program: Command): Promise<void> {
  if (
    shouldLaunchDefaultWorkSession({
      args: process.argv.slice(2),
      stdinIsTTY: process.stdin.isTTY ?? false,
      stdoutIsTTY: process.stdout.isTTY ?? false,
    })
  ) {
    process.exitCode = await runRustCommandPassthrough(
      ["work"],
      process.cwd(),
      process.env,
    );
    return;
  }

  program.outputHelp();
}

async function handleTuiSmokeCommand(options: WorkCommandOptions): Promise<void> {
  const { loadWorkEntrypointModule } = await import("./work-bootstrap.js");
  const module = await loadWorkEntrypointModule();
  if (typeof module.smokeWorkShellRuntime !== "function") {
    throw new Error("work entrypoint does not export smokeWorkShellRuntime()");
  }
  const lines = await module.smokeWorkShellRuntime(buildWorkCommandArgs([], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  }));
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function handleTuiCommand(options: WorkCommandOptions): Promise<void> {
  if (options.smoke) {
    await handleTuiSmokeCommand(options);
    return;
  }

  if (process.env.UNCLECODE_FORCE_TS_TUI === "1") {
    await launchWorkEntrypoint(buildWorkCommandArgs([], options), {
      callerCwd: process.cwd(),
    });
    return;
  }

  process.exitCode = await runRustCommandPassthrough(
    ["tui", ...buildWorkCommandArgs([], options)],
    process.cwd(),
    process.env,
  );
}

async function handleCenterCommand(args: string[] = []): Promise<void> {
  if (process.env.UNCLECODE_FORCE_TS_TUI === "1" && args.length === 0) {
    const { launchSessionCenter } = await import("./session-center-launcher.js");
    await launchSessionCenter({ workspaceRoot: process.cwd() });
    return;
  }

  process.stdout.write(
    await runRustCommand(["center", ...args], process.cwd(), undefined, process.env),
  );
}

async function handleWorkCommand(promptParts: string[], options: WorkCommandOptions): Promise<void> {
  process.exitCode = await runRustCommandPassthrough(
    ["work", ...buildWorkCommandArgs(promptParts, options)],
    process.cwd(),
    process.env,
  );
}

async function handleDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  if (options.json) {
    const { report } = await buildDoctorReportData({
      workspaceRoot: process.cwd(),
      env: process.env,
      verbose: true,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  process.stdout.write(
    `${await buildDoctorReport({ workspaceRoot: process.cwd(), env: process.env, ...(options.verbose ? { verbose: true } : {}) })}\n`,
  );
}

async function handleResumeCommand(sessionId: string, options: ResumeCommandOptions): Promise<void> {
  process.stdout.write(
    await runRustCommand(
      buildResumeCommandArgs(sessionId, options),
      process.cwd(),
      undefined,
      process.env,
    ),
  );
}

function buildResumeCommandArgs(sessionId: string, options: ResumeCommandOptions): string[] {
  return [
    "resume",
    sessionId,
    ...(options.verbose ? ["--verbose"] : []),
    ...(options.json ? ["--json"] : []),
  ];
}

async function handleResearchStatusCommand(): Promise<void> {
  const userHomeDir = process.env.HOME;
  process.stdout.write(
    `${await buildResearchStatusReport({
      workspaceRoot: process.cwd(),
      env: process.env,
      ...(userHomeDir ? { userHomeDir } : {}),
    })}\n`,
  );
}

async function handleResearchRunCommand(promptParts: string[], options: ResearchRunCommandOptions): Promise<void> {
  const userHomeDir = process.env.HOME;
  const { lines, report } = await runResearchPassData({
    workspaceRoot: process.cwd(),
    env: process.env,
    prompt: promptParts.join(" "),
    ...(userHomeDir ? { userHomeDir } : {}),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function handleConfigExplainCommand(options: ConfigExplainCommandOptions): void {
  const cliFlags: ConfigExplainCliFlags = {
    ...(isModeProfileId(options.mode) ? { mode: options.mode } : {}),
    ...(options.model ? { model: options.model } : {}),
  };

  const explanation = explainUncleCodeConfig({
    workspaceRoot: process.cwd(),
    env: process.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot: process.cwd(),
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    }),
    cliFlags,
  });

  process.stdout.write(`${formatUncleCodeConfigExplanation(explanation)}\n`);
}

async function handleAuthStatusCommand(): Promise<void> {
  const status = await resolveOpenAIAuthStatus({ env: process.env });
  process.stdout.write(`${formatOpenAIAuthStatus(status)}\n`);
}

async function handleAuthLogoutCommand(): Promise<void> {
  await runRustCommand(["rust", "auth", "logout"], process.cwd(), undefined, process.env);
  const status = await resolveOpenAIAuthStatus({ env: process.env });
  for (const line of formatLogoutResult(status)) {
    process.stdout.write(`${line}\n`);
  }
}

function handleModeStatusCommand(): void {
  process.stdout.write(
    `${formatModeStatusReport({ workspaceRoot: process.cwd(), env: process.env })}\n`,
  );
}

async function handleModeSetCommand(mode: string): Promise<void> {
  if (!isModeProfileId(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const configPath = await persistProjectMode(process.cwd(), mode);
  process.stdout.write(`${formatModeSetReport(mode, configPath)}\n`);
}

async function handleSetupCommand(): Promise<void> {
  process.stdout.write(
    `${await buildSetupReport({ workspaceRoot: process.cwd(), env: process.env })}\n`,
  );
}

async function handleSessionsCommand(): Promise<void> {
  const items = await listSessions({ workspaceRoot: process.cwd(), env: process.env });
  process.stdout.write(`${formatSessionsReport(items)}\n`);
}

function handleMcpListCommand(): void {
  const userHomeDir = process.env.HOME;

  process.stdout.write(
    `${buildMcpListReport({
      workspaceRoot: process.cwd(),
      ...(userHomeDir ? { userHomeDir } : {}),
    })}\n`,
  );
}

function handleMcpInspectCommand(serverName: string): void {
  const userHomeDir = process.env.HOME;

  process.stdout.write(
    `${buildMcpInspectReport({
      workspaceRoot: process.cwd(),
      serverName,
      ...(userHomeDir ? { userHomeDir } : {}),
    })}\n`,
  );
}

async function handleMcpAddCommand(parts: string[]): Promise<void> {
  const lines = await addProjectMcpServer({
    workspaceRoot: process.cwd(),
    prompt: parts.join(" "),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function handleMcpRemoveCommand(serverName: string): Promise<void> {
  const userHomeDir = process.env.HOME;
  const lines = await removeProjectMcpServer({
    workspaceRoot: process.cwd(),
    serverName,
    ...(userHomeDir ? { userHomeDir } : {}),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
}

function registerRootCommands(program: Command): void {
  program.action(async () => {
    await handleRootCommand(program);
  });

  program
    .command("center [args...]")
    .description("Launch the secondary session center")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[]) => {
      await handleCenterCommand(args);
    });

  program
    .command("setup")
    .description("Show actionable setup guidance for auth, runtime, and workspace readiness")
    .action(async () => {
      await handleSetupCommand();
    });

  program
    .command("doctor")
    .description("Report auth, runtime, session-store, and MCP readiness")
    .option("--verbose", "Print subsystem latency counters for support and debugging")
    .option("--json", "Print machine-readable doctor output with latency counters and thresholds")
    .action(async (options: DoctorCommandOptions) => {
      await handleDoctorCommand(options);
    });

  const sessionsCommand = program
    .command("sessions")
    .description("List resumable local sessions for this workspace")
    .action(async () => {
      await handleSessionsCommand();
    });

  sessionsCommand
    .command("fork <sessionId>")
    .description("Fork a session into a new session id; optionally truncate at a turn")
    .option("--at <turn>", "Truncate the forked transcript at this turn index (inclusive)")
    .action(async (sessionId: string, options: { at?: string }) => {
      const teamModule = await import("./sessions-fork-share.js");
      await teamModule.handleSessionFork(sessionId, options);
    });

  sessionsCommand
    .command("share <sessionId>")
    .description("Pack a compacted session transcript and emit a share slug + path")
    .option("--out <dir>", "Override output directory (default .unclecode/shares/)")
    .action(async (sessionId: string, options: { out?: string }) => {
      const teamModule = await import("./sessions-fork-share.js");
      await teamModule.handleSessionShare(sessionId, options);
    });

  program
    .command("resume <sessionId>")
    .description("Resume a stored local session snapshot")
    .option("--verbose", "Collect resume latency instrumentation")
    .option("--json", "Print machine-readable resume output with latency counters and thresholds")
    .action(async (sessionId: string, options: ResumeCommandOptions) => {
      await handleResumeCommand(sessionId, options);
    });
}

function registerWorkCommands(program: Command): void {
  program
    .command("tui")
    .description("Launch the interactive work shell")
    .allowUnknownOption(true)
    .helpOption(false)
    .option("--provider <provider>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .option("--cwd <cwd>")
    .option("--session-id <sessionId>")
    .option("--tools")
    .option("--help")
    .option("--smoke", "Run non-interactive TUI runtime smoke checks")
    .action(async (options: WorkCommandOptions) => {
      await handleTuiCommand(options);
    });

  program
    .command("work [prompt...]")
    .description("Launch the repo-local coding assistant entrypoint")
    .allowUnknownOption(true)
    .helpOption(false)
    .option("--provider <provider>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .option("--cwd <cwd>")
    .option("--session-id <sessionId>")
    .option("--tools")
    .option("--help")
    .action(async (promptParts: string[], options: WorkCommandOptions, _command) => {
      await handleWorkCommand(promptParts, options);
    });
}

function registerConfigCommands(program: Command): void {
  const configCommand = program.command("config").description("Inspect effective UncleCode config");

  configCommand
    .command("explain")
    .description("Explain resolved settings, prompt sections, and active mode overlays")
    .addOption(
      new Option("--mode <mode>", "Override the active mode for this invocation").choices(
        MODE_PROFILE_IDS,
      ),
    )
    .option("--model <model>", "Override the configured model for this invocation")
    .action((options: ConfigExplainCommandOptions) => {
      handleConfigExplainCommand(options);
    });
}

function registerAuthCommands(program: Command): void {
  const authCommand = program.command("auth").description("Inspect and manage provider authentication");

  authCommand
    .command("login")
    .description("Sign in with OpenAI OAuth or save an OpenAI API key")
    .option("--browser", "Generate a browser-based login URL")
    .option("--device", "Use device-code login")
    .option("--api-key-stdin", "Read an OpenAI API key from stdin and store it as local UncleCode auth")
    .addOption(new Option("--api-key <key>").hideHelp())
    .option("--org <org>", "Store default OpenAI organization context with an API key login")
    .option("--project <project>", "Store default OpenAI project context with an API key login")
    .option("--print", "Print the login URL explicitly (default browser behavior today)")
    .action(async (options: AuthLoginCommandOptions) => {
      const credentialsPath = resolveOpenAICredentialsPath();
      if (await handleApiKeyStdinLogin({ options })) {
        return;
      }

      const runtimeContext = await resolveAuthLoginRuntimeContext(options);
      if (!runtimeContext.browserClientId && !runtimeContext.deviceClientId) {
        if (await handleSavedAuthLogin()) {
          return;
        }
        throw new Error("OPENAI_OAUTH_CLIENT_ID is required for OAuth login. Existing ~/.codex/auth.json is reused automatically when present.");
      }

      const methodSelection = selectAuthLoginMethod(options, runtimeContext);
      if (methodSelection.error) {
        throw new Error(methodSelection.error);
      }

      if (methodSelection.method === "saved-auth") {
        if (await handleSavedAuthLogin()) {
          return;
        }
        throw new Error("OPENAI_OAUTH_CLIENT_ID is required for OAuth login. Existing ~/.codex/auth.json is reused automatically when present.");
      }

      if (methodSelection.method === "api-key-stdin") {
        return;
      }

      if (methodSelection.method === "device") {
        await runDeviceAuthLogin({ runtimeContext, credentialsPath });
        return;
      }

      await runBrowserAuthLogin({ runtimeContext, options, credentialsPath });
    });

  authCommand
    .command("status")
    .description("Show OpenAI auth source, org/project context, and expiry state")
    .action(async () => {
      await handleAuthStatusCommand();
    });

  authCommand
    .command("logout")
    .description("Clear locally stored UncleCode auth credentials")
    .action(async () => {
      await handleAuthLogoutCommand();
    });
}

function registerModeCommands(program: Command): void {
  const modeCommand = program.command("mode").description("Inspect and persist the active UncleCode mode");

  modeCommand
    .command("status")
    .description("Show the active mode and where it came from")
    .action(() => {
      handleModeStatusCommand();
    });

  modeCommand
    .command("set <mode>")
    .description("Persist the active mode in the project config")
    .action(async (mode: string) => {
      await handleModeSetCommand(mode);
    });
}

function registerResearchCommands(program: Command): void {
  const researchCommand = program.command("research").description("Refresh and inspect saved Work context");

  researchCommand
    .command("status")
    .description("Show the current Work context status")
    .action(async () => {
      await handleResearchStatusCommand();
    });

  researchCommand
    .command("run <prompt...>")
    .description("Refresh local Work context for a prompt")
    .option("--json", "Print machine-readable Work context output with latency counters and thresholds")
    .action(async (promptParts: string[], options: ResearchRunCommandOptions) => {
      await handleResearchRunCommand(promptParts, options);
    });
}

function registerMcpCommands(program: Command): void {
  const mcpCommand = program.command("mcp").description("Inspect configured MCP servers");

  mcpCommand
    .command("add <parts...>")
    .description("Add a stdio MCP server to this workspace .mcp.json")
    .action(async (parts: string[]) => {
      await handleMcpAddCommand(parts);
    });

  mcpCommand
    .command("remove <server>")
    .alias("rm")
    .description("Remove a workspace MCP server from .mcp.json")
    .action(async (serverName: string) => {
      await handleMcpRemoveCommand(serverName);
    });

  mcpCommand
    .command("list")
    .description("List merged MCP servers from user and project config")
    .action(() => {
      handleMcpListCommand();
    });

  mcpCommand
    .command("inspect <server>")
    .description("Inspect one configured MCP server without starting it")
    .action((serverName: string) => {
      handleMcpInspectCommand(serverName);
    });
}

export function createUncleCodeProgram(): Command {
  const program = new Command();

  program
    .name(UNCLECODE_COMMAND_NAME)
    .description("UncleCode workspace shell")
    .version(UNCLECODE_CLI_VERSION)
    .showHelpAfterError();

  registerRootCommands(program);
  registerWorkCommands(program);
  registerConfigCommands(program);
  registerAuthCommands(program);
  registerModeCommands(program);
  registerResearchCommands(program);
  registerMcpCommands(program);
  registerHarnessCommands(program);
  registerTeamCommands(program);

  return program;
}

function isModeProfileId(value: string | undefined): value is ModeProfileId {
  return value !== undefined && MODE_PROFILE_IDS.includes(value as ModeProfileId);
}

function registerHarnessCommands(program: Command): void {
  const harness = program.command("harness").description("Inspect and apply agent runtime harness presets");

  harness
    .command("status")
    .description("Show the current harness configuration from .codex/config.toml")
    .action(() => {
      const status = inspectHarnessStatus(process.cwd());
      for (const line of formatHarnessStatusLines(status)) {
        process.stdout.write(`${line}\n`);
      }
    });

  harness
    .command("explain")
    .description("Explain available harness presets and how they work")
    .action(() => {
      for (const line of formatHarnessExplainLines()) {
        process.stdout.write(`${line}\n`);
      }
    });

  harness
    .command("apply <preset>")
    .description("Apply a named harness preset (e.g. yolo)")
    .action(async (preset: string) => {
      if (!isHarnessPresetId(preset)) {
        process.stderr.write(`Unknown preset: ${preset}. Available: ${HARNESS_PRESET_IDS.join(", ")}\n`);
        process.exitCode = 1;
        return;
      }

      const status = inspectHarnessStatus(process.cwd());

      if (!status.exists) {
        process.stderr.write(`No .codex/config.toml found at ${status.configPath}\n`);
        process.stderr.write("Run 'unclecode harness init' or create the config first.\n");
        process.exitCode = 1;
        return;
      }

      const changes = applyHarnessPreset(process.cwd(), preset);
      for (const change of changes) {
        if (change.changed) {
          process.stdout.write(`  ${change.key} -> "${change.value}"\n`);
        } else {
          process.stdout.write(`  ${change.key} not found in config (skipped)\n`);
        }
      }

      process.stdout.write(`\n${preset} preset applied to ${status.configPath}\n`);

      const updated = inspectHarnessStatus(process.cwd());
      process.stdout.write("\nCurrent status:\n");
      for (const line of formatHarnessStatusLines(updated)) {
        process.stdout.write(`${line}\n`);
      }
    });
}

function registerTeamCommands(program: import("commander").Command): void {
  const team = program.command("team").description("Coordinate multi-agent team runs");

  team
    .command("run <objective...>")
    .description("Start a team run and record it under .data/team-runs/<runId>")
    .option("--persona <id>", "coder|builder|hardener|auditor|agentless-fix|agentless-then-agent|mini", "coder")
    .option(
      "--lanes <spec>",
      "Lane count (e.g. 4) or comma-list of lane specs (e.g. cursor,codex,opencode:anthropic/claude-sonnet-4-6,hermes::agent=codex)",
      "1",
    )
    .option("--gate <level>", "strict|warn|off", "strict")
    .option("--runtime <mode>", "local|docker|e2b", "local")
    .option("--record <runId>", "Force a specific RUN_ID (resume / external dispatch)")
    .option("--dispatch", "Spawn worker child processes after recording")
    .option("--worker-timeout <ms>", "Per-worker SIGKILL timeout (default 600000)", "600000")
    .option("--quiet", "Print only the RUN_ID on stdout")
    .action(async (objective: string[], options: { persona?: string; lanes?: string; gate?: string; runtime?: string; record?: string; dispatch?: boolean; workerTimeout?: string; quiet?: boolean }) => {
      const teamModule = await import("./team.js");
      await teamModule.handleTeamRun(objective, options);
    });

  team
    .command("worker")
    .description("Worker child entry — bound to UNCLECODE_TEAM_RUN_ID/ROOT")
    .requiredOption("--persona <id>", "coder|builder|hardener|auditor|agentless-fix|agentless-then-agent|mini")
    .requiredOption("--worker-id <id>", "Stable worker id within the run")
    .requiredOption("--task <text>", "Task description handed to the persona")
    .option("--runtime <id>", "Lane runtime (openai|anthropic|gemini|cursor|codex|opencode|glm|hermes)", "openai")
    .option("--model <id>", "Override model identifier passed to the lane adapter")
    .option("--extras <json>", "Per-lane extras as a JSON object (e.g. '{\"channel\":\"#review\"}')")
    .action(
      async (options: {
        persona: string;
        workerId: string;
        task: string;
        runtime?: string;
        model?: string;
        extras?: string;
      }) => {
        const workerModule = await import("./team-worker.js");
        const { handleTeamWorker } = workerModule;
        const resolved = resolveTeamWorkerOptions(options);
        await handleTeamWorker({
          persona: resolved.persona,
          workerId: resolved.workerId,
          task: resolved.task,
          runtime: resolved.runtime,
          ...(resolved.model !== undefined ? { model: resolved.model } : {}),
          ...(resolved.extras !== undefined ? { extras: resolved.extras } : {}),
        });
      },
    );

  team
    .command("ls")
    .description("List recorded team runs")
    .action(async () => {
      const teamModule = await import("./team.js");
      teamModule.handleTeamList();
    });

  team
    .command("status [runId]")
    .description("Show the latest run status, or a specific runId")
    .action(async (runId?: string) => {
      const teamModule = await import("./team.js");
      teamModule.handleTeamStatus(runId);
    });

  team
    .command("inspect <runId>")
    .description("Print run details and optionally verify the hash chain")
    .option("--verify", "Replay sha256 chain and report tampered lines")
    .action(async (runId: string, options: { verify?: boolean }) => {
      const teamModule = await import("./team.js");
      teamModule.handleTeamInspect(runId, options);
    });

  team
    .command("abort <runId>")
    .description("Append an aborted checkpoint to the run log")
    .action(async (runId: string) => {
      const teamModule = await import("./team.js");
      teamModule.handleTeamAbort(runId);
    });

  team
    .command("doctor")
    .description("Preflight every lane runtime — show which lanes are usable on this machine")
    .action(async () => {
      const teamModule = await import("./team.js");
      teamModule.handleTeamDoctor();
    });
}

type ResolvedTeamWorkerOptions = {
  readonly persona: PersonaId;
  readonly workerId: string;
  readonly task: string;
  readonly runtime: TeamLaneRuntime;
  readonly model?: string;
  readonly extras?: Readonly<Record<string, string>>;
};

function resolveTeamWorkerOptions(options: {
  readonly persona: string;
  readonly workerId: string;
  readonly task: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly extras?: string;
}): ResolvedTeamWorkerOptions {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "worker-options"],
      process.cwd(),
      JSON.stringify({ options }),
    ),
  ) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Rust team worker options returned invalid payload");
  }
  if (
    typeof parsed.persona !== "string"
    || typeof parsed.workerId !== "string"
    || typeof parsed.task !== "string"
    || typeof parsed.runtime !== "string"
    || (parsed.model !== undefined && typeof parsed.model !== "string")
    || (parsed.extras !== undefined && !isStringRecord(parsed.extras))
  ) {
    throw new Error("Rust team worker options returned invalid fields");
  }
  return {
    persona: parsed.persona as PersonaId,
    workerId: parsed.workerId,
    task: parsed.task,
    runtime: parsed.runtime as TeamLaneRuntime,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.extras !== undefined ? { extras: parsed.extras } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
