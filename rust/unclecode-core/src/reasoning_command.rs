use serde_json::{json, Map, Value};

pub fn resolve_reasoning_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid reasoning command JSON: {error}"))?;
    let raw_line = str_field(&input, "input").unwrap_or_default();
    let current_reasoning = input.get("currentReasoning").cloned().unwrap_or_else(|| {
        json!({"effort":"unsupported","source":"model-capability","support":{"status":"unsupported","supportedEfforts":[]}})
    });
    let mode_default_reasoning = input
        .get("modeDefaultReasoning")
        .cloned()
        .unwrap_or_else(|| current_reasoning.clone());

    let (next_reasoning, message) = if reasoning_status(&current_reasoning) == "unsupported" {
        (
            current_reasoning,
            "Reasoning controls are visible, but this model does not support them.".to_string(),
        )
    } else if let Some(command) = reasoning_command_value(raw_line) {
        if command == "default" {
            let effort = str_field(&mode_default_reasoning, "effort")
                .unwrap_or("unsupported")
                .to_string();
            (
                mode_default_reasoning,
                format!("Reasoning reset to {effort}."),
            )
        } else {
            let supported_efforts = supported_efforts(&current_reasoning);
            if supported_efforts.iter().any(|effort| effort == command) {
                (
                    merge_reasoning_fields(&current_reasoning, command, "override"),
                    format!("Reasoning set to {command}."),
                )
            } else {
                (
                    current_reasoning,
                    format!(
                        "Unsupported reasoning value: {command}. Use one of {} or default.",
                        supported_efforts.join(", ")
                    ),
                )
            }
        }
    } else {
        let effort = str_field(&current_reasoning, "effort")
            .unwrap_or("unsupported")
            .to_string();
        let supported_efforts = supported_efforts(&current_reasoning);
        (
            current_reasoning,
            format!(
                "Reasoning is {effort}. Supported: {}.",
                supported_efforts.join(", ")
            ),
        )
    };

    serde_json::to_string(&json!({
        "nextReasoning": next_reasoning,
        "message": message,
    }))
    .map_err(|error| error.to_string())
}

fn reasoning_command_value(input: &str) -> Option<&str> {
    let mut parts = input.split_whitespace();
    parts.next()?;
    parts.next()
}

fn supported_efforts(reasoning: &Value) -> Vec<String> {
    reasoning
        .get("support")
        .and_then(|support| support.get("supportedEfforts"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn merge_reasoning_fields(base: &Value, effort: &str, source: &str) -> Value {
    let mut object = base.as_object().cloned().unwrap_or_else(Map::new);
    object.insert("effort".to_string(), Value::String(effort.to_string()));
    object.insert("source".to_string(), Value::String(source.to_string()));
    Value::Object(object)
}

fn reasoning_status(value: &Value) -> &str {
    value
        .get("support")
        .and_then(|support| str_field(support, "status"))
        .unwrap_or("unsupported")
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_current_supported_reasoning() {
        let result = resolve_reasoning_command_json(
            r#"{
                "input": "/reasoning",
                "currentReasoning": {"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextReasoning"]["effort"], "high");
        assert_eq!(
            parsed["message"],
            "Reasoning is high. Supported: low, medium, high."
        );
    }

    #[test]
    fn applies_override_and_default_reset() {
        let result = resolve_reasoning_command_json(
            r#"{
                "input": "/reasoning low",
                "currentReasoning": {"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextReasoning"]["effort"], "low");
        assert_eq!(parsed["nextReasoning"]["source"], "override");
        assert_eq!(parsed["message"], "Reasoning set to low.");

        let result = resolve_reasoning_command_json(
            r#"{
                "input": "/reasoning default",
                "currentReasoning": {"effort":"low","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextReasoning"]["effort"], "medium");
        assert_eq!(parsed["nextReasoning"]["source"], "mode-default");
        assert_eq!(parsed["message"], "Reasoning reset to medium.");
    }

    #[test]
    fn rejects_unsupported_values_and_unsupported_models() {
        let result = resolve_reasoning_command_json(
            r#"{
                "input": "/reasoning extreme",
                "currentReasoning": {"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextReasoning"]["effort"], "high");
        assert_eq!(
            parsed["message"],
            "Unsupported reasoning value: extreme. Use one of low, medium, high or default."
        );

        let result = resolve_reasoning_command_json(
            r#"{
                "input": "/reasoning high",
                "currentReasoning": {"effort":"unsupported","source":"model-capability","support":{"status":"unsupported","supportedEfforts":[]}},
                "modeDefaultReasoning": {"effort":"unsupported","source":"model-capability","support":{"status":"unsupported","supportedEfforts":[]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["nextReasoning"]["effort"], "unsupported");
        assert_eq!(
            parsed["message"],
            "Reasoning controls are visible, but this model does not support them."
        );
    }
}
