use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_help_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid help command JSON: {error}"))?;
    let line = input.get("line").and_then(Value::as_str).unwrap_or("/help");
    let panel = serde_json::from_str::<Value>(&build_ux_panel_json("help", "{}")?)
        .map_err(|error| format!("Invalid help panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": "Help shown." },
        ],
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_help_result() {
        let result = resolve_help_command_json(r#"{"line":"/help"}"#).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "/help");
        assert_eq!(parsed["entries"][1]["text"], "Help shown.");
        assert_eq!(parsed["panel"]["title"], "Work-first shell");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("/context")));
    }
}
