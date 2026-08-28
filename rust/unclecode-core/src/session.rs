use std::cmp::Reverse;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::model_registry::is_openai_reasoning_effort;
use crate::redaction::redact_secrets;
use crate::session_listing::{parse_session_list_item, parse_session_resume_summary};
pub use crate::session_listing::{SessionListItem, SessionResumeSummary};
use crate::sha256::sha256_hex;
use crate::time_iso::{unix_millis_to_iso, utc_now_iso};
use serde_json::{json, Map, Value};

const MAX_RESUME_ENTRIES: usize = 24;
const MAX_AGENT_CONSOLE_BYTES: usize = 32 * 1024;
const MAX_AGENT_CONSOLE_ACTIVITY: usize = 80;
const MAX_AGENT_CONSOLE_AGENTS: usize = 128;
const MAX_AGENT_CONSOLE_JOBS: usize = 128;
const MAX_AGENT_CONSOLE_EVOLUTION_PROPOSALS: usize = 32;
const MAX_RESUME_ENTRY_CHARS: usize = 600;
const SESSION_NOTICE_VERSION: u8 = 1;
static ATOMIC_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    pub last_submitted_context_receipt_id: Option<String>,
    pub entries: Vec<WorkShellTranscriptEntry>,
    pub agent_console: Option<Value>,
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
    pub last_submitted_context_receipt_id: Option<String>,
    pub summary: String,
    pub entries: Vec<WorkShellTranscriptEntry>,
    pub agent_console: Option<Value>,
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

        let checkpoint = build_checkpoint_json(snapshot, existing_count, &updated_at);
        write_atomic_durable(&paths.checkpoint_path, checkpoint.as_bytes())?;
        self.persist_checkpoint_notice(&snapshot.session_id, existing_count)
    }

    fn persist_checkpoint_notice(&self, session_id: &str, revision: usize) -> io::Result<()> {
        let notice_dir = self.root_dir.join("notifications");
        let notice_path = notice_dir.join(format!(
            "{}.notice.json",
            to_opaque_id(session_id, "session")
        ));
        let notice = serde_json::to_vec(&json!({
            "version": SESSION_NOTICE_VERSION,
            "sessionId": session_id,
            "revision": revision,
        }))
        .map_err(io::Error::other)?;
        write_atomic_durable(&notice_path, &notice)
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
            .filter(|value| is_openai_reasoning_effort(value))
            .map(str::to_string);
        let last_submitted_context_receipt_id = parsed
            .get("metadata")
            .and_then(|value| value.get("lastSubmittedContextReceiptId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
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
        let agent_console = parsed
            .get("agentConsole")
            .and_then(sanitize_agent_console_snapshot);
        Ok(Some(WorkShellResume {
            session_id: parsed_session_id,
            trace_mode,
            reasoning_effort,
            last_submitted_context_receipt_id,
            summary,
            entries,
            agent_console,
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
        .filter(|value| is_openai_reasoning_effort(value))
        .map(str::to_string);
    let last_submitted_context_receipt_id = parsed
        .get("lastSubmittedContextReceiptId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let entries = parsed
        .get("entries")
        .and_then(Value::as_array)
        .map(|items| parse_transcript_entries(items))
        .unwrap_or_default();
    let agent_console = parsed
        .get("agentConsole")
        .and_then(sanitize_agent_console_snapshot);

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
            last_submitted_context_receipt_id,
            entries,
            agent_console,
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
        "lastSubmittedContextReceiptId": resumed.last_submitted_context_receipt_id,
        "contextLine": format!("Resumed session: {session_id}"),
        "initialSessionSummary": resumed.summary,
        "initialEntries": resumed
            .entries
            .into_iter()
            .map(|entry| json!({ "role": entry.role, "text": entry.text }))
            .collect::<Vec<_>>(),
        "agentConsole": resumed.agent_console,
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

fn write_atomic_durable(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "durable file has no parent"))?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid durable file name"))?;
    let nonce = ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(".{file_name}.tmp-{}-{nonce}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        OpenOptions::new().read(true).open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sanitize_agent_console_snapshot(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let profile_id = source.get("profileId")?.as_str()?;
    if !matches!(profile_id, "build" | "explore" | "review") {
        return None;
    }

    let mut snapshot = Map::new();
    snapshot.insert(
        "profileId".to_string(),
        Value::String(profile_id.to_string()),
    );

    if let Some(manifest) = source.get("manifest") {
        snapshot.insert("manifest".to_string(), sanitize_prompt_manifest(manifest)?);
    }
    if let Some(pending_decision) = source.get("pendingDecision") {
        snapshot.insert(
            "pendingDecision".to_string(),
            sanitize_pending_decision(pending_decision)?,
        );
    }
    if let Some(work_graph) = source.get("workGraph") {
        snapshot.insert("workGraph".to_string(), sanitize_work_graph(work_graph)?);
    }
    if let Some(evolution_proposals) = source.get("evolutionProposals") {
        let evolution_proposals = evolution_proposals.as_array()?;
        let start = evolution_proposals
            .len()
            .saturating_sub(MAX_AGENT_CONSOLE_EVOLUTION_PROPOSALS);
        let evolution_proposals = evolution_proposals[start..]
            .iter()
            .map(sanitize_evolution_proposal)
            .collect::<Option<Vec<_>>>()?;
        snapshot.insert(
            "evolutionProposals".to_string(),
            Value::Array(evolution_proposals),
        );
    }

    let activity = source.get("activity")?.as_array()?;
    let start = activity.len().saturating_sub(MAX_AGENT_CONSOLE_ACTIVITY);
    let activity = activity[start..]
        .iter()
        .map(sanitize_tool_activity)
        .collect::<Option<Vec<_>>>()?;
    snapshot.insert("activity".to_string(), Value::Array(activity));

    // Lifecycle projections are rebuilt field by field for the same reason as
    // the activity list: only the named safe fields cross the durable gate, so
    // a worker prompt, raw assignment, or provider credential can never ride
    // along inside an agent or job record. A missing key is a legacy snapshot.
    if let Some(agents) = source.get("agents") {
        let agents = agents.as_array()?;
        let start = agents.len().saturating_sub(MAX_AGENT_CONSOLE_AGENTS);
        let agents = agents[start..]
            .iter()
            .map(sanitize_agent_run)
            .collect::<Option<Vec<_>>>()?;
        snapshot.insert("agents".to_string(), Value::Array(agents));
    }
    if let Some(jobs) = source.get("jobs") {
        let jobs = jobs.as_array()?;
        let start = jobs.len().saturating_sub(MAX_AGENT_CONSOLE_JOBS);
        let jobs = jobs[start..]
            .iter()
            .map(sanitize_async_job)
            .collect::<Option<Vec<_>>>()?;
        snapshot.insert("jobs".to_string(), Value::Array(jobs));
    }
    if let Some(main_usage) = source.get("mainUsage") {
        snapshot.insert(
            "mainUsage".to_string(),
            sanitize_agent_run_usage(main_usage)?,
        );
    }

    // Allowlisting and redaction both run before fitting, so the size ladder
    // below can only ever remove safe data — it can never keep an unknown field
    // or a secret to make the budget work.
    let Value::Object(sanitized) = redact_json_strings(Value::Object(snapshot)) else {
        return None;
    };
    Some(Value::Object(fit_agent_console_snapshot(sanitized)))
}

/// Longest bounded prose a compacted lifecycle record keeps.
const COMPACT_TEXT_CHARS: usize = 80;

const COMPACTABLE_TEXT_FIELDS: &[&str] = &[
    "summary",
    "errorSummary",
    "currentActivity",
    "intent",
    "target",
];

const LIFECYCLE_ARRAY_KEYS: &[&str] = &["activity", "agents", "jobs"];

fn console_byte_len(snapshot: &Map<String, Value>) -> usize {
    serde_json::to_vec(snapshot).map_or(usize::MAX, |bytes| bytes.len())
}

fn console_fits(snapshot: &Map<String, Value>) -> bool {
    console_byte_len(snapshot) <= MAX_AGENT_CONSOLE_BYTES
}

/// Bytes a JSON array loses when one element is removed: the element's own
/// serialization plus the separator comma it no longer needs. `before` is the
/// element count prior to the removal. Serde emits no whitespace, so this is
/// exact — it is only ever used as a fast pre-filter in front of a real
/// re-measure, so drift could cost an extra measurement, never correctness.
fn removed_array_element_bytes(removed: &Value, before: usize) -> usize {
    let element = serde_json::to_vec(removed).map_or(0, |bytes| bytes.len());
    element + usize::from(before >= 2)
}

/// Deterministic size fitting for the durable console projection.
///
/// A legal bounded history can still exceed the byte budget, and discarding the
/// whole console would resume a session with no interruptible work at all. The
/// stages below run in one fixed order — most expendable first — and each stops
/// the moment the projection fits:
///
///  1. per-run usage replay identities (`eventIds`, `routes`); counters stay
///  2. the aggregate `mainUsage` replay identities; its counters stay
///  3. oldest tool activity
///  4. oldest settled jobs, then oldest settled agents
///  5. lifecycle transcript metadata, then bounded prose compacted, then dropped
///  6. the manifest policy list — provenance bulk, not manifest identity
///  7. decision prose — option descriptions, then question and title text
///  8. the manifest
///  9. the proposed work graph
/// 10. the pending decision
/// 11. oldest active jobs, then oldest active agents — identity is sacrificed last
/// 12. the smallest valid safe projection, which always fits
///
/// Stages 6–10 sit ahead of stage 11 deliberately: optional shell metadata is
/// recoverable (the operator can re-ask, and a resumed decision is announced as
/// unresumable anyway) while an evicted active identity leaves resume with
/// nothing to mark interrupted.
fn fit_agent_console_snapshot(mut snapshot: Map<String, Value>) -> Map<String, Value> {
    if console_fits(&snapshot) {
        return snapshot;
    }

    strip_run_usage_replay_identities(&mut snapshot);
    if console_fits(&snapshot) {
        return snapshot;
    }

    if let Some(main_usage) = snapshot.get_mut("mainUsage") {
        strip_usage_replay_identity(main_usage);
    }
    if console_fits(&snapshot) {
        return snapshot;
    }

    trim_oldest_entries(&mut snapshot, "activity", |_| false);
    if console_fits(&snapshot) {
        return snapshot;
    }

    trim_oldest_entries(&mut snapshot, "jobs", is_active_async_job);
    if console_fits(&snapshot) {
        return snapshot;
    }

    trim_oldest_entries(&mut snapshot, "agents", is_active_agent_run);
    if console_fits(&snapshot) {
        return snapshot;
    }

    drop_lifecycle_field(&mut snapshot, "transcriptRef");
    if console_fits(&snapshot) {
        return snapshot;
    }

    compact_lifecycle_text(&mut snapshot, Some(COMPACT_TEXT_CHARS));
    if console_fits(&snapshot) {
        return snapshot;
    }

    compact_lifecycle_text(&mut snapshot, None);
    if console_fits(&snapshot) {
        return snapshot;
    }

    trim_manifest_policy(&mut snapshot);
    if console_fits(&snapshot) {
        return snapshot;
    }

    compact_pending_decision(&mut snapshot);
    if console_fits(&snapshot) {
        return snapshot;
    }

    trim_evolution_proposals(&mut snapshot);
    if console_fits(&snapshot) {
        return snapshot;
    }

    snapshot.remove("manifest");
    if console_fits(&snapshot) {
        return snapshot;
    }

    snapshot.remove("workGraph");
    if console_fits(&snapshot) {
        return snapshot;
    }

    snapshot.remove("pendingDecision");
    if console_fits(&snapshot) {
        return snapshot;
    }

    trim_oldest_entries(&mut snapshot, "jobs", |_| false);
    if console_fits(&snapshot) {
        return snapshot;
    }

    trim_oldest_entries(&mut snapshot, "agents", |_| false);
    if console_fits(&snapshot) {
        return snapshot;
    }

    minimal_agent_console_snapshot(&snapshot)
}

/// Drop the oldest expendable entries of one JSON array in a single linear
/// pass.
///
/// One forward scan finds the smallest window whose removal frees `excess`
/// bytes, then one `retain` rebuilds the vector. Removing entries one at a time
/// would shift every surviving `Value` on each removal — Θ(n²) moves on a
/// synchronous persistence path that the engine's ordered write queue waits on.
///
/// Accounting is in serialized bytes, never characters: `manifest.policy`
/// labels and lifecycle prose are arbitrary UTF-8, so a character count would
/// under-measure multibyte text and over-trim. `keep` names the records this
/// stage refuses to sacrifice; they stay even when they sit inside the scan
/// window, and they do not count towards the freed total.
fn drop_oldest_until_freed(items: &mut Vec<Value>, excess: usize, keep: fn(&Value) -> bool) {
    if excess == 0 || items.is_empty() {
        return;
    }
    let mut remaining = items.len();
    let mut freed = 0usize;
    let mut cutoff = 0usize;
    for (index, item) in items.iter().enumerate() {
        if freed >= excess {
            break;
        }
        cutoff = index + 1;
        if keep(item) {
            continue;
        }
        freed += removed_array_element_bytes(item, remaining);
        remaining -= 1;
    }
    if remaining == items.len() {
        return;
    }
    let mut index = 0usize;
    items.retain(|item| {
        let position = index;
        index += 1;
        position >= cutoff || keep(item)
    });
}

fn manifest_policy_mut(snapshot: &mut Map<String, Value>) -> Option<&mut Vec<Value>> {
    snapshot
        .get_mut("manifest")
        .and_then(Value::as_object_mut)
        .and_then(|manifest| manifest.get_mut("policy"))
        .and_then(Value::as_array_mut)
}

/// The policy list is the manifest's bulk and its most expendable part: the
/// manifest identity (`id`, `packetId`, counts) is what a resumed console needs
/// to name the packet it was built from. The key itself must stay — the resume
/// sanitizer requires it — so it empties rather than disappears.
fn trim_manifest_policy(snapshot: &mut Map<String, Value>) {
    let Some(excess) = console_byte_len(snapshot).checked_sub(MAX_AGENT_CONSOLE_BYTES) else {
        return;
    };
    if let Some(policy) = manifest_policy_mut(snapshot) {
        drop_oldest_until_freed(policy, excess, |_| false);
    }
    // The byte accounting is exact, but the serializer stays the authority. If
    // it disagrees, spend the rest of the list in one more linear rebuild
    // rather than trusting the estimate.
    if console_fits(snapshot) {
        return;
    }
    if let Some(policy) = manifest_policy_mut(snapshot) {
        policy.clear();
    }
}

/// Compact a pending decision without making it unanswerable. Option labels,
/// question ids, and the recommended index are the answer contract, so only the
/// prose is touched: descriptions go first, then the question and title text is
/// truncated. Emptying `questions` or `options` would fail the resume parser.
fn compact_pending_decision(snapshot: &mut Map<String, Value>) {
    let Some(decision) = snapshot
        .get_mut("pendingDecision")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    if let Some(title) = decision.get("title").and_then(Value::as_str) {
        let compacted = title.chars().take(COMPACT_TEXT_CHARS).collect::<String>();
        if compacted.trim().is_empty() {
            decision.remove("title");
        } else {
            decision.insert("title".to_string(), Value::String(compacted));
        }
    }
    let Some(questions) = decision.get_mut("questions").and_then(Value::as_array_mut) else {
        return;
    };
    for question in questions.iter_mut() {
        let Some(question) = question.as_object_mut() else {
            continue;
        };
        if let Some(text) = question.get("question").and_then(Value::as_str) {
            let compacted = text.chars().take(COMPACT_TEXT_CHARS).collect::<String>();
            if !compacted.trim().is_empty() {
                question.insert("question".to_string(), Value::String(compacted));
            }
        }
        let Some(options) = question.get_mut("options").and_then(Value::as_array_mut) else {
            continue;
        };
        for option in options.iter_mut() {
            if let Some(option) = option.as_object_mut() {
                option.remove("description");
            }
        }
    }
}

fn trim_evolution_proposals(snapshot: &mut Map<String, Value>) {
    loop {
        if console_fits(snapshot) {
            return;
        }
        let Some(proposals) = snapshot
            .get_mut("evolutionProposals")
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        // The newest host record is the authoritative lifecycle outcome. Keep
        // it while spending older history under the durable byte budget.
        if proposals.len() <= 1 {
            return;
        }
        proposals.remove(0);
    }
}

fn is_active_agent_run(agent: &Value) -> bool {
    matches!(
        agent.get("status").and_then(Value::as_str),
        Some("queued" | "running" | "waiting")
    )
}

fn is_active_async_job(job: &Value) -> bool {
    matches!(
        job.get("status").and_then(Value::as_str),
        Some("queued" | "running")
    )
}

/// Remove the oldest entries of one lifecycle array until the projection fits.
/// Lists are in creation order, so index order is age order. Same one-pass
/// rebuild as the manifest policy: scan for the cutoff, then `retain` once.
fn trim_oldest_entries(snapshot: &mut Map<String, Value>, key: &str, keep: fn(&Value) -> bool) {
    let Some(excess) = console_byte_len(snapshot).checked_sub(MAX_AGENT_CONSOLE_BYTES) else {
        return;
    };
    if let Some(items) = snapshot.get_mut(key).and_then(Value::as_array_mut) {
        drop_oldest_until_freed(items, excess, keep);
    }
    if console_fits(snapshot) {
        return;
    }
    if let Some(items) = snapshot.get_mut(key).and_then(Value::as_array_mut) {
        items.retain(|item| keep(item));
    }
}

fn strip_run_usage_replay_identities(snapshot: &mut Map<String, Value>) {
    let Some(Value::Array(agents)) = snapshot.get_mut("agents") else {
        return;
    };
    for agent in agents.iter_mut() {
        if let Some(usage) = agent.get_mut("usage") {
            strip_usage_replay_identity(usage);
        }
    }
}

/// Replay identities are dedupe bookkeeping, not operator evidence. Dropping
/// them under size pressure keeps the counters an operator actually reads; the
/// cost is that a resumed trace may re-count a duplicate event, which is a far
/// smaller loss than resuming with no console at all.
fn strip_usage_replay_identity(usage: &mut Value) {
    let Some(usage) = usage.as_object_mut() else {
        return;
    };
    usage.remove("routes");
    usage.insert("eventIds".to_string(), Value::Array(Vec::new()));
}

fn drop_lifecycle_field(snapshot: &mut Map<String, Value>, field: &str) {
    for key in LIFECYCLE_ARRAY_KEYS {
        let Some(Value::Array(items)) = snapshot.get_mut(*key) else {
            continue;
        };
        for item in items.iter_mut() {
            if let Some(record) = item.as_object_mut() {
                record.remove(field);
            }
        }
    }
}

/// Compact bounded prose. `Some(limit)` truncates on a char boundary; `None`
/// removes the field. A truncation that would leave blank text removes the
/// field instead, so the projection stays valid for the resume parser.
fn compact_lifecycle_text(snapshot: &mut Map<String, Value>, limit: Option<usize>) {
    for key in LIFECYCLE_ARRAY_KEYS {
        let Some(Value::Array(items)) = snapshot.get_mut(*key) else {
            continue;
        };
        for item in items.iter_mut() {
            let Some(record) = item.as_object_mut() else {
                continue;
            };
            for field in COMPACTABLE_TEXT_FIELDS {
                let Some(text) = record.get(*field).and_then(Value::as_str) else {
                    continue;
                };
                let compacted =
                    limit.map(|limit| text.chars().take(limit).collect::<String>());
                match compacted {
                    Some(compacted) if !compacted.trim().is_empty() => {
                        record.insert((*field).to_string(), Value::String(compacted));
                    }
                    _ => {
                        record.remove(*field);
                    }
                }
            }
        }
    }
}

/// The smallest projection that still identifies a session's console. It is a
/// fixed handful of bytes, so it is the one outcome that always fits.
fn minimal_agent_console_snapshot(snapshot: &Map<String, Value>) -> Map<String, Value> {
    let mut minimal = Map::new();
    minimal.insert(
        "profileId".to_string(),
        snapshot
            .get("profileId")
            .cloned()
            .unwrap_or_else(|| Value::String("build".to_string())),
    );
    minimal.insert("activity".to_string(), Value::Array(Vec::new()));
    minimal.insert("agents".to_string(), Value::Array(Vec::new()));
    minimal.insert("jobs".to_string(), Value::Array(Vec::new()));
    minimal
}

const AGENT_RUN_FIELDS: &[&str] = &[
    "id",
    "displayName",
    "agentType",
    "status",
    "currentActivity",
    "parentRunId",
    "continuationOf",
    "transcriptRef",
    "startedAt",
    "completedAt",
    "summary",
    "errorSummary",
];

const ASYNC_JOB_FIELDS: &[&str] = &[
    "id",
    "type",
    "label",
    "status",
    "agentRunId",
    "queuedAt",
    "startedAt",
    "completedAt",
    "summary",
    "errorSummary",
];

const USAGE_COUNTER_FIELDS: &[&str] = &[
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheSavingsUsd",
    "costUsd",
];

fn sanitize_agent_run(value: &Value) -> Option<Value> {
    let mut run = copy_known_fields(value, AGENT_RUN_FIELDS)?;
    if let Some(usage) = value.as_object()?.get("usage") {
        run.insert("usage".to_string(), sanitize_agent_run_usage(usage)?);
    }
    Some(Value::Object(run))
}

fn sanitize_async_job(value: &Value) -> Option<Value> {
    copy_known_fields(value, ASYNC_JOB_FIELDS).map(Value::Object)
}

fn sanitize_agent_run_usage(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let mut usage = copy_known_fields(value, USAGE_COUNTER_FIELDS)?;
    usage.insert(
        "eventIds".to_string(),
        sanitize_usage_event_ids(source.get("eventIds")?)?,
    );
    if let Some(routes) = source.get("routes") {
        let routes = routes
            .as_array()?
            .iter()
            .map(sanitize_agent_run_usage_route)
            .collect::<Option<Vec<_>>>()?;
        usage.insert("routes".to_string(), Value::Array(routes));
    }
    Some(Value::Object(usage))
}

fn sanitize_agent_run_usage_route(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let mut route = copy_known_fields(value, USAGE_COUNTER_FIELDS)?;
    route.insert(
        "provider".to_string(),
        Value::String(source.get("provider")?.as_str()?.to_string()),
    );
    route.insert(
        "model".to_string(),
        Value::String(source.get("model")?.as_str()?.to_string()),
    );
    route.insert(
        "eventIds".to_string(),
        sanitize_usage_event_ids(source.get("eventIds")?)?,
    );
    Some(Value::Object(route))
}

/// Replay identities are the one raw string array a console carries. Rebuilding
/// it keeps a nested object from riding into the checkpoint inside an
/// allow-listed key.
fn sanitize_usage_event_ids(value: &Value) -> Option<Value> {
    Some(Value::Array(
        value
            .as_array()?
            .iter()
            .map(|entry| entry.as_str().map(|id| Value::String(id.to_string())))
            .collect::<Option<Vec<_>>>()?,
    ))
}

fn sanitize_prompt_manifest(value: &Value) -> Option<Value> {
    let mut manifest = copy_known_fields(
        value,
        &[
            "id",
            "profileId",
            "createdAt",
            "packetId",
            "includedSourceCount",
            "excludedSourceCount",
            "tokenEstimate",
        ],
    )?;
    let policy = value
        .as_object()?
        .get("policy")?
        .as_array()?
        .iter()
        .map(|source| {
            copy_known_fields(source, &["id", "label", "authority", "digest"]).map(Value::Object)
        })
        .collect::<Option<Vec<_>>>()?;
    manifest.insert("policy".to_string(), Value::Array(policy));
    Some(Value::Object(manifest))
}

fn sanitize_pending_decision(value: &Value) -> Option<Value> {
    let mut decision = copy_known_fields(value, &["id", "title"])?;
    let questions = value
        .as_object()?
        .get("questions")?
        .as_array()?
        .iter()
        .map(|question| {
            let source = question.as_object()?;
            let mut question =
                copy_known_fields(question, &["id", "question", "multi", "recommended"])?;
            let options = source
                .get("options")?
                .as_array()?
                .iter()
                .map(|option| {
                    copy_known_fields(option, &["label", "description"]).map(Value::Object)
                })
                .collect::<Option<Vec<_>>>()?;
            question.insert("options".to_string(), Value::Array(options));
            Some(Value::Object(question))
        })
        .collect::<Option<Vec<_>>>()?;
    decision.insert("questions".to_string(), Value::Array(questions));
    Some(Value::Object(decision))
}

fn sanitize_work_graph(value: &Value) -> Option<Value> {
    let mut graph = copy_known_fields(value, &["id", "approval"])?;
    let nodes = value
        .as_object()?
        .get("nodes")?
        .as_array()?
        .iter()
        .map(|node| {
            copy_known_fields(
                node,
                &[
                    "id",
                    "title",
                    "prompt",
                    "status",
                    "dependsOn",
                    "fileOwnership",
                    "manifestId",
                    "evidenceRefs",
                ],
            )
            .map(Value::Object)
        })
        .collect::<Option<Vec<_>>>()?;
    graph.insert("nodes".to_string(), Value::Array(nodes));
    Some(Value::Object(graph))
}

fn sanitize_evolution_proposal(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let mut proposal = copy_known_fields(
        value,
        &[
            "id",
            "runId",
            "candidateId",
            "creatorId",
            "evaluatorId",
            "attestorId",
            "state",
            "isolation",
            "isolatedBranch",
            "isolatedWorktree",
            "heldOutBenchmark",
            "heldOutBenchmarkId",
            "humanApproval",
            "mergeRequiresHumanApproval",
            "stale",
            "summary",
            "createdAt",
        ],
    )?;

    let changed_assets = source
        .get("changedAssets")?
        .as_array()?
        .iter()
        .take(128)
        .map(|asset| copy_known_fields(asset, &["path", "sha256"]).map(Value::Object))
        .collect::<Option<Vec<_>>>()?;
    proposal.insert("changedAssets".to_string(), Value::Array(changed_assets));

    let hashes = copy_known_fields(
        source.get("hashes")?,
        &[
            "baseCommit",
            "candidateCommit",
            "patch",
            "candidateArtifact",
            "evaluator",
            "evaluatorEnvironment",
            "policy",
            "suite",
            "baselineResult",
            "candidateResult",
        ],
    )?;
    proposal.insert("hashes".to_string(), Value::Object(hashes));

    if let Some(comparison) = source.get("comparison") {
        proposal.insert(
            "comparison".to_string(),
            Value::Object(copy_known_fields(
                comparison,
                &[
                    "baselineScore",
                    "candidateScore",
                    "delta",
                    "passed",
                    "thresholdsHash",
                ],
            )?),
        );
    }
    if let Some(attestation) = source.get("attestation") {
        proposal.insert(
            "attestation".to_string(),
            Value::Object(copy_known_fields(
                attestation,
                &["timestamp", "maxAgeMs", "branchExists", "worktreeExists"],
            )?),
        );
    }

    let cleanup_source = source.get("cleanup")?.as_object()?;
    let mut cleanup = copy_known_fields(source.get("cleanup")?, &["status", "summary"])?;
    let resources = cleanup_source
        .get("resources")?
        .as_array()?
        .iter()
        .take(16)
        .map(|resource| {
            copy_known_fields(resource, &["kind", "identity", "status"]).map(Value::Object)
        })
        .collect::<Option<Vec<_>>>()?;
    cleanup.insert("resources".to_string(), Value::Array(resources));
    proposal.insert("cleanup".to_string(), Value::Object(cleanup));
    proposal.insert(
        "failures".to_string(),
        sanitize_bounded_string_array(source.get("failures")?, 32)?,
    );
    proposal.insert(
        "artifactRefs".to_string(),
        sanitize_bounded_string_array(source.get("artifactRefs")?, 32)?,
    );
    Some(Value::Object(proposal))
}

fn sanitize_bounded_string_array(value: &Value, maximum_items: usize) -> Option<Value> {
    Some(Value::Array(
        value
            .as_array()?
            .iter()
            .take(maximum_items)
            .map(|entry| entry.as_str().map(|text| Value::String(text.to_string())))
            .collect::<Option<Vec<_>>>()?,
    ))
}

fn sanitize_tool_activity(value: &Value) -> Option<Value> {
    copy_known_fields(
        value,
        &[
            "id",
            "toolCallId",
            "toolName",
            "kind",
            "intent",
            "status",
            "target",
            "summary",
            "startedAt",
            "completedAt",
        ],
    )
    .map(Value::Object)
}

fn copy_known_fields(value: &Value, fields: &[&str]) -> Option<Map<String, Value>> {
    let source = value.as_object()?;
    let mut result = Map::new();
    for field in fields {
        if let Some(field_value) = source.get(*field) {
            result.insert((*field).to_string(), field_value.clone());
        }
    }
    Some(result)
}

fn redact_json_strings(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact_secrets(&value)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_json_strings).collect()),
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(key, value)| (key, redact_json_strings(value)))
                .collect(),
        ),
        value => value,
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
    let metadata_context_receipt = snapshot
        .last_submitted_context_receipt_id
        .as_ref()
        .map(|receipt_id| {
            format!(
                ",\"lastSubmittedContextReceiptId\":\"{}\"",
                escape_json(receipt_id)
            )
        })
        .unwrap_or_default();
    let mut records = vec![
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
                "{{\"type\":\"metadata\",\"metadata\":{{\"model\":\"{}\",\"taskSummary\":\"{}\",\"isUltraworkMode\":{}{}{}{}}}}}",
                escape_json(&snapshot.model),
                escape_json(&snapshot.summary),
                if snapshot.mode == "ultrawork" { "true" } else { "false" },
                metadata_trace,
                metadata_reasoning,
                metadata_context_receipt,
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
    ];
    if let Some(agent_console) = &snapshot.agent_console {
        records.push(WorkShellRecord {
            timestamp: now_timestamp(),
            checkpoint_json: format!(
                "{{\"type\":\"agent_console\",\"agentConsole\":{agent_console}}}"
            ),
        });
    }
    records
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
    if let Some(receipt_id) = &snapshot.last_submitted_context_receipt_id {
        metadata.insert(
            "lastSubmittedContextReceiptId".to_string(),
            json!(receipt_id),
        );
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
        "agentConsole": snapshot.agent_console.clone(),
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
                last_submitted_context_receipt_id: Some("receipt-submitted".to_string()),
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
                agent_console: None,
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
        assert_eq!(
            resumed.last_submitted_context_receipt_id,
            Some("receipt-submitted".to_string())
        );
        assert_eq!(resumed.summary, "Chat: inspect repo");
        assert_eq!(resumed.entries.len(), 2);
        assert_eq!(resumed.entries[0].text, "inspect repo");
        assert_eq!(resumed.entries[1].text, "repo inspected");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn work_shell_evolution_projection_and_notice_cross_the_durable_gate() {
        let root = env::temp_dir().join(format!(
            "unclecode-session-evolution-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let session_id = "work-session-evolution";
        let store = WorkShellSessionStore::new(&root);
        let proposal = json!({
            "id": "proposal-1",
            "runId": "run-1",
            "candidateId": "candidate-1",
            "creatorId": "creator-1",
            "evaluatorId": "evaluator-1",
            "attestorId": "attestor-1",
            "state": "pr-ready",
            "isolation": "worktree",
            "isolatedBranch": "unclecode/evolve/candidate-1",
            "isolatedWorktree": "/private/candidate-1",
            "heldOutBenchmark": true,
            "heldOutBenchmarkId": "suite-1",
            "humanApproval": "pending",
            "mergeRequiresHumanApproval": true,
            "stale": false,
            "changedAssets": [{ "path": "skills/creator.md", "sha256": format!("sha256:{}", "a".repeat(64)), "body": "must-not-persist" }],
            "hashes": {
                "evaluator": format!("sha256:{}", "b".repeat(64)),
                "evaluatorEnvironment": format!("sha256:{}", "c".repeat(64)),
                "policy": format!("sha256:{}", "d".repeat(64)),
                "suite": format!("sha256:{}", "e".repeat(64)),
                "providerCredential": "must-not-persist"
            },
            "comparison": {
                "baselineScore": 0.7,
                "candidateScore": 0.9,
                "delta": 0.2,
                "passed": true,
                "thresholdsHash": format!("sha256:{}", "f".repeat(64)),
                "rawOutput": "must-not-persist"
            },
            "attestation": {
                "timestamp": "2026-08-28T12:00:00.000Z",
                "maxAgeMs": 300000,
                "branchExists": true,
                "worktreeExists": true,
                "hookOutput": "must-not-persist"
            },
            "cleanup": {
                "status": "retained",
                "resources": [{ "kind": "branch", "identity": "unclecode/evolve/candidate-1", "status": "retained", "command": "must-not-persist" }]
            },
            "failures": [],
            "summary": format!("safe summary sk-proj-{}", "s".repeat(30)),
            "artifactRefs": [".unclecode/artifacts/run-1/proposal.json"],
            "createdAt": "2026-08-28T12:00:00.000Z",
            "rawCandidateOutput": "must-not-persist"
        });
        let payload = json!({
            "sessionId": session_id,
            "model": "gpt-5.4",
            "mode": "normal",
            "state": "idle",
            "summary": "Recorded evolution proposal",
            "entries": [],
            "agentConsole": {
                "profileId": "build",
                "activity": [],
                "evolutionProposals": [proposal]
            }
        })
        .to_string();

        persist_work_shell_session_snapshot_json(&store, &project, &payload)
            .expect("persist evolution snapshot");
        let resumed = store
            .resume_work_shell_session(&project, session_id)
            .expect("resume")
            .expect("resumed");
        let console = resumed.agent_console.expect("agent console");
        let recorded = &console["evolutionProposals"][0];
        assert_eq!(recorded["state"], "pr-ready");
        assert_eq!(
            recorded["hashes"]["evaluatorEnvironment"],
            format!("sha256:{}", "c".repeat(64))
        );
        let serialized = serde_json::to_string(recorded).expect("serialize proposal");
        assert!(!serialized.contains("must-not-persist"));
        assert!(!serialized.contains("sk-proj-"));
        assert!(serialized.contains("[REDACTED]"));

        let notice_path = root.join("notifications").join(format!(
            "{}.notice.json",
            to_opaque_id(session_id, "session")
        ));
        let first_notice: Value = serde_json::from_str(
            &fs::read_to_string(&notice_path).expect("read persistence notice"),
        )
        .expect("parse persistence notice");
        assert_eq!(first_notice["version"], 1);
        assert_eq!(first_notice["sessionId"], session_id);
        assert_eq!(first_notice["revision"], 5);

        persist_work_shell_session_snapshot_json(&store, &project, &payload)
            .expect("persist next evolution snapshot");
        let next_notice: Value = serde_json::from_str(
            &fs::read_to_string(&notice_path).expect("read next persistence notice"),
        )
        .expect("parse next persistence notice");
        assert_eq!(next_notice["revision"], 10);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn work_shell_persist_json_strips_raw_agent_console_output() {
        let root = env::temp_dir().join(format!(
            "unclecode-session-console-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let store = WorkShellSessionStore::new(&root);
        let payload = json!({
            "sessionId": "work-session-console",
            "model": "gpt-5.4",
            "mode": "normal",
            "state": "idle",
            "summary": "Chat: persist console",
            "entries": [],
            "agentConsole": {
                "profileId": "build",
                "activity": [{
                    "id": "activity-1",
                    "toolCallId": "call-1",
                    "toolName": "read_file",
                    "kind": "read",
                    "intent": format!("Read sk-proj-{}", "a".repeat(30)),
                    "status": "completed",
                    "startedAt": 1,
                    "output": "unbounded raw output"
                }]
            }
        })
        .to_string();

        persist_work_shell_session_snapshot_json(&store, &project, &payload)
            .expect("persist JSON snapshot");

        let paths = session_paths(&root, &project, "work-session-console");
        let checkpoint = fs::read_to_string(paths.checkpoint_path).expect("checkpoint");
        assert!(!checkpoint.contains("unbounded raw output"));
        assert!(!checkpoint.contains("sk-proj-"));

        let resumed = store
            .resume_work_shell_session(&project, "work-session-console")
            .expect("resume")
            .expect("resumed");
        let console = resumed.agent_console.expect("agent console");
        assert_eq!(console["profileId"], "build");
        assert!(console["activity"][0].get("output").is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn work_shell_agent_console_preserves_named_lifecycle_fields_only() {
        let root = env::temp_dir().join(format!(
            "unclecode-session-lifecycle-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let store = WorkShellSessionStore::new(&root);
        let payload = json!({
            "sessionId": "work-session-lifecycle",
            "model": "gpt-5.4",
            "mode": "normal",
            "state": "running",
            "summary": "Chat: dispatch the plan",
            "entries": [],
            "agentConsole": {
                "profileId": "build",
                "activity": [],
                "agents": [{
                    "id": "run-1",
                    "displayName": "Executor A",
                    "agentType": "executor",
                    "status": "running",
                    "currentActivity": "Reading auth.ts",
                    "parentRunId": "run-root",
                    "transcriptRef": "transcripts/run-1.jsonl",
                    "startedAt": 10,
                    "summary": "Refactoring the auth guard.",
                    "usage": {
                        "eventIds": ["usage-1"],
                        "inputTokens": 120,
                        "outputTokens": 40,
                        "costUsd": 0.002,
                        "routes": [{
                            "provider": "openai",
                            "model": "gpt-5.6-sol",
                            "eventIds": ["usage-1"],
                            "inputTokens": 120,
                            "outputTokens": 40,
                            "costUsd": 0.002,
                            "rawRequest": "must not persist"
                        }],
                        "rawFrames": ["must not persist"]
                    },
                    "systemPrompt": format!("Executor key sk-proj-{}", "a".repeat(30)),
                    "rawAssignment": "internal worker assignment text"
                }],
                "jobs": [{
                    "id": "job-1",
                    "type": "executor",
                    "label": "Plan step one",
                    "status": "queued",
                    "agentRunId": "run-1",
                    "queuedAt": 5,
                    "credential": format!("ghp_{}", "1".repeat(36))
                }],
                "mainUsage": {
                    "eventIds": ["usage-main"],
                    "inputTokens": 900,
                    "outputTokens": 150,
                    "cacheReadTokens": 400,
                    "costUsd": 0.01,
                    "providerHeaders": { "authorization": "Bearer secret" }
                }
            }
        })
        .to_string();

        persist_work_shell_session_snapshot_json(&store, &project, &payload)
            .expect("persist JSON snapshot");

        let paths = session_paths(&root, &project, "work-session-lifecycle");
        let checkpoint = fs::read_to_string(paths.checkpoint_path).expect("checkpoint");
        assert!(!checkpoint.contains("systemPrompt"));
        assert!(!checkpoint.contains("rawAssignment"));
        assert!(!checkpoint.contains("rawFrames"));
        assert!(!checkpoint.contains("rawRequest"));
        assert!(!checkpoint.contains("providerHeaders"));
        assert!(!checkpoint.contains("credential"));
        assert!(!checkpoint.contains("sk-proj-"));
        assert!(!checkpoint.contains("ghp_"));

        let resumed = store
            .resume_work_shell_session(&project, "work-session-lifecycle")
            .expect("resume")
            .expect("resumed");
        let console = resumed.agent_console.expect("agent console");
        assert_eq!(console["agents"][0]["id"], "run-1");
        assert_eq!(console["agents"][0]["status"], "running");
        assert_eq!(console["agents"][0]["currentActivity"], "Reading auth.ts");
        assert_eq!(console["agents"][0]["parentRunId"], "run-root");
        assert_eq!(
            console["agents"][0]["transcriptRef"],
            "transcripts/run-1.jsonl"
        );
        assert_eq!(console["agents"][0]["summary"], "Refactoring the auth guard.");
        assert_eq!(console["agents"][0]["usage"]["inputTokens"], 120);
        assert_eq!(console["agents"][0]["usage"]["eventIds"][0], "usage-1");
        assert_eq!(
            console["agents"][0]["usage"]["routes"][0]["model"],
            "gpt-5.6-sol"
        );
        assert!(console["agents"][0]["usage"]["routes"][0]
            .get("rawRequest")
            .is_none());
        assert!(console["agents"][0].get("systemPrompt").is_none());
        assert!(console["agents"][0].get("rawAssignment").is_none());
        assert_eq!(console["jobs"][0]["id"], "job-1");
        assert_eq!(console["jobs"][0]["label"], "Plan step one");
        assert_eq!(console["jobs"][0]["agentRunId"], "run-1");
        assert!(console["jobs"][0].get("credential").is_none());
        assert_eq!(console["mainUsage"]["inputTokens"], 900);
        assert_eq!(console["mainUsage"]["cacheReadTokens"], 400);
        assert!(console["mainUsage"].get("providerHeaders").is_none());

        let _ = fs::remove_dir_all(root);
    }

    fn oversized_agent_console_payload() -> Value {
        let long_summary = "s".repeat(400);
        let long_intent = "i".repeat(400);
        let secret_key = format!("sk-proj-{}", "a".repeat(30));
        let agents = (0..128)
            .map(|index| {
                let active = index >= 120;
                let mut agent = json!({
                    "id": format!("run-{index}"),
                    "displayName": format!("Executor {index}"),
                    "agentType": "executor",
                    "status": if active { "running" } else { "completed" },
                    "startedAt": 1_000 + index,
                    "summary": long_summary.clone(),
                    "transcriptRef": format!("transcripts/run-{index}.jsonl"),
                    "systemPrompt": secret_key.clone(),
                    "usage": {
                        "eventIds": (0..8).map(|slot| format!("usage-{index}-{slot}")).collect::<Vec<_>>(),
                        "inputTokens": 10,
                        "outputTokens": 5
                    }
                });
                if !active {
                    agent["completedAt"] = json!(2_000 + index);
                }
                agent
            })
            .collect::<Vec<_>>();
        let jobs = (0..128)
            .map(|index| {
                let active = index >= 120;
                let mut job = json!({
                    "id": format!("job-{index}"),
                    "type": "executor",
                    "label": format!("Plan step {index}"),
                    "status": if active { "queued" } else { "completed" },
                    "queuedAt": 900 + index,
                    "summary": long_summary.clone(),
                    "credential": format!("ghp_{}", "1".repeat(36))
                });
                if !active {
                    job["completedAt"] = json!(2_100 + index);
                }
                job
            })
            .collect::<Vec<_>>();
        let activity = (0..80)
            .map(|index| {
                json!({
                    "id": format!("activity-{index}"),
                    "toolCallId": format!("call-{index}"),
                    "toolName": "read_file",
                    "kind": "read",
                    "intent": long_intent.clone(),
                    "status": "completed",
                    "startedAt": 1,
                    "output": "unbounded raw output"
                })
            })
            .collect::<Vec<_>>();
        json!({
            "profileId": "build",
            "activity": activity,
            "agents": agents,
            "jobs": jobs,
            "mainUsage": {
                "eventIds": (0..64).map(|slot| format!("usage-main-{slot}")).collect::<Vec<_>>(),
                "inputTokens": 900,
                "outputTokens": 150,
                "cacheReadTokens": 400,
                "costUsd": 0.01,
                "providerHeaders": { "authorization": "Bearer secret" }
            }
        })
    }

    #[test]
    fn work_shell_agent_console_fits_oversized_history_without_dropping_active_work() {
        let console = oversized_agent_console_payload();
        assert!(
            serde_json::to_vec(&console).expect("serialize").len() > MAX_AGENT_CONSOLE_BYTES,
            "fixture must exceed the console byte budget"
        );

        let root = env::temp_dir().join(format!(
            "unclecode-session-oversized-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let store = WorkShellSessionStore::new(&root);
        let payload = json!({
            "sessionId": "work-session-oversized",
            "model": "gpt-5.4",
            "mode": "normal",
            "state": "running",
            "summary": "Chat: dispatch the plan",
            "entries": [],
            "agentConsole": console
        })
        .to_string();

        persist_work_shell_session_snapshot_json(&store, &project, &payload)
            .expect("persist JSON snapshot");

        let resumed = store
            .resume_work_shell_session(&project, "work-session-oversized")
            .expect("resume")
            .expect("resumed");
        let fitted = resumed.agent_console.expect("agent console survives fitting");

        // Fits the durable budget instead of collapsing to nothing.
        let bytes = serde_json::to_vec(&fitted).expect("serialize fitted");
        assert!(
            bytes.len() <= MAX_AGENT_CONSOLE_BYTES,
            "fitted console is {} bytes",
            bytes.len()
        );
        assert_eq!(fitted["profileId"], "build");

        // Every active identity resume needs to interrupt is still present.
        let agents = fitted["agents"].as_array().expect("agents");
        let jobs = fitted["jobs"].as_array().expect("jobs");
        for index in 120..128 {
            assert!(
                agents
                    .iter()
                    .any(|agent| agent["id"] == json!(format!("run-{index}"))),
                "active run-{index} must survive fitting"
            );
            assert!(
                jobs.iter()
                    .any(|job| job["id"] == json!(format!("job-{index}"))),
                "active job-{index} must survive fitting"
            );
        }

        // Oldest terminal history is what paid for the budget.
        assert!(agents.len() < 128);
        assert!(jobs.len() < 128);
        assert!(!agents
            .iter()
            .any(|agent| agent["id"] == json!("run-0")));
        assert!(!jobs.iter().any(|job| job["id"] == json!("job-0")));

        // Aggregate main usage counters survive.
        assert_eq!(fitted["mainUsage"]["inputTokens"], 900);
        assert_eq!(fitted["mainUsage"]["outputTokens"], 150);
        assert_eq!(fitted["mainUsage"]["cacheReadTokens"], 400);

        // Nothing unknown or secret was retained to make the budget work.
        let serialized = String::from_utf8(bytes).expect("utf8");
        assert!(!serialized.contains("systemPrompt"));
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("providerHeaders"));
        assert!(!serialized.contains("unbounded raw output"));
        assert!(!serialized.contains("sk-proj-"));
        assert!(!serialized.contains("ghp_"));

        let _ = fs::remove_dir_all(root);
    }

    fn active_lifecycle_console_fields() -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert("profileId".to_string(), json!("build"));
        fields.insert("activity".to_string(), json!([]));
        fields.insert(
            "agents".to_string(),
            json!([{
                "id": "run-active",
                "displayName": "Executor A",
                "agentType": "executor",
                "status": "running",
                "startedAt": 10,
                "systemPrompt": format!("Executor key sk-proj-{}", "a".repeat(30))
            }]),
        );
        fields.insert(
            "jobs".to_string(),
            json!([{
                "id": "job-active",
                "type": "executor",
                "label": "Plan step one",
                "status": "queued",
                "queuedAt": 5,
                "credential": format!("ghp_{}", "1".repeat(36))
            }]),
        );
        fields.insert(
            "mainUsage".to_string(),
            json!({
                "eventIds": ["usage-main"],
                "inputTokens": 900,
                "outputTokens": 150,
                "cacheReadTokens": 400,
                "costUsd": 0.01,
                "providerHeaders": { "authorization": "Bearer secret" }
            }),
        );
        fields
    }

    fn oversized_manifest(policy_sources: usize) -> Value {
        let long_label = "l".repeat(400);
        json!({
            "id": "manifest-oversized",
            "profileId": "build",
            "createdAt": "2026-08-09T00:00:00.000Z",
            "packetId": "packet-oversized",
            "includedSourceCount": policy_sources,
            "excludedSourceCount": 0,
            "tokenEstimate": 4_000,
            "policy": (0..policy_sources)
                .map(|index| json!({
                    "id": format!("policy-{index}"),
                    "label": long_label.clone(),
                    "authority": "mandatory",
                    "digest": format!("digest-{index}")
                }))
                .collect::<Vec<_>>()
        })
    }

    fn oversized_pending_decision(questions: usize) -> Value {
        let long_question = "q".repeat(400);
        let long_description = "d".repeat(400);
        json!({
            "id": "decision-oversized",
            "title": "Execution choice",
            "questions": (0..questions)
                .map(|index| json!({
                    "id": format!("question-{index}"),
                    "question": long_question.clone(),
                    "recommended": 0,
                    "options": [
                        { "label": "Safe", "description": long_description.clone() },
                        { "label": "Fast", "description": long_description.clone() }
                    ]
                }))
                .collect::<Vec<_>>()
        })
    }

    fn persist_and_resume_console(session_id: &str, console: Value) -> Value {
        assert!(
            serde_json::to_vec(&console).expect("serialize").len() > MAX_AGENT_CONSOLE_BYTES,
            "fixture must exceed the console byte budget"
        );
        let root = env::temp_dir().join(format!(
            "unclecode-session-shell-test-{}-{}-{}",
            session_id,
            std::process::id(),
            now_ms()
        ));
        let project = env::current_dir().expect("cwd");
        let store = WorkShellSessionStore::new(&root);
        let payload = json!({
            "sessionId": session_id,
            "model": "gpt-5.4",
            "mode": "normal",
            "state": "running",
            "summary": "Chat: dispatch the plan",
            "entries": [],
            "agentConsole": console
        })
        .to_string();

        persist_work_shell_session_snapshot_json(&store, &project, &payload)
            .expect("persist JSON snapshot");
        let resumed = store
            .resume_work_shell_session(&project, session_id)
            .expect("resume")
            .expect("resumed");
        let fitted = resumed.agent_console.expect("agent console survives fitting");
        let _ = fs::remove_dir_all(root);
        fitted
    }

    fn assert_active_lifecycle_survived(fitted: &Value) {
        let bytes = serde_json::to_vec(fitted).expect("serialize fitted");
        assert!(
            bytes.len() <= MAX_AGENT_CONSOLE_BYTES,
            "fitted console is {} bytes",
            bytes.len()
        );
        assert_eq!(fitted["agents"][0]["id"], "run-active");
        assert_eq!(fitted["agents"][0]["status"], "running");
        assert_eq!(fitted["jobs"][0]["id"], "job-active");
        assert_eq!(fitted["jobs"][0]["status"], "queued");
        assert_eq!(fitted["mainUsage"]["inputTokens"], 900);
        assert_eq!(fitted["mainUsage"]["outputTokens"], 150);
        assert_eq!(fitted["mainUsage"]["cacheReadTokens"], 400);

        let serialized = String::from_utf8(bytes).expect("utf8");
        assert!(!serialized.contains("systemPrompt"));
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("providerHeaders"));
        assert!(!serialized.contains("sk-proj-"));
        assert!(!serialized.contains("ghp_"));
    }

    #[test]
    fn work_shell_agent_console_compacts_oversized_manifest_before_active_work() {
        let mut console = active_lifecycle_console_fields();
        console.insert("manifest".to_string(), oversized_manifest(400));

        let fitted = persist_and_resume_console("work-session-manifest", Value::Object(console));

        assert_active_lifecycle_survived(&fitted);
        // The bounded safe subset of the manifest is what survives: the policy
        // list is the expendable bulk, the identity is not.
        assert_eq!(fitted["manifest"]["id"], "manifest-oversized");
        assert_eq!(fitted["manifest"]["packetId"], "packet-oversized");
        // Trimming is incremental and oldest-first: it stops as soon as the
        // projection fits, so the newest policy sources are the ones kept.
        let policy = fitted["manifest"]["policy"].as_array().expect("policy");
        assert!(!policy.is_empty());
        assert!(policy.len() < 400);
        assert_eq!(policy[0]["id"], json!(format!("policy-{}", 400 - policy.len())));
        assert_eq!(policy[policy.len() - 1]["id"], "policy-399");
    }

    #[test]
    fn work_shell_agent_console_compacts_oversized_pending_decision_before_active_work() {
        let mut console = active_lifecycle_console_fields();
        console.insert("pendingDecision".to_string(), oversized_pending_decision(60));

        let fitted = persist_and_resume_console("work-session-decision", Value::Object(console));

        assert_active_lifecycle_survived(&fitted);
        // The decision stays answerable: ids, option labels, and the recommended
        // index survive; only the prose is compacted.
        assert_eq!(fitted["pendingDecision"]["id"], "decision-oversized");
        let questions = fitted["pendingDecision"]["questions"]
            .as_array()
            .expect("questions");
        assert_eq!(questions.len(), 60);
        assert_eq!(questions[0]["options"][0]["label"], "Safe");
        assert_eq!(questions[0]["options"][1]["label"], "Fast");
        assert_eq!(questions[0]["recommended"], 0);
        assert!(questions[0]["options"][0].get("description").is_none());
        assert_eq!(
            questions[0]["question"]
                .as_str()
                .expect("question text")
                .chars()
                .count(),
            COMPACT_TEXT_CHARS
        );
    }

    #[test]
    fn work_shell_agent_console_drops_shell_metadata_before_active_identities() {
        let mut console = active_lifecycle_console_fields();
        console.insert("manifest".to_string(), oversized_manifest(400));
        console.insert("pendingDecision".to_string(), oversized_pending_decision(400));
        console.insert(
            "workGraph".to_string(),
            json!({
                "id": "graph-1",
                "approval": "approved",
                "nodes": (0..200)
                    .map(|index| json!({
                        "id": format!("node-{index}"),
                        "title": "t".repeat(400),
                        "status": "pending"
                    }))
                    .collect::<Vec<_>>()
            }),
        );

        let fitted = persist_and_resume_console("work-session-shell", Value::Object(console));

        // Optional shell metadata is spent before a single active identity or an
        // aggregate usage counter is touched.
        assert_active_lifecycle_survived(&fitted);
        assert!(fitted.get("manifest").is_none());
        assert!(fitted.get("pendingDecision").is_none());
        assert!(fitted.get("workGraph").is_none());
    }

    fn policy_source(index: usize, label: &str) -> Value {
        json!({
            "id": format!("policy-{index}"),
            "label": label,
            "authority": "mandatory",
            "digest": format!("digest-{index}")
        })
    }

    /// A manifest whose policy list is the only thing pushing the console over
    /// the budget. Labels are multibyte so a cutoff computed from character
    /// count cannot agree with one computed from serialized bytes.
    fn multibyte_policy_console(sources: usize) -> Map<String, Value> {
        let label = "日本語ラベル".repeat(20);
        let policy = (0..sources)
            .map(|index| policy_source(index, &label))
            .collect::<Vec<_>>();
        let mut console = active_lifecycle_console_fields();
        console.insert(
            "manifest".to_string(),
            json!({
                "id": "manifest-multibyte",
                "profileId": "build",
                "createdAt": "2026-08-09T00:00:00.000Z",
                "packetId": "packet-multibyte",
                "includedSourceCount": sources,
                "excludedSourceCount": 0,
                "tokenEstimate": 4_000,
                "policy": policy
            }),
        );
        console
    }

    fn assert_minimal_newest_policy_suffix(sources: usize) -> usize {
        let console = multibyte_policy_console(sources);
        assert!(
            console_byte_len(&console) > MAX_AGENT_CONSOLE_BYTES,
            "fixture must exceed the console byte budget"
        );

        let fitted = fit_agent_console_snapshot(console);
        assert!(console_fits(&fitted), "fitted console must respect the cap");

        let policy = fitted["manifest"]["policy"]
            .as_array()
            .expect("policy survives as an array");
        assert!(!policy.is_empty(), "trimming must not empty a policy that fits");
        assert!(policy.len() < sources);

        // Oldest-first retention: the survivors are the newest contiguous
        // suffix, still in order.
        let first_kept = sources - policy.len();
        for (offset, source) in policy.iter().enumerate() {
            assert_eq!(source["id"], json!(format!("policy-{}", first_kept + offset)));
        }

        // Minimality: putting the newest dropped source back must overflow.
        let label = "日本語ラベル".repeat(20);
        let mut restored = fitted.clone();
        restored["manifest"]["policy"]
            .as_array_mut()
            .expect("policy")
            .insert(0, policy_source(first_kept - 1, &label));
        assert!(
            !console_fits(&restored),
            "trimming removed more than the smallest sufficient prefix"
        );

        // Active lifecycle and aggregate counters are untouched by policy work.
        assert_eq!(fitted["agents"][0]["id"], "run-active");
        assert_eq!(fitted["jobs"][0]["id"], "job-active");
        assert_eq!(fitted["mainUsage"]["inputTokens"], 900);
        policy.len()
    }

    #[test]
    fn agent_console_policy_trim_keeps_the_minimal_newest_suffix() {
        // Sized so only a small prefix has to go: a cutoff computed from
        // character count under-measures multibyte labels, over-trims, and
        // fails the minimality assertion instead of merely emptying the list.
        let kept = assert_minimal_newest_policy_suffix(90);
        assert!(kept > 1, "the fixture must need more than a single removal");
    }

    #[test]
    fn agent_console_policy_trim_scales_to_a_large_policy() {
        assert_minimal_newest_policy_suffix(5_000);
    }

    #[test]
    fn drop_oldest_until_freed_handles_cutoff_boundaries() {
        let entry = json!({ "id": "e", "label": "0123456789" });
        let entry_bytes = serde_json::to_vec(&entry).expect("serialize").len();

        // Nothing to free, nothing to do.
        let mut none_needed = vec![entry.clone(), entry.clone()];
        drop_oldest_until_freed(&mut none_needed, 0, |_| false);
        assert_eq!(none_needed.len(), 2);

        // Empty input is a no-op rather than a panic.
        let mut empty: Vec<Value> = Vec::new();
        drop_oldest_until_freed(&mut empty, 1_000, |_| false);
        assert!(empty.is_empty());

        // One element: removing it frees its own bytes and no separator.
        let mut single = vec![entry.clone()];
        drop_oldest_until_freed(&mut single, entry_bytes, |_| false);
        assert!(single.is_empty());

        // Cutoff boundary: one byte less than two elements' worth must still
        // stop after the second element, never after the first.
        let mut four = (0..4)
            .map(|index| policy_source(index, "0123456789"))
            .collect::<Vec<_>>();
        let element = serde_json::to_vec(&four[0]).expect("serialize").len();
        drop_oldest_until_freed(&mut four, element + 2, |_| false);
        assert_eq!(four.len(), 2);
        assert_eq!(four[0]["id"], "policy-2");
        assert_eq!(four[1]["id"], "policy-3");

        // A target larger than the whole list drains everything droppable.
        let mut all = (0..4)
            .map(|index| policy_source(index, "0123456789"))
            .collect::<Vec<_>>();
        drop_oldest_until_freed(&mut all, usize::MAX / 2, |_| false);
        assert!(all.is_empty());

        // Kept records survive even when they sit inside the scan window.
        let mut mixed = vec![
            json!({ "id": "old", "status": "completed" }),
            json!({ "id": "live", "status": "running" }),
            json!({ "id": "older", "status": "completed" }),
        ];
        drop_oldest_until_freed(&mut mixed, usize::MAX / 2, is_active_agent_run);
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0]["id"], "live");
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
                last_submitted_context_receipt_id: None,
                entries,
                agent_console: None,
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
