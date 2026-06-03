use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::redaction::redact_secrets;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpHostRegistryEntry {
    pub name: String,
    pub transport: String,
    pub trust_tier: String,
    pub origin_label: String,
    pub command: Option<String>,
    pub args_count: usize,
    pub env_keys_count: usize,
    pub url: Option<String>,
    pub headers_count: usize,
    pub oauth_configured: bool,
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

pub fn format_mcp_host_inspect(entries: &[McpHostRegistryEntry], server_name: &str) -> String {
    let server_name = server_name.trim();
    if server_name.is_empty() {
        return [
            "MCP server inspect".to_string(),
            "Select an MCP server first.".to_string(),
            "Health: not checked by inspect.".to_string(),
        ]
        .join("\n");
    }

    let Some(entry) = entries.iter().find(|entry| entry.name == server_name) else {
        let available = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return [
            "MCP server inspect".to_string(),
            format!("Server not found: {server_name}"),
            format!(
                "Available: {}",
                if available.is_empty() {
                    "none"
                } else {
                    &available
                }
            ),
        ]
        .join("\n");
    };

    let mut lines = vec![
        "MCP server inspect".to_string(),
        format!("Name: {}", entry.name),
        format!("Transport: {}", entry.transport),
        format!("Scope: {}", entry.trust_tier),
        format!("Trust: {}", entry.trust_tier),
        format!("Origin: {}", entry.origin_label),
        "Health: not checked by inspect.".to_string(),
    ];

    match entry.transport.as_str() {
        "stdio" => {
            lines.push(format!(
                "Command: {}",
                redact_secrets(entry.command.as_deref().unwrap_or("unknown"))
            ));
            lines.push(format!("Args: {} configured (hidden)", entry.args_count));
            lines.push(format!("Env keys: {}", entry.env_keys_count));
        }
        _ if entry.url.is_some() => {
            lines.push(format!(
                "URL: {}",
                redact_mcp_url(entry.url.as_deref().unwrap_or_default())
            ));
            lines.push(format!("Headers: {}", entry.headers_count));
            lines.push(format!(
                "OAuth: {}",
                if entry.oauth_configured {
                    "configured"
                } else {
                    "none"
                }
            ));
        }
        _ => lines.push(format!("Config: {}", entry.transport)),
    }

    lines.join("\n")
}

pub fn add_project_mcp_server(
    workspace_root: &Path,
    name: &str,
    command: &str,
    args: &[String],
) -> Result<PathBuf, String> {
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
    {
        return Err(
            "MCP server name may only contain letters, numbers, dot, underscore, and dash."
                .to_string(),
        );
    }

    let mut config = read_project_mcp_config(workspace_root)?;
    if config
        .get("mcpServers")
        .and_then(Value::as_object)
        .is_none()
    {
        config["mcpServers"] = json!({});
    }
    let server = if args.is_empty() {
        json!({ "type": "stdio", "command": command })
    } else {
        json!({ "type": "stdio", "command": command, "args": args })
    };
    config["mcpServers"][name] = server;
    write_project_mcp_config(workspace_root, &config)
}

pub fn remove_project_mcp_server(
    workspace_root: &Path,
    server_name: &str,
) -> Result<PathBuf, String> {
    let mut config = read_project_mcp_config(workspace_root)?;
    let Some(servers) = config.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Err(format!("MCP server not found in .mcp.json: {server_name}"));
    };
    if servers.remove(server_name).is_none() {
        return Err(format!("MCP server not found in .mcp.json: {server_name}"));
    }
    write_project_mcp_config(workspace_root, &config)
}

fn project_mcp_config_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".mcp.json")
}

fn read_project_mcp_config(workspace_root: &Path) -> Result<Value, String> {
    let config_path = project_mcp_config_path(workspace_root);
    match fs::read_to_string(&config_path) {
        Ok(raw) => {
            let parsed: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("Invalid {}: {error}", config_path.display()))?;
            if !parsed.is_object() {
                return Err(format!(
                    "{} must contain a JSON object.",
                    config_path.display()
                ));
            }
            Ok(parsed)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("Failed to read {}: {error}", config_path.display())),
    }
}

fn write_project_mcp_config(workspace_root: &Path, config: &Value) -> Result<PathBuf, String> {
    let config_path = project_mcp_config_path(workspace_root);
    let raw = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&config_path, format!("{raw}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;
    Ok(config_path)
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
            let stdio = normalize_stdio_paths(config_dir, config);
            let args_count = config
                .get("args")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let env_keys_count = config
                .get("env")
                .and_then(Value::as_object)
                .map_or(0, serde_json::Map::len);
            let url = config
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string);
            let headers_count = config
                .get("headers")
                .and_then(Value::as_object)
                .map_or(0, serde_json::Map::len);
            let oauth_configured = config.get("oauth").is_some_and(|value| !value.is_null());
            Some(McpHostRegistryEntry {
                name: name.to_string(),
                transport: transport.to_string(),
                trust_tier: trust_tier(scope).to_string(),
                origin_label: origin_label(scope).to_string(),
                command: stdio.map(|(command, _args)| command),
                args_count,
                env_keys_count,
                url,
                headers_count,
                oauth_configured,
            })
        })
        .collect())
}

fn redact_mcp_url(url: &str) -> String {
    let redacted = redact_secrets(url);
    let cutoff = [redacted.find('?'), redacted.find('#')]
        .into_iter()
        .flatten()
        .min();
    match cutoff {
        Some(index) => format!("{} (query hidden)", &redacted[..index]),
        None => redacted,
    }
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
    fn inspects_mcp_servers_without_exposing_args_env_or_url_query() {
        let root = temp_root("mcp-inspect");
        let fake_token = format!("ghp_{}", "1".repeat(36));
        let config = serde_json::json!({
            "mcpServers": {
                "memory": {
                    "type": "stdio",
                    "command": "node",
                    "args": ["memory.js", "--token", fake_token],
                    "env": { "MEMORY_TOKEN": fake_token },
                },
                "remote": {
                    "type": "http",
                    "url": format!("https://example.test/mcp?token={fake_token}"),
                    "headers": { "Authorization": "Bearer hidden" },
                    "oauth": {},
                },
            },
        });
        fs::write(root.join(".mcp.json"), config.to_string()).unwrap();

        let entries = load_mcp_host_registry(&root, None).unwrap();
        let stdio_report = format_mcp_host_inspect(&entries, "memory");
        assert!(stdio_report.contains("MCP server inspect"));
        assert!(stdio_report.contains("Name: memory"));
        assert!(stdio_report.contains("Args: 3 configured (hidden)"));
        assert!(stdio_report.contains("Env keys: 1"));
        assert!(!stdio_report.contains("memory.js"));
        assert!(!stdio_report.contains("ghp_"));

        let http_report = format_mcp_host_inspect(&entries, "remote");
        assert!(http_report.contains("URL: https://example.test/mcp (query hidden)"));
        assert!(http_report.contains("Headers: 1"));
        assert!(http_report.contains("OAuth: configured"));
        assert!(!http_report.contains("ghp_"));
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
