import { type ProviderId } from "@unclecode/contracts";
import type { ModelRegistry, ProviderCapabilityName, ReasoningSupport } from "./types.js";
export declare function getOpenAIReasoningSupport(modelId: string): ReasoningSupport;
export declare function getReasoningSupport(providerId: ProviderId, modelId: string): ReasoningSupport;
export declare function detectProviderForModel(modelId: string): Extract<ProviderId, "openai" | "anthropic" | "gemini" | "deepseek">;
export type ProviderRoute = {
    readonly providerId: ProviderId;
    readonly label: string;
    readonly transport: "native" | "compat";
    readonly runtimeSupported: boolean;
    readonly defaultModel: string;
    readonly endpointUrl: string;
    readonly proxyPolicy: {
        readonly proxyUrl: string | null;
        readonly source: string;
        readonly bypassed: boolean;
        readonly targetHost: string;
        readonly noProxy: readonly string[];
    };
    readonly envKeys: readonly string[];
    readonly compatPolicy: OpenAICompatPolicy;
};
export type OpenAICompatPolicy = {
    readonly providerId: string;
    readonly modelId: string;
    readonly supportsReasoningEffort: boolean;
    readonly supportsToolChoice: boolean;
    readonly supportsStrictTools: boolean;
    readonly toolStrictMode: "provider" | "disabled";
    readonly maxTokensField: "max_tokens" | "max_completion_tokens";
    readonly supportsMultipleSystemMessages: boolean;
    readonly requiresToolResultName: boolean;
    readonly requiresAssistantContentForToolCalls: boolean;
    readonly requiresReasoningContentForToolCalls: boolean;
    readonly thinkingFormat: "none" | "zai" | "qwen" | "deepseek";
};
export declare function resolveProviderRoute(providerId: ProviderId | "auto", modelId?: string): ProviderRoute;
export declare function resolveOpenAICompatPolicy(providerId: ProviderId, modelId: string, endpointUrl?: string): OpenAICompatPolicy;
export declare function getProviderModelCatalog(providerId: ProviderId, env?: NodeJS.ProcessEnv): {
    readonly label: string;
    readonly models: readonly string[];
};
export declare function getOpenAIModelRegistry(env?: NodeJS.ProcessEnv): ModelRegistry;
export declare function getGenericModelRegistry(providerId: ProviderId, env?: NodeJS.ProcessEnv): ModelRegistry;
export declare function assertProviderCapability(providerId: ProviderId, capability: ProviderCapabilityName, modelId: string): void;
//# sourceMappingURL=model-registry.d.ts.map