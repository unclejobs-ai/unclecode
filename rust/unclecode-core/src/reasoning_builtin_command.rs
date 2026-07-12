use crate::reasoning_command::resolve_reasoning_command_json;
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

    let panel = build_reasoning_picker_panel(&next_reasoning);

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

fn build_reasoning_picker_panel(reasoning: &Value) -> Value {
    let effort = reasoning
        .get("effort")
        .and_then(Value::as_str)
        .unwrap_or("unsupported");
    let current = humanize_reasoning_effort(effort);
    let supported = reasoning
        .get("support")
        .and_then(|support| support.get("supportedEfforts"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut lines = vec![
        format!("Current · {current}"),
        "Choose thinking depth".to_string(),
    ];
    for supported_effort in supported {
        let marker = if supported_effort == effort {
            "›"
        } else {
            " "
        };
        lines.push(format!(
            "{marker} /reasoning {supported_effort}  {} · {}",
            humanize_reasoning_effort(supported_effort),
            reasoning_effort_description(supported_effort)
        ));
    }
    lines.push("  /reasoning default  Mode default · follow the current work mode".to_string());
    json!({
        "title": "Reasoning picker",
        "lines": lines,
    })
}

fn humanize_reasoning_effort(effort: &str) -> &'static str {
    match effort {
        "none" => "None",
        "low" => "Light",
        "medium" => "Balanced",
        "high" => "Deep",
        "xhigh" => "Very deep",
        "max" => "Maximum",
        "default" => "Mode default",
        _ => "Reasoning fixed",
    }
}

fn reasoning_effort_description(effort: &str) -> &'static str {
    match effort {
        "none" => "lowest latency",
        "low" => "fast checks",
        "medium" => "steady default",
        "high" => "hard changes",
        "xhigh" => "deep research and review",
        "max" => "maximum reasoning depth",
        _ => "fixed for this model",
    }
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
        assert_eq!(parsed["entries"][1]["text"], "Reasoning · Light selected.");
        assert_eq!(parsed["nextReasoning"]["effort"], "low");
        assert_eq!(parsed["nextReasoning"]["source"], "override");
        assert_eq!(parsed["panel"]["title"], "Reasoning picker");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Current · Light")));
    }
}
