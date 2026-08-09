import type { WorkEngine } from "./work-runtime-args.js";
import {
  workShellAuthLabelWithApiBlocked,
  type RustOpenAIAuthStatus,
} from "./work-runtime-session.js";

export function resolveDefaultWorkEngine(env: NodeJS.ProcessEnv): WorkEngine {
  return env.UNCLECODE_WORK_ENGINE === "native" ? "native" : "pi";
}

const OAUTH_API_BLOCKED_LABELS = new Set([
  "oauth-file-api-blocked",
  "oauth-env-api-blocked",
  "OAuth file · API blocked",
  "OAuth env · API blocked",
]);

export function resolveWorkShellAuthLabel(input: {
  readonly engine: WorkEngine;
  readonly configuredLabel: string;
  readonly authStatus?: RustOpenAIAuthStatus;
  readonly codexOAuthAvailable?: boolean;
}): string {
  const label = input.authStatus
    ? workShellAuthLabelWithApiBlocked(input.configuredLabel, input.authStatus)
    : input.configuredLabel;
  // Only Codex credentials can select pi-ai's openai-codex transport. UncleCode
  // OAuth file/env tokens remain unusable for standard OpenAI API calls.
  if (
    input.engine === "pi"
    && input.codexOAuthAvailable === true
    && OAUTH_API_BLOCKED_LABELS.has(label)
  ) {
    return "oauth-pi";
  }
  return label;
}
