use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_harness_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid harness command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/harness");
    let mode = input
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let worker_budget = input
        .get("workerBudget")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let auto_continue = input
        .get("autoContinue")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let panel_input = json!({
        "mode": mode,
        "workerBudget": worker_budget,
        "autoContinue": auto_continue,
    });
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("harness", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid harness panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": "Harness shown." },
        ],
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_harness_result_with_panel() {
        let result = resolve_harness_command_json(
            r#"{"line":"/harness","mode":"yolo","workerBudget":4,"autoContinue":true}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][0]["text"], "/harness");
        assert_eq!(parsed["entries"][1]["text"], "Harness shown.");
        assert_eq!(parsed["panel"]["title"], "Harness");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Workers · 4 max")));
    }
}
