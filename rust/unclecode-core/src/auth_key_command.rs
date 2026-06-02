use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_auth_key_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid auth key command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/auth key");
    let message = input
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Paste key. Optional: --org <id> --project <id>.");
    let panel_input = json!({ "message": message });
    let panel = serde_json::from_str::<Value>(&build_ux_panel_json(
        "auth-secure-entry",
        &panel_input.to_string(),
    )?)
    .map_err(|error| format!("Invalid auth key panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
        ],
        "composerMode": "api-key-entry",
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_auth_key_submit_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid auth key submit result JSON: {error}"))?;
    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    match kind {
        "success" => build_auth_key_success_result(&input),
        "error" => build_auth_key_error_result(&input),
        _ => build_auth_key_unavailable_result(&input),
    }
}

fn build_auth_key_success_result(input: &Value) -> Result<String, String> {
    let result_lines = input
        .get("resultLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_auth_label = input
        .get("nextAuthLabel")
        .and_then(Value::as_str)
        .unwrap_or("api-key-file");
    let panel_input = json!({
        "args": ["auth", "key"],
        "lines": result_lines,
    });
    let panel = serde_json::from_str::<Value>(&build_ux_panel_json(
        "inline-command",
        &panel_input.to_string(),
    )?)
    .map_err(|error| format!("Invalid auth key success panel JSON: {error}"))?;
    let summary = crate::ux_panels::format_inline_command_summary_json(&panel_input.to_string())?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "tool", "text": "✓ auth key" },
            { "role": "system", "text": summary },
        ],
        "patch": {
            "composerMode": "default",
            "authLabel": next_auth_label,
            "authLauncherLines": result_lines,
            "panel": panel,
        },
        "traceLines": ["→ auth key", "✓ auth key"],
    }))
    .map_err(|error| error.to_string())
}

fn build_auth_key_error_result(input: &Value) -> Result<String, String> {
    let message = input
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Failed to save API key.");
    let panel_input = json!({ "message": message });
    let panel = serde_json::from_str::<Value>(&build_ux_panel_json(
        "auth-secure-entry",
        &panel_input.to_string(),
    )?)
    .map_err(|error| format!("Invalid auth key error panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "system", "text": message },
        ],
        "patch": {
            "panel": panel,
        },
        "traceLines": [],
    }))
    .map_err(|error| error.to_string())
}

fn build_auth_key_unavailable_result(input: &Value) -> Result<String, String> {
    let message = "Secure API key entry is unavailable.";
    let panel_input = json!({
        "provider": input.get("provider").and_then(Value::as_str).unwrap_or("openai"),
        "model": input.get("model").and_then(Value::as_str).unwrap_or(""),
        "mode": input.get("mode").and_then(Value::as_str).unwrap_or("default"),
        "cwd": input.get("cwd").and_then(Value::as_str).unwrap_or(""),
        "reasoningLabel": input.get("reasoningLabel").and_then(Value::as_str).unwrap_or("default"),
        "authLabel": input.get("authLabel").and_then(Value::as_str).unwrap_or("none"),
        "contextSummaryLines": input.get("contextSummaryLines").and_then(Value::as_array).cloned().unwrap_or_default(),
        "bridgeLines": input.get("bridgeLines").and_then(Value::as_array).cloned().unwrap_or_default(),
        "memoryLines": input.get("memoryLines").and_then(Value::as_array).cloned().unwrap_or_default(),
        "traceLines": input.get("traceLines").and_then(Value::as_array).cloned().unwrap_or_default(),
    });
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("status", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid auth key unavailable status panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "system", "text": message },
        ],
        "patch": {
            "composerMode": "default",
            "panel": panel,
        },
        "traceLines": [],
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_secure_api_key_entry_result() {
        let result = resolve_auth_key_command_json(r#"{"line":"/auth key"}"#).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "/auth key");
        assert_eq!(parsed["composerMode"], "api-key-entry");
        assert_eq!(parsed["panel"]["title"], "Auth");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("") == "Secure API key entry."));
    }

    #[test]
    fn builds_secure_api_key_submit_success_result() {
        let result = resolve_auth_key_submit_result_json(
            r#"{"kind":"success","resultLines":["API key login saved.","Auth: api-key-file"],"nextAuthLabel":"api-key-file"}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "✓ auth key");
        assert_eq!(parsed["patch"]["composerMode"], "default");
        assert_eq!(parsed["patch"]["authLabel"], "api-key-file");
        assert_eq!(parsed["patch"]["panel"]["title"], "Auth");
        assert_eq!(parsed["traceLines"][0], "→ auth key");
    }

    #[test]
    fn builds_secure_api_key_submit_error_result() {
        let result =
            resolve_auth_key_submit_result_json(r#"{"kind":"error","message":"ERR:bad key"}"#)
                .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "ERR:bad key");
        assert_eq!(parsed["patch"]["panel"]["title"], "Auth");
        assert!(parsed["patch"]["composerMode"].is_null());
    }
}
