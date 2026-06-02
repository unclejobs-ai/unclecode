use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_skill_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid skill command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/skill");

    if let Some(error) = input.get("error").and_then(Value::as_str) {
        return entries_only(line, error);
    }

    let Some(skill) = input.get("skill").filter(|value| value.is_object()) else {
        return entries_only(line, "Usage: /skill <name>");
    };

    let name = skill.get("name").and_then(Value::as_str).unwrap_or("skill");
    let panel = serde_json::from_str::<Value>(&build_ux_panel_json("skill", &skill.to_string())?)
        .map_err(|error| format!("Invalid skill panel JSON: {error}"))?;

    let mut entries = vec![json!({ "role": "user", "text": line })];
    for attempt in skill
        .get("attempts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let path = attempt.get("path").and_then(Value::as_str).unwrap_or("");
        if !path.is_empty() {
            entries.push(json!({ "role": "tool", "text": format!("read {path}") }));
        }
        if attempt.get("ok").and_then(Value::as_bool) == Some(false) {
            let error = attempt
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Failed to read skill.");
            entries.push(json!({ "role": "system", "text": error }));
        }
    }
    entries.push(json!({ "role": "system", "text": format!("Loaded skill {name}.") }));

    serde_json::to_string(&json!({
        "entries": entries,
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

fn entries_only(line: &str, text: &str) -> Result<String, String> {
    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": text },
        ],
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_loaded_skill_result() {
        let result = resolve_skill_command_json(
            r##"{
                "line": "/skill analyze",
                "skill": {
                    "name": "analyze",
                    "content": "# Analyze\nLook deeper.",
                    "attempts": [
                        {"path":"/skills/missing","ok":false,"error":"missing"},
                        {"path":"/skills/analyze","ok":true}
                    ]
                }
            }"##,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "/skill analyze");
        assert_eq!(parsed["entries"][1]["role"], "tool");
        assert_eq!(parsed["entries"][2]["text"], "missing");
        assert_eq!(parsed["entries"][4]["text"], "Loaded skill analyze.");
        assert_eq!(parsed["panel"]["title"], "Skill · analyze");
    }

    #[test]
    fn builds_usage_and_error_results() {
        let usage = resolve_skill_command_json(r#"{"line":"/skill"}"#).unwrap();
        let parsed_usage: Value = serde_json::from_str(&usage).unwrap();
        assert_eq!(parsed_usage["entries"][1]["text"], "Usage: /skill <name>");

        let error =
            resolve_skill_command_json(r#"{"line":"/skill analyze","error":"boom"}"#).unwrap();
        let parsed_error: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(parsed_error["entries"][1]["text"], "boom");
    }
}
