use crate::http_transport::{resolve_proxy_policy, ProxyPolicy};
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReasoningSupport {
    pub status: String,
    pub default_effort: Option<String>,
    pub supported_efforts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRegistry {
    pub provider_id: String,
    pub default_model: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatProviderCatalog {
    pub provider_id: String,
    pub label: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRoute {
    pub provider_id: String,
    pub label: String,
    pub transport: String,
    pub runtime_supported: bool,
    pub default_model: String,
    pub endpoint_url: String,
    pub env_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAICompatPolicy {
    pub provider_id: String,
    pub model_id: String,
    pub supports_reasoning_effort: bool,
    pub supports_tool_choice: bool,
    pub supports_strict_tools: bool,
    pub tool_strict_mode: String,
    pub max_tokens_field: String,
    pub supports_multiple_system_messages: bool,
    pub requires_tool_result_name: bool,
    pub requires_assistant_content_for_tool_calls: bool,
    pub requires_reasoning_content_for_tool_calls: bool,
    pub thinking_format: String,
}

const OPENAI_DEFAULT_MODEL: &str = "gpt-5.6-sol";
const OPENAI_DEFAULT_MODELS: &[&str] = &["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
pub const OPENAI_REASONING_EFFORTS: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];

const COMPAT_OPENAI_MODELS: &[&str] = &["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const COMPAT_DEEPSEEK_MODELS: &[&str] = &["deepseek-chat", "deepseek-reasoner"];
const COMPAT_ANTHROPIC_MODELS: &[&str] = &[
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
];
const COMPAT_GEMINI_MODELS: &[&str] = &["gemini-2.5-flash", "gemini-2.5-pro", "gemma-3-27b-it"];
const COMPAT_GROQ_MODELS: &[&str] = &[
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3-32b",
    "llama-3.3-70b-versatile",
];
const COMPAT_OLLAMA_MODELS: &[&str] = &[
    "qwen3",
    "qwen2.5-coder:7b",
    "qwen2.5-coder:14b",
    "deepseek-r1:8b",
];
const COMPAT_COPILOT_MODELS: &[&str] = &[
    "openai/gpt-4.1-mini",
    "openai/gpt-4.1",
    "openai/gpt-4o",
    "openai/o4-mini",
];
const COMPAT_ZAI_MODELS: &[&str] = &["glm-5", "glm-4.5", "glm-4.5-air"];
/// OMP is the delegated work/executor route: it is pinned to a single selector
/// because UncleCode never picks the upstream model for a delegated turn.
const OMP_MODELS: &[&str] = &["kimi-code/k3"];
/// Providers UncleCode can drive as its own interactive runtime. `omp` is
/// absent on purpose: it is executor-only and hands the whole turn to OMP.
const RUNTIME_SUPPORTED_PROVIDERS: &[&str] = &["anthropic", "gemini", "openai", "deepseek"];

pub fn openai_reasoning_support(model_id: &str) -> ReasoningSupport {
    let normalized = model_id.trim().to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "gpt-5.6" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna"
    ) {
        return ReasoningSupport {
            status: "supported".to_string(),
            default_effort: Some("medium".to_string()),
            supported_efforts: OPENAI_REASONING_EFFORTS
                .iter()
                .map(|effort| (*effort).to_string())
                .collect(),
        };
    }

    ReasoningSupport {
        status: "unsupported".to_string(),
        default_effort: None,
        supported_efforts: Vec::new(),
    }
}
pub fn is_openai_reasoning_effort(value: &str) -> bool {
    OPENAI_REASONING_EFFORTS.contains(&value)
}

pub fn openai_model_registry(active_model: Option<&str>) -> ModelRegistry {
    let mut models = Vec::new();
    if let Some(model) = active_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        push_unique(&mut models, model);
    }
    for model in OPENAI_DEFAULT_MODELS {
        push_unique(&mut models, model);
    }

    ModelRegistry {
        provider_id: "openai".to_string(),
        default_model: OPENAI_DEFAULT_MODEL.to_string(),
        models,
    }
}

pub fn detect_provider_for_model(model_id: &str) -> &'static str {
    let normalized = model_id.trim().to_ascii_lowercase();
    if normalized.starts_with("claude") {
        "anthropic"
    } else if normalized.starts_with("gemini") {
        "gemini"
    } else if normalized.starts_with("deepseek") {
        "deepseek"
    } else {
        "openai"
    }
}

pub fn resolve_provider_route(
    provider_id: &str,
    model_id: Option<&str>,
) -> Result<ProviderRoute, String> {
    let requested = provider_id.trim().to_ascii_lowercase();
    let provider = if requested == "auto" {
        detect_provider_for_model(model_id.unwrap_or_default()).to_string()
    } else {
        requested
    };
    if !is_known_provider(&provider) {
        return Err(format!("Unsupported runtime provider: {provider}"));
    }
    let defaults = provider_default_models(&provider);
    Ok(ProviderRoute {
        provider_id: provider.clone(),
        label: provider_label(&provider),
        transport: provider_transport(&provider).to_string(),
        runtime_supported: RUNTIME_SUPPORTED_PROVIDERS.contains(&provider.as_str()),
        default_model: defaults.first().copied().unwrap_or_default().to_string(),
        endpoint_url: provider_endpoint_url(&provider).to_string(),
        env_keys: provider_env_keys(&provider)
            .iter()
            .map(|key| key.to_string())
            .collect(),
    })
}

/// Resolve the proxy policy that applies to a route.
///
/// A route without an endpoint URL never leaves the machine — OMP runs as a
/// local subprocess — so no HTTP proxy can apply and there is no URL to parse.
pub fn provider_route_proxy_policy(route: &ProviderRoute) -> Result<ProxyPolicy, String> {
    if route.endpoint_url.trim().is_empty() {
        return Ok(ProxyPolicy {
            target_host: String::new(),
            proxy_url: None,
            source: "none".to_string(),
            bypassed: false,
            no_proxy: Vec::new(),
        });
    }
    resolve_proxy_policy(&route.endpoint_url)
}

pub fn provider_route_json(route: &ProviderRoute, proxy: &ProxyPolicy) -> Result<String, String> {
    let compat_policy = openai_compat_policy_value(
        &route.provider_id,
        &route.default_model,
        Some(&route.endpoint_url),
    );
    serde_json::to_string(&json!({
        "providerId": route.provider_id,
        "label": route.label,
        "transport": route.transport,
        "runtimeSupported": route.runtime_supported,
        "defaultModel": route.default_model,
        "endpointUrl": route.endpoint_url,
        "envKeys": route.env_keys,
        "compatPolicy": compat_policy,
        "proxyPolicy": {
            "proxyUrl": proxy.proxy_url.as_deref().map(crate::http_transport::redact_proxy_url_for_display),
            "source": proxy.source,
            "bypassed": proxy.bypassed,
            "targetHost": proxy.target_host,
            "noProxy": proxy.no_proxy,
        },
    }))
    .map_err(|error| error.to_string())
}

pub fn openai_compat_policy_json(
    provider_id: &str,
    model_id: &str,
    endpoint_url: Option<&str>,
) -> Result<String, String> {
    serde_json::to_string(&openai_compat_policy_value(
        provider_id,
        model_id,
        endpoint_url,
    ))
    .map_err(|error| error.to_string())
}

fn openai_compat_policy_value(
    provider_id: &str,
    model_id: &str,
    endpoint_url: Option<&str>,
) -> serde_json::Value {
    let policy = openai_compat_policy(provider_id, model_id, endpoint_url);
    json!({
        "providerId": policy.provider_id,
        "modelId": policy.model_id,
        "supportsReasoningEffort": policy.supports_reasoning_effort,
        "supportsToolChoice": policy.supports_tool_choice,
        "supportsStrictTools": policy.supports_strict_tools,
        "toolStrictMode": policy.tool_strict_mode,
        "maxTokensField": policy.max_tokens_field,
        "supportsMultipleSystemMessages": policy.supports_multiple_system_messages,
        "requiresToolResultName": policy.requires_tool_result_name,
        "requiresAssistantContentForToolCalls": policy.requires_assistant_content_for_tool_calls,
        "requiresReasoningContentForToolCalls": policy.requires_reasoning_content_for_tool_calls,
        "thinkingFormat": policy.thinking_format,
    })
}

pub fn openai_compat_policy(
    provider_id: &str,
    model_id: &str,
    endpoint_url: Option<&str>,
) -> OpenAICompatPolicy {
    let provider = provider_id.trim().to_ascii_lowercase();
    let model = model_id.trim().to_ascii_lowercase();
    let endpoint = endpoint_url.unwrap_or_default().trim().to_ascii_lowercase();
    let is_zai = provider == "zai" || endpoint.contains("bigmodel.cn") || model.starts_with("glm-");
    let is_kimi =
        model.contains("kimi") || model.contains("moonshot") || endpoint.contains("moonshot");
    let is_qwen = model.contains("qwen");
    let is_deepseek = provider == "deepseek" || model.contains("deepseek");
    let is_groq = provider == "groq" || endpoint.contains("groq.com");
    let is_mistral =
        provider == "mistral" || endpoint.contains("mistral") || model.contains("mistral");
    let is_copilot = provider == "copilot" || endpoint.contains("githubcopilot");
    let supports_reasoning_effort =
        provider == "openai" || is_groq && (model.contains("gpt-oss") || model.contains("qwen3"));
    let supports_strict_tools = provider == "openai" || is_copilot;
    let supports_multiple_system_messages = provider == "openai" || is_copilot;
    let thinking_format = if is_zai || is_kimi {
        "zai"
    } else if is_qwen {
        "qwen"
    } else if is_deepseek {
        "deepseek"
    } else {
        "none"
    };

    OpenAICompatPolicy {
        provider_id: provider,
        model_id: model_id.trim().to_string(),
        supports_reasoning_effort,
        supports_tool_choice: !is_deepseek && !is_mistral,
        supports_strict_tools,
        tool_strict_mode: if supports_strict_tools {
            "provider".to_string()
        } else {
            "disabled".to_string()
        },
        max_tokens_field: if is_zai || is_deepseek || model.starts_with("o") {
            "max_completion_tokens".to_string()
        } else {
            "max_tokens".to_string()
        },
        supports_multiple_system_messages,
        requires_tool_result_name: is_mistral,
        requires_assistant_content_for_tool_calls: is_kimi || is_zai,
        requires_reasoning_content_for_tool_calls: is_kimi || is_deepseek,
        thinking_format: thinking_format.to_string(),
    }
}

pub fn provider_runtime_decision_json(route: &ProviderRoute) -> Result<String, String> {
    let error = (!route.runtime_supported)
        .then(|| format!("Unsupported runtime provider: {}", route.provider_id));
    serde_json::to_string(&json!({
        "providerId": route.provider_id,
        "runtimeSupported": route.runtime_supported,
        "runtimeKind": if route.runtime_supported { route.provider_id.as_str() } else { "unsupported" },
        "error": error,
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_capability_json(
    provider_id: &str,
    capability: &str,
    model_id: &str,
) -> Result<String, String> {
    let provider = provider_id.trim().to_ascii_lowercase();
    if !is_known_provider(&provider) {
        return Err(format!("Unsupported runtime provider: {provider}"));
    }
    let capability = capability.trim();
    let supported = provider_supports_capability(&provider, capability);
    serde_json::to_string(&json!({
        "providerId": provider,
        "capability": capability,
        "modelId": model_id,
        "supported": supported
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_label(provider_id: &str) -> String {
    match provider_id {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        "deepseek" => "DeepSeek",
        "gemini" => "Google Gemini",
        "groq" => "Groq",
        "ollama" => "Ollama",
        "copilot" => "GitHub Copilot",
        "zai" => "z.ai",
        "omp" => "OMP",
        other => other,
    }
    .to_string()
}

fn is_known_provider(provider_id: &str) -> bool {
    matches!(
        provider_id,
        "anthropic"
            | "gemini"
            | "openai"
            | "deepseek"
            | "groq"
            | "ollama"
            | "copilot"
            | "zai"
            | "omp"
    )
}

fn provider_transport(provider_id: &str) -> &'static str {
    match provider_id {
        // `omp` is native: the executor speaks OMP's own worker protocol over a
        // subprocess, not the OpenAI-compatible HTTP shape.
        "anthropic" | "gemini" | "openai" | "omp" => "native",
        _ => "compat",
    }
}

fn provider_supports_capability(provider_id: &str, capability: &str) -> bool {
    match capability {
        "tool-calls" => true,
        // OMP starts a fresh session per delegated turn, so nothing carries over.
        "session-memory" => provider_id != "omp",
        "prompt-caching" => provider_id == "anthropic" || provider_id == "omp",
        _ => provider_id == "openai",
    }
}

fn provider_env_keys(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "anthropic" => &["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
        "gemini" => &["GEMINI_API_KEY", "GEMINI_MODEL"],
        "openai" => &["OPENAI_API_KEY", "OPENAI_MODEL"],
        "deepseek" => &["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL"],
        "groq" => &["GROQ_API_KEY", "GROQ_MODEL"],
        "ollama" => &["OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_API_KEY"],
        "copilot" => &["COPILOT_TOKEN", "COPILOT_MODEL"],
        "zai" => &["ZAI_API_KEY", "ZAI_MODEL"],
        // OMP resolves its own credentials from its own profile; UncleCode reads
        // no environment for this route and holds no bearer token for it.
        "omp" => &[],
        _ => &[],
    }
}

fn provider_endpoint_url(provider_id: &str) -> &'static str {
    match provider_id {
        "anthropic" => "https://api.anthropic.com/v1/messages",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/models",
        "openai" => "https://api.openai.com/v1/responses",
        "deepseek" => "https://api.deepseek.com/chat/completions",
        "groq" => "https://api.groq.com/openai/v1/chat/completions",
        "ollama" => "http://localhost:11434/api/chat",
        "copilot" => "https://api.githubcopilot.com/chat/completions",
        "zai" => "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        // OMP has no endpoint: the executor turn runs in a local subprocess.
        "omp" => "",
        _ => "",
    }
}

pub fn provider_model_catalog(
    provider_id: &str,
    active_model: Option<&str>,
    custom_models: Option<&str>,
) -> CompatProviderCatalog {
    // OMP is pinned: a delegated work turn always runs on the same selector, so
    // neither an active model nor an operator model list may widen its catalog.
    if provider_id == "omp" {
        return CompatProviderCatalog {
            provider_id: provider_id.to_string(),
            label: provider_label(provider_id),
            models: OMP_MODELS
                .iter()
                .map(|model| (*model).to_string())
                .collect(),
        };
    }
    let mut models = Vec::new();
    if let Some(model) = active_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        push_unique(&mut models, model);
    }
    for model in custom_models
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        push_unique(&mut models, model);
    }
    for model in provider_default_models(provider_id) {
        push_unique(&mut models, model);
    }

    CompatProviderCatalog {
        provider_id: provider_id.to_string(),
        label: provider_label(provider_id),
        models,
    }
}

fn provider_default_models(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "anthropic" => COMPAT_ANTHROPIC_MODELS,
        "openai" => COMPAT_OPENAI_MODELS,
        "deepseek" => COMPAT_DEEPSEEK_MODELS,
        "gemini" => COMPAT_GEMINI_MODELS,
        "groq" => COMPAT_GROQ_MODELS,
        "ollama" => COMPAT_OLLAMA_MODELS,
        "copilot" => COMPAT_COPILOT_MODELS,
        "zai" => COMPAT_ZAI_MODELS,
        "omp" => OMP_MODELS,
        _ => &[],
    }
}

fn push_unique(models: &mut Vec<String>, model: &str) {
    if !models.iter().any(|existing| existing == model) {
        models.push(model.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_registry_keeps_active_model_first() {
        let registry = openai_model_registry(Some("custom-openai-model"));
        assert_eq!(registry.provider_id, "openai");
        assert_eq!(registry.default_model, "gpt-5.6-sol");
        assert_eq!(
            registry.models,
            [
                "custom-openai-model",
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
            ]
        );
    }

    #[test]
    fn openai_reasoning_support_matches_gpt_5_6_family() {
        for model in ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] {
            let support = openai_reasoning_support(model);
            assert_eq!(support.status, "supported");
            assert_eq!(support.default_effort.as_deref(), Some("medium"));
            assert_eq!(
                support.supported_efforts,
                ["none", "low", "medium", "high", "xhigh", "max"]
            );
        }
        assert_eq!(openai_reasoning_support("gpt-5.5").status, "unsupported");
        assert_eq!(
            openai_reasoning_support("gpt-4.1-mini").status,
            "unsupported"
        );
    }

    #[test]
    fn detects_provider_from_model_family() {
        assert_eq!(detect_provider_for_model("Claude-Sonnet"), "anthropic");
        assert_eq!(detect_provider_for_model("Gemini-3.1"), "gemini");
        assert_eq!(detect_provider_for_model("deepseek-reasoner"), "deepseek");
        assert_eq!(detect_provider_for_model("gpt-5.6-terra"), "openai");
    }

    #[test]
    fn resolves_deepseek_runtime_route_catalog_and_wire_policy() {
        let route = resolve_provider_route("deepseek", None).unwrap();
        assert_eq!(route.provider_id, "deepseek");
        assert_eq!(route.label, "DeepSeek");
        assert_eq!(route.transport, "compat");
        assert!(route.runtime_supported);
        assert_eq!(route.default_model, "deepseek-chat");
        assert_eq!(
            route.endpoint_url,
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            route.env_keys,
            ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL"]
        );

        let catalog = provider_model_catalog("deepseek", None, None);
        assert_eq!(catalog.models, ["deepseek-chat", "deepseek-reasoner"]);

        let policy = openai_compat_policy("deepseek", "deepseek-reasoner", None);
        assert_eq!(policy.thinking_format, "deepseek");
        assert!(!policy.supports_tool_choice);
        assert!(policy.requires_reasoning_content_for_tool_calls);
    }

    #[test]
    fn resolves_provider_route_metadata() {
        let route = resolve_provider_route("auto", Some("Claude-Sonnet")).unwrap();
        assert_eq!(route.provider_id, "anthropic");
        assert_eq!(route.label, "Anthropic");
        assert_eq!(route.transport, "native");
        assert!(route.runtime_supported);
        assert_eq!(route.default_model, "claude-sonnet-4-20250514");
        assert_eq!(route.endpoint_url, "https://api.anthropic.com/v1/messages");
        assert!(route.env_keys.contains(&"ANTHROPIC_API_KEY".to_string()));

        let openai_route = resolve_provider_route("auto", Some("gpt-5.6-sol")).unwrap();
        assert_eq!(openai_route.provider_id, "openai");
        assert_eq!(openai_route.transport, "native");
        assert!(openai_route.runtime_supported);
        assert_eq!(
            openai_route.endpoint_url,
            "https://api.openai.com/v1/responses"
        );

        let compat_route = resolve_provider_route("ollama", None).unwrap();
        assert_eq!(compat_route.transport, "compat");
        assert!(!compat_route.runtime_supported);
        assert_eq!(compat_route.endpoint_url, "http://localhost:11434/api/chat");

        assert!(resolve_provider_route("bogus", None).is_err());
    }

    #[test]
    fn resolves_omp_as_an_executor_only_native_route() {
        let route = resolve_provider_route("omp", None).unwrap();
        assert_eq!(route.provider_id, "omp");
        assert_eq!(route.label, "OMP");
        assert_eq!(route.transport, "native");
        assert_eq!(route.default_model, "kimi-code/k3");
        // Executor-only: `omp` is never a selectable interactive runtime.
        assert!(!route.runtime_supported);
        // OMP owns credential lookup, so UncleCode reads no env and has no endpoint.
        assert!(route.env_keys.is_empty());
        assert_eq!(route.endpoint_url, "");

        assert_eq!(
            resolve_provider_route("OMP", None).unwrap().provider_id,
            "omp"
        );
    }

    #[test]
    fn omp_route_json_reports_a_local_proxy_free_policy() {
        let route = resolve_provider_route("omp", None).unwrap();
        let proxy = provider_route_proxy_policy(&route).unwrap();
        assert_eq!(proxy.proxy_url, None);
        assert_eq!(proxy.source, "none");
        assert!(!proxy.bypassed);
        assert_eq!(proxy.target_host, "");

        let parsed: serde_json::Value =
            serde_json::from_str(&provider_route_json(&route, &proxy).unwrap()).unwrap();
        assert_eq!(parsed["providerId"], "omp");
        assert_eq!(parsed["label"], "OMP");
        assert_eq!(parsed["transport"], "native");
        assert_eq!(parsed["runtimeSupported"], false);
        assert_eq!(parsed["defaultModel"], "kimi-code/k3");
        assert_eq!(parsed["endpointUrl"], "");
        assert_eq!(parsed["envKeys"].as_array().unwrap().len(), 0);
        assert_eq!(parsed["proxyPolicy"]["proxyUrl"], serde_json::Value::Null);

        // Endpoint-bearing routes still parse their URL for a real proxy decision.
        let hosted = resolve_provider_route("ollama", None).unwrap();
        assert_eq!(
            provider_route_proxy_policy(&hosted).unwrap().target_host,
            "localhost"
        );
    }

    #[test]
    fn omp_capabilities_report_prompt_caching_without_session_memory() {
        let caching: serde_json::Value = serde_json::from_str(
            &provider_capability_json("omp", "prompt-caching", "kimi-code/k3").unwrap(),
        )
        .unwrap();
        assert_eq!(caching["providerId"], "omp");
        assert_eq!(caching["supported"], true);

        let memory: serde_json::Value = serde_json::from_str(
            &provider_capability_json("omp", "session-memory", "kimi-code/k3").unwrap(),
        )
        .unwrap();
        assert_eq!(memory["supported"], false);

        let tools: serde_json::Value = serde_json::from_str(
            &provider_capability_json("omp", "tool-calls", "kimi-code/k3").unwrap(),
        )
        .unwrap();
        assert_eq!(tools["supported"], true);

        // Every other provider keeps cross-turn session memory.
        let zai: serde_json::Value = serde_json::from_str(
            &provider_capability_json("zai", "session-memory", "glm-5").unwrap(),
        )
        .unwrap();
        assert_eq!(zai["supported"], true);
    }

    #[test]
    fn renders_provider_route_with_proxy_policy_as_json() {
        let route = resolve_provider_route("auto", Some("gpt-5.6-sol")).unwrap();
        let proxy = ProxyPolicy {
            target_host: "api.openai.com".to_string(),
            proxy_url: Some("http://user:secret@proxy.local:8080".to_string()),
            source: "HTTPS_PROXY".to_string(),
            bypassed: false,
            no_proxy: vec![".internal".to_string()],
        };
        let parsed: serde_json::Value =
            serde_json::from_str(&provider_route_json(&route, &proxy).unwrap()).unwrap();

        assert_eq!(parsed["providerId"], "openai");
        assert_eq!(parsed["defaultModel"], "gpt-5.6-sol");
        assert_eq!(
            parsed["proxyPolicy"]["proxyUrl"],
            "http://redacted@proxy.local:8080/"
        );
        assert!(!parsed.to_string().contains("secret"));
        assert_eq!(parsed["proxyPolicy"]["noProxy"][0], ".internal");
    }

    #[test]
    fn resolves_openai_compat_policy_for_core_compat_families() {
        let kimi = openai_compat_policy(
            "zai",
            "moonshotai/kimi-k2-instruct",
            Some("https://api.moonshot.ai/v1/chat/completions"),
        );
        assert_eq!(kimi.thinking_format, "zai");
        assert!(kimi.requires_assistant_content_for_tool_calls);
        assert!(kimi.requires_reasoning_content_for_tool_calls);
        assert!(!kimi.supports_reasoning_effort);

        let groq = openai_compat_policy("groq", "qwen/qwen3-32b", None);
        assert!(groq.supports_reasoning_effort);
        assert_eq!(groq.thinking_format, "qwen");

        let deepseek = openai_compat_policy("ollama", "deepseek-r1:8b", None);
        assert_eq!(deepseek.thinking_format, "deepseek");
        assert!(!deepseek.supports_tool_choice);
        assert!(deepseek.requires_reasoning_content_for_tool_calls);
    }

    #[test]
    fn renders_provider_runtime_decision() {
        let route = resolve_provider_route("auto", Some("gemini-2.5-pro")).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&provider_runtime_decision_json(&route).unwrap()).unwrap();
        assert_eq!(parsed["providerId"], "gemini");
        assert_eq!(parsed["runtimeSupported"], true);
        assert_eq!(parsed["runtimeKind"], "gemini");
        assert!(parsed["error"].is_null());

        let route = resolve_provider_route("ollama", None).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&provider_runtime_decision_json(&route).unwrap()).unwrap();
        assert_eq!(parsed["providerId"], "ollama");
        assert_eq!(parsed["runtimeSupported"], false);
        assert_eq!(parsed["runtimeKind"], "unsupported");
        assert_eq!(parsed["error"], "Unsupported runtime provider: ollama");
    }

    #[test]
    fn renders_provider_capability_support_as_json() {
        let openai: serde_json::Value = serde_json::from_str(
            &provider_capability_json("openai", "prompt-caching", "gpt-5.6-sol").unwrap(),
        )
        .unwrap();
        assert_eq!(openai["providerId"], "openai");
        assert_eq!(openai["capability"], "prompt-caching");
        assert_eq!(openai["modelId"], "gpt-5.6-sol");
        assert_eq!(openai["supported"], false);

        let anthropic: serde_json::Value = serde_json::from_str(
            &provider_capability_json("anthropic", "prompt-caching", "claude-sonnet-4-6").unwrap(),
        )
        .unwrap();
        assert_eq!(anthropic["providerId"], "anthropic");
        assert_eq!(anthropic["supported"], true);

        assert!(provider_capability_json("bogus", "tool-calls", "model").is_err());
    }

    #[test]
    fn provider_catalog_merges_active_custom_and_defaults() {
        let catalog = provider_model_catalog(
            "gemini",
            Some("gemini-2.5-pro"),
            Some("gemini-2.5-pro-exp,gemini-2.5-flash-lite-preview"),
        );
        assert_eq!(catalog.label, "Google Gemini");
        assert_eq!(catalog.models[0], "gemini-2.5-pro");
        assert!(catalog.models.contains(&"gemini-2.5-pro-exp".to_string()));
        assert!(catalog
            .models
            .contains(&"gemini-2.5-flash-lite-preview".to_string()));
    }

    #[test]
    fn openai_provider_catalog_includes_only_gpt_5_6_defaults() {
        let catalog = provider_model_catalog("openai", None, None);
        assert_eq!(
            catalog.models,
            ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
        );
    }

    #[test]
    fn omp_catalog_stays_pinned_to_k3_against_operator_model_env() {
        let pinned = provider_model_catalog("omp", None, None);
        assert_eq!(pinned.label, "OMP");
        assert_eq!(pinned.models, ["kimi-code/k3"]);

        // `OMP_MODEL` / `OMP_MODELS` must not widen or reorder a delegated route.
        let forced =
            provider_model_catalog("omp", Some("zai/glm-5"), Some("groq/openai/gpt-oss-20b"));
        assert_eq!(forced.models, ["kimi-code/k3"]);

        // Every other provider still honours the operator's active/custom models.
        let zai = provider_model_catalog("zai", Some("glm-4.6"), None);
        assert_eq!(zai.models[0], "glm-4.6");
    }
}
