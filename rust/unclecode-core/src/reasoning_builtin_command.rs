use crate::reasoning_command::resolve_reasoning_command_json;
use crate::status_command::build_status_panel_input;
use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_reasoning_builtin_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid reasoning builtin command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/reasoning");

    let reasoning_result = serde_json::from_str::<Value>(&resolve_reasoning_command_json(
        &json!({
            "input": line,
            "currentReasoning": input.get("currentReasoning").cloned().unwrap_or(Value::Null),
            "modeDefaultReasoning": input.get("modeDefaultReasoning").cloned().unwrap_or(Value::Null),
        })
        .to_string(),
    )?)
    .map_err(|error| format!("Invalid reasoning command result JSON: {error}"))?;
    let next_reasoning = reasoning_result
        .get("nextReasoning")
        .cloned()
        .ok_or_else(|| "Reasoning command result is missing nextReasoning.".to_string())?;
    let message = reasoning_result
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Reasoning updated.")
        .to_string();

    let mut panel_input = input.clone();
    if let Some(object) = panel_input.as_object_mut() {
        object.insert(
            "reasoningLabel".to_string(),
            Value::String(describe_reasoning(&next_reasoning)),
        );
    }
    let panel_input = build_status_panel_input(&panel_input)?;
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("status", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid reasoning status panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": message },
        ],
        "nextReasoning": next_reasoning,
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

fn describe_reasoning(reasoning: &Value) -> String {
    if reasoning
        .get("support")
        .and_then(|support| support.get("status"))
        .and_then(Value::as_str)
        == Some("unsupported")
    {
        return "unsupported".to_string();
    }
    let effort = reasoning
        .get("effort")
        .and_then(Value::as_str)
        .unwrap_or("unsupported");
    let source = reasoning
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("{effort} ({source})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_reasoning_result_with_status_panel() {
        let result = resolve_reasoning_builtin_command_json(
            r#"{
                "line": "/reasoning low",
                "provider": "openai",
                "model": "gpt-5.4",
                "mode": "default",
                "cwd": "/repo",
                "authLabel": "api-key-env",
                "currentReasoning": {"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "contextSummaryLines": ["Loaded guidance: AGENTS.md"],
                "bridgeLines": ["bridge ready"],
                "memoryLines": [],
                "traceLines": []
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][1]["text"], "Reasoning set to low.");
        assert_eq!(parsed["nextReasoning"]["effort"], "low");
        assert_eq!(parsed["nextReasoning"]["source"], "override");
        assert_eq!(parsed["panel"]["title"], "Session status");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line
                .as_str()
                .unwrap_or("")
                .contains("Reasoning · low (override)")));
    }
}
