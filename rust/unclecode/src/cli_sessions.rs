use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use unclecode_core::session::WorkShellSessionStore;
use unclecode_core::sha256::sha256_hex_bytes;
use unclecode_core::time_iso::utc_now_iso;

pub fn top_level_sessions_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("sessions") | Some("/sessions") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/sessions ") => Some(
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

pub fn run_top_level_sessions_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None => list_sessions(),
        Some("--help") | Some("-h") | Some("help") => {
            print_sessions_help();
            Ok(0)
        }
        Some("fork") => fork_session(&args[1..]),
        Some("share") => share_session(&args[1..]),
        _ => Err(sessions_usage()),
    }
}

fn print_sessions_help() {
    println!("{}", sessions_usage());
    println!();
    println!("Rust-native session commands:");
    println!("  unclecode sessions");
    println!("  unclecode sessions fork <session-id> [--at <turn>]");
    println!("  unclecode sessions share <session-id> [--out <dir>]");
}

fn sessions_usage() -> String {
    "Usage: unclecode sessions [fork <session-id> [--at <turn>]|share <session-id> [--out <dir>]]"
        .to_string()
}

fn list_sessions() -> Result<u8, String> {
    let cwd = env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let store = WorkShellSessionStore::new(session_store_root());
    let items = store
        .list_session_items(&cwd)
        .map_err(|error| format!("Failed to list sessions: {error}"))?;
    if items.is_empty() {
        println!("No resumable sessions found.");
        return Ok(0);
    }

    println!("Sessions");
    for item in items {
        let mut parts = vec![
            item.session_id,
            format!("state={}", item.state),
            format!("model={}", item.model.as_deref().unwrap_or("none")),
            format!("mode={}", item.mode.as_deref().unwrap_or("none")),
            format!(
                "pending={}",
                item.pending_action.as_deref().unwrap_or("none")
            ),
            format!("updated={}", item.updated_at),
        ];
        if let Some(summary) = item.task_summary {
            parts.push(format!("summary={summary}"));
        }
        println!("{}", parts.join(" | "));
    }
    Ok(0)
}

fn fork_session(args: &[OsString]) -> Result<u8, String> {
    let session_id = args
        .first()
        .and_then(|arg| arg.to_str())
        .ok_or("Usage: unclecode sessions fork <session-id> [--at <turn>]")?;
    let mut truncate_at = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].to_str() {
            Some("--at") => {
                let value = args
                    .get(index + 1)
                    .and_then(|arg| arg.to_str())
                    .ok_or("--at expects an integer turn index")?;
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| "--at expects an integer turn index".to_string())?;
                truncate_at = Some(parsed);
                index += 2;
            }
            _ => {
                return Err("Usage: unclecode sessions fork <session-id> [--at <turn>]".to_string())
            }
        }
    }

    let located = locate_session_files(session_id)
        .map_err(|error| format!("Failed to locate session files: {error}"))?
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    let fork_id = generate_fork_id(session_id);
    let fork_prefix = session_file_prefix(&fork_id);
    for filename in &located.files {
        let src = located.session_dir.join(filename);
        let dest_name = if filename.contains(session_id) {
            filename.replace(session_id, &fork_id)
        } else {
            filename.replace(&located.file_prefix, &fork_prefix)
        };
        let dest = located.session_dir.join(dest_name);
        if filename.ends_with(".jsonl") {
            if let Some(turn) = truncate_at {
                let raw = fs::read_to_string(&src)
                    .map_err(|error| format!("Failed to read {}: {error}", src.display()))?;
                let truncated = raw
                    .lines()
                    .take(turn + 1)
                    .collect::<Vec<_>>()
                    .join("\n")
                    .replace(session_id, &fork_id);
                fs::write(&dest, truncated)
                    .map_err(|error| format!("Failed to write {}: {error}", dest.display()))?;
                continue;
            }
        }
        let raw = fs::read_to_string(&src)
            .map_err(|error| format!("Failed to read {}: {error}", src.display()))?;
        fs::write(&dest, raw.replace(session_id, &fork_id))
            .map_err(|error| format!("Failed to write {}: {error}", dest.display()))?;
    }
    println!("forked {session_id} -> {fork_id}");
    println!("session-dir {}", located.session_dir.display());
    Ok(0)
}

fn share_session(args: &[OsString]) -> Result<u8, String> {
    let session_id = args
        .first()
        .and_then(|arg| arg.to_str())
        .ok_or("Usage: unclecode sessions share <session-id> [--out <dir>]")?;
    let mut out_dir = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].to_str() {
            Some("--out") => {
                out_dir = Some(
                    args.get(index + 1)
                        .map(PathBuf::from)
                        .ok_or("Usage: unclecode sessions share <session-id> [--out <dir>]")?,
                );
                index += 2;
            }
            _ => {
                return Err("Usage: unclecode sessions share <session-id> [--out <dir>]".to_string())
            }
        }
    }

    let located = locate_session_files(session_id)
        .map_err(|error| format!("Failed to locate session files: {error}"))?
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    let slug = generate_share_slug(session_id);
    let base = out_dir.unwrap_or_else(|| PathBuf::from(".unclecode").join("shares"));
    let share_path = absolute_or_cwd(base)?.join(&slug);
    fs::create_dir_all(&share_path)
        .map_err(|error| format!("Failed to create {}: {error}", share_path.display()))?;
    for filename in &located.files {
        let src = located.session_dir.join(filename);
        let dest = share_path.join(filename);
        fs::copy(&src, &dest).map_err(|error| {
            format!(
                "Failed to copy {} to {}: {error}",
                src.display(),
                dest.display()
            )
        })?;
    }
    fs::write(
        share_path.join("share.json"),
        share_manifest_json(&slug, session_id, &located.session_dir, &located.files),
    )
    .map_err(|error| format!("Failed to write share manifest: {error}"))?;
    println!("SHARE_SLUG={slug}");
    println!("SHARE_PATH={}", share_path.display());
    Ok(0)
}

struct LocatedSession {
    session_dir: PathBuf,
    file_prefix: String,
    files: Vec<String>,
}

fn locate_session_files(session_id: &str) -> std::io::Result<Option<LocatedSession>> {
    let projects_dir = session_store_root().join("projects");
    if !projects_dir.exists() {
        return Ok(None);
    }
    for project in fs::read_dir(projects_dir)? {
        let project = project?;
        let session_dir = project.path().join("sessions");
        if !session_dir.exists() {
            continue;
        }
        let mut files = Vec::new();
        let mut file_prefix = String::new();
        for entry in fs::read_dir(&session_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(session_id) || checkpoint_file_matches(&entry.path(), session_id)? {
                let prefix = name
                    .strip_suffix(".checkpoint.json")
                    .or_else(|| name.strip_suffix(".events.jsonl"))
                    .unwrap_or(&name)
                    .to_string();
                file_prefix = prefix.clone();
                files = collect_session_files_by_prefix(&session_dir, &prefix)?;
                break;
            }
        }
        if !files.is_empty() {
            files.sort();
            return Ok(Some(LocatedSession {
                session_dir,
                file_prefix,
                files,
            }));
        }
    }
    Ok(None)
}

fn checkpoint_file_matches(path: &Path, session_id: &str) -> std::io::Result<bool> {
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".checkpoint.json"))
    {
        return Ok(false);
    }
    let raw = fs::read_to_string(path)?;
    Ok(
        raw.contains(&format!("\"sessionId\":\"{}\"", escape_json(session_id)))
            || raw.contains(&format!("\"sessionId\": \"{}\"", escape_json(session_id))),
    )
}

fn collect_session_files_by_prefix(
    session_dir: &Path,
    prefix: &str,
) -> std::io::Result<Vec<String>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(session_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(prefix) {
            files.push(name);
        }
    }
    files.sort();
    Ok(files)
}

fn generate_fork_id(session_id: &str) -> String {
    let stamp = unix_ms();
    let hash = sha256_hex_bytes(format!("{session_id}:{stamp}:{}", std::process::id()).as_bytes());
    format!("{}-{}", base36(stamp), &hash[..6])
}

fn session_file_prefix(session_id: &str) -> String {
    format!("session-{}", &sha256_hex_bytes(session_id.as_bytes())[..20])
}

fn generate_share_slug(session_id: &str) -> String {
    let stamp = unix_ms();
    let stamp36 = base36(stamp);
    let hash = sha256_hex_bytes(format!("{session_id}:{stamp36}").as_bytes());
    format!("share-{stamp36}-{}", &hash[..8])
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        chars.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        value /= 36;
    }
    chars.iter().rev().collect()
}

fn absolute_or_cwd(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?
        .join(path))
}

fn share_manifest_json(
    slug: &str,
    session_id: &str,
    source_dir: &Path,
    files: &[String],
) -> String {
    let files_json = files
        .iter()
        .map(|file| format!("\"{}\"", escape_json(file)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{{\n  \"slug\": \"{}\",\n  \"sessionId\": \"{}\",\n  \"sourceDir\": \"{}\",\n  \"sharedAt\": \"{}\",\n  \"files\": [{}]\n}}\n",
        escape_json(slug),
        escape_json(session_id),
        escape_json(&source_dir.to_string_lossy()),
        escape_json(&utc_now_iso()),
        files_json
    )
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
