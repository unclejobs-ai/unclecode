use crate::model_registry::{openai_reasoning_support, provider_model_catalog};
use crate::ux_model::build_model_panel_json;
use serde_json::{json, Map, Value};

pub fn resolve_model_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid model command JSON: {error}"))?;
    let provider = str_field(&input, "provider").unwrap_or("openai");
    let raw_line = str_field(&input, "input").unwrap_or_default();
    let current_model = str_field(&input, "currentModel").unwrap_or("unknown");
    let current_reasoning = input.get("currentReasoning").cloned().unwrap_or_else(|| {
        json!({"effort":"unsupported","source":"model-capability","support":{"status":"unsupported","supportedEfforts":[]}})
    });
    let mode_default_reasoning = input
        .get("modeDefaultReasoning")
        .cloned()
        .unwrap_or_else(|| current_reasoning.clone());
    let normalized = normalize_model_command(raw_line);
    let models = provider_model_catalog(provider, Some(current_model), None).models;

    let (next_model, next_reasoning, message) =
        if normalized == "/model" || normalized == "/model list" {
            (
                current_model.to_string(),
                current_reasoning.clone(),
                "Model choices shown.".to_string(),
            )
        } else if !normalized.starts_with("/model ") {
            (
                current_model.to_string(),
                current_reasoning.clone(),
                "Usage: /model <name>".to_string(),
            )
        } else {
            let candidate = normalized["/model ".len()..].trim();
            if candidate.is_empty() {
                (
                    current_model.to_string(),
                    current_reasoning.clone(),
                    "Usage: /model <name>".to_string(),
                )
            } else if !models.iter().any(|model| model == candidate) {
                (
                    current_model.to_string(),
                    current_reasoning.clone(),
                    format!("No model match for {candidate}. Current model unchanged."),
                )
            } else {
                let next_reasoning = resolve_reasoning_for_model(
                    provider,
                    candidate,
                    &current_reasoning,
                    &mode_default_reasoning,
                );
                let message = if reasoning_status(&next_reasoning) == "unsupported" {
                    format!("Model set to {candidate}. Reasoning unsupported.")
                } else {
                    format!(
                        "Model set to {candidate}. Reasoning {}.",
                        str_field(&next_reasoning, "effort").unwrap_or("unsupported")
                    )
                };
                (candidate.to_string(), next_reasoning, message)
            }
        };

    let panel_input = json!({
        "provider": provider,
        "currentModel": next_model,
        "currentReasoning": next_reasoning,
        "models": models,
    });
    let panel = serde_json::from_str::<Value>(&build_model_panel_json(&panel_input.to_string())?)
        .map_err(|error| format!("Invalid model panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "nextModel": next_model,
        "nextReasoning": next_reasoning,
        "message": message,
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

fn resolve_reasoning_for_model(
    provider: &str,
    model: &str,
    current_reasoning: &Value,
    mode_default_reasoning: &Value,
) -> Value {
    let support = reasoning_support_value(provider, model);
    if reasoning_status(&support) == "unsupported" {
        return merge_reasoning_fields(
            current_reasoning,
            "unsupported",
            "model-capability",
            support,
        );
    }

    let supported_efforts = support
        .get("supportedEfforts")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let current_effort = str_field(current_reasoning, "effort")
        .filter(|effort| matches!(*effort, "low" | "medium" | "high"));
    let can_keep_current = current_effort
        .map(|effort| supported_efforts.contains(&effort))
        .unwrap_or(false);
    let mode_default_effort = str_field(mode_default_reasoning, "effort")
        .filter(|effort| *effort != "unsupported")
        .filter(|_| reasoning_status(mode_default_reasoning) == "supported");
    let support_default = str_field(&support, "defaultEffort").map(str::to_string);
    let next_effort = if can_keep_current {
        current_effort.unwrap_or("medium")
    } else {
        mode_default_effort
            .or(support_default.as_deref())
            .unwrap_or("medium")
    };
    let next_source =
        if can_keep_current && str_field(current_reasoning, "source") == Some("override") {
            "override"
        } else {
            "mode-default"
        };

    merge_reasoning_fields(mode_default_reasoning, next_effort, next_source, support)
}

fn reasoning_support_value(provider: &str, model: &str) -> Value {
    if provider != "openai" {
        return json!({"status":"unsupported","supportedEfforts":[]});
    }
    let support = openai_reasoning_support(model);
    match support.status.as_str() {
        "supported" => json!({
            "status": "supported",
            "defaultEffort": support.default_effort.unwrap_or_else(|| "medium".to_string()),
            "supportedEfforts": support.supported_efforts,
        }),
        _ => json!({"status":"unsupported","supportedEfforts":[]}),
    }
}

fn merge_reasoning_fields(base: &Value, effort: &str, source: &str, support: Value) -> Value {
    let mut object = base.as_object().cloned().unwrap_or_else(Map::new);
    object.insert("effort".to_string(), Value::String(effort.to_string()));
    object.insert("source".to_string(), Value::String(source.to_string()));
    object.insert("support".to_string(), support);
    Value::Object(object)
}

fn reasoning_status(value: &Value) -> &str {
    value
        .get("support")
        .and_then(|support| str_field(support, "status"))
        .or_else(|| str_field(value, "status"))
        .unwrap_or("unsupported")
}

fn normalize_model_command(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_model_choices_without_changing_state() {
        let result = resolve_model_command_json(
            r#"{
                "input": "/model",
                "provider": "openai",
                "currentModel": "gpt-5.4",
                "currentReasoning": {"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextModel"], "gpt-5.4");
        assert_eq!(parsed["nextReasoning"]["effort"], "high");
        assert_eq!(parsed["message"], "Model choices shown.");
        assert_eq!(parsed["panel"]["title"], "Model picker");
    }

    #[test]
    fn switches_model_and_keeps_supported_override() {
        let result = resolve_model_command_json(
            r#"{
                "input": "/model gpt-5.5",
                "provider": "openai",
                "currentModel": "gpt-5.4",
                "currentReasoning": {"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextModel"], "gpt-5.5");
        assert_eq!(parsed["nextReasoning"]["effort"], "high");
        assert_eq!(parsed["nextReasoning"]["source"], "override");
        assert_eq!(parsed["message"], "Model set to gpt-5.5. Reasoning high.");
    }

    #[test]
    fn switches_unsupported_model_to_model_capability() {
        let result = resolve_model_command_json(
            r#"{
                "input": "/model gpt-4.1-mini",
                "provider": "openai",
                "currentModel": "gpt-5.4",
                "currentReasoning": {"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextModel"], "gpt-4.1-mini");
        assert_eq!(parsed["nextReasoning"]["effort"], "unsupported");
        assert_eq!(parsed["nextReasoning"]["source"], "model-capability");
        assert_eq!(
            parsed["message"],
            "Model set to gpt-4.1-mini. Reasoning unsupported."
        );
    }

    #[test]
    fn rejects_unknown_model_without_changing_runtime_state() {
        let result = resolve_model_command_json(
            r#"{
                "input": "/model gkdl",
                "provider": "openai",
                "currentModel": "gpt-5.4",
                "currentReasoning": {"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextModel"], "gpt-5.4");
        assert_eq!(parsed["nextReasoning"]["effort"], "high");
        assert_eq!(
            parsed["message"],
            "No model match for gkdl. Current model unchanged."
        );
        let lines = parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!lines.contains("gkdl"));
    }
}
