use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpHostRegistryEntry {
    pub name: String,
    pub transport: String,
    pub trust_tier: String,
    pub origin_label: String,
}

pub fn load_mcp_host_registry(
    workspace_root: &Path,
    user_home_dir: Option<&Path>,
) -> Result<Vec<McpHostRegistryEntry>, String> {
    let mut merged = BTreeMap::new();
    if let Some(user_home_dir) = user_home_dir {
        for entry in read_mcp_config_file(&user_home_dir.join(".unclecode/mcp.json"), "user")? {
            merged.insert(entry.name.clone(), entry);
        }
    }
    for entry in read_mcp_config_file(&workspace_root.join(".mcp.json"), "project")? {
        merged.insert(entry.name.clone(), entry);
    }
    Ok(merged.into_values().collect())
}

pub fn format_mcp_host_registry(entries: &[McpHostRegistryEntry]) -> String {
    if entries.is_empty() {
        return "MCP servers\nNo MCP servers configured.".to_string();
    }

    let mut lines = vec!["MCP servers".to_string()];
    lines.extend(entries.iter().map(|entry| {
        format!(
            "{} | {} | {} | {}",
            entry.name, entry.transport, entry.trust_tier, entry.origin_label
        )
    }));
    lines.join("\n")
}

fn read_mcp_config_file(path: &Path, scope: &str) -> Result<Vec<McpHostRegistryEntry>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid MCP config {}: {error}", path.display()))?;
    let Some(servers) = parsed.get("mcpServers").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let config_dir = path.parent().unwrap_or_else(|| Path::new("."));
    Ok(servers
        .iter()
        .filter_map(|(name, config)| {
            let transport = config.get("type").and_then(Value::as_str)?.trim();
            if transport.is_empty() {
                return None;
            }
            let transport = transport.to_string();
            let _ = normalize_stdio_paths(config_dir, config);
            Some(McpHostRegistryEntry {
                name: name.to_string(),
                transport,
                trust_tier: trust_tier(scope).to_string(),
                origin_label: origin_label(scope).to_string(),
            })
        })
        .collect())
}

fn normalize_stdio_paths(config_dir: &Path, config: &Value) -> Option<(String, Vec<String>)> {
    if config.get("type").and_then(Value::as_str) != Some("stdio") {
        return None;
    }
    let command = config.get("command").and_then(Value::as_str)?;
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|arg| resolve_config_relative_path(config_dir, arg))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some((resolve_config_relative_path(config_dir, command), args))
}

fn resolve_config_relative_path(config_dir: &Path, value: &str) -> String {
    if Path::new(value).is_absolute() || !value.starts_with('.') {
        return value.to_string();
    }
    config_dir
        .join(PathBuf::from(value))
        .to_string_lossy()
        .to_string()
}

fn origin_label(scope: &str) -> &'static str {
    match scope {
        "project" | "local" => "project config",
        "user" => "user config",
        "enterprise" | "managed" => "managed config",
        "dynamic" => "dynamic config",
        "claudeai" => "claudeai config",
        _ => "unknown config",
    }
}

fn trust_tier(scope: &str) -> &'static str {
    match scope {
        "project" | "local" | "enterprise" | "managed" => "project",
        _ => "user",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn loads_merged_mcp_servers_with_project_precedence() {
        let root = temp_root("mcp");
        let home = root.join("home");
        fs::create_dir_all(home.join(".unclecode")).unwrap();
        fs::write(
            home.join(".unclecode/mcp.json"),
            r#"{"mcpServers":{"memory":{"type":"stdio","command":"node","args":["memory.js"]},"shared":{"type":"stdio","command":"node","args":["user.js"]}}}"#,
        )
        .unwrap();
        fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"shared":{"type":"http","url":"http://localhost:8787/mcp"},"repo":{"type":"stdio","command":"node","args":["repo.js"]}}}"#,
        )
        .unwrap();

        let entries = load_mcp_host_registry(&root, Some(&home)).unwrap();
        let report = format_mcp_host_registry(&entries);

        assert!(report.contains("memory | stdio | user | user config"));
        assert!(report.contains("repo | stdio | project | project config"));
        assert!(report.contains("shared | http | project | project config"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn formats_empty_mcp_registry() {
        assert_eq!(
            format_mcp_host_registry(&[]),
            "MCP servers\nNo MCP servers configured."
        );
    }

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("unclecode-rust-{label}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        root
    }
}
