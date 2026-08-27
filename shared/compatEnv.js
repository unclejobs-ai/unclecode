const MODEL_ENV_KEY_BY_PROVIDER = {
  openai: "OPENAI_MODEL",
  deepseek: "DEEPSEEK_MODEL",
  gemini: "GEMINI_MODEL",
  groq: "GROQ_MODEL",
  ollama: "OLLAMA_MODEL",
  copilot: "COPILOT_MODEL",
  zai: "ZAI_MODEL",
};

export function applyCompatModelEnv(provider, env) {
  const modelEnvKey = MODEL_ENV_KEY_BY_PROVIDER[provider];
  const model = modelEnvKey ? env[modelEnvKey]?.trim() : "";
  if (!model) {
    return env;
  }

  env.ANTHROPIC_MODEL = model;
  return env;
}
