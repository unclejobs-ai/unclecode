import { explainUncleCodeConfig } from "@unclecode/config-core";
import { isModeReasoningEffort } from "@unclecode/contracts";
import {
  type ModeProfileId,
  type ModeReasoningEffort,
  type ProviderId,
} from "@unclecode/contracts";
import {
  resolveOpenAIAuth,
  type ReasoningSupport,
  type ResolvedOpenAIAuth,
} from "@unclecode/providers";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

import { loadExtensionConfigOverlays } from "./extension-registry.js";
import { runRustCommand, runRustCommandSync } from "./rust-command.js";

loadEnv({ quiet: true });

const providerSchema = z.enum(["anthropic", "gemini", "openai", "deepseek"]);

const DEEPSEEK_DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";

const envSchema = z.object({
  LLM_PROVIDER: providerSchema.default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-chat"),
  DEEPSEEK_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-20250514"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
});

const appReasoningConfigCache = new Map<string, AppReasoningConfig>();

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
  baseUrl?: string;
};

function resolveDeepSeekEndpoint(baseUrl: string | undefined): string {
  const normalized = baseUrl?.trim().replace(/\/+$/, "");
  if (!normalized) {
    return DEEPSEEK_DEFAULT_ENDPOINT;
  }
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`;
}

function resolveReasoningConfig(input: {
  provider: ProviderId;
  model: string;
  mode: ModeProfileId;
  override?: ModeReasoningEffort;
  env: NodeJS.ProcessEnv;
}): AppReasoningConfig {
  const cacheKey = JSON.stringify({
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    override: input.override ?? null,
  });
  const cached = appReasoningConfigCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "app-reasoning",
      input.provider,
      input.model,
      input.mode,
      input.override ?? "-",
    ],
    process.cwd(),
    undefined,
    input.env,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isAppReasoningConfig(parsed)) {
    throw new Error("Rust app reasoning config returned an invalid payload.");
  }
  appReasoningConfigCache.set(cacheKey, parsed);
  return parsed;
}

function isAppReasoningConfig(value: unknown): value is AppReasoningConfig {
  if (!isRecord(value) || !isRecord(value.support)) {
    return false;
  }
  const effortOk = isModeReasoningEffort(value.effort) || value.effort === "unsupported";
  const sourceOk = value.source === "mode-default"
    || value.source === "override"
    || value.source === "model-capability";
  return effortOk
    && sourceOk
    && typeof value.support.status === "string"
    && Array.isArray(value.support.supportedEfforts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveOpenAIAuthForConfig(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  readOpenAiAuthFile?: () => Promise<string>;
}): Promise<ResolvedOpenAIAuth> {
  if (input.readOpenAiAuthFile) {
    return await resolveOpenAIAuth({
      env: input.env,
      ...(input.env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim()
        ? { fallbackAuthPath: input.env.UNCLECODE_OPENAI_CREDENTIALS_PATH.trim() }
        : {}),
      readFallbackFile: input.readOpenAiAuthFile,
    });
  }

  const stdout = await runRustCommand(["rust", "auth", "resolve"], input.cwd, undefined, input.env);
  const fields = parseRustKeyValueLines(stdout);
  const status = fields.get("status");
  const authType = fields.get("authType");
  const source = fields.get("source") ?? "none";
  const bearerToken = normalizeRustOptionalField(fields.get("bearerToken")) ?? "";
  const organizationId = normalizeRustOptionalField(fields.get("organizationId"));
  const projectId = normalizeRustOptionalField(fields.get("projectId"));
  const accountId = normalizeRustOptionalField(fields.get("accountId"));
  const runtime = normalizeRustRuntime(fields.get("runtime"));
  const reason = normalizeRustOptionalField(fields.get("reason")) ?? "auth-file-missing";

  if (status === "ok" && (authType === "api-key" || authType === "oauth") && bearerToken) {
    return {
      status,
      authType,
      source: normalizeRustAuthSource(source),
      bearerToken,
      organizationId,
      projectId,
      accountId,
      ...(runtime ? { runtime } : {}),
    };
  }

  if (status === "expired") {
    return {
      status,
      authType: "oauth",
      source: normalizeRustOAuthFailureSource(source),
      reason,
    };
  }

  return {
    status: "missing",
    authType: authType === "oauth" ? "oauth" : "none",
    source: source === "unclecode-auth-file" || source === "codex-auth-file" ? source : "none",
    reason,
  };
}

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}

function normalizeRustOptionalField(value: string | undefined): string | null {
  return value && value !== "none" ? value : null;
}

function normalizeRustRuntime(value: string | undefined): "api" | "codex" | null {
  return value === "api" || value === "codex" ? value : null;
}

function normalizeRustAuthSource(source: string): Extract<ResolvedOpenAIAuth, { status: "ok" }>["source"] {
  switch (source) {
    case "env-openai-api-key":
    case "env-openai-auth-token":
    case "codex-auth-file":
    case "unclecode-api-key-file":
      return source;
    default:
      return "unclecode-auth-file";
  }
}

function normalizeRustOAuthFailureSource(
  source: string,
): Extract<ResolvedOpenAIAuth, { status: "expired" }>["source"] {
  return source === "env-openai-auth-token" || source === "codex-auth-file"
    ? source
    : "unclecode-auth-file";
}

export async function loadConfig(
  overrides?: Partial<Pick<AppConfig, "provider" | "model">> & {
    cwd?: string;
    reasoning?: ModeReasoningEffort;
    readOpenAiAuthFile?: () => Promise<string>;
    allowProblematicOpenAIAuth?: boolean;
    /** Complete environment override for deterministic embedding/bootstrap callers. */
    env?: NodeJS.ProcessEnv;
  },
): Promise<AppConfig> {
  const env = overrides?.env ?? process.env;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(", ");
    throw new Error(message);
  }
  const provider = overrides?.provider ?? parsed.data.LLM_PROVIDER;
  const workspaceRoot = overrides?.cwd ?? process.cwd();
  const mode = explainUncleCodeConfig({
    workspaceRoot,
    env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot,
      env,
      ...(env.HOME ? { userHomeDir: env.HOME } : {}),
    }),
  }).activeMode.id;

  if (provider === "openai") {
    const auth = await resolveOpenAIAuthForConfig({
      cwd: workspaceRoot,
      env,
      ...(overrides?.readOpenAiAuthFile
        ? { readOpenAiAuthFile: overrides.readOpenAiAuthFile }
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
          )
            ? "codex"
            : "api",
        openAIAccountId: auth.accountId ?? null,
        reasoning: resolveReasoningConfig({
          provider,
          model,
          mode,
          env,
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
          env,
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

  if (provider === "deepseek") {
    const apiKey = parsed.data.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek");
    }
    const model = overrides?.model ?? parsed.data.DEEPSEEK_MODEL;
    return {
      provider,
      apiKey,
      model,
      mode,
      authLabel: "env-key",
      baseUrl: resolveDeepSeekEndpoint(parsed.data.DEEPSEEK_BASE_URL),
      reasoning: resolveReasoningConfig({ provider, model, mode, env }),
    };
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
      reasoning: resolveReasoningConfig({ provider, model, mode, env }),
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
    reasoning: resolveReasoningConfig({ provider, model, mode, env }),
  };
}
