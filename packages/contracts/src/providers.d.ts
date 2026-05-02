export declare const PROVIDER_IDS: readonly ["anthropic", "gemini", "openai", "groq", "ollama", "copilot", "zai"];
export type ProviderId = (typeof PROVIDER_IDS)[number];
export declare const PROVIDER_TRANSPORTS: readonly ["native", "compat"];
export type ProviderTransport = (typeof PROVIDER_TRANSPORTS)[number];
export type ProviderCapability = {
    readonly id: ProviderId;
    readonly label: string;
    readonly transport: ProviderTransport;
    readonly defaultModel: string;
    readonly envKeys: readonly string[];
    readonly supportsToolCalls: boolean;
    readonly supportsSessionMemory: boolean;
    readonly supportsPromptCaching: boolean;
};
export declare const PROVIDER_CAPABILITIES: {
    readonly anthropic: {
        readonly id: "anthropic";
        readonly label: "Anthropic";
        readonly transport: "native";
        readonly defaultModel: "claude-sonnet-4-20250514";
        readonly envKeys: readonly ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"];
        readonly supportsToolCalls: true;
        readonly supportsSessionMemory: true;
        readonly supportsPromptCaching: true;
    };
    readonly gemini: {
        readonly id: "gemini";
        readonly label: "Gemini";
        readonly transport: "native";
        readonly defaultModel: "gemini-2.5-flash";
        readonly envKeys: readonly ["GEMINI_API_KEY", "GEMINI_MODEL"];
        readonly supportsToolCalls: true;
        readonly supportsSessionMemory: true;
        readonly supportsPromptCaching: false;
    };
    readonly openai: {
        readonly id: "openai";
        readonly label: "OpenAI";
        readonly transport: "compat";
        readonly defaultModel: "gpt-5.5";
        readonly envKeys: readonly ["OPENAI_API_KEY", "OPENAI_MODEL"];
        readonly supportsToolCalls: true;
        readonly supportsSessionMemory: true;
        readonly supportsPromptCaching: false;
    };
    readonly groq: {
        readonly id: "groq";
        readonly label: "Groq";
        readonly transport: "compat";
        readonly defaultModel: "openai/gpt-oss-20b";
        readonly envKeys: readonly ["GROQ_API_KEY", "GROQ_MODEL"];
        readonly supportsToolCalls: true;
        readonly supportsSessionMemory: true;
        readonly supportsPromptCaching: false;
    };
    readonly ollama: {
        readonly id: "ollama";
        readonly label: "Ollama";
        readonly transport: "compat";
        readonly defaultModel: "qwen3";
        readonly envKeys: readonly ["OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_API_KEY"];
        readonly supportsToolCalls: true;
        readonly supportsSessionMemory: true;
        readonly supportsPromptCaching: false;
    };
    readonly copilot: {
        readonly id: "copilot";
        readonly label: "GitHub Copilot";
        readonly transport: "compat";
        readonly defaultModel: "openai/gpt-4.1-mini";
        readonly envKeys: readonly ["COPILOT_TOKEN", "COPILOT_MODEL"];
        readonly supportsToolCalls: true;
        readonly supportsSessionMemory: true;
        readonly supportsPromptCaching: false;
    };
    readonly zai: {
        readonly id: "zai";
        readonly label: "z.ai";
        readonly transport: "compat";
        readonly defaultModel: "glm-5";
        readonly envKeys: readonly ["ZAI_API_KEY", "ZAI_MODEL"];
        readonly supportsToolCalls: true;
        readonly supportsSessionMemory: true;
        readonly supportsPromptCaching: false;
    };
};
export type ProviderCapabilityMap = typeof PROVIDER_CAPABILITIES;
//# sourceMappingURL=providers.d.ts.map