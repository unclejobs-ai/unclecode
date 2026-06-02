use serde_json::{json, Value};

pub fn resolve_clear_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid clear command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/clear");
    let entries = json!([{ "role": "system", "text": "Conversation cleared." }]);

    serde_json::to_string(&json!({
        "line": line,
        "entries": entries,
        "patch": {
            "entries": entries
        }
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_clear_patch_result() {
        let result = resolve_clear_command_json(r#"{"line":"/clear"}"#).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["line"], "/clear");
        assert_eq!(parsed["entries"][0]["role"], "system");
        assert_eq!(parsed["entries"][0]["text"], "Conversation cleared.");
        assert_eq!(parsed["patch"]["entries"], parsed["entries"]);
    }
}
