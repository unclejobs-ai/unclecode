use serde_json::{json, Value};

pub fn resolve_reload_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid reload command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/reload");

    serde_json::to_string(&json!({
        "startEntries": [
            { "role": "user", "text": line },
            { "role": "system", "text": "Reloading workspace context..." }
        ],
        "completeEntry": { "role": "system", "text": "Workspace context reloaded." }
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_reload_start_and_complete_entries() {
        let result = resolve_reload_command_json(r#"{"line":"/reload"}"#).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["startEntries"][0]["role"], "user");
        assert_eq!(parsed["startEntries"][0]["text"], "/reload");
        assert_eq!(parsed["startEntries"][1]["role"], "system");
        assert_eq!(
            parsed["startEntries"][1]["text"],
            "Reloading workspace context..."
        );
        assert_eq!(parsed["completeEntry"]["role"], "system");
        assert_eq!(
            parsed["completeEntry"]["text"],
            "Workspace context reloaded."
        );
    }
}
