export type CompatProvider = "openai" | "deepseek" | "gemini" | "groq" | "ollama" | "copilot" | "zai";

export type ModelOption = {
  value: string;
  label: string;
  description: string;
};

export function providerLabel(provider: CompatProvider): string;
export function providerModelCatalog(
  provider: CompatProvider,
  env?: NodeJS.ProcessEnv,
): string[];
export function providerPromptSuggestions(
  provider: CompatProvider,
  env?: NodeJS.ProcessEnv,
): string[];
export function providerAdditionalModelOptions(
  provider: CompatProvider,
  env?: NodeJS.ProcessEnv,
): ModelOption[];
