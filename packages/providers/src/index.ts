import { PROVIDER_IDS, type ProviderId } from "@unclecode/contracts";
import { ProviderCapabilityMismatchError } from "./errors.js";
import { assertProviderCapability, getOpenAIModelRegistry, getReasoningSupport } from "./model-registry.js";
import { resolveOpenAIAuth } from "./openai-auth.js";
import {
  normalizeOpenAIProviderId,
  resolvePreferredOpenAIProvider,
  type CanonicalOpenAIProviderId,
  type OpenAIProviderSelection,
} from "./openai-provider-selection.js";
import { clearOpenAICredentials, readOpenAICredentials, writeOpenAICredentials } from "./openai-credential-store.js";
import {
  clearOpenAICodexCredentials,
  readOpenAICodexCredentials,
  writeOpenAICodexCredentials,
} from "./openai-codex-credential-store.js";
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
import { formatOpenAICodexAuthStatus, resolveOpenAICodexAuthStatus } from "./openai-codex-status.js";
import { formatEffectiveOpenAIAuthStatus, resolveEffectiveOpenAIAuthStatus } from "./openai-auth-surface.js";
import type { ModelRegistry, OpenAIAuthStatus, ReasoningSupport, ResolveOpenAIAuthInput, ResolvedOpenAIAuth } from "./types.js";

export * from "./runtime.js";
export type { ProviderId };
export type { CanonicalOpenAIProviderId, OpenAIProviderSelection };
export type { ModelRegistry, OpenAIAuthStatus, ReasoningSupport, ResolveOpenAIAuthInput, ResolvedOpenAIAuth } from "./types.js";
export { ProviderCapabilityMismatchError };
export const PROVIDERS_SUPPORTED_IDS = PROVIDER_IDS;
export function getProviderAdapter(providerId: ProviderId | "openai") {
  const canonicalProviderId = normalizeOpenAIProviderId(providerId) ?? providerId;

  if (canonicalProviderId !== "openai-api" && canonicalProviderId !== "openai-codex") {
    throw new Error(`Provider ${providerId} is not implemented yet.`);
  }
  return {
    providerId: canonicalProviderId,
    getModelRegistry(env?: NodeJS.ProcessEnv) {
      return getOpenAIModelRegistry(env, canonicalProviderId);
    },
    assertCapability(capability: Parameters<typeof assertProviderCapability>[1], options: { modelId: string }) {
      assertProviderCapability(canonicalProviderId, capability, options.modelId);
    },
    getReasoningSupport(options: { modelId: string }): ReasoningSupport {
      return getReasoningSupport(canonicalProviderId, options.modelId);
    },
  };
}
export {
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
  clearOpenAICodexCredentials,
  readOpenAICodexCredentials,
  writeOpenAICodexCredentials,
  formatOpenAICodexAuthStatus,
  resolveOpenAICodexAuthStatus,
  formatEffectiveOpenAIAuthStatus,
  resolveEffectiveOpenAIAuthStatus,
  normalizeOpenAIProviderId,
  resolvePreferredOpenAIProvider,
};
