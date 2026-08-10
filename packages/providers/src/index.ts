import { PROVIDER_IDS, type ProviderId } from "@unclecode/contracts";
import { ProviderCapabilityMismatchError } from "./errors.js";
import {
  assertProviderCapability,
  detectProviderForModel,
  getGenericModelRegistry,
  getOpenAIModelRegistry,
  getReasoningSupport,
  resolveOpenAICompatPolicy,
  resolveProviderRoute,
} from "./model-registry.js";
import { resolveOpenAIAuth } from "./openai-auth.js";
import { clearOpenAICredentials, readOpenAICredentials, writeOpenAICredentials } from "./openai-credential-store.js";
import {
  buildOpenAIAuthorizationUrl,
  completeOpenAIBrowserLogin,
  completeOpenAICodexDeviceLogin,
  completeOpenAIDeviceLogin,
  createOpenAIPkcePair,
  exchangeOpenAIAuthorizationCode,
  parseOpenAICallback,
  requestOpenAICodexDeviceAuthorization,
  requestOpenAIDeviceAuthorization,
  resolveReusableOpenAIOAuthClientId,
} from "./openai-oauth.js";
import { formatOpenAIAuthStatus, resolveOpenAIAuthStatus } from "./openai-status.js";
import type { ModelRegistry, OpenAIAuthStatus, ReasoningSupport, ResolveOpenAIAuthInput, ResolvedOpenAIAuth } from "./types.js";

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
export const PROVIDERS_SUPPORTED_IDS = PROVIDER_IDS;
export function getProviderAdapter(providerId: ProviderId) {
  return {
    providerId,
    getModelRegistry(env?: NodeJS.ProcessEnv) {
      return providerId === "openai" ? getOpenAIModelRegistry(env) : getGenericModelRegistry(providerId, env);
    },
    assertCapability(capability: Parameters<typeof assertProviderCapability>[1], options: { modelId: string }) {
      assertProviderCapability(providerId, capability, options.modelId);
    },
    getReasoningSupport(options: { modelId: string }): ReasoningSupport {
      return getReasoningSupport(providerId, options.modelId);
    },
  };
}
export {
  detectProviderForModel,
  resolveOpenAICompatPolicy,
  resolveProviderRoute,
  buildOpenAIAuthorizationUrl,
  completeOpenAIBrowserLogin,
  completeOpenAICodexDeviceLogin,
  completeOpenAIDeviceLogin,
  createOpenAIPkcePair,
  exchangeOpenAIAuthorizationCode,
  formatOpenAIAuthStatus,
  parseOpenAICallback,
  requestOpenAICodexDeviceAuthorization,
  requestOpenAIDeviceAuthorization,
  resolveReusableOpenAIOAuthClientId,
  resolveOpenAIAuth,
  resolveOpenAIAuthStatus,
  clearOpenAICredentials,
  readOpenAICredentials,
  writeOpenAICredentials,
};
