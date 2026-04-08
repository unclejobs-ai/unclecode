import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  clearCachedWorkspaceGuidance,
  listAvailableSkills,
  listProjectBridgeLines,
  listScopedMemoryLines,
  loadCachedWorkspaceGuidance,
  loadNamedSkill,
  publishContextBridge,
  writeScopedMemory,
} from "@unclecode/context-broker";
import type {
  ExecutionTraceEvent,
  ModeReasoningEffort,
} from "@unclecode/contracts";
import {
  clearExtensionRegistryCache,
  describeReasoning,
  listSessionLines,
  loadConfig,
  loadExtensionConfigOverlays,
  loadExtensionManifestSummaries,
  persistWorkShellSessionSnapshot,
  resolveComposerInput,
  resolveModelCommand,
  resolveReasoningCommand,
  resolveWorkShellSlashCommand,
  runWorkShellInlineCommand,
  toolDefinitions,
  type AppReasoningConfig,
  type CodingAgentTraceEvent,
  type OrchestratedWorkAgentTraceEvent,
  type WorkShellReasoningConfig,
  WorkAgent,
} from "@unclecode/orchestrator";
import {
  resolveOpenAIAuth,
  resolveOpenAIAuthStatus,
  resolveReusableOpenAIOAuthClientId,
  type ProviderInputAttachment,
  type ProviderName,
  type ProviderToolTraceEvent,
} from "@unclecode/providers";
import { createSessionStore, getSessionStoreRoot } from "@unclecode/session-store";
import {
  buildContextPanel,
  buildInlineCommandPanel,
  buildWorkShellHelpPanel,
  buildWorkShellStatusPanel,
  createManagedWorkShellDashboardProps,
  extractAuthLabel,
  formatAgentTraceLine,
  formatInlineCommandResultSummary,
  formatWorkShellError,
  refineInlineCommandPanelLines,
  renderManagedWorkShellDashboard,
  type TuiShellHomeState,
} from "@unclecode/tui";
import * as path from "node:path";

import {
  buildTuiHomeState,
  runTuiSessionCenterAction,
  runWorkShellInlineAction,
} from "./operational.js";
import { runWorkspaceGuardianChecks } from "./guardian-checks.js";
import { createRuntimeCodingAgent } from "./runtime-coding-agent.js";

export type StartReplOptions = {
  provider: ProviderName;
  model: string;
  mode: string;
  authLabel: string;
  reasoning: AppReasoningConfig;
  cwd: string;
  contextSummaryLines: readonly string[];
  homeState: TuiShellHomeState;
  sessionId?: string | undefined;
  initialTraceMode?: "minimal" | "verbose" | undefined;
  reloadWorkspaceContext?: ((cwd: string) => Promise<readonly string[]>) | undefined;
  refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  runInlineCommand?: ((args: readonly string[]) => Promise<readonly string[]>) | undefined;
  saveApiKeyAuth?: ((raw: string) => Promise<readonly string[]>) | undefined;
  browserOAuthAvailable?: boolean | undefined;
};

type StartReplTraceEvent =
  | OrchestratedWorkAgentTraceEvent<CodingAgentTraceEvent<ProviderToolTraceEvent>>
  | Extract<ExecutionTraceEvent, { type: "bridge.published" | "memory.written" }>;

export type StartReplAgent = {
  runTurn(
    prompt: string,
    attachments?: readonly ProviderInputAttachment[],
  ): Promise<{ text: string }>;
  clear(): void;
  updateRuntimeSettings(settings: {
    reasoning?: AppReasoningConfig | undefined;
    model?: string | undefined;
  }): void;
  setTraceListener(
    listener?: ((event: StartReplTraceEvent) => void) | undefined,
  ): void;
};

type ManagedDashboardSession = {
  agent: StartReplAgent;
  options: StartReplOptions;
};

type ParsedArgs = {
  cwd: string;
  provider?: "anthropic" | "gemini" | "openai" | "openai-api" | "openai-codex";
  model?: string;
  reasoning?: ModeReasoningEffort;
  sessionId?: string;
  prompt?: string;
  showHelp: boolean;
  showTools: boolean;
};

function printHelp(): void {
  process.stdout.write(`UncleCode Work (repo-local)\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  unclecode work\n`);
  process.stdout.write(`  unclecode work "summarize this project"\n`);
  process.stdout.write(`  unclecode work --provider gemini --cwd E:\\\\repo --model gemini-2.5-flash\n\n`);
  process.stdout.write(`Flags:\n`);
  process.stdout.write(`  --help   Show this help text\n`);
  process.stdout.write(`  --tools  List available local tools\n`);
  process.stdout.write(`  --cwd    Set the workspace root\n`);
  process.stdout.write(`  --provider  Choose openai-api, openai-codex, anthropic, or gemini (legacy: openai)\n`);
  process.stdout.write(`  --model  Override the model for the chosen provider\n`);
  process.stdout.write(`  --reasoning  Override reasoning effort: low, medium, high\n`);
  process.stdout.write(`  --session-id  Resume a persisted work session id\n`);
}

function printTools(): void {
  process.stdout.write(`Available tools:\n`);
  for (const tool of toolDefinitions) {
    process.stdout.write(`- ${tool.name}: ${tool.description}\n`);
  }
}

function resolveRuntimeProvider(provider: string): "anthropic" | "gemini" | "openai-api" | "openai-codex" {
  if (provider === "anthropic" || provider === "gemini" || provider === "openai-codex" || provider === "openai-api") {
    return provider;
  }

  if (provider === "openai") {
    return "openai-api";
  }

  throw new Error(`Unsupported runtime provider: ${provider}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  let cwd = process.cwd();
  let provider: "anthropic" | "gemini" | "openai" | "openai-api" | "openai-codex" | undefined;
  let model: string | undefined;
  let reasoning: ModeReasoningEffort | undefined;
  let sessionId: string | undefined;
  const promptParts: string[] = [];
  let showHelp = false;
  let showTools = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help") {
      showHelp = true;
      continue;
    }
    if (arg === "--tools") {
      showTools = true;
      continue;
    }
    if (arg === "--cwd") {
      cwd = path.resolve(argv[i + 1] ?? cwd);
      i += 1;
      continue;
    }
    if (arg === "--provider") {
      const next = argv[i + 1];
      if (
        next === "anthropic" ||
        next === "gemini" ||
        next === "openai" ||
        next === "openai-api" ||
        next === "openai-codex"
      ) {
        provider = next;
      }
      i += 1;
      continue;
    }
    if (arg === "--model") {
      model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--reasoning") {
      const next = argv[i + 1];
      if (next === "low" || next === "medium" || next === "high") {
        reasoning = next;
      }
      i += 1;
      continue;
    }
    if (arg === "--session-id") {
      sessionId = argv[i + 1];
      i += 1;
      continue;
    }
    promptParts.push(arg);
  }

  const parsed: ParsedArgs = { cwd, showHelp, showTools };
  if (provider !== undefined) {
    parsed.provider = provider;
  }
  if (model !== undefined) {
    parsed.model = model;
  }
  if (reasoning !== undefined) {
    parsed.reasoning = reasoning;
  }
  if (sessionId !== undefined) {
    parsed.sessionId = sessionId;
  }
  if (promptParts.length > 0) {
    parsed.prompt = promptParts.join(" ");
  }
  return parsed;
}

async function runInlineCommand(
  args: readonly string[],
  cwd: string,
): Promise<readonly string[]> {
  return runWorkShellInlineAction({
    args,
    workspaceRoot: cwd,
    env: process.env,
    ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
  });
}

async function buildWorkShellContextSummary(input: {
    cwd: string;
    resumedContextLine?: string | undefined;
    forceRefresh?: boolean | undefined;
  },
): Promise<readonly string[]> {
  if (input.forceRefresh) {
    clearCachedWorkspaceGuidance(input.cwd, process.env.HOME);
    clearExtensionRegistryCache({
      workspaceRoot: input.cwd,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    });
  }

  const guidance = await loadCachedWorkspaceGuidance({
    cwd: input.cwd,
    ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
  });
  const extensionSummaries = loadExtensionManifestSummaries({
    workspaceRoot: input.cwd,
    ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
  });

  return [
    ...(input.resumedContextLine ? [input.resumedContextLine] : []),
    ...guidance.contextSummaryLines,
    ...extensionSummaries.slice(0, 2).map((extension) => {
      const status = extension.statusLines[0]?.trim();
      return status && status.length > 0
        ? `Loaded extension: ${extension.name} · ${status}`
        : `Loaded extension: ${extension.name}`;
    }),
  ];
}

export async function loadResumedWorkSession(input: {
  cwd: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  sessionId: string;
  initialTraceMode?: "minimal" | "verbose";
  contextLine: string;
}> {
  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(input.env) });
  const resumed = await sessionStore.resumeSession({
    projectPath: input.cwd,
    sessionId: input.sessionId,
  });
  if (resumed.checkpoint === null && resumed.records.length === 0) {
    throw new Error(`Session not found: ${input.sessionId}`);
  }

  return {
    sessionId: input.sessionId,
    ...(resumed.metadata.traceMode
      ? { initialTraceMode: resumed.metadata.traceMode }
      : {}),
    contextLine: `Resumed session: ${input.sessionId}`,
  };
}

export const resolveWorkShellInlineCommand = (
  args: readonly string[],
  runInlineCommand: (args: readonly string[]) => Promise<readonly string[]>,
): Promise<{ readonly lines: readonly string[]; readonly failed: boolean }> =>
  runWorkShellInlineCommand(args, runInlineCommand, formatWorkShellError);

export function createManagedDashboardInput(session: ManagedDashboardSession) {
  return {
    homeState: session.options.homeState,
    ...(session.options.refreshHomeState
      ? { refreshHomeState: session.options.refreshHomeState }
      : {}),
    paneRuntime: {
      agent: session.agent,
      options: session.options,
      buildContextPanel,
      buildHelpPanel: buildWorkShellHelpPanel,
      buildStatusPanel: ({ options, reasoningLabel, authLabel }: {
        options: { model: string; mode: string };
        reasoningLabel: string;
        authLabel: string;
      }) =>
        buildWorkShellStatusPanel({
          provider: session.options.provider,
          model: options.model,
          mode: options.mode,
          cwd: session.options.cwd,
          reasoningLabel,
          authLabel,
        }),
      buildInlineCommandPanel,
      formatInlineCommandResultSummary,
      formatAgentTraceLine: (
        event: ExecutionTraceEvent | { readonly type: "bridge.published" | "memory.written"; readonly [key: string]: unknown },
      ) => formatAgentTraceLine(event as ExecutionTraceEvent),
      formatWorkShellError,
      listProjectBridgeLines,
      listScopedMemoryLines,
      listSessionLines,
      persistWorkShellSessionSnapshot,
      resolveReasoningCommand,
      resolveModelCommand: (
        input: string,
        currentModel: string,
        currentReasoning: WorkShellReasoningConfig,
        modeDefaultReasoning: WorkShellReasoningConfig,
      ) =>
        resolveModelCommand(input, {
          provider: session.options.provider as import("@unclecode/contracts").ProviderId,
          currentModel,
          currentReasoning,
          modeDefaultReasoning,
        }),
      resolveWorkShellSlashCommand,
      resolveWorkShellInlineCommand,
      ...(session.options.refreshAuthState
        ? { refreshAuthState: session.options.refreshAuthState }
        : {}),
      ...(session.options.runInlineCommand
        ? { runInlineCommand: session.options.runInlineCommand }
        : {}),
      ...(session.options.saveApiKeyAuth
        ? { saveApiKeyAuth: session.options.saveApiKeyAuth }
        : {}),
      resolveComposerInput,
      refineInlineCommandResultLines: ({
        args,
        lines,
        failed,
        authLabel,
        browserOAuthAvailable,
      }: {
        args: readonly string[];
        lines: readonly string[];
        failed: boolean;
        authLabel: string;
        browserOAuthAvailable: boolean;
      }) =>
        refineInlineCommandPanelLines({
          args,
          lines,
          failed,
          authLabel,
          browserOAuthAvailable,
        }),
      ...(session.options.reloadWorkspaceContext
        ? { reloadWorkspaceContext: session.options.reloadWorkspaceContext }
        : {}),
      publishContextBridge,
      writeScopedMemory,
      listAvailableSkills,
      loadNamedSkill,
      toolLines: toolDefinitions.map(
        (tool) => `${tool.name}: ${tool.description}`,
      ),
      extractAuthLabel,
      ...(session.options.sessionId
        ? { sessionId: session.options.sessionId }
        : {}),
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
      browserOAuthAvailable: Boolean(session.options.browserOAuthAvailable),
    },
    getReasoningLabel: describeReasoning,
    isReasoningSupported: (reasoning: WorkShellReasoningConfig) =>
      reasoning.support.status === "supported",
  };
}

function deriveAuthIssueLines(input: {
  authStatus?: Awaited<ReturnType<typeof resolveOpenAIAuthStatus>>;
  authIssueMessage?: string | undefined;
}): readonly string[] {
  return input.authStatus?.expiresAt === "insufficient-scope"
    ? ["Auth issue: saved OAuth lacks model.request scope. Use /auth key, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."]
    : input.authStatus?.expiresAt === "refresh-required"
      ? ["Auth issue: saved OAuth needs refresh. Use /auth login or /auth logout before asking the model to work."]
      : input.authIssueMessage
        ? [input.authIssueMessage]
        : [];
}

async function loadWorkCliSession(argv: readonly string[]) {
  const { cwd, provider, model, reasoning, sessionId, prompt } = parseArgs([...argv]);
  const config = await loadConfig({
    cwd,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    allowProblematicOpenAIAuth: true,
  });
  const guidance = await loadCachedWorkspaceGuidance({
    cwd,
    ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
  });
  const pluginOverlays = loadExtensionConfigOverlays({
    workspaceRoot: cwd,
    ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
  });
  const configExplanation = explainUncleCodeConfig({
    workspaceRoot: cwd,
    env: process.env,
    pluginOverlays,
  });
  const systemPromptAppendix = [
    configExplanation.prompt.rendered
      ? `Configured prompt:\n\n${configExplanation.prompt.rendered}`
      : "",
    guidance.systemPromptAppendix,
  ]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
  const directAgent = await createRuntimeCodingAgent({
    provider: resolveRuntimeProvider(config.provider),
    apiKey: config.apiKey,
    model: config.model,
    cwd,
    reasoning: config.reasoning,
    ...(systemPromptAppendix ? { systemPrompt: systemPromptAppendix } : {}),
  });

  const agent = new WorkAgent({
    directAgent,
    mode: config.mode,
    reasoning: config.reasoning,
    model: config.model,
    async runExecutableGuardianChecks(input) {
      const scripts = input.mode === "ultrawork"
        ? ["lint", "check", "test"]
        : ["check", "test"];
      return runWorkspaceGuardianChecks({
        cwd,
        env: process.env,
        scripts,
        changedFiles: input.changedFiles,
      });
    },
  });

  const refreshAuthState = async (): Promise<{ authLabel: string; authIssueLines?: readonly string[] }> => {
    const status = await resolveOpenAIAuthStatus({ env: process.env });
    const resolved = await resolveOpenAIAuth({
      env: process.env,
      ...(process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim()
        ? { fallbackAuthPath: process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH.trim() }
        : {}),
    });

    directAgent.refreshAuthToken(resolved.status === "ok" ? resolved.bearerToken : "");
    return {
      authLabel: status.activeSource,
      authIssueLines: deriveAuthIssueLines({
        ...(status ? { authStatus: status } : {}),
        ...(config.authIssueMessage ? { authIssueMessage: config.authIssueMessage } : {}),
      }),
    };
  };

  const authStatus = config.provider === "openai-api"
    ? await resolveOpenAIAuthStatus({ env: process.env })
    : undefined;
  const browserOAuthAvailable = config.provider === "openai-api"
    ? Boolean(process.env.OPENAI_OAUTH_CLIENT_ID?.trim())
    : false;
  const authIssueLines = deriveAuthIssueLines({
    ...(authStatus ? { authStatus } : {}),
    ...(config.authIssueMessage ? { authIssueMessage: config.authIssueMessage } : {}),
  });

  const resumedSession = sessionId
    ? await loadResumedWorkSession({ cwd, sessionId, env: process.env })
    : undefined;
  const refreshHomeState = () =>
    buildTuiHomeState({
      workspaceRoot: cwd,
      env: process.env,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    });
  const homeState = await refreshHomeState();

  return {
    agent,
    prompt,
    options: {
      provider: resolveRuntimeProvider(config.provider),
      model: config.model,
      mode: config.mode,
      authLabel: config.authLabel,
      reasoning: config.reasoning,
      cwd,
      contextSummaryLines: [
        ...authIssueLines,
        ...(await buildWorkShellContextSummary({
          cwd,
          ...(resumedSession?.contextLine
            ? { resumedContextLine: resumedSession.contextLine }
            : {}),
        })),
      ],
      homeState,
      ...(resumedSession?.sessionId ? { sessionId: resumedSession.sessionId } : {}),
      ...(resumedSession?.initialTraceMode
        ? { initialTraceMode: resumedSession.initialTraceMode }
        : {}),
      reloadWorkspaceContext: async (workspaceRoot: string) =>
        buildWorkShellContextSummary({
          cwd: workspaceRoot,
          ...(resumedSession?.contextLine
            ? { resumedContextLine: resumedSession.contextLine }
            : {}),
          forceRefresh: true,
        }),
      refreshHomeState,
      refreshAuthState,
      browserOAuthAvailable,
      runInlineCommand: (args: readonly string[]) => runInlineCommand(args, cwd),
      saveApiKeyAuth: (raw: string) => runTuiSessionCenterAction({
        actionId: "api-key-login",
        workspaceRoot: cwd,
        env: process.env,
        prompt: raw,
        ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
      }),
    },
  };
}

export function createManagedDashboardProps(session: ManagedDashboardSession) {
  return createManagedWorkShellDashboardProps(createManagedDashboardInput(session));
}

export function createWorkShellDashboardProps(
  agent: StartReplAgent,
  options: StartReplOptions,
) {
  return createManagedDashboardProps({ agent, options });
}

export async function startRepl(
  agent: StartReplAgent,
  options: StartReplOptions,
): Promise<void> {
  await renderManagedWorkShellDashboard(createManagedDashboardInput({ agent, options }));
}

export async function loadWorkShellDashboardProps(
  argv: readonly string[] = [],
) {
  const session = await loadWorkCliSession(argv);
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

  const session = await loadWorkCliSession(argv);
  if (session.prompt) {
    const result = await session.agent.runTurn(session.prompt);
    process.stdout.write(`${result.text}\n`);
    return;
  }

  await startRepl(session.agent, session.options);
}
