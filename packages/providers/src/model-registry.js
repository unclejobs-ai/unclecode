import { PROVIDER_CAPABILITIES } from "@unclecode/contracts";
import { ProviderCapabilityMismatchError } from "./errors.js";
const OPENAI_DEFAULT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "o4-mini", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"];
function unique(values) {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
}
export function getOpenAIModelRegistry(env = process.env) {
    const activeModel = String(env.OPENAI_MODEL ?? "").trim();
    return {
        providerId: "openai",
        defaultModel: PROVIDER_CAPABILITIES.openai.defaultModel,
        models: unique([activeModel, ...OPENAI_DEFAULT_MODELS]),
    };
}
export function assertProviderCapability(providerId, capability, modelId) {
    const provider = PROVIDER_CAPABILITIES[providerId];
    const supported = capability === "tool-calls"
        ? provider.supportsToolCalls
        : capability === "session-memory"
            ? provider.supportsSessionMemory
            : capability === "prompt-caching"
                ? provider.supportsPromptCaching
                : providerId === "openai";
    if (!supported) {
        throw new ProviderCapabilityMismatchError({
            providerId,
            requiredCapability: capability,
            modelId,
        });
    }
}
//# sourceMappingURL=model-registry.js.map
