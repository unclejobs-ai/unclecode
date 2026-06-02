use serde_json::{json, Value};

pub fn resolve_sessions_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid sessions command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/sessions");

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line }
        ]
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_sessions_overlay_entry() {
        let result = resolve_sessions_command_json(r#"{"line":"/sessions"}"#).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["role"], "user");
        assert_eq!(parsed["entries"][0]["text"], "/sessions");
    }
}
