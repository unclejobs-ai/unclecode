// Providers `/model <provider>/<model>` can switch to (the runtime-supported set).
const SWITCHABLE_PROVIDERS = new Set(["anthropic", "deepseek", "gemini", "openai", "xai"]);

/** The provider actually answering: a `provider/model` id from `/model` overrides the boot provider. */
export function resolveLiveProvider(bootProvider: string, model: string): string {
  const prefix = model.split("/", 1)[0] ?? "";
  // A provider outside the set (e.g. groq's `openai/gpt-oss-20b`) uses slashes in its own ids.
  return SWITCHABLE_PROVIDERS.has(bootProvider) && model.includes("/") && SWITCHABLE_PROVIDERS.has(prefix)
    ? prefix
    : bootProvider;
}

/** `/auth status` inspects OpenAI auth by default; for any other live provider, ask about that one. */
export function routeAuthStatusToLiveProvider(route: readonly string[], liveProvider: string): readonly string[] {
  return route.length === 2 && route[0] === "auth" && route[1] === "status" && liveProvider !== "openai"
    ? [...route, liveProvider]
    : route;
}
