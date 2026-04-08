import { MODE_REASONING_EFFORTS, PROVIDER_CAPABILITIES, type ModeReasoningEffort, type ProviderId } from "@unclecode/contracts";

import { ProviderCapabilityMismatchError } from "./errors.js";
import type { ModelRegistry, ProviderCapabilityName, ReasoningSupport } from "./types.js";

const OPENAI_DEFAULT_MODELS = ["gpt-5.4", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o", "o4-mini"];
const UNSUPPORTED_REASONING: ReasoningSupport = {
  status: "unsupported",
  supportedEfforts: [],
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function supportedReasoning(defaultEffort: ModeReasoningEffort): ReasoningSupport {
  return {
    status: "supported",
    defaultEffort,
    supportedEfforts: MODE_REASONING_EFFORTS,
  };
}

export function getOpenAIReasoningSupport(modelId: string): ReasoningSupport {
  const normalized = modelId.trim().toLowerCase();

  if (normalized.startsWith("gpt-5") || normalized.startsWith("o4")) {
    return supportedReasoning("medium");
  }

  return UNSUPPORTED_REASONING;
}

export function getReasoningSupport(providerId: ProviderId, modelId: string): ReasoningSupport {
  if (providerId === "openai-api" || providerId === "openai-codex") {
    return getOpenAIReasoningSupport(modelId);
  }

  return UNSUPPORTED_REASONING;
}

export function getOpenAIModelRegistry(
  env: NodeJS.ProcessEnv = process.env,
  providerId: Extract<ProviderId, "openai-api" | "openai-codex"> = "openai-api",
): ModelRegistry {
  const activeModel = String(env.OPENAI_MODEL ?? "").trim();
  const models = unique([activeModel, ...OPENAI_DEFAULT_MODELS]);

  return {
    providerId,
    defaultModel: PROVIDER_CAPABILITIES[providerId].defaultModel,
    models,
    reasoningByModel: Object.fromEntries(
      models.map((modelId) => [modelId, getOpenAIReasoningSupport(modelId)]),
    ),
  };
}

export function assertProviderCapability(
  providerId: ProviderId,
  capability: ProviderCapabilityName,
  modelId: string,
): void {
  const provider = PROVIDER_CAPABILITIES[providerId];

  const supported =
    capability === "tool-calls"
      ? provider.supportsToolCalls
      : capability === "session-memory"
        ? provider.supportsSessionMemory
        : capability === "prompt-caching"
          ? provider.supportsPromptCaching
          : providerId === "openai-api" || providerId === "openai-codex";

  if (!supported) {
    throw new ProviderCapabilityMismatchError({
      providerId,
      requiredCapability: capability,
      modelId,
    });
  }
}
