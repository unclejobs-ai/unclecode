use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_trace_mode_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid trace mode command JSON: {error}"))?;
    let line = str_field(&input, "line").unwrap_or("/trace");
    let trace_mode = str_field(&input, "traceMode").unwrap_or("minimal");
    if trace_mode != "verbose" && trace_mode != "minimal" {
        return Err("Trace mode must be verbose or minimal.".to_string());
    }

    let message = if trace_mode == "verbose" {
        "Verbose trace mode enabled."
    } else {
        "Minimal trace mode enabled."
    };
    let patch = if trace_mode == "verbose" {
        json!({ "traceMode": "verbose" })
    } else {
        let panel_input = json!({
            "contextSummaryLines": array_field(&input, "contextSummaryLines"),
            "bridgeLines": array_field(&input, "bridgeLines"),
            "memoryLines": array_field(&input, "memoryLines"),
            "traceLines": [],
        });
        let panel = serde_json::from_str::<Value>(&build_ux_panel_json(
            "context",
            &panel_input.to_string(),
        )?)
        .map_err(|error| format!("Invalid trace-mode context panel JSON: {error}"))?;
        json!({
            "traceMode": "minimal",
            "traceLines": [],
            "panel": panel,
        })
    };

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": message },
        ],
        "patch": patch,
    }))
    .map_err(|error| error.to_string())
}

fn array_field(input: &Value, key: &str) -> Vec<Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enables_verbose_trace_without_rebuilding_panel() {
        let result = resolve_trace_mode_command_json(
            r#"{
                "line": "/verbose",
                "traceMode": "verbose",
                "contextSummaryLines": ["Loaded guidance: AGENTS.md"],
                "bridgeLines": ["bridge ready"],
                "memoryLines": ["memory ready"],
                "traceLines": ["old trace"]
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][1]["text"], "Verbose trace mode enabled.");
        assert_eq!(parsed["patch"]["traceMode"], "verbose");
        assert!(parsed["patch"].get("panel").is_none());
    }

    #[test]
    fn enables_minimal_trace_and_rebuilds_context_panel_without_live_traces() {
        let result = resolve_trace_mode_command_json(
            r#"{
                "line": "/minimal",
                "traceMode": "minimal",
                "contextSummaryLines": ["Loaded guidance: AGENTS.md"],
                "bridgeLines": ["bridge ready"],
                "memoryLines": ["memory ready"],
                "traceLines": ["old trace"]
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["entries"][1]["text"], "Minimal trace mode enabled.");
        assert_eq!(parsed["patch"]["traceMode"], "minimal");
        assert_eq!(parsed["patch"]["traceLines"], json!([]));
        assert_eq!(parsed["patch"]["panel"]["title"], "Context");
        assert!(!parsed["patch"]["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("old trace")));
    }
}
