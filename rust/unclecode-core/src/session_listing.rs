use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionListItem {
    pub session_id: String,
    pub state: String,
    pub updated_at: String,
    pub model: Option<String>,
    pub task_summary: Option<String>,
    pub mode: Option<String>,
    pub pending_action: Option<String>,
    pub worktree_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionResumeSummary {
    pub session_id: String,
    pub state: String,
    pub model: String,
    pub mode: String,
    pub trace_mode: String,
    pub pending_action: String,
    pub worktree_branch: String,
    pub task_summary: String,
}

pub(crate) fn parse_session_list_item(raw: &str) -> Option<SessionListItem> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let session_id = parsed.get("sessionId")?.as_str()?.to_string();
    let updated_at = parsed.get("updatedAt")?.as_str()?.to_string();
    let state = parsed
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let model = parsed
        .get("metadata")
        .and_then(|value| value.get("model"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let task_summary = parsed
        .get("taskSummary")
        .and_then(|value| value.get("summary"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let mode = parsed
        .get("mode")
        .and_then(Value::as_str)
        .filter(|value| *value == "coordinator" || *value == "normal")
        .map(ToOwned::to_owned);
    let pending_action = parsed
        .get("pendingAction")
        .and_then(|value| value.get("toolName"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let worktree_branch = parsed
        .get("worktree")
        .and_then(|value| value.get("worktreeBranch"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    Some(SessionListItem {
        session_id,
        state,
        updated_at,
        model,
        task_summary,
        mode,
        pending_action,
        worktree_branch,
    })
}

pub(crate) fn parse_session_resume_summary(
    raw: &str,
    requested_session_id: &str,
) -> Option<SessionResumeSummary> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let session_id = parsed
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or(requested_session_id)
        .to_string();
    let state = parsed
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let metadata = parsed.get("metadata");
    let model = metadata
        .and_then(|value| value.get("model"))
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();
    let trace_mode = metadata
        .and_then(|value| value.get("traceMode"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let mode = parsed
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();
    let pending_action = parsed
        .get("pendingAction")
        .and_then(|value| value.get("actionDescription"))
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();
    let worktree_branch = parsed
        .get("worktree")
        .and_then(|value| value.get("worktreeBranch"))
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();
    let task_summary = parsed
        .get("taskSummary")
        .and_then(|value| value.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();

    Some(SessionResumeSummary {
        session_id,
        state,
        model,
        mode,
        trace_mode,
        pending_action,
        worktree_branch,
        task_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_list_checkpoint() {
        let item = parse_session_list_item(
            r#"{"sessionId":"session-alpha","updatedAt":"2026-04-02T00:00:00.000Z","state":"idle","metadata":{"model":"gpt-5.4"},"taskSummary":{"summary":"Review current repo health"},"mode":"coordinator","pendingAction":{"toolName":"mcp.list"},"worktree":{"worktreeBranch":"main"}}"#,
        )
        .expect("item");

        assert_eq!(item.session_id, "session-alpha");
        assert_eq!(item.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(
            item.task_summary.as_deref(),
            Some("Review current repo health")
        );
        assert_eq!(item.pending_action.as_deref(), Some("mcp.list"));
    }

    #[test]
    fn parses_resume_checkpoint() {
        let summary = parse_session_resume_summary(
            r#"{"sessionId":"session-beta","updatedAt":"2026-04-02T00:00:00.000Z","state":"idle","metadata":{"model":"gpt-5.4","traceMode":"verbose"},"taskSummary":{"summary":"Review current repo health"},"mode":"coordinator","pendingAction":{"toolName":"mcp.list","actionDescription":"List MCP servers"},"worktree":{"worktreeBranch":"main"}}"#,
            "session-beta",
        )
        .expect("summary");

        assert_eq!(summary.session_id, "session-beta");
        assert_eq!(summary.state, "idle");
        assert_eq!(summary.model, "gpt-5.4");
        assert_eq!(summary.trace_mode, "verbose");
        assert_eq!(summary.pending_action, "List MCP servers");
        assert_eq!(summary.worktree_branch, "main");
    }
}
