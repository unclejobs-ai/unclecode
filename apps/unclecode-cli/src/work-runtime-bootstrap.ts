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

const WORK_PI_TURN_STEP_LIMIT = 16;
const WORK_PI_TURN_COST_LIMIT_USD = 2;

/**
 * Build one work/executor agent backed by OMP.
 *
 * Executor turns run entirely inside OMP: it routes the request, executes its
 * own tool loop, and resolves its own credentials from its own profile — so the
 * executor needs neither UncleCode's tool runtime nor a bearer token. The
 * surrounding `CodingAgent` still brackets the turn with the standard
 * trace/usage events, under the `omp` provider identity and the OMP selector.
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
  env?: NodeJS.ProcessEnv | undefined;
  userHomeDir?: string | undefined;
  lspBridge?: GuardianLspBridge | undefined;
};

export type WorkCliBootstrapResult = {
  agent: StartReplAgent;
  prompt: string;
  options: StartReplOptions;
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
      ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
    });
  }

  const guidance = await loadCachedWorkspaceGuidance({
    cwd: input.cwd,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const extensionSummaries = loadExtensionManifestSummaries({
    workspaceRoot: input.cwd,
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
  const userHomeDir = input.userHomeDir ?? env.HOME;
  const { cwd, provider, model, reasoning, sessionId, prompt, engine } = parseArgs([
    ...input.argv,
  ]);
  const activeEngine = engine ?? resolveDefaultWorkEngine(env);
  const resumedSession = sessionId
    ? await loadResumedWorkSession({ cwd, sessionId, env })
    : undefined;
  const config = await loadConfig({
    cwd,
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
    ...(userHomeDir ? { userHomeDir } : {}),
  });
  const configExplanation = explainUncleCodeConfig({
    workspaceRoot: cwd,
    env,
    pluginOverlays,
  });
  const contextProfile = resolveContextProfile(configExplanation.settings.contextProfile.value);
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
            const baseUrl = resolvePiProviderBaseUrl(runtimeProviderName);
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
  const directAgent = await createConfiguredCodingAgent(
    config.apiKey,
    config.model,
    config.reasoning,
    config.mode,
  );

  const agent = new WorkAgent({
    directAgent,
    createExecutorAgent: async (settings) => createWorkExecutorAgent({
      cwd,
      env,
      reasoning: settings.reasoning,
    }),
    mode: config.mode,
    reasoning: config.reasoning,
    model: config.model,
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
  });

  const refreshAuthState = async (): Promise<{
    authLabel: string;
    authIssueLines?: readonly string[];
  }> => {
    const status = await resolveRustOpenAIAuthStatus({ cwd, env });
    const resolved = await resolveRustOpenAIAuth({ cwd, env });
    directAgent.refreshAuthToken(resolved.status === "ok" ? resolved.bearerToken : "");
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

  const recorder = createAgentOpsRecorder({
    workspaceRoot: cwd,
    command: "unclecode work",
    ...(resumedSession?.sessionId ? { sessionId: resumedSession.sessionId } : {}),
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
      interactionBridge: directAgent.getInteractionBridge(),
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
      recordTurn: (turn) => recorder.recordTurn(turn),
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
}
