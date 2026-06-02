use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use unclecode_core::queue::{
    queue_item_json, queue_items_json, queue_length_json, PersistentWorkQueue,
};

pub fn top_level_queue_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("queue") => Some(args[1..].to_vec()),
        Some("/queue") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/queue ") => Some(
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

pub fn run_top_level_queue_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_queue_help();
            Ok(0)
        }
        Some("push") | Some("pop") | Some("list") | Some("len") | Some("clear") => {
            run_queue_action(args)
        }
        _ => Err(queue_usage()),
    }
}

fn run_queue_action(args: &[OsString]) -> Result<u8, String> {
    let action = args
        .first()
        .and_then(|arg| arg.to_str())
        .ok_or_else(queue_usage)?;
    let json = args.iter().any(|arg| arg.to_str() == Some("--json"));
    let positional = args
        .iter()
        .skip(1)
        .filter(|arg| arg.to_str() != Some("--json"))
        .collect::<Vec<_>>();
    let session_id = positional
        .first()
        .and_then(|arg| arg.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(queue_usage)?;
    let queue = PersistentWorkQueue::new(queue_path(&work_cwd()?, session_id));

    match action {
        "push" => {
            let line = positional
                .iter()
                .skip(1)
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let Some(item) = queue
                .push(line)
                .map_err(|error| format!("Failed to push queue item: {error}"))?
            else {
                return Err("Queue line must not be empty.".to_string());
            };
            if json {
                println!("{}", queue_item_json(Some(&item)));
            } else {
                println!("Queued #{}: {}", item.id, item.line);
            }
        }
        "pop" => {
            let item = queue
                .pop()
                .map_err(|error| format!("Failed to pop queue item: {error}"))?;
            if json {
                println!("{}", queue_item_json(item.as_ref()));
            } else if let Some(item) = item {
                println!("Dequeued #{}: {}", item.id, item.line);
            } else {
                println!("Queue empty.");
            }
        }
        "list" => {
            let items = queue
                .snapshot()
                .map_err(|error| format!("Failed to list queue items: {error}"))?;
            if json {
                println!("{}", queue_items_json(&items));
            } else if items.is_empty() {
                println!("No queued follow-ups for {session_id}.");
            } else {
                for item in items {
                    println!("#{} {}", item.id, item.line);
                }
            }
        }
        "len" => {
            let length = queue
                .len()
                .map_err(|error| format!("Failed to read queue length: {error}"))?;
            if json {
                println!("{}", queue_length_json(length));
            } else {
                println!("{length}");
            }
        }
        "clear" => {
            queue
                .clear()
                .map_err(|error| format!("Failed to clear queue: {error}"))?;
            if json {
                println!("{}", r#"{"cleared":true,"length":0}"#);
            } else {
                println!("Queue cleared for {session_id}.");
            }
        }
        _ => return Err(queue_usage()),
    }
    Ok(0)
}

fn print_queue_help() {
    println!("{}", queue_usage());
    println!();
    println!("Rust-native queue commands:");
    println!("  unclecode queue list <session-id>");
    println!("  unclecode queue push <session-id> <follow-up...>");
    println!("  unclecode queue pop <session-id>");
    println!("  unclecode queue len <session-id>");
    println!("  unclecode queue clear <session-id>");
    println!();
    println!("Add --json to print machine-readable queue payloads.");
}

fn queue_usage() -> String {
    "Usage: unclecode queue <list|push|pop|len|clear> <session-id> [line...] [--json]".to_string()
}

fn queue_path(workspace_root: &Path, session_id: &str) -> PathBuf {
    workspace_root
        .join(".unclecode")
        .join("work-queues")
        .join(format!("{}.queue", sanitize_session_id(session_id)))
}

fn work_cwd() -> Result<PathBuf, String> {
    if let Some(cwd) = env::var_os("UNCLECODE_WORK_CWD") {
        let cwd = PathBuf::from(cwd);
        if !cwd.as_os_str().is_empty() {
            return Ok(cwd);
        }
    }
    env::current_dir().map_err(|error| format!("Failed to read current directory: {error}"))
}

fn sanitize_session_id(session_id: &str) -> String {
    let sanitized = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}
