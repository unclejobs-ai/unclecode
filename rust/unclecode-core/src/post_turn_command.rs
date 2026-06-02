use serde_json::{json, Value};

pub fn resolve_post_turn_success_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid post-turn success JSON: {error}"))?;
    let summary = input.get("summary").and_then(Value::as_str).unwrap_or("");
    let bridge_id = input.get("bridgeId").and_then(Value::as_str).unwrap_or("");
    let bridge_line = input
        .get("bridgeLine")
        .and_then(Value::as_str)
        .unwrap_or("");
    let memory_id = input.get("memoryId").and_then(Value::as_str).unwrap_or("");
    let mut bridge_lines = vec![Value::String(bridge_line.to_string())];
    bridge_lines.extend(
        input
            .get("currentBridgeLines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );
    bridge_lines.truncate(6);
    let memory_lines = input
        .get("memoryLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    serde_json::to_string(&json!({
        "bridgeLines": bridge_lines,
        "memoryLines": memory_lines,
        "bridgeSummary": summary,
        "memorySummary": summary,
        "bridgeTraceEvent": {
            "type": "bridge.published",
            "level": "high-signal",
            "bridgeId": bridge_id,
            "scope": "project",
            "kind": "summary",
            "summary": summary,
            "source": "work-shell",
            "target": "project-context",
        },
        "memoryTraceEvent": {
            "type": "memory.written",
            "level": "high-signal",
            "memoryId": memory_id,
            "scope": "session",
            "summary": summary,
        }
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_post_turn_success_effects() {
        let result = resolve_post_turn_success_result_json(
            r#"{
                "summary": "User: hello\nAssistant: world",
                "bridgeId": "bridge-1",
                "bridgeLine": "bridge-1 line",
                "currentBridgeLines": ["bridge-0"],
                "memoryId": "memory-1",
                "memoryLines": ["memory-1 line"]
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["bridgeLines"][0], "bridge-1 line");
        assert_eq!(parsed["bridgeLines"][1], "bridge-0");
        assert_eq!(parsed["memoryLines"][0], "memory-1 line");
        assert_eq!(parsed["bridgeTraceEvent"]["type"], "bridge.published");
        assert_eq!(parsed["bridgeTraceEvent"]["bridgeId"], "bridge-1");
        assert_eq!(parsed["memoryTraceEvent"]["type"], "memory.written");
        assert_eq!(parsed["memoryTraceEvent"]["memoryId"], "memory-1");
    }
}
