use crate::{
    http_transport::describe_proxy_policy_fields, mode::mode_label, redaction::redact_secrets,
};
use serde_json::{json, Value};

pub fn build_attachment_preview_lines_json(input_json: &str) -> Result<String, String> {
    let attachments: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid attachment preview JSON: {error}"))?;
    let attachments = attachments
        .as_array()
        .ok_or("Attachment preview JSON must be an array".to_string())?;
    serde_json::to_string(&build_attachment_preview_lines(attachments))
        .map_err(|error| format!("Failed to serialize attachment preview: {error}"))
}

pub fn wrap_display_text_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid wrap display JSON: {error}"))?;
    let text = str_field(&input, "text").unwrap_or_default();
    let width = number_field(&input, "width").unwrap_or(0).max(0) as usize;
    serde_json::to_string(&wrap_display_text(text, width)).map_err(|error| error.to_string())
}

pub fn classify_work_shell_panel_line_json(line: &str) -> Result<String, String> {
    serde_json::to_string(&classify_work_shell_panel_line(line)).map_err(|error| error.to_string())
}

pub fn resolve_work_shell_panel_layout_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid panel layout JSON: {error}"))?;
    let panel_title = str_field(&input, "panelTitle").unwrap_or_default();
    let input_value = str_field(&input, "inputValue").unwrap_or_default();
    let display_mode = str_field(&input, "displayMode")
        .map(ToString::to_string)
        .unwrap_or_else(|| resolve_panel_display_mode(panel_title, input_value).to_string());
    let placement = if display_mode == "side" {
        "side"
    } else {
        "bottom"
    };
    let anchor = if display_mode == "side" {
        "with-conversation"
    } else {
        "after-composer"
    };
    let min_height = resolve_bottom_drawer_min_height(&display_mode, panel_title, input_value);
    serde_json::to_string(&json!({
        "borderColorRole": resolve_panel_border_color_role(input_value, panel_title),
        "displayMode": display_mode,
        "placement": placement,
        "anchor": anchor,
        "bottomDrawerMinHeight": min_height,
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_entry_presentation_json(role: &str) -> Result<String, String> {
    serde_json::to_string(&resolve_work_shell_entry_presentation(role))
        .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_attachment_layout_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid attachment layout JSON: {error}"))?;
    let line_index = number_field(&input, "lineIndex").unwrap_or(0);
    serde_json::to_string(&json!({
        "composerHintMinHeight": 1,
        "attachmentPlacement": "after-composer",
        "attachmentMinHeight": 4,
        "attachmentLineColorRole": resolve_attachment_line_color_role(line_index),
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_viewport_layout_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid viewport layout JSON: {error}"))?;
    let panel_placement = str_field(&input, "panelPlacement").unwrap_or("bottom");
    let terminal_columns = number_field(&input, "terminalColumns").unwrap_or(96).max(0);
    let available_columns = if panel_placement == "side" {
        ((terminal_columns as f64) * 0.62).floor() as i64
    } else {
        terminal_columns - 6
    };
    let conversation_width = available_columns.max(32);
    let dock_width = (terminal_columns - 4).max(32);
    serde_json::to_string(&json!({
        "conversationWidth": conversation_width,
        "dockWidth": dock_width,
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_work_shell_composer_dock_layout_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid composer dock layout JSON: {error}"))?;
    let input_value = str_field(&input, "inputValue").unwrap_or_default();
    let dock_width = number_field(&input, "dockWidth").unwrap_or(92).max(32) as usize;
    let attachment_count = number_field(&input, "attachmentCount");
    let footer_line = str_field(&input, "footerLine").unwrap_or_default();
    let divider = "─".repeat(dock_width);
    serde_json::to_string(&json!({
        "accentColorRole": if input_value.trim_start().starts_with('/') { "user" } else { "borderStrong" },
        "attachmentBadgeColorRole": if attachment_count.is_some_and(|count| count >= 5) { "warning" } else { "textDim" },
        "topDivider": divider,
        "bottomDivider": divider,
        "footerLine": pad_display_width(footer_line, dock_width),
    }))
    .map_err(|error| error.to_string())
}

pub fn build_work_shell_transition_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid work-shell transition JSON: {error}"))?;
    let value = match str_field(&input, "kind").unwrap_or_default() {
        "workspace-reload-start" => json!([
            {
                "role": "user",
                "text": str_field(&input, "line").unwrap_or("/reload")
            },
            {
                "role": "system",
                "text": "Reloading workspace context…"
            }
        ]),
        "workspace-reload-complete" => json!({
            "role": "system",
            "text": "Workspace context reloaded."
        }),
        "sensitive-input-cancel" => json!([
            {
                "role": "system",
                "text": "API key entry canceled."
            }
        ]),
        _ => {
            return Err(
                "Usage: unclecode rust ux text work-shell-transition with kind workspace-reload-start|workspace-reload-complete|sensitive-input-cancel"
                    .to_string(),
            )
        }
    };
    serde_json::to_string(&value).map_err(|error| error.to_string())
}

pub fn format_inline_image_support_line_from_env<F>(mut env: F) -> String
where
    F: FnMut(&str) -> Option<String>,
{
    match detect_terminal_inline_image_protocol(&mut env) {
        Some("iterm") => {
            "iTerm inline preview paused while typing to prevent ghosting.".to_string()
        }
        Some("kitty") => {
            "Kitty inline preview paused while typing to prevent ghosting.".to_string()
        }
        _ => "Preview unavailable in this terminal.".to_string(),
    }
}

pub fn build_terminal_inline_image_sequence_json<F>(
    attachment_json: &str,
    mut env: F,
) -> Result<Option<String>, String>
where
    F: FnMut(&str) -> Option<String>,
{
    let attachment: Value = serde_json::from_str(attachment_json)
        .map_err(|error| format!("Invalid terminal image attachment JSON: {error}"))?;
    let payload = str_field(&attachment, "dataUrl")
        .and_then(|value| value.split_once(',').map(|(_, payload)| payload))
        .unwrap_or_default();
    if payload.is_empty() {
        return Ok(None);
    }

    let protocol = detect_terminal_inline_image_protocol(&mut env);
    if protocol == Some("iterm") {
        let display_name = str_field(&attachment, "displayName").unwrap_or_default();
        return Ok(Some(format!(
            "\u{1b}]1337;File=name={};inline=1:{payload}\u{7}",
            base64_encode(display_name.as_bytes())
        )));
    }
    if protocol == Some("kitty") {
        return Ok(Some(format!("\u{1b}_Gf=100,a=T,t=d;{payload}\u{1b}\\")));
    }

    Ok(None)
}

fn build_attachment_preview_lines(attachments: &[Value]) -> Vec<String> {
    let mut lines = vec![format_attachment_badge_line(attachments)];
    lines.extend(
        attachments
            .iter()
            .take(3)
            .enumerate()
            .map(|(index, attachment)| {
                format!(
                    "{}. {} · {}",
                    index + 1,
                    str_field(attachment, "displayName").unwrap_or_default(),
                    str_field(attachment, "mimeType").unwrap_or_default()
                )
            }),
    );
    lines
}

fn format_attachment_badge_line(attachments: &[Value]) -> String {
    let names = attachments
        .iter()
        .map(|attachment| str_field(attachment, "displayName").unwrap_or_default())
        .collect::<Vec<_>>()
        .join(", ");
    format!("Attachments {} · {names}", attachments.len())
}

fn classify_work_shell_panel_line(line: &str) -> Value {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return json!({ "kind": "blank", "trimmed": trimmed });
    }
    if is_panel_section_header(trimmed) {
        return json!({ "kind": "section", "trimmed": trimmed });
    }
    if let Some(tree) = parse_tree_line(line) {
        return tree;
    }
    if let Some(suggestion) = parse_suggestion_line(line) {
        return suggestion;
    }
    if trimmed.starts_with("› /") {
        return json!({ "kind": "selected-command", "trimmed": trimmed });
    }
    if trimmed.starts_with('/') {
        return json!({ "kind": "command", "trimmed": trimmed });
    }
    if let Some(fact) = parse_panel_fact_line(trimmed) {
        return fact;
    }
    if trimmed.starts_with("Signed in · ") {
        return json!({ "kind": "signed-in", "trimmed": trimmed });
    }
    if trimmed == "Not signed in yet" || trimmed == "Not signed in" {
        return json!({ "kind": "not-signed-in", "trimmed": trimmed });
    }
    if trimmed.starts_with("Browser OAuth needs refresh")
        || trimmed.starts_with("Browser OAuth unavailable")
    {
        return json!({ "kind": "warning", "trimmed": trimmed });
    }
    if trimmed.starts_with("Tip · ") {
        return json!({ "kind": "tip", "trimmed": trimmed });
    }
    if trimmed.starts_with("↑↓") || trimmed.starts_with("No slash") {
        return json!({ "kind": "hint-warning", "trimmed": trimmed });
    }
    if trimmed.starts_with("Matches for ") || trimmed.ends_with(" matches") {
        return json!({ "kind": "match-summary", "trimmed": trimmed });
    }
    if line.starts_with("  ") {
        return json!({ "kind": "indent", "line": line, "trimmed": trimmed });
    }
    json!({ "kind": "text", "line": line, "trimmed": trimmed })
}

fn is_panel_section_header(value: &str) -> bool {
    matches!(
        value,
        "Workspace"
            | "Snapshot"
            | "Issues"
            | "Guidance"
            | "Bridge"
            | "Memory"
            | "Live steps"
            | "Current"
            | "Available"
            | "Choose"
            | "Controls"
            | "Routes"
            | "Next"
            | "Backlog"
            | "Steer"
    )
}

fn parse_tree_line(line: &str) -> Option<Value> {
    let trimmed = line.trim_start();
    let branch = trimmed.chars().next()?;
    if branch != '├' && branch != '└' {
        return None;
    }
    let rest = trimmed[branch.len_utf8()..].strip_prefix(' ')?;
    let (label, spacing, value) = split_label_spacing_value(rest)?;
    Some(json!({
        "kind": "tree",
        "branch": branch.to_string(),
        "label": label.trim(),
        "spacing": spacing,
        "value": value,
    }))
}

fn parse_suggestion_line(line: &str) -> Option<Value> {
    let marker = line.chars().next()?;
    if marker != '›' && marker != ' ' {
        return None;
    }
    let rest = line[marker.len_utf8()..].strip_prefix(' ')?;
    if !rest.starts_with('/') {
        return None;
    }
    let (command, spacing, description) = split_label_spacing_value(rest)?;
    Some(json!({
        "kind": "suggestion",
        "marker": marker.to_string(),
        "command": command,
        "spacing": spacing,
        "description": description,
        "isSelected": marker == '›',
        "isWarning": is_work_shell_warning_line(description),
    }))
}

fn split_label_spacing_value(value: &str) -> Option<(&str, &str, &str)> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b' ' {
            let start = index;
            while index < bytes.len() && bytes[index] == b' ' {
                index += 1;
            }
            if index - start >= 2 {
                return Some((&value[..start], &value[start..index], &value[index..]));
            }
        } else {
            index += 1;
        }
    }
    None
}

fn parse_panel_fact_line(line: &str) -> Option<Value> {
    if line.starts_with('/') {
        return None;
    }
    let (label, value) = line.split_once(" · ")?;
    if label.is_empty()
        || !label
            .chars()
            .all(|ch| ch.is_ascii_alphabetic() || ch == ' ')
        || !label
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase())
    {
        return None;
    }
    Some(json!({
        "kind": "fact",
        "label": label,
        "value": value,
        "isWarning": is_work_shell_warning_line(line),
    }))
}

fn resolve_panel_border_color_role(input_value: &str, panel_title: &str) -> &'static str {
    if input_value.trim().starts_with('/') {
        return "user";
    }
    match panel_title {
        "Auth" => "assistant",
        "Commands" | "Models" | "Model picker" => "borderStrong",
        _ => "border",
    }
}

fn resolve_panel_display_mode(panel_title: &str, _input_value: &str) -> &'static str {
    match panel_title {
        "Context" => "hidden",
        "Context expanded" => "overlay",
        _ => "bottom",
    }
}

fn resolve_bottom_drawer_min_height(
    display_mode: &str,
    panel_title: &str,
    input_value: &str,
) -> u64 {
    if display_mode != "bottom" {
        return 0;
    }
    if input_value.trim().starts_with('/') {
        return 6;
    }
    if matches!(
        panel_title,
        "Commands"
            | "Auth"
            | "Models"
            | "Model picker"
            | "Session status"
            | "Doctor"
            | "Mode"
            | "MCP"
    ) {
        return 6;
    }
    0
}

fn resolve_work_shell_entry_presentation(role: &str) -> Value {
    let (margin_bottom, padding_left, border_style) = match role {
        "assistant" => (1, 2, "single"),
        "tool" | "system" => (0, 3, "single"),
        _ => (1, 0, "single"),
    };
    let presentation = match role {
        "user" => json!({
            "label": "You",
            "badge": "◇",
            "labelColor": "#0a3069",
            "labelTextColor": "#0d1117",
            "labelBackgroundColor": "#ddf4ff",
            "railColor": "#0d1117",
            "borderColor": "#30363d",
            "bodyColor": "#0d1117",
        }),
        "assistant" => json!({
            "label": "UncleCode",
            "badge": "◈",
            "labelColor": "#0d1117",
            "labelTextColor": "#0d1117",
            "labelBackgroundColor": "#dafbe1",
            "railColor": "#0a3069",
            "borderColor": "#30363d",
            "bodyColor": "#0d1117",
        }),
        "tool" => json!({
            "label": "Trace · execution",
            "badge": "▸",
            "labelColor": "#033a16",
            "railColor": "#475569",
            "borderColor": "#30363d",
            "bodyColor": "#0d1117",
        }),
        _ => json!({
            "label": "System · state",
            "badge": "·",
            "labelColor": "#475569",
            "railColor": "#475569",
            "borderColor": "#30363d",
            "bodyColor": "#0d1117",
        }),
    };
    json!({
        "presentation": presentation,
        "layout": {
            "marginBottom": margin_bottom,
            "paddingLeft": padding_left,
            "hasBorder": false,
        },
        "borderStyle": border_style,
    })
}

fn resolve_attachment_line_color_role(line_index: i64) -> &'static str {
    match line_index {
        0 => "user",
        1 => "text",
        _ => "textMuted",
    }
}

fn detect_terminal_inline_image_protocol<F>(env: &mut F) -> Option<&'static str>
where
    F: FnMut(&str) -> Option<String>,
{
    let term_program = env("TERM_PROGRAM").unwrap_or_default();
    if term_program == "iTerm.app" {
        return Some("iterm");
    }
    let term = env("TERM").unwrap_or_default();
    if term.contains("kitty")
        || env("KITTY_WINDOW_ID").is_some_and(|value| !value.is_empty())
        || term_program == "ghostty"
        || term_program == "WezTerm"
    {
        return Some("kitty");
    }
    None
}

pub fn format_trace_line_json(input_json: &str) -> Result<String, String> {
    let event: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid trace event JSON: {error}"))?;
    Ok(format_trace_line(&event))
}

pub fn format_work_shell_error_message(message: &str) -> String {
    let has_route = message
        .lines()
        .any(|line| line.trim_start().starts_with("Route · "));
    let provider_status_failure = is_provider_status_failure(message);
    if provider_status_failure && has_route {
        if has_model_request_scope_error(message) {
            return format!(
                "OpenAI OAuth lacks model.request scope for API calls. Use `unclecode auth login --api-key-stdin`, set OPENAI_API_KEY, or use browser OAuth with OPENAI_OAUTH_CLIENT_ID.\n{message}"
            );
        }
        if let Some(provider) = provider_auth_failure_label(message) {
            return format!(
                "{}\n{message}",
                provider_auth_failure_message(provider, false)
            );
        }
        return message.to_string();
    }
    if has_model_request_scope_error(message) {
        return "OpenAI OAuth lacks model.request scope for API calls. Use `unclecode auth login --api-key-stdin`, set OPENAI_API_KEY, or use browser OAuth with OPENAI_OAUTH_CLIENT_ID."
            .to_string();
    }
    if let Some(provider) = provider_auth_failure_label(message) {
        return provider_auth_failure_message(provider, true);
    }
    if is_missing_oauth_client_id(message) {
        return "Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID.".to_string();
    }
    message.to_string()
}

pub fn is_work_shell_warning_line(line: &str) -> bool {
    let normalized = line.trim().to_ascii_lowercase();
    normalized.contains("unsupported")
        || normalized.contains("unavailable")
        || normalized.contains("needs refresh")
        || normalized.contains("lacks")
        || normalized.starts_with("warning ·")
}

pub fn format_work_shell_provider_title(provider: &str) -> String {
    match provider {
        "openai" => "UncleCode · OpenAI".to_string(),
        "gemini" => "UncleCode · Gemini".to_string(),
        "anthropic" => "UncleCode · Anthropic".to_string(),
        _ => format!("UncleCode · {provider}"),
    }
}

pub fn format_runtime_label_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid runtime label JSON: {error}"))?;
    Ok(format_runtime_label(
        str_field(&input, "node").unwrap_or_default(),
        str_field(&input, "platform").unwrap_or_default(),
        str_field(&input, "arch").unwrap_or_default(),
    ))
}

pub fn format_runtime_label(node: &str, platform: &str, arch: &str) -> String {
    format!("Node {node} · {platform}/{arch}")
}

pub fn work_shell_empty_conversation_hint() -> &'static str {
    "Type a task, /context to see what gets sent, @file to attach."
}

pub fn work_shell_composer_hint_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid composer hint JSON: {error}"))?;
    let input_value = str_field(&input, "inputValue").unwrap_or_default();
    let slash_suggestion_count = number_field(&input, "slashSuggestionCount").unwrap_or(0);
    let hint = work_shell_composer_hint(input_value, slash_suggestion_count);
    serde_json::to_string(&json!({ "hint": hint })).map_err(|error| error.to_string())
}

pub fn work_shell_composer_hint(input_value: &str, slash_suggestion_count: i64) -> &'static str {
    let trimmed = input_value.trim();
    if trimmed.starts_with('/') {
        if trimmed.starts_with("/model") {
            if slash_suggestion_count > 0 {
                return "↑↓ choose · Enter switch · type to filter · Esc cancel";
            }
            return "No exact model match";
        }
        if slash_suggestion_count > 0 {
            return "↑↓ select · Enter run · Esc cancel";
        }
        return "No matches";
    }
    if trimmed.is_empty() {
        return "Enter send · Shift+Enter newline · / commands";
    }
    "Enter send · Shift+Enter newline"
}

pub fn format_work_shell_thinking_line(reasoning_label: &str) -> String {
    format!(
        "Reasoning · {}",
        humanize_work_shell_reasoning_label(reasoning_label)
    )
}

pub fn format_work_shell_status_line_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work-shell status JSON: {error}"))?;
    Ok(format_work_shell_status_line(
        str_field(&input, "model").unwrap_or_default(),
        str_field(&input, "mode").unwrap_or_default(),
        str_field(&input, "authLabel").unwrap_or_default(),
    ))
}

pub fn format_work_shell_status_line(model: &str, mode: &str, auth_label: &str) -> String {
    format!(
        "{model} · {} · {} · work context",
        format_work_shell_mode_label(mode),
        compact_work_shell_auth_label(auth_label)
    )
}

pub fn format_work_shell_usage_line_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work-shell usage JSON: {error}"))?;
    Ok(format_work_shell_usage_line(
        bool_field(&input, "isBusy"),
        str_field(&input, "busyStatus"),
        number_field(&input, "currentTurnStartedAt"),
        number_field(&input, "lastTurnDurationMs"),
        number_field(&input, "nowMs"),
    ))
}

pub fn format_work_shell_usage_line(
    is_busy: bool,
    busy_status: Option<&str>,
    current_turn_started_at: Option<i64>,
    last_turn_duration_ms: Option<i64>,
    now_ms: Option<i64>,
) -> String {
    let activity = if is_busy { "Working now" } else { "Ready" };
    let usage = if is_busy {
        match current_turn_started_at {
            Some(started_at) => format!(
                "elapsed {}",
                format_compact_duration((now_ms.unwrap_or(started_at) - started_at).max(0))
            ),
            None => "elapsed now".to_string(),
        }
    } else {
        match last_turn_duration_ms {
            Some(duration) => format!("last reply {}", format_compact_duration(duration)),
            None => "no reply yet".to_string(),
        }
    };
    let detail = if is_busy {
        busy_status
            .map(normalize_status_detail)
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    [Some(activity.to_string()), Some(usage), detail]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}

pub fn format_work_shell_footer_line_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work-shell footer JSON: {error}"))?;
    Ok(format_work_shell_footer_line(
        str_field(&input, "cwd"),
        str_field(&input, "home"),
        str_field(&input, "model").unwrap_or_default(),
        str_field(&input, "mode").unwrap_or_default(),
        str_field(&input, "authLabel").unwrap_or_default(),
        str_field(&input, "contextIndicator"),
        str_field(&input, "composerHint"),
        number_field(&input, "width").map(|value| value.max(0) as usize),
    ))
}

pub fn format_work_shell_footer_line(
    cwd: Option<&str>,
    home: Option<&str>,
    model: &str,
    mode: &str,
    auth_label: &str,
    context_indicator: Option<&str>,
    composer_hint: Option<&str>,
    width: Option<usize>,
) -> String {
    let path = compact_work_shell_path(cwd, home);
    let full_status_line = format_work_shell_status_line(model, mode, auth_label);
    let full_core_footer = [path.clone(), Some(full_status_line.clone())]
        .into_iter()
        .flatten()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("  ·  ");
    let full_preview_footer = [
        Some(full_core_footer),
        context_indicator
            .map(str::to_string)
            .filter(|value| !value.is_empty()),
        composer_hint
            .map(str::to_string)
            .filter(|value| !value.is_empty()),
    ]
    .into_iter()
    .flatten()
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>()
    .join("  ·  ");
    let status_line = if width.is_some_and(|value| display_width(&full_preview_footer) > value) {
        full_status_line.replace(" · work context", " · context")
    } else {
        full_status_line
    };
    let core_footer = [path.clone(), Some(status_line.clone())]
        .into_iter()
        .flatten()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("  ·  ");
    let full_footer = [
        Some(core_footer.clone()),
        context_indicator
            .map(str::to_string)
            .filter(|value| !value.is_empty()),
        composer_hint
            .map(str::to_string)
            .filter(|value| !value.is_empty()),
    ]
    .into_iter()
    .flatten()
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>()
    .join("  ·  ");
    let context_footer = [
        Some(status_line.clone()),
        context_indicator
            .map(str::to_string)
            .filter(|value| !value.is_empty()),
    ]
    .into_iter()
    .flatten()
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>()
    .join("  ·  ");
    let cwd_with_context_footer = [path.clone(), Some(context_footer.clone())]
        .into_iter()
        .flatten()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("  ·  ");
    // Overflow fallbacks keep cwd anchored first (footer contract shared
    // with the TS fast path): drop the composer hint, then the context
    // indicator — never the cwd.
    let footer = match width {
        Some(width)
            if display_width(&full_footer) > width
                && !cwd_with_context_footer.is_empty()
                && display_width(&cwd_with_context_footer) <= width =>
        {
            cwd_with_context_footer
        }
        Some(width)
            if display_width(&full_footer) > width && display_width(&core_footer) <= width =>
        {
            core_footer
        }
        _ => full_footer,
    };
    match width {
        Some(width) => truncate_display_width(&footer, width),
        None => footer,
    }
}

fn format_trace_line(event: &Value) -> String {
    match str_field(event, "type").unwrap_or_default() {
        "turn.started" => format!(
            "· thinking {}",
            summarize_prompt(str_field(event, "prompt").unwrap_or_default())
        ),
        "turn.completed" => format!(
            "✓ response {}ms",
            number_field(event, "durationMs").unwrap_or(0)
        ),
        "provider.calling" => format!(
            "→ model {} {}",
            str_field(event, "provider").unwrap_or_default(),
            str_field(event, "model").unwrap_or_default()
        ),
        "provider.route" => format_provider_route_trace(event),
        "tool.started" => format!(
            "→ {} {}",
            tool_display_name(str_field(event, "toolName").unwrap_or_default()),
            summarize_tool_input(
                str_field(event, "toolName").unwrap_or_default(),
                event.get("input").unwrap_or(&Value::Null)
            )
        )
        .trim()
        .to_string(),
        "tool.completed" => format_completed_tool_trace(event),
        "orchestrator.step" => format_orchestrator_step(event),
        "bridge.published" => format!(
            "↔ context saved {}",
            summarize_text(str_field(event, "summary").unwrap_or_default())
        ),
        "memory.written" => format!(
            "★ {} memory saved {}",
            str_field(event, "scope").unwrap_or_default(),
            summarize_text(str_field(event, "summary").unwrap_or_default())
        ),
        "policy.denied" => format_policy_denied_trace(event),
        "attachment.attached" | "attachment.dropped" => format_attachment_trace_line(event),
        "reasoning.delta" => {
            let delta = summarize_text(str_field(event, "delta").unwrap_or_default());
            if is_low_signal_reasoning_delta(&delta) {
                return String::new();
            }
            let prefix = if str_field(event, "kind") == Some("summary") {
                "✦ thinking·"
            } else {
                "✦ reasoning·"
            };
            format!("{prefix} {delta}")
        }
        _ => String::new(),
    }
}

fn format_completed_tool_trace(event: &Value) -> String {
    let tool_name = str_field(event, "toolName").unwrap_or_default();
    let subject =
        describe_completed_tool_subject(tool_name, event.get("input").unwrap_or(&Value::Null));
    let duration_ms = number_field(event, "durationMs").unwrap_or(0);
    if !bool_field(event, "isError") {
        return format!("✓ {subject} · {duration_ms}ms");
    }

    let diagnostic = summarize_completed_tool_error(event);
    if diagnostic.is_empty() {
        format!("✖ {subject} · {duration_ms}ms")
    } else {
        format!("✖ {subject} · {duration_ms}ms · {diagnostic}")
    }
}

fn describe_completed_tool_subject(tool_name: &str, input: &Value) -> String {
    match tool_name {
        "read_file" => input_display_value(input, "path")
            .map(|path| format!("read {path}"))
            .unwrap_or_else(|| "read".to_string()),
        "list_files" => input_display_value(input, "path")
            .map(|path| format!("listed {path}"))
            .unwrap_or_else(|| "listed files".to_string()),
        "write_file" => input_display_value(input, "path")
            .map(|path| format!("wrote {path}"))
            .unwrap_or_else(|| "wrote file".to_string()),
        "delete_file" => input_display_value(input, "path")
            .map(|path| format!("deleted {path}"))
            .unwrap_or_else(|| "deleted file".to_string()),
        "search_text" => {
            let query = input_display_value(input, "query").unwrap_or_else(|| "text".to_string());
            match input_display_value(input, "path") {
                Some(path) => format!("search {query} in {path}"),
                None => format!("search {query}"),
            }
        }
        "run_shell" => input_display_value(input, "command")
            .map(|command| format!("$ {command}"))
            .unwrap_or_else(|| "bash".to_string()),
        _ => tool_display_name(tool_name).to_string(),
    }
}

fn input_display_value(input: &Value, key: &str) -> Option<String> {
    str_field(input, key)
        .map(redact_secrets)
        .map(|value| truncate_display_width(&value, 72))
        .filter(|value| !value.is_empty())
}

fn summarize_completed_tool_error(event: &Value) -> String {
    let output = event
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let first_line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    summarize_text(&redact_secrets(first_line))
}

fn format_policy_denied_trace(event: &Value) -> String {
    let capability = str_field(event, "capability").unwrap_or("capability");
    let tool = str_field(event, "toolName")
        .filter(|value| !value.is_empty())
        .map(|value| format!("/{value}"))
        .unwrap_or_default();
    let runtime = str_field(event, "runtimeMode")
        .filter(|value| !value.is_empty())
        .map(|value| format!(" · {value}"))
        .unwrap_or_default();
    let reason = str_field(event, "reason")
        .or_else(|| str_field(event, "matchedRule"))
        .unwrap_or("blocked by execution policy");
    format!(
        "✖ policy denied {capability}{tool}{runtime} · {}",
        summarize_text(reason)
    )
}

fn is_low_signal_reasoning_delta(delta: &str) -> bool {
    let normalized = delta
        .trim()
        .trim_matches(|character: char| matches!(character, '.' | '…'))
        .to_ascii_lowercase();
    matches!(normalized.as_str(), "" | "thinking" | "reasoning")
}

fn format_attachment_trace_line(event: &Value) -> String {
    let size_note = number_field(event, "byteEstimate")
        .filter(|value| *value >= 0)
        .map(|value| format!(" {:.0}kB", (value as f64) / 1024.0))
        .unwrap_or_default();
    let mime = str_field(event, "mimeType")
        .filter(|value| !value.is_empty())
        .map(|value| format!(" {value}"))
        .unwrap_or_default();
    let source = str_field(event, "source").unwrap_or("clipboard");
    if str_field(event, "type") == Some("attachment.attached") {
        return format!("📎 attached {source}{mime}{size_note}");
    }
    let reason = str_field(event, "reason")
        .filter(|value| !value.is_empty())
        .map(|value| format!(" ({value})"))
        .unwrap_or_default();
    format!("📎 dropped {source}{mime}{size_note}{reason}")
}

fn format_provider_route_trace(event: &Value) -> String {
    if let Some(error) = str_field(event, "error")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("↗ route unavailable {}", summarize_text(error));
    }

    let label = str_field(event, "label")
        .unwrap_or_else(|| str_field(event, "provider").unwrap_or("provider"));
    let transport = str_field(event, "transport").unwrap_or("unknown");
    let endpoint = str_field(event, "endpointUrl").unwrap_or_default();
    let proxy = event
        .get("proxyPolicy")
        .map(format_trace_proxy_policy)
        .unwrap_or_else(|| "proxy unknown".to_string());
    format!(
        "↗ route {} · {} · {}",
        label,
        if endpoint.is_empty() {
            transport
        } else {
            endpoint
        },
        proxy
    )
}

fn format_trace_proxy_policy(proxy: &Value) -> String {
    let target_host = str_field(proxy, "targetHost").unwrap_or("unknown");
    let source = str_field(proxy, "source").unwrap_or("none");
    let no_proxy = proxy
        .get("noProxy")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    describe_proxy_policy_fields(
        target_host,
        source,
        bool_field(proxy, "bypassed"),
        &no_proxy,
        str_field(proxy, "proxyUrl"),
    )
}

fn format_orchestrator_step(event: &Value) -> String {
    let role = str_field(event, "role").unwrap_or_default();
    let status = str_field(event, "status").unwrap_or_default();
    let summary = str_field(event, "summary").unwrap_or_default();
    if role == "turn" || role == "coordinator" || str_field(event, "kind") == Some("span") {
        return String::new();
    }
    if (role == "planner" || role == "reviewer") && status == "completed" {
        return String::new();
    }
    if role == "executor"
        && status == "running"
        && summary.to_ascii_lowercase().starts_with("calling ")
    {
        return format!("→ model {}", summary[8..].trim());
    }
    let duration = number_field(event, "durationMs")
        .map(|value| format!(" {value}ms"))
        .unwrap_or_default();
    if role == "executor" && status == "failed" {
        return format!(
            "✖ action{} {}",
            duration,
            summarize_failure_summary(summary)
        )
        .trim()
        .to_string();
    }
    if role == "executor" && status == "completed" {
        return format!("✓ action{} {}", duration, summarize_text(summary))
            .trim()
            .to_string();
    }

    let prefix = match status {
        "failed" => "✖",
        "completed" => "✓",
        "running" => "→",
        _ => "·",
    };
    let formatted_summary = if status == "failed" {
        summarize_failure_summary(summary)
    } else {
        summarize_text(summary)
    };
    format!("{prefix} {role}{duration} {formatted_summary}")
        .trim()
        .to_string()
}

fn summarize_failure_summary(summary: &str) -> String {
    let stripped = summary
        .strip_prefix("Provider failed:")
        .map(str::trim)
        .unwrap_or(summary);
    if has_model_request_scope_error(stripped) {
        return "OpenAI OAuth lacks model.request scope for API calls. Use `unclecode auth login --api-key-stdin`, set OPENAI_API_KEY, or use browser OAuth with OPENAI_OAUTH_CLIENT_ID.".to_string();
    }
    if let Some(provider) = provider_auth_failure_label(stripped) {
        return provider_auth_failure_message(provider, false);
    }
    summarize_text(stripped)
}

fn is_provider_status_failure(message: &str) -> bool {
    ["OpenAI", "Anthropic", "Gemini"]
        .iter()
        .any(|provider| message.starts_with(&format!("{provider} request failed with status ")))
}

fn has_model_request_scope_error(message: &str) -> bool {
    message.contains("missing_scope") || message.contains("model.request")
}

fn provider_auth_failure_label(message: &str) -> Option<&'static str> {
    ["OpenAI", "Anthropic", "Gemini"]
        .into_iter()
        .find(|provider| {
            message.contains(&format!("{provider} request failed with status 401"))
                || message.contains(&format!("{provider} request failed with status 403"))
        })
}

fn provider_auth_failure_message(provider: &str, saved_hint: bool) -> String {
    match provider {
        "OpenAI" if saved_hint => {
            "OpenAI rejected current auth (401/403). Saved auth may be stale. Run /auth status, /auth login, or /auth logout.".to_string()
        }
        "OpenAI" => {
            "OpenAI rejected current auth (401/403). Run /auth status, /auth login, or /auth logout.".to_string()
        }
        "Anthropic" => {
            "Anthropic rejected current auth (401/403). Check ANTHROPIC_API_KEY or the provider account.".to_string()
        }
        "Gemini" => {
            "Gemini rejected current auth (401/403). Check GEMINI_API_KEY or the provider account.".to_string()
        }
        other => {
            format!("{other} rejected current auth (401/403). Check the provider API key or account.")
        }
    }
}

fn is_missing_oauth_client_id(message: &str) -> bool {
    message.contains("OPENAI_OAUTH_CLIENT_ID is required for OAuth login")
        || message.contains("OPENAI_OAUTH_CLIENT_ID is required for browser login")
        || message.contains("Browser OAuth unavailable")
}

fn tool_display_name(tool_name: &str) -> &str {
    match tool_name {
        "read_file" | "list_files" => "read",
        "write_file" => "write",
        "search_text" => "search",
        "run_shell" => "bash",
        _ => tool_name,
    }
}

fn summarize_tool_input(tool_name: &str, input: &Value) -> String {
    let preferred = match tool_name {
        "read_file" | "write_file" | "list_files" => str_field(input, "path"),
        "search_text" => str_field(input, "query"),
        "run_shell" => str_field(input, "command"),
        _ => None,
    };
    preferred
        .map(ToString::to_string)
        .unwrap_or_else(|| summarize_json(input))
}

pub fn normalize_markdown_display_text(value: &str) -> String {
    let mut output = String::new();
    let mut in_fence = false;
    for line in value.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            output.push_str("  ");
            output.push_str(line);
            output.push('\n');
            continue;
        }
        let without_heading = strip_heading_prefix(line);
        let without_bullet = strip_bullet_prefix(without_heading);
        output.push_str(&strip_inline_markup(&without_bullet));
        output.push('\n');
    }
    if !value.ends_with('\n') {
        output.pop();
    }
    output
}

pub fn normalize_busy_status(value: Option<&str>) -> String {
    let normalized = value
        .unwrap_or("Thinking...")
        .trim_start_matches(|ch: char| matches!(ch, '·' | '→' | '★' | '✓' | '✖' | '↔'))
        .trim();
    if normalized.is_empty() {
        "Thinking...".to_string()
    } else {
        normalized.to_string()
    }
}

fn humanize_work_shell_reasoning_label(reasoning_label: &str) -> String {
    let compact = reasoning_label
        .split_once('(')
        .map(|(value, _)| value)
        .unwrap_or(reasoning_label)
        .trim()
        .to_ascii_lowercase();
    match compact.as_str() {
        "low" => "Light".to_string(),
        "medium" => "Balanced".to_string(),
        "high" => "Deep".to_string(),
        "unsupported" => "Reasoning fixed".to_string(),
        _ => reasoning_label.to_string(),
    }
}

fn compact_work_shell_auth_label(auth_label: &str) -> String {
    match auth_label {
        // OAuth token present but lacks model.request scope — API calls rejected.
        // "needs API key" names the fix instead of the opaque "blocked".
        "OAuth file · API blocked" => "OAuth · needs API key".to_string(),
        "OAuth env · API blocked" => "OAuth · needs API key".to_string(),
        "Browser OAuth · file" => "Saved OAuth".to_string(),
        "Browser OAuth · env" => "OAuth env".to_string(),
        "API key · file" => "Saved API key".to_string(),
        "API key · env" => "API key env".to_string(),
        "Not signed in" => "No auth".to_string(),
        _ => auth_label.to_string(),
    }
}

pub fn format_work_shell_mode_label(mode: &str) -> String {
    mode_label(mode)
}

fn normalize_status_detail(value: &str) -> String {
    let stripped = value
        .trim_start_matches(|ch: char| matches!(ch, '·' | '→' | '★' | '✓' | '✖' | '↔' | '✦'))
        .trim();
    if stripped.is_empty() {
        return String::new();
    }
    let lower = stripped.to_ascii_lowercase();
    if lower.contains("planner") || lower.contains("routing complex") || lower.contains("prepared ")
    {
        return "Planning parallel work".to_string();
    }
    if lower.contains("synthesis") || lower.contains("synthesiz") {
        return "Synthesizing answer".to_string();
    }
    if lower.contains("reviewer") || lower.contains("guardian") {
        return "Reviewing results".to_string();
    }
    if lower.starts_with("read ") || lower.starts_with("write ") || lower.starts_with("search ") {
        return "Reading files".to_string();
    }
    if lower.starts_with("calling ") || lower.starts_with("model ") {
        return stripped
            .replacen("calling ", "Model ", 1)
            .replacen("model ", "Model ", 1)
            .to_string();
    }
    if lower == "thinking" || lower == "thinking..." || lower == "reasoning" {
        return "Thinking".to_string();
    }
    if lower.starts_with("executor") || lower.contains(" parallel ") || lower.contains("task") {
        return "Parallel workers".to_string();
    }
    if looks_like_internal_file_path(stripped) {
        return "Reading files".to_string();
    }
    stripped.to_string()
}

fn looks_like_internal_file_path(value: &str) -> bool {
    value.contains('/') && value.contains('.') && !value.contains(' ')
}

fn format_compact_duration(duration_ms: i64) -> String {
    let duration_ms = duration_ms.max(0);
    if duration_ms < 1000 {
        return format!("{duration_ms}ms");
    }
    if duration_ms < 10_000 {
        return format!("{:.1}s", duration_ms as f64 / 1000.0);
    }
    format!("{}s", duration_ms / 1000)
}

fn compact_work_shell_path(cwd: Option<&str>, home: Option<&str>) -> Option<String> {
    let cwd = cwd.filter(|value| !value.is_empty())?;
    let normalized = match home.filter(|value| !value.is_empty()) {
        Some(home) if cwd.starts_with(home) => format!("~{}", &cwd[home.len()..]),
        _ => cwd.to_string(),
    };
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if normalized.starts_with('~') && parts.len() > 3 {
        return Some(format!("~/{}", parts[parts.len() - 2..].join("/")));
    }
    if !normalized.starts_with('~') && parts.len() > 3 {
        return Some(format!("…/{}", parts[parts.len() - 2..].join("/")));
    }
    Some(normalized)
}

fn strip_heading_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ') {
        return &trimmed[hashes + 1..];
    }
    line
}

fn strip_bullet_prefix(line: &str) -> String {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("- ") {
        return format!("• {rest}");
    }
    line.to_string()
}

fn strip_inline_markup(value: &str) -> String {
    strip_delimited(&strip_delimited(&strip_delimited(value, "`"), "**"), "__")
}

fn strip_delimited(value: &str, delimiter: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
    while let Some(start) = rest.find(delimiter) {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + delimiter.len()..];
        let Some(end) = after_start.find(delimiter) else {
            output.push_str(delimiter);
            output.push_str(after_start);
            return output;
        };
        output.push_str(&after_start[..end]);
        rest = &after_start[end + delimiter.len()..];
    }
    output.push_str(rest);
    output
}

fn summarize_prompt(value: &str) -> String {
    truncate_display_width(value, 52)
}

fn summarize_json(value: &Value) -> String {
    truncate_display_width(&value.to_string(), 60)
}

fn summarize_text(value: &str) -> String {
    truncate_display_width(value, 72)
}

fn wrap_display_text(value: &str, width: usize) -> Vec<String> {
    value
        .split('\n')
        .flat_map(|line| {
            if line.is_empty() {
                vec![String::new()]
            } else {
                wrap_display_line(line, width)
            }
        })
        .collect()
}

fn wrap_display_line(line: &str, width: usize) -> Vec<String> {
    if width == 0 || display_width(line) <= width {
        return vec![line.to_string()];
    }

    let mut output = Vec::new();
    let mut remaining = line.trim_start().to_string();
    while !remaining.is_empty() {
        let chunk = slice_display_width(&remaining, width);
        if chunk.is_empty() {
            break;
        }
        output.push(chunk.trim_end().to_string());
        remaining = remaining[chunk.len()..].trim_start().to_string();
    }
    if output.is_empty() {
        vec![line.to_string()]
    } else {
        output
    }
}

fn slice_display_width(value: &str, max_width: usize) -> &str {
    if max_width == 0 {
        return "";
    }
    let mut width = 0;
    let mut end = 0;
    for (index, ch) in value.char_indices() {
        let ch_width = display_char_width(ch);
        if width + ch_width > max_width {
            break;
        }
        width += ch_width;
        end = index + ch.len_utf8();
    }
    &value[..end]
}

pub(crate) fn display_width(value: &str) -> usize {
    value.chars().map(display_char_width).sum()
}

pub(crate) fn truncate_display_width(value: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    let mut width = 0;
    let mut output = String::new();
    for ch in value.chars() {
        let ch_width = display_char_width(ch);
        if width + ch_width > max_width.saturating_sub(1) {
            while output.ends_with(char::is_whitespace) {
                output.pop();
            }
            output.push('…');
            return output;
        }
        output.push(ch);
        width += ch_width;
    }
    output
}

pub(crate) fn pad_display_width(value: &str, width: usize) -> String {
    let padding = width.saturating_sub(display_width(value));
    format!("{}{}", value, " ".repeat(padding))
}

fn display_char_width(ch: char) -> usize {
    if ch.is_ascii() {
        return 1;
    }
    let code = ch as u32;
    if (0x1100..=0x11ff).contains(&code)
        || (0x2e80..=0xa4cf).contains(&code)
        || (0xac00..=0xd7a3).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
        || (0xfe10..=0xfe6f).contains(&code)
        || (0xff00..=0xff60).contains(&code)
        || (0xffe0..=0xffe6).contains(&code)
    {
        2
    } else {
        1
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);

        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_markdown_for_terminal_display() {
        assert_eq!(
            normalize_markdown_display_text("## Heading\n- `npm run check`\n- **Done**"),
            "Heading\n• npm run check\n• Done"
        );
    }

    #[test]
    fn preserves_fenced_code_blocks_as_readable_terminal_lines() {
        assert_eq!(
            normalize_markdown_display_text("before\n```ts\nconst x = 1;\n```\nafter"),
            "before\n  const x = 1;\nafter"
        );
    }

    #[test]
    fn normalizes_busy_status_prefixes() {
        assert_eq!(
            normalize_busy_status(Some("· thinking inspect repo")),
            "thinking inspect repo"
        );
        assert_eq!(normalize_busy_status(Some("   ")), "Thinking...");
    }

    #[test]
    fn formats_work_shell_error_messages() {
        assert_eq!(
            format_work_shell_error_message("OpenAI request failed with status 401"),
            "OpenAI rejected current auth (401/403). Saved auth may be stale. Run /auth status, /auth login, or /auth logout."
        );
        assert_eq!(
            format_work_shell_error_message(
                r#"OpenAI request failed with status 401: {"error":{"code":"missing_scope","message":"Missing scopes: model.request"}}"#,
            ),
            "OpenAI OAuth lacks model.request scope for API calls. Use `unclecode auth login --api-key-stdin`, set OPENAI_API_KEY, or use browser OAuth with OPENAI_OAUTH_CLIENT_ID."
        );
        assert_eq!(
            format_work_shell_error_message("Anthropic request failed with status 401"),
            "Anthropic rejected current auth (401/403). Check ANTHROPIC_API_KEY or the provider account."
        );
        assert_eq!(
            format_work_shell_error_message("Gemini request failed with status 403"),
            "Gemini rejected current auth (401/403). Check GEMINI_API_KEY or the provider account."
        );
        let routed = [
            "OpenAI request failed with status 401",
            "Route · openai · https://api.openai.com/v1/responses",
            "Proxy · direct to api.openai.com",
            "Auth · rejected credentials; inspect /auth status or refresh login",
            "Retry · 1 attempt; not retryable by default",
        ]
        .join("\n");
        assert_eq!(
            format_work_shell_error_message(&routed),
            format!(
                "OpenAI rejected current auth (401/403). Run /auth status, /auth login, or /auth logout.\n{routed}"
            )
        );
        assert_eq!(
            format_work_shell_error_message("Browser OAuth unavailable in this shell."),
            "Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID."
        );
        assert_eq!(
            format_work_shell_error_message("provider exploded"),
            "provider exploded"
        );
    }

    #[test]
    fn formats_work_shell_chrome_text() {
        assert_eq!(
            format_work_shell_provider_title("openai"),
            "UncleCode · OpenAI"
        );
        assert_eq!(
            format_runtime_label("v22.22.0", "darwin", "arm64"),
            "Node v22.22.0 · darwin/arm64"
        );
        assert_eq!(
            format_runtime_label_json(r#"{"node":"v22","platform":"linux","arch":"x64"}"#).unwrap(),
            "Node v22 · linux/x64"
        );
        assert_eq!(
            work_shell_composer_hint("/model g", 2),
            "↑↓ choose · Enter switch · type to filter · Esc cancel"
        );
        assert_eq!(
            work_shell_composer_hint("/model gkdl", 0),
            "No exact model match"
        );
        assert_eq!(work_shell_composer_hint("/unknown", 0), "No matches");
        assert_eq!(
            work_shell_empty_conversation_hint(),
            "Type a task, /context to see what gets sent, @file to attach."
        );
        assert_eq!(
            format_work_shell_thinking_line("medium (mode-default)"),
            "Reasoning · Balanced"
        );
        assert_eq!(
            format_work_shell_status_line("gpt-5.4", "default", "Browser OAuth · file"),
            "gpt-5.4 · 작업 모드 · Saved OAuth · work context"
        );
        assert_eq!(
            format_work_shell_status_line("gpt-5.4", "default", "OAuth file · API blocked"),
            "gpt-5.4 · 작업 모드 · OAuth · needs API key · work context"
        );
        assert_eq!(
            format_work_shell_usage_line(false, None, None, Some(1480), None),
            "Ready · last reply 1.5s"
        );
        assert_eq!(
            format_work_shell_usage_line(
                true,
                Some("· thinking inspect repo"),
                Some(1000),
                Some(1480),
                Some(2480),
            ),
            "Working now · elapsed 1.5s · thinking inspect repo"
        );
    }

    #[test]
    fn formats_work_shell_footer_with_cjk_width() {
        assert_eq!(
            format_work_shell_footer_line(
                Some("/Users/me/project/unclecode"),
                Some("/Users/me"),
                "gpt-5.4",
                "default",
                "Browser OAuth · file",
                None,
                Some("Enter send · Shift+Enter newline"),
                None,
            ),
            "~/project/unclecode  ·  gpt-5.4 · 작업 모드 · Saved OAuth · work context  ·  Enter send · Shift+Enter newline"
        );
        assert_eq!(
            format_work_shell_footer_line(
                Some("/Users/me/project/엉클코드"),
                Some("/Users/me"),
                "gpt-5.4",
                "default",
                "Browser OAuth · file",
                None,
                Some("하이"),
                Some(20),
            ),
            "~/project/엉클코드…"
        );
        assert_eq!(
            format_work_shell_footer_line(
                Some("/Users/me/project/unclecode"),
                Some("/Users/me"),
                "gpt-5.4",
                "yolo",
                "Browser OAuth · file",
                None,
                Some("Enter send · Shift+Enter newline · / commands"),
                Some(72),
            ),
            "~/project/unclecode  ·  gpt-5.4 · YOLO 모드 · Saved OAuth · context"
        );
        assert_eq!(
            format_work_shell_footer_line(
                Some("/Users/me/project/unclecode"),
                Some("/Users/me"),
                "gpt-5.4",
                "default",
                "Browser OAuth · file",
                Some("context 2 ready · 1 held back"),
                None,
                Some(120),
            ),
            "~/project/unclecode  ·  gpt-5.4 · 작업 모드 · Saved OAuth · work context  ·  context 2 ready · 1 held back"
        );
    }

    #[test]
    fn wraps_display_text_with_cjk_width() {
        assert_eq!(
            wrap_display_text("abc def", 4),
            vec!["abc".to_string(), "def".to_string()]
        );
        assert_eq!(
            wrap_display_text("하이abc", 5),
            vec!["하이a".to_string(), "bc".to_string()]
        );
        assert_eq!(
            wrap_display_text("one\n\n하이 there", 6),
            vec![
                "one".to_string(),
                "".to_string(),
                "하이 t".to_string(),
                "here".to_string()
            ]
        );
        assert_eq!(
            wrap_display_text_json(r#"{"text":"하이abc","width":5}"#).unwrap(),
            r#"["하이a","bc"]"#
        );
    }

    #[test]
    fn classifies_work_shell_panel_lines() {
        assert_eq!(
            classify_work_shell_panel_line_json("Model · gpt-5.4").unwrap(),
            r#"{"isWarning":false,"kind":"fact","label":"Model","value":"gpt-5.4"}"#
        );
        assert_eq!(
            classify_work_shell_panel_line_json("/model gpt-5.4").unwrap(),
            r#"{"kind":"command","trimmed":"/model gpt-5.4"}"#
        );
        assert_eq!(
            classify_work_shell_panel_line_json(
                "  /model gpt-4.1-mini  Warning · reasoning unsupported"
            )
            .unwrap(),
            r#"{"command":"/model gpt-4.1-mini","description":"Warning · reasoning unsupported","isSelected":false,"isWarning":true,"kind":"suggestion","marker":" ","spacing":"  "}"#
        );
        assert_eq!(
            classify_work_shell_panel_line_json("Current").unwrap(),
            r#"{"kind":"section","trimmed":"Current"}"#
        );
        assert!(is_work_shell_warning_line(
            "Warning · reasoning unsupported"
        ));
        assert!(!is_work_shell_warning_line("Provider · openai"));
    }

    #[test]
    fn resolves_work_shell_panel_layout() {
        assert_eq!(
            resolve_work_shell_panel_layout_json(
                r#"{"panelTitle":"Context","inputValue":"plain text"}"#
            )
            .unwrap(),
            r#"{"anchor":"after-composer","borderColorRole":"border","bottomDrawerMinHeight":0,"displayMode":"hidden","placement":"bottom"}"#
        );
        assert_eq!(
            resolve_work_shell_panel_layout_json(
                r#"{"panelTitle":"Context expanded","inputValue":"plain text"}"#
            )
            .unwrap(),
            r#"{"anchor":"after-composer","borderColorRole":"border","bottomDrawerMinHeight":0,"displayMode":"overlay","placement":"bottom"}"#
        );
        assert_eq!(
            resolve_work_shell_panel_layout_json(
                r#"{"panelTitle":"Models","inputValue":"/model"}"#
            )
            .unwrap(),
            r#"{"anchor":"after-composer","borderColorRole":"user","bottomDrawerMinHeight":6,"displayMode":"bottom","placement":"bottom"}"#
        );
        assert_eq!(
            resolve_work_shell_panel_layout_json(
                r#"{"panelTitle":"Session status","inputValue":"plain text","displayMode":"bottom"}"#
            )
            .unwrap(),
            r#"{"anchor":"after-composer","borderColorRole":"border","bottomDrawerMinHeight":6,"displayMode":"bottom","placement":"bottom"}"#
        );
    }

    #[test]
    fn resolves_work_shell_entry_presentation() {
        assert_eq!(
            resolve_work_shell_entry_presentation_json("user").unwrap(),
            r##"{"borderStyle":"single","layout":{"hasBorder":false,"marginBottom":1,"paddingLeft":0},"presentation":{"badge":"◇","bodyColor":"#0d1117","borderColor":"#30363d","label":"You","labelBackgroundColor":"#ddf4ff","labelColor":"#0a3069","labelTextColor":"#0d1117","railColor":"#0d1117"}}"##
        );
        assert_eq!(
            resolve_work_shell_entry_presentation_json("tool").unwrap(),
            r##"{"borderStyle":"single","layout":{"hasBorder":false,"marginBottom":0,"paddingLeft":3},"presentation":{"badge":"▸","bodyColor":"#0d1117","borderColor":"#30363d","label":"Trace · execution","labelColor":"#033a16","railColor":"#475569"}}"##
        );
        assert_eq!(
            resolve_work_shell_entry_presentation_json("assistant").unwrap(),
            r##"{"borderStyle":"single","layout":{"hasBorder":false,"marginBottom":1,"paddingLeft":2},"presentation":{"badge":"◈","bodyColor":"#0d1117","borderColor":"#30363d","label":"UncleCode","labelBackgroundColor":"#dafbe1","labelColor":"#0d1117","labelTextColor":"#0d1117","railColor":"#0a3069"}}"##
        );
        assert_eq!(
            resolve_work_shell_entry_presentation_json("system").unwrap(),
            r##"{"borderStyle":"single","layout":{"hasBorder":false,"marginBottom":0,"paddingLeft":3},"presentation":{"badge":"·","bodyColor":"#0d1117","borderColor":"#30363d","label":"System · state","labelColor":"#475569","railColor":"#475569"}}"##
        );
    }

    #[test]
    fn resolves_work_shell_attachment_layout() {
        assert_eq!(
            resolve_work_shell_attachment_layout_json(r#"{"lineIndex":0}"#).unwrap(),
            r#"{"attachmentLineColorRole":"user","attachmentMinHeight":4,"attachmentPlacement":"after-composer","composerHintMinHeight":1}"#
        );
        assert_eq!(
            resolve_work_shell_attachment_layout_json(r#"{"lineIndex":1}"#).unwrap(),
            r#"{"attachmentLineColorRole":"text","attachmentMinHeight":4,"attachmentPlacement":"after-composer","composerHintMinHeight":1}"#
        );
        assert_eq!(
            resolve_work_shell_attachment_layout_json(r#"{"lineIndex":2}"#).unwrap(),
            r#"{"attachmentLineColorRole":"textMuted","attachmentMinHeight":4,"attachmentPlacement":"after-composer","composerHintMinHeight":1}"#
        );
        assert_eq!(
            resolve_work_shell_attachment_layout_json("").unwrap(),
            r#"{"attachmentLineColorRole":"user","attachmentMinHeight":4,"attachmentPlacement":"after-composer","composerHintMinHeight":1}"#
        );
    }

    #[test]
    fn resolves_work_shell_viewport_layout() {
        assert_eq!(
            resolve_work_shell_viewport_layout_json(
                r#"{"panelPlacement":"bottom","terminalColumns":120}"#
            )
            .unwrap(),
            r#"{"conversationWidth":114,"dockWidth":116}"#
        );
        assert_eq!(
            resolve_work_shell_viewport_layout_json(
                r#"{"panelPlacement":"side","terminalColumns":180}"#
            )
            .unwrap(),
            r#"{"conversationWidth":111,"dockWidth":176}"#
        );
        assert_eq!(
            resolve_work_shell_viewport_layout_json(
                r#"{"panelPlacement":"bottom","terminalColumns":20}"#
            )
            .unwrap(),
            r#"{"conversationWidth":32,"dockWidth":32}"#
        );
        assert_eq!(
            resolve_work_shell_viewport_layout_json(
                r#"{"panelPlacement":"bottom","terminalColumns":240}"#
            )
            .unwrap(),
            r#"{"conversationWidth":234,"dockWidth":236}"#
        );
        assert_eq!(
            resolve_work_shell_viewport_layout_json("").unwrap(),
            r#"{"conversationWidth":90,"dockWidth":92}"#
        );
    }

    #[test]
    fn resolves_work_shell_composer_dock_layout() {
        assert_eq!(
            resolve_work_shell_composer_dock_layout_json(
                r#"{"inputValue":" /model","dockWidth":32,"attachmentCount":5,"footerLine":"하이"}"#
            )
            .unwrap(),
            r#"{"accentColorRole":"user","attachmentBadgeColorRole":"warning","bottomDivider":"────────────────────────────────","footerLine":"하이                            ","topDivider":"────────────────────────────────"}"#
        );
        assert_eq!(
            resolve_work_shell_composer_dock_layout_json(
                r#"{"inputValue":"plain","dockWidth":32,"attachmentCount":1,"footerLine":"ok"}"#
            )
            .unwrap(),
            r#"{"accentColorRole":"borderStrong","attachmentBadgeColorRole":"textDim","bottomDivider":"────────────────────────────────","footerLine":"ok                              ","topDivider":"────────────────────────────────"}"#
        );
    }

    #[test]
    fn formats_trace_lines_for_terminal_display() {
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"orchestrator.step","role":"executor","status":"running","summary":"Calling openai gpt-5.4"}"#
            )
            .unwrap(),
            "→ model openai gpt-5.4"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"tool.started","toolName":"read_file","input":{"path":"README.md"}}"#
            )
            .unwrap(),
            "→ read README.md"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"provider.route","provider":"openai","label":"OpenAI","transport":"native","endpointUrl":"https://api.openai.com/v1/responses","proxyPolicy":{"targetHost":"api.openai.com","proxyUrl":null,"source":"none","bypassed":false,"noProxy":[]}}"#
            )
            .unwrap(),
            "↗ route OpenAI · https://api.openai.com/v1/responses · direct to api.openai.com"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"provider.route","provider":"openai","label":"OpenAI","transport":"native","endpointUrl":"https://api.openai.com/v1/responses","proxyPolicy":{"targetHost":"api.openai.com","proxyUrl":"http://user:secret@proxy.local:8080","source":"HTTPS_PROXY","bypassed":false,"noProxy":[]}}"#
            )
            .unwrap(),
            "↗ route OpenAI · https://api.openai.com/v1/responses · HTTPS_PROXY via http://redacted@proxy.local:8080/"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"attachment.attached","source":"clipboard","mimeType":"image/png","byteEstimate":4096}"#
            )
            .unwrap(),
            "📎 attached clipboard image/png 4kB"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"attachment.dropped","source":"clipboard","reason":"cap-exceeded","byteEstimate":6291456}"#
            )
            .unwrap(),
            "📎 dropped clipboard 6144kB (cap-exceeded)"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"policy.denied","level":"high-signal","capability":"filesystem.write","source":"runtime","reason":"OpenShell runtime requires an explicit filesystem write policy.","matchedRule":"workspace.filesystem.write.openshell.default-deny","runtimeMode":"openshell","toolName":"write_file","startedAt":42}"#
            )
            .unwrap(),
            "✖ policy denied filesystem.write/write_file · openshell · OpenShell runtime requires an explicit filesystem write policy."
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"reasoning.delta","kind":"summary","delta":"thinking"}"#
            )
            .unwrap(),
            ""
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"reasoning.delta","kind":"summary","delta":"inspect repo before editing"}"#
            )
            .unwrap(),
            "✦ thinking· inspect repo before editing"
        );
    }

    #[test]
    fn formats_completed_tool_traces_as_compact_evidence() {
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"tool.completed","toolName":"write_file","input":{"path":"notes.txt","content":"private text"},"output":"Wrote notes.txt","isError":false,"durationMs":12}"#
            )
            .unwrap(),
            "✓ wrote notes.txt · 12ms"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"tool.completed","toolName":"run_shell","input":{"command":"npm test -- work"},"output":"all tests passed\nwith verbose details","isError":false,"durationMs":34}"#
            )
            .unwrap(),
            "✓ $ npm test -- work · 34ms"
        );
        assert_eq!(
            format_trace_line_json(
                r#"{"type":"tool.completed","toolName":"run_shell","input":{"command":"npm test"},"output":"exit 1: syntax error","isError":true,"durationMs":42}"#
            )
            .unwrap(),
            "✖ $ npm test · 42ms · exit 1: syntax error"
        );
    }

    #[test]
    fn compresses_trace_auth_failures() {
        assert!(
            format_trace_line_json(
                r#"{"type":"orchestrator.step","role":"executor","status":"failed","summary":"Provider failed: OpenAI request failed with status 401","durationMs":261}"#
            )
            .unwrap()
            .contains("OpenAI rejected current auth")
        );
    }

    #[test]
    fn builds_attachment_preview_lines_for_terminal_display() {
        assert_eq!(
            build_attachment_preview_lines_json(
                r#"[{"displayName":"a.png","mimeType":"image/png"},{"displayName":"b.jpg","mimeType":"image/jpeg"}]"#
            )
            .unwrap(),
            r#"["Attachments 2 · a.png, b.jpg","1. a.png · image/png","2. b.jpg · image/jpeg"]"#
        );
    }

    #[test]
    fn builds_workspace_reload_transition_entries() {
        assert_eq!(
            build_work_shell_transition_json(
                r#"{"kind":"workspace-reload-start","line":"/reload"}"#
            )
            .unwrap(),
            r#"[{"role":"user","text":"/reload"},{"role":"system","text":"Reloading workspace context…"}]"#
        );
        assert_eq!(
            build_work_shell_transition_json(r#"{"kind":"workspace-reload-complete"}"#).unwrap(),
            r#"{"role":"system","text":"Workspace context reloaded."}"#
        );
    }

    #[test]
    fn builds_sensitive_input_cancel_transition_entries() {
        assert_eq!(
            build_work_shell_transition_json(r#"{"kind":"sensitive-input-cancel"}"#).unwrap(),
            r#"[{"role":"system","text":"API key entry canceled."}]"#
        );
    }

    #[test]
    fn formats_inline_image_support_from_terminal_env() {
        assert_eq!(
            format_inline_image_support_line_from_env(|key| {
                (key == "TERM_PROGRAM").then_some("iTerm.app".to_string())
            }),
            "iTerm inline preview paused while typing to prevent ghosting."
        );
        assert_eq!(
            format_inline_image_support_line_from_env(|key| {
                (key == "TERM_PROGRAM").then_some("ghostty".to_string())
            }),
            "Kitty inline preview paused while typing to prevent ghosting."
        );
    }

    #[test]
    fn builds_terminal_inline_image_sequences() {
        let sequence = build_terminal_inline_image_sequence_json(
            r#"{"displayName":"a.png","dataUrl":"data:image/png;base64,AAAA"}"#,
            |key| (key == "TERM_PROGRAM").then_some("iTerm.app".to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(sequence.contains("1337;File=name=YS5wbmc="));
        assert!(sequence.contains("AAAA"));

        let kitty_sequence = build_terminal_inline_image_sequence_json(
            r#"{"displayName":"a.png","dataUrl":"data:image/png;base64,AAAA"}"#,
            |key| (key == "TERM").then_some("xterm-kitty".to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(kitty_sequence.contains("_G"));
        assert!(kitty_sequence.contains("AAAA"));
    }
}
