use serde_json::{json, Value};

pub fn resolve_prompt_success_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid prompt success JSON: {error}"))?;
    let assistant_text = input
        .get("assistantText")
        .and_then(Value::as_str)
        .unwrap_or("");
    let bridge_lines = input
        .get("bridgeLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let memory_lines = input
        .get("memoryLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let last_turn_duration_ms = input
        .get("lastTurnDurationMs")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let mut entries = Vec::new();
    if !assistant_text.trim().is_empty() {
        entries.push(json!({ "role": "assistant", "text": assistant_text }));
    }

    serde_json::to_string(&json!({
        "entries": entries,
        "patch": {
            "bridgeLines": bridge_lines,
            "memoryLines": memory_lines,
            "lastTurnDurationMs": last_turn_duration_ms,
        }
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_success_entry_and_state_patch() {
        let result = resolve_prompt_success_result_json(
            r#"{
                "assistantText": "Done.",
                "bridgeLines": ["bridge-1", "bridge-0"],
                "memoryLines": ["memory-1"],
                "lastTurnDurationMs": 23
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["role"], "assistant");
        assert_eq!(parsed["entries"][0]["text"], "Done.");
        assert_eq!(parsed["patch"]["bridgeLines"][0], "bridge-1");
        assert_eq!(parsed["patch"]["memoryLines"][0], "memory-1");
        assert_eq!(parsed["patch"]["lastTurnDurationMs"], 23);
    }

    #[test]
    fn omits_assistant_entry_when_sanitized_text_is_empty() {
        let result = resolve_prompt_success_result_json(
            r#"{
                "assistantText": "",
                "bridgeLines": ["bridge-1"],
                "memoryLines": ["memory-1"],
                "lastTurnDurationMs": 12
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"].as_array().map(|entries| entries.len()), Some(0));
        assert_eq!(parsed["patch"]["bridgeLines"][0], "bridge-1");
    }
}
