use serde_json::{json, Value};

pub fn resolve_prompt_start_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid prompt start JSON: {error}"))?;
    let turn_started_at = input
        .get("turnStartedAt")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    serde_json::to_string(&json!({
        "patch": {
            "isBusy": true,
            "busyStatus": "thinking",
            "currentTurnStartedAt": turn_started_at,
        }
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_prompt_finalize_result_json(_input_json: &str) -> Result<String, String> {
    serde_json::to_string(&json!({
        "patch": {
            "isBusy": false,
            "clearBusyStatus": true,
            "clearCurrentTurnStartedAt": true,
        }
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_prompt_start_busy_patch() {
        let result = resolve_prompt_start_result_json(r#"{"turnStartedAt":42}"#).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["patch"]["isBusy"], true);
        assert_eq!(parsed["patch"]["busyStatus"], "thinking");
        assert_eq!(parsed["patch"]["currentTurnStartedAt"], 42);
    }

    #[test]
    fn builds_prompt_finalize_idle_patch() {
        let result = resolve_prompt_finalize_result_json("{}").unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["patch"]["isBusy"], false);
        assert_eq!(parsed["patch"]["clearBusyStatus"], true);
        assert_eq!(parsed["patch"]["clearCurrentTurnStartedAt"], true);
    }
}
