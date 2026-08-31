use crate::provider_loop::provider_loop_decision;
use crate::provider_trace::provider_tool_result_turn_entries_json;
use serde_json::{json, Value};

pub fn provider_turn_step_json(
    provider: &str,
    iteration: usize,
    max_iterations: usize,
    previous_assistant_text: &str,
    response_text: &str,
    action_count: usize,
    state_json: &str,
    response_entries_json: &str,
) -> Result<String, String> {
    match provider {
        "openai" | "deepseek" | "anthropic" | "gemini" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider turn-step <openai|deepseek|anthropic|gemini> <iteration> <action-count> <max-iterations>"
                    .to_string(),
            )
        }
    }

    let mut state = parse_array(state_json, "state")?;
    let response_entries = parse_array(response_entries_json, "response entries")?;
    state.extend(response_entries);

    let assistant_text = if response_text.is_empty() {
        previous_assistant_text
    } else {
        response_text
    };
    let decision = provider_loop_decision(iteration, max_iterations, action_count, assistant_text);

    serde_json::to_string(&json!({
        "provider": provider,
        "state": state,
        "assistantText": assistant_text,
        "decision": decision.decision,
        "text": decision.text
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_complete_turn_step_json(
    provider: &str,
    iteration: usize,
    max_iterations: usize,
    previous_assistant_text: &str,
    response_text: &str,
    action_count: usize,
    state_json: &str,
    response_entries_json: &str,
    tool_outcomes_json: &str,
) -> Result<String, String> {
    match provider {
        "openai" | "deepseek" | "anthropic" | "gemini" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider complete-turn-step <openai|deepseek|anthropic|gemini> <iteration> <action-count> <max-iterations>"
                    .to_string(),
            )
        }
    }

    let mut state = parse_array(state_json, "state")?;
    let response_entries = parse_array(response_entries_json, "response entries")?;
    state.extend(response_entries);

    let assistant_text = if response_text.is_empty() {
        previous_assistant_text
    } else {
        response_text
    };
    let decision = provider_loop_decision(iteration, max_iterations, action_count, assistant_text);

    if decision.decision == "continue" {
        let entries_raw = provider_tool_result_turn_entries_json(provider, tool_outcomes_json)?;
        let entries_payload = serde_json::from_str::<Value>(&entries_raw)
            .map_err(|error| format!("Invalid generated tool result entries JSON: {error}"))?;
        let entries = entries_payload
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .ok_or("Generated tool result entries JSON must include entries array")?;
        state.extend(entries);
    }

    serde_json::to_string(&json!({
        "provider": provider,
        "state": state,
        "assistantText": assistant_text,
        "decision": decision.decision,
        "text": decision.text
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_response_entries_and_continues() {
        let raw = provider_turn_step_json(
            "openai",
            0,
            8,
            "",
            "working",
            1,
            r#"[{"role":"system","content":"s"}]"#,
            r#"[{"role":"assistant","content":"working"}]"#,
        )
        .expect("step");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["assistantText"], "working");
        assert_eq!(parsed["decision"], "continue");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 2);
    }

    #[test]
    fn preserves_previous_text_for_empty_response() {
        let raw =
            provider_turn_step_json("gemini", 0, 8, "previous", "", 0, "[]", "[]").expect("step");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["assistantText"], "previous");
        assert_eq!(parsed["decision"], "final");
        assert_eq!(parsed["text"], "previous");
    }

    #[test]
    fn completes_turn_step_with_tool_results_when_continuing() {
        let raw = provider_complete_turn_step_json(
            "openai",
            0,
            8,
            "",
            "working",
            1,
            r#"[{"role":"system","content":"s"}]"#,
            r#"[{"role":"assistant","content":"working","tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{}"}}]}]"#,
            r#"[{"toolName":"read_file","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]"#,
        )
        .expect("step");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["decision"], "continue");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 3);
        assert_eq!(parsed["state"][2]["role"], "tool");
        assert_eq!(parsed["state"][2]["content"], "ok");
    }

    #[test]
    fn completes_final_turn_without_tool_results() {
        let raw = provider_complete_turn_step_json(
            "anthropic",
            0,
            8,
            "",
            "done",
            0,
            "[]",
            r#"[{"role":"assistant","content":[{"type":"text","text":"done"}]}]"#,
            r#"[{"toolName":"ignored","toolCallId":"ignored","kind":"success","isError":false,"content":"ignored"}]"#,
        )
        .expect("step");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["decision"], "final");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 1);
    }
}
