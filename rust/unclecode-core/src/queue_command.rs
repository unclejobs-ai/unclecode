use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_queue_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid queue command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/queue");
    let is_busy = input
        .get("isBusy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = input
        .get("transcriptText")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if is_busy {
                "Queue shown. Active turn is still running.".to_string()
            } else {
                "Queue shown. No queued work in this shell.".to_string()
            }
        });
    let panel_input = json!({
        "isBusy": is_busy,
        "busyStatus": input.get("busyStatus").cloned().unwrap_or(Value::Null),
        "mode": input.get("mode").cloned().unwrap_or(Value::Null),
        "workerBudget": input.get("workerBudget").cloned().unwrap_or(Value::Null),
        "queuedCount": input.get("queuedCount").cloned().unwrap_or(Value::Null),
        "queuedItems": input.get("queuedItems").cloned().unwrap_or(Value::Null),
        "queuePaused": input.get("queuePaused").cloned().unwrap_or(Value::Null),
        "blockedReason": input.get("blockedReason").cloned().unwrap_or(Value::Null),
        "activePromptPreview": input.get("activePromptPreview").cloned().unwrap_or(Value::Null),
        "lastCompletedTurn": input.get("lastCompletedTurn").cloned().unwrap_or(Value::Null),
        "terminalColumns": input.get("terminalColumns").cloned().unwrap_or(Value::Null),
    });
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("queue", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid queue panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": message },
        ],
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_idle_queue_result() {
        let result = resolve_queue_command_json(
            r#"{"line":"/queue","isBusy":false,"mode":"default","workerBudget":1,"queuedCount":0,"queuedItems":[]}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["entries"][1]["text"],
            "Queue shown. No queued work in this shell."
        );
        assert_eq!(parsed["panel"]["title"], "Work board");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("State · idle")));
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Queued · 0")));
    }

    #[test]
    fn builds_busy_queue_result_with_override_copy() {
        let result = resolve_queue_command_json(
            r#"{
                "line": "/queue clear",
                "isBusy": true,
                "busyStatus": "thinking",
                "mode": "yolo",
                "workerBudget": 4,
                "queuedCount": 0,
                "queuedItems": [],
                "transcriptText": "Queue cleared. Active turn is still running."
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["entries"][1]["text"],
            "Queue cleared. Active turn is still running."
        );
        assert_eq!(parsed["panel"]["title"], "Work board");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("State · running")));
    }
}
