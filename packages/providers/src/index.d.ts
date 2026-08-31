import { type ProviderId } from "@unclecode/contracts";
import { ProviderCapabilityMismatchError } from "./errors.js";
import { assertProviderCapability, detectProviderForModel, resolveOpenAICompatPolicy, resolveProviderRoute } from "./model-registry.js";
import { resolveOpenAIAuth } from "./openai-auth.js";
import { clearOpenAICredentials, readOpenAICredentials, writeOpenAICredentials } from "./openai-credential-store.js";
import { buildOpenAIAuthorizationUrl, completeOpenAIBrowserLogin, completeOpenAICodexDeviceLogin, completeOpenAIDeviceLogin, createOpenAIPkcePair, exchangeOpenAIAuthorizationCode, parseOpenAICallback, requestOpenAICodexDeviceAuthorization, requestOpenAIDeviceAuthorization, resolveReusableOpenAIOAuthClientId } from "./openai-oauth.js";
import { formatOpenAIAuthStatus, resolveOpenAIAuthStatus } from "./openai-status.js";
import type { ModelRegistry, ReasoningSupport } from "./types.js";
export * from "./runtime.js";
export * from "./model-pricing.js";
export * from "./omp-install.js";
export * from "./omp-auth-catalog.js";
export * from "./omp-worker-entry.js";
export * from "./omp-worker-provider.js";
export type { OpenAICompatPolicy, ProviderRoute } from "./model-registry.js";
export type { ProviderId };
export type { ModelRegistry, OpenAIAuthStatus, ReasoningSupport, ResolveOpenAIAuthInput, ResolvedOpenAIAuth } from "./types.js";
export { ProviderCapabilityMismatchError };
export declare const PROVIDERS_SUPPORTED_IDS: readonly ["anthropic", "gemini", "openai", "deepseek", "groq", "ollama", "copilot", "zai", "omp"];
export declare function getProviderAdapter(providerId: ProviderId): {
    providerId: "anthropic" | "gemini" | "openai" | "deepseek" | "groq" | "ollama" | "copilot" | "zai" | "omp";
    getModelRegistry(env?: NodeJS.ProcessEnv): ModelRegistry;
    assertCapability(capability: Parameters<typeof assertProviderCapability>[1], options: {
        modelId: string;
    }): void;
    getReasoningSupport(options: {
        modelId: string;
    }): ReasoningSupport;
};
export { detectProviderForModel, resolveOpenAICompatPolicy, resolveProviderRoute, buildOpenAIAuthorizationUrl, completeOpenAIBrowserLogin, completeOpenAICodexDeviceLogin, completeOpenAIDeviceLogin, createOpenAIPkcePair, exchangeOpenAIAuthorizationCode, formatOpenAIAuthStatus, parseOpenAICallback, requestOpenAICodexDeviceAuthorization, requestOpenAIDeviceAuthorization, resolveReusableOpenAIOAuthClientId, resolveOpenAIAuth, resolveOpenAIAuthStatus, clearOpenAICredentials, readOpenAICredentials, writeOpenAICredentials, };
//# sourceMappingURL=index.d.ts.map