import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  MODE_PROFILES,
  type ModeProfileId,
  type ModeReasoningEffort,
  type ProviderId,
} from "@unclecode/contracts";
import {
  getProviderAdapter,
  resolveOpenAIAuth,
  type ReasoningSupport,
} from "@unclecode/providers";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

import { loadExtensionConfigOverlays } from "./extension-registry.js";

loadEnv({ quiet: true });

const providerSchema = z.enum(["anthropic", "gemini", "openai"]);

const envSchema = z.object({
  LLM_PROVIDER: providerSchema.default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.5"),
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
  openAIRuntime?: "api" | "codex";
  openAIAccountId?: string | null;
  authIssueMessage?: string;
};

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function tokenHasModelRequestScope(token: string): boolean {
  const payload = parseJwtPayload(token);
  if (!payload) {
    return true;
  }
  const scopeValue = payload.scp ?? payload.scope;
  const scopes = Array.isArray(scopeValue)
    ? scopeValue.filter((value): value is string => typeof value === "string")
    : typeof scopeValue === "string"
      ? scopeValue.split(/\s+/).filter(Boolean)
      : [];
  return scopes.length === 0 || scopes.includes("model.request");
}

function resolveReasoningConfig(input: {
  provider: ProviderId;
  model: string;
  mode: ModeProfileId;
  override?: ModeReasoningEffort;
}): AppReasoningConfig {
  if (input.provider !== "openai") {
    return {
      effort: "unsupported",
      source: "model-capability",
      support: {
        status: "unsupported",
        supportedEfforts: [],
      },
    };
  }

  const adapter = getProviderAdapter("openai");
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
  overrides?: Partial<Pick<AppConfig, "provider" | "model">> & {
    cwd?: string;
    reasoning?: ModeReasoningEffort;
    readOpenAiAuthFile?: () => Promise<string>;
    allowProblematicOpenAIAuth?: boolean;
  },
): Promise<AppConfig> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(", ");
    throw new Error(message);
  }
  const provider = overrides?.provider ?? parsed.data.LLM_PROVIDER;
  const workspaceRoot = overrides?.cwd ?? process.cwd();
  const mode = explainUncleCodeConfig({
    workspaceRoot,
    env: process.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    }),
  }).activeMode.id;

  if (provider === "openai") {
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
        openAIRuntime:
          auth.authType === "oauth"
          && (
            auth.runtime === "codex"
            || auth.source === "codex-auth-file"
            || (auth.source === "env-openai-auth-token" && !tokenHasModelRequestScope(auth.bearerToken))
          )
            ? "codex"
            : "api",
        openAIAccountId: auth.accountId ?? null,
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
