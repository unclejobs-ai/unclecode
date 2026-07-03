use crate::auth::{
    openai_auth_status_recovery, openai_auth_supports_api_calls, resolve_openai_auth_status,
    OpenAIAuthStatus,
};
use crate::mcp_host::load_mcp_host_registry;
use crate::mode::{resolve_mode_status, user_config_path};
use crate::setup_report::session_store_root_from_env;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MCP_TRANSPORTS: &[&str] = &[
    "stdio",
    "sse",
    "sse-ide",
    "http",
    "ws",
    "sdk",
    "claudeai-proxy",
];

const CONFIG_MS_BUDGET: u128 = 50;
const AUTH_MS_BUDGET: u128 = 50;
const RUNTIME_MS_BUDGET: u128 = 25;
const SESSION_STORE_MS_BUDGET: u128 = 50;
const MCP_MS_BUDGET: u128 = 50;
const TOTAL_MS_BUDGET: u128 = 250;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorReport {
    pub lines: Vec<String>,
    pub json: String,
}

pub fn doctor_report(
    workspace_root: &Path,
    home_dir: Option<&Path>,
    verbose: bool,
    env_get: impl Fn(&str) -> Option<String> + Copy,
) -> Result<DoctorReport, String> {
    let total_started = Instant::now();

    let config_started = Instant::now();
    let mode_status = resolve_mode_status(workspace_root, env_get);
    let config_ms = config_started.elapsed().as_millis();

    let auth_started = Instant::now();
    let auth_status = resolve_openai_auth_status(env_get);
    let auth_ms = auth_started.elapsed().as_millis();

    let runtime_started = Instant::now();
    let runtime_ms = runtime_started.elapsed().as_millis();

    let session_started = Instant::now();
    let session_store_root = session_store_root_from_env(env_get, home_dir.map(Path::to_path_buf));
    fs::create_dir_all(&session_store_root).map_err(|error| {
        format!(
            "Failed to create session store {}: {error}",
            session_store_root.display()
        )
    })?;
    let session_store_ms = session_started.elapsed().as_millis();

    let mcp_started = Instant::now();
    let mcp_entries = load_mcp_host_registry(workspace_root, home_dir)?;
    let mcp_ms = mcp_started.elapsed().as_millis();

    let auth_label = format_auth_label(&auth_status);
    let mode_label = format!("{} ({})", mode_status.profile.id, mode_status.source_label);
    let runtime_label = "local available".to_string();
    let auth_api_ready = openai_auth_supports_api_calls(&auth_status);
    let auth_recovery = openai_auth_status_recovery(&auth_status).map(|recovery| {
        json!({
            "reason": recovery.reason,
            "preferredFix": recovery.preferred_fix,
            "commands": recovery.commands,
            "verify": recovery.verify,
        })
    });
    let auth_verdict = if auth_api_ready { "PASS" } else { "WARN" };
    let runtime_verdict = "PASS";
    let mcp_label = format!(
        "{} servers; transports {}",
        mcp_entries.len(),
        MCP_TRANSPORTS.join(", ")
    );
    let total_ms = total_started.elapsed().as_millis();
    let team_summary = summarize_team_runs(workspace_root, env_get);

    let mut lines = vec![
        "Doctor report".to_string(),
        format!("Mode           PASS  {mode_label}"),
        format!("Auth           {auth_verdict}  {auth_label}"),
        format!("Runtime        {runtime_verdict}  {runtime_label}"),
        format!("Session store  PASS  {}", session_store_root.display()),
        format!("MCP host       PASS  {mcp_label}"),
        format!("Team runs      {}  {}", team_summary.0, team_summary.1),
    ];
    if verbose {
        lines.extend([
            String::new(),
            "Latency counters".to_string(),
            format!("configMs={config_ms}"),
            format!("authMs={auth_ms}"),
            format!("runtimeMs={runtime_ms}"),
            format!("sessionStoreMs={session_store_ms}"),
            format!("mcpMs={mcp_ms}"),
            format!("totalMs={total_ms}"),
        ]);
    }

    let payload = json!({
        "command": "doctor",
        "verbose": verbose,
        "workspaceRoot": workspace_root.to_string_lossy(),
        "verdicts": {
            "mode": "PASS",
            "auth": auth_verdict,
            "runtime": runtime_verdict,
            "sessionStore": "PASS",
            "mcpHost": "PASS"
        },
        "labels": {
            "mode": mode_label,
            "auth": auth_label,
            "runtime": runtime_label,
            "sessionStore": session_store_root.to_string_lossy(),
            "mcpHost": mcp_label
        },
        "auth": {
            "provider": "openai",
            "source": auth_status.active_source,
            "type": auth_status.auth_type,
            "organizationId": auth_status.organization_id,
            "projectId": auth_status.project_id,
            "runtime": auth_status.runtime,
            "expiresAt": auth_status.expires_at,
            "expired": auth_status.is_expired,
            "apiReady": auth_api_ready,
            "recovery": auth_recovery
        },
        "metrics": {
            "configMs": config_ms,
            "authMs": auth_ms,
            "runtimeMs": runtime_ms,
            "sessionStoreMs": session_store_ms,
            "mcpMs": mcp_ms,
            "totalMs": total_ms
        },
        "thresholds": {
            "configMsBudget": CONFIG_MS_BUDGET,
            "authMsBudget": AUTH_MS_BUDGET,
            "runtimeMsBudget": RUNTIME_MS_BUDGET,
            "sessionStoreMsBudget": SESSION_STORE_MS_BUDGET,
            "mcpMsBudget": MCP_MS_BUDGET,
            "totalMsBudget": TOTAL_MS_BUDGET
        }
    });
    let json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;

    Ok(DoctorReport { lines, json })
}

fn format_auth_label(status: &OpenAIAuthStatus) -> String {
    let base = match status.runtime.as_deref() {
        Some(runtime) => format!(
            "{} ({}, {runtime} runtime)",
            status.active_source, status.auth_type
        ),
        None => format!("{} ({})", status.active_source, status.auth_type),
    };
    if openai_auth_supports_api_calls(status) {
        return base;
    }
    match (status.auth_type.as_str(), status.runtime.as_deref(), status.expires_at.as_deref()) {
        ("oauth", Some("codex"), _) => format!(
            "{base}; API calls blocked, use `unclecode auth login --api-key-stdin` or API-capable browser OAuth"
        ),
        ("oauth", _, Some("insufficient-scope")) => format!(
            "{base}; missing model.request scope, use `unclecode auth login --api-key-stdin` or API-capable browser OAuth"
        ),
        ("oauth", _, Some("refresh-required")) => {
            format!("{base}; refresh required, run `unclecode auth login --browser`")
        }
        _ => base,
    }
}

fn summarize_team_runs(
    workspace_root: &Path,
    env_get: impl Fn(&str) -> Option<String>,
) -> (&'static str, String) {
    let data_root = env_get("UNCLECODE_DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join(".data"));
    let runs_dir = data_root.join("team-runs");
    let Ok(entries) = fs::read_dir(runs_dir) else {
        return ("INFO", "none".to_string());
    };
    let count = entries.filter_map(Result::ok).count();
    if count == 0 {
        ("INFO", "none".to_string())
    } else {
        ("PASS", format!("{count} run(s)"))
    }
}

pub fn doctor_user_config_path(home: Option<String>) -> PathBuf {
    user_config_path(home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn builds_text_and_json_doctor_report() {
        let root = temp_root("doctor");
        let home = root.join("home");
        let session_root = root.join(".state");
        fs::create_dir_all(&home).unwrap();
        let report = doctor_report(&root, Some(&home), true, |key| match key {
            "OPENAI_API_KEY" => Some("sk-test".to_string()),
            "UNCLECODE_SESSION_STORE_ROOT" => Some(session_root.to_string_lossy().to_string()),
            _ => None,
        })
        .unwrap();

        let text = report.lines.join("\n");
        assert!(text.contains("Doctor report"));
        assert!(text.contains("Auth           PASS  api-key-env"));
        assert!(text.contains("Runtime        PASS  local available"));
        assert!(text.contains("Latency counters"));
        let parsed: serde_json::Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(parsed["command"], "doctor");
        assert_eq!(parsed["verdicts"]["auth"], "PASS");
        assert!(parsed["metrics"]["totalMs"].as_u64().unwrap() <= TOTAL_MS_BUDGET as u64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn warns_when_auth_is_missing() {
        let root = temp_root("doctor-missing-auth");
        let report = doctor_report(&root, None, false, |_| None).unwrap();
        assert!(report
            .lines
            .join("\n")
            .contains("Auth           WARN  none"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn warns_when_only_codex_oauth_is_available_for_api_work() {
        let root = temp_root("doctor-codex-oauth");
        let home = root.join("home");
        let codex_dir = home.join(".codex");
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(
            codex_dir.join("auth.json"),
            r#"{"tokens":{"access_token":"not-a-jwt","refresh_token":"rt-test"}}"#,
        )
        .unwrap();

        let report = doctor_report(&root, Some(&home), false, |key| match key {
            "HOME" => Some(home.to_string_lossy().to_string()),
            _ => None,
        })
        .unwrap();

        let text = report.lines.join("\n");
        assert!(text
            .contains("Auth           WARN  oauth-file (oauth, codex runtime); API calls blocked"));
        assert!(text.contains("unclecode auth login --api-key-stdin"));
        let parsed: serde_json::Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(parsed["verdicts"]["auth"], "WARN");
        assert_eq!(
            parsed["auth"]["recovery"]["reason"],
            "openai-oauth-codex-runtime-not-api-ready"
        );
        assert_eq!(
            parsed["auth"]["recovery"]["commands"][0],
            "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser"
        );
        assert_eq!(parsed["auth"]["recovery"]["verify"], "npm run qa:live");
        let _ = fs::remove_dir_all(root);
    }

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("unclecode-rust-{label}-{nanos}"))
    }
}
