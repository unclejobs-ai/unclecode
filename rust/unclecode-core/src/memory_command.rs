use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_memories_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid memories command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/memories");
    let session_memory = input
        .get("sessionMemory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let project_memory = input
        .get("projectMemory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let panel_input = json!({
        "sessionMemory": session_memory,
        "projectMemory": project_memory,
    });
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("memories", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid memories panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": "Memories shown." },
        ],
        "patch": {
            "memoryLines": session_memory,
            "panel": panel,
        },
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_remember_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid remember command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/remember");
    if let Some(usage_error) = input.get("usageError").and_then(Value::as_str) {
        return serde_json::to_string(&json!({
            "entries": [
                { "role": "user", "text": line },
                { "role": "system", "text": usage_error },
            ]
        }))
        .map_err(|error| error.to_string());
    }

    let scope = input
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("session");
    let memory_trace = input
        .get("memoryTrace")
        .and_then(Value::as_str)
        .unwrap_or("memory saved");
    let next_memory_lines = input
        .get("nextMemoryLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut result = json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "tool", "text": memory_trace },
        ],
        "traceLine": memory_trace,
    });
    if scope == "session" {
        result["patch"] = json!({ "memoryLines": next_memory_lines });
    }
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_memories_result_with_panel_patch() {
        let result = resolve_memories_command_json(
            r#"{"line":"/memories","sessionMemory":["session-1"],"projectMemory":["project-1"]}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "/memories");
        assert_eq!(parsed["entries"][1]["text"], "Memories shown.");
        assert_eq!(parsed["patch"]["memoryLines"][0], "session-1");
        assert_eq!(parsed["patch"]["panel"]["title"], "Memories");
    }

    #[test]
    fn builds_remember_usage_error_entries() {
        let result = resolve_remember_command_json(
            r#"{"line":"/remember","usageError":"Usage: /remember [session|project|user|agent] <text>"}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["role"], "user");
        assert_eq!(
            parsed["entries"][1]["text"],
            "Usage: /remember [session|project|user|agent] <text>"
        );
    }

    #[test]
    fn builds_remember_trace_and_session_patch() {
        let result = resolve_remember_command_json(
            r#"{"line":"/remember session keep this","scope":"session","memoryTrace":"memory keep this","nextMemoryLines":["keep this"]}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][1]["role"], "tool");
        assert_eq!(parsed["traceLine"], "memory keep this");
        assert_eq!(parsed["patch"]["memoryLines"][0], "keep this");
    }
}
