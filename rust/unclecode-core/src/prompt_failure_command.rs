use crate::status_command::build_status_panel_input;
use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_prompt_failure_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid prompt failure JSON: {error}"))?;
    let formatted_message = input
        .get("formattedMessage")
        .and_then(Value::as_str)
        .unwrap_or("Request failed.");
    let next_auth_label = input
        .get("nextAuthLabel")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let last_turn_duration_ms = input
        .get("lastTurnDurationMs")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let is_auth_failure = input
        .get("isAuthFailure")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut patch = json!({
        "authLabel": next_auth_label,
        "lastTurnDurationMs": last_turn_duration_ms,
        "clearCurrentTurnStartedAt": true,
    });
    if is_auth_failure {
        let mut panel_input = build_status_panel_input(&input)?;
        if let Some(object) = panel_input.as_object_mut() {
            object.insert(
                "authLabel".to_string(),
                Value::String(next_auth_label.to_string()),
            );
        }
        let panel = serde_json::from_str::<Value>(&build_ux_panel_json(
            "status",
            &panel_input.to_string(),
        )?)
        .map_err(|error| format!("Invalid prompt failure status panel JSON: {error}"))?;
        if let Some(object) = patch.as_object_mut() {
            object.insert("panel".to_string(), panel);
        }
    }

    serde_json::to_string(&json!({
        "entries": [
            { "role": "system", "text": formatted_message },
        ],
        "patch": patch,
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_auth_failure_entry_and_status_patch() {
        let result = resolve_prompt_failure_result_json(
            r#"{
                "formattedMessage": "Auth failed. Run /auth login.",
                "nextAuthLabel": "api-key-file",
                "lastTurnDurationMs": 42,
                "isAuthFailure": true,
                "provider": "openai",
                "model": "gpt-5.4",
                "mode": "default",
                "cwd": "/repo",
                "reasoningLabel": "high (override)",
                "contextSummaryLines": ["Auth issue: saved OAuth needs refresh."],
                "bridgeLines": [],
                "memoryLines": [],
                "traceLines": []
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["entries"][0]["text"],
            "Auth failed. Run /auth login."
        );
        assert_eq!(parsed["patch"]["authLabel"], "api-key-file");
        assert_eq!(parsed["patch"]["lastTurnDurationMs"], 42);
        assert_eq!(parsed["patch"]["clearCurrentTurnStartedAt"], true);
        assert_eq!(parsed["patch"]["panel"]["title"], "Session status");
        assert!(parsed["patch"]["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line
                .as_str()
                .unwrap_or("")
                .contains("Issue · saved OAuth needs refresh.")));
    }

    #[test]
    fn builds_plain_failure_without_panel() {
        let result = resolve_prompt_failure_result_json(
            r#"{
                "formattedMessage": "Provider timed out.",
                "nextAuthLabel": "oauth-file",
                "lastTurnDurationMs": 7,
                "isAuthFailure": false
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "Provider timed out.");
        assert!(parsed["patch"]["panel"].is_null());
    }
}
