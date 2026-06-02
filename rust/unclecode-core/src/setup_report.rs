use crate::auth::resolve_openai_auth_status;
use std::fs;
use std::path::{Path, PathBuf};

pub fn setup_report_text(
    workspace_root: &Path,
    session_store_root: &Path,
    env_get: impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    fs::create_dir_all(session_store_root).map_err(|error| {
        format!(
            "Failed to create session store {}: {error}",
            session_store_root.display()
        )
    })?;
    let auth_status = resolve_openai_auth_status(env_get);
    let auth_ready = auth_status.active_source != "none" && !auth_status.is_expired;
    Ok([
        "Setup guide".to_string(),
        format!("Workspace: {}", workspace_root.display()),
        format!(
            "Auth: {}",
            if auth_ready {
                format!("ready ({})", auth_status.active_source)
            } else {
                "missing".to_string()
            }
        ),
        "Runtime: local available".to_string(),
        format!("Session store: {}", session_store_root.display()),
        format!(
            "Project config: {}",
            workspace_root.join(".unclecode/config.json").display()
        ),
        "Next steps:".to_string(),
        if auth_ready {
            "1. Auth is ready. You can continue with `unclecode doctor` or `unclecode`."
                .to_string()
        } else {
            "1. Set OPENAI_API_KEY, save credentials with `unclecode auth login --api-key-stdin [--org <id>] [--project <id>]`, reuse an existing `~/.codex/auth.json`, or run `unclecode auth login --browser` with OPENAI_OAUTH_CLIENT_ID.".to_string()
        },
        "2. Run `unclecode doctor` to verify auth, runtime, session-store, and MCP readiness."
            .to_string(),
        "3. Run `unclecode mode status` to confirm the active operating profile before starting work."
            .to_string(),
    ]
    .join("\n"))
}

pub fn session_store_root_from_env(
    env_get: impl Fn(&str) -> Option<String>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    env_get("UNCLECODE_SESSION_STORE_ROOT")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            home_dir
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".unclecode/state")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn builds_missing_auth_setup_report_and_creates_session_root() {
        let root = temp_root("setup");
        let session_root = root.join(".state");
        let report = setup_report_text(&root, &session_root, |_| None).unwrap();

        assert!(report.contains("Setup guide"));
        assert!(report.contains("Auth: missing"));
        assert!(report.contains("Runtime: local available"));
        assert!(report.contains("unclecode auth login --browser"));
        assert!(report.contains("OPENAI_API_KEY"));
        assert!(session_root.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn builds_ready_auth_setup_report_from_env_key() {
        let root = temp_root("setup-auth");
        let session_root = root.join(".state");
        let report = setup_report_text(&root, &session_root, |key| {
            (key == "OPENAI_API_KEY").then(|| "sk-test".to_string())
        })
        .unwrap();

        assert!(report.contains("Auth: ready (api-key-env)"));
        assert!(report.contains("Auth is ready"));
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
