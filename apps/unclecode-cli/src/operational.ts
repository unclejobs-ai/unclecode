import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  listProjectBridgeLines,
  listScopedMemoryLines,
  prepareResearchBundle,
} from "@unclecode/context-broker";
import {
  MCP_HOST_SUPPORTED_TRANSPORTS,
  type StartedMcpProfile,
  createMcpHostController,
  createMcpHostRegistry,
  formatMcpHostRegistry,
  getResearchMcpProfile,
  loadMcpHostRegistry,
} from "@unclecode/mcp-host";
import { createOrchestrator, loadExtensionConfigOverlays, loadExtensionManifestSummaries } from "@unclecode/orchestrator";
import type { ModeProfileId } from "@unclecode/contracts";
import { MODE_PROFILE_IDS, MODE_PROFILES } from "@unclecode/contracts";
import {
  buildOpenAIAuthorizationUrl,
  clearOpenAICredentials,
  clearOpenAICodexCredentials,
  completeOpenAIBrowserLogin,
  completeOpenAICodexDeviceLogin,
  createOpenAIPkcePair,
  formatEffectiveOpenAIAuthStatus,
  resolveEffectiveOpenAIAuthStatus,
  requestOpenAICodexDeviceAuthorization,
  requestOpenAIDeviceAuthorization,
  resolveReusableOpenAIOAuthClientId,
  writeOpenAICodexCredentials,
  writeOpenAICredentials,
} from "@unclecode/providers";
import { createRuntimeBroker } from "@unclecode/runtime-broker";
import { createSessionStore, getSessionStoreRoot } from "@unclecode/session-store";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

type PersistedProjectConfig = {
  readonly mode?: ModeProfileId;
  readonly [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getProjectConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".unclecode", "config.json");
}

function formatAuthLogoutLines(status: Awaited<ReturnType<typeof resolveEffectiveOpenAIAuthStatus>>): readonly string[] {
  if (status.activeSource === "none") {
    return ["Signed out.", "Auth: none"];
  }

  return ["Local credentials cleared.", `Auth: ${status.activeSource}`];
}

function formatOpenAIProviderDisplayName(providerId: "openai-api" | "openai-codex"): string {
  return providerId === "openai-codex" ? "OpenAI Codex" : "OpenAI API";
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

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

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

const RESEARCH_LATENCY_THRESHOLDS = {
  firstEventMsBudget: 1_500,
  totalMsBudget: 3_000,
  bundleMsBudget: 1_500,
  mcpStartMsBudget: 500,
  executorMsBudget: 1_500,
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
  const authStatus = await resolveEffectiveOpenAIAuthStatus({ env: input.env });
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

  const lines = [
    "Doctor report",
    `Mode           PASS  ${modeLabel}`,
    `Auth           ${authVerdict}  ${authLabel}`,
    `Runtime        ${runtimeVerdict}  ${runtimeLabel}`,
    `Session store  PASS  ${sessionStoreRoot}`,
    `MCP host       PASS  ${mcpLabel}`,
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
  const authStatus = await resolveEffectiveOpenAIAuthStatus({ env: input.env });
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
      : "1. Set OPENAI_API_KEY, save credentials with `unclecode auth login --api-key-stdin [--org <id>] [--project <id>]`, reuse an existing `~/.codex/auth.json`, or run `unclecode auth login --browser` with OPENAI_OAUTH_CLIENT_ID.",
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
  readonly latestResearchSessionId: string | null;
  readonly latestResearchSummary: string | null;
  readonly latestResearchTimestamp: string | null;
  readonly researchRunCount: number;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
};

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
  const authStatus = await resolveEffectiveOpenAIAuthStatus({ env: input.env });
  const sessions = await listSessions(input);
  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const latestResearch = sessions.find((session) => session.sessionId.startsWith("research-"));
  const canonicalWorkspaceRoot = await realpath(input.workspaceRoot).catch(() => input.workspaceRoot);
  const ledgerPath = path.join(canonicalWorkspaceRoot, ".unclecode", "research-runs.jsonl");
  let researchRunCount = 0;
  let latestResearchTimestamp: string | null = null;
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

  try {
    const ledger = await readFile(ledgerPath, "utf8");
    const lines = ledger.split("\n").filter((line) => line.trim().length > 0);
    researchRunCount = lines.length;
    const latest = lines.at(-1);
    if (latest) {
      const parsed = JSON.parse(latest) as Record<string, unknown>;
      latestResearchTimestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
    }
  } catch {
    researchRunCount = 0;
    latestResearchTimestamp = null;
  }

  return {
    modeLabel: explanation.activeMode.id,
    authLabel: authStatus.activeSource,
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
    latestResearchSessionId: latestResearch?.sessionId ?? null,
    latestResearchSummary: latestResearch?.taskSummary ?? null,
    latestResearchTimestamp,
    researchRunCount,
    bridgeLines,
    memoryLines: [...extensionSummaryLines, ...memoryLines].slice(0, 6),
  };
}

function getOpenAIApiCredentialsPath(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim() || path.join(homedir(), ".unclecode", "credentials", "openai.json");
}

function getOpenAICodexCredentialsPath(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_OPENAI_CODEX_CREDENTIALS_PATH?.trim() || path.join(homedir(), ".unclecode", "credentials", "openai-codex.json");
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
  const normalized = args.join(" ").trim().replace(/\s+/g, " ");

  if (normalized === "doctor") return "doctor";
  if (normalized === "auth status") return "auth-status";
  if (normalized === "auth login" || normalized === "auth login --browser") return "browser-login";
  if (normalized === "auth logout") return "auth-logout";
  if (normalized.startsWith("auth login --api-key ")) return "api-key-login";
  if (normalized === "mcp list") return "mcp-list";
  if (normalized === "mode status") return "mode-status";
  if (normalized === "research status") return "research-status";
  if (normalized === "research run" || normalized.startsWith("research run ")) return "new-research";
  return undefined;
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
  const actionId = resolveWorkShellInlineActionId(input.args);
  if (!actionId) {
    throw new Error(`Unsupported work-shell inline command: ${input.args.join(" ")}`.trim());
  }

  const prompt = actionId === "new-research"
    ? input.args.slice(2).join(" ").trim()
    : undefined;

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
    case "browser-login": {
      const browserClientId = input.env.OPENAI_OAUTH_CLIENT_ID?.trim();
      const reusableClientId = await resolveReusableOpenAIOAuthClientId({ env: input.env });
      const clientId = browserClientId || reusableClientId;
      if (!clientId) {
        const status = await resolveEffectiveOpenAIAuthStatus({ env: input.env });
        if (status.activeSource !== "none" && !status.isExpired) {
          return [
            "Saved auth found.",
            `Provider: ${formatOpenAIProviderDisplayName(status.providerId)}`,
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
        return ["OPENAI_OAUTH_CLIENT_ID is required for browser login."];
      }

      const baseUrl = input.env.OPENAI_OAUTH_BASE_URL?.trim();
      const apiCredentialsPath = getOpenAIApiCredentialsPath(input.env);
      const codexCredentialsPath = getOpenAICodexCredentialsPath(input.env);
      if (!browserClientId && reusableClientId) {
        const deviceClientId = reusableClientId;
        let deviceUserCode = "";
        let verificationUri = "";

        await completeOpenAICodexDeviceLogin({
          clientId: deviceClientId,
          credentialsPath: codexCredentialsPath,
          writeCredentials: async ({ credentialsPath, credentials }) => {
            if (!credentials || credentials.authType !== "oauth") {
              throw new Error("OpenAI Codex login only supports oauth credentials.");
            }
            await writeOpenAICodexCredentials({ credentialsPath, credentials });
          },
          ...(baseUrl ? { baseUrl } : {}),
          ...(input.fetch ? { fetch: input.fetch } : {}),
          onDeviceCode: async (info) => {
            deviceUserCode = info.userCode;
            verificationUri = info.verificationUri;
            input.onProgress?.("Opening browser…");
            await Promise.resolve((input.openExternalUrl ?? openExternalUrl)(info.verificationUri)).catch(() => undefined);
            input.onProgress?.(`Enter code: ${info.userCode}`);
            input.onProgress?.("Waiting for device approval…");
          },
        });
        input.onProgress?.("Auth ready.");

        return [
          "OAuth login complete.",
          "Provider: OpenAI Codex",
          "Auth: oauth-file",
          "Route: device-oauth",
          ...(deviceUserCode ? [`Code used: ${deviceUserCode}`] : []),
          ...(verificationUri ? [`Opened: ${verificationUri}`] : []),
        ];
      }

      const browserPkceClientId = browserClientId!;
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
        credentialsPath: apiCredentialsPath,
        ...(baseUrl ? { baseUrl } : {}),
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
      input.onProgress?.("Auth ready.");

      return [
        "OAuth login complete.",
        "Provider: OpenAI API",
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
      return formatEffectiveOpenAIAuthStatus(await resolveEffectiveOpenAIAuthStatus({ env: input.env })).split("\n");
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
      await writeOpenAICredentials({
        credentialsPath: getOpenAIApiCredentialsPath(input.env),
        credentials: {
          authType: "api-key",
          apiKey,
          organizationId,
          projectId,
        },
      });
      return ["API key login saved.", "Auth: api-key-file"];
    }
    case "auth-logout": {
      await clearOpenAICredentials({ credentialsPath: getOpenAIApiCredentialsPath(input.env) });
      await clearOpenAICodexCredentials({ credentialsPath: getOpenAICodexCredentialsPath(input.env) });
      const status = await resolveEffectiveOpenAIAuthStatus({ env: input.env });
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

      return ["Type a research prompt and press Enter."];
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

export function buildResearchStatusReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
}): Promise<string> {
  const registry = createMcpHostRegistry({});
  const loadedRegistry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const profile = getResearchMcpProfile(loadedRegistry);

  return listSessions({ workspaceRoot: input.workspaceRoot, env: input.env }).then((items) => {
    const latestResearchSession = items.find((item) => item.sessionId.startsWith("research-"));

    return [
      "Research status",
      `Profile: ${profile.profileName}`,
      `Configured servers: ${profile.serverNames.length}`,
      ...(latestResearchSession
        ? [
            `Last run: ${latestResearchSession.sessionId}`,
            `State: ${latestResearchSession.state}`,
            `Summary: ${latestResearchSession.taskSummary ?? "none"}`,
          ]
        : ["No active research run"]),
    ].join("\n");
  });
}

export function buildMcpListReport(input: {
  readonly workspaceRoot: string;
  readonly userHomeDir?: string;
}): string {
  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });

  return formatMcpHostRegistry(registry);
}

export async function runResearchPassData(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly userHomeDir?: string;
}): Promise<{
  readonly lines: readonly string[];
  readonly report: {
    readonly command: "research.run";
    readonly sessionId: string;
    readonly prompt: string;
    readonly status: "completed" | "failed";
    readonly summary: string;
    readonly artifactPaths: readonly string[];
    readonly metrics: {
      readonly firstEventMs: number;
      readonly totalMs: number;
      readonly bundleMs: number;
      readonly mcpStartMs: number;
      readonly executorMs: number;
    };
    readonly thresholds: typeof RESEARCH_LATENCY_THRESHOLDS;
  };
}> {
  const totalStartedAt = Date.now();
  let firstEventMs = -1;
  let bundleMs = 0;
  let mcpStartMs = 0;
  let executorMs = 0;

  const markFirstEvent = () => {
    if (firstEventMs < 0) {
      firstEventMs = elapsedSince(totalStartedAt);
    }
  };

  markFirstEvent();

  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(input.env) });
  const sessionId = `research-${randomUUID()}`;
  const ref = {
    projectPath: input.workspaceRoot,
    sessionId,
  } as const;

  await sessionStore.appendCheckpoint(ref, { type: "state", state: "running" });
  await sessionStore.appendCheckpoint(ref, {
    type: "metadata",
    metadata: { model: "research-local" },
  });

  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const hostController = createMcpHostController(registry);
  const profile = getResearchMcpProfile(registry);

  const orchestrator = createOrchestrator({
    async prepareResearchBundle({ rootDir, prompt, sessionId, artifactsDir }) {
      const startedAt = Date.now();
      const bundle = await prepareResearchBundle({
        rootDir,
        ...(sessionId ? { sessionId } : {}),
        artifactsDir,
        hypotheses: [prompt],
      });
      bundleMs = elapsedSince(startedAt);
      markFirstEvent();
      return bundle;
    },
    async startMcpProfile(profileInput) {
      const startedAt = Date.now();
      const startedProfile = await hostController.startProfile(profileInput);
      mcpStartMs = elapsedSince(startedAt);
      markFirstEvent();
      return startedProfile;
    },
    async runResearchExecutor({ prompt, bundle, profile: startedProfile }) {
      const startedAt = Date.now();
      markFirstEvent();
      await mkdir(bundle.artifactsDir, { recursive: true });
      const artifactPath = path.join(bundle.artifactsDir, "research.md");
      const changedFiles = bundle.packet.changedFiles ?? [];
      const hotspots = bundle.packet.hotspots ?? [];
      const policySignals = bundle.packet.policySignals ?? [];
      const summary = `Prepared a local research bundle for \"${prompt}\" with ${changedFiles.length} changed files and ${startedProfile.connectedServerNames.length} MCP servers.`;
      const body = [
        "# UncleCode Research Report",
        "",
        `Prompt: ${prompt}`,
        `Session: ${sessionId}`,
        `Packet: ${bundle.packet.id}`,
        `Changed files: ${changedFiles.length}`,
        `Hotspots: ${hotspots.length}`,
        `Policy signals: ${policySignals.join(", ") || "none"}`,
        `MCP servers: ${startedProfile.connectedServerNames.join(", ") || "none"}`,
        "",
        "## Findings",
        changedFiles.length > 0
          ? `- Changed files observed: ${changedFiles.join(", ")}`
          : "- No changed files observed in the current packet.",
        hotspots.length > 0
          ? `- Hotspots detected: ${hotspots.length}`
          : "- No hotspots detected in the current packet.",
        policySignals.length > 0
          ? `- Policy signals: ${policySignals.join(", ")}`
          : "- No policy signals were emitted.",
        startedProfile.connectedServerNames.length > 0
          ? `- Connected MCP servers: ${startedProfile.connectedServerNames.join(", ")}`
          : "- No MCP servers were connected for this run.",
        "",
        "## Recommended Next Steps",
        changedFiles.length > 0
          ? "1. Inspect the changed files above and decide whether the research should focus on one subsystem first."
          : "1. Introduce a concrete change set or target area so the next research pass can analyze a narrower scope.",
        hotspots.length > 0
          ? "2. Review the hotspot count and prioritize the densest area for the next implementation wave."
          : "2. Run another research pass after a meaningful code change so hotspots and policy signals become more informative.",
        startedProfile.connectedServerNames.length > 0
          ? "3. Use the connected MCP servers as the next source of truth for deeper investigation."
          : "3. Configure MCP servers if you need external tools or richer context for the next run.",
        "",
        `Summary: ${summary}`,
      ].join("\n");

      await writeFile(artifactPath, `${body}\n`, "utf8");
      executorMs = elapsedSince(startedAt);

      return {
        summary,
        artifactPaths: [artifactPath],
      };
    },
    async stopMcpProfile(startedProfile) {
      if (isStartedMcpProfile(startedProfile)) {
        await hostController.stopProfile(startedProfile);
      }
    },
  });

  const result = await orchestrator.runResearch({
    rootDir: input.workspaceRoot,
    prompt: input.prompt,
    sessionId,
    enabledServerNames: profile.serverNames,
  });

  await sessionStore.appendCheckpoint(ref, {
    type: "state",
    state: result.status === "completed" ? "idle" : "requires_action",
  });
  await sessionStore.appendCheckpoint(ref, {
    type: "task_summary",
    summary: result.summary,
    timestamp: new Date().toISOString(),
  });

  const canonicalWorkspaceRoot = await realpath(input.workspaceRoot).catch(() => input.workspaceRoot);
  const ledgerDir = path.join(canonicalWorkspaceRoot, ".unclecode");
  const ledgerPath = path.join(ledgerDir, "research-runs.jsonl");
  await mkdir(ledgerDir, { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      sessionId,
      prompt: input.prompt,
      status: result.status,
      summary: result.summary,
      artifactPaths: result.artifactPaths,
      timestamp: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", flag: "a" },
  );

  const totalMs = elapsedSince(totalStartedAt);
  const lines = [
    result.status === "completed" ? "Research completed" : "Research failed",
    `Session: ${sessionId}`,
    `Summary: ${result.summary}`,
    ...result.artifactPaths.map((artifactPath) => `Artifact: ${artifactPath}`),
  ] as const;

  return {
    lines,
    report: {
      command: "research.run",
      sessionId,
      prompt: input.prompt,
      status: result.status,
      summary: result.summary,
      artifactPaths: result.artifactPaths,
      metrics: {
        firstEventMs: firstEventMs < 0 ? totalMs : firstEventMs,
        totalMs,
        bundleMs,
        mcpStartMs,
        executorMs,
      },
      thresholds: RESEARCH_LATENCY_THRESHOLDS,
    },
  };
}

export async function runResearchPass(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly userHomeDir?: string;
}): Promise<readonly string[]> {
  const { lines } = await runResearchPassData(input);
  return lines;
}

function isStartedMcpProfile(value: {
  readonly profileName: string;
  readonly connectedServerNames: readonly string[];
  readonly connections?: readonly unknown[];
}): value is StartedMcpProfile {
  return Array.isArray(value.connections);
}

export function createTuiActivityEntry(input: {
  readonly actionId: string;
  readonly lines: readonly string[];
  readonly status: "completed" | "failed" | "info";
}) {
  const titleMap: Record<string, string> = {
    doctor: "Doctor",
    "mode-status": "Mode Status",
    "mode-cycle": "Mode Cycle",
    "auth-status": "Auth Status",
    "browser-login": "Browser Login",
    "device-login": "Device Login",
    "mcp-list": "MCP List",
    "new-research": "Research",
  };

  return {
    id: `${input.actionId}-${Date.now()}`,
    source: input.actionId,
    title: titleMap[input.actionId] ?? input.actionId,
    timestamp: new Date().toISOString(),
    lines: input.lines,
    tone:
      input.status === "completed"
        ? "success"
        : input.status === "failed"
          ? "warning"
          : "info",
  } as const;
}
