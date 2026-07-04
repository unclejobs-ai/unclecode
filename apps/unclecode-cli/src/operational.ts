import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  listProjectBridgeLines,
  listScopedMemoryLines,
} from "@unclecode/context-broker";
import {
  MCP_HOST_SUPPORTED_TRANSPORTS,
  loadMcpHostRegistry,
} from "@unclecode/mcp-host";
import { loadExtensionConfigOverlays, loadExtensionManifestSummaries, runRustCommand, runRustCommandSync } from "@unclecode/orchestrator";
import type { ModeProfileId } from "@unclecode/contracts";
import { MODE_PROFILE_IDS, MODE_PROFILES } from "@unclecode/contracts";
import {
  buildOpenAIAuthorizationUrl,
  completeOpenAIBrowserLogin,
  completeOpenAICodexDeviceLogin,
  createOpenAIPkcePair,
  formatOpenAIAuthStatus,
  requestOpenAICodexDeviceAuthorization,
  requestOpenAIDeviceAuthorization,
  resolveOpenAIAuthStatus,
  resolveReusableOpenAIOAuthClientId,
  type OpenAIAuthStatus,
} from "@unclecode/providers";
import { createRuntimeBroker } from "@unclecode/runtime-broker";
import {
  createSessionStore,
  getSessionStoreRoot,
  getRunStatusFromCheckpoints,
  readTeamCheckpoints,
  readTeamRunManifest,
  verifyTeamRunChain,
} from "@unclecode/session-store";
import { listTeamRuns } from "@unclecode/orchestrator";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import { workShellAuthLabelWithApiBlocked } from "./work-runtime-session.js";

type PersistedProjectConfig = {
  readonly mode?: ModeProfileId;
  readonly [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModeProfileId(value: string): value is ModeProfileId {
  return MODE_PROFILE_IDS.includes(value as ModeProfileId);
}


export function getProjectConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".unclecode", "config.json");
}

function formatAuthLogoutLines(status: Awaited<ReturnType<typeof resolveOpenAIAuthStatus>>): readonly string[] {
  if (status.activeSource === "none") {
    return ["Signed out.", "Auth: none"];
  }

  return ["Local credentials cleared.", `Auth: ${status.activeSource}`];
}

async function readPersistedProjectConfig(workspaceRoot: string): Promise<PersistedProjectConfig> {
  const configPath = getProjectConfigPath(workspaceRoot);

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Project config must be a JSON object.");
    }

    return parsed as PersistedProjectConfig;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function persistProjectMode(workspaceRoot: string, mode: ModeProfileId): Promise<string> {
  const configPath = getProjectConfigPath(workspaceRoot);
  const currentConfig = await readPersistedProjectConfig(workspaceRoot);

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ ...currentConfig, mode }, null, 2)}\n`,
    "utf8",
  );

  return configPath;
}

export function formatModeStatusReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  const explanation = explainUncleCodeConfig({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot: input.workspaceRoot,
      ...(input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
    }),
  });

  return [
    `Active mode: ${explanation.activeMode.id}`,
    `Label: ${explanation.activeMode.label}`,
    `Source: ${explanation.settings.mode.winner.sourceLabel}`,
    `Editing: ${explanation.activeMode.editing}`,
    `Search depth: ${explanation.activeMode.searchDepth}`,
    `Background tasks: ${explanation.activeMode.backgroundTasks}`,
    `Explanation style: ${explanation.activeMode.explanationStyle}`,
  ].join("\n");
}

export function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

import {
  buildMmbridgeContextSummary,
  buildMmbridgeDoctorReport,
  buildMmbridgeGateReport,
  buildMmbridgeHandoffReport,
  buildMmbridgeHealthReport,
  buildMmbridgeReviewReport,
  runMmbridgeMcpHealthCheck,
  runMmbridgeMcpTool,
} from "./mmbridge-mcp.js";

const DOCTOR_LATENCY_THRESHOLDS = {
  configMsBudget: 100,
  authMsBudget: 50,
  runtimeMsBudget: 25,
  sessionStoreMsBudget: 50,
  mcpMsBudget: 50,
  totalMsBudget: 500,
} as const;

const RESUME_LATENCY_THRESHOLDS = {
  resumeMsBudget: 600,
} as const;

export async function buildDoctorReportData(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verbose?: boolean;
}): Promise<{
  readonly lines: readonly string[];
  readonly report: {
    readonly command: "doctor";
    readonly verbose: boolean;
    readonly workspaceRoot: string;
    readonly verdicts: {
      readonly mode: "PASS";
      readonly auth: "PASS" | "WARN";
      readonly runtime: "PASS" | "WARN";
      readonly sessionStore: "PASS";
      readonly mcpHost: "PASS";
    };
    readonly labels: {
      readonly mode: string;
      readonly auth: string;
      readonly runtime: string;
      readonly sessionStore: string;
      readonly mcpHost: string;
    };
    readonly metrics: {
      readonly configMs: number;
      readonly authMs: number;
      readonly runtimeMs: number;
      readonly sessionStoreMs: number;
      readonly mcpMs: number;
      readonly totalMs: number;
    };
    readonly thresholds: typeof DOCTOR_LATENCY_THRESHOLDS;
  };
}> {
  const totalStartedAt = Date.now();

  const configStartedAt = Date.now();
  const explanation = explainUncleCodeConfig({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot: input.workspaceRoot,
      ...(input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
    }),
  });
  const configMs = elapsedSince(configStartedAt);

  const authStartedAt = Date.now();
  const authStatus = await resolveOpenAIAuthStatus({ env: input.env });
  const authMs = elapsedSince(authStartedAt);

  const runtimeStartedAt = Date.now();
  const runtimeHealth = createRuntimeBroker({
    workingDirectory: input.workspaceRoot,
    runtimeMode: "local",
  }).health();
  const runtimeMs = elapsedSince(runtimeStartedAt);

  const sessionStoreStartedAt = Date.now();
  const sessionStoreRoot = getSessionStoreRoot(input.env);
  await mkdir(sessionStoreRoot, { recursive: true });

  const sessionStore = createSessionStore({ rootDir: sessionStoreRoot });
  sessionStore.getSessionPaths({
    projectPath: input.workspaceRoot,
    sessionId: "doctor-probe",
  });
  const sessionStoreMs = elapsedSince(sessionStoreStartedAt);

  const mcpStartedAt = Date.now();
  const mcpRegistry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
  });
  const mcpMs = elapsedSince(mcpStartedAt);

  const runtimeAdapter = runtimeHealth.adapters.find((adapter) => adapter.mode === "local");
  const authLabel = `${authStatus.activeSource} (${authStatus.authType})`;
  const modeLabel = `${explanation.activeMode.id} (${explanation.settings.mode.winner.sourceLabel})`;
  const runtimeLabel = runtimeAdapter?.available ? "local available" : "local unavailable";
  const authVerdict = authStatus.activeSource === "none" || authStatus.isExpired ? "WARN" : "PASS";
  const runtimeVerdict = runtimeAdapter?.available ? "PASS" : "WARN";
  const mcpLabel = `${mcpRegistry.entries.length} servers; transports ${MCP_HOST_SUPPORTED_TRANSPORTS.join(", ")}`;
  const totalMs = elapsedSince(totalStartedAt);

  const teamSummary = await summarizeTeamRunsForDoctor(input.workspaceRoot);

  const lines = [
    "Doctor report",
    `Mode           PASS  ${modeLabel}`,
    `Auth           ${authVerdict}  ${authLabel}`,
    `Runtime        ${runtimeVerdict}  ${runtimeLabel}`,
    `Session store  PASS  ${sessionStoreRoot}`,
    `MCP host       PASS  ${mcpLabel}`,
    `Team runs      ${teamSummary.verdict}  ${teamSummary.label}`,
    ...(input.verbose
      ? [
          "",
          "Latency counters",
          `configMs=${configMs}`,
          `authMs=${authMs}`,
          `runtimeMs=${runtimeMs}`,
          `sessionStoreMs=${sessionStoreMs}`,
          `mcpMs=${mcpMs}`,
          `totalMs=${totalMs}`,
        ]
      : []),
  ] as const;

  return {
    lines,
    report: {
      command: "doctor",
      verbose: input.verbose ?? false,
      workspaceRoot: input.workspaceRoot,
      verdicts: {
        mode: "PASS",
        auth: authVerdict,
        runtime: runtimeVerdict,
        sessionStore: "PASS",
        mcpHost: "PASS",
      },
      labels: {
        mode: modeLabel,
        auth: authLabel,
        runtime: runtimeLabel,
        sessionStore: sessionStoreRoot,
        mcpHost: mcpLabel,
      },
      metrics: {
        configMs,
        authMs,
        runtimeMs,
        sessionStoreMs,
        mcpMs,
        totalMs,
      },
      thresholds: DOCTOR_LATENCY_THRESHOLDS,
    },
  };
}

export async function buildDoctorReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verbose?: boolean;
}): Promise<string> {
  const { lines } = await buildDoctorReportData(input);
  return lines.join("\n");
}

export async function buildSetupReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  const authStatus = await resolveOpenAIAuthStatus({ env: input.env });
  const runtimeHealth = createRuntimeBroker({
    workingDirectory: input.workspaceRoot,
    runtimeMode: "local",
  }).health();
  const runtimeAdapter = runtimeHealth.adapters.find((adapter) => adapter.mode === "local");
  const sessionStoreRoot = getSessionStoreRoot(input.env);
  await mkdir(sessionStoreRoot, { recursive: true });

  const authReady = authStatus.activeSource !== "none" && !authStatus.isExpired;
  const runtimeReady = runtimeAdapter?.available ?? false;

  return [
    "Setup guide",
    `Workspace: ${input.workspaceRoot}`,
    `Auth: ${authReady ? `ready (${authStatus.activeSource})` : "missing"}`,
    `Runtime: ${runtimeReady ? "local available" : "local unavailable"}`,
    `Session store: ${sessionStoreRoot}`,
    `Project config: ${getProjectConfigPath(input.workspaceRoot)}`,
    "Next steps:",
    authReady
      ? "1. Auth is ready. You can continue with `unclecode doctor` or `unclecode`."
      : "1. Set OPENAI_API_KEY, save API-key credentials with `unclecode auth login --api-key-stdin [--org <id>] [--project <id>]`, or run `OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser` for API-ready OAuth. Existing Codex auth (`~/.codex/auth.json`) may be detected for sign-in, but it is not proof of OpenAI API readiness.",
    "2. Run `unclecode doctor` to verify auth, runtime, session-store, and MCP readiness.",
    "3. Run `unclecode mode status` to confirm the active operating profile before starting work.",
  ].join("\n");
}

export function formatModeSetReport(mode: ModeProfileId, configPath: string): string {
  return [
    `Active mode saved: ${mode}`,
    `Label: ${MODE_PROFILES[mode].label}`,
    `Config path: ${configPath}`,
  ].join("\n");
}

export type SessionListItem = {
  readonly sessionId: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly taskSummary: string | null;
  readonly mode: string | null;
  readonly pendingAction: string | null;
  readonly worktreeBranch: string | null;
};

export type TuiHomeState = {
  readonly modeLabel: string;
  readonly authLabel: string;
  readonly sessions: readonly SessionListItem[];
  readonly sessionCount: number;
  readonly mcpServerCount: number;
  readonly mcpServers: readonly {
    name: string;
    transport: string;
    scope: string;
    trustTier: string;
    originLabel: string;
  }[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
};

function workShellAuthLabelFromOpenAIStatus(status: OpenAIAuthStatus): string {
  return workShellAuthLabelWithApiBlocked(status.activeSource, status);
}

async function readCheckpointFile(pathToFile: string): Promise<SessionListItem | null> {
  try {
    const raw = await readFile(pathToFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.sessionId !== "string" || typeof parsed.updatedAt !== "string") {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      state: typeof parsed.state === "string" ? parsed.state : "unknown",
      updatedAt: parsed.updatedAt,
      model:
        isRecord(parsed.metadata) && typeof parsed.metadata.model === "string"
          ? parsed.metadata.model
          : null,
      taskSummary:
        isRecord(parsed.taskSummary) && typeof parsed.taskSummary.summary === "string"
          ? parsed.taskSummary.summary
          : null,
      mode: parsed.mode === "coordinator" || parsed.mode === "normal" ? parsed.mode : null,
      pendingAction:
        isRecord(parsed.pendingAction) && typeof parsed.pendingAction.toolName === "string"
          ? parsed.pendingAction.toolName
          : null,
      worktreeBranch:
        isRecord(parsed.worktree) && typeof parsed.worktree.worktreeBranch === "string"
          ? parsed.worktree.worktreeBranch
          : null,
    };
  } catch {
    return null;
  }
}

export async function listSessions(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<readonly SessionListItem[]> {
  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(input.env) });
  const probePaths = sessionStore.getSessionPaths({
    projectPath: input.workspaceRoot,
    sessionId: "session-list-probe",
  });

  try {
    const entries = await readdir(probePaths.sessionDir, { withFileTypes: true });
    const checkpoints = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".checkpoint.json"))
        .map((entry) => readCheckpointFile(path.join(probePaths.sessionDir, entry.name))),
    );

    return checkpoints
      .filter((item): item is SessionListItem => item !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function buildTuiHomeState(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
}): Promise<TuiHomeState> {
  const explanation = explainUncleCodeConfig({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot: input.workspaceRoot,
      ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
    }),
  });
  const authStatus = await resolveOpenAIAuthStatus({ env: input.env });
  const sessions = await listSessions(input);
  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const [bridgeLines, memoryLines] = await Promise.all([
    listProjectBridgeLines(input.workspaceRoot, input.env),
    listScopedMemoryLines({
      scope: "project",
      cwd: input.workspaceRoot,
      env: input.env,
    }),
  ]);
  const extensionSummaryLines = loadExtensionManifestSummaries({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
  })
    .slice(0, 2)
    .flatMap((extension) => extension.statusLines.slice(0, 2).map((line) => `Extension ${extension.name} · ${line}`));

  return {
    modeLabel: explanation.activeMode.id,
    authLabel: workShellAuthLabelFromOpenAIStatus(authStatus),
    sessions,
    sessionCount: sessions.length,
    mcpServerCount: registry.entries.length,
    mcpServers: registry.entries.map((entry) => ({
      name: entry.name,
      transport: entry.transport,
      scope: entry.scope,
      trustTier: entry.trustTier,
      originLabel: entry.originLabel,
    })),
    bridgeLines,
    memoryLines: [...extensionSummaryLines, ...memoryLines].slice(0, 6),
  };
}

function getOpenAICredentialsPath(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim() || path.join(homedir(), ".unclecode", "credentials", "openai.json");
}

async function openExternalUrl(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "darwin"
    ? [url]
    : process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

async function waitForBrowserOAuthCallback(input: { readonly redirectUri: string }): Promise<string> {
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

export function resolveWorkShellInlineActionId(args: readonly string[]): string | undefined {
  return resolveWorkShellInlineAction(args)?.actionId;
}

export async function runWorkShellInlineAction(input: {
  readonly args: readonly string[];
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
  readonly fetch?: typeof fetch;
  readonly waitForBrowserCallback?: ((input: { redirectUri: string; url: string }) => Promise<string>) | undefined;
  readonly openExternalUrl?: ((url: string) => Promise<void> | void) | undefined;
  readonly onProgress?: ((line: string) => void) | undefined;
}): Promise<readonly string[]> {
  const action = resolveWorkShellInlineAction(input.args);
  if (!action) {
    throw new Error(`Unsupported work-shell inline command: ${input.args.join(" ")}`.trim());
  }

  const actionId = action.actionId;
  const prompt = action.prompt;

  return runTuiSessionCenterAction({
    actionId,
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
    ...(prompt ? { prompt } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.waitForBrowserCallback ? { waitForBrowserCallback: input.waitForBrowserCallback } : {}),
    ...(input.openExternalUrl ? { openExternalUrl: input.openExternalUrl } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}

function resolveWorkShellInlineAction(args: readonly string[]): { readonly actionId: string; readonly prompt?: string } | undefined {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "command", "inline-action"],
      process.cwd(),
      JSON.stringify({ args }),
    ),
  ) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.actionId !== "string") {
    throw new Error("Rust inline action command returned an invalid payload.");
  }
  if (parsed.prompt !== undefined && typeof parsed.prompt !== "string") {
    throw new Error("Rust inline action command returned an invalid prompt payload.");
  }
  return parsed.prompt ? { actionId: parsed.actionId, prompt: parsed.prompt } : { actionId: parsed.actionId };
}

export async function runTuiSessionCenterAction(input: {
  readonly actionId: string;
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
  readonly prompt?: string;
  readonly fetch?: typeof fetch;
  readonly waitForBrowserCallback?: ((input: { redirectUri: string; url: string }) => Promise<string>) | undefined;
  readonly openExternalUrl?: ((url: string) => Promise<void> | void) | undefined;
  readonly onProgress?: ((line: string) => void) | undefined;
}): Promise<readonly string[]> {
  switch (input.actionId) {
    case "work-session":
      return [
        "Real assistant entrypoint is ready.",
        "Run:",
        "unclecode work",
      ];
    case "mode-cycle": {
      const explanation = explainUncleCodeConfig({
        workspaceRoot: input.workspaceRoot,
        env: input.env,
        pluginOverlays: loadExtensionConfigOverlays({
          workspaceRoot: input.workspaceRoot,
          ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
        }),
      });
      const currentIndex = MODE_PROFILE_IDS.indexOf(explanation.activeMode.id);
      const nextMode =
        MODE_PROFILE_IDS[(currentIndex + 1) % MODE_PROFILE_IDS.length] ?? MODE_PROFILE_IDS[0] ?? "default";
      const configPath = await persistProjectMode(input.workspaceRoot, nextMode);
      return formatModeSetReport(nextMode, configPath).split("\n");
    }
    case "mode-set": {
      const mode = input.prompt?.trim() ?? "";
      if (!isModeProfileId(mode)) {
        return [`Unsupported mode: ${mode || "<empty>"}`, `Supported: ${MODE_PROFILE_IDS.join(", ")}`];
      }
      const configPath = await persistProjectMode(input.workspaceRoot, mode);
      return formatModeSetReport(mode, configPath).split("\n");
    }
    case "browser-login": {
      const browserClientId = input.env.OPENAI_OAUTH_CLIENT_ID?.trim();
      if (!browserClientId) {
        const status = await resolveOpenAIAuthStatus({ env: input.env });
        if (status.activeSource !== "none" && !status.isExpired && status.apiReady) {
          return [
            "Saved auth found.",
            `Auth: ${status.activeSource}`,
            "Use `unclecode auth status` to inspect it. The next model request will verify provider access.",
          ];
        }
        if (status.activeSource !== "none" && status.expiresAt === "insufficient-scope") {
          return [
            "Saved OAuth lacks model.request scope.",
            "Use API key login now, or set OPENAI_OAUTH_CLIENT_ID for proper browser OAuth.",
          ];
        }
        if (status.activeSource !== "none" && status.authType === "oauth" && !status.apiReady) {
          return [
            "Saved OAuth is not API-ready for model calls.",
            "Use API key login now, or set OPENAI_OAUTH_CLIENT_ID for API-ready browser OAuth.",
          ];
        }
        return [
          "Browser OAuth needs OPENAI_OAUTH_CLIENT_ID for API-ready OAuth.",
          "Use Device login only for Codex device OAuth; it may not be API-ready for model calls.",
          "Reliable fallback: unclecode auth login --api-key-stdin.",
        ];
      }

      const baseUrl = input.env.OPENAI_OAUTH_BASE_URL?.trim();
      const credentialsPath = getOpenAICredentialsPath(input.env);
      const browserPkceClientId = browserClientId;
      const redirectUri = input.env.OPENAI_OAUTH_REDIRECT_URI?.trim() || "http://localhost:7777/callback";
      const pkce = createOpenAIPkcePair();
      const url = buildOpenAIAuthorizationUrl({
        clientId: browserPkceClientId,
        redirectUri,
        state: pkce.state,
        codeChallenge: pkce.codeChallenge,
        scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
        ...(baseUrl ? { baseUrl } : {}),
      });

      input.onProgress?.("Opening browser…");
      await Promise.resolve((input.openExternalUrl ?? openExternalUrl)(url.toString())).catch(() => undefined);
      input.onProgress?.("Waiting for callback…");
      const callbackUrl = await (input.waitForBrowserCallback ?? ((next) => waitForBrowserOAuthCallback({ redirectUri: next.redirectUri })))({
        redirectUri,
        url: url.toString(),
      });
      input.onProgress?.("Saving auth…");
      await completeOpenAIBrowserLogin({
        clientId: browserPkceClientId,
        redirectUri,
        callbackUrl,
        expectedState: pkce.state,
        codeVerifier: pkce.codeVerifier,
        credentialsPath,
        ...(baseUrl ? { baseUrl } : {}),
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
      input.onProgress?.("Auth ready.");

      return [
        "OAuth login complete.",
        "Auth: oauth-file",
        "Route: browser-oauth",
      ];
    }
    case "device-login": {
      const clientId = input.env.OPENAI_OAUTH_CLIENT_ID?.trim() || await resolveReusableOpenAIOAuthClientId({ env: input.env });
      if (!clientId) {
        return ["OPENAI_OAUTH_CLIENT_ID is required for device login."];
      }

      const baseUrl = input.env.OPENAI_OAUTH_BASE_URL?.trim();
      const authorization = input.env.OPENAI_OAUTH_CLIENT_ID?.trim()
        ? await requestOpenAIDeviceAuthorization({
            clientId,
            scopes: ["openid", "profile", "offline_access", "model.request", "api.model.read"],
            ...(baseUrl ? { baseUrl } : {}),
            fetch: input.fetch,
          })
        : await requestOpenAICodexDeviceAuthorization({
            clientId,
            ...(baseUrl ? { baseUrl } : {}),
            ...(input.fetch ? { fetch: input.fetch } : {}),
          });

      return [
        `User code: ${authorization.userCode}`,
        `Verify at: ${authorization.verificationUri}`,
        ...("expiresIn" in authorization ? [`Expires in: ${authorization.expiresIn}s`] : []),
      ];
    }
    case "auth-status":
      return formatOpenAIAuthStatus(await resolveOpenAIAuthStatus({ env: input.env })).split("\n");
    case "api-key-login": {
      const raw = input.prompt?.trim() ?? "";
      if (!raw) {
        return ["Paste an OpenAI API key and press Enter."];
      }
      const parts = raw.split(/\s+/).filter(Boolean);
      const apiKey = parts[0] ?? "";
      const orgIndex = parts.indexOf("--org");
      const projectIndex = parts.indexOf("--project");
      const organizationId = orgIndex >= 0 ? (parts[orgIndex + 1] ?? "").trim() || null : null;
      const projectId = projectIndex >= 0 ? (parts[projectIndex + 1] ?? "").trim() || null : null;
      if (!apiKey) {
        return ["Paste an OpenAI API key and press Enter."];
      }
      await runRustCommand(
        ["rust", "auth", "save-api-key", organizationId ?? "-", projectId ?? "-"],
        input.workspaceRoot,
        apiKey,
        input.env,
      );
      return ["API key login saved.", "Auth: api-key-file"];
    }
    case "auth-logout": {
      await runRustCommand(["rust", "auth", "logout"], input.workspaceRoot, undefined, input.env);
      const status = await resolveOpenAIAuthStatus({ env: input.env });
      return formatAuthLogoutLines(status);
    }
    case "doctor":
      return (await buildDoctorReport({
        workspaceRoot: input.workspaceRoot,
        env: input.env,
      })).split("\n");
    case "mcp-list":
      return buildMcpListReport({
        workspaceRoot: input.workspaceRoot,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
      }).split("\n");
    case "mcp-add":
      return addProjectMcpServer({
        workspaceRoot: input.workspaceRoot,
        ...(input.prompt ? { prompt: input.prompt } : {}),
      });
    case "mcp-remove":
      return removeProjectMcpServer({
        workspaceRoot: input.workspaceRoot,
        ...(input.prompt ? { serverName: input.prompt } : {}),
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
      });
    case "mcp-inspect":
      return buildMcpInspectReport({
        workspaceRoot: input.workspaceRoot,
        ...(input.prompt ? { serverName: input.prompt } : {}),
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
      }).split("\n");
    case "mmbridge-context": {
      const lines = await runMmbridgeMcpTool({
        workspaceRoot: input.workspaceRoot,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        toolName: "mmbridge_context_packet",
        args: {
          task: "prepare workspace context for UncleCode",
          command: "unclecode work",
          projectDir: input.workspaceRoot,
        },
      });
      return buildMmbridgeContextSummary(lines);
    }
    case "mmbridge-review": {
      const lines = await runMmbridgeMcpTool({
        workspaceRoot: input.workspaceRoot,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        toolName: "mmbridge_review",
        args: {
          tool: input.env.MMBRIDGE_DEFAULT_TOOL?.trim() || "kimi",
          mode: "review",
          projectDir: input.workspaceRoot,
        },
      });
      return buildMmbridgeReviewReport(lines);
    }
    case "mmbridge-gate": {
      const lines = await runMmbridgeMcpTool({
        workspaceRoot: input.workspaceRoot,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        toolName: "mmbridge_gate",
        args: {
          mode: "review",
          projectDir: input.workspaceRoot,
        },
      });
      return buildMmbridgeGateReport(lines);
    }
    case "mmbridge-handoff": {
      const lines = await runMmbridgeMcpTool({
        workspaceRoot: input.workspaceRoot,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        toolName: "mmbridge_handoff",
        args: {
          projectDir: input.workspaceRoot,
        },
      });
      return buildMmbridgeHandoffReport(lines);
    }
    case "mmbridge-health": {
      const report = await runMmbridgeMcpHealthCheck({
        workspaceRoot: input.workspaceRoot,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
      });
      return buildMmbridgeHealthReport(report);
    }
    case "mmbridge-doctor": {
      const lines = await runMmbridgeMcpTool({
        workspaceRoot: input.workspaceRoot,
        ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        toolName: "mmbridge_doctor",
        args: {
          projectDir: input.workspaceRoot,
        },
      });
      return buildMmbridgeDoctorReport(lines);
    }
    case "mode-status":
      return formatModeStatusReport({
        workspaceRoot: input.workspaceRoot,
        env: input.env,
      }).split("\n");
    case "research-status":
      return (await buildResearchStatusReport({
        workspaceRoot: input.workspaceRoot,
        env: input.env,
      })).split("\n");
    case "new-research":
      if (input.prompt && input.prompt.trim().length > 0) {
        return runResearchPass({
          workspaceRoot: input.workspaceRoot,
          env: input.env,
          prompt: input.prompt.trim(),
          ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
        });
      }

      return ["Describe what Work should inspect. Enter or Ctrl+R refreshes context."];
    default:
      return ["Unknown action."];
  }
}

export function formatSessionsReport(items: readonly SessionListItem[]): string {
  if (items.length === 0) {
    return "No resumable sessions found.";
  }

  return [
    "Sessions",
    ...items.map((item) =>
      [
        `${item.sessionId}`,
        `state=${item.state}`,
        `model=${item.model ?? "none"}`,
        `mode=${item.mode ?? "none"}`,
        `pending=${item.pendingAction ?? "none"}`,
        `updated=${item.updatedAt}`,
        ...(item.taskSummary ? [`summary=${item.taskSummary}`] : []),
      ].join(" | "),
    ),
  ].join("\n");
}

export async function buildResumeSummaryData(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionId: string;
}): Promise<{
  readonly lines: readonly string[];
  readonly report: {
    readonly command: "resume";
    readonly sessionId: string;
    readonly status: string;
    readonly model: string;
    readonly mode: string;
    readonly pendingAction: string;
    readonly worktreeBranch: string;
    readonly taskSummary: string;
    readonly metrics: {
      readonly resumeMs: number;
    };
    readonly thresholds: typeof RESUME_LATENCY_THRESHOLDS;
  };
}> {
  const resumeStartedAt = Date.now();
  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(input.env) });
  const result = await sessionStore.resumeSession({
    projectPath: input.workspaceRoot,
    sessionId: input.sessionId,
  });

  if (result.checkpoint === null && result.records.length === 0) {
    throw new Error(`Session not found: ${input.sessionId}`);
  }

  const resumeMs = elapsedSince(resumeStartedAt);
  const state = result.state;
  const model = result.metadata.model ?? "none";
  const mode = result.mode ?? "none";
  const pendingAction = result.pendingAction?.actionDescription ?? "none";
  const worktreeBranch = result.worktree?.worktreeBranch ?? "none";
  const taskSummary = result.taskSummary?.summary ?? "none";
  const traceMode = result.metadata.traceMode ?? "unknown";
  const lines = [
    `Resuming session: ${input.sessionId}`,
    `State: ${state}`,
    `Model: ${model}`,
    `Mode: ${mode}`,
    `Trace mode: ${traceMode}`,
    `Pending action: ${pendingAction}`,
    `Worktree branch: ${worktreeBranch}`,
    `Task summary: ${taskSummary}`,
  ] as const;

  return {
    lines,
    report: {
      command: "resume",
      sessionId: input.sessionId,
      status: state,
      model,
      mode,
      pendingAction,
      worktreeBranch,
      taskSummary,
      metrics: {
        resumeMs,
      },
      thresholds: RESUME_LATENCY_THRESHOLDS,
    },
  };
}

export async function buildResumeSummary(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionId: string;
}): Promise<readonly string[]> {
  const { lines } = await buildResumeSummaryData(input);
  return lines;
}


import {
  addProjectMcpServer,
  buildMcpInspectReport,
  buildMcpListReport,
  buildResearchStatusReport,
  removeProjectMcpServer,
  runResearchPass,
} from "./operational-research.js";

export {
  addProjectMcpServer,
  buildMcpInspectReport,
  buildMcpListReport,
  buildResearchStatusReport,
  createTuiActivityEntry,
  removeProjectMcpServer,
  runResearchPass,
  runResearchPassData,
} from "./operational-research.js";

async function summarizeTeamRunsForDoctor(workspaceRoot: string): Promise<{ verdict: string; label: string }> {
  const dataRoot = process.env.UNCLECODE_DATA_ROOT?.trim() || path.join(workspaceRoot, ".data");
  const verifyChains = process.env.UNCLECODE_DOCTOR_VERIFY_CHAINS === "1";
  try {
    const runs = listTeamRuns(dataRoot);
    if (runs.length === 0) {
      return { verdict: "PASS", label: "no team runs recorded" };
    }
    const latest = runs[runs.length - 1];
    if (!latest) {
      return { verdict: "PASS", label: "no team runs recorded" };
    }
    const manifest = readTeamRunManifest(latest.runRoot);
    const status = getRunStatusFromCheckpoints(readTeamCheckpoints(latest.runRoot)) ?? "(no checkpoints)";
    if (!verifyChains) {
      return {
        verdict: "PASS",
        label: `${runs.length} run(s); latest ${manifest.runId} status=${status} (chain not verified — set UNCLECODE_DOCTOR_VERIFY_CHAINS=1)`,
      };
    }
    const chain = verifyTeamRunChain(latest.runRoot);
    const chainNote = chain.ok ? `chain ${chain.verifiedLines} ok` : `chain BROKEN @ ${chain.brokenAt}`;
    return {
      verdict: chain.ok ? "PASS" : "WARN",
      label: `${runs.length} run(s); latest ${manifest.runId} status=${status}; ${chainNote}`,
    };
  } catch (error) {
    return {
      verdict: "WARN",
      label: `inspect failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
