use serde_json::{json, Value};

pub fn resolve_work_shell_trace_line_patch_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_trace_line_patch(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_trace_mode_patch_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_trace_mode_patch(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_busy_state_patch_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_busy_state_patch(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_auth_state_patch_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_auth_state_patch(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_initial_state_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_initial_state(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_append_entries_patch_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_append_entries_patch(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_mode_default_reasoning_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_mode_default_reasoning(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_dashboard_home_patch_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_dashboard_home_patch(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_dashboard_home_sync_state_json(
    input_json: &str,
) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&resolve_work_shell_dashboard_home_sync_state(&input))
        .map_err(|error| error.to_string())
}

pub fn should_refresh_work_shell_dashboard_home_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json)?;
    serde_json::to_string(&json!({
        "shouldRefresh": should_refresh_work_shell_dashboard_home(&input)
    }))
    .map_err(|error| error.to_string())
}

fn parse_input(input_json: &str) -> Result<Value, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    serde_json::from_str(input)
        .map_err(|error| format!("Invalid work-shell trace line patch JSON: {error}"))
}

fn resolve_work_shell_trace_line_patch(input: &Value) -> Value {
    let line = str_field(input, "line").unwrap_or_default();
    let current_trace_lines = input
        .get("traceLines")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let trace_lines = [line.to_string()]
        .into_iter()
        .chain(
            current_trace_lines
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string),
        )
        .take(8)
        .collect::<Vec<_>>();
    let panel_title = str_field(input, "panelTitle").unwrap_or_default();
    let preserve_panel = bool_field(input, "preservePanel") || is_pinned_panel_title(panel_title);
    json!({
        "traceLines": trace_lines,
        "preservePanel": preserve_panel,
        "shouldRebuildContextPanel": !preserve_panel,
    })
}

fn resolve_work_shell_trace_mode_patch(input: &Value) -> Value {
    let trace_mode = str_field(input, "traceMode").unwrap_or("minimal");
    if trace_mode == "verbose" {
        return json!({
            "traceMode": "verbose",
            "clearTraceLines": false,
            "shouldRebuildContextPanel": false,
        });
    }

    json!({
        "traceMode": "minimal",
        "clearTraceLines": true,
        "shouldRebuildContextPanel": true,
    })
}

fn resolve_work_shell_busy_state_patch(input: &Value) -> Value {
    let mut patch = json!({
        "isBusy": bool_field(input, "isBusy"),
        "busyStatusAction": if input.get("busyStatus").and_then(Value::as_str).is_some() {
            "set"
        } else {
            "clear"
        },
        "currentTurnStartedAtAction": "keep",
    });

    if let Some(busy_status) = input.get("busyStatus").and_then(Value::as_str) {
        patch["busyStatus"] = json!(busy_status);
    }

    if let Some(started_at) = input.get("currentTurnStartedAt").and_then(Value::as_i64) {
        patch["currentTurnStartedAt"] = json!(started_at);
        patch["currentTurnStartedAtAction"] = json!("set");
    } else if bool_field(input, "clearCurrentTurnStartedAt") {
        patch["currentTurnStartedAtAction"] = json!("clear");
    }

    patch
}

fn resolve_work_shell_auth_state_patch(input: &Value) -> Value {
    let mut patch = json!({
        "authLabel": str_field(input, "authLabel").unwrap_or_default(),
        "authLauncherLinesAction": "keep",
    });

    if let Some(lines) = input.get("authLauncherLines").and_then(Value::as_array) {
        patch["authLauncherLines"] =
            json!(lines.iter().filter_map(Value::as_str).collect::<Vec<_>>());
        patch["authLauncherLinesAction"] = json!("set");
    }

    patch
}

fn resolve_work_shell_initial_state(input: &Value) -> Value {
    let mode = str_field(input, "mode").unwrap_or("default");
    let initial_trace_mode = str_field(input, "initialTraceMode");
    let trace_mode = match initial_trace_mode {
        Some("verbose") => "verbose",
        Some("minimal") => "minimal",
        _ if mode == "ultrawork" => "verbose",
        _ => "minimal",
    };

    json!({
        "entries": [],
        "model": str_field(input, "model").unwrap_or_default(),
        "mode": mode,
        "reasoning": input.get("reasoning").cloned().unwrap_or_else(|| json!(null)),
        "authLabel": str_field(input, "authLabel").unwrap_or_default(),
        "authLauncherLines": [],
        "bridgeLines": [],
        "memoryLines": [],
        "traceLines": [],
        "traceMode": trace_mode,
        "composerMode": "default",
        "isBusy": false,
        "busyStatusAction": "clear",
        "currentTurnStartedAtAction": "clear",
        "lastTurnDurationMsAction": "clear",
    })
}

fn resolve_work_shell_append_entries_patch(input: &Value) -> Value {
    let existing_entries = input
        .get("entries")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let next_entries = input
        .get("nextEntries")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let entries = existing_entries
        .iter()
        .chain(next_entries.iter())
        .cloned()
        .collect::<Vec<_>>();

    json!({ "entries": entries })
}

fn resolve_work_shell_mode_default_reasoning(input: &Value) -> Value {
    if input
        .get("support")
        .and_then(|support| support.get("status"))
        .and_then(Value::as_str)
        == Some("unsupported")
    {
        return input.clone();
    }

    let mut reasoning = input.clone();
    if let Value::Object(ref mut object) = reasoning {
        object.insert("source".to_string(), json!("mode-default"));
    }
    reasoning
}

fn resolve_work_shell_dashboard_home_patch(input: &Value) -> Value {
    json!({
        "authLabel": str_field(input, "authLabel").unwrap_or_default(),
        "bridgeLines": string_array_field(input, "bridgeLines"),
        "memoryLines": string_array_field(input, "memoryLines"),
    })
}

fn resolve_work_shell_dashboard_home_sync_state(input: &Value) -> Value {
    json!({
        "isBusy": bool_field(input, "isBusy"),
        "authLabel": str_field(input, "authLabel").unwrap_or_default(),
        "bridgeLines": string_array_field(input, "bridgeLines"),
        "memoryLines": string_array_field(input, "memoryLines"),
    })
}

fn should_refresh_work_shell_dashboard_home(input: &Value) -> bool {
    let Some(previous) = input.get("previous").filter(|value| value.is_object()) else {
        return false;
    };
    let next = input.get("next").unwrap_or(&Value::Null);
    let previous_is_busy = bool_field(previous, "isBusy");
    let next_is_busy = bool_field(next, "isBusy");
    (previous_is_busy && !next_is_busy)
        || str_field(previous, "authLabel").unwrap_or_default()
            != str_field(next, "authLabel").unwrap_or_default()
        || first_string_field(previous, "bridgeLines") != first_string_field(next, "bridgeLines")
        || first_string_field(previous, "memoryLines") != first_string_field(next, "memoryLines")
}

fn is_pinned_panel_title(title: &str) -> bool {
    matches!(
        title,
        "Recent sessions" | "Session status" | "Status" | "Help" | "Memories" | "Skills" | "Queue"
    ) || title.starts_with("Skill · ")
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn first_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_trace_line_patch_for_unpinned_panel() {
        assert_eq!(
            resolve_work_shell_trace_line_patch_json(
                r#"{"line":"new trace","traceLines":["old trace"],"panelTitle":"Context","preservePanel":false}"#,
            )
            .unwrap(),
            r#"{"preservePanel":false,"shouldRebuildContextPanel":true,"traceLines":["new trace","old trace"]}"#
        );
    }

    #[test]
    fn preserves_pinned_panels() {
        assert_eq!(
            resolve_work_shell_trace_line_patch_json(
                r#"{"line":"new trace","traceLines":["old trace"],"panelTitle":"Status","preservePanel":false}"#,
            )
            .unwrap(),
            r#"{"preservePanel":true,"shouldRebuildContextPanel":false,"traceLines":["new trace","old trace"]}"#
        );
        assert_eq!(
            resolve_work_shell_trace_line_patch_json(
                r#"{"line":"new trace","traceLines":[],"panelTitle":"Skill · autopilot","preservePanel":false}"#,
            )
            .unwrap(),
            r#"{"preservePanel":true,"shouldRebuildContextPanel":false,"traceLines":["new trace"]}"#
        );
    }

    #[test]
    fn caps_trace_lines_at_eight() {
        assert_eq!(
            resolve_work_shell_trace_line_patch_json(
                r#"{"line":"0","traceLines":["1","2","3","4","5","6","7","8","9"],"panelTitle":"Context","preservePanel":false}"#,
            )
            .unwrap(),
            r#"{"preservePanel":false,"shouldRebuildContextPanel":true,"traceLines":["0","1","2","3","4","5","6","7"]}"#
        );
    }

    #[test]
    fn resolves_trace_mode_patch() {
        assert_eq!(
            resolve_work_shell_trace_mode_patch_json(r#"{"traceMode":"verbose"}"#).unwrap(),
            r#"{"clearTraceLines":false,"shouldRebuildContextPanel":false,"traceMode":"verbose"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_mode_patch_json(r#"{"traceMode":"minimal"}"#).unwrap(),
            r#"{"clearTraceLines":true,"shouldRebuildContextPanel":true,"traceMode":"minimal"}"#
        );
        assert_eq!(
            resolve_work_shell_trace_mode_patch_json(r#"{"traceMode":"unknown"}"#).unwrap(),
            r#"{"clearTraceLines":true,"shouldRebuildContextPanel":true,"traceMode":"minimal"}"#
        );
    }

    #[test]
    fn resolves_busy_state_patch() {
        assert_eq!(
            resolve_work_shell_busy_state_patch_json(
                r#"{"isBusy":true,"busyStatus":"thinking","currentTurnStartedAt":123}"#,
            )
            .unwrap(),
            r#"{"busyStatus":"thinking","busyStatusAction":"set","currentTurnStartedAt":123,"currentTurnStartedAtAction":"set","isBusy":true}"#
        );
        assert_eq!(
            resolve_work_shell_busy_state_patch_json(
                r#"{"isBusy":false,"clearCurrentTurnStartedAt":true}"#,
            )
            .unwrap(),
            r#"{"busyStatusAction":"clear","currentTurnStartedAtAction":"clear","isBusy":false}"#
        );
        assert_eq!(
            resolve_work_shell_busy_state_patch_json(r#"{"isBusy":true}"#).unwrap(),
            r#"{"busyStatusAction":"clear","currentTurnStartedAtAction":"keep","isBusy":true}"#
        );
    }

    #[test]
    fn resolves_auth_state_patch() {
        assert_eq!(
            resolve_work_shell_auth_state_patch_json(
                r#"{"authLabel":"oauth-file","authLauncherLines":["Saved auth found."]}"#,
            )
            .unwrap(),
            r#"{"authLabel":"oauth-file","authLauncherLines":["Saved auth found."],"authLauncherLinesAction":"set"}"#
        );
        assert_eq!(
            resolve_work_shell_auth_state_patch_json(r#"{"authLabel":"api-key-env"}"#).unwrap(),
            r#"{"authLabel":"api-key-env","authLauncherLinesAction":"keep"}"#
        );
        assert_eq!(
            resolve_work_shell_auth_state_patch_json(
                r#"{"authLabel":"none","authLauncherLines":[]}"#,
            )
            .unwrap(),
            r#"{"authLabel":"none","authLauncherLines":[],"authLauncherLinesAction":"set"}"#
        );
    }

    #[test]
    fn resolves_initial_state_contract() {
        assert_eq!(
            resolve_work_shell_initial_state_json(
                r#"{"model":"gpt-5.4","mode":"ultrawork","reasoning":{"effort":"high"},"authLabel":"oauth-file"}"#,
            )
            .unwrap(),
            r#"{"authLabel":"oauth-file","authLauncherLines":[],"bridgeLines":[],"busyStatusAction":"clear","composerMode":"default","currentTurnStartedAtAction":"clear","entries":[],"isBusy":false,"lastTurnDurationMsAction":"clear","memoryLines":[],"mode":"ultrawork","model":"gpt-5.4","reasoning":{"effort":"high"},"traceLines":[],"traceMode":"verbose"}"#
        );
        assert_eq!(
            resolve_work_shell_initial_state_json(
                r#"{"model":"gpt-5.4","mode":"default","reasoning":{"effort":"medium"},"authLabel":"api-key-env","initialTraceMode":"verbose"}"#,
            )
            .unwrap(),
            r#"{"authLabel":"api-key-env","authLauncherLines":[],"bridgeLines":[],"busyStatusAction":"clear","composerMode":"default","currentTurnStartedAtAction":"clear","entries":[],"isBusy":false,"lastTurnDurationMsAction":"clear","memoryLines":[],"mode":"default","model":"gpt-5.4","reasoning":{"effort":"medium"},"traceLines":[],"traceMode":"verbose"}"#
        );
    }

    #[test]
    fn resolves_append_entries_patch() {
        assert_eq!(
            resolve_work_shell_append_entries_patch_json(
                r#"{"entries":[{"role":"system","text":"hello"}],"nextEntries":[{"role":"user","text":"world"},{"role":"assistant","text":"done"}]}"#,
            )
            .unwrap(),
            r#"{"entries":[{"role":"system","text":"hello"},{"role":"user","text":"world"},{"role":"assistant","text":"done"}]}"#
        );
        assert_eq!(
            resolve_work_shell_append_entries_patch_json(
                r#"{"entries":[{"role":"system","text":"hello"}],"nextEntries":[]}"#,
            )
            .unwrap(),
            r#"{"entries":[{"role":"system","text":"hello"}]}"#
        );
    }

    #[test]
    fn resolves_mode_default_reasoning() {
        assert_eq!(
            resolve_work_shell_mode_default_reasoning_json(
                r#"{"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}"#,
            )
            .unwrap(),
            r#"{"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}"#
        );
        assert_eq!(
            resolve_work_shell_mode_default_reasoning_json(
                r#"{"effort":"unsupported","source":"model-capability","support":{"status":"unsupported","supportedEfforts":[]}}"#,
            )
            .unwrap(),
            r#"{"effort":"unsupported","source":"model-capability","support":{"status":"unsupported","supportedEfforts":[]}}"#
        );
    }

    #[test]
    fn resolves_dashboard_home_sync_contracts() {
        assert_eq!(
            resolve_work_shell_dashboard_home_patch_json(
                r#"{"authLabel":"oauth-file","bridgeLines":["bridge"],"memoryLines":["memory"]}"#
            )
            .unwrap(),
            r#"{"authLabel":"oauth-file","bridgeLines":["bridge"],"memoryLines":["memory"]}"#
        );
        assert_eq!(
            resolve_work_shell_dashboard_home_sync_state_json(
                r#"{"isBusy":true,"authLabel":"oauth-file","bridgeLines":["bridge"],"memoryLines":["memory"]}"#
            )
            .unwrap(),
            r#"{"authLabel":"oauth-file","bridgeLines":["bridge"],"isBusy":true,"memoryLines":["memory"]}"#
        );
        assert_eq!(
            should_refresh_work_shell_dashboard_home_json(
                r#"{"previous":{"isBusy":true,"authLabel":"oauth-file","bridgeLines":["a"],"memoryLines":[]},"next":{"isBusy":false,"authLabel":"oauth-file","bridgeLines":["a"],"memoryLines":[]}}"#
            )
            .unwrap(),
            r#"{"shouldRefresh":true}"#
        );
        assert_eq!(
            should_refresh_work_shell_dashboard_home_json(
                r#"{"next":{"isBusy":false,"authLabel":"oauth-file","bridgeLines":["a"],"memoryLines":[]}}"#
            )
            .unwrap(),
            r#"{"shouldRefresh":false}"#
        );
        assert_eq!(
            should_refresh_work_shell_dashboard_home_json(
                r#"{"previous":{"isBusy":false,"authLabel":"oauth-file","bridgeLines":["a"],"memoryLines":[]},"next":{"isBusy":false,"authLabel":"api-key-env","bridgeLines":["a"],"memoryLines":[]}}"#
            )
            .unwrap(),
            r#"{"shouldRefresh":true}"#
        );
    }
}
