use crate::model_registry::{openai_reasoning_support, provider_label, provider_model_catalog};
use serde_json::{json, Value};

pub fn build_model_panel_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid model panel JSON: {error}"))?;
    serde_json::to_string(&model_panel(&input)).map_err(|error| error.to_string())
}

fn model_panel(input: &Value) -> Value {
    let provider = str_field(input, "provider").unwrap_or("openai");
    let current_model = str_field(input, "currentModel").unwrap_or("unknown");
    let models = input
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|model| !model.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|models| !models.is_empty())
        .unwrap_or_else(|| provider_model_catalog(provider, Some(current_model), None).models);
    let current_support = model_reasoning_support(provider, current_model);
    let mut lines = vec![
        "Current model".to_string(),
        format!("Provider · {}", provider_label(provider)),
        format!("Model · {current_model}"),
        format!(
            "Thinking · {}",
            describe_panel_reasoning(input.get("currentReasoning"), &current_support)
        ),
        format_reasoning_choice_line(&current_support),
        format!("Available · {} models", models.len()),
        String::new(),
        "Catalog".to_string(),
    ];

    lines.extend(models.iter().take(6).map(|model| {
        let support = model_reasoning_support(provider, model);
        let active = model == current_model;
        format!(
            "{} /model {}  {}",
            if active { "›" } else { " " },
            model,
            format_model_panel_support_label(active, &support)
        )
    }));
    lines.extend([
        String::new(),
        "Controls".to_string(),
        "Type filter · /model <name> [none|low|medium|high|xhigh|max|default] · Esc close"
            .to_string(),
    ]);

    json!({ "title": "Model picker", "lines": lines })
}

fn format_reasoning_choice_line(support: &ReasoningPanelSupport) -> String {
    if support.status == "unsupported" {
        return "Thinking choices · unavailable for this model".to_string();
    }
    let choices = if support.supported_efforts.is_empty() {
        "low / medium / high".to_string()
    } else {
        support.supported_efforts.join(" / ")
    };
    format!("Thinking choices · {choices} / default")
}

struct ReasoningPanelSupport {
    status: String,
    default_effort: Option<String>,
    supported_efforts: Vec<String>,
}

fn model_reasoning_support(provider: &str, model: &str) -> ReasoningPanelSupport {
    if provider != "openai" {
        return ReasoningPanelSupport {
            status: "unsupported".to_string(),
            default_effort: None,
            supported_efforts: Vec::new(),
        };
    }
    let support = openai_reasoning_support(model);
    ReasoningPanelSupport {
        status: support.status,
        default_effort: support.default_effort,
        supported_efforts: support.supported_efforts,
    }
}

fn format_model_panel_support_label(active: bool, support: &ReasoningPanelSupport) -> String {
    if support.status == "unsupported" {
        return if active {
            "active · reasoning unavailable".to_string()
        } else {
            "reasoning unavailable".to_string()
        };
    }
    let effort = support.default_effort.as_deref().unwrap_or("medium");
    let support_label = if support.supported_efforts.is_empty() {
        "low/medium/high".to_string()
    } else {
        support.supported_efforts.join("/")
    };
    if active {
        format!("active · reasoning {effort} · {support_label}")
    } else {
        format!("reasoning {effort} · {support_label}")
    }
}

fn describe_panel_reasoning(reasoning: Option<&Value>, support: &ReasoningPanelSupport) -> String {
    let Some(reasoning) = reasoning else {
        return if support.status == "unsupported" {
            "unsupported".to_string()
        } else {
            format!(
                "{} (mode default)",
                support.default_effort.as_deref().unwrap_or("medium")
            )
        };
    };
    let effort = str_field(reasoning, "effort").unwrap_or("unsupported");
    let source = str_field(reasoning, "source").unwrap_or("mode-default");
    let reasoning_status = reasoning
        .get("support")
        .and_then(|support| str_field(support, "status"))
        .unwrap_or(&support.status);
    if reasoning_status == "unsupported" || effort == "unsupported" {
        return "unsupported".to_string();
    }
    format!("{effort} ({})", source.replace('-', " "))
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_model_panel_with_current_reasoning_and_choices() {
        let output = build_model_panel_json(
            r#"{
                "provider":"openai",
                "currentModel":"gpt-5.6-sol",
                "currentReasoning":{
                    "effort":"xhigh",
                    "source":"override",
                    "support":{"status":"supported"}
                },
                "models":["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"]
            }"#,
        )
        .expect("json");
        let parsed: Value = serde_json::from_str(&output).expect("parsed");
        let lines = parsed
            .get("lines")
            .and_then(Value::as_array)
            .expect("lines")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            parsed.get("title").and_then(Value::as_str),
            Some("Model picker")
        );
        assert!(lines.contains("Current model"));
        assert!(lines.contains("Catalog"));
        assert!(lines.contains("Provider · OpenAI"));
        assert!(lines.contains("Available · 3 models"));
        assert!(lines.contains("Thinking · xhigh (override)"));
        assert!(
            lines.contains("Thinking choices · none / low / medium / high / xhigh / max / default")
        );
        assert!(lines.contains(
            "› /model gpt-5.6-sol  active · reasoning medium · none/low/medium/high/xhigh/max"
        ));
        assert!(lines
            .contains(" /model gpt-5.6-terra  reasoning medium · none/low/medium/high/xhigh/max"));
        assert!(lines.contains(
            "Type filter · /model <name> [none|low|medium|high|xhigh|max|default] · Esc close"
        ));
    }
}
