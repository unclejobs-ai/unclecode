use serde_json::{json, Value};

const WORK_SHELL_MODE_CYCLE: [&str; 5] = ["default", "yolo", "ultrawork", "analyze", "search"];
const MAX_CLIPBOARD_ATTACHMENT_COUNT: i64 = 5;
const MAX_CLIPBOARD_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

pub fn resolve_work_shell_input_action_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json, "input action")?;
    serde_json::to_string(&resolve_work_shell_input_action(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_submit_action_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json, "submit action")?;
    serde_json::to_string(&resolve_work_shell_submit_action(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_slash_submit_block_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json, "slash submit block")?;
    serde_json::to_string(&resolve_work_shell_slash_submit_block(&input))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_slash_selection_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json, "slash selection")?;
    let selected_index = number_field(&input, "selectedIndex").unwrap_or(0).max(0);
    let suggestion_count = number_field(&input, "suggestionCount").unwrap_or(0).max(0);
    let direction = str_field(&input, "direction");
    let next_index = if suggestion_count <= 0 {
        0
    } else if direction == Some("previous") {
        if selected_index <= 0 {
            suggestion_count - 1
        } else {
            selected_index - 1
        }
    } else if direction == Some("next") {
        (selected_index + 1) % suggestion_count
    } else {
        selected_index.min(suggestion_count - 1)
    };
    serde_json::to_string(&json!({ "selectedIndex": next_index }))
        .map_err(|error| error.to_string())
}

pub fn resolve_clipboard_attachment_cap_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json, "clipboard attachment cap")?;
    let current_count = number_field(&input, "currentCount").unwrap_or(0).max(0);
    let data_url = str_field(&input, "dataUrl").unwrap_or_default();
    let byte_estimate = estimate_data_url_bytes(data_url);

    if current_count >= MAX_CLIPBOARD_ATTACHMENT_COUNT {
        return serde_json::to_string(&json!({
            "accepted": false,
            "status": "failed",
            "reason": format!("clipboard attachment cap reached ({MAX_CLIPBOARD_ATTACHMENT_COUNT} images max — submit or clear before adding more)"),
            "byteEstimate": byte_estimate,
        }))
        .map_err(|error| error.to_string());
    }

    if byte_estimate > MAX_CLIPBOARD_ATTACHMENT_BYTES {
        let mib = byte_estimate as f64 / (1024.0 * 1024.0);
        return serde_json::to_string(&json!({
            "accepted": false,
            "status": "failed",
            "reason": format!("image too large ({mib:.1} MiB — max {} MiB per image)", MAX_CLIPBOARD_ATTACHMENT_BYTES / (1024 * 1024)),
            "byteEstimate": byte_estimate,
        }))
        .map_err(|error| error.to_string());
    }

    serde_json::to_string(&json!({
        "accepted": true,
        "byteEstimate": byte_estimate,
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_attachment_dedup_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "[]"
    } else {
        input_json.trim()
    };
    let items: Vec<Value> = serde_json::from_str(input)
        .map_err(|error| format!("Invalid attachment dedup JSON: {error}"))?;
    let mut seen = Vec::<String>::new();
    let mut out = Vec::<Value>::new();
    for item in items {
        let Some(data_url) = str_field(&item, "dataUrl") else {
            out.push(item);
            continue;
        };
        if seen.iter().any(|seen_url| seen_url == data_url) {
            continue;
        }
        seen.push(data_url.to_string());
        out.push(item);
    }
    serde_json::to_string(&json!({ "attachments": out })).map_err(|error| error.to_string())
}

pub fn resolve_composer_preview_mode_json(input_json: &str) -> Result<String, String> {
    let input = parse_input(input_json, "composer preview mode")?;
    let value = str_field(&input, "value").unwrap_or_default();
    let prompt = value.trim();
    if prompt.is_empty() {
        return serde_json::to_string(&json!({
            "mode": "empty",
            "prompt": "",
            "transcriptText": "",
        }))
        .map_err(|error| error.to_string());
    }

    let mode = if has_file_reference_token(prompt) || has_image_path_token(prompt) {
        "slow"
    } else {
        "fast"
    };
    serde_json::to_string(&json!({
        "mode": mode,
        "prompt": prompt,
        "transcriptText": prompt,
    }))
    .map_err(|error| error.to_string())
}

fn parse_input(input_json: &str, label: &str) -> Result<Value, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    serde_json::from_str(input).map_err(|error| format!("Invalid work-shell {label} JSON: {error}"))
}

fn resolve_work_shell_input_action(input: &Value) -> Value {
    let key = input.get("key").unwrap_or(&Value::Null);
    let value = str_field(input, "value").unwrap_or_default();
    let composer_input = str_field(input, "input").unwrap_or_default();
    let slash_suggestion_count = number_field(input, "slashSuggestionCount").unwrap_or(0);
    let has_slash_suggestions = has_slash_suggestions(composer_input, slash_suggestion_count);

    if bool_field(key, "ctrl") && value == "c" {
        if bool_field(input, "isBusy") {
            return json!({ "type": "interrupt-turn" });
        }
        return json!({ "type": "exit" });
    }

    if bool_field(key, "tab")
        && bool_field(key, "shift")
        && !bool_field(input, "isBusy")
        && !has_slash_suggestions
    {
        return json!({
            "type": "cycle-mode",
            "nextMode": next_work_shell_mode(str_field(input, "currentMode")),
        });
    }

    if bool_field(key, "tab") && has_slash_suggestions {
        return json!({
            "type": "complete-slash",
            "value": format!("{} ", str_field(input, "selectedSlashCommand").unwrap_or(composer_input)),
        });
    }

    if bool_field(key, "upArrow") && has_slash_suggestions {
        return json!({ "type": "move-slash-selection", "direction": "previous" });
    }

    if bool_field(key, "downArrow") && has_slash_suggestions {
        return json!({ "type": "move-slash-selection", "direction": "next" });
    }

    if bool_field(key, "escape") {
        if bool_field(input, "hasSensitiveInput") {
            return json!({ "type": "cancel-sensitive-input" });
        }
        if bool_field(input, "hasSlashPicker") {
            return json!({ "type": "close-slash-picker" });
        }
        if bool_field(input, "hasOverlayOpen") {
            return json!({ "type": "close-overlay" });
        }
        if bool_field(input, "isBusy") {
            return json!({ "type": "interrupt-turn" });
        }
        if !composer_input.trim().is_empty() {
            if bool_field(input, "escapeResetArmed") {
                return json!({ "type": "clear-input" });
            }
            return json!({ "type": "none" });
        }
        if bool_field(input, "hasRequestSessionsView") {
            return json!({ "type": "none" });
        }
        return json!({ "type": "open-engine-sessions" });
    }

    json!({ "type": "none" })
}

fn resolve_work_shell_submit_action(input: &Value) -> Value {
    let line = str_field(input, "value")
        .unwrap_or_default()
        .trim()
        .to_string();
    if line.is_empty() {
        return json!({ "type": "noop" });
    }

    if bool_field(input, "isBusy") {
        return json!({ "type": "submit", "line": line, "clearInput": true });
    }

    // Exact `/auth` opens the WorkShell-owned provider catalog. Its command
    // suggestions remain selectable, but must not replace the launch command.
    if line == "/auth" {
        return json!({ "type": "submit", "line": line, "clearInput": true });
    }

    if str_field(input, "activePanelTitle") == Some("Model picker") && !line.starts_with('/') {
        return json!({
            "type": "submit",
            "line": format!("/model {line}"),
            "clearInput": true
        });
    }

    if bool_field(input, "shouldBlockSlashSubmit") {
        if let Some(selected) =
            str_field(input, "selectedSlashCommand").filter(|value| !value.is_empty())
        {
            return json!({ "type": "submit-suggestion", "line": selected, "clearInput": true });
        }
        return json!({ "type": "noop" });
    }

    json!({ "type": "submit", "line": line, "clearInput": true })
}

fn resolve_work_shell_slash_submit_block(input: &Value) -> Value {
    let normalized = str_field(input, "input").unwrap_or_default().trim();
    let suggestions = input
        .get("suggestions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let has_suggestions = !suggestions.is_empty();

    let should_block = if !normalized.starts_with('/') {
        false
    } else if normalized == "/model" {
        has_suggestions
    } else if normalized.to_ascii_lowercase().starts_with("/model ")
        && exact_suggestion_match(normalized, suggestions)
    {
        false
    } else {
        !bool_field(input, "routeResolved") && has_suggestions
    };

    json!({ "shouldBlock": should_block })
}

fn exact_suggestion_match(normalized: &str, suggestions: &[Value]) -> bool {
    let normalized_lower = normalized.to_ascii_lowercase();
    suggestions.iter().any(|entry| {
        entry
            .get("command")
            .and_then(Value::as_str)
            .map(|command| command.to_ascii_lowercase() == normalized_lower)
            .unwrap_or(false)
    })
}

fn has_slash_suggestions(input: &str, slash_suggestion_count: i64) -> bool {
    input.trim().starts_with('/') && slash_suggestion_count > 0
}

fn next_work_shell_mode(current_mode: Option<&str>) -> &'static str {
    let current_index = current_mode.and_then(|mode| {
        WORK_SHELL_MODE_CYCLE
            .iter()
            .position(|candidate| *candidate == mode)
    });
    let next_index = match current_index {
        Some(index) => (index + 1) % WORK_SHELL_MODE_CYCLE.len(),
        None => 0,
    };
    WORK_SHELL_MODE_CYCLE[next_index]
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn estimate_data_url_bytes(data_url: &str) -> usize {
    let payload = data_url
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(data_url);
    let trailing_pad = payload
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count();
    (payload.len() * 3 / 4).saturating_sub(trailing_pad)
}

fn has_file_reference_token(value: &str) -> bool {
    for (index, ch) in value.char_indices() {
        if ch != '@' {
            continue;
        }
        if index > 0 {
            let previous = value[..index].chars().next_back();
            if !previous.is_some_and(char::is_whitespace) {
                continue;
            }
        }
        let rest = &value[index + ch.len_utf8()..];
        if let Some(stripped) = rest.strip_prefix('"') {
            let quoted = stripped.chars().take_while(|next| *next != '"');
            if quoted.clone().all(|next| next != '\n')
                && quoted.count() > 0
                && stripped.contains('"')
            {
                return true;
            }
            continue;
        }
        if rest
            .chars()
            .next()
            .is_some_and(|next| !next.is_whitespace())
        {
            return true;
        }
    }
    false
}

fn has_image_path_token(value: &str) -> bool {
    value
        .split(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'')
        .filter(|token| !token.is_empty())
        .any(|token| {
            let lower = token.to_ascii_lowercase();
            ["png", "jpg", "jpeg", "gif", "webp", "bmp"]
                .iter()
                .any(|extension| lower.ends_with(&format!(".{extension}")))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_navigation_input_actions() {
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"tab":true},"input":"/auth","slashSuggestionCount":1,"selectedSlashCommand":"/auth status","isBusy":false,"hasRequestSessionsView":false}"#
            )
            .unwrap(),
            r#"{"type":"complete-slash","value":"/auth status "}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"upArrow":true},"input":"/auth","slashSuggestionCount":3,"isBusy":false,"hasRequestSessionsView":false}"#
            )
            .unwrap(),
            r#"{"direction":"previous","type":"move-slash-selection"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"tab":true,"shift":true},"input":"plain text","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":false,"currentMode":"default"}"#
            )
            .unwrap(),
            r#"{"nextMode":"yolo","type":"cycle-mode"}"#
        );
    }

    #[test]
    fn resolves_escape_priority() {
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"secret","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":true,"hasSensitiveInput":true,"hasOverlayOpen":true}"#
            )
            .unwrap(),
            r#"{"type":"cancel-sensitive-input"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"/model","slashSuggestionCount":3,"isBusy":false,"hasRequestSessionsView":true,"hasSlashPicker":true}"#
            )
            .unwrap(),
            r#"{"type":"close-slash-picker"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"plain","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":true,"hasOverlayOpen":true}"#
            )
            .unwrap(),
            r#"{"type":"close-overlay"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"plain","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":true}"#
            )
            .unwrap(),
            r#"{"type":"none"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"plain","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":true,"escapeResetArmed":true}"#
            )
            .unwrap(),
            r#"{"type":"clear-input"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"plain","slashSuggestionCount":0,"isBusy":true,"hasRequestSessionsView":true}"#
            )
            .unwrap(),
            r#"{"type":"interrupt-turn"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"c","key":{"ctrl":true},"input":"plain","slashSuggestionCount":0,"isBusy":true,"hasRequestSessionsView":true}"#
            )
            .unwrap(),
            r#"{"type":"interrupt-turn"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"o","key":{"ctrl":true},"input":"plain","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":true}"#
            )
            .unwrap(),
            r#"{"type":"none"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"\u000f","key":{"ctrl":true},"input":"IME 초안","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":true}"#
            )
            .unwrap(),
            r#"{"type":"none"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"o","key":{"ctrl":true},"input":"plain","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":false}"#
            )
            .unwrap(),
            r#"{"type":"none"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"plain","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":false}"#
            )
            .unwrap(),
            r#"{"type":"none"}"#
        );
        assert_eq!(
            resolve_work_shell_input_action_json(
                r#"{"value":"","key":{"escape":true},"input":"","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":false}"#
            )
            .unwrap(),
            r#"{"type":"open-engine-sessions"}"#
        );
    }

    #[test]
    fn resolves_submit_actions() {
        assert_eq!(
            resolve_work_shell_submit_action_json(
                r#"{"value":"/auth","isBusy":false,"shouldBlockSlashSubmit":true,"selectedSlashCommand":"/auth status"}"#
            )
            .unwrap(),
            r#"{"clearInput":true,"line":"/auth","type":"submit"}"#
        );
        assert_eq!(
            resolve_work_shell_submit_action_json(
                r#"{"value":"ship it","isBusy":true,"shouldBlockSlashSubmit":false}"#
            )
            .unwrap(),
            r#"{"clearInput":true,"line":"ship it","type":"submit"}"#
        );
        assert_eq!(
            resolve_work_shell_submit_action_json(
                r#"{"value":"gkdl","isBusy":false,"shouldBlockSlashSubmit":false,"activePanelTitle":"Model picker"}"#
            )
            .unwrap(),
            r#"{"clearInput":true,"line":"/model gkdl","type":"submit"}"#
        );
        assert_eq!(
            resolve_work_shell_submit_action_json(
                r#"{"value":"   ","isBusy":false,"shouldBlockSlashSubmit":false}"#
            )
            .unwrap(),
            r#"{"type":"noop"}"#
        );
    }

    #[test]
    fn resolves_slash_submit_block_decisions() {
        assert_eq!(
            resolve_work_shell_slash_submit_block_json(
                r#"{"input":"plain","routeResolved":false,"suggestions":[{"command":"/plain","description":"Plain"}]}"#
            )
            .unwrap(),
            r#"{"shouldBlock":false}"#
        );
        assert_eq!(
            resolve_work_shell_slash_submit_block_json(
                r#"{"input":"/model","routeResolved":false,"suggestions":[{"command":"/model gpt-5.5","description":"Current"}]}"#
            )
            .unwrap(),
            r#"{"shouldBlock":true}"#
        );
        assert_eq!(
            resolve_work_shell_slash_submit_block_json(
                r#"{"input":"/model gpt-5.5","routeResolved":false,"suggestions":[{"command":"/model gpt-5.5","description":"Current"}]}"#
            )
            .unwrap(),
            r#"{"shouldBlock":false}"#
        );
        assert_eq!(
            resolve_work_shell_slash_submit_block_json(
                r#"{"input":"/auth","routeResolved":false,"suggestions":[{"command":"/auth status","description":"Show auth"}]}"#
            )
            .unwrap(),
            r#"{"shouldBlock":true}"#
        );
        assert_eq!(
            resolve_work_shell_slash_submit_block_json(
                r#"{"input":"/auth status","routeResolved":true,"suggestions":[{"command":"/auth status","description":"Show auth"}]}"#
            )
            .unwrap(),
            r#"{"shouldBlock":false}"#
        );
    }

    #[test]
    fn resolves_slash_selection_navigation() {
        assert_eq!(
            resolve_work_shell_slash_selection_json(r#"{"selectedIndex":8,"suggestionCount":3}"#)
                .unwrap(),
            r#"{"selectedIndex":2}"#
        );
        assert_eq!(
            resolve_work_shell_slash_selection_json(
                r#"{"selectedIndex":0,"suggestionCount":3,"direction":"previous"}"#
            )
            .unwrap(),
            r#"{"selectedIndex":2}"#
        );
        assert_eq!(
            resolve_work_shell_slash_selection_json(
                r#"{"selectedIndex":2,"suggestionCount":3,"direction":"next"}"#
            )
            .unwrap(),
            r#"{"selectedIndex":0}"#
        );
    }

    #[test]
    fn resolves_clipboard_attachment_caps() {
        assert_eq!(
            resolve_clipboard_attachment_cap_json(
                r#"{"currentCount":0,"dataUrl":"data:image/png;base64,aGVsbG8="}"#
            )
            .unwrap(),
            r#"{"accepted":true,"byteEstimate":5}"#
        );

        let count_rejection = serde_json::from_str::<Value>(
            &resolve_clipboard_attachment_cap_json(
                r#"{"currentCount":5,"dataUrl":"data:image/png;base64,aGVsbG8="}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(count_rejection["accepted"], false);
        assert_eq!(count_rejection["status"], "failed");
        assert!(count_rejection["reason"]
            .as_str()
            .unwrap()
            .contains("5 images max"));

        let oversized = serde_json::from_str::<Value>(
            &resolve_clipboard_attachment_cap_json(&format!(
                r#"{{"currentCount":0,"dataUrl":"data:image/png;base64,{}"}}"#,
                "a".repeat((MAX_CLIPBOARD_ATTACHMENT_BYTES + 1) * 4 / 3 + 8)
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(oversized["accepted"], false);
        assert!(oversized["reason"]
            .as_str()
            .unwrap()
            .contains("image too large"));
    }

    #[test]
    fn resolves_attachment_dedup_by_data_url() {
        let result = resolve_attachment_dedup_json(
            r#"[
                {"dataUrl":"data:image/png;base64,AAAA","displayName":"a.png"},
                {"dataUrl":"data:image/png;base64,AAAA","displayName":"duplicate.png"},
                {"dataUrl":"data:image/png;base64,BBBB","displayName":"b.png"}
            ]"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["attachments"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["attachments"][0]["displayName"], "a.png");
        assert_eq!(parsed["attachments"][1]["displayName"], "b.png");
    }

    #[test]
    fn resolves_composer_preview_mode() {
        assert_eq!(
            resolve_composer_preview_mode_json(r#"{"value":"  plain text  "}"#).unwrap(),
            r#"{"mode":"fast","prompt":"plain text","transcriptText":"plain text"}"#
        );
        assert_eq!(
            resolve_composer_preview_mode_json(r#"{"value":"@README.md 요약"}"#).unwrap(),
            r#"{"mode":"slow","prompt":"@README.md 요약","transcriptText":"@README.md 요약"}"#
        );
        assert_eq!(
            resolve_composer_preview_mode_json(r#"{"value":"attach screenshot.PNG"}"#).unwrap(),
            r#"{"mode":"slow","prompt":"attach screenshot.PNG","transcriptText":"attach screenshot.PNG"}"#
        );
        assert_eq!(
            resolve_composer_preview_mode_json(r#"{"value":"   "}"#).unwrap(),
            r#"{"mode":"empty","prompt":"","transcriptText":""}"#
        );
    }
}
