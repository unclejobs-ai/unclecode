use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_skills_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid skills command JSON: {error}"))?;
    let line = str_field(&input, "line").unwrap_or("/skills");
    let skills = input
        .get("skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let message = if skills.is_empty() {
        "No skills found.".to_string()
    } else {
        format!("Loaded {} skills.", skills.len())
    };
    let panel_input = json!({ "skills": skills });
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("skills", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid skills panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": message },
        ],
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_loaded_skills_result() {
        let result = resolve_skills_command_json(
            r#"{
                "line": "/skills",
                "skills": [
                    {"name":"autopilot","scope":"project","summary":"Keep moving."},
                    {"name":"review","scope":"global","summary":"Find risks."}
                ]
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][1]["text"], "Loaded 2 skills.");
        assert_eq!(parsed["panel"]["title"], "Skills");
        assert_eq!(parsed["panel"]["lines"][0], "autopilot · project");
        assert_eq!(parsed["panel"]["lines"][1], "  Keep moving.");
    }

    #[test]
    fn builds_empty_skills_result() {
        let result = resolve_skills_command_json(r#"{"line":"/skills","skills":[]}"#).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][1]["text"], "No skills found.");
        assert_eq!(parsed["panel"]["lines"][0], "No skills found.");
    }
}
