use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Instant;

use unclecode_core::session::{SessionResumeSummary, WorkShellSessionStore};

const RESUME_MS_BUDGET: u64 = 600;

pub fn top_level_resume_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("resume") => Some(args[1..].to_vec()),
        _ => None,
    }
}

pub fn run_top_level_resume_command(args: &[OsString]) -> Result<u8, String> {
    let started_at = Instant::now();
    let mut session_id = None;
    let mut json = false;

    for arg in args {
        match arg.to_str() {
            Some("--json") => json = true,
            Some("--verbose") => {}
            Some(value) if !value.starts_with('-') && session_id.is_none() => {
                session_id = Some(value.to_string());
            }
            _ => {
                return Err("Usage: unclecode resume <session-id> [--verbose] [--json]".to_string())
            }
        }
    }

    let session_id =
        session_id.ok_or("Usage: unclecode resume <session-id> [--verbose] [--json]")?;
    let cwd = env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let store = WorkShellSessionStore::new(session_store_root());
    let Some(summary) = store
        .resume_session_summary(&cwd, &session_id)
        .map_err(|error| format!("Failed to resume session: {error}"))?
    else {
        return Err(format!("Session not found: {session_id}"));
    };

    let resume_ms = started_at.elapsed().as_millis();
    if json {
        println!("{}", resume_report_json(&summary, resume_ms));
    } else {
        print_resume_lines(&summary);
    }
    Ok(0)
}

fn print_resume_lines(summary: &SessionResumeSummary) {
    println!("Resuming session: {}", summary.session_id);
    println!("State: {}", summary.state);
    println!("Model: {}", summary.model);
    println!("Mode: {}", summary.mode);
    println!("Trace mode: {}", summary.trace_mode);
    println!("Pending action: {}", summary.pending_action);
    println!("Worktree branch: {}", summary.worktree_branch);
    println!("Task summary: {}", summary.task_summary);
}

fn resume_report_json(summary: &SessionResumeSummary, resume_ms: u128) -> String {
    format!(
        "{{\"command\":\"resume\",\"sessionId\":\"{}\",\"status\":\"{}\",\"model\":\"{}\",\"mode\":\"{}\",\"pendingAction\":\"{}\",\"worktreeBranch\":\"{}\",\"taskSummary\":\"{}\",\"metrics\":{{\"resumeMs\":{}}},\"thresholds\":{{\"resumeMsBudget\":{}}}}}",
        escape_json(&summary.session_id),
        escape_json(&summary.state),
        escape_json(&summary.model),
        escape_json(&summary.mode),
        escape_json(&summary.pending_action),
        escape_json(&summary.worktree_branch),
        escape_json(&summary.task_summary),
        resume_ms,
        RESUME_MS_BUDGET
    )
}

fn session_store_root() -> PathBuf {
    if let Some(root) = env::var_os("UNCLECODE_SESSION_STORE_ROOT") {
        let root = PathBuf::from(root);
        if !root.as_os_str().is_empty() {
            return root;
        }
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".unclecode")
        .join("state")
}

fn escape_json(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            ch if ch.is_control() => escaped.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => escaped.push(ch),
        }
    }
    escaped
}
