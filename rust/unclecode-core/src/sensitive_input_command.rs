use crate::status_command::build_status_panel_input;
use crate::ux_panels::build_ux_panel_json;
use crate::ux_text::build_work_shell_transition_json;
use serde_json::{json, Value};

pub fn resolve_sensitive_input_cancel_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid sensitive input cancel JSON: {error}"))?;
    let entries = serde_json::from_str::<Value>(&build_work_shell_transition_json(
        r#"{"kind":"sensitive-input-cancel"}"#,
    )?)
    .map_err(|error| format!("Invalid sensitive input cancel entries JSON: {error}"))?;
    let panel_input = build_status_panel_input(&input)?;
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("status", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid sensitive input cancel panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": entries,
        "composerMode": "default",
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_cancel_result_with_status_panel() {
        let result = resolve_sensitive_input_cancel_result_json(
            r#"{
                "provider": "openai",
                "model": "gpt-5.4",
                "mode": "default",
                "cwd": "/repo",
                "reasoningLabel": "high (override)",
                "authLabel": "api-key-file",
                "contextSummaryLines": ["Loaded guidance: AGENTS.md"],
                "bridgeLines": [],
                "memoryLines": [],
                "traceLines": []
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "API key entry canceled.");
        assert_eq!(parsed["composerMode"], "default");
        assert_eq!(parsed["panel"]["title"], "Session status");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line
                .as_str()
                .unwrap_or("")
                .contains("Auth · API key · file")));
    }
}
