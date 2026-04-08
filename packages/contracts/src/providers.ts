export const PROVIDER_IDS = [
  "anthropic",
  "gemini",
  "openai-api",
  "openai-codex",
  "groq",
  "ollama",
  "copilot",
  "zai",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_TRANSPORTS = ["native", "compat"] as const;

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

export const PROVIDER_CAPABILITIES = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    transport: "native",
    defaultModel: "claude-sonnet-4-20250514",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: true,
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    transport: "native",
    defaultModel: "gemini-2.5-flash",
    envKeys: ["GEMINI_API_KEY", "GEMINI_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  },
  "openai-api": {
    id: "openai-api",
    label: "OpenAI API",
    transport: "compat",
    defaultModel: "gpt-5.4",
    envKeys: ["OPENAI_API_KEY", "OPENAI_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  },
  "openai-codex": {
    id: "openai-codex",
    label: "OpenAI Codex",
    transport: "compat",
    defaultModel: "gpt-5.4",
    envKeys: ["OPENAI_AUTH_TOKEN", "OPENAI_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  },
  groq: {
    id: "groq",
    label: "Groq",
    transport: "compat",
    defaultModel: "openai/gpt-oss-20b",
    envKeys: ["GROQ_API_KEY", "GROQ_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    transport: "compat",
    defaultModel: "qwen3",
    envKeys: ["OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_API_KEY"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    transport: "compat",
    defaultModel: "openai/gpt-4.1-mini",
    envKeys: ["COPILOT_TOKEN", "COPILOT_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  },
  zai: {
    id: "zai",
    label: "z.ai",
    transport: "compat",
    defaultModel: "glm-5",
    envKeys: ["ZAI_API_KEY", "ZAI_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  },
} as const satisfies Readonly<Record<ProviderId, ProviderCapability>>;

export type ProviderCapabilityMap = typeof PROVIDER_CAPABILITIES;
