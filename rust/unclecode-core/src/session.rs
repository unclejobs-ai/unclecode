use std::cmp::Reverse;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::redaction::redact_secrets;
use crate::session_listing::{parse_session_list_item, parse_session_resume_summary};
pub use crate::session_listing::{SessionListItem, SessionResumeSummary};
use crate::sha256::sha256_hex;
use crate::time_iso::{unix_millis_to_iso, utc_now_iso};
use serde_json::{json, Value};

const MAX_RESUME_ENTRIES: usize = 24;
const MAX_RESUME_ENTRY_CHARS: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvent {
    pub timestamp_ms: u128,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct SessionLog {
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkShellTranscriptEntry {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkShellSessionSnapshot {
    pub session_id: String,
    pub project_path: String,
    pub model: String,
    pub mode: String,
    pub state: String,
    pub summary: String,
    pub trace_mode: Option<String>,
    pub reasoning_effort: Option<String>,
    pub entries: Vec<WorkShellTranscriptEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLine {
    pub session_id: String,
    pub updated_at: String,
    pub state: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkShellResume {
    pub session_id: String,
    pub trace_mode: Option<String>,
    pub reasoning_effort: Option<String>,
    pub summary: String,
    pub entries: Vec<WorkShellTranscriptEntry>,
}

#[derive(Debug, Clone)]
pub struct WorkShellSessionStore {
    root_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPaths {
    pub project_dir: PathBuf,
    pub session_dir: PathBuf,
    pub event_log_path: PathBuf,
    pub checkpoint_path: PathBuf,
    pub project_memory_dir: PathBuf,
    pub project_memory_db_path: PathBuf,
    pub research_artifacts_dir: PathBuf,
}

impl SessionLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(
        &self,
        kind: impl Into<String>,
        text: impl Into<String>,
    ) -> io::Result<SessionEvent> {
        let event = SessionEvent {
            timestamp_ms: now_ms(),
            kind: kind.into(),
            text: text.into(),
        };
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{}", event.to_ndjson_line())?;
        Ok(event)
    }
}

impl WorkShellSessionStore {
    pub fn new(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
        }
    }

    pub fn persist_work_shell_snapshot(
        &self,
        snapshot: &WorkShellSessionSnapshot,
    ) -> io::Result<()> {
        let paths = session_paths(
            &self.root_dir,
            Path::new(&snapshot.project_path),
            &snapshot.session_id,
        );
        fs::create_dir_all(&paths.session_dir)?;
        fs::create_dir_all(&paths.project_memory_dir)?;
        fs::create_dir_all(&paths.research_artifacts_dir)?;

        let records = build_work_shell_records(snapshot);
        let mut existing_count = count_lines(&paths.event_log_path)?;
        let mut updated_at = String::new();
        let mut event_log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&paths.event_log_path)?;
        for record in &records {
            updated_at = record.timestamp.clone();
            existing_count += 1;
            writeln!(event_log, "{}", record.to_json(&snapshot.session_id))?;
        }

        fs::write(
            &paths.checkpoint_path,
            build_checkpoint_json(snapshot, existing_count, &updated_at),
        )
    }

    pub fn list_session_lines(&self, project_path: &Path) -> io::Result<Vec<SessionLine>> {
        let probe = session_paths(
            &self.root_dir,
            project_path,
            "work-shell-session-list-probe",
        );
        let entries = match fs::read_dir(&probe.session_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut sessions = Vec::new();
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".checkpoint.json") {
                continue;
            }
            let raw = fs::read_to_string(entry.path())?;
            if let Some(line) = parse_session_line(&raw) {
                sessions.push(line);
            }
        }
        sessions.sort_by_cached_key(|session| {
            (
                Reverse(timestamp_sort_key(&session.updated_at)),
                Reverse(session.updated_at.clone()),
            )
        });
        sessions.truncate(6);
        Ok(sessions)
    }

    pub fn list_session_items(&self, project_path: &Path) -> io::Result<Vec<SessionListItem>> {
        let probe = session_paths(&self.root_dir, project_path, "session-list-probe");
        let entries = match fs::read_dir(&probe.session_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut sessions = Vec::new();
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            if !name.to_string_lossy().ends_with(".checkpoint.json") {
                continue;
            }
            let raw = fs::read_to_string(entry.path())?;
            if let Some(item) = parse_session_list_item(&raw) {
                sessions.push(item);
            }
        }
        sessions.sort_by_cached_key(|session| {
            (
                Reverse(timestamp_sort_key(&session.updated_at)),
                Reverse(session.updated_at.clone()),
            )
        });
        Ok(sessions)
    }

    pub fn resume_work_shell_session(
        &self,
        project_path: &Path,
        session_id: &str,
    ) -> io::Result<Option<WorkShellResume>> {
        let paths = session_paths(&self.root_dir, project_path, session_id);
        let raw = match fs::read_to_string(&paths.checkpoint_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return Ok(None);
        };
        let Some(parsed_session_id) = parsed
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return Ok(None);
        };
        let trace_mode = parsed
            .get("metadata")
            .and_then(|value| value.get("traceMode"))
            .and_then(Value::as_str)
            .filter(|value| *value == "minimal" || *value == "verbose")
            .map(str::to_string);
        let reasoning_effort = parsed
            .get("metadata")
            .and_then(|value| value.get("reasoningEffort"))
            .and_then(Value::as_str)
            .filter(|value| *value == "low" || *value == "medium" || *value == "high")
            .map(str::to_string);
        let summary = parsed
            .get("taskSummary")
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .unwrap_or("none")
            .to_string();
        let entries = parsed
            .get("entries")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| {
                        let role = entry.get("role").and_then(Value::as_str)?;
                        let text = entry.get("text").and_then(Value::as_str)?;
                        Some(WorkShellTranscriptEntry {
                            role: role.to_string(),
                            text: text.to_string(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(Some(WorkShellResume {
            session_id: parsed_session_id,
            trace_mode,
            reasoning_effort,
            summary,
            entries,
        }))
    }

    pub fn resume_session_summary(
        &self,
        project_path: &Path,
        session_id: &str,
    ) -> io::Result<Option<SessionResumeSummary>> {
        let paths = session_paths(&self.root_dir, project_path, session_id);
        let raw = match fs::read_to_string(&paths.checkpoint_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok(parse_session_resume_summary(&raw, session_id))
    }
}

pub fn persist_work_shell_session_snapshot_json(
    store: &WorkShellSessionStore,
    project_path: &Path,
    payload: &str,
) -> Result<String, String> {
    let parsed = serde_json::from_str::<Value>(payload)
        .map_err(|error| format!("Invalid session persist JSON: {error}"))?;
    let session_id = required_string_field(&parsed, "sessionId", SESSION_PERSIST_JSON_USAGE)?;
    let model = required_string_field(&parsed, "model", SESSION_PERSIST_JSON_USAGE)?;
    let mode = required_string_field(&parsed, "mode", SESSION_PERSIST_JSON_USAGE)?;
    let state = required_string_field(&parsed, "state", SESSION_PERSIST_JSON_USAGE)?;
    let summary = required_string_field(&parsed, "summary", SESSION_PERSIST_JSON_USAGE)?;
    let trace_mode = parsed
        .get("traceMode")
        .and_then(Value::as_str)
        .filter(|value| *value == "minimal" || *value == "verbose")
        .map(str::to_string);
    let reasoning_effort = parsed
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "low" | "medium" | "high"))
        .map(str::to_string);
    let entries = parsed
        .get("entries")
        .and_then(Value::as_array)
        .map(|items| parse_transcript_entries(items))
        .unwrap_or_default();

    store
        .persist_work_shell_snapshot(&WorkShellSessionSnapshot {
            session_id: session_id.to_string(),
            project_path: project_path.to_string_lossy().to_string(),
            model: model.to_string(),
            mode: mode.to_string(),
            state: state.to_string(),
            summary: summary.to_string(),
            trace_mode,
            reasoning_effort,
            entries,
        })
        .map_err(|error| format!("Failed to persist session snapshot: {error}"))?;
    Ok(session_id.to_string())
}

pub fn resume_work_shell_session_json(
    store: &WorkShellSessionStore,
    project_path: &Path,
    session_id: &str,
) -> Result<Option<String>, String> {
    let Some(resumed) = store
        .resume_work_shell_session(project_path, session_id)
        .map_err(|error| format!("Failed to resume session: {error}"))?
    else {
        return Ok(None);
    };
    serde_json::to_string(&json!({
        "sessionId": resumed.session_id,
        "traceMode": resumed.trace_mode,
        "reasoningEffort": resumed.reasoning_effort,
        "contextLine": format!("Resumed session: {session_id}"),
        "initialSessionSummary": resumed.summary,
        "initialEntries": resumed
            .entries
            .into_iter()
            .map(|entry| json!({ "role": entry.role, "text": entry.text }))
            .collect::<Vec<_>>(),
    }))
    .map(Some)
    .map_err(|error| format!("Failed to serialize resumed session: {error}"))
}

const SESSION_PERSIST_JSON_USAGE: &str =
    "Usage: unclecode rust session persist-json (stdin JSON must include sessionId, model, mode, state, summary)";

fn required_string_field<'a>(
    value: &'a Value,
    field: &str,
    usage: &'static str,
) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(usage.to_string())
}

fn parse_transcript_entries(items: &[Value]) -> Vec<WorkShellTranscriptEntry> {
    items
        .iter()
        .filter_map(|entry| {
            let role = entry.get("role").and_then(Value::as_str)?;
            if !is_resume_entry_role(role) {
                return None;
            }
            let text = entry.get("text").and_then(Value::as_str)?;
            Some(WorkShellTranscriptEntry {
                role: role.to_string(),
                text: minimize_resume_entry_text(text),
            })
        })
        .collect()
}

fn is_resume_entry_role(role: &str) -> bool {
    matches!(role, "user" | "assistant")
}

fn minimize_resume_entries(entries: &[WorkShellTranscriptEntry]) -> Vec<WorkShellTranscriptEntry> {
    let slice = if entries.len() > MAX_RESUME_ENTRIES {
        &entries[entries.len() - MAX_RESUME_ENTRIES..]
    } else {
        entries
    };
    slice
        .iter()
        .filter(|entry| is_resume_entry_role(&entry.role))
        .map(|entry| WorkShellTranscriptEntry {
            role: entry.role.clone(),
            text: minimize_resume_entry_text(&entry.text),
        })
        .collect()
}

fn minimize_resume_entry_text(text: &str) -> String {
    let redacted = redact_resume_secrets(&redact_secrets(text).replace('\0', "\u{FFFD}"));
    let without_reference_bodies = strip_reference_body_lines(&redacted);
    truncate_chars(&without_reference_bodies, MAX_RESUME_ENTRY_CHARS)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut iter = value.chars();
    let truncated = iter.by_ref().take(max_chars).collect::<String>();
    if iter.next().is_some() {
        format!("{truncated}... [truncated]")
    } else {
        truncated
    }
}

fn strip_reference_body_lines(value: &str) -> String {
    let has_reference = value
        .lines()
        .any(|line| is_reference_summary_line(line.trim()));
    if !has_reference {
        return value.to_string();
    }

    let mut lines: Vec<String> = Vec::new();
    let mut seen_reference = false;
    for raw_line in value.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if is_reference_summary_line(line) {
            seen_reference = true;
            if !lines
                .iter()
                .any(|existing: &String| existing.as_str() == line)
            {
                lines.push(line.to_string());
            }
            continue;
        }
        if !seen_reference {
            lines.push(line.to_string());
        }
    }
    lines.join("\n")
}

fn is_reference_summary_line(line: &str) -> bool {
    line.starts_with("Referenced file:") || line.starts_with("Referenced directory:")
}

fn redact_resume_secrets(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find("sk-") {
        let (before, after_prefix) = rest.split_at(index);
        out.push_str(before);
        let token_len = after_prefix
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .map(char::len_utf8)
            .sum::<usize>();
        if token_len >= 8 {
            out.push_str("[REDACTED]");
            rest = &after_prefix[token_len..];
        } else {
            out.push_str("sk-");
            rest = &after_prefix[3..];
        }
    }
    out.push_str(rest);
    out
}

#[derive(Debug, Clone)]
struct WorkShellRecord {
    timestamp: String,
    checkpoint_json: String,
}

impl WorkShellRecord {
    fn to_json(&self, session_id: &str) -> String {
        format!(
            "{{\"kind\":\"checkpoint\",\"sessionId\":\"{}\",\"timestamp\":\"{}\",\"checkpoint\":{}}}",
            escape_json(session_id),
            escape_json(&self.timestamp),
            self.checkpoint_json
        )
    }
}

impl SessionEvent {
    pub fn to_ndjson_line(&self) -> String {
        format!(
            "{{\"timestamp_ms\":{},\"kind\":\"{}\",\"text\":\"{}\"}}",
            self.timestamp_ms,
            escape_json(&self.kind),
            escape_json(&self.text)
        )
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_timestamp() -> String {
    utc_now_iso()
}

fn timestamp_sort_key(value: &str) -> String {
    if value.len() >= 13 && value.chars().all(|ch| ch.is_ascii_digit()) {
        return value
            .parse::<u128>()
            .map(unix_millis_to_iso)
            .unwrap_or_else(|_| value.to_string());
    }
    value.to_string()
}

pub fn session_paths(root_dir: &Path, project_path: &Path, session_id: &str) -> SessionPaths {
    let project_dir = root_dir
        .join("projects")
        .join(to_opaque_project_bucket(project_path));
    let session_dir = project_dir.join("sessions");
    let session_file_id = to_opaque_id(session_id, "session");
    let project_memory_dir = project_dir.join("memory");
    SessionPaths {
        project_dir: project_dir.clone(),
        session_dir: session_dir.clone(),
        event_log_path: session_dir.join(format!("{session_file_id}.events.jsonl")),
        checkpoint_path: session_dir.join(format!("{session_file_id}.checkpoint.json")),
        project_memory_db_path: project_memory_dir.join("project-memory.sqlite"),
        project_memory_dir,
        research_artifacts_dir: project_dir.join("research-artifacts").join(session_file_id),
    }
}

fn to_opaque_project_bucket(project_path: &Path) -> String {
    let canonical = fs::canonicalize(project_path).unwrap_or_else(|_| project_path.to_path_buf());
    let mut normalized = canonical.to_string_lossy().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if normalized.is_empty() {
        normalized.push('/');
    }
    to_opaque_id(&normalized, "project")
}

fn to_opaque_id(value: &str, prefix: &str) -> String {
    format!("{}-{}", prefix, &sha256_hex(value)[..20])
}

fn count_lines(path: &Path) -> io::Result<usize> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(raw.lines().filter(|line| !line.trim().is_empty()).count()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn build_work_shell_records(snapshot: &WorkShellSessionSnapshot) -> Vec<WorkShellRecord> {
    let summary_timestamp = now_timestamp();
    let metadata_trace = snapshot
        .trace_mode
        .as_ref()
        .map(|trace_mode| format!(",\"traceMode\":\"{}\"", escape_json(trace_mode)))
        .unwrap_or_default();
    let metadata_reasoning = snapshot
        .reasoning_effort
        .as_ref()
        .map(|reasoning_effort| {
            format!(",\"reasoningEffort\":\"{}\"", escape_json(reasoning_effort))
        })
        .unwrap_or_default();
    vec![
        WorkShellRecord {
            timestamp: now_timestamp(),
            checkpoint_json: format!(
                "{{\"type\":\"state\",\"state\":\"{}\"}}",
                escape_json(&snapshot.state)
            ),
        },
        WorkShellRecord {
            timestamp: now_timestamp(),
            checkpoint_json: format!(
                "{{\"type\":\"metadata\",\"metadata\":{{\"model\":\"{}\",\"taskSummary\":\"{}\",\"isUltraworkMode\":{}{}{}}}}}",
                escape_json(&snapshot.model),
                escape_json(&snapshot.summary),
                if snapshot.mode == "ultrawork" { "true" } else { "false" },
                metadata_trace,
                metadata_reasoning,
            ),
        },
        WorkShellRecord {
            timestamp: summary_timestamp.clone(),
            checkpoint_json: format!(
                "{{\"type\":\"task_summary\",\"summary\":\"{}\",\"timestamp\":\"{}\"}}",
                escape_json(&snapshot.summary),
                summary_timestamp
            ),
        },
        WorkShellRecord {
            timestamp: now_timestamp(),
            checkpoint_json: "{\"type\":\"mode\",\"mode\":\"normal\"}".to_string(),
        },
    ]
}

fn build_checkpoint_json(
    snapshot: &WorkShellSessionSnapshot,
    event_count: usize,
    updated_at: &str,
) -> String {
    let mut metadata = serde_json::Map::new();
    metadata.insert("model".to_string(), json!(snapshot.model));
    metadata.insert("taskSummary".to_string(), json!(snapshot.summary));
    metadata.insert(
        "isUltraworkMode".to_string(),
        json!(snapshot.mode == "ultrawork"),
    );
    if let Some(trace_mode) = &snapshot.trace_mode {
        metadata.insert("traceMode".to_string(), json!(trace_mode));
    }
    if let Some(reasoning_effort) = &snapshot.reasoning_effort {
        metadata.insert("reasoningEffort".to_string(), json!(reasoning_effort));
    }

    let entries = minimize_resume_entries(&snapshot.entries);

    serde_json::to_string(&json!({
        "sessionId": snapshot.session_id,
        "projectPath": snapshot.project_path,
        "eventCount": event_count,
        "updatedAt": updated_at,
        "state": snapshot.state,
        "metadata": metadata,
        "taskSummary": {
            "summary": snapshot.summary,
            "timestamp": updated_at,
        },
        "mode": "normal",
        "entries": entries
            .into_iter()
            .map(|entry| json!({ "role": entry.role, "text": entry.text }))
            .collect::<Vec<_>>(),
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

fn parse_session_line(raw: &str) -> Option<SessionLine> {
    Some(SessionLine {
        session_id: extract_json_string(raw, "sessionId")?,
        updated_at: extract_json_string(raw, "updatedAt").unwrap_or_else(|| "unknown".to_string()),
        state: extract_json_string(raw, "state").unwrap_or_else(|| "unknown".to_string()),
        summary: extract_task_summary(raw).unwrap_or_else(|| "no summary".to_string()),
    })
}

fn extract_task_summary(raw: &str) -> Option<String> {
    let task_index = raw.find("\"taskSummary\"")?;
    extract_json_string(&raw[task_index..], "summary")
}

fn extract_json_string(raw: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\":\"");
    let start = raw.find(&pattern)? + pattern.len();
    let mut result = String::new();
    let mut escaped = false;
    for ch in raw[start..].chars() {
        if escaped {
            match ch {
                '"' => result.push('"'),
                '\\' => result.push('\\'),
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                other => result.push(other),
            }
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(result),
            other => result.push(other),
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn appends_ndjson_session_events() {
        let path = env::temp_dir().join(format!(
            "unclecode-session-test-{}-{}.ndjson",
            std::process::id(),
            now_ms()
        ));
        let log = SessionLog::new(&path);

        let event = log
            .append("assistant", "hello\nworld")
            .expect("append event");
        let content = fs::read_to_string(&path).expect("read session log");

        assert_eq!(log.path(), path.as_path());
        assert_eq!(event.kind, "assistant");
        assert!(content.contains("\"kind\":\"assistant\""));
        assert!(content.contains("\"text\":\"hello\\nworld\""));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn work_shell_snapshot_matches_session_store_shape() {
        let root = env::temp_dir().join(format!(
            "unclecode-session-store-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let store = WorkShellSessionStore::new(&root);
        store
            .persist_work_shell_snapshot(&WorkShellSessionSnapshot {
                session_id: "work-session-1".to_string(),
                project_path: project.to_string_lossy().to_string(),
                model: "gpt-5.4".to_string(),
                mode: "analyze".to_string(),
                state: "idle".to_string(),
                summary: "Chat: inspect repo".to_string(),
                trace_mode: Some("verbose".to_string()),
                reasoning_effort: Some("high".to_string()),
                entries: vec![
                    WorkShellTranscriptEntry {
                        role: "user".to_string(),
                        text: "inspect repo".to_string(),
                    },
                    WorkShellTranscriptEntry {
                        role: "assistant".to_string(),
                        text: "repo inspected".to_string(),
                    },
                ],
            })
            .expect("persist snapshot");

        let lines = store.list_session_lines(&project).expect("list sessions");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].session_id, "work-session-1");
        assert!(lines[0].updated_at.contains('T'));
        assert_eq!(lines[0].summary, "Chat: inspect repo");
        let resumed = store
            .resume_work_shell_session(&project, "work-session-1")
            .expect("resume")
            .expect("resumed");
        assert_eq!(resumed.session_id, "work-session-1");
        assert_eq!(resumed.trace_mode, Some("verbose".to_string()));
        assert_eq!(resumed.summary, "Chat: inspect repo");
        assert_eq!(resumed.entries.len(), 2);
        assert_eq!(resumed.entries[0].text, "inspect repo");
        assert_eq!(resumed.entries[1].text, "repo inspected");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_listing_orders_legacy_epoch_millis_after_older_iso() {
        let root = env::temp_dir().join(format!(
            "unclecode-session-mixed-timestamp-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let store = WorkShellSessionStore::new(&root);
        write_checkpoint(
            &root,
            &project,
            "work-old-iso",
            "2026-04-03T13:39:44.266Z",
            "Old ISO",
        );
        write_checkpoint(
            &root,
            &project,
            "work-new-epoch",
            "1782407659276",
            "New epoch",
        );

        let sessions = store.list_session_items(&project).expect("sessions");

        assert_eq!(sessions[0].session_id, "work-new-epoch");
        assert_eq!(sessions[1].session_id, "work-old-iso");
        let _ = fs::remove_dir_all(root);
    }

    fn write_checkpoint(
        root: &Path,
        project: &Path,
        session_id: &str,
        updated_at: &str,
        summary: &str,
    ) {
        let paths = session_paths(root, project, session_id);
        fs::create_dir_all(&paths.session_dir).expect("session dir");
        fs::write(
            paths.checkpoint_path,
            serde_json::to_string(&json!({
                "sessionId": session_id,
                "projectPath": project.to_string_lossy(),
                "eventCount": 1,
                "updatedAt": updated_at,
                "state": "idle",
                "metadata": {
                    "model": "gpt-5.4",
                    "taskSummary": summary
                },
                "taskSummary": {
                    "summary": summary,
                    "timestamp": updated_at
                },
                "mode": "normal",
                "entries": []
            }))
            .expect("checkpoint json"),
        )
        .expect("checkpoint write");
    }

    #[test]
    fn work_shell_snapshot_minimizes_resume_entries_on_disk() {
        let root = env::temp_dir().join(format!(
            "unclecode-session-minimize-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let store = WorkShellSessionStore::new(&root);
        let secret = format!("sk-proj-{}", "a".repeat(30));
        let long_text = format!(
            "ask with secret {secret} {}",
            "x".repeat(MAX_RESUME_ENTRY_CHARS + 50)
        );
        let mut entries = vec![WorkShellTranscriptEntry {
            role: "ignored".to_string(),
            text: "should not persist".to_string(),
        }];
        for index in 0..30 {
            entries.push(WorkShellTranscriptEntry {
                role: "user".to_string(),
                text: format!("{index}: {long_text}"),
            });
        }

        store
            .persist_work_shell_snapshot(&WorkShellSessionSnapshot {
                session_id: "work-session-minimized".to_string(),
                project_path: project.to_string_lossy().to_string(),
                model: "gpt-5.4".to_string(),
                mode: "analyze".to_string(),
                state: "idle".to_string(),
                summary: "Chat: minimize".to_string(),
                trace_mode: Some("minimal".to_string()),
                reasoning_effort: None,
                entries,
            })
            .expect("persist snapshot");

        let paths = session_paths(&root, &project, "work-session-minimized");
        let checkpoint = fs::read_to_string(paths.checkpoint_path).expect("checkpoint");
        assert!(!checkpoint.contains(&secret));
        assert!(!checkpoint.contains("should not persist"));
        assert!(checkpoint.contains("[REDACTED]"));
        assert!(checkpoint.contains("[truncated]"));

        let resumed = store
            .resume_work_shell_session(&project, "work-session-minimized")
            .expect("resume")
            .expect("resumed");
        assert_eq!(resumed.entries.len(), MAX_RESUME_ENTRIES);
        assert!(resumed.entries.iter().all(|entry| entry.role == "user"));
        assert!(resumed
            .entries
            .iter()
            .all(|entry| entry.text.len() <= MAX_RESUME_ENTRY_CHARS + 16));

        let _ = fs::remove_dir_all(root);
    }
}
