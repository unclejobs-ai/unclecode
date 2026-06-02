use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessStatus {
    pub config_path: PathBuf,
    pub exists: bool,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub approvals: Option<String>,
    pub trust_level: Option<String>,
    pub multi_agent: bool,
    pub status_line: Vec<String>,
    pub mcp_servers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessApplyChange {
    pub key: String,
    pub value: String,
    pub changed: bool,
}

pub fn inspect_harness_status(cwd: &Path) -> HarnessStatus {
    let config_path = cwd.join(".codex").join("config.toml");
    let content = fs::read_to_string(&config_path).ok();
    let Some(content) = content else {
        return HarnessStatus {
            config_path,
            exists: false,
            model: None,
            reasoning_effort: None,
            approvals: None,
            trust_level: None,
            multi_agent: false,
            status_line: Vec::new(),
            mcp_servers: Vec::new(),
        };
    };

    HarnessStatus {
        config_path,
        exists: true,
        model: parse_toml_string(&content, "model"),
        reasoning_effort: parse_toml_string(&content, "model_reasoning_effort"),
        approvals: parse_toml_string(&content, "approvals_reviewer"),
        trust_level: parse_toml_string(&content, "trust_level"),
        multi_agent: parse_toml_bool(&content, "multi_agent"),
        status_line: parse_toml_string_array(&content, "status_line"),
        mcp_servers: parse_mcp_server_names(&content),
    }
}

pub fn apply_harness_preset(cwd: &Path, preset: &str) -> Result<Vec<HarnessApplyChange>, String> {
    let config_path = cwd.join(".codex").join("config.toml");
    let content = fs::read_to_string(&config_path)
        .map_err(|_| format!("No .codex/config.toml found at {}", config_path.display()))?;
    let patch = harness_preset_patch(preset).ok_or_else(|| {
        format!(
            "Unknown preset: {preset}. Available: {}",
            harness_preset_ids().join(", ")
        )
    })?;

    let mut changes = patch
        .iter()
        .map(|(key, value)| HarnessApplyChange {
            key: (*key).to_string(),
            value: (*value).to_string(),
            changed: false,
        })
        .collect::<Vec<_>>();
    let mut output_lines = Vec::new();
    for line in content.lines() {
        let mut replacement = None;
        for change in &mut changes {
            if toml_line_key(line) == Some(change.key.as_str()) {
                replacement = Some(replace_toml_string_value(line, &change.value));
                change.changed = true;
                break;
            }
        }
        output_lines.push(replacement.unwrap_or_else(|| line.to_string()));
    }

    let mut output = output_lines.join("\n");
    if content.ends_with('\n') {
        output.push('\n');
    }
    fs::write(&config_path, output)
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    Ok(changes)
}

pub fn harness_preset_ids() -> &'static [&'static str] {
    &[
        "yolo",
        "team-coder",
        "team-builder",
        "team-hardener",
        "team-auditor",
        "team-agentless",
    ]
}

pub fn harness_preset_patch(preset: &str) -> Option<&'static [(&'static str, &'static str)]> {
    match preset {
        "yolo" | "team-coder" => Some(&[
            ("model_reasoning_effort", "medium"),
            ("approvals_reviewer", "auto-edit"),
        ]),
        "team-builder" | "team-hardener" => Some(&[
            ("model_reasoning_effort", "high"),
            ("approvals_reviewer", "user"),
        ]),
        "team-auditor" => Some(&[
            ("model_reasoning_effort", "low"),
            ("approvals_reviewer", "user"),
        ]),
        "team-agentless" => Some(&[
            ("model_reasoning_effort", "low"),
            ("approvals_reviewer", "auto-edit"),
        ]),
        _ => None,
    }
}

fn parse_toml_string(content: &str, key: &str) -> Option<String> {
    let prefix = format!("{key} =");
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix(&prefix)?.trim();
        parse_quoted_string(value)
    })
}

fn parse_toml_bool(content: &str, key: &str) -> bool {
    let prefix = format!("{key} =");
    content.lines().any(|line| {
        let trimmed = line.trim();
        let Some(value) = trimmed.strip_prefix(&prefix) else {
            return false;
        };
        value.trim() == "true"
    })
}

fn parse_toml_string_array(content: &str, key: &str) -> Vec<String> {
    let prefix = format!("{key} =");
    content
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            let value = trimmed.strip_prefix(&prefix)?.trim();
            let inner = value.strip_prefix('[')?.strip_suffix(']')?;
            Some(
                inner
                    .split(',')
                    .filter_map(|item| parse_quoted_string(item.trim()))
                    .filter(|item| !item.is_empty())
                    .collect(),
            )
        })
        .unwrap_or_default()
}

fn parse_mcp_server_names(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            trimmed
                .strip_prefix("[mcp_servers.")
                .and_then(|rest| rest.strip_suffix(']'))
                .filter(|name| !name.is_empty())
                .map(ToOwned::to_owned)
        })
        .collect()
}

fn parse_quoted_string(value: &str) -> Option<String> {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.split_once('"'))
        .map(|(value, _)| value.to_owned())
}

fn toml_line_key(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') {
        return None;
    }
    let (key, value) = trimmed.split_once('=')?;
    let key = key.trim();
    if key.is_empty() || !value.trim_start().starts_with('"') {
        return None;
    }
    Some(key)
}

fn replace_toml_string_value(line: &str, value: &str) -> String {
    let Some(equals_index) = line.find('=') else {
        return line.to_string();
    };
    format!("{}= \"{}\"", &line[..equals_index], value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reports_missing_config() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-harness-missing-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let status = inspect_harness_status(&root);

        assert!(!status.exists);
        assert_eq!(status.model, None);
        assert_eq!(status.status_line, Vec::<String>::new());
    }

    #[test]
    fn parses_codex_config_fields() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-harness-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config_dir = root.join(".codex");
        fs::create_dir_all(&config_dir).unwrap();
        fs::write(
            config_dir.join("config.toml"),
            [
                r#"model = "gpt-5.4""#,
                r#"model_reasoning_effort = "high""#,
                r#"approvals_reviewer = "user""#,
                "",
                "[features]",
                "multi_agent = true",
                "",
                "[tui]",
                r#"status_line = ["model-with-reasoning", "git-branch"]"#,
                "",
                "[mcp_servers.workspace_state]",
                r#"command = "node""#,
                "",
                "[mcp_servers.workspace_memory]",
                r#"command = "node""#,
            ]
            .join("\n"),
        )
        .unwrap();

        let status = inspect_harness_status(&root);

        assert!(status.exists);
        assert_eq!(status.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(status.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(status.approvals.as_deref(), Some("user"));
        assert!(status.multi_agent);
        assert_eq!(status.status_line, ["model-with-reasoning", "git-branch"]);
        assert_eq!(status.mcp_servers, ["workspace_state", "workspace_memory"]);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn applies_named_harness_preset() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-harness-apply-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config_dir = root.join(".codex");
        fs::create_dir_all(&config_dir).unwrap();
        fs::write(
            config_dir.join("config.toml"),
            [
                r#"model = "gpt-5.4""#,
                r#"model_reasoning_effort = "high""#,
                r#"approvals_reviewer = "user""#,
                "",
            ]
            .join("\n"),
        )
        .unwrap();

        let changes = apply_harness_preset(&root, "team-agentless").unwrap();
        let status = inspect_harness_status(&root);

        assert!(changes.iter().all(|change| change.changed));
        assert_eq!(status.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(status.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(status.approvals.as_deref(), Some("auto-edit"));

        fs::remove_dir_all(root).unwrap();
    }
}
