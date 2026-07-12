use crate::model_registry::{is_openai_reasoning_effort, openai_reasoning_support};
use serde_json::json;

pub fn resolve_app_reasoning_effort(
    provider: &str,
    model: &str,
    mode: &str,
    override_effort: Option<&str>,
) -> Option<String> {
    let provider = provider.trim();
    if provider != "openai" {
        return None;
    }

    let support = openai_reasoning_support(model);
    if support.status == "unsupported" {
        return None;
    }

    let override_effort = override_effort
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")
        .filter(|value| is_openai_reasoning_effort(value));
    Some(
        override_effort
            .unwrap_or_else(|| mode_default_reasoning(mode))
            .to_string(),
    )
}

pub fn resolve_app_reasoning_config_json(
    provider: &str,
    model: &str,
    mode: &str,
    override_effort: Option<&str>,
) -> Result<String, String> {
    let provider = provider.trim();
    if provider != "openai" {
        return serde_json::to_string(&json!({
            "effort": "unsupported",
            "source": "model-capability",
            "support": {
                "status": "unsupported",
                "supportedEfforts": [],
            },
        }))
        .map_err(|error| error.to_string());
    }

    let support = openai_reasoning_support(model);
    if support.status == "unsupported" {
        return serde_json::to_string(&json!({
            "effort": "unsupported",
            "source": "model-capability",
            "support": {
                "status": support.status,
                "supportedEfforts": support.supported_efforts,
            },
        }))
        .map_err(|error| error.to_string());
    }

    let normalized_override = override_effort
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")
        .filter(|value| is_openai_reasoning_effort(value));
    let effort = resolve_app_reasoning_effort(provider, model, mode, override_effort)
        .unwrap_or_else(|| mode_default_reasoning(mode).to_string());
    let source = if normalized_override.is_some() {
        "override"
    } else {
        "mode-default"
    };

    serde_json::to_string(&json!({
        "effort": effort,
        "source": source,
        "support": {
            "status": support.status,
            "defaultEffort": support.default_effort,
            "supportedEfforts": support.supported_efforts,
        },
    }))
    .map_err(|error| error.to_string())
}

fn mode_default_reasoning(mode: &str) -> &'static str {
    match mode.trim() {
        "ultrawork" | "analyze" | "plan" => "high",
        "search" => "low",
        "default" | "yolo" | "build" => "medium",
        _ => "medium",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn resolves_openai_mode_default_reasoning() {
        let parsed: Value = serde_json::from_str(
            &resolve_app_reasoning_config_json("openai", "gpt-5.6-sol", "ultrawork", None).unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["effort"], "high");
        assert_eq!(parsed["source"], "mode-default");
        assert_eq!(parsed["support"]["status"], "supported");
        assert_eq!(parsed["support"]["defaultEffort"], "medium");
    }

    #[test]
    fn resolves_override_reasoning() {
        let parsed: Value = serde_json::from_str(
            &resolve_app_reasoning_config_json("openai", "gpt-5.6-terra", "search", Some("xhigh"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["effort"], "xhigh");
        assert_eq!(parsed["source"], "override");
    }

    #[test]
    fn disables_reasoning_for_unsupported_models_and_providers() {
        let parsed: Value = serde_json::from_str(
            &resolve_app_reasoning_config_json("openai", "gpt-4.1-mini", "analyze", None).unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["effort"], "unsupported");
        assert_eq!(parsed["source"], "model-capability");

        let parsed: Value = serde_json::from_str(
            &resolve_app_reasoning_config_json("gemini", "gemini-2.5-pro", "analyze", None)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["effort"], "unsupported");
        assert_eq!(parsed["support"]["status"], "unsupported");
    }
}
