use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_context_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid context command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/context");
    let panel_input = json!({
        "contextSummaryLines": array_field(&input, "contextSummaryLines"),
        "bridgeLines": array_field(&input, "bridgeLines"),
        "memoryLines": array_field(&input, "memoryLines"),
        "traceLines": array_field(&input, "traceLines"),
        "expanded": true,
    });
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("context", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid context panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": "Context opened." },
        ],
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

pub fn apply_auth_issue_lines_json(input_json: &str) -> Result<String, String> {
    let input: Value = if input_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(input_json)
            .map_err(|error| format!("Invalid auth issue context JSON: {error}"))?
    };
    let mut lines = Vec::new();
    for line in array_strings(&input, "authIssueLines") {
        lines.push(Value::String(line));
    }
    for line in array_strings(&input, "currentContextSummaryLines") {
        if !line.starts_with("Auth issue:") {
            lines.push(Value::String(line));
        }
    }
    serde_json::to_string(&json!({ "contextSummaryLines": lines }))
        .map_err(|error| error.to_string())
}

fn array_field(input: &Value, key: &str) -> Vec<Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn array_strings(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|lines| {
            lines
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_expanded_context_result() {
        let result = resolve_context_command_json(
            r#"{
                "line": "/context",
                "contextSummaryLines": ["Loaded guidance: AGENTS.md"],
                "bridgeLines": ["bridge ready"],
                "memoryLines": ["memory ready"],
                "traceLines": ["trace ready"]
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][1]["text"], "Context opened.");
        assert_eq!(parsed["panel"]["title"], "Context expanded");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Loaded guidance")));
    }

    #[test]
    fn applies_auth_issue_lines_to_context_summary() {
        let result = apply_auth_issue_lines_json(
            r#"{
                "currentContextSummaryLines": [
                    "Auth issue: stale oauth",
                    "Loaded guidance: AGENTS.md",
                    "Other note"
                ],
                "authIssueLines": ["Auth issue: saved OAuth needs refresh."]
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["contextSummaryLines"],
            json!([
                "Auth issue: saved OAuth needs refresh.",
                "Loaded guidance: AGENTS.md",
                "Other note"
            ])
        );
    }
}
