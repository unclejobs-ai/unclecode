import { MODE_REASONING_EFFORTS, PROVIDER_IDS } from "@unclecode/contracts";
import { ProviderCapabilityMismatchError } from "./errors.js";
import { runRustCommandSync } from "./rust-command.js";
const UNSUPPORTED_REASONING = {
    status: "unsupported",
    supportedEfforts: [],
};
function supportedReasoning(defaultEffort) {
    return {
        status: "supported",
        defaultEffort,
        supportedEfforts: MODE_REASONING_EFFORTS,
    };
}
export function getOpenAIReasoningSupport(modelId) {
    const stdout = runRustCommandSync(["rust", "model", "openai-reasoning", modelId], process.cwd());
    return parseRustReasoningSupport(parseRustKeyValueLines(stdout));
}
export function getReasoningSupport(providerId, modelId) {
    if (providerId === "openai") {
        return getOpenAIReasoningSupport(modelId);
    }
    return UNSUPPORTED_REASONING;
}
export function detectProviderForModel(modelId) {
    const stdout = runRustCommandSync(["rust", "model", "detect-provider", modelId], process.cwd());
    const provider = parseRustKeyValueLines(stdout).get("provider");
    return provider === "anthropic" || provider === "gemini" || provider === "deepseek"
        ? provider
        : "openai";
}
export function resolveProviderRoute(providerId, modelId = "") {
    const args = ["rust", "model", "provider-route-json", providerId];
    if (modelId.trim()) {
        args.push(modelId.trim());
    }
    const parsed = JSON.parse(runRustCommandSync(args, process.cwd()).trim());
    if (!isRecord(parsed)) {
        throw new Error("Rust provider route returned an invalid payload.");
    }
    const provider = typeof parsed.providerId === "string" ? parsed.providerId : undefined;
    if (!isProviderId(provider)) {
        throw new Error(`Rust provider route returned unsupported provider: ${provider ?? ""}`);
    }
    const proxyPolicy = isRecord(parsed.proxyPolicy) ? parsed.proxyPolicy : {};
    return {
        providerId: provider,
        label: typeof parsed.label === "string" ? parsed.label : provider,
        transport: parsed.transport === "native" ? "native" : "compat",
        runtimeSupported: parsed.runtimeSupported === true,
        defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : "",
        endpointUrl: typeof parsed.endpointUrl === "string" ? parsed.endpointUrl : "",
        proxyPolicy: {
            proxyUrl: typeof proxyPolicy.proxyUrl === "string" && proxyPolicy.proxyUrl.trim() ? proxyPolicy.proxyUrl : null,
            source: typeof proxyPolicy.source === "string" ? proxyPolicy.source : "none",
            bypassed: proxyPolicy.bypassed === true,
            targetHost: typeof proxyPolicy.targetHost === "string" ? proxyPolicy.targetHost : "",
            noProxy: Array.isArray(proxyPolicy.noProxy)
                ? proxyPolicy.noProxy.filter((entry) => typeof entry === "string")
                : [],
        },
        envKeys: Array.isArray(parsed.envKeys)
            ? parsed.envKeys.filter((key) => typeof key === "string")
            : [],
        compatPolicy: parseOpenAICompatPolicy(parsed.compatPolicy, provider),
    };
}
export function resolveOpenAICompatPolicy(providerId, modelId, endpointUrl = "") {
    const args = ["rust", "model", "openai-compat-policy-json", providerId, modelId];
    if (endpointUrl.trim()) {
        args.push(endpointUrl.trim());
    }
    const parsed = JSON.parse(runRustCommandSync(args, process.cwd()).trim());
    return parseOpenAICompatPolicy(parsed, providerId);
}
export function getProviderModelCatalog(providerId, env = process.env) {
    const stdout = runRustCommandSync(["rust", "model", "catalog", providerId], process.cwd(), env);
    let label = providerId;
    const models = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("label=")) {
            label = line.slice("label=".length).trim() || label;
        }
        else if (line.startsWith("model=")) {
            const model = line.slice("model=".length).trim();
            if (model) {
                models.push(model);
            }
        }
    }
    return { label, models };
}
export function getOpenAIModelRegistry(env = process.env) {
    const stdout = runRustCommandSync(["rust", "model", "openai-registry"], process.cwd(), env);
    const parsed = parseRustModelRegistry(stdout);
    return {
        providerId: "openai",
        defaultModel: parsed.defaultModel,
        models: parsed.models,
        reasoningByModel: parsed.reasoningByModel,
    };
}
export function getGenericModelRegistry(providerId, env = process.env) {
    const catalog = getProviderModelCatalog(providerId, env);
    return {
        providerId,
        defaultModel: catalog.models[0] ?? "",
        models: [...catalog.models],
        reasoningByModel: Object.fromEntries(catalog.models.map((model) => [model, UNSUPPORTED_REASONING])),
    };
}
/**
 * Derived from `PROVIDER_IDS` rather than a hand-written list: a duplicated
 * literal set silently rejected `omp` once it joined the public provider set.
 */
function isProviderId(value) {
    return value !== undefined && PROVIDER_IDS.includes(value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseOpenAICompatPolicy(value, fallbackProviderId) {
    const parsed = isRecord(value) ? value : {};
    const toolStrictMode = parsed.toolStrictMode === "provider" ? "provider" : "disabled";
    const maxTokensField = parsed.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
    const thinkingFormat = parsed.thinkingFormat === "zai"
        || parsed.thinkingFormat === "qwen"
        || parsed.thinkingFormat === "deepseek"
        ? parsed.thinkingFormat
        : "none";
    return {
        providerId: typeof parsed.providerId === "string" ? parsed.providerId : fallbackProviderId,
        modelId: typeof parsed.modelId === "string" ? parsed.modelId : "",
        supportsReasoningEffort: parsed.supportsReasoningEffort === true,
        supportsToolChoice: parsed.supportsToolChoice !== false,
        supportsStrictTools: parsed.supportsStrictTools === true,
        toolStrictMode,
        maxTokensField,
        supportsMultipleSystemMessages: parsed.supportsMultipleSystemMessages === true,
        requiresToolResultName: parsed.requiresToolResultName === true,
        requiresAssistantContentForToolCalls: parsed.requiresAssistantContentForToolCalls === true,
        requiresReasoningContentForToolCalls: parsed.requiresReasoningContentForToolCalls === true,
        thinkingFormat,
    };
}
function parseRustModelRegistry(stdout) {
    let defaultModel = "";
    const models = [];
    const reasoningByModel = {};
    for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("defaultModel=")) {
            defaultModel = line.slice("defaultModel=".length).trim() || defaultModel;
            continue;
        }
        if (!line.startsWith("model=")) {
            continue;
        }
        const fields = parseRustTabbedFields(line);
        const model = fields.get("model");
        if (!model) {
            continue;
        }
        models.push(model);
        reasoningByModel[model] = parseRustReasoningSupport(fields);
    }
    return { defaultModel, models, reasoningByModel };
}
function parseRustKeyValueLines(stdout) {
    return new Map(stdout
        .split(/\r?\n/)
        .map((line) => line.split("=", 2))
        .filter((parts) => parts.length === 2));
}
function parseRustTabbedFields(line) {
    return new Map(line
        .split("\t")
        .map((field) => field.split("=", 2))
        .filter((parts) => parts.length === 2));
}
function parseRustReasoningSupport(fields) {
    if (fields.get("status") !== "supported" && fields.get("reasoning") !== "supported") {
        return UNSUPPORTED_REASONING;
    }
    const defaultEffort = fields.get("defaultEffort");
    return supportedReasoning(defaultEffort === "low" || defaultEffort === "high" ? defaultEffort : "medium");
}
export function assertProviderCapability(providerId, capability, modelId) {
    const parsed = JSON.parse(runRustCommandSync(["rust", "model", "capability", providerId, capability, modelId], process.cwd()).trim());
    if (!isRecord(parsed) || parsed.supported !== true && parsed.supported !== false) {
        throw new Error("Rust provider capability returned an invalid payload.");
    }
    if (!parsed.supported) {
        throw new ProviderCapabilityMismatchError({
            providerId,
            requiredCapability: capability,
            modelId,
        });
    }
}
//# sourceMappingURL=model-registry.js.map