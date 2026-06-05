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

function createWorkShellContextPacketResolver(): StartReplOptions["resolveContextPacket"] {
  return async (input): Promise<ContextPacketView> => {
    const omo = await loadOmoContextSnapshot(input.cwd);
    const included: ContextPacketViewItem[] = [
      ...buildContextLineItems({
        lines: input.contextSummaryLines,
        category: "workspace",
        idPrefix: "workspace-context",
        reason: "loaded workspace guidance",
      }),
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
    const excluded: ContextPacketViewItem[] = omo.excluded.map((item, index) => ({
      id: `omo-excluded-${index + 1}`,
      category: "omo",
      label: item.path,
      reason: item.reason,
    }));
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
      title: "Next model-call packet",
      included,
      excluded,
      warnings,
      preview: [
        `Packet ${id} will prefix the next provider call.`,
        "Included items are summarized context sources; raw OMO audit artifacts stay excluded.",
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
  const homeState = await refreshHomeState();

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
      resolveContextPacket: createWorkShellContextPacketResolver(),
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
