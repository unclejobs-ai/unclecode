import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  MODE_PROFILES,
  type ModeProfileId,
  type ModeReasoningEffort,
  type ProviderId,
} from "@unclecode/contracts";
import {
  getProviderAdapter,
  normalizeOpenAIProviderId,
  resolveOpenAIAuth,
  resolvePreferredOpenAIProvider,
  type ReasoningSupport,
} from "@unclecode/providers";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

import { loadExtensionConfigOverlays } from "./extension-registry.js";

loadEnv({ quiet: true });

const providerSchema = z.enum(["anthropic", "gemini", "openai", "openai-api", "openai-codex"]);

const envSchema = z.object({
  LLM_PROVIDER: providerSchema.default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-20250514"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
});

export type AppReasoningConfig = {
  effort: ModeReasoningEffort | "unsupported";
  source: "mode-default" | "override" | "model-capability";
  support: ReasoningSupport;
};

export type AppConfig = {
  provider: ProviderId;
  apiKey: string;
  model: string;
  mode: ModeProfileId;
  authLabel: string;
  reasoning: AppReasoningConfig;
  authIssueMessage?: string;
};

function resolveReasoningConfig(input: {
  provider: ProviderId;
  model: string;
  mode: ModeProfileId;
  override?: ModeReasoningEffort;
}): AppReasoningConfig {
  if (input.provider !== "openai-api" && input.provider !== "openai-codex") {
    return {
      effort: "unsupported",
      source: "model-capability",
      support: {
        status: "unsupported",
        supportedEfforts: [],
      },
    };
  }

  const adapter = getProviderAdapter(input.provider);
  const support = adapter.getReasoningSupport({ modelId: input.model });

  if (support.status === "unsupported") {
    return {
      effort: "unsupported",
      source: "model-capability",
      support,
    };
  }

  return {
    effort: input.override ?? MODE_PROFILES[input.mode].reasoningDefault,
    source: input.override ? "override" : "mode-default",
    support,
  };
}

export async function loadConfig(
  overrides?: {
    provider?: AppConfig["provider"] | "openai";
    model?: string;
    cwd?: string;
    reasoning?: ModeReasoningEffort;
    readOpenAiAuthFile?: ((authPath?: string) => Promise<string>) | undefined;
    readCodexAuthFile?: ((authPath?: string) => Promise<string>) | undefined;
    allowProblematicOpenAIAuth?: boolean;
  },
): Promise<AppConfig> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(", ");
    throw new Error(message);
  }
  const requestedProvider = overrides?.provider ?? parsed.data.LLM_PROVIDER;
  const envHasExplicitProvider = typeof process.env.LLM_PROVIDER === "string" && process.env.LLM_PROVIDER.trim().length > 0;
  const workspaceRoot = overrides?.cwd ?? process.cwd();
  const mode = explainUncleCodeConfig({
    workspaceRoot,
    env: process.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    }),
  }).activeMode.id;

  const preferredOpenAI = await resolvePreferredOpenAIProvider({
    env: process.env,
    ...(overrides?.readCodexAuthFile ? { readCodexAuthFile: overrides.readCodexAuthFile } : {}),
    ...(overrides?.readOpenAiAuthFile ? { readApiAuthFile: overrides.readOpenAiAuthFile } : {}),
  });

  const provider = (
    !overrides?.provider && !envHasExplicitProvider && requestedProvider === "openai"
      ? preferredOpenAI.providerId ?? "openai-api"
      : normalizeOpenAIProviderId(requestedProvider) ?? requestedProvider
  ) as ProviderId;

  if (provider === "openai-codex") {
    if (preferredOpenAI.providerId === "openai-codex" && preferredOpenAI.bearerToken) {
      const model = overrides?.model ?? parsed.data.OPENAI_MODEL;
      return {
        provider,
        apiKey: preferredOpenAI.bearerToken,
        model,
        mode,
        authLabel: preferredOpenAI.authLabel,
        reasoning: resolveReasoningConfig({
          provider,
          model,
          mode,
          ...(overrides?.reasoning ? { override: overrides.reasoning } : {}),
        }),
      };
    }

    throw new Error("OpenAI Codex login is required. Run unclecode auth login to sign in with Codex/ChatGPT OAuth.");
  }

  if (provider === "openai-api") {
    const apiKey = parsed.data.OPENAI_API_KEY?.trim();
    if (apiKey) {
      const model = overrides?.model ?? parsed.data.OPENAI_MODEL;
      return {
        provider,
        apiKey,
        model,
        mode,
        authLabel: "api-key-env",
        reasoning: resolveReasoningConfig({
          provider,
          model,
          mode,
          ...(overrides?.reasoning ? { override: overrides.reasoning } : {}),
        }),
      };
    }

    const auth = await resolveOpenAIAuth({
      env: process.env,
      ...(process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim()
        ? { fallbackAuthPath: process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH.trim() }
        : {}),
      ...(overrides?.readOpenAiAuthFile
        ? { readFallbackFile: overrides.readOpenAiAuthFile }
        : {}),
    });

    if (auth.status === "ok") {
      const model = overrides?.model ?? parsed.data.OPENAI_MODEL;
      const authLabel =
        auth.source === "env-openai-auth-token"
          ? "oauth-env"
          : auth.source === "env-openai-api-key"
            ? "api-key-env"
            : auth.authType === "oauth"
              ? "oauth-file"
              : "api-key-file";
      return {
        provider,
        apiKey: auth.bearerToken,
        model,
        mode,
        authLabel,
        reasoning: resolveReasoningConfig({
          provider,
          model,
          mode,
          ...(overrides?.reasoning ? { override: overrides.reasoning } : {}),
        }),
      };
    }

    if (
      overrides?.allowProblematicOpenAIAuth &&
      (auth.reason === "auth-refresh-required" || auth.reason === "auth-insufficient-scope")
    ) {
      const model = overrides?.model ?? parsed.data.OPENAI_MODEL;
      return {
        provider,
        apiKey: "",
        model,
        mode,
        authLabel: auth.source === "env-openai-auth-token" ? "oauth-env" : "oauth-file",
        reasoning: resolveReasoningConfig({
          provider,
          model,
          mode,
          ...(overrides?.reasoning ? { override: overrides.reasoning } : {}),
        }),
        authIssueMessage:
          auth.reason === "auth-insufficient-scope"
            ? "Auth issue: saved OAuth lacks model.request scope. Use /auth login --api-key <key>, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."
            : "Auth issue: saved OAuth needs refresh. Use /auth login or /auth logout before asking the model to work.",
      };
    }

    throw new Error(
      auth.reason === "auth-refresh-required"
        ? "OpenAI auth needs refresh. Run unclecode auth login --browser, unclecode auth login --api-key-stdin, or provide OPENAI_AUTH_TOKEN / OPENAI_API_KEY."
        : auth.reason === "auth-insufficient-scope"
          ? "OpenAI OAuth is present but missing model.request scope for API calls. Codex chat auth may exist locally but is not usable here. Use unclecode auth login --api-key-stdin, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."
          : "OPENAI_API_KEY or a valid UncleCode OpenAI login is required when LLM_PROVIDER=openai",
    );
  }

  if (provider === "gemini") {
    const apiKey = parsed.data.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
    }
    const model = overrides?.model ?? parsed.data.GEMINI_MODEL;
    return {
      provider,
      apiKey,
      model,
      mode,
      authLabel: "env-key",
      reasoning: resolveReasoningConfig({ provider, model, mode }),
    };
  }

  const apiKey = parsed.data.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
  }

  const model = overrides?.model ?? parsed.data.ANTHROPIC_MODEL;
  return {
    provider,
    apiKey,
    model,
    mode,
    authLabel: "env-key",
    reasoning: resolveReasoningConfig({ provider, model, mode }),
  };
}
