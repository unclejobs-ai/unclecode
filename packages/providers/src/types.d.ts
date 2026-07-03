import type { ProviderId } from "@unclecode/contracts";
export type ProviderCapabilityName = "tool-calls" | "session-memory" | "prompt-caching" | "oauth-browser-login" | "oauth-device-login" | "api-key-auth" | "org-context" | "project-context";
export type ModelRegistry = {
    readonly providerId: ProviderId;
    readonly defaultModel: string;
    readonly models: readonly string[];
};
export type ResolvedOpenAIAuth = {
    readonly status: "ok";
    readonly authType: "api-key" | "oauth";
    readonly source: "env-openai-api-key" | "env-openai-auth-token" | "unclecode-auth-file";
    readonly bearerToken: string;
} | {
    readonly status: "expired";
    readonly authType: "oauth";
    readonly source: "unclecode-auth-file";
    readonly reason: string;
} | {
    readonly status: "missing";
    readonly authType: "none";
    readonly source: "none";
    readonly reason: string;
};
export type ResolveOpenAIAuthInput = {
    readonly env?: NodeJS.ProcessEnv;
    readonly fallbackAuthPath?: string;
    readonly readFallbackFile?: () => Promise<string>;
};
export type OpenAIAuthStatus = {
    readonly providerId: "openai";
    readonly activeSource: "api-key-env" | "api-key-file" | "oauth-env" | "oauth-file" | "none";
    readonly authType: "api-key" | "oauth" | "none";
    readonly runtime: "api" | "codex" | null;
    readonly organizationId: string | null;
    readonly projectId: string | null;
    readonly expiresAt: string | null;
    readonly isExpired: boolean;
    readonly apiReady: boolean;
};
//# sourceMappingURL=types.d.ts.map
