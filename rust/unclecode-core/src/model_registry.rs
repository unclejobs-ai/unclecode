use crate::http_transport::ProxyPolicy;
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

const OPENAI_DEFAULT_MODEL: &str = "gpt-5.5";
const OPENAI_DEFAULT_MODELS: &[&str] = &[
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "o4-mini",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-4o-mini",
    "gpt-4o",
];

const COMPAT_OPENAI_MODELS: &[&str] = &[
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "o4-mini",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-4o-mini",
    "gpt-4o",
];
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
const RUNTIME_SUPPORTED_PROVIDERS: &[&str] = &["anthropic", "gemini", "openai"];

pub fn openai_reasoning_support(model_id: &str) -> ReasoningSupport {
    let normalized = model_id.trim().to_ascii_lowercase();
    if normalized.starts_with("gpt-5") || normalized.starts_with("o4") {
        return ReasoningSupport {
            status: "supported".to_string(),
            default_effort: Some("medium".to_string()),
            supported_efforts: vec!["low".to_string(), "medium".to_string(), "high".to_string()],
        };
    }

    ReasoningSupport {
        status: "unsupported".to_string(),
        default_effort: None,
        supported_efforts: Vec::new(),
    }
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

pub fn provider_route_json(route: &ProviderRoute, proxy: &ProxyPolicy) -> Result<String, String> {
    serde_json::to_string(&json!({
        "providerId": route.provider_id,
        "label": route.label,
        "transport": route.transport,
        "runtimeSupported": route.runtime_supported,
        "defaultModel": route.default_model,
        "endpointUrl": route.endpoint_url,
        "envKeys": route.env_keys,
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
        "gemini" => "Google Gemini",
        "groq" => "Groq",
        "ollama" => "Ollama",
        "copilot" => "GitHub Copilot",
        "zai" => "z.ai",
        other => other,
    }
    .to_string()
}

fn is_known_provider(provider_id: &str) -> bool {
    matches!(
        provider_id,
        "anthropic" | "gemini" | "openai" | "groq" | "ollama" | "copilot" | "zai"
    )
}

fn provider_transport(provider_id: &str) -> &'static str {
    match provider_id {
        "anthropic" | "gemini" | "openai" => "native",
        _ => "compat",
    }
}

fn provider_supports_capability(provider_id: &str, capability: &str) -> bool {
    match capability {
        "tool-calls" => true,
        "session-memory" => true,
        "prompt-caching" => provider_id == "anthropic",
        _ => provider_id == "openai",
    }
}

fn provider_env_keys(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "anthropic" => &["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
        "gemini" => &["GEMINI_API_KEY", "GEMINI_MODEL"],
        "openai" => &["OPENAI_API_KEY", "OPENAI_MODEL"],
        "groq" => &["GROQ_API_KEY", "GROQ_MODEL"],
        "ollama" => &["OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_API_KEY"],
        "copilot" => &["COPILOT_TOKEN", "COPILOT_MODEL"],
        "zai" => &["ZAI_API_KEY", "ZAI_MODEL"],
        _ => &[],
    }
}

fn provider_endpoint_url(provider_id: &str) -> &'static str {
    match provider_id {
        "anthropic" => "https://api.anthropic.com/v1/messages",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/models",
        "openai" => "https://api.openai.com/v1/responses",
        "groq" => "https://api.groq.com/openai/v1/chat/completions",
        "ollama" => "http://localhost:11434/api/chat",
        "copilot" => "https://api.githubcopilot.com/chat/completions",
        "zai" => "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        _ => "",
    }
}

pub fn provider_model_catalog(
    provider_id: &str,
    active_model: Option<&str>,
    custom_models: Option<&str>,
) -> CompatProviderCatalog {
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
        "gemini" => COMPAT_GEMINI_MODELS,
        "groq" => COMPAT_GROQ_MODELS,
        "ollama" => COMPAT_OLLAMA_MODELS,
        "copilot" => COMPAT_COPILOT_MODELS,
        "zai" => COMPAT_ZAI_MODELS,
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
        let registry = openai_model_registry(Some("gpt-5.4"));
        assert_eq!(registry.provider_id, "openai");
        assert_eq!(registry.default_model, "gpt-5.5");
        assert_eq!(
            &registry.models[..5],
            &[
                "gpt-5.4",
                "gpt-5.5",
                "gpt-5.4-mini",
                "o4-mini",
                "gpt-4.1-mini"
            ]
        );
    }

    #[test]
    fn openai_reasoning_support_matches_frontier_families() {
        assert_eq!(openai_reasoning_support("gpt-5.4").status, "supported");
        assert_eq!(
            openai_reasoning_support("o4-mini")
                .default_effort
                .as_deref(),
            Some("medium")
        );
        assert_eq!(
            openai_reasoning_support("gpt-4.1-mini").status,
            "unsupported"
        );
    }

    #[test]
    fn detects_provider_from_model_family() {
        assert_eq!(detect_provider_for_model("Claude-Sonnet"), "anthropic");
        assert_eq!(detect_provider_for_model("Gemini-3.1"), "gemini");
        assert_eq!(detect_provider_for_model("gpt-5.4"), "openai");
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

        let openai_route = resolve_provider_route("auto", Some("gpt-5.5")).unwrap();
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
    fn renders_provider_route_with_proxy_policy_as_json() {
        let route = resolve_provider_route("auto", Some("gpt-5.5")).unwrap();
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
        assert_eq!(parsed["defaultModel"], "gpt-5.5");
        assert_eq!(
            parsed["proxyPolicy"]["proxyUrl"],
            "http://redacted@proxy.local:8080/"
        );
        assert!(!parsed.to_string().contains("secret"));
        assert_eq!(parsed["proxyPolicy"]["noProxy"][0], ".internal");
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
            &provider_capability_json("openai", "prompt-caching", "gpt-5.5").unwrap(),
        )
        .unwrap();
        assert_eq!(openai["providerId"], "openai");
        assert_eq!(openai["capability"], "prompt-caching");
        assert_eq!(openai["modelId"], "gpt-5.5");
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
    fn openai_provider_catalog_includes_frontier_defaults() {
        let catalog = provider_model_catalog("openai", None, None);
        assert_eq!(catalog.models[0], "gpt-5.5");
        assert!(catalog.models.contains(&"gpt-5.4-mini".to_string()));
    }
}
