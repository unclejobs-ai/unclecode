use serde_json::{json, Value};

pub fn resolve_work_shell_trace_event_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_trace_event(&input))
        .map_err(|error| error.to_string())
}

fn parse_input(input_json: &str) -> Result<Value, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    serde_json::from_str(input)
        .map_err(|error| format!("Invalid work-shell trace event JSON: {error}"))
}

fn resolve_work_shell_trace_event(input: &Value) -> Value {
    let event = input.get("event").unwrap_or(&Value::Null);
    let line = str_field(input, "line").unwrap_or_default();
    let trace_mode = str_field(input, "traceMode").unwrap_or("minimal");
    let mut decision = json!({
        "busyStatusAction": resolve_busy_status_action(event, line),
        "traceEntryRole": resolve_trace_entry_role(event),
    });

    if let Some(value) = resolve_busy_status_value(event, line) {
        decision["busyStatus"] = json!(value);
    }
    if let Some(started_at) = extract_current_turn_started_at(event) {
        decision["currentTurnStartedAt"] = json!(started_at);
    }
    if let Some(trace_entry) = resolve_verbose_trace_entry(trace_mode, event, line) {
        decision["traceEntry"] = trace_entry;
    }

    decision
}

fn resolve_busy_status_action(event: &Value, line: &str) -> &'static str {
    match str_field(event, "type").unwrap_or_default() {
        "turn.completed" => "clear",
        "turn.started" | "provider.calling" | "tool.started" | "tool.completed" => "set",
        "reasoning.delta" if !line.is_empty() => "set",
        "orchestrator.step" if str_field(event, "status") == Some("running") => "set",
        _ => "none",
    }
}

fn resolve_busy_status_value<'a>(event: &Value, line: &'a str) -> Option<&'a str> {
    if resolve_busy_status_action(event, line) == "set" {
        if line.is_empty() {
            Some("thinking")
        } else {
            Some(line)
        }
    } else {
        None
    }
}

fn resolve_trace_entry_role(event: &Value) -> &'static str {
    match str_field(event, "type").unwrap_or_default() {
        "turn.started" | "turn.completed" => "system",
        "reasoning.delta" => "assistant",
        _ => "tool",
    }
}

fn extract_current_turn_started_at(event: &Value) -> Option<i64> {
    if str_field(event, "type") == Some("turn.started") {
        event.get("startedAt").and_then(Value::as_i64)
    } else {
        None
    }
}

fn resolve_verbose_trace_entry(_trace_mode: &str, event: &Value, line: &str) -> Option<Value> {
    if line.is_empty() {
        return None;
    }

    match str_field(event, "type").unwrap_or_default() {
        "policy.denied" => Some(json!({
            "role": "tool",
            "text": line,
        })),
        // tool.completed is a first-class transcript citizen in every trace
        // mode: the decision only says "emit an entry"; the caller replaces
        // the formatted one-liner with a multi-row glyph-less detail text
        // assembled from the structured event.
        "tool.completed" => Some(json!({
            "role": "tool",
            "text": line,
        })),
        _ => None,
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_busy_trace_event_updates() {
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"turn.started","startedAt":42},"line":"thinking inspect repo","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"thinking inspect repo","busyStatusAction":"set","currentTurnStartedAt":42,"traceEntryRole":"system"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"turn.completed"},"line":"done 123","traceMode":"verbose"}"#,
            )
            .unwrap(),
            r#"{"busyStatusAction":"clear","traceEntryRole":"system"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"orchestrator.step","status":"running"},"line":"","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"thinking","busyStatusAction":"set","traceEntryRole":"tool"}"#
        );
    }

    #[test]
    fn resolves_verbose_and_minimal_trace_entries() {
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"provider.calling"},"line":"calling openai gpt-5.4","traceMode":"verbose"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"calling openai gpt-5.4","busyStatusAction":"set","traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"provider.route"},"line":"route openai direct","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatusAction":"none","traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"reasoning.delta"},"line":"✦ thinking· inspect repo","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"✦ thinking· inspect repo","busyStatusAction":"set","traceEntryRole":"assistant"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"policy.denied"},"line":"✖ policy denied filesystem.write/write_file · openshell · denied","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatusAction":"none","traceEntry":{"role":"tool","text":"✖ policy denied filesystem.write/write_file · openshell · denied"},"traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"tool.started"},"line":"→ read package.json","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"→ read package.json","busyStatusAction":"set","traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"provider.calling"},"line":"calling openai gpt-5.4","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"calling openai gpt-5.4","busyStatusAction":"set","traceEntryRole":"tool"}"#
        );
    }

    #[test]
    fn resolves_completed_tool_status_and_trace_entries() {
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"tool.completed","toolName":"write_file","isError":false},"line":"✓ write 12ms notes.txt","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"✓ write 12ms notes.txt","busyStatusAction":"set","traceEntry":{"role":"tool","text":"✓ write 12ms notes.txt"},"traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"tool.completed","toolName":"run_shell","isError":false},"line":"✓ bash 34ms cargo test -p unclecode-core","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"✓ bash 34ms cargo test -p unclecode-core","busyStatusAction":"set","traceEntry":{"role":"tool","text":"✓ bash 34ms cargo test -p unclecode-core"},"traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"tool.completed","toolName":"write_file","isError":false},"line":"✓ write 12ms notes.txt","traceMode":"verbose"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"✓ write 12ms notes.txt","busyStatusAction":"set","traceEntry":{"role":"tool","text":"✓ write 12ms notes.txt"},"traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"tool.completed","toolName":"read_file","isError":true},"line":"","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"thinking","busyStatusAction":"set","traceEntryRole":"tool"}"#,
            "an empty formatted line still emits no trace entry",
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"provider.route"},"line":"route openai direct","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatusAction":"none","traceEntryRole":"tool"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_event_json(
                r#"{"event":{"type":"tool.started"},"line":"→ write notes.txt","traceMode":"minimal"}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"→ write notes.txt","busyStatusAction":"set","traceEntryRole":"tool"}"#,
            "tool.started stays a live-status-only event in every trace mode",
        );
    }
}
