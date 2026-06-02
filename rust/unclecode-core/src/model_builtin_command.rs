use crate::model_command::resolve_model_command_json;
use serde_json::{json, Value};

pub fn resolve_model_builtin_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid model builtin command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/model");

    let model_result = serde_json::from_str::<Value>(&resolve_model_command_json(
        &json!({
            "input": line,
            "provider": input.get("provider").and_then(Value::as_str).unwrap_or("openai"),
            "currentModel": input.get("currentModel").and_then(Value::as_str).unwrap_or("unknown"),
            "currentReasoning": input.get("currentReasoning").cloned().unwrap_or(Value::Null),
            "modeDefaultReasoning": input.get("modeDefaultReasoning").cloned().unwrap_or(Value::Null),
        })
        .to_string(),
    )?)
    .map_err(|error| format!("Invalid model command result JSON: {error}"))?;

    let next_model = model_result
        .get("nextModel")
        .cloned()
        .ok_or_else(|| "Model command result is missing nextModel.".to_string())?;
    let next_reasoning = model_result
        .get("nextReasoning")
        .cloned()
        .ok_or_else(|| "Model command result is missing nextReasoning.".to_string())?;
    let message = model_result
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Model command handled.")
        .to_string();
    let panel = model_result
        .get("panel")
        .cloned()
        .ok_or_else(|| "Model command result is missing panel.".to_string())?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": message },
        ],
        "nextModel": next_model,
        "nextReasoning": next_reasoning,
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_model_result_with_entries_and_panel() {
        let result = resolve_model_builtin_command_json(
            r#"{
                "line": "/model gpt-4.1-mini",
                "provider": "openai",
                "currentModel": "gpt-5.4",
                "currentReasoning": {"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},
                "modeDefaultReasoning": {"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["entries"][1]["text"],
            "Model set to gpt-4.1-mini. Reasoning unsupported."
        );
        assert_eq!(parsed["nextModel"], "gpt-4.1-mini");
        assert_eq!(parsed["nextReasoning"]["effort"], "unsupported");
        assert_eq!(parsed["panel"]["title"], "Model picker");
    }
}
