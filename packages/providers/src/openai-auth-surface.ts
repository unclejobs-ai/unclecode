import { formatOpenAICodexAuthStatus, resolveOpenAICodexAuthStatus } from "./openai-codex-status.js";
import { resolvePreferredOpenAIProvider } from "./openai-provider-selection.js";
import { formatOpenAIAuthStatus, resolveOpenAIAuthStatus } from "./openai-status.js";

export async function resolveEffectiveOpenAIAuthStatus(options: {
  readonly env?: NodeJS.ProcessEnv;
} = {}) {
  const env = options.env ?? process.env;
  const preferred = await resolvePreferredOpenAIProvider({ env });

  if (preferred.providerId === "openai-codex") {
    return await resolveOpenAICodexAuthStatus({ env });
  }

  return await resolveOpenAIAuthStatus({ env });
}

export function formatEffectiveOpenAIAuthStatus(status: Awaited<ReturnType<typeof resolveEffectiveOpenAIAuthStatus>>): string {
  return status.providerId === "openai-codex"
    ? formatOpenAICodexAuthStatus(status)
    : formatOpenAIAuthStatus(status);
}
