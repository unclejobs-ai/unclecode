import { createHash } from "node:crypto";

import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  clearCachedWorkspaceGuidance,
  createContextPacketView,
  loadCachedWorkspaceGuidance,
  loadOmoContextSnapshot,
} from "@unclecode/context-broker";
import type {
  ContextPacketSourceCategory,
  ContextPacketView,
  ContextPacketViewItem,
  ContextPacketViewWarning,
} from "@unclecode/contracts";
import {
  clearExtensionRegistryCache,
  loadConfig,
  loadExtensionConfigOverlays,
  loadExtensionManifestSummaries,
  WorkAgent,
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
} from "./work-runtime-session.js";
import { runWorkspaceGuardianChecks } from "./guardian-checks.js";
import { createRuntimeCodingAgent } from "./runtime-coding-agent.js";

export type WorkCliBootstrapInput = {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv | undefined;
  userHomeDir?: string | undefined;
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

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function buildContextLineItems(input: {
  readonly lines: readonly string[];
  readonly category: ContextPacketSourceCategory;
  readonly idPrefix: string;
  readonly reason: string;
}): readonly ContextPacketViewItem[] {
  return input.lines.map((line, index) => ({
    id: `${input.idPrefix}-${index + 1}`,
    category: input.category,
    label: line,
    reason: input.reason,
    preview: line,
    tokenEstimate: estimateTokens(line),
  }));
}

function isWorkspaceGuidanceSummaryLine(line: string): boolean {
  return (
    /^(Loaded guidance|Deduped duplicate guidance|Conflict|Loaded skills):/i.test(line) ||
    /^(?:AGENTS|CLAUDE|GEMINI|UNCLECODE)(?:\.local)?\.md:/i.test(line) ||
    /^rules\/.+\.md:/i.test(line)
  );
}

const WORKSPACE_GUIDANCE_SAFE_PREVIEW =
  "Workspace guidance is active; raw guidance text stays out of the context view.";

function extractWorkspaceGuidanceSource(line: string): string | undefined {
  const sourceMatch = /^((?:AGENTS|CLAUDE|GEMINI|UNCLECODE)(?:\.local)?\.md|rules\/.+\.md):/i.exec(line);
  return sourceMatch?.[1];
}

function buildContextSummaryItems(lines: readonly string[]): readonly ContextPacketViewItem[] {
  return lines.map((line, index) => {
    const workspaceGuidance = isWorkspaceGuidanceSummaryLine(line);
    const workspaceGuidanceSource = workspaceGuidance ? extractWorkspaceGuidanceSource(line) : undefined;
    const label = workspaceGuidanceSource ? "Workspace guidance" : line;
    const preview = workspaceGuidanceSource
      ? `${workspaceGuidanceSource} — ${WORKSPACE_GUIDANCE_SAFE_PREVIEW}`
      : line;

    return {
      id: workspaceGuidance
        ? `workspace-guidance-${index + 1}`
        : `workspace-context-${index + 1}`,
      category: workspaceGuidance ? "workspace-guidance" : "workspace",
      label,
      reason: workspaceGuidance ? "workspace guidance summary" : "loaded workspace context",
      preview,
      tokenEstimate: estimateTokens(`${label} ${preview}`),
    };
  });
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
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

const OMO_EXCLUDED_DETAIL_LIMIT = 6;

function buildOmoExcludedPacketItems(
  excludedArtifacts: readonly { readonly path: string; readonly reason: string }[],
): readonly ContextPacketViewItem[] {
  if (excludedArtifacts.length <= OMO_EXCLUDED_DETAIL_LIMIT) {
    return excludedArtifacts.map((item, index) => ({
      id: `omo-excluded-${index + 1}`,
      category: "omo",
      label: "OMO session artifact",
      reason: item.reason,
      preview: item.path,
    }));
  }

  const evidenceArtifacts = excludedArtifacts.filter((item) => /evidence/i.test(item.reason));
  const otherArtifacts = excludedArtifacts.filter((item) => !/evidence/i.test(item.reason));
  const items: ContextPacketViewItem[] = otherArtifacts
    .slice(0, OMO_EXCLUDED_DETAIL_LIMIT - 1)
    .map((item, index) => ({
      id: `omo-excluded-${index + 1}`,
      category: "omo",
      label: "OMO session artifact",
      reason: item.reason,
      preview: item.path,
    }));

  if (otherArtifacts.length > items.length) {
    const additionalArtifactCount = otherArtifacts.length - items.length;
    items.push({
      id: "omo-excluded-other-summary",
      category: "omo",
      label: `${formatCountLabel(additionalArtifactCount, "additional raw OMO artifact", "additional raw OMO artifacts")}`,
      reason: "raw OMO artifacts stay local",
      sourceCount: additionalArtifactCount,
    });
  }

  if (evidenceArtifacts.length > 0) {
    items.push({
      id: "omo-excluded-evidence-summary",
      category: "omo",
      label: `${formatCountLabel(evidenceArtifacts.length, "raw OMO evidence transcript", "raw OMO evidence transcripts")}`,
      reason: "raw OMO evidence transcripts stay local",
      preview: "Detailed evidence paths stay local; use the OMO session evidence directory for full transcripts.",
      sourceCount: evidenceArtifacts.length,
    });
  }

  return items;
}

function createWorkShellContextPacketResolver(options: {
  readonly sourceMetadata: readonly ContextPacketViewItem[];
}): StartReplOptions["resolveContextPacket"] {
  return async (input): Promise<ContextPacketView> => {
    const omo = await loadOmoContextSnapshot(input.cwd);
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
      ...omo.included.map((item): ContextPacketViewItem => ({
        id: item.kind === "omo-goal"
          ? `omo-goal-${item.sessionId}-${item.goalId}`
          : `omo-criterion-${item.sessionId}-${item.goalId}-${item.criterionId}`,
        category: "omo",
        label: item.kind === "omo-goal"
          ? `${item.goalId} · ${item.status}`
          : `${item.goalId}/${item.criterionId} · ${item.status}`,
        reason: item.kind === "omo-goal" ? "active OMO goal context" : "OMO success criterion context",
        preview: item.summary,
        tokenEstimate: estimateTokens(item.summary),
      })),
    ];
    const excluded = buildOmoExcludedPacketItems(omo.excluded);
    const warnings: ContextPacketViewWarning[] = omo.warnings.map((message, index) => ({
      code: `omo.warning.${index + 1}`,
      message,
      severity: "warning",
    }));
    const id = createPacketId({
      sessionId: input.sessionId,
      included,
      excluded,
      warnings,
    });

    return createContextPacketView({
      id,
      generatedAt: new Date().toISOString(),
      title: "Next answer context",
      included,
      excluded,
      warnings,
      preview: [
        "UncleCode will carry these summaries into the next answer.",
        "Raw OMO audit artifacts stay local.",
      ],
    });
  };
}

export async function loadWorkCliBootstrap(
  input: WorkCliBootstrapInput,
): Promise<WorkCliBootstrapResult> {
  const env = input.env ?? process.env;
  const userHomeDir = input.userHomeDir ?? env.HOME;
  const { cwd, provider, model, reasoning, sessionId, prompt } = parseArgs([
    ...input.argv,
  ]);
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
  const systemPromptAppendix = [
    configExplanation.prompt.rendered
      ? `Configured prompt:\n\n${configExplanation.prompt.rendered}`
      : "",
    guidance.systemPromptAppendix,
  ]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
  const contextPacketSourceMetadata = buildProviderSystemPromptMetadata({
    configuredPrompt: configExplanation.prompt.rendered,
    guidanceSystemPrompt: guidance.systemPromptAppendix,
    guidanceSources: guidance.sources,
  });
  const directAgent = await createRuntimeCodingAgent({
    provider: resolveRuntimeProvider(config.provider),
    apiKey: config.apiKey,
    model: config.model,
    cwd,
    reasoning: config.reasoning,
    ...(systemPromptAppendix ? { systemPrompt: systemPromptAppendix } : {}),
    ...(config.openAIRuntime ? { openAIRuntime: config.openAIRuntime } : {}),
    ...(config.openAIAccountId !== undefined
      ? { openAIAccountId: config.openAIAccountId }
      : {}),
  });

  const agent = new WorkAgent({
    directAgent,
    mode: config.mode,
    reasoning: config.reasoning,
    model: config.model,
    async runExecutableGuardianChecks(guardianInput) {
      const scripts = guardianInput.mode === "ultrawork" || guardianInput.mode === "yolo"
        ? ["lint", "check", "test"]
        : ["check", "test"];
      return runWorkspaceGuardianChecks({
        cwd,
        env,
        scripts,
        changedFiles: guardianInput.changedFiles,
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
      authLabel: status.activeSource,
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

  const refreshHomeState = () =>
    buildTuiHomeState({
      workspaceRoot: cwd,
      env,
      ...(userHomeDir ? { userHomeDir } : {}),
    });
  const homeState = createInitialHomeState({
    modeLabel: config.mode,
    authLabel: config.authLabel,
  });

  return {
    agent,
    prompt: prompt ?? "",
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
      reloadWorkspaceContext: async (workspaceRoot: string) =>
        buildWorkShellContextSummary({
          cwd: workspaceRoot,
          env,
          ...(userHomeDir ? { userHomeDir } : {}),
          ...(resumedSession?.contextLine
            ? { resumedContextLine: resumedSession.contextLine }
            : {}),
          forceRefresh: true,
        }),
      resolveContextPacket: createWorkShellContextPacketResolver({
        sourceMetadata: contextPacketSourceMetadata,
      }),
      refreshHomeState,
      refreshAuthState,
      browserOAuthAvailable,
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
    },
  };
}
