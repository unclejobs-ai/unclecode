use serde_json::{json, Value};
use std::collections::HashSet;

pub fn provider_tool_dispatch_plan_json(
    provider: &str,
    actions_json: &str,
    handler_names_json: &str,
) -> Result<String, String> {
    match provider {
        "openai" | "deepseek" | "anthropic" | "gemini" => {}
        _ => return Err(
            "Usage: unclecode rust provider tool-dispatch-plan <openai|deepseek|anthropic|gemini>"
                .to_string(),
        ),
    }

    let actions = parse_array(actions_json, "actions")?;
    let handler_names = parse_handler_names(handler_names_json)?;
    let mut dispatches = Vec::new();
    let mut outcomes = Vec::new();

    for action in actions {
        let Some(action) = action.as_object() else {
            continue;
        };
        let tool = action
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let call_id = action
            .get("callId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if tool.is_empty() || call_id.is_empty() {
            continue;
        }

        if handler_names.contains(tool) {
            dispatches.push(json!({
                "callId": call_id,
                "tool": tool,
                "input": action.get("input").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({}))
            }));
        } else {
            outcomes.push(json!({
                "toolName": tool,
                "toolCallId": call_id,
                "kind": "error",
                "isError": true,
                "content": format!("Unknown tool: {tool}")
            }));
        }
    }

    serde_json::to_string(&json!({
        "provider": provider,
        "dispatches": dispatches,
        "outcomes": outcomes
    }))
    .map_err(|error| error.to_string())
}

fn parse_array(source: &str, name: &str) -> Result<Vec<Value>, String> {
    let input = if source.trim().is_empty() {
        "[]"
    } else {
        source
    };
    let parsed = serde_json::from_str::<Value>(input)
        .map_err(|error| format!("Invalid {name} JSON: {error}"))?;
    parsed
        .as_array()
        .cloned()
        .ok_or_else(|| format!("{name} JSON must be an array"))
}

fn parse_handler_names(source: &str) -> Result<HashSet<String>, String> {
    Ok(parse_array(source, "handler names")?
        .into_iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_dispatches_and_unknown_tool_outcomes() {
        let raw = provider_tool_dispatch_plan_json(
            "openai",
            r#"[
                {"callId":"call_1","tool":"read_file","input":{"path":"README.md"}},
                {"callId":"call_2","tool":"missing","input":{}},
                {"callId":"","tool":"ignored","input":{}}
            ]"#,
            r#"["read_file"]"#,
        )
        .expect("plan");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["dispatches"].as_array().expect("array").len(), 1);
        assert_eq!(parsed["dispatches"][0]["tool"], "read_file");
        assert_eq!(parsed["outcomes"].as_array().expect("array").len(), 1);
        assert_eq!(parsed["outcomes"][0]["content"], "Unknown tool: missing");
    }
}
