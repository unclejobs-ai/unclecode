import {
  explainUncleCodeConfig,
  formatUncleCodeConfigExplanation,
} from "@unclecode/config-core";
import {
  MODE_PROFILE_IDS,
  UNCLECODE_COMMAND_NAME,
} from "@unclecode/contracts";
import type { ModeProfileId } from "@unclecode/contracts";
import { loadExtensionConfigOverlays } from "@unclecode/orchestrator";
import {
  buildOpenAIAuthorizationUrl,
  clearOpenAICredentials,
  clearOpenAICodexCredentials,
  completeOpenAIBrowserLogin,
  completeOpenAICodexDeviceLogin,
  completeOpenAIDeviceLogin,
  createOpenAIPkcePair,
  formatEffectiveOpenAIAuthStatus,
  resolveEffectiveOpenAIAuthStatus,
  resolveReusableOpenAIOAuthClientId,
  writeOpenAICodexCredentials,
  writeOpenAICredentials,
} from "@unclecode/providers";
import { Command, Option } from "commander";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import {
  buildDoctorReport,
  buildDoctorReportData,
  buildMcpListReport,
  buildResearchStatusReport,
  buildResumeSummaryData,
  buildSetupReport,
  formatModeSetReport,
  formatModeStatusReport,
  formatSessionsReport,
  listSessions,
  persistProjectMode,
  runResearchPassData,
} from "./operational.js";
import {
  launchSessionCenter,
  launchWorkEntrypoint,
  shouldLaunchDefaultWorkSession,
  withWorkCwd,
} from "./interactive-shell.js";

const UNCLECODE_CLI_VERSION = "0.1.0";

async function waitForBrowserOAuthCallback(input: { redirectUri: string }): Promise<string> {
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

function getOpenAIApiCredentialsPath(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim() || path.join(os.homedir(), ".unclecode", "credentials", "openai.json");
}

function getOpenAICodexCredentialsPath(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_OPENAI_CODEX_CREDENTIALS_PATH?.trim() || path.join(os.homedir(), ".unclecode", "credentials", "openai-codex.json");
}

function formatOpenAIProviderDisplayName(providerId: "openai-api" | "openai-codex"): string {
  return providerId === "openai-codex" ? "OpenAI Codex" : "OpenAI API";
}

function formatLogoutResult(status: Awaited<ReturnType<typeof resolveEffectiveOpenAIAuthStatus>>): readonly string[] {
  if (status.activeSource === "none") {
    return ["Signed out.", "Auth: none"];
  }

  return ["Local credentials cleared.", `Auth: ${status.activeSource}`];
}

export { launchWorkEntrypoint, shouldLaunchDefaultWorkSession, withWorkCwd };

export function createUncleCodeProgram(): Command {
  const program = new Command();

  program
    .name(UNCLECODE_COMMAND_NAME)
    .description("UncleCode workspace shell")
    .version(UNCLECODE_CLI_VERSION)
    .showHelpAfterError();

  program.action(async () => {
    if (
      shouldLaunchDefaultWorkSession({
        args: process.argv.slice(2),
        stdinIsTTY: process.stdin.isTTY ?? false,
        stdoutIsTTY: process.stdout.isTTY ?? false,
      })
    ) {
      await launchWorkEntrypoint([]);
      return;
    }

    program.outputHelp();
  });

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
    .action(async (_promptParts: string[], options: { provider?: string; model?: string; reasoning?: string; cwd?: string; sessionId?: string; tools?: boolean; help?: boolean }) => {
      const forwardedArgs: string[] = [];
      if (options.help) forwardedArgs.push("--help");
      if (options.tools) forwardedArgs.push("--tools");
      if (options.cwd) forwardedArgs.push("--cwd", options.cwd);
      if (options.provider) forwardedArgs.push("--provider", options.provider);
      if (options.model) forwardedArgs.push("--model", options.model);
      if (options.reasoning) forwardedArgs.push("--reasoning", options.reasoning);
      if (options.sessionId) forwardedArgs.push("--session-id", options.sessionId);
      await launchWorkEntrypoint(forwardedArgs);
    });

  program
    .command("center")
    .description("Launch the secondary session center")
    .action(async () => {
      await launchSessionCenter({
        workspaceRoot: process.cwd(),
        env: process.env,
      });
    });

  const configCommand = program.command("config").description("Inspect effective UncleCode config");
  const authCommand = program.command("auth").description("Inspect and manage provider authentication");
  const workCommand = program.command("work [prompt...]").description("Launch the repo-local coding assistant entrypoint");
  const mcpCommand = program.command("mcp").description("Inspect configured MCP servers");
  const modeCommand = program.command("mode").description("Inspect and persist the active UncleCode mode");
  const researchCommand = program.command("research").description("Inspect and run research-mode flows");

  configCommand
    .command("explain")
    .description("Explain resolved settings, prompt sections, and active mode overlays")
    .addOption(
      new Option("--mode <mode>", "Override the active mode for this invocation").choices(
        MODE_PROFILE_IDS,
      ),
    )
    .option("--model <model>", "Override the configured model for this invocation")
    .action((options: { mode?: string; model?: string }) => {
      const cliFlags: {
        mode?: ModeProfileId;
        model?: string;
      } = {
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
    });

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
    .action(async (options: { browser?: boolean; device?: boolean; apiKeyStdin?: boolean; apiKey?: string; org?: string; project?: string; print?: boolean }) => {
      const apiCredentialsPath = getOpenAIApiCredentialsPath(process.env);
      const codexCredentialsPath = getOpenAICodexCredentialsPath(process.env);

      if (options.apiKey?.trim()) {
        throw new Error("Passing API keys on argv is disabled. Use `unclecode auth login --api-key-stdin` and pipe the key on stdin.");
      }

      if (options.apiKeyStdin) {
        if (options.browser || options.device) {
          throw new Error("Choose exactly one auth login method: OAuth browser, device login, or --api-key-stdin.");
        }

        const apiKey = await readApiKeyFromStdin();
        if (!apiKey) {
          throw new Error("No API key received on stdin.");
        }

        await writeOpenAICredentials({
          credentialsPath: apiCredentialsPath,
          credentials: {
            authType: "api-key",
            apiKey,
            organizationId: options.org?.trim() || null,
            projectId: options.project?.trim() || null,
          },
        });
        process.stdout.write("API key login saved.\n");
        process.stdout.write("Source: api-key-file\n");
        return;
      }

      const browserClientId = process.env.OPENAI_OAUTH_CLIENT_ID?.trim();
      const reusableClientId = await resolveReusableOpenAIOAuthClientId({ env: process.env });
      const deviceClientId = reusableClientId ?? browserClientId;
      const shouldUseDevice = Boolean(options.device || (!options.browser && !options.print && !browserClientId && deviceClientId));

      if (!browserClientId && !deviceClientId) {
        const status = await resolveEffectiveOpenAIAuthStatus({ env: process.env });
        if (status.activeSource !== "none" && !status.isExpired) {
          process.stdout.write("Saved auth found.\n");
          process.stdout.write(`Provider: ${formatOpenAIProviderDisplayName(status.providerId)}\n`);
          process.stdout.write(`Auth: ${status.activeSource}\n`);
          process.stdout.write("Use `unclecode auth status` to inspect it. The next model request will verify provider access.\n");
          return;
        }
        if (status.activeSource !== "none" && status.expiresAt === "insufficient-scope") {
          throw new Error("Saved OAuth was found but it lacks model.request scope for UncleCode API calls. Use unclecode auth login --api-key-stdin, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID.");
        }
        throw new Error("OPENAI_OAUTH_CLIENT_ID is required for OAuth login. Existing ~/.codex/auth.json is reused automatically when present.");
      }

      const redirectUri =
        process.env.OPENAI_OAUTH_REDIRECT_URI?.trim() || "http://localhost:7777/callback";

      if (options.browser || options.print) {
        if (!browserClientId) {
          throw new Error("Browser OAuth needs OPENAI_OAUTH_CLIENT_ID. Reused Codex auth can start device OAuth instead. Run `unclecode auth login --device`.");
        }
      }

      if (shouldUseDevice) {
        const deviceLoginClientId = deviceClientId!;
        const baseUrl = process.env.OPENAI_OAUTH_BASE_URL?.trim();

        process.stdout.write("Starting device login…\n");

        if (!browserClientId && reusableClientId) {
          await completeOpenAICodexDeviceLogin({
            clientId: deviceLoginClientId,
            credentialsPath: codexCredentialsPath,
            writeCredentials: async ({ credentialsPath, credentials }) => {
              if (!credentials || credentials.authType !== "oauth") {
                throw new Error("OpenAI Codex login only supports oauth credentials.");
              }
              await writeOpenAICodexCredentials({ credentialsPath, credentials });
            },
            ...(baseUrl ? { baseUrl } : {}),
            onDeviceCode: (info) => {
              process.stdout.write(`Please visit ${info.verificationUri} and enter code: ${info.userCode}\n`);
            },
          });
        } else {
          await completeOpenAIDeviceLogin({
            clientId: deviceLoginClientId,
            scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
            credentialsPath: apiCredentialsPath,
            ...(baseUrl ? { baseUrl } : {}),
            onDeviceCode: (info) => {
              process.stdout.write(`Please visit ${info.verificationUri} and enter code: ${info.userCode}\n`);
            },
          });
        }

        process.stdout.write(`Provider: ${!browserClientId && reusableClientId ? "OpenAI Codex" : "OpenAI API"}\n`);
        process.stdout.write("Login successful.\n");
        return;
      }

      const browserPkceClientId = browserClientId!;
      const pkce = createOpenAIPkcePair();
      const baseUrl = process.env.OPENAI_OAUTH_BASE_URL?.trim();
      const url = buildOpenAIAuthorizationUrl({
        clientId: browserPkceClientId,
        redirectUri,
        state: pkce.state,
        codeChallenge: pkce.codeChallenge,
        scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
        ...(baseUrl ? { baseUrl } : {}),
      });

      if (options.print) {
        process.stdout.write(`${url.toString()}\n`);
        return;
      }

      process.stdout.write(`${url.toString()}\n`);
      process.stdout.write(`Waiting for OAuth callback on ${redirectUri}\n`);

      const callbackUrl = await waitForBrowserOAuthCallback({ redirectUri });
      await completeOpenAIBrowserLogin({
        clientId: browserPkceClientId,
        redirectUri,
        callbackUrl,
        expectedState: pkce.state,
        codeVerifier: pkce.codeVerifier,
        credentialsPath: apiCredentialsPath,
        ...(baseUrl ? { baseUrl } : {}),
      });
      process.stdout.write("Login successful.\n");
    });

  workCommand
    .allowUnknownOption(true)
    .helpOption(false)
    .option("--provider <provider>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .option("--cwd <cwd>")
    .option("--session-id <sessionId>")
    .option("--tools")
    .option("--help")
    .action(async (promptParts: string[], options: { provider?: string; model?: string; reasoning?: string; cwd?: string; sessionId?: string; tools?: boolean; help?: boolean }, _command) => {
      const forwardedArgs: string[] = [];
      if (options.help) {
        forwardedArgs.push("--help");
      }
      if (options.tools) {
        forwardedArgs.push("--tools");
      }
      if (options.cwd) {
        forwardedArgs.push("--cwd", options.cwd);
      }
      if (options.provider) {
        forwardedArgs.push("--provider", options.provider);
      }
      if (options.model) {
        forwardedArgs.push("--model", options.model);
      }
      if (options.reasoning) {
        forwardedArgs.push("--reasoning", options.reasoning);
      }
      if (options.sessionId) {
        forwardedArgs.push("--session-id", options.sessionId);
      }
      forwardedArgs.push(...promptParts);
      await launchWorkEntrypoint(forwardedArgs);
    });

  authCommand
    .command("status")
    .description("Show OpenAI auth source, org/project context, and expiry state")
    .action(async () => {
      const status = await resolveEffectiveOpenAIAuthStatus({ env: process.env });

      process.stdout.write(`${formatEffectiveOpenAIAuthStatus(status)}\n`);
    });

  authCommand
    .command("logout")
    .description("Clear locally stored UncleCode auth credentials")
    .action(async () => {
      await clearOpenAICredentials({ credentialsPath: getOpenAIApiCredentialsPath(process.env) });
      await clearOpenAICodexCredentials({ credentialsPath: getOpenAICodexCredentialsPath(process.env) });
      const status = await resolveEffectiveOpenAIAuthStatus({ env: process.env });
      for (const line of formatLogoutResult(status)) {
        process.stdout.write(`${line}\n`);
      }
    });

  modeCommand
    .command("status")
    .description("Show the active mode and where it came from")
    .action(() => {
      process.stdout.write(
        `${formatModeStatusReport({ workspaceRoot: process.cwd(), env: process.env })}\n`,
      );
    });

  modeCommand
    .command("set <mode>")
    .description("Persist the active mode in the project config")
    .action(async (mode: string) => {
      if (!isModeProfileId(mode)) {
        throw new Error(`Unsupported mode: ${mode}`);
      }

      const configPath = await persistProjectMode(process.cwd(), mode);
      process.stdout.write(`${formatModeSetReport(mode, configPath)}\n`);
    });

  program
    .command("setup")
    .description("Show actionable setup guidance for auth, runtime, and workspace readiness")
    .action(async () => {
      process.stdout.write(
        `${await buildSetupReport({ workspaceRoot: process.cwd(), env: process.env })}\n`,
      );
    });

  program
    .command("doctor")
    .description("Report auth, runtime, session-store, and MCP readiness")
    .option("--verbose", "Print subsystem latency counters for support and debugging")
    .option("--json", "Print machine-readable doctor output with latency counters and thresholds")
    .action(async (options: { verbose?: boolean; json?: boolean }) => {
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
    });

  program
    .command("sessions")
    .description("List resumable local sessions for this workspace")
    .action(async () => {
      const items = await listSessions({ workspaceRoot: process.cwd(), env: process.env });
      process.stdout.write(`${formatSessionsReport(items)}\n`);
    });

  program
    .command("resume <sessionId>")
    .description("Resume a stored local session snapshot")
    .option("--verbose", "Collect resume latency instrumentation")
    .option("--json", "Print machine-readable resume output with latency counters and thresholds")
    .action(async (sessionId: string, options: { verbose?: boolean; json?: boolean }) => {
      const { lines, report } = await buildResumeSummaryData({
        workspaceRoot: process.cwd(),
        env: process.env,
        sessionId,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }

      if ((process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false)) {
        await launchSessionCenter({
          workspaceRoot: process.cwd(),
          env: process.env,
          initialSelectedSessionId: sessionId,
          contextLines: lines,
        });
        return;
      }

      process.stdout.write(`${lines.join("\n")}\n`);
    });

  researchCommand
    .command("status")
    .description("Show the current research-mode status")
    .action(async () => {
      const userHomeDir = process.env.HOME;
      process.stdout.write(
        `${await buildResearchStatusReport({
          workspaceRoot: process.cwd(),
          env: process.env,
          ...(userHomeDir ? { userHomeDir } : {}),
        })}\n`,
      );
    });

  researchCommand
    .command("run <prompt...>")
    .description("Run a linear local research pass and write an artifact")
    .option("--json", "Print machine-readable research output with latency counters and thresholds")
    .action(async (promptParts: string[], options: { json?: boolean }) => {
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
    });

  mcpCommand
    .command("list")
    .description("List merged MCP servers from user and project config")
    .action(() => {
      const userHomeDir = process.env.HOME;

      process.stdout.write(
        `${buildMcpListReport({
          workspaceRoot: process.cwd(),
          ...(userHomeDir ? { userHomeDir } : {}),
        })}\n`,
      );
    });

  return program;
}

function isModeProfileId(value: string | undefined): value is ModeProfileId {
  return value !== undefined && MODE_PROFILE_IDS.includes(value as ModeProfileId);
}
