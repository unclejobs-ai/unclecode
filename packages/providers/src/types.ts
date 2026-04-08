import type { ModeReasoningEffort, ProviderId } from "@unclecode/contracts";

export type ProviderCapabilityName =
  | "tool-calls"
  | "session-memory"
  | "prompt-caching"
  | "oauth-browser-login"
  | "oauth-device-login"
  | "api-key-auth"
  | "org-context"
  | "project-context";

export type ReasoningSupport =
  | {
      readonly status: "supported";
      readonly defaultEffort: ModeReasoningEffort;
      readonly supportedEfforts: readonly ModeReasoningEffort[];
    }
  | {
      readonly status: "unsupported";
      readonly supportedEfforts: readonly [];
    };

export type ModelRegistry = {
  readonly providerId: ProviderId;
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly reasoningByModel: Readonly<Record<string, ReasoningSupport>>;
};

export type ResolvedOpenAIAuth =
  | {
      readonly status: "ok";
      readonly authType: "api-key" | "oauth";
      readonly source:
        | "env-openai-api-key"
        | "env-openai-auth-token"
        | "unclecode-auth-file"
        | "codex-auth-file"
        | "unclecode-api-key-file";
      readonly bearerToken: string;
      readonly organizationId?: string | null;
      readonly projectId?: string | null;
    }
  | {
      readonly status: "expired";
      readonly authType: "oauth";
      readonly source: "unclecode-auth-file" | "codex-auth-file" | "env-openai-auth-token";
      readonly reason: string;
    }
  | {
      readonly status: "missing";
      readonly authType: "none" | "oauth";
      readonly source: "none" | "unclecode-auth-file" | "codex-auth-file";
      readonly reason: string;
    };

export type ResolveOpenAIAuthInput = {
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackAuthPath?: string;
  readonly fallbackAuthPaths?: readonly string[];
  readonly readFallbackFile?: ((authPath?: string) => Promise<string>) | undefined;
};

export type OpenAIAuthStatus = {
  readonly providerId: "openai-api";
  readonly activeSource: "api-key-env" | "api-key-file" | "oauth-env" | "oauth-file" | "none";
  readonly authType: "api-key" | "oauth" | "none";
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly expiresAt: string | null;
  readonly isExpired: boolean;
};
