import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  clearCachedWorkspaceGuidance,
  loadCachedWorkspaceGuidance,
} from "@unclecode/context-broker";
import {
  clearExtensionRegistryCache,
  loadConfig,
  loadExtensionConfigOverlays,
  loadExtensionManifestSummaries,
  WorkAgent,
} from "@unclecode/orchestrator";
import {
  resolveOpenAIAuth,
  resolveOpenAIAuthStatus,
} from "@unclecode/providers";

import {
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

export async function loadWorkCliBootstrap(
  input: WorkCliBootstrapInput,
): Promise<WorkCliBootstrapResult> {
  const env = input.env ?? process.env;
  const userHomeDir = input.userHomeDir ?? env.HOME;
  const { cwd, provider, model, reasoning, sessionId, prompt } = parseArgs([
    ...input.argv,
  ]);
  const config = await loadConfig({
    cwd,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
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
    const status = await resolveOpenAIAuthStatus({ env });
    const resolved = await resolveOpenAIAuth({
      env,
      ...(env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim()
        ? { fallbackAuthPath: env.UNCLECODE_OPENAI_CREDENTIALS_PATH.trim() }
        : {}),
    });

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
    ? await resolveOpenAIAuthStatus({ env })
    : undefined;
  const browserOAuthAvailable = config.provider === "openai"
    ? Boolean(env.OPENAI_OAUTH_CLIENT_ID?.trim())
    : false;
  const authIssueLines = deriveAuthIssueLines({
    ...(authStatus ? { authStatus } : {}),
    ...(config.authIssueMessage ? { authIssueMessage: config.authIssueMessage } : {}),
  });

  const resumedSession = sessionId
    ? await loadResumedWorkSession({ cwd, sessionId, env })
    : undefined;
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
