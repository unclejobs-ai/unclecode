use crate::ux_panels::{build_ux_panel_json, format_inline_command_summary_json};
use serde_json::{json, Value};

pub fn resolve_inline_command_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid inline command result JSON: {error}"))?;
    let line = input.get("line").and_then(Value::as_str).unwrap_or("");
    let slash_command = string_array_field(&input, "slashCommand");
    let visible_args = redact_inline_command_args(&slash_command);
    let visible_line = redact_inline_command_line(line);
    let result_lines = input
        .get("resultLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let failed = input
        .get("failed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let next_auth_label = input
        .get("nextAuthLabel")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let is_auth_command = slash_command.first().map(String::as_str) == Some("auth");
    let completion_line = format!(
        "{} {}",
        if failed { "✖" } else { "✓" },
        visible_args.join(" ")
    );
    let panel_input = json!({
        "args": visible_args,
        "lines": result_lines,
    });
    let panel = serde_json::from_str::<Value>(&build_ux_panel_json(
        "inline-command",
        &panel_input.to_string(),
    )?)
    .map_err(|error| format!("Invalid inline command panel JSON: {error}"))?;
    let summary = format_inline_command_summary_json(&panel_input.to_string())?;
    let mut patch = json!({
        "authLabel": next_auth_label,
        "panel": panel,
    });
    if is_auth_command {
        patch["authLauncherLines"] = Value::Array(result_lines.clone());
    }

    serde_json::to_string(&json!({
        "visibleLine": visible_line,
        "visibleArgs": visible_args,
        "resultLines": result_lines,
        "completionLine": completion_line,
        "nextAuthLabel": next_auth_label,
        "isAuthCommand": is_auth_command,
        "entries": [
            { "role": "tool", "text": completion_line },
            { "role": "system", "text": summary },
        ],
        "patch": patch,
        "traceLines": [
            format!("→ {}", visible_args.join(" ")),
            completion_line,
        ],
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_inline_command_visibility_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid inline command visibility JSON: {error}"))?;
    let line = input.get("line").and_then(Value::as_str).unwrap_or("");
    let slash_command = string_array_field(&input, "slashCommand");
    let visible_args = redact_inline_command_args(&slash_command);
    let visible_line = redact_inline_command_line(line);
    let is_auth_command = slash_command.first().map(String::as_str) == Some("auth");
    let is_auth_login = slash_command.first().map(String::as_str) == Some("auth")
        && slash_command.get(1).map(String::as_str) == Some("login");

    serde_json::to_string(&json!({
        "visibleLine": visible_line,
        "visibleArgs": visible_args,
        "isAuthCommand": is_auth_command,
        "isAuthLogin": is_auth_login,
    }))
    .map_err(|error| error.to_string())
}

fn string_array_field(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn redact_inline_command_line(line: &str) -> String {
    let args = line
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    redact_inline_command_args(&args).join(" ")
}

fn redact_inline_command_args(args: &[String]) -> Vec<String> {
    let mut redacted = args.to_vec();
    if let Some(index) = redacted.iter().position(|arg| arg == "--api-key") {
        if index + 1 < redacted.len() {
            redacted[index + 1] = "[REDACTED]".to_string();
        }
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_inline_command_result_with_redaction_panel_and_trace() {
        let result = resolve_inline_command_result_json(
            r#"{"line":"/auth login --api-key sk-secret","slashCommand":["auth","login","--api-key","sk-secret"],"resultLines":["OAuth login complete.","Auth: oauth-file"],"failed":false,"nextAuthLabel":"oauth-file"}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["visibleLine"], "/auth login --api-key [REDACTED]");
        assert_eq!(parsed["visibleArgs"][3], "[REDACTED]");
        assert_eq!(
            parsed["completionLine"],
            "✓ auth login --api-key [REDACTED]"
        );
        assert_eq!(parsed["entries"][0]["text"], parsed["completionLine"]);
        assert_eq!(parsed["patch"]["authLabel"], "oauth-file");
        assert_eq!(
            parsed["patch"]["authLauncherLines"][0],
            "OAuth login complete."
        );
        assert_eq!(parsed["patch"]["panel"]["title"], "Auth");
        assert_eq!(parsed["traceLines"][0], "→ auth login --api-key [REDACTED]");
    }

    #[test]
    fn marks_failed_inline_command_completion() {
        let result = resolve_inline_command_result_json(
            r#"{"line":"/doctor","slashCommand":["doctor"],"resultLines":[],"failed":true,"nextAuthLabel":"none"}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["completionLine"], "✖ doctor");
        assert_eq!(parsed["patch"]["panel"]["lines"][0], "No output.");
        assert!(parsed["patch"].get("authLauncherLines").is_none());
    }

    #[test]
    fn resolves_inline_command_visibility() {
        let result = resolve_inline_command_visibility_json(
            r#"{"line":"/auth login --api-key sk-secret","slashCommand":["auth","login","--api-key","sk-secret"]}"#,
        )
        .unwrap();
        assert_eq!(
            result,
            r#"{"isAuthCommand":true,"isAuthLogin":true,"visibleArgs":["auth","login","--api-key","[REDACTED]"],"visibleLine":"/auth login --api-key [REDACTED]"}"#
        );

        let result = resolve_inline_command_visibility_json(
            r#"{"line":"/doctor","slashCommand":["doctor"]}"#,
        )
        .unwrap();
        assert_eq!(
            result,
            r#"{"isAuthCommand":false,"isAuthLogin":false,"visibleArgs":["doctor"],"visibleLine":"/doctor"}"#
        );
    }
}
