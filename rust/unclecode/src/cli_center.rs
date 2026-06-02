use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use unclecode_core::session::{SessionListItem, WorkShellSessionStore};

pub fn top_level_center_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("center") | Some("/center") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/center ") => Some(
            command
                .split_whitespace()
                .skip(1)
                .map(OsString::from)
                .chain(args[1..].iter().cloned())
                .collect(),
        ),
        _ => None,
    }
}

pub fn run_top_level_center_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None => print_center(),
        Some("--help") | Some("-h") | Some("help") => {
            print_center_help();
            Ok(0)
        }
        Some("sessions") | Some("list") => print_center(),
        _ => Err(center_usage()),
    }
}

fn print_center_help() {
    println!("{}", center_usage());
    println!();
    println!("Rust-native session center:");
    println!("  unclecode center");
    println!("  unclecode center sessions");
    println!("  unclecode resume <session-id>");
    println!("  unclecode work");
}

fn center_usage() -> String {
    "Usage: unclecode center [sessions|list|--help]".to_string()
}

fn print_center() -> Result<u8, String> {
    let cwd = env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let store = WorkShellSessionStore::new(session_store_root());
    let sessions = store
        .list_session_items(&cwd)
        .map_err(|error| format!("Failed to list sessions: {error}"))?;

    println!("UncleCode Center");
    println!("workspace: {}", cwd.display());
    println!("runtime: rust-native");
    println!();

    if sessions.is_empty() {
        println!("No resumable sessions found.");
        println!("start: unclecode work");
        println!("sessions: unclecode sessions");
        return Ok(0);
    }

    println!("Recent sessions");
    for (index, session) in sessions.iter().take(8).enumerate() {
        print_session(index + 1, session);
    }
    println!();
    println!("Commands");
    println!("  unclecode resume <session-id>");
    println!("  unclecode queue list <session-id>");
    println!("  unclecode work");
    Ok(0)
}

fn print_session(index: usize, session: &SessionListItem) {
    let mut metadata = vec![
        format!("state={}", session.state),
        format!("model={}", session.model.as_deref().unwrap_or("none")),
        format!("mode={}", session.mode.as_deref().unwrap_or("none")),
        format!("updated={}", session.updated_at),
    ];
    if let Some(pending) = &session.pending_action {
        metadata.push(format!("pending={pending}"));
    }
    if let Some(branch) = &session.worktree_branch {
        metadata.push(format!("branch={branch}"));
    }

    println!("{index}. {} | {}", session.session_id, metadata.join(" | "));
    if let Some(summary) = &session.task_summary {
        println!("   {summary}");
    }
    println!("   resume: unclecode resume {}", session.session_id);
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
