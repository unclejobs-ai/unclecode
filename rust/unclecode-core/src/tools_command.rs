use serde_json::{json, Value};

pub fn resolve_tools_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid tools command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/tools");
    let tool_lines = input
        .get("toolLines")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": tool_lines },
        ],
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_tools_result() {
        let result = resolve_tools_command_json(
            r#"{"line":"/tools","toolLines":["read_file","write_file"]}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "/tools");
        assert_eq!(parsed["entries"][1]["text"], "read_file\nwrite_file");
    }
}
