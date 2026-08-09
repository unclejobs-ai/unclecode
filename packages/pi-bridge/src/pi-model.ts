import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderName, RuntimeReasoningConfig } from "@unclecode/providers";

// pi-ai registers the Gemini API surface under the "google" provider id.
export const PI_BRIDGE_PROVIDER_IDS: Readonly<Record<ProviderName, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
};
const PI_BRIDGE_BUILTIN_PROVIDER_IDS = new Set(Object.values(PI_BRIDGE_PROVIDER_IDS));


let sharedModels: Models | undefined;

export function getSharedPiModels(): Models {
  if (!sharedModels) {
    sharedModels = builtinModels();
  }
  return sharedModels;
}

const PI_PROVIDER_DEFAULT_APIS: Readonly<Record<ProviderName, string>> = {
  openai: "openai-responses",
  anthropic: "anthropic-messages",
  gemini: "google-generative-ai",
};

const PI_PROVIDER_DEFAULT_BASE_URLS: Readonly<Record<ProviderName, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

const PI_PROVIDER_BASE_URL_ENV_KEYS: Readonly<Record<ProviderName, readonly string[]>> = {
  openai: ["OPENAI_BASE_URL", "OPENAI_API_BASE_URL"],
  anthropic: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL"],
  gemini: ["GEMINI_BASE_URL", "GEMINI_API_BASE_URL"],
};

export function resolvePiProviderBaseUrl(
  provider: ProviderName,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  for (const name of PI_PROVIDER_BASE_URL_ENV_KEYS[provider]) {
    const value = env[name]?.trim().replace(/\/+$/, "");
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolvePiModel(
  provider: ProviderName,
  modelId: string,
  models?: Models,
  piProviderId?: string,
  baseUrl?: string,
): Model<Api> {
  const registry = models ?? getSharedPiModels();
  const resolvedProviderId = piProviderId ?? PI_BRIDGE_PROVIDER_IDS[provider];
  const customProvider =
    piProviderId !== undefined && !PI_BRIDGE_BUILTIN_PROVIDER_IDS.has(piProviderId);
  const found = registry.getModel(resolvedProviderId, modelId);
  if (found) return customProvider ? found : withBaseUrl(found, baseUrl);
  const defaultApi = PI_PROVIDER_DEFAULT_APIS[provider];
  const defaultBaseUrl = baseUrl?.trim() || PI_PROVIDER_DEFAULT_BASE_URLS[provider];
  if (customProvider) {
    throw new Error(
      `pi-bridge: model "${modelId}" is not available in the pi-ai catalog for provider "${resolvedProviderId}". ` +
        "Custom pi providers require a catalog-resolvable model.",
    );
  }
  // UncleCode takes model ids from user config/env without catalog validation,
  // and pi-ai provider catalogs are dynamic (empty until authenticated refresh),
  // so a catalog miss falls back to a synthetic model with provider defaults;
  // the provider API itself rejects unknown model ids.
  return {
    id: modelId,
    name: modelId,
    api: defaultApi as Api,
    provider: resolvedProviderId,
    baseUrl: defaultBaseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

function withBaseUrl(model: Model<Api>, baseUrl: string | undefined): Model<Api> {
  const resolved = baseUrl?.trim();
  return resolved ? { ...model, baseUrl: resolved } : model;
}

const EFFORT_TO_PI_THINKING: Readonly<Record<string, ModelThinkingLevel>> = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function toPiThinkingLevel(
  model: Model<Api>,
  reasoning: RuntimeReasoningConfig,
): ModelThinkingLevel | undefined {
  if (reasoning.effort === "unsupported") return undefined;
  if (reasoning.support.status !== "supported") return undefined;
  const mapped = EFFORT_TO_PI_THINKING[reasoning.effort];
  if (!mapped) return undefined;
  return clampThinkingLevel(model, mapped);
}
