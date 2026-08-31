import { PROVIDER_IDS } from "@unclecode/contracts";
import { ProviderCapabilityMismatchError } from "./errors.js";
import { assertProviderCapability, detectProviderForModel, getGenericModelRegistry, getOpenAIModelRegistry, getReasoningSupport, resolveOpenAICompatPolicy, resolveProviderRoute, } from "./model-registry.js";
import { resolveOpenAIAuth } from "./openai-auth.js";
import { clearOpenAICredentials, readOpenAICredentials, writeOpenAICredentials } from "./openai-credential-store.js";
import { buildOpenAIAuthorizationUrl, completeOpenAIBrowserLogin, completeOpenAICodexDeviceLogin, completeOpenAIDeviceLogin, createOpenAIPkcePair, exchangeOpenAIAuthorizationCode, parseOpenAICallback, requestOpenAICodexDeviceAuthorization, requestOpenAIDeviceAuthorization, resolveReusableOpenAIOAuthClientId, } from "./openai-oauth.js";
import { formatOpenAIAuthStatus, resolveOpenAIAuthStatus } from "./openai-status.js";
export * from "./runtime.js";
export * from "./model-pricing.js";
export * from "./omp-install.js";
export * from "./omp-auth-catalog.js";
export * from "./omp-worker-entry.js";
export * from "./omp-worker-provider.js";
export { ProviderCapabilityMismatchError };
export const PROVIDERS_SUPPORTED_IDS = PROVIDER_IDS;
export function getProviderAdapter(providerId) {
    return {
        providerId,
        getModelRegistry(env) {
            return providerId === "openai" ? getOpenAIModelRegistry(env) : getGenericModelRegistry(providerId, env);
        },
        assertCapability(capability, options) {
            assertProviderCapability(providerId, capability, options.modelId);
        },
        getReasoningSupport(options) {
            return getReasoningSupport(providerId, options.modelId);
        },
    };
}
export { detectProviderForModel, resolveOpenAICompatPolicy, resolveProviderRoute, buildOpenAIAuthorizationUrl, completeOpenAIBrowserLogin, completeOpenAICodexDeviceLogin, completeOpenAIDeviceLogin, createOpenAIPkcePair, exchangeOpenAIAuthorizationCode, formatOpenAIAuthStatus, parseOpenAICallback, requestOpenAICodexDeviceAuthorization, requestOpenAIDeviceAuthorization, resolveReusableOpenAIOAuthClientId, resolveOpenAIAuth, resolveOpenAIAuthStatus, clearOpenAICredentials, readOpenAICredentials, writeOpenAICredentials, };
//# sourceMappingURL=index.js.map