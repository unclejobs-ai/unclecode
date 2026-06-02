use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::session_listing::{parse_session_list_item, parse_session_resume_summary};
pub use crate::session_listing::{SessionListItem, SessionResumeSummary};
use crate::sha256::sha256_hex;

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
pub struct WorkShellSessionSnapshot {
    pub session_id: String,
    pub project_path: String,
    pub model: String,
    pub mode: String,
    pub state: String,
    pub summary: String,
    pub trace_mode: Option<String>,
    pub reasoning_effort: Option<String>,
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
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
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
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
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
        let Some(parsed_session_id) = extract_json_string(&raw, "sessionId") else {
            return Ok(None);
        };
        Ok(Some(WorkShellResume {
            session_id: parsed_session_id,
            trace_mode: extract_json_string(&raw, "traceMode")
                .filter(|value| value == "minimal" || value == "verbose"),
            reasoning_effort: extract_json_string(&raw, "reasoningEffort")
                .filter(|value| value == "low" || value == "medium" || value == "high"),
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
    format!("{:013}", now_ms())
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
            format!(
                ",\"reasoningEffort\":\"{}\"",
                escape_json(reasoning_effort)
            )
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
    let trace = snapshot
        .trace_mode
        .as_ref()
        .map(|trace_mode| format!(",\"traceMode\":\"{}\"", escape_json(trace_mode)))
        .unwrap_or_default();
    let reasoning = snapshot
        .reasoning_effort
        .as_ref()
        .map(|reasoning_effort| {
            format!(
                ",\"reasoningEffort\":\"{}\"",
                escape_json(reasoning_effort)
            )
        })
        .unwrap_or_default();
    format!(
        "{{\"sessionId\":\"{}\",\"projectPath\":\"{}\",\"eventCount\":{},\"updatedAt\":\"{}\",\"state\":\"{}\",\"metadata\":{{\"model\":\"{}\",\"taskSummary\":\"{}\",\"isUltraworkMode\":{}{}{}}},\"taskSummary\":{{\"summary\":\"{}\",\"timestamp\":\"{}\"}},\"mode\":\"normal\"}}",
        escape_json(&snapshot.session_id),
        escape_json(&snapshot.project_path),
        event_count,
        escape_json(updated_at),
        escape_json(&snapshot.state),
        escape_json(&snapshot.model),
        escape_json(&snapshot.summary),
        if snapshot.mode == "ultrawork" { "true" } else { "false" },
        trace,
        reasoning,
        escape_json(&snapshot.summary),
        escape_json(updated_at)
    )
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
            })
            .expect("persist snapshot");

        let lines = store.list_session_lines(&project).expect("list sessions");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].session_id, "work-session-1");
        assert_eq!(lines[0].summary, "Chat: inspect repo");
        let resumed = store
            .resume_work_shell_session(&project, "work-session-1")
            .expect("resume")
            .expect("resumed");
        assert_eq!(resumed.session_id, "work-session-1");
        assert_eq!(resumed.trace_mode, Some("verbose".to_string()));

        let _ = fs::remove_dir_all(root);
    }
}
