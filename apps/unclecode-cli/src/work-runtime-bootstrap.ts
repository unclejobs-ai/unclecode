import { createHash } from "node:crypto";

import { explainUncleCodeConfig } from "@unclecode/config-core";
import { createAgentOpsRecorder, runRustCommand } from "@unclecode/orchestrator";
import { LspBridge } from "@unclecode/lsp-bridge";
import {
  attachPromptManifestToPacket,
  augmentContextPacketViewInput,
  clearCachedWorkspaceGuidance,
  createPromptManifest,
  ingestWorkspaceBootstrapContext,
  loadCachedWorkspaceGuidance,
  loadOmoContextSnapshot,
  resolveContextProfile,
  promoteScopedMemory,
} from "@unclecode/context-broker";
import type {
  ContextPacketView,
  ContextPacketViewItem,
  ContextPacketViewWarning,
  PromptManifestPolicySource,
} from "@unclecode/contracts";
import {
  buildContextPacketSourceRefs,
  buildMandatorySourceIds,
  classifyContextPacketChange,
  clearExtensionRegistryCache,
  CodingAgent,
  loadConfig,
  loadExtensionConfigOverlays,
  loadExtensionManifestSummaries,
  WorkAgent,
  resolveWorkShellTerminalUiLocale,
  type AppReasoningConfig,
  type WorkTurnAgent,
} from "@unclecode/orchestrator";

import {
  buildResumeSummary,
  buildTuiHomeState,
  runTuiSessionCenterAction,
  runWorkShellInlineAction,
} from "./operational.js";
import {
  parseArgs,
  resolveRuntimeProvider,
} from "./work-runtime-args.js";
import type {
  StartReplAgent,
  StartReplOptions,
} from "./work-runtime-dashboard.js";
import {
  deriveAuthIssueLines,
  loadResumedWorkSession,
  resolveRustOpenAIAuth,
  resolveRustOpenAIAuthStatus,
  workShellAuthLabelWithApiBlocked,
  type RustOpenAIAuthStatus,
} from "./work-runtime-session.js";
import { runWorkspaceGuardianChecks } from "./guardian-checks.js";
import type { GuardianLspBridge } from "./guardian-check-types.js";
import { createRuntimeCodingAgent } from "./runtime-coding-agent.js";
import { resolveDefaultWorkEngine, resolveWorkShellAuthLabel } from "./work-engine-auth.js";
import {
  createPiBridgeProvider,
  resolveCodexOAuthBridgeArgs,
  resolvePiProviderBaseUrl,
} from "@unclecode/pi-bridge";
import {
  createOmpAuthCatalogClient,
  createOmpWorkerProvider,
  OMP_WORKER_DEFAULT_MODEL,
  OMP_WORKER_PROVIDER_ID,
  type ToolRuntime,
} from "@unclecode/providers";
import {
  PluginHost,
  registerBuiltInSccQualityEngine,
} from "@unclecode/plugin-host";
import { loadMcpHostRegistry } from "@unclecode/mcp-host";
import type { RuntimeSessionObservabilitySource } from "@unclecode/server";

const MAX_SESSION_MCP_OBSERVABILITY = 64;
import {
  buildContextLineItems,
  buildContextSummaryItems,
  buildOmoExcludedPacketItems,
  buildWorkGraphContextItems,
  estimateTokens,
  formatCountLabel,
} from "./work-runtime-context-items.js";
import {
  createCrpRuntime,
  reconcileResumedContextLifecycle,
  resolveWorkShellCrpConfig,
  type WorkShellContextPacketResolver,
} from "./work-runtime-crp.js";
import {
  createHostHeldOutWorktreeEvaluator,
  createWorkCreatorEvolutionService,
} from "./creator-evolution-runtime.js";

const WORK_PI_TURN_STEP_LIMIT = 16;
const WORK_PI_TURN_COST_LIMIT_USD = 2;

type QualityReviewProvider = "openai" | "anthropic" | "gemini" | "deepseek";

export type QualityReviewSelection = {
  readonly provider: QualityReviewProvider;
  readonly model: string;
  readonly distinct: boolean;
};

const QUALITY_REVIEW_PROVIDER_ORDER: readonly QualityReviewProvider[] = [
  "anthropic",
  "gemini",
  "deepseek",
  "openai",
];

const QUALITY_REVIEW_PROVIDER_ENV = {
  openai: { key: "OPENAI_API_KEY", model: "OPENAI_MODEL", fallback: "gpt-5.6-sol" },
  anthropic: { key: "ANTHROPIC_API_KEY", model: "ANTHROPIC_MODEL", fallback: "claude-sonnet-4-20250514" },
  gemini: { key: "GEMINI_API_KEY", model: "GEMINI_MODEL", fallback: "gemini-2.5-flash" },
  deepseek: { key: "DEEPSEEK_API_KEY", model: "DEEPSEEK_MODEL", fallback: "deepseek-chat" },
} as const;

function isQualityReviewProvider(value: string | undefined): value is QualityReviewProvider {
  return value === "openai" || value === "anthropic" || value === "gemini" || value === "deepseek";
}

/** Picks a real configured alternate route; otherwise a separate no-tools agent uses the direct route. */
export function resolveQualityReviewSelection(input: {
  readonly directProvider: QualityReviewProvider;
  readonly directModel: string;
  readonly env: NodeJS.ProcessEnv;
}): QualityReviewSelection {
  const explicitProvider = input.env.UNCLECODE_REVIEW_PROVIDER?.trim().toLowerCase();
  if (explicitProvider && !isQualityReviewProvider(explicitProvider)) {
    throw new Error(`Unsupported UNCLECODE_REVIEW_PROVIDER: ${explicitProvider}`);
  }
  const requestedProvider = isQualityReviewProvider(explicitProvider) ? explicitProvider : undefined;
  const explicitModel = input.env.UNCLECODE_REVIEW_MODEL?.trim();
  const candidates: readonly QualityReviewProvider[] = requestedProvider
    ? [requestedProvider]
    : explicitModel
      ? [input.directProvider]
      : QUALITY_REVIEW_PROVIDER_ORDER.filter((provider) => provider !== input.directProvider);
  for (const provider of candidates) {
    const fields = QUALITY_REVIEW_PROVIDER_ENV[provider];
    const configured = provider === input.directProvider || Boolean(input.env[fields.key]?.trim());
    if (!configured) continue;
    const model = explicitModel
      ?? input.env[fields.model]?.trim()
      ?? (provider === input.directProvider ? input.directModel : fields.fallback);
    return {
      provider,
      model,
      distinct: provider !== input.directProvider,
    };
  }
  return {
    provider: input.directProvider,
    model: input.directModel,
    distinct: false,
  };
}

export function resolveCreatorHeldOutReviewerSelection(input: {
  readonly creatorProvider: QualityReviewProvider;
  readonly evaluatorProvider: QualityReviewProvider;
  readonly env: NodeJS.ProcessEnv;
}): QualityReviewSelection | undefined {
  const explicitProvider = input.env.UNCLECODE_CREATOR_REVIEW_PROVIDER?.trim().toLowerCase();
  if (explicitProvider && !isQualityReviewProvider(explicitProvider)) {
    throw new Error(`Unsupported UNCLECODE_CREATOR_REVIEW_PROVIDER: ${explicitProvider}`);
  }
  const candidates: readonly QualityReviewProvider[] = isQualityReviewProvider(explicitProvider)
    ? [explicitProvider]
    : QUALITY_REVIEW_PROVIDER_ORDER;
  for (const provider of candidates) {
    if (provider === input.creatorProvider || provider === input.evaluatorProvider) continue;
    const fields = QUALITY_REVIEW_PROVIDER_ENV[provider];
    if (!input.env[fields.key]?.trim()) continue;
    return {
      provider,
      model: input.env.UNCLECODE_CREATOR_REVIEW_MODEL?.trim()
        ?? input.env[fields.model]?.trim()
        ?? fields.fallback,
      distinct: true,
    };
  }
  return undefined;
}

/**
 * Build one work/executor agent backed by OMP.
 *
 * Executor turns run entirely inside OMP: it routes the request, executes its
 * own tool loop, and resolves its own credentials from its own profile — so the
 * executor needs neither UncleCode's tool runtime nor a bearer token. Because
 * that process boundary has no approval bridge, the worker exposes only its
 * fixed workspace-file tool allowlist; shell and externally acting tools stay
 * on UncleCode-owned runtimes. The surrounding `CodingAgent` still brackets
 * the turn with the standard trace/usage events, under the `omp` provider
 * identity and the OMP selector.
 *
 * The selector is fixed to `OMP_WORKER_DEFAULT_MODEL`: work turns always run on
 * Kimi K3. There is deliberately no caller input and no environment override —
 * a delegated turn that silently ran on a different upstream model would make
 * every trace, cost figure, and guardian verdict unattributable.
 *
 * The interactive/direct conversation agent is deliberately untouched and stays
 * on the configured runtime.
 */
export function createWorkExecutorAgent(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly reasoning: AppReasoningConfig;
}): WorkTurnAgent {
  return new CodingAgent({
    providerName: OMP_WORKER_PROVIDER_ID,
    model: OMP_WORKER_DEFAULT_MODEL,
    provider: createOmpWorkerProvider({
      cwd: input.cwd,
      env: input.env,
      model: OMP_WORKER_DEFAULT_MODEL,
      reasoning: input.reasoning,
    }),
  });
}

export type WorkCliBootstrapInput = {
  argv: readonly string[];
  role?: "owner" | "client" | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  userHomeDir?: string | undefined;
  lspBridge?: GuardianLspBridge | undefined;
  /** Runtime-owner embedding seam; route identity remains derived from host configuration. */
  creatorEvolutionRuntime?: {
    readonly createCreatorAgent?: (() => WorkTurnAgent | Promise<WorkTurnAgent>) | undefined;
    readonly createHeldOutWorkloadAgent?: ((input: {
      readonly kind: "baseline" | "candidate";
      readonly creatorSystemPrompt: string;
    }) => WorkTurnAgent | Promise<WorkTurnAgent>) | undefined;
    readonly createHeldOutEvaluatorAgent?: (() => WorkTurnAgent | Promise<WorkTurnAgent>) | undefined;
    readonly createHeldOutReviewerAgent?: (() => WorkTurnAgent | Promise<WorkTurnAgent>) | undefined;
    readonly evaluatorTurnTimeoutMs?: number | undefined;
    readonly evaluatorAbortSettlementGraceMs?: number | undefined;
  } | undefined;
};

export function createRuntimeClientAgent(): StartReplAgent {
  return {
    async runTurn() {
      throw new Error("The TUI client must execute turns through the runtime owner attachment.");
    },
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
  };
}

export type WorkCliBootstrapResult = {
  agent: StartReplAgent;
  prompt: string;
  options: StartReplOptions;
  dispose?: (() => void | Promise<void>) | undefined;
  readObservability?: (() => RuntimeSessionObservabilitySource) | undefined;
};

async function runInlineCommand(input: {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  userHomeDir?: string | undefined;
  onProgress?: ((line: string) => void) | undefined;
}): Promise<readonly string[]> {
  return runWorkShellInlineAction({
    args: input.args,
    workspaceRoot: input.cwd,
    env: input.env,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}

async function buildWorkShellContextSummary(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  userHomeDir?: string | undefined;
  resumedContextLine?: string | undefined;
  forceRefresh?: boolean | undefined;
}): Promise<readonly string[]> {
  if (input.forceRefresh) {
    clearCachedWorkspaceGuidance(input.cwd, input.userHomeDir);
    clearExtensionRegistryCache({
      workspaceRoot: input.cwd,
      env: input.env,
      ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
    });
  }

  const guidance = await loadCachedWorkspaceGuidance({
    cwd: input.cwd,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const extensionSummaries = loadExtensionManifestSummaries({
    workspaceRoot: input.cwd,
    env: input.env,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
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

function buildProviderSystemPromptMetadata(input: {
  readonly configuredPrompt: string;
  readonly guidanceSystemPrompt: string;
  readonly guidanceSources: readonly string[];
}): readonly ContextPacketViewItem[] {
  const items: ContextPacketViewItem[] = [];

  if (input.configuredPrompt.trim().length > 0) {
    items.push({
      id: "provider-system-prompt-configured",
      category: "provider-system-prompt",
      label: "Configured prompt",
      reason: "prompt guidance active",
      preview: "Configured prompt sections are active; raw prompt text stays local.",
    });
  }

  if (input.guidanceSystemPrompt.trim().length > 0) {
    items.push({
      id: "provider-system-prompt-workspace-guidance",
      category: "provider-system-prompt",
      label: "Workspace guidance system prompt",
      reason: "workspace guidance active",
      preview: `${formatCountLabel(input.guidanceSources.length, "guidance source", "guidance sources")} ready for the next answer.`,
    });
  }

  return items;
}
function createContextSourceDetailResolver(input: {
  readonly configuredPrompt: string;
  readonly guidanceSystemPrompt: string;
}): (sourceId: string) => Promise<string | undefined> {
  const details = new Map<string, string>();
  const configuredPrompt = input.configuredPrompt.trim();
  if (configuredPrompt.length > 0) {
    details.set("provider-system-prompt-configured", configuredPrompt);
  }
  const guidanceSystemPrompt = input.guidanceSystemPrompt.trim();
  if (guidanceSystemPrompt.length > 0) {
    details.set("provider-system-prompt-workspace-guidance", guidanceSystemPrompt);
  }
  return async (sourceId) => details.get(sourceId);
}


function buildPromptManifestPolicySources(input: {
  readonly configuredPrompt: string;
  readonly guidanceSources: readonly {
    readonly id: string;
    readonly label: string;
    readonly authority: "mandatory" | "profile-eligible";
    readonly sha256: string;
  }[];
}): readonly PromptManifestPolicySource[] {
  const configuredPrompt = input.configuredPrompt.trim();
  return [
    ...(configuredPrompt.length > 0
      ? [{
          id: "provider-system-prompt-configured",
          label: "Configured prompt",
          authority: "mandatory" as const,
          digest: createHash("sha256").update(configuredPrompt).digest("hex"),
        }]
      : []),
    ...input.guidanceSources.map((source) => ({
      id: source.id,
      label: source.label,
      authority: source.authority,
      digest: source.sha256,
    })),
  ];
}

function createInitialHomeState(input: {
  readonly modeLabel: string;
  readonly authLabel: string;
}): StartReplOptions["homeState"] {
  return {
    modeLabel: input.modeLabel,
    authLabel: input.authLabel,
    sessions: [],
    sessionCount: 0,
    mcpServerCount: 0,
    mcpServers: [],
    bridgeLines: [],
    memoryLines: [],
  };
}

function createPacketId(input: {
  readonly sessionId: string;
  readonly included: readonly ContextPacketViewItem[];
  readonly excluded: readonly ContextPacketViewItem[];
  readonly warnings: readonly ContextPacketViewWarning[];
}): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 12);
  return `packet-${hash}`;
}

function createWorkShellContextPacketResolver(options: {
  readonly sourceMetadata: readonly ContextPacketViewItem[];
  readonly bootstrapPacketItems?: readonly ContextPacketViewItem[];
  readonly bootstrapPacketWarnings?: readonly ContextPacketViewWarning[];
}): WorkShellContextPacketResolver {
  return async (input): Promise<ContextPacketView> => {
    const loopTrail = await loadOmoContextSnapshot(input.cwd);
    const included: ContextPacketViewItem[] = [
      ...options.sourceMetadata,
      ...buildContextSummaryItems(input.contextSummaryLines),
      ...buildContextLineItems({
        lines: input.bridgeLines,
        category: "bridge",
        idPrefix: "context-bridge",
        reason: "project context bridge",
      }),
      ...buildContextLineItems({
        lines: input.memoryLines,
        category: "memory",
        idPrefix: "context-memory",
        reason: "scoped memory",
      }),
      ...buildContextLineItems({
        lines: input.traceLines,
        category: "runtime",
        idPrefix: "runtime-trace",
        reason: "live work-shell trace",
      }),
      ...buildWorkGraphContextItems(input.workGraph),
      ...loopTrail.included.map((item): ContextPacketViewItem => ({
        id: item.kind === "omo-goal"
          ? `loop-trail-goal-${item.sessionId}-${item.goalId}`
          : `loop-trail-criterion-${item.sessionId}-${item.goalId}-${item.criterionId}`,
        category: "loop-trail",
        label: item.kind === "omo-goal"
          ? `${item.goalId} · ${item.status}`
          : `${item.goalId}/${item.criterionId} · ${item.status}`,
        reason: item.kind === "omo-goal" ? "active loop trail goal context" : "loop trail success criterion context",
        preview: item.summary,
        tokenEstimate: estimateTokens(item.summary),
      })),
    ];
    const excluded = buildOmoExcludedPacketItems(loopTrail.excluded);
    const warnings: ContextPacketViewWarning[] = [
      ...loopTrail.warnings.map((message, index) => ({
        code: `loop-trail.warning.${index + 1}`,
        message,
        severity: "warning" as const,
      })),
      ...(options.bootstrapPacketWarnings ?? []),
    ];
    const id = createPacketId({
      sessionId: input.sessionId,
      included,
      excluded,
      warnings,
    });

    return augmentContextPacketViewInput({
      base: {
        id,
        generatedAt: new Date().toISOString(),
        title: "Next answer context",
        included: [...included, ...(options.bootstrapPacketItems ?? [])],
        excluded,
        warnings,
        preview: [
          "UncleCode will carry these summaries into the next answer.",
          "Raw loop trail artifacts stay local.",
        ],
      },
    });
  };
}

export async function loadWorkCliBootstrap(
  input: WorkCliBootstrapInput,
): Promise<WorkCliBootstrapResult> {
  const env = input.env ?? process.env;
  const runtimeRole = input.role ?? "owner";
  const userHomeDir = input.userHomeDir ?? env.HOME;
  const { cwd, provider, model, reasoning, sessionId, prompt, engine } = parseArgs([
    ...input.argv,
  ]);
  const activeEngine = engine ?? resolveDefaultWorkEngine(env);
  if (runtimeRole === "client") {
    const config = await loadConfig({
      cwd,
      env,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      allowProblematicOpenAIAuth: true,
    });
    const pluginOverlays = loadExtensionConfigOverlays({
      workspaceRoot: cwd,
      env,
      ...(userHomeDir ? { userHomeDir } : {}),
    });
    const configExplanation = explainUncleCodeConfig({
      workspaceRoot: cwd,
      env,
      pluginOverlays,
    });
    const contextProfile = resolveContextProfile(
      configExplanation.settings.contextProfile.value,
    );
    const crpConfig = resolveWorkShellCrpConfig(configExplanation);
    const runtimeProvider = resolveRuntimeProvider(config.provider);
    const codexOAuthAvailable = Boolean(resolveCodexOAuthBridgeArgs({
      provider: runtimeProvider,
      apiKey: config.apiKey,
      openAIRuntime: config.openAIRuntime,
    }));
    const authLabel = resolveWorkShellAuthLabel({
      engine: activeEngine,
      configuredLabel: config.authLabel,
      codexOAuthAvailable,
    });
    const modeLabel = (await runRustCommand(
      ["rust", "ux", "text", "mode-label"],
      cwd,
      config.mode,
      env,
    )).trim();

    return {
      agent: createRuntimeClientAgent(),
      prompt: prompt ?? "",
      options: {
        provider: runtimeProvider,
        model: config.model,
        mode: config.mode,
        authLabel,
        reasoning: config.reasoning,
        modelWindow: crpConfig.modelWindow,
        contextProfile: contextProfile.id,
        motion: configExplanation.settings.motion.value,
        cwd,
        contextSummaryLines: deriveAuthIssueLines({
          ...(config.authIssueMessage
            ? { authIssueMessage: config.authIssueMessage }
            : {}),
        }),
        homeState: createInitialHomeState({ modeLabel, authLabel }),
        ...(sessionId ? { sessionId } : {}),
        browserOAuthAvailable: config.provider === "openai"
          && Boolean(env.OPENAI_OAUTH_CLIENT_ID?.trim()),
      },
    };
  }
  const resumedSession = sessionId
    ? await loadResumedWorkSession({ cwd, sessionId, env })
    : undefined;
  const config = await loadConfig({
    cwd,
    env,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reasoning !== undefined
      ? { reasoning }
      : resumedSession?.reasoningEffort
        ? { reasoning: resumedSession.reasoningEffort }
        : {}),
    allowProblematicOpenAIAuth: true,
  });
  const guidance = await loadCachedWorkspaceGuidance({
    cwd,
    ...(userHomeDir ? { userHomeDir } : {}),
  });
  const pluginOverlays = loadExtensionConfigOverlays({
    workspaceRoot: cwd,
    env,
    ...(userHomeDir ? { userHomeDir } : {}),
  });
  const configExplanation = explainUncleCodeConfig({
    workspaceRoot: cwd,
    env,
    pluginOverlays,
  });
  const contextProfile = resolveContextProfile(configExplanation.settings.contextProfile.value);
  const terminalUiLocale = resolveWorkShellTerminalUiLocale(env, "en");
  // Shell chrome follows the operator's terminal preference. The current
  // provider turn detects its response language independently from user prose,
  // so Korean conversation content can never relocalize or persist the TUI.
  const initialUiLocale = terminalUiLocale;
  const initialUiLocaleLocked = false;
  const systemPromptAppendix = [
    configExplanation.prompt.rendered
      ? `Configured prompt:\n\n${configExplanation.prompt.rendered}`
      : "",
    guidance.systemPromptAppendix,
  ]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
  const promptManifestPolicy = buildPromptManifestPolicySources({
    configuredPrompt: configExplanation.prompt.rendered,
    guidanceSources: guidance.guidanceSources,
  });
  const createTurnPromptManifest = (packet: ContextPacketView, userPrompt: string) =>
    createPromptManifest({
      profile: contextProfile,
      packet,
      policy: promptManifestPolicy,
      systemPromptAppendix,
      userPrompt,
    });
  const contextPacketSourceMetadata = buildProviderSystemPromptMetadata({
    configuredPrompt: configExplanation.prompt.rendered,
    guidanceSystemPrompt: guidance.systemPromptAppendix,
    guidanceSources: guidance.sources,
  });
  const resolveContextSourceDetail = createContextSourceDetailResolver({
    configuredPrompt: configExplanation.prompt.rendered,
    guidanceSystemPrompt: guidance.systemPromptAppendix,
  });
  const codexOAuthAvailable = () => Boolean(resolveCodexOAuthBridgeArgs({
    provider: resolveRuntimeProvider(config.provider),
    apiKey: config.apiKey,
    openAIRuntime: config.openAIRuntime,
  }));
  const createConfiguredCodingAgent = (
    apiKey: string,
    model: string,
    reasoning: typeof config.reasoning,
    mode: string,
  ) => createRuntimeCodingAgent({
    provider: resolveRuntimeProvider(config.provider),
    apiKey,
    model,
    cwd,
    reasoning,
    mode,
    ...(resumedSession?.initialAgentConsole?.securityApprovals
      ? { initialPermissionRules: resumedSession.initialAgentConsole.securityApprovals }
      : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(systemPromptAppendix ? { systemPrompt: systemPromptAppendix } : {}),
    ...(config.openAIRuntime ? { openAIRuntime: config.openAIRuntime } : {}),
    ...(config.openAIAccountId !== undefined
      ? { openAIAccountId: config.openAIAccountId }
      : {}),
    ...(activeEngine === "pi"
      ? {
          providerOverrideFactory: ({ toolRuntime }: { toolRuntime: ToolRuntime }) => {
            const runtimeProviderName = resolveRuntimeProvider(config.provider);
            const codexOAuth = resolveCodexOAuthBridgeArgs({
              provider: runtimeProviderName,
              apiKey,
              openAIRuntime: config.openAIRuntime,
            });
            const baseUrl = resolvePiProviderBaseUrl(runtimeProviderName, env);
            return createPiBridgeProvider({
              provider: runtimeProviderName,
              apiKey,
              model,
              cwd,
              reasoning,
              ...(systemPromptAppendix ? { systemPrompt: systemPromptAppendix } : {}),
              toolRuntime,
              toolLoopMax: WORK_PI_TURN_STEP_LIMIT,
              costLimitUsd: WORK_PI_TURN_COST_LIMIT_USD,
              ...(codexOAuth ?? {}),
              ...(baseUrl ? { baseUrl } : {}),
            });
          },
        }
      : {}),
  });
  const directAgent = runtimeRole === "owner"
    ? await createConfiguredCodingAgent(
        config.apiKey,
        config.model,
        config.reasoning,
        config.mode,
      )
    : undefined;
  const directRuntimeProvider = resolveRuntimeProvider(config.provider);
  const reviewSelection = resolveQualityReviewSelection({
    directProvider: directRuntimeProvider,
    directModel: config.model,
    env,
  });
  const reviewConfig = reviewSelection.provider === directRuntimeProvider
      && reviewSelection.model === config.model
    ? config
    : await loadConfig({
        cwd,
        env,
        provider: reviewSelection.provider,
        model: reviewSelection.model,
        allowProblematicOpenAIAuth: true,
      });
  const reviewAgent = runtimeRole === "owner"
    ? await createRuntimeCodingAgent({
        provider: resolveRuntimeProvider(reviewConfig.provider),
        apiKey: reviewConfig.apiKey,
        model: reviewConfig.model,
        cwd,
        reasoning: reviewConfig.reasoning,
        mode: reviewConfig.mode,
        toolAccess: "none",
        ...(reviewConfig.baseUrl ? { baseUrl: reviewConfig.baseUrl } : {}),
        ...(systemPromptAppendix ? { systemPrompt: systemPromptAppendix } : {}),
        ...(reviewConfig.openAIRuntime ? { openAIRuntime: reviewConfig.openAIRuntime } : {}),
        ...(reviewConfig.openAIAccountId !== undefined
          ? { openAIAccountId: reviewConfig.openAIAccountId }
          : {}),
      })
    : undefined;
  const heldOutReviewerSelection = reviewSelection.distinct
    ? resolveCreatorHeldOutReviewerSelection({
        creatorProvider: directRuntimeProvider,
        evaluatorProvider: reviewSelection.provider,
        env,
      })
    : undefined;
  const heldOutReviewerConfig = heldOutReviewerSelection
    ? await loadConfig({
        cwd,
        env,
        provider: heldOutReviewerSelection.provider,
        model: heldOutReviewerSelection.model,
        allowProblematicOpenAIAuth: true,
      })
    : undefined;

  const recorder = createAgentOpsRecorder({
    workspaceRoot: cwd,
    command: "unclecode work",
    ...(resumedSession?.sessionId ? { sessionId: resumedSession.sessionId } : {}),
  });

  let recordPluginDiagnostic: ((diagnostic: import("@unclecode/plugin-host").PluginInvocationDiagnostic) => void) | undefined;
  const pluginHost = new PluginHost({
    onDiagnostic: (diagnostic) => recordPluginDiagnostic?.(diagnostic),
  });
  let pluginHostDisposal: Promise<void> | undefined;
  const disposePluginHost = (): Promise<void> => {
    pluginHostDisposal ??= pluginHost.dispose();
    return pluginHostDisposal;
  };
  try {
    registerBuiltInSccQualityEngine(pluginHost, { workspaceRoot: cwd, env });
    await pluginHost.loadFromDisk(cwd, {
      env,
      ...(input.userHomeDir ? { homeDir: input.userHomeDir } : {}),
    });
  const createHeldOutEvaluatorAgent = input.creatorEvolutionRuntime?.createHeldOutEvaluatorAgent
    ?? (() => createRuntimeCodingAgent({
        provider: resolveRuntimeProvider(reviewConfig.provider),
        apiKey: reviewConfig.apiKey,
        model: reviewConfig.model,
        cwd,
        reasoning: reviewConfig.reasoning,
        mode: reviewConfig.mode,
        toolAccess: "none",
        ...(reviewConfig.baseUrl ? { baseUrl: reviewConfig.baseUrl } : {}),
        ...(reviewConfig.openAIRuntime ? { openAIRuntime: reviewConfig.openAIRuntime } : {}),
        ...(reviewConfig.openAIAccountId !== undefined
          ? { openAIAccountId: reviewConfig.openAIAccountId }
          : {}),
      }));
  const createHeldOutWorkloadAgent = input.creatorEvolutionRuntime?.createHeldOutWorkloadAgent
    ?? ((workload: { readonly creatorSystemPrompt: string }) => createRuntimeCodingAgent({
      provider: directRuntimeProvider,
      apiKey: config.apiKey,
      model: config.model,
      cwd,
      reasoning: config.reasoning,
      mode: config.mode,
      toolAccess: "none",
      systemPrompt: workload.creatorSystemPrompt,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.openAIRuntime ? { openAIRuntime: config.openAIRuntime } : {}),
      ...(config.openAIAccountId !== undefined
        ? { openAIAccountId: config.openAIAccountId }
        : {}),
    }));
  const createHeldOutReviewerAgent = input.creatorEvolutionRuntime?.createHeldOutReviewerAgent
    ?? (heldOutReviewerConfig
      ? () => createRuntimeCodingAgent({
          provider: resolveRuntimeProvider(heldOutReviewerConfig.provider),
          apiKey: heldOutReviewerConfig.apiKey,
          model: heldOutReviewerConfig.model,
          cwd,
          reasoning: heldOutReviewerConfig.reasoning,
          mode: heldOutReviewerConfig.mode,
          toolAccess: "none",
          ...(heldOutReviewerConfig.baseUrl ? { baseUrl: heldOutReviewerConfig.baseUrl } : {}),
          ...(heldOutReviewerConfig.openAIRuntime
            ? { openAIRuntime: heldOutReviewerConfig.openAIRuntime }
            : {}),
          ...(heldOutReviewerConfig.openAIAccountId !== undefined
            ? { openAIAccountId: heldOutReviewerConfig.openAIAccountId }
            : {}),
        })
      : undefined);
  const evaluateHeldOutWorktrees = reviewSelection.distinct
    && heldOutReviewerSelection
    && createHeldOutReviewerAgent
      ? createHostHeldOutWorktreeEvaluator({
          cwd,
          creator: {
            provider: directRuntimeProvider,
            model: config.model,
          },
          evaluator: {
            provider: reviewSelection.provider,
            model: reviewSelection.model,
          },
          reviewer: {
            provider: heldOutReviewerSelection.provider,
            model: heldOutReviewerSelection.model,
          },
          createWorkloadAgent: createHeldOutWorkloadAgent,
          createEvaluatorAgent: createHeldOutEvaluatorAgent,
          createReviewerAgent: createHeldOutReviewerAgent,
          ...(input.creatorEvolutionRuntime?.evaluatorTurnTimeoutMs === undefined
            ? {}
            : { evaluatorTurnTimeoutMs: input.creatorEvolutionRuntime.evaluatorTurnTimeoutMs }),
          ...(input.creatorEvolutionRuntime?.evaluatorAbortSettlementGraceMs === undefined
            ? {}
            : {
                evaluatorAbortSettlementGraceMs:
                  input.creatorEvolutionRuntime.evaluatorAbortSettlementGraceMs,
              }),
        })
      : undefined;
  const creatorEvolutionService = createWorkCreatorEvolutionService({
    cwd,
    env,
    reasoning: config.reasoning,
    recorder,
    ...(evaluateHeldOutWorktrees ? { evaluateHeldOutWorktrees } : {}),
    ...(evaluateHeldOutWorktrees && heldOutReviewerSelection
      ? {
          heldOutProviderIdentities: {
            creator: { provider: directRuntimeProvider, model: config.model },
            evaluator: { provider: reviewSelection.provider, model: reviewSelection.model },
            reviewer: {
              provider: heldOutReviewerSelection.provider,
              model: heldOutReviewerSelection.model,
            },
          },
        }
      : {}),
    createCreatorAgent: input.creatorEvolutionRuntime?.createCreatorAgent
      ?? (() => createRuntimeCodingAgent({
        provider: directRuntimeProvider,
        apiKey: config.apiKey,
        model: config.model,
        cwd,
        reasoning: config.reasoning,
        mode: config.mode,
        toolAccess: "none",
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(systemPromptAppendix ? { systemPrompt: systemPromptAppendix } : {}),
        ...(config.openAIRuntime ? { openAIRuntime: config.openAIRuntime } : {}),
        ...(config.openAIAccountId !== undefined
          ? { openAIAccountId: config.openAIAccountId }
          : {}),
      })),
  });

  const ownerAgent = directAgent && reviewAgent ? new WorkAgent({
      directAgent,
      reviewAgent,
    createExecutorAgent: async (settings) => createWorkExecutorAgent({
      cwd,
      env,
      reasoning: settings.reasoning,
    }),
    mode: config.mode,
    reasoning: config.reasoning,
    model: config.model,
    workspaceRoot: cwd,
    pluginHost,
    creatorEvolutionService,
    directRoute: {
      provider: directRuntimeProvider,
      model: config.model,
    },
    reviewRoute: {
      provider: reviewSelection.provider,
      model: reviewSelection.model,
    },
    commodityRoute: {
      provider: OMP_WORKER_PROVIDER_ID,
      model: OMP_WORKER_DEFAULT_MODEL,
    },
    async runExecutableGuardianChecks(guardianInput) {
      const scripts = guardianInput.mode === "ultrawork" || guardianInput.mode === "yolo"
        ? ["lint", "check", "test"]
        : ["check", "test"];
      const lspBridge = input.lspBridge ?? new LspBridge();
      return runWorkspaceGuardianChecks({
        cwd,
        env,
        scripts,
        changedFiles: guardianInput.changedFiles,
        lspBridge,
        signal: guardianInput.signal,
      });
    },
  }) : undefined;
  recordPluginDiagnostic = (diagnostic) => ownerAgent?.recordPluginDiagnostic(diagnostic);
  const agent: StartReplAgent = ownerAgent ?? createRuntimeClientAgent();

  const refreshAuthState = async (): Promise<{
    authLabel: string;
    authIssueLines?: readonly string[];
  }> => {
    if (config.provider !== "openai") {
      return {
        authLabel: resolveWorkShellAuthLabel({
          engine: activeEngine,
          configuredLabel: config.authLabel,
          codexOAuthAvailable: false,
        }),
        authIssueLines: [],
      };
    }
    const status = await resolveRustOpenAIAuthStatus({ cwd, env });
    const resolved = await resolveRustOpenAIAuth({ cwd, env });
    directAgent?.refreshAuthToken(resolved.status === "ok" ? resolved.bearerToken : "");
    return {
      authLabel: resolveWorkShellAuthLabel({
        engine: activeEngine,
        configuredLabel: status.activeSource,
        authStatus: status,
        codexOAuthAvailable: codexOAuthAvailable(),
      }),
      authIssueLines: deriveAuthIssueLines({
        ...(status ? { authStatus: status } : {}),
        ...(config.authIssueMessage
          ? { authIssueMessage: config.authIssueMessage }
          : {}),
      }),
    };
  };

  const authStatus = config.provider === "openai"
    ? await resolveRustOpenAIAuthStatus({ cwd, env })
    : undefined;
  const observabilityObservedAt = Date.now();
  const mcpEvidence = (() => {
    try {
      const mcpServers = loadMcpHostRegistry({
        workspaceRoot: cwd,
        ...(userHomeDir ? { userHomeDir } : {}),
      }).entries.slice(0, MAX_SESSION_MCP_OBSERVABILITY).map((entry) => ({
        name: entry.name,
        transport: entry.transport,
        configured: true,
        authentication: "unverified" as const,
        liveProbe: "not-run" as const,
        observedAt: observabilityObservedAt,
      }));
      return { status: "available" as const, mcpServers };
    } catch {
      return { status: "unavailable" as const, mcpServers: [] };
    }
  })();
  const browserOAuthAvailable = config.provider === "openai"
    ? Boolean(env.OPENAI_OAUTH_CLIENT_ID?.trim())
    : false;
  const authIssueLines = deriveAuthIssueLines({
    ...(authStatus ? { authStatus } : {}),
    ...(config.authIssueMessage ? { authIssueMessage: config.authIssueMessage } : {}),
  });
  const authLabel = resolveWorkShellAuthLabel({
    engine: activeEngine,
    configuredLabel: config.authLabel,
    ...(authStatus ? { authStatus } : {}),
    codexOAuthAvailable: codexOAuthAvailable(),
  });

  const refreshHomeState = () =>
    buildTuiHomeState({
      workspaceRoot: cwd,
      env,
      ...(userHomeDir ? { userHomeDir } : {}),
    });
  const modeLabel = (await runRustCommand(
    ["rust", "ux", "text", "mode-label"],
    cwd,
    config.mode,
    env,
  )).trim();
  const homeState = createInitialHomeState({
    modeLabel,
    authLabel,
  });

  const crpConfig = resolveWorkShellCrpConfig(configExplanation);
  let resumeIntegrityLines: readonly string[] = [];
  if (crpConfig.enabled && resumedSession !== undefined) {
    try {
      resumeIntegrityLines = reconcileResumedContextLifecycle({
        cwd,
        sessionId: resumedSession.sessionId,
        ...(resumedSession.lastSubmittedContextReceiptId
          ? {
              lastSubmittedContextReceiptId:
                resumedSession.lastSubmittedContextReceiptId,
            }
          : {}),
        ...(userHomeDir ? { userHomeDir } : {}),
      }).warningLines;
    } catch (error) {
      throw new Error(
        "Unable to resume safely: context integrity validation failed.",
        { cause: error },
      );
    }
  }
  const bootstrapContext = await ingestWorkspaceBootstrapContext({
    cwd,
    env,
    ...(userHomeDir ? { userHomeDir } : {}),
    ...(resumedSession?.sessionId ? { sessionId: resumedSession.sessionId } : {}),
  });
  const legacyContextPacketResolver = createWorkShellContextPacketResolver({
    sourceMetadata: contextPacketSourceMetadata,
    bootstrapPacketItems: bootstrapContext.packetItems,
    bootstrapPacketWarnings: bootstrapContext.packetWarnings,
  });
  const crpRuntime = createCrpRuntime(legacyContextPacketResolver, {
    sourceMetadata: contextPacketSourceMetadata,
    crpConfig,
    env,
    ...(userHomeDir ? { userHomeDir } : {}),
    ...(bootstrapContext.packetItems ? { bootstrapPacketItems: bootstrapContext.packetItems } : {}),
    ...(bootstrapContext.packetWarnings ? { bootstrapPacketWarnings: bootstrapContext.packetWarnings } : {}),
    workspaceRoot: cwd,
  });

  const resolveContextPacket: WorkShellContextPacketResolver = async (packetInput) => {
    const packet = await crpRuntime.resolveContextPacket(packetInput);
    return attachPromptManifestToPacket(packet, createTurnPromptManifest(packet, ""));
  };

  return {
    agent,
    prompt: prompt ?? "",
    dispose: disposePluginHost,
    readObservability: () => ({
      provider: {
        provider: directRuntimeProvider,
        model: config.model,
        configured: true,
        authentication: config.provider === "openai"
          ? authStatus?.activeSource === "none" ? "missing" : "unverified"
          : config.apiKey.trim().length > 0 ? "unverified" : "missing",
        liveProbe: "not-run",
        observedAt: observabilityObservedAt,
      },
      mcpServers: mcpEvidence.mcpServers,
      mcpConfigurationStatus: mcpEvidence.status,
      plugins: pluginHost.getLifecycleSnapshot(),
    }),
    options: {
      provider: resolveRuntimeProvider(config.provider),
      model: config.model,
      mode: config.mode,
      authLabel,
      reasoning: config.reasoning,
      modelWindow: crpConfig.modelWindow,
      contextProfile: contextProfile.id,
      motion: configExplanation.settings.motion.value,
      cwd,
      contextSummaryLines: [
        ...authIssueLines,
        ...bootstrapContext.summaryLines,
        ...resumeIntegrityLines,
        ...(await buildWorkShellContextSummary({
          cwd,
          env,
          ...(userHomeDir ? { userHomeDir } : {}),
          ...(resumedSession?.contextLine
            ? { resumedContextLine: resumedSession.contextLine }
            : {}),
        })),
      ],
      contextPacketSourceMetadata,
      homeState,
      ...(resumedSession?.sessionId ? { sessionId: resumedSession.sessionId } : {}),
      ...(resumedSession?.initialTraceMode
        ? { initialTraceMode: resumedSession.initialTraceMode }
        : {}),
      initialUiLocale,
      initialUiLocaleLocked,
      ...(resumedSession?.initialEntries
        ? { initialEntries: resumedSession.initialEntries }
        : {}),
      ...(resumedSession?.initialSessionSummary
        ? { initialSessionSummary: resumedSession.initialSessionSummary }
        : {}),
      ...(resumedSession?.lastSubmittedContextReceiptId
        ? {
            initialLastSubmittedContextReceiptId:
              resumedSession.lastSubmittedContextReceiptId,
          }
        : {}),
      ...(resumedSession?.initialAgentConsole
        ? { initialAgentConsole: resumedSession.initialAgentConsole }
        : {}),
      ...(resumedSession?.initialPauseCheckpoint
        ? { initialPauseCheckpoint: resumedSession.initialPauseCheckpoint }
        : {}),
      ...(directAgent ? { interactionBridge: directAgent.getInteractionBridge() } : {}),
      reloadWorkspaceContext: async (workspaceRoot: string) => {
        const refreshedBootstrap = await ingestWorkspaceBootstrapContext({
          cwd: workspaceRoot,
          env,
          ...(userHomeDir ? { userHomeDir } : {}),
          ...(resumedSession?.sessionId ? { sessionId: resumedSession.sessionId } : {}),
          persistMemoryFacts: false,
        });
        return [
          ...refreshedBootstrap.summaryLines,
          ...(await buildWorkShellContextSummary({
            cwd: workspaceRoot,
            env,
            ...(userHomeDir ? { userHomeDir } : {}),
            ...(resumedSession?.contextLine
              ? { resumedContextLine: resumedSession.contextLine }
              : {}),
            forceRefresh: true,
          })),
        ];
      },
      resolveContextPacket,
      resolveContextSourceDetail,
      resolvePromptManifest: ({ packet, userPrompt }) => createTurnPromptManifest(packet, userPrompt),
      refreshHomeState,
      refreshAuthState,
      browserOAuthAvailable,
      ompAuthCatalog: createOmpAuthCatalogClient({ env }),
      runInlineCommand: (
        args: readonly string[],
        onProgress?: ((line: string) => void) | undefined,
      ) =>
        runInlineCommand({
          args,
          cwd,
          env,
          ...(userHomeDir ? { userHomeDir } : {}),
          ...(onProgress ? { onProgress } : {}),
        }),
      runAction: ({ actionId, prompt, onProgress }) =>
        runTuiSessionCenterAction({
          actionId,
          workspaceRoot: cwd,
          env,
          ...(prompt ? { prompt } : {}),
          ...(userHomeDir ? { userHomeDir } : {}),
          ...(onProgress ? { onProgress } : {}),
        }),
      runSession: (sessionId) =>
        buildResumeSummary({
          sessionId,
          workspaceRoot: cwd,
          env,
        }),
      saveApiKeyAuth: (raw: string) =>
        runTuiSessionCenterAction({
          actionId: "api-key-login",
          workspaceRoot: cwd,
          env,
          prompt: raw,
          ...(userHomeDir ? { userHomeDir } : {}),
        }),
      ...(runtimeRole === "owner"
        ? { recordTurn: (turn) => recorder.recordTurn(turn) }
        : {}),
      mutateContextSource: crpRuntime.mutateContextSource,
      undoContextSourceAction: crpRuntime.undoLastContextSourceAction,
      previewContextPacket: ({ sessionId, packet, profile }) =>
        crpRuntime.contextLedger.previewPacket({ sessionId, packet, profile }),
      revalidateContextPacket: ({ preview, packet }) =>
        classifyContextPacketChange({
          before: preview.sourceRefs,
          after: buildContextPacketSourceRefs(packet),
          protectedSourceIds: crpRuntime.contextLedger.protectedSourceIds(),
          mandatorySourceIds: buildMandatorySourceIds(packet),
        }),
      submitContextPacketReceipt: (input) => crpRuntime.contextLedger.submitPreview(input),
      generateContextSuggestions: async (input) =>
        crpRuntime.contextLedger.generateSuggestions(input),
      resolveContextSuggestion: (suggestionId, status) =>
        crpRuntime.contextLedger.resolveSuggestion(suggestionId, status),
      invalidateContextSuggestions: (receiptId) =>
        crpRuntime.contextLedger.invalidateSuggestions(receiptId),
      ...(crpConfig.enabled
        ? {
            memoryLineage: crpRuntime.contextLedger.memoryLineage,
            promoteScopedMemory,
          }
        : {}),
      refreshCondensedHistory: () =>
        crpRuntime.refreshCondensedHistory(),
    },
  };
  } catch (error) {
    await disposePluginHost();
    throw error;
  }
}
