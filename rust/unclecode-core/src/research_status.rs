use crate::mcp_host::load_mcp_host_registry;
use crate::session::WorkShellSessionStore;
use crate::setup_report::session_store_root_from_env;
use serde_json::json;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResearchStatusReport {
    pub lines: Vec<String>,
    pub json: String,
}

pub fn research_status_report(
    workspace_root: &Path,
    home_dir: Option<&Path>,
    env_get: impl Fn(&str) -> Option<String> + Copy,
) -> Result<ResearchStatusReport, String> {
    let registry = load_mcp_host_registry(workspace_root, home_dir)?;
    let server_names = registry
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    let session_root = session_store_root_from_env(env_get, home_dir.map(Path::to_path_buf));
    fs::create_dir_all(&session_root).map_err(|error| {
        format!(
            "Failed to create session store {}: {error}",
            session_root.display()
        )
    })?;
    let latest_research = WorkShellSessionStore::new(&session_root)
        .list_session_items(workspace_root)
        .map_err(|error| format!("Failed to list sessions: {error}"))?
        .into_iter()
        .find(|item| item.session_id.starts_with("research-"));

    let mut lines = vec![
        "Work context status".to_string(),
        "Profile: work-context-local".to_string(),
        format!("Configured servers: {}", server_names.len()),
    ];
    if let Some(session) = &latest_research {
        lines.extend([
            format!("Last refresh: {}", session.session_id),
            format!("State: {}", session.state),
            format!(
                "Summary: {}",
                format_work_context_summary(session.task_summary.as_deref().unwrap_or("none"))
            ),
        ]);
    } else {
        lines.push("No Work context refresh yet".to_string());
    }

    let payload = json!({
        "command": "research.status",
        "workspaceRoot": workspace_root.to_string_lossy(),
        "profile": {
            "profileName": "work-context-local",
            "serverNames": server_names,
        },
        "latestRun": latest_research.as_ref().map(|session| {
            json!({
                "sessionId": session.session_id,
                "state": session.state,
                "summary": session.task_summary.as_deref().unwrap_or("none"),
                "updatedAt": session.updated_at,
            })
        }),
        "sessionStoreRoot": session_root.to_string_lossy(),
    });
    let json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;

    Ok(ResearchStatusReport { lines, json })
}

fn format_work_context_summary(summary: &str) -> String {
    summary
        .replace(
            "Prepared a local research bundle for",
            "Refreshed Work context for",
        )
        .replace("Prepared a context brief for", "Refreshed Work context for")
        .replace("Prepared a context brief", "Refreshed Work context")
        .replace("research bundle", "Work context")
        .replace("context brief", "Work context")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::WorkShellSessionSnapshot;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reports_no_active_research_run() {
        let root = temp_root("research-status-empty");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let report = research_status_report(&root, Some(&home), |_| None).unwrap();

        let text = report.lines.join("\n");
        assert!(text.contains("Work context status"));
        assert!(text.contains("Profile: work-context-local"));
        assert!(text.contains("Configured servers: 0"));
        assert!(text.contains("No Work context refresh yet"));
        let parsed: serde_json::Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(parsed["command"], "research.status");
        assert_eq!(parsed["profile"]["profileName"], "work-context-local");
        assert!(parsed["latestRun"].is_null());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reports_latest_research_session_and_mcp_count() {
        let root = temp_root("research-status-session");
        let home = root.join("home");
        let session_root = root.join(".state");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"memory":{"type":"stdio","command":"node","args":["memory.js"]}}}"#,
        )
        .unwrap();
        WorkShellSessionStore::new(&session_root)
            .persist_work_shell_snapshot(&WorkShellSessionSnapshot {
                session_id: "research-alpha".to_string(),
                project_path: root.to_string_lossy().to_string(),
                model: "research-local".to_string(),
                mode: "normal".to_string(),
                state: "idle".to_string(),
                summary: "Mapped local context".to_string(),
                trace_mode: None,
                reasoning_effort: None,
                entries: vec![],
            })
            .unwrap();

        let report = research_status_report(&root, Some(&home), |key| {
            (key == "UNCLECODE_SESSION_STORE_ROOT")
                .then(|| session_root.to_string_lossy().to_string())
        })
        .unwrap();

        let text = report.lines.join("\n");
        assert!(text.contains("Configured servers: 1"));
        assert!(text.contains("Last refresh: research-alpha"));
        assert!(text.contains("State: idle"));
        assert!(text.contains("Summary: Mapped local context"));
        let parsed: serde_json::Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(parsed["latestRun"]["sessionId"], "research-alpha");
        assert_eq!(parsed["profile"]["serverNames"][0], "memory");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hides_legacy_research_words_in_human_status_summary() {
        let root = temp_root("research-status-legacy-summary");
        let home = root.join("home");
        let session_root = root.join(".state");
        fs::create_dir_all(&home).unwrap();
        WorkShellSessionStore::new(&session_root)
            .persist_work_shell_snapshot(&WorkShellSessionSnapshot {
                session_id: "research-legacy".to_string(),
                project_path: root.to_string_lossy().to_string(),
                model: "research-local".to_string(),
                mode: "normal".to_string(),
                state: "idle".to_string(),
                summary: "Prepared a local research bundle for \"audit workflow\".".to_string(),
                trace_mode: None,
                reasoning_effort: None,
                entries: vec![],
            })
            .unwrap();

        let report = research_status_report(&root, Some(&home), |key| {
            (key == "UNCLECODE_SESSION_STORE_ROOT")
                .then(|| session_root.to_string_lossy().to_string())
        })
        .unwrap();

        let text = report.lines.join("\n");
        assert!(text.contains("Summary: Refreshed Work context for \"audit workflow\"."));
        assert!(!text.contains("research bundle"));
        assert!(!text.contains("context brief"));
        let _ = fs::remove_dir_all(root);
    }

    fn temp_root(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("unclecode-rust-{label}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        root
    }
}
