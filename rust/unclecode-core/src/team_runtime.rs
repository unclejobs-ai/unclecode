use crate::sha256::sha256_hex;
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PERSONA_IDS: &[&str] = &[
    "coder",
    "builder",
    "hardener",
    "auditor",
    "agentless-fix",
    "agentless-then-agent",
    "mini",
];
const TEAM_GATE_LEVELS: &[&str] = &["strict", "warn", "off"];
const TEAM_RUNTIME_MODES: &[&str] = &["local", "docker", "e2b", "openshell"];
const TEAM_LANE_RUNTIMES: &[&str] = &[
    "openai",
    "anthropic",
    "gemini",
    "cursor",
    "codex",
    "opencode",
    "glm",
    "hermes",
];
const DEFAULT_WORKER_TIMEOUT_MS: &str = "600000";
const DEFAULT_LANE_RUNTIME: &str = "openai";
const MAX_LANES_PER_RUN: usize = 16;
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const APPEND_LOCK_RETRIES: usize = 50;
const APPEND_LOCK_DELAY_MS: u64 = 4;
static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TeamWorkerSpec {
    pub worker_id: String,
    pub persona: String,
    pub task: String,
    pub runtime: String,
    pub model: Option<String>,
    pub extras: Vec<(String, String)>,
}

pub struct TeamWorkerOptionsRequest {
    pub persona: String,
    pub worker_id: String,
    pub task: String,
    pub runtime: Option<String>,
    pub model: Option<String>,
    pub extras_json: Option<String>,
}

pub struct TeamLockSweep {
    pub swept: usize,
    pub live: usize,
}

pub fn resolve_team_run_config_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team run config JSON: {error}"))?;
    let options = input.get("options").unwrap_or(&Value::Null);
    let env = input.get("env").and_then(Value::as_object);
    let cwd = input
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(".");

    let persona = validate_choice(
        string_field(options, "persona").unwrap_or("coder"),
        PERSONA_IDS,
        "persona",
    )?;
    let gate = validate_choice(
        string_field(options, "gate").unwrap_or("strict"),
        TEAM_GATE_LEVELS,
        "gate",
    )?;
    let runtime = validate_choice(
        string_field(options, "runtime").unwrap_or("local"),
        TEAM_RUNTIME_MODES,
        "runtime",
    )?;
    let worker_timeout_ms = parse_worker_timeout(
        string_field(options, "workerTimeout").unwrap_or(DEFAULT_WORKER_TIMEOUT_MS),
    )?;
    let data_root = env_string(env, "UNCLECODE_DATA_ROOT")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| path_join(cwd, ".data"));
    let created_by = env_string(env, "USER")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| "unclecode-cli".to_string());
    let cli_entry = input
        .get("argv1")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());

    serde_json::to_string(&json!({
        "persona": persona,
        "gate": gate,
        "runtime": runtime,
        "workerTimeoutMs": worker_timeout_ms,
        "dataRoot": data_root,
        "createdBy": created_by,
        "cliEntry": cli_entry,
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_team_worker_options_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team worker options JSON: {error}"))?;
    let options = input.get("options").unwrap_or(&Value::Null);
    let spec = resolve_team_worker_options(TeamWorkerOptionsRequest {
        persona: string_field(options, "persona").unwrap_or("").to_string(),
        worker_id: string_field(options, "workerId").unwrap_or("").to_string(),
        task: string_field(options, "task").unwrap_or("").to_string(),
        runtime: string_field(options, "runtime").map(ToString::to_string),
        model: string_field(options, "model").map(ToString::to_string),
        extras_json: string_field(options, "extras").map(ToString::to_string),
    })?;
    let out = team_worker_spec_to_value(&spec);
    serde_json::to_string(&out).map_err(|error| error.to_string())
}

pub fn parse_team_lanes_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team lanes JSON: {error}"))?;
    let spec = input.get("lanes").and_then(Value::as_str).unwrap_or("1");
    serde_json::to_string(&json!({
        "lanes": parse_team_lanes(spec)?,
    }))
    .map_err(|error| error.to_string())
}

pub fn build_team_worker_spawn_args_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team worker spawn args JSON: {error}"))?;
    let base_args = input
        .get("baseArgs")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let spec = input.get("spec").unwrap_or(&Value::Null);
    serde_json::to_string(&json!({
        "args": build_team_worker_spawn_args(&base_args, spec)?,
    }))
    .map_err(|error| error.to_string())
}

pub fn build_team_worker_spawn_args_from_spec(
    base_args: &[String],
    spec: &TeamWorkerSpec,
) -> Result<Vec<String>, String> {
    build_team_worker_spawn_args(base_args, &team_worker_spec_to_value(spec))
}

pub fn resolve_team_worker_options(
    input: TeamWorkerOptionsRequest,
) -> Result<TeamWorkerSpec, String> {
    let persona = validate_choice(&input.persona, PERSONA_IDS, "persona")?.to_string();
    let runtime = validate_choice(
        input.runtime.as_deref().unwrap_or(DEFAULT_LANE_RUNTIME),
        TEAM_LANE_RUNTIMES,
        "runtime",
    )?
    .to_string();
    let worker_id = non_empty_string(input.worker_id, "Missing team worker id")?;
    let task = non_empty_string(input.task, "Missing team worker task")?;
    let model = input.model.filter(|value| !value.trim().is_empty());
    let extras = parse_worker_extras_pairs(input.extras_json.as_deref())?;
    Ok(TeamWorkerSpec {
        worker_id,
        persona,
        task,
        runtime,
        model,
        extras,
    })
}

pub fn build_team_worker_specs(
    lanes_spec: &str,
    persona: &str,
    task: &str,
) -> Result<Vec<TeamWorkerSpec>, String> {
    let persona = validate_choice(persona, PERSONA_IDS, "persona")?.to_string();
    let task = non_empty_string(task.to_string(), "Missing team worker task")?;
    parse_team_lanes(lanes_spec)?
        .into_iter()
        .enumerate()
        .map(|(index, lane)| {
            let runtime = validate_choice(
                string_field(&lane, "runtime").unwrap_or(DEFAULT_LANE_RUNTIME),
                TEAM_LANE_RUNTIMES,
                "runtime",
            )?
            .to_string();
            let model = string_field(&lane, "model")
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let extras = lane
                .get("extras")
                .and_then(Value::as_object)
                .map(extras_pairs_from_map)
                .transpose()?
                .unwrap_or_default();
            Ok(TeamWorkerSpec {
                worker_id: format!("w{}", index + 1),
                persona: persona.clone(),
                task: task.clone(),
                runtime,
                model,
                extras,
            })
        })
        .collect()
}

pub fn append_team_run_status_checkpoint(run_root: &Path, status: &str) -> Result<(), String> {
    validate_choice(
        status,
        &[
            "started",
            "running",
            "gated",
            "accepted",
            "corrective",
            "aborted",
            "killed",
            "errored",
        ],
        "team run status",
    )?;
    let manifest = read_team_manifest(run_root)?;
    let mut checkpoint = Map::new();
    checkpoint.insert("type".to_string(), json!("team_run"));
    checkpoint.insert(
        "runId".to_string(),
        json!(manifest_string(&manifest, "runId")?),
    );
    checkpoint.insert(
        "persona".to_string(),
        json!(manifest_string(&manifest, "persona")?),
    );
    checkpoint.insert("status".to_string(), json!(status));
    checkpoint.insert(
        "objective".to_string(),
        json!(manifest_string(&manifest, "objective")?),
    );
    checkpoint.insert(
        "lanes".to_string(),
        manifest
            .get("lanes")
            .cloned()
            .ok_or("Team run manifest missing numeric field `lanes`")?,
    );
    checkpoint.insert("timestamp".to_string(), json!(unix_millis_timestamp()));
    append_team_checkpoint(run_root, checkpoint)?;
    Ok(())
}

pub fn append_team_task_received_checkpoint(
    run_root: &Path,
    run_id: &str,
    worker_id: &str,
    task_hash: &str,
) -> Result<(), String> {
    let mut action = Map::new();
    action.insert("tool".to_string(), json!("task_received"));
    action.insert("argHash".to_string(), json!(task_hash));

    let mut checkpoint = Map::new();
    checkpoint.insert("type".to_string(), json!("team_step"));
    checkpoint.insert("runId".to_string(), json!(run_id));
    checkpoint.insert("workerId".to_string(), json!(worker_id));
    checkpoint.insert("stepIndex".to_string(), json!(0));
    checkpoint.insert("action".to_string(), Value::Object(action));
    checkpoint.insert("timestamp".to_string(), json!(unix_millis_timestamp()));
    append_team_checkpoint(run_root, checkpoint)?;
    Ok(())
}

pub fn append_team_action_checkpoint(
    run_root: &Path,
    run_id: &str,
    worker_id: &str,
    step_index: usize,
    tool: &str,
    arg_hash: &str,
    observation_hash: &str,
) -> Result<(), String> {
    let mut action = Map::new();
    action.insert("tool".to_string(), json!(tool));
    action.insert("argHash".to_string(), json!(arg_hash));

    let mut checkpoint = Map::new();
    checkpoint.insert("type".to_string(), json!("team_step"));
    checkpoint.insert("runId".to_string(), json!(run_id));
    checkpoint.insert("workerId".to_string(), json!(worker_id));
    checkpoint.insert("stepIndex".to_string(), json!(step_index));
    checkpoint.insert("action".to_string(), Value::Object(action));
    checkpoint.insert("observationHash".to_string(), json!(observation_hash));
    checkpoint.insert("timestamp".to_string(), json!(unix_millis_timestamp()));
    append_team_checkpoint(run_root, checkpoint)?;
    Ok(())
}

pub fn sweep_stale_team_locks<F>(run_root: &Path, is_pid_alive: F) -> TeamLockSweep
where
    F: Fn(i64) -> bool,
{
    let locks_dir = run_root.join("locks");
    let Ok(entries) = fs::read_dir(&locks_dir) else {
        return TeamLockSweep { swept: 0, live: 0 };
    };
    let mut swept = 0;
    let mut live = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.ends_with(".lock") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let pid = raw
            .trim()
            .split(':')
            .nth(1)
            .and_then(|value| value.parse::<i64>().ok());
        match pid {
            Some(pid) if !is_pid_alive(pid) => {
                if fs::remove_file(&path).is_ok() {
                    swept += 1;
                }
            }
            _ => live += 1,
        }
    }
    TeamLockSweep { swept, live }
}

pub fn format_team_worker_envelope(worker_id: &str, persona: &str, submission: &str) -> String {
    const SUBMISSION_CAP: usize = 4096;
    let submission = truncate_chars(submission, SUBMISSION_CAP);
    format!(
        "WORKER_ID={worker_id}\nPERSONA={persona}\nSUBMISSION:{submission}\n__UNCLECODE_SUBMIT__"
    )
}

pub fn apply_team_system_prefix(system_prompt: Option<&str>, task: &str) -> String {
    let Some(trimmed) = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return task.to_string();
    };
    format!("<persona>\n{trimmed}\n</persona>\n\n{task}")
}

pub fn resolve_team_dispatch_status_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team dispatch status JSON: {error}"))?;
    let outcomes = input
        .get("outcomes")
        .and_then(Value::as_array)
        .ok_or("Missing team dispatch outcomes")?;
    let all_completed = outcomes
        .iter()
        .all(|outcome| string_field(outcome, "status") == Some("completed"));
    let any_killed = outcomes
        .iter()
        .any(|outcome| string_field(outcome, "status") == Some("killed"));
    let status = if all_completed {
        "accepted"
    } else if any_killed {
        "killed"
    } else {
        "errored"
    };
    serde_json::to_string(&json!({ "status": status })).map_err(|error| error.to_string())
}

pub fn resolve_team_child_env_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team child env JSON: {error}"))?;
    let mut env = Map::new();
    merge_string_fields(&mut env, input.get("baseEnv"));
    merge_string_fields(&mut env, input.get("bindingEnv"));
    merge_string_fields(&mut env, input.get("extraEnv"));
    serde_json::to_string(&json!({ "env": env })).map_err(|error| error.to_string())
}

pub fn resolve_team_worker_close_outcome_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team worker close outcome JSON: {error}"))?;
    let killed_by_timeout = input
        .get("killedByTimeout")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let exit_code = input.get("code").and_then(Value::as_i64).unwrap_or(-1);
    let signal = input.get("signal").and_then(Value::as_str);
    let status = if killed_by_timeout {
        "killed"
    } else if exit_code == 0 {
        "completed"
    } else {
        "failed"
    };
    serde_json::to_string(&json!({
        "status": status,
        "exitCode": exit_code,
        "signal": signal,
    }))
    .map_err(|error| error.to_string())
}

pub fn list_team_runs_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid team list runs JSON: {error}"))?;
    let data_root = input
        .get("dataRoot")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Missing team dataRoot")?;
    let runs = list_team_run_refs(Path::new(data_root))?;
    serde_json::to_string(&json!({
        "runs": runs.into_iter().map(|run| {
            json!({
                "runId": run.run_id,
                "runRoot": run.run_root.to_string_lossy().into_owned(),
            })
        }).collect::<Vec<_>>()
    }))
    .map_err(|error| error.to_string())
}

pub fn format_team_runs_list(data_root: &Path) -> Result<String, String> {
    let runs = list_team_run_refs(data_root)?;
    if runs.is_empty() {
        return Ok("No team runs recorded.\n".to_string());
    }

    let mut lines = Vec::with_capacity(runs.len());
    for run in runs {
        let manifest = read_team_manifest(&run.run_root)?;
        let checkpoints = read_team_checkpoints(&run.run_root)?;
        let status = team_status_from_checkpoints(&checkpoints)
            .unwrap_or_else(|| "(no checkpoints)".to_string());
        let persona = manifest_string(&manifest, "persona")?;
        let objective = compact_objective(&manifest_string(&manifest, "objective")?);
        lines.push(format!(
            "{}  {:<22} {:<11} {}",
            run.run_id, persona, status, objective
        ));
    }
    Ok(format!("{}\n", lines.join("\n")))
}

pub fn format_team_run_status(data_root: &Path, run_id: Option<&str>) -> Result<String, String> {
    let runs = list_team_run_refs(data_root)?;
    if runs.is_empty() {
        return Ok("No team runs recorded.\n".to_string());
    }
    let target = match run_id {
        Some(run_id) => runs
            .into_iter()
            .find(|run| run.run_id == run_id)
            .ok_or_else(|| format!("Run not found: {run_id}"))?,
        None => runs
            .into_iter()
            .last()
            .ok_or_else(|| "No team runs recorded.".to_string())?,
    };
    format_team_run_summary(&target.run_root)
}

pub struct TeamInspectResult {
    pub output: String,
    pub ok: bool,
}

pub fn format_team_run_inspect(
    data_root: &Path,
    run_id: &str,
    verify: bool,
) -> Result<TeamInspectResult, String> {
    let target = find_team_run(data_root, run_id)?;
    let mut output = format_team_run_summary(&target.run_root)?;
    let mut ok = true;
    if verify {
        let verification = verify_team_run_chain(&target.run_root)?;
        if verification.ok {
            output.push_str(&format!(
                "Chain: VERIFIED ({} entries)\n",
                verification.verified_lines
            ));
        } else {
            ok = false;
            output.push_str(&format!(
                "Chain: BROKEN at line {} (expected {}, actual {})\n",
                verification.broken_at.unwrap_or(0),
                verification
                    .expected_hash
                    .unwrap_or_else(|| "unknown".to_string()),
                verification
                    .actual_hash
                    .unwrap_or_else(|| "unknown".to_string())
            ));
        }
    }
    Ok(TeamInspectResult { output, ok })
}

pub struct TeamAbortResult {
    pub output: String,
    pub warning: Option<String>,
}

pub fn abort_team_run(data_root: &Path, run_id: &str) -> Result<TeamAbortResult, String> {
    let target = find_team_run(data_root, run_id)?;
    let manifest = read_team_manifest(&target.run_root)?;
    let lock_path = target.run_root.join(".lock");
    let warning = fs::read_to_string(&lock_path).ok().map(|holder| {
        format!(
            "Run is still locked by {}; manual SIGTERM may be required.",
            holder.trim()
        )
    });

    let mut checkpoint = Map::new();
    checkpoint.insert("type".to_string(), json!("team_run"));
    checkpoint.insert(
        "runId".to_string(),
        json!(manifest_string(&manifest, "runId")?),
    );
    checkpoint.insert(
        "persona".to_string(),
        json!(manifest_string(&manifest, "persona")?),
    );
    checkpoint.insert("status".to_string(), json!("aborted"));
    checkpoint.insert(
        "objective".to_string(),
        json!(manifest_string(&manifest, "objective")?),
    );
    checkpoint.insert(
        "lanes".to_string(),
        manifest
            .get("lanes")
            .cloned()
            .ok_or("Team run manifest missing numeric field `lanes`")?,
    );
    checkpoint.insert("timestamp".to_string(), json!(unix_millis_timestamp()));
    append_team_checkpoint(&target.run_root, checkpoint)?;

    Ok(TeamAbortResult {
        output: format!("Aborted {run_id}\n"),
        warning,
    })
}

pub struct TeamLaneDoctorReport {
    pub output: String,
    pub ok_count: usize,
}

pub fn format_team_lane_doctor<F, W>(env_lookup: F, which_lookup: W) -> TeamLaneDoctorReport
where
    F: Fn(&str) -> Option<String>,
    W: Fn(&str) -> bool,
{
    let mut ok_count = 0;
    let mut missing_count = 0;
    let mut lines = Vec::new();
    for runtime in TEAM_LANE_RUNTIMES {
        let missing_reason = lane_missing_reason(runtime, &env_lookup, &which_lookup);
        match missing_reason {
            Some(reason) => {
                missing_count += 1;
                lines.push(format!("MISS  {:<10}  - {}", runtime, reason));
            }
            None => {
                ok_count += 1;
                lines.push(format!("OK    {:<10}", runtime));
            }
        }
    }
    lines.push(String::new());
    lines.push(format!(
        "Ready: {ok_count}/{}  Missing: {missing_count}",
        TEAM_LANE_RUNTIMES.len()
    ));
    TeamLaneDoctorReport {
        output: format!("{}\n", lines.join("\n")),
        ok_count,
    }
}

pub struct TeamRunRecordRequest {
    pub data_root: PathBuf,
    pub run_id: Option<String>,
    pub objective: String,
    pub persona: String,
    pub lanes_spec: String,
    pub gate: String,
    pub runtime: String,
    pub workspace_root: PathBuf,
    pub created_by: String,
}

pub struct TeamRunRecordResult {
    pub run_id: String,
    pub run_root: PathBuf,
    pub persona: String,
    pub lanes_summary: String,
    pub gate: String,
    pub runtime: String,
}

pub fn start_team_run_record(input: TeamRunRecordRequest) -> Result<TeamRunRecordResult, String> {
    let persona = validate_choice(&input.persona, PERSONA_IDS, "persona")?.to_string();
    let gate = validate_choice(&input.gate, TEAM_GATE_LEVELS, "gate")?.to_string();
    let runtime = validate_choice(&input.runtime, TEAM_RUNTIME_MODES, "runtime")?.to_string();
    let lanes = parse_team_lanes(&input.lanes_spec)?;
    let lane_count = lanes.len();
    let lanes_summary = format_lanes_summary(&lanes);
    let run_id = input.run_id.unwrap_or_else(generate_team_run_id);
    let team_runs_root = input.data_root.join("team-runs");
    let run_root = team_runs_root.join(&run_id);
    if run_root.exists() {
        return Err(format!("Team run already exists at {}", run_root.display()));
    }

    fs::create_dir_all(run_root.join("workers"))
        .map_err(|error| format!("Failed to create workers dir: {error}"))?;
    fs::create_dir_all(run_root.join("reviews"))
        .map_err(|error| format!("Failed to create reviews dir: {error}"))?;
    let manifest = json!({
        "runId": run_id,
        "objective": input.objective,
        "persona": persona,
        "lanes": lane_count,
        "gate": gate,
        "runtime": runtime,
        "createdAt": current_unix_millis(),
        "createdBy": input.created_by,
        "workspaceRoot": input.workspace_root.to_string_lossy(),
    });
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("Failed to encode team manifest: {error}"))?;
    fs::write(run_root.join("manifest.json"), manifest_text)
        .map_err(|error| format!("Failed to write manifest: {error}"))?;
    fs::write(run_root.join("checkpoints.ndjson"), "")
        .map_err(|error| format!("Failed to write checkpoint log: {error}"))?;

    let mut started = Map::new();
    started.insert("type".to_string(), json!("team_run"));
    started.insert(
        "runId".to_string(),
        json!(manifest_string(&manifest, "runId")?),
    );
    started.insert(
        "persona".to_string(),
        json!(manifest_string(&manifest, "persona")?),
    );
    started.insert("status".to_string(), json!("started"));
    started.insert(
        "objective".to_string(),
        json!(manifest_string(&manifest, "objective")?),
    );
    started.insert("lanes".to_string(), json!(lane_count));
    started.insert("timestamp".to_string(), json!(unix_millis_timestamp()));
    append_team_checkpoint(&run_root, started)?;

    Ok(TeamRunRecordResult {
        run_id: manifest_string(&manifest, "runId")?,
        run_root,
        persona: manifest_string(&manifest, "persona")?,
        lanes_summary,
        gate: manifest_string(&manifest, "gate")?,
        runtime: manifest_string(&manifest, "runtime")?,
    })
}

fn list_team_run_refs(data_root: &Path) -> Result<Vec<TeamRunRef>, String> {
    let team_runs_root = data_root.join("team-runs");
    let Ok(entries) = fs::read_dir(&team_runs_root) else {
        return Ok(Vec::new());
    };
    let mut runs = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_team_run_dir_name(&name) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            runs.push(TeamRunRef {
                run_id: name,
                run_root: team_runs_root.join(entry.file_name()),
            });
        }
    }
    runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
    Ok(runs)
}

struct TeamRunRef {
    run_id: String,
    run_root: PathBuf,
}

fn find_team_run(data_root: &Path, run_id: &str) -> Result<TeamRunRef, String> {
    list_team_run_refs(data_root)?
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| format!("Run not found: {run_id}"))
}

fn is_team_run_dir_name(name: &str) -> bool {
    name.starts_with("tr_") || name.starts_with("team-")
}

fn format_team_run_summary(run_root: &Path) -> Result<String, String> {
    let manifest = read_team_manifest(run_root)?;
    let checkpoints = read_team_checkpoints(run_root)?;
    let status = team_status_from_checkpoints(&checkpoints)
        .unwrap_or_else(|| "(no checkpoints)".to_string());
    let steps = checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.get("type").and_then(Value::as_str) == Some("team_step"))
        .count();
    let mut lines = Vec::new();
    lines.push(format!(
        "RUN_ID:    {}",
        manifest_string(&manifest, "runId")?
    ));
    lines.push(format!("RUN_ROOT:  {}", run_root.display()));
    lines.push(format!(
        "Persona:   {}",
        manifest_string(&manifest, "persona")?
    ));
    lines.push(format!(
        "Lanes:     {}",
        manifest_number(&manifest, "lanes")?
    ));
    lines.push(format!(
        "Gate:      {}",
        manifest_string(&manifest, "gate")?
    ));
    lines.push(format!(
        "Runtime:   {}",
        manifest_string(&manifest, "runtime")?
    ));
    lines.push(format!("Status:    {status}"));
    lines.push(format!("Steps:     {steps}"));
    lines.push(format!(
        "Objective: {}",
        manifest_string(&manifest, "objective")?
    ));
    Ok(format!("{}\n", lines.join("\n")))
}

fn read_team_manifest(run_root: &Path) -> Result<Value, String> {
    let path = run_root.join("manifest.json");
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("Invalid {}: {error}", path.display()))
}

fn read_team_checkpoints(run_root: &Path) -> Result<Vec<Value>, String> {
    let path = run_root.join("checkpoints.ndjson");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let mut checkpoints = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<Value>(line).map_err(|error| {
            format!(
                "Invalid checkpoint line {} in {}: {error}",
                index + 1,
                path.display()
            )
        })?;
        checkpoints.push(parsed);
    }
    Ok(checkpoints)
}

struct TeamChainVerification {
    ok: bool,
    verified_lines: usize,
    broken_at: Option<usize>,
    expected_hash: Option<String>,
    actual_hash: Option<String>,
}

fn verify_team_run_chain(run_root: &Path) -> Result<TeamChainVerification, String> {
    let path = run_root.join("checkpoints.ndjson");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(TeamChainVerification {
            ok: true,
            verified_lines: 0,
            broken_at: None,
            expected_hash: None,
            actual_hash: None,
        });
    };

    let lines = raw
        .lines()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let mut prev_hash = ZERO_HASH.to_string();
    for (index, line) in lines.iter().enumerate() {
        let parsed = match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(object)) => object,
            Ok(_) | Err(_) => {
                return Ok(TeamChainVerification {
                    ok: false,
                    verified_lines: index,
                    broken_at: Some(index),
                    expected_hash: None,
                    actual_hash: None,
                });
            }
        };
        let recorded_hash = parsed
            .get("lineHash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let recorded_prev = parsed
            .get("prevTipHash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut without_line_hash = parsed.clone();
        without_line_hash.remove("lineHash");
        let expected_hash =
            hash_team_checkpoint_line(&recorded_prev, &Value::Object(without_line_hash));
        if expected_hash != recorded_hash || recorded_prev != prev_hash {
            return Ok(TeamChainVerification {
                ok: false,
                verified_lines: index,
                broken_at: Some(index),
                expected_hash: Some(expected_hash),
                actual_hash: Some(recorded_hash),
            });
        }
        prev_hash = recorded_hash;
    }
    Ok(TeamChainVerification {
        ok: true,
        verified_lines: lines.len(),
        broken_at: None,
        expected_hash: None,
        actual_hash: None,
    })
}

fn append_team_checkpoint(
    run_root: &Path,
    checkpoint: Map<String, Value>,
) -> Result<Value, String> {
    let checkpoints_path = run_root.join("checkpoints.ndjson");
    let _lock = AppendLock::acquire(run_root)?;
    let prev_tip_hash = current_tip_hash(run_root, &checkpoints_path)?;
    if let Some(requested_prev) = checkpoint.get("prevTipHash").and_then(Value::as_str) {
        if requested_prev != prev_tip_hash {
            return Err(format!(
                "prevTipHash mismatch: expected {prev_tip_hash}, got {requested_prev}"
            ));
        }
    }

    let mut without_line_hash = checkpoint;
    without_line_hash.insert("prevTipHash".to_string(), json!(prev_tip_hash));
    let line_hash =
        hash_team_checkpoint_line(&prev_tip_hash, &Value::Object(without_line_hash.clone()));
    without_line_hash.insert("lineHash".to_string(), json!(line_hash.clone()));
    let final_checkpoint = Value::Object(without_line_hash);
    let line = serde_json::to_string(&final_checkpoint)
        .map_err(|error| format!("Failed to encode team checkpoint: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&checkpoints_path)
        .map_err(|error| format!("Failed to open {}: {error}", checkpoints_path.display()))?;
    writeln!(file, "{line}")
        .map_err(|error| format!("Failed to append {}: {error}", checkpoints_path.display()))?;
    fs::write(run_root.join(".tip"), line_hash).map_err(|error| {
        format!(
            "Failed to write {}: {error}",
            run_root.join(".tip").display()
        )
    })?;
    Ok(final_checkpoint)
}

fn current_tip_hash(run_root: &Path, checkpoints_path: &Path) -> Result<String, String> {
    let tip_path = run_root.join(".tip");
    if let Ok(cached) = fs::read_to_string(&tip_path) {
        let trimmed = cached.trim();
        if is_sha256_hex(trimmed) {
            return Ok(trimmed.to_string());
        }
    }
    let Ok(raw) = fs::read_to_string(checkpoints_path) else {
        return Ok(ZERO_HASH.to_string());
    };
    let Some(last_line) = raw.lines().rev().find(|line| !line.is_empty()) else {
        return Ok(ZERO_HASH.to_string());
    };
    let parsed = serde_json::from_str::<Value>(last_line).ok();
    let recovered = parsed
        .as_ref()
        .and_then(|value| value.get("lineHash"))
        .and_then(Value::as_str)
        .filter(|value| is_sha256_hex(value))
        .unwrap_or(ZERO_HASH)
        .to_string();
    if recovered != ZERO_HASH {
        let _ = fs::write(tip_path, &recovered);
    }
    Ok(recovered)
}

struct AppendLock {
    path: PathBuf,
}

impl AppendLock {
    fn acquire(run_root: &Path) -> Result<Self, String> {
        let path = run_root.join(".append.lock");
        for attempt in 0..=APPEND_LOCK_RETRIES {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let _ = writeln!(file, "{}:{}", std::process::id(), current_unix_millis());
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if attempt == APPEND_LOCK_RETRIES {
                        return Err(format!(
                            "appendTeamCheckpoint: could not acquire {} after {} retries",
                            path.display(),
                            APPEND_LOCK_RETRIES
                        ));
                    }
                    thread::sleep(Duration::from_millis(APPEND_LOCK_DELAY_MS));
                }
                Err(error) => {
                    return Err(format!("Failed to acquire {}: {error}", path.display()));
                }
            }
        }
        Err(format!("Failed to acquire {}", path.display()))
    }
}

impl Drop for AppendLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn hash_team_checkpoint_line(prev_hash: &str, line: &Value) -> String {
    sha256_hex(&format!("{prev_hash}{}", canonical_json(line)))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let parts = keys
                .into_iter()
                .map(|key| {
                    let encoded_key =
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let encoded_value = canonical_json(&object[key]);
                    format!("{encoded_key}:{encoded_value}")
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", parts.join(","))
        }
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn current_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn unix_millis_timestamp() -> String {
    format!("unix-ms:{}", current_unix_millis())
}

fn generate_team_run_id() -> String {
    let millis = current_unix_millis();
    let counter = RUN_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let digest = sha256_hex(&format!("{millis}-{}-{counter}", std::process::id()));
    format!("tr_{millis}_{}", &digest[..6])
}

fn format_lanes_summary(lanes: &[Value]) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for lane in lanes {
        let runtime = lane
            .get("runtime")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_LANE_RUNTIME);
        if let Some((_, count)) = counts.iter_mut().find(|(name, _)| name == runtime) {
            *count += 1;
        } else {
            counts.push((runtime.to_string(), 1));
        }
    }
    let parts = counts
        .into_iter()
        .map(|(runtime, count)| {
            if count > 1 {
                format!("{runtime}x{count}")
            } else {
                runtime
            }
        })
        .collect::<Vec<_>>();
    format!("{} [{}]", lanes.len(), parts.join(","))
}

fn lane_missing_reason<F, W>(runtime: &str, env_lookup: &F, which_lookup: &W) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
    W: Fn(&str) -> bool,
{
    match runtime {
        "openai" => missing_env("openai", "OPENAI_API_KEY", env_lookup),
        "anthropic" => missing_env("anthropic", "ANTHROPIC_API_KEY", env_lookup),
        "gemini" => missing_env("gemini", "GEMINI_API_KEY", env_lookup),
        "cursor" => missing_env("cursor", "CURSOR_API_KEY", env_lookup)
            .or_else(|| missing_binary("cursor", "cursor-agent", which_lookup)),
        "glm" => missing_env("glm", "GLM_API_KEY", env_lookup),
        "codex" => missing_binary("codex", "codex", which_lookup),
        "opencode" => missing_binary("opencode", "opencode", which_lookup),
        "hermes" => missing_binary("hermes", "acpx", which_lookup),
        _ => Some(format!("unknown lane runtime {runtime}")),
    }
}

fn missing_env<F>(runtime: &str, env_name: &str, env_lookup: &F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    match env_lookup(env_name) {
        Some(value) if !value.trim().is_empty() => None,
        _ => Some(format!(
            "{runtime} lane requires {env_name} (currently unset)"
        )),
    }
}

fn missing_binary<W>(runtime: &str, binary: &str, which_lookup: &W) -> Option<String>
where
    W: Fn(&str) -> bool,
{
    if which_lookup(binary) {
        None
    } else {
        Some(format!("{runtime} lane requires `{binary}` on PATH"))
    }
}

fn team_status_from_checkpoints(checkpoints: &[Value]) -> Option<String> {
    checkpoints.iter().rev().find_map(|checkpoint| {
        if checkpoint.get("type").and_then(Value::as_str) == Some("team_run") {
            checkpoint
                .get("status")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        } else {
            None
        }
    })
}

fn manifest_string(manifest: &Value, key: &str) -> Result<String, String> {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("Team run manifest missing string field `{key}`"))
}

fn manifest_number(manifest: &Value, key: &str) -> Result<String, String> {
    manifest
        .get(key)
        .and_then(Value::as_i64)
        .map(|value| value.to_string())
        .ok_or_else(|| format!("Team run manifest missing numeric field `{key}`"))
}

fn compact_objective(objective: &str) -> String {
    let compact = objective.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX_OBJECTIVE_CHARS: usize = 96;
    if compact.chars().count() <= MAX_OBJECTIVE_CHARS {
        return compact;
    }
    let mut truncated = compact
        .chars()
        .take(MAX_OBJECTIVE_CHARS.saturating_sub(1))
        .collect::<String>();
    truncated.push_str("...");
    truncated
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn env_string<'a>(env: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    env.and_then(|values| values.get(key))
        .and_then(Value::as_str)
}

fn validate_choice<'a>(value: &'a str, choices: &[&str], label: &str) -> Result<&'a str, String> {
    if choices.contains(&value) {
        return Ok(value);
    }
    Err(format!(
        "Unknown {label} \"{value}\". Valid: {}",
        choices.join(", ")
    ))
}

fn parse_worker_timeout(value: &str) -> Result<u64, String> {
    value.parse::<u64>().map_err(|_| {
        format!("Invalid --worker-timeout \"{value}\". Expected non-negative integer ms.")
    })
}

fn non_empty_string(value: String, message: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        Err(message.to_string())
    } else {
        Ok(value)
    }
}

fn parse_worker_extras(value: Option<&str>) -> Result<Option<Map<String, Value>>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(value)
        .map_err(|error| format!("--extras must be a JSON object of string values ({error})"))?;
    let object = parsed
        .as_object()
        .ok_or("--extras must be a JSON object of string values (not a JSON object)".to_string())?;
    let mut out = Map::new();
    for (key, value) in object {
        let value = value.as_str().ok_or_else(|| {
            format!(
                "--extras must be a JSON object of string values (extras.{key} must be a string)"
            )
        })?;
        out.insert(key.clone(), Value::String(value.to_string()));
    }
    Ok(Some(out))
}

fn parse_worker_extras_pairs(value: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let Some(extras) = parse_worker_extras(value)? else {
        return Ok(Vec::new());
    };
    extras_pairs_from_map(&extras)
}

fn extras_pairs_from_map(object: &Map<String, Value>) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::with_capacity(object.len());
    for (key, value) in object {
        let value = value
            .as_str()
            .ok_or_else(|| format!("extras.{key} must be a string"))?;
        out.push((key.clone(), value.to_string()));
    }
    out.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(out)
}

fn team_worker_spec_to_value(spec: &TeamWorkerSpec) -> Value {
    let mut out = Map::new();
    out.insert("persona".to_string(), json!(spec.persona));
    out.insert("workerId".to_string(), json!(spec.worker_id));
    out.insert("task".to_string(), json!(spec.task));
    out.insert("runtime".to_string(), json!(spec.runtime));
    if let Some(model) = spec.model.as_ref() {
        out.insert("model".to_string(), json!(model));
    }
    if !spec.extras.is_empty() {
        let mut extras = Map::new();
        for (key, value) in &spec.extras {
            extras.insert(key.clone(), json!(value));
        }
        out.insert("extras".to_string(), Value::Object(extras));
    }
    Value::Object(out)
}

fn truncate_chars(value: &str, cap: usize) -> String {
    if value.chars().count() <= cap {
        return value.to_string();
    }
    let mut out = value
        .chars()
        .take(cap.saturating_sub(3))
        .collect::<String>();
    out.push_str("...");
    out
}

fn parse_team_lanes(input: &str) -> Result<Vec<Value>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(
            "--lanes is empty; expected a count (e.g. 4) or a comma list (e.g. cursor,codex)"
                .to_string(),
        );
    }

    if is_integer_token(trimmed) {
        let count = trimmed.parse::<isize>().unwrap_or(0);
        if count < 1 || count as usize > MAX_LANES_PER_RUN {
            return Err(format!(
                "invalid lane count \"{trimmed}\" (expected 1..{MAX_LANES_PER_RUN})"
            ));
        }
        return Ok((0..count)
            .map(|_| json!({ "runtime": DEFAULT_LANE_RUNTIME }))
            .collect());
    }

    let lanes = trimmed
        .split(',')
        .filter_map(|token| {
            let token = token.trim();
            if token.is_empty() {
                None
            } else {
                Some(parse_single_lane_token(token))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;

    if lanes.len() > MAX_LANES_PER_RUN {
        return Err(format!(
            "too many lanes ({}); cap is {MAX_LANES_PER_RUN}. Run multiple commands or batch the workload.",
            lanes.len()
        ));
    }
    if lanes.is_empty() {
        return Err(format!(
            "--lanes \"{trimmed}\" produced zero lanes; check for trailing commas or empty tokens"
        ));
    }
    Ok(lanes)
}

fn parse_single_lane_token(token: &str) -> Result<Value, String> {
    let parts = token.split(':').collect::<Vec<_>>();
    let runtime = parts.first().map(|value| value.trim()).unwrap_or("");
    validate_choice(runtime, TEAM_LANE_RUNTIMES, "lane runtime").map_err(|_| {
        format!(
            "unknown lane runtime \"{runtime}\". valid: {}",
            TEAM_LANE_RUNTIMES.join(", ")
        )
    })?;

    let extras_idx = parts
        .iter()
        .enumerate()
        .find_map(|(index, part)| (index >= 2 && part.contains('=')).then_some(index));
    let (model_part, extras_part) = match extras_idx {
        Some(index) => (
            parts[1..index].join(":").trim().to_string(),
            parts[index..].join(":").trim().to_string(),
        ),
        None => (parts[1..].join(":").trim().to_string(), String::new()),
    };

    let mut lane = Map::new();
    lane.insert("runtime".to_string(), Value::String(runtime.to_string()));
    if !model_part.is_empty() {
        lane.insert("model".to_string(), Value::String(model_part));
    }
    if !extras_part.is_empty() {
        let mut extras = Map::new();
        for kv in extras_part.split(';') {
            let Some((key, value)) = kv.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if !key.is_empty() {
                extras.insert(key.to_string(), Value::String(value.trim().to_string()));
            }
        }
        if !extras.is_empty() {
            lane.insert("extras".to_string(), Value::Object(extras));
        }
    }
    Ok(Value::Object(lane))
}

fn is_integer_token(value: &str) -> bool {
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    !unsigned.is_empty() && unsigned.chars().all(|char| char.is_ascii_digit())
}

fn build_team_worker_spawn_args(base_args: &[String], spec: &Value) -> Result<Vec<String>, String> {
    let worker_id = string_field(spec, "workerId")
        .filter(|value| !value.is_empty())
        .ok_or("Missing team worker id")?;
    let persona = validate_choice(
        string_field(spec, "persona").unwrap_or(""),
        PERSONA_IDS,
        "persona",
    )?;
    let task = string_field(spec, "task")
        .filter(|value| !value.is_empty())
        .ok_or("Missing team worker task")?;
    let runtime = validate_choice(
        string_field(spec, "runtime").unwrap_or(DEFAULT_LANE_RUNTIME),
        TEAM_LANE_RUNTIMES,
        "runtime",
    )?;

    let mut args = base_args.to_vec();
    args.extend([
        "--worker-id".to_string(),
        worker_id.to_string(),
        "--persona".to_string(),
        persona.to_string(),
        "--task".to_string(),
        task.to_string(),
        "--runtime".to_string(),
        runtime.to_string(),
    ]);
    if let Some(model) = string_field(spec, "model").filter(|value| !value.is_empty()) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(extras) = spec.get("extras").and_then(Value::as_object) {
        if !extras.is_empty() {
            for (key, value) in extras {
                if !value.is_string() {
                    return Err(format!("extras.{key} must be a string"));
                }
            }
            args.extend([
                "--extras".to_string(),
                serde_json::to_string(extras).map_err(|error| error.to_string())?,
            ]);
        }
    }
    Ok(args)
}

fn merge_string_fields(out: &mut Map<String, Value>, value: Option<&Value>) {
    let Some(fields) = value.and_then(Value::as_object) else {
        return;
    };
    for (key, value) in fields {
        if let Some(value) = value.as_str() {
            out.insert(key.clone(), Value::String(value.to_string()));
        }
    }
}

fn path_join(base: &str, child: &str) -> String {
    Path::new(base)
        .join(PathBuf::from(child))
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_team_run_config_defaults_and_env() {
        let parsed = serde_json::from_str::<Value>(
            &resolve_team_run_config_json(
                r#"{"cwd":"/repo","argv1":"/bin/unclecode","env":{"USER":"park","UNCLECODE_DATA_ROOT":"/tmp/uc"},"options":{}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["persona"], "coder");
        assert_eq!(parsed["gate"], "strict");
        assert_eq!(parsed["runtime"], "local");
        assert_eq!(parsed["workerTimeoutMs"], 600000);
        assert_eq!(parsed["dataRoot"], "/tmp/uc");
        assert_eq!(parsed["createdBy"], "park");
        assert_eq!(parsed["cliEntry"], "/bin/unclecode");
    }

    #[test]
    fn resolves_team_run_config_options_and_fallbacks() {
        let parsed = serde_json::from_str::<Value>(
            &resolve_team_run_config_json(
                r#"{"cwd":"/repo","env":{},"options":{"persona":"hardener","gate":"warn","runtime":"docker","workerTimeout":"42"}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["persona"], "hardener");
        assert_eq!(parsed["gate"], "warn");
        assert_eq!(parsed["runtime"], "docker");
        assert_eq!(parsed["workerTimeoutMs"], 42);
        assert_eq!(parsed["dataRoot"], "/repo/.data");
        assert_eq!(parsed["createdBy"], "unclecode-cli");
        assert!(parsed["cliEntry"].is_null());
    }

    #[test]
    fn rejects_invalid_team_run_config_values() {
        assert!(
            resolve_team_run_config_json(r#"{"options":{"persona":"bogus"}}"#)
                .unwrap_err()
                .contains("Unknown persona")
        );
        assert!(
            resolve_team_run_config_json(r#"{"options":{"workerTimeout":"-1"}}"#)
                .unwrap_err()
                .contains("Invalid --worker-timeout")
        );
    }

    #[test]
    fn resolves_team_worker_options() {
        let parsed = serde_json::from_str::<Value>(
            &resolve_team_worker_options_json(
                r#"{"options":{"persona":"coder","workerId":"w1","task":"fix auth","runtime":"codex","model":"gpt-5.4","extras":"{\"agent\":\"codex\"}"}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["persona"], "coder");
        assert_eq!(parsed["workerId"], "w1");
        assert_eq!(parsed["task"], "fix auth");
        assert_eq!(parsed["runtime"], "codex");
        assert_eq!(parsed["model"], "gpt-5.4");
        assert_eq!(parsed["extras"]["agent"], "codex");
    }

    #[test]
    fn rejects_invalid_team_worker_options() {
        assert!(resolve_team_worker_options_json(
            r#"{"options":{"persona":"bogus","workerId":"w1","task":"x"}}"#
        )
        .unwrap_err()
        .contains("Unknown persona"));
        assert!(resolve_team_worker_options_json(
            r#"{"options":{"persona":"coder","workerId":"w1","task":"x","runtime":"bogus"}}"#
        )
        .unwrap_err()
        .contains("Unknown runtime"));
        assert!(resolve_team_worker_options_json(
            r#"{"options":{"persona":"coder","workerId":"w1","task":"x","extras":"{\"n\":1}"}}"#
        )
        .unwrap_err()
        .contains("extras.n must be a string"));
    }

    #[test]
    fn parses_team_lanes_numeric_and_token_forms() {
        let numeric =
            serde_json::from_str::<Value>(&parse_team_lanes_json(r#"{"lanes":"2"}"#).unwrap())
                .unwrap();
        assert_eq!(numeric["lanes"].as_array().unwrap().len(), 2);
        assert_eq!(numeric["lanes"][0]["runtime"], "openai");

        let mixed = serde_json::from_str::<Value>(
            &parse_team_lanes_json(
                r#"{"lanes":"cursor,codex,opencode:hf/llama:3.1:instruct:agent=codex,hermes::channel=#x"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(mixed["lanes"].as_array().unwrap().len(), 4);
        assert_eq!(mixed["lanes"][2]["runtime"], "opencode");
        assert_eq!(mixed["lanes"][2]["model"], "hf/llama:3.1:instruct");
        assert_eq!(mixed["lanes"][2]["extras"]["agent"], "codex");
        assert_eq!(mixed["lanes"][3]["extras"]["channel"], "#x");
    }

    #[test]
    fn rejects_invalid_team_lanes() {
        assert!(parse_team_lanes_json(r#"{"lanes":""}"#)
            .unwrap_err()
            .contains("empty"));
        assert!(parse_team_lanes_json(r#"{"lanes":"0"}"#)
            .unwrap_err()
            .contains("invalid lane count"));
        assert!(parse_team_lanes_json(r#"{"lanes":"bogus,codex"}"#)
            .unwrap_err()
            .contains("unknown lane runtime"));
        let too_many = (0..17).map(|_| "codex").collect::<Vec<_>>().join(",");
        assert!(
            parse_team_lanes_json(&format!(r#"{{"lanes":"{too_many}"}}"#))
                .unwrap_err()
                .contains("too many lanes")
        );
    }

    #[test]
    fn builds_team_worker_spawn_args() {
        let parsed = serde_json::from_str::<Value>(
            &build_team_worker_spawn_args_json(
                r##"{"baseArgs":["--import=tsx","worker.mjs"],"spec":{"workerId":"w1","persona":"coder","task":"fix auth","runtime":"hermes","model":"gpt-5.4","extras":{"channel":"#review","agent":"codex"}}}"##,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            parsed["args"],
            json!([
                "--import=tsx",
                "worker.mjs",
                "--worker-id",
                "w1",
                "--persona",
                "coder",
                "--task",
                "fix auth",
                "--runtime",
                "hermes",
                "--model",
                "gpt-5.4",
                "--extras",
                "{\"agent\":\"codex\",\"channel\":\"#review\"}"
            ])
        );
    }

    #[test]
    fn builds_team_worker_spawn_args_with_default_runtime() {
        let parsed = serde_json::from_str::<Value>(
            &build_team_worker_spawn_args_json(
                r#"{"baseArgs":[],"spec":{"workerId":"w1","persona":"coder","task":"fix auth"}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            parsed["args"],
            json!([
                "--worker-id",
                "w1",
                "--persona",
                "coder",
                "--task",
                "fix auth",
                "--runtime",
                "openai"
            ])
        );
    }

    #[test]
    fn builds_team_worker_specs_for_dispatch() {
        let specs = build_team_worker_specs(
            "cursor,codex:gpt-5.5,hermes::agent=codex;channel=#review",
            "coder",
            "fix queue",
        )
        .unwrap();
        assert_eq!(specs.len(), 3);
        assert_eq!(specs[0].worker_id, "w1");
        assert_eq!(specs[0].runtime, "cursor");
        assert_eq!(specs[1].runtime, "codex");
        assert_eq!(specs[1].model.as_deref(), Some("gpt-5.5"));
        assert_eq!(specs[2].runtime, "hermes");
        assert_eq!(
            specs[2].extras,
            vec![
                ("agent".to_string(), "codex".to_string()),
                ("channel".to_string(), "#review".to_string())
            ]
        );

        let args = build_team_worker_spawn_args_from_spec(
            &["team".to_string(), "worker".to_string()],
            &specs[1],
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "team",
                "worker",
                "--worker-id",
                "w2",
                "--persona",
                "coder",
                "--task",
                "fix queue",
                "--runtime",
                "codex",
                "--model",
                "gpt-5.5"
            ]
        );
    }

    #[test]
    fn resolves_team_dispatch_status() {
        assert_eq!(
            serde_json::from_str::<Value>(
                &resolve_team_dispatch_status_json(
                    r#"{"outcomes":[{"status":"completed"},{"status":"completed"}]}"#
                )
                .unwrap()
            )
            .unwrap()["status"],
            "accepted"
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                &resolve_team_dispatch_status_json(
                    r#"{"outcomes":[{"status":"completed"},{"status":"killed"}]}"#
                )
                .unwrap()
            )
            .unwrap()["status"],
            "killed"
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                &resolve_team_dispatch_status_json(
                    r#"{"outcomes":[{"status":"completed"},{"status":"failed"}]}"#
                )
                .unwrap()
            )
            .unwrap()["status"],
            "errored"
        );
    }

    #[test]
    fn resolves_team_child_env_with_precedence_and_string_filtering() {
        let parsed = serde_json::from_str::<Value>(
            &resolve_team_child_env_json(
                r#"{"baseEnv":{"PATH":"/bin","DROP":null,"OVERRIDE":"base"},"bindingEnv":{"UNCLECODE_TEAM_RUN_ID":"tr_1","OVERRIDE":"binding"},"extraEnv":{"UNCLECODE_TEAM_WORKER_LIVE":"0","OVERRIDE":"extra","N":1}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["env"]["PATH"], "/bin");
        assert_eq!(parsed["env"]["UNCLECODE_TEAM_RUN_ID"], "tr_1");
        assert_eq!(parsed["env"]["UNCLECODE_TEAM_WORKER_LIVE"], "0");
        assert_eq!(parsed["env"]["OVERRIDE"], "extra");
        assert!(parsed["env"].get("DROP").is_none());
        assert!(parsed["env"].get("N").is_none());
    }

    #[test]
    fn resolves_team_worker_close_outcome() {
        let completed = serde_json::from_str::<Value>(
            &resolve_team_worker_close_outcome_json(
                r#"{"killedByTimeout":false,"code":0,"signal":null}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["exitCode"], 0);
        assert!(completed["signal"].is_null());

        let failed = serde_json::from_str::<Value>(
            &resolve_team_worker_close_outcome_json(
                r#"{"killedByTimeout":false,"code":7,"signal":"SIGTERM"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["exitCode"], 7);
        assert_eq!(failed["signal"], "SIGTERM");

        let killed = serde_json::from_str::<Value>(
            &resolve_team_worker_close_outcome_json(
                r#"{"killedByTimeout":true,"code":null,"signal":"SIGKILL"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(killed["status"], "killed");
        assert_eq!(killed["exitCode"], -1);
        assert_eq!(killed["signal"], "SIGKILL");
    }

    #[test]
    fn lists_team_runs_from_data_root() {
        let root = std::env::temp_dir().join(format!("unclecode-team-runs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let team_runs = root.join("team-runs");
        fs::create_dir_all(team_runs.join("tr_2")).unwrap();
        fs::create_dir_all(team_runs.join("tr_1")).unwrap();
        fs::create_dir_all(team_runs.join("team-legacy")).unwrap();
        fs::write(team_runs.join("tr_file"), "not a directory").unwrap();
        fs::create_dir_all(team_runs.join("nope")).unwrap();

        let parsed = serde_json::from_str::<Value>(
            &list_team_runs_json(&format!(
                r#"{{"dataRoot":{}}}"#,
                serde_json::to_string(&root.to_string_lossy()).unwrap()
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["runs"].as_array().unwrap().len(), 3);
        assert_eq!(parsed["runs"][0]["runId"], "team-legacy");
        assert_eq!(parsed["runs"][1]["runId"], "tr_1");
        assert_eq!(
            parsed["runs"][1]["runRoot"],
            team_runs.join("tr_1").to_string_lossy().as_ref()
        );
        assert_eq!(parsed["runs"][2]["runId"], "tr_2");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn formats_team_run_list_and_status_text() {
        let root =
            std::env::temp_dir().join(format!("unclecode-team-run-text-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let run_root = root.join("team-runs").join("tr_1");
        fs::create_dir_all(&run_root).unwrap();
        fs::write(
            run_root.join("manifest.json"),
            r#"{"runId":"tr_1","objective":"inspect queue and model picker","persona":"coder","lanes":2,"gate":"strict","runtime":"local","createdAt":1,"createdBy":"test","workspaceRoot":"/tmp/repo"}"#,
        )
        .unwrap();
        fs::write(
            run_root.join("checkpoints.ndjson"),
            r#"{"type":"team_run","runId":"tr_1","status":"started"}
{"type":"team_step","runId":"tr_1","workerId":"w1","status":"completed"}
{"type":"team_run","runId":"tr_1","status":"completed"}"#,
        )
        .unwrap();

        let list = format_team_runs_list(&root).unwrap();
        assert!(list.contains("tr_1  coder"));
        assert!(list.contains("completed"));
        assert!(list.contains("inspect queue and model picker"));

        let status = format_team_run_status(&root, Some("tr_1")).unwrap();
        assert!(status.contains("RUN_ID:    tr_1"));
        assert!(status.contains("Status:    completed"));
        assert!(status.contains("Steps:     1"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn verifies_and_aborts_team_run_hash_chain() {
        let root =
            std::env::temp_dir().join(format!("unclecode-team-run-chain-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let run_root = root.join("team-runs").join("tr_chain");
        fs::create_dir_all(&run_root).unwrap();
        fs::write(
            run_root.join("manifest.json"),
            r#"{"runId":"tr_chain","objective":"abort stalled queue","persona":"coder","lanes":1,"gate":"strict","runtime":"local","createdAt":1,"createdBy":"test","workspaceRoot":"/tmp/repo"}"#,
        )
        .unwrap();
        fs::write(run_root.join("checkpoints.ndjson"), "").unwrap();

        let mut started = Map::new();
        started.insert("type".to_string(), json!("team_run"));
        started.insert("runId".to_string(), json!("tr_chain"));
        started.insert("persona".to_string(), json!("coder"));
        started.insert("status".to_string(), json!("started"));
        started.insert("objective".to_string(), json!("abort stalled queue"));
        started.insert("lanes".to_string(), json!(1));
        started.insert("timestamp".to_string(), json!("1970-01-01T00:00:00.000Z"));
        append_team_checkpoint(&run_root, started).unwrap();

        let inspect = format_team_run_inspect(&root, "tr_chain", true).unwrap();
        assert!(inspect.ok);
        assert!(inspect.output.contains("Chain: VERIFIED (1 entries)"));

        let abort = abort_team_run(&root, "tr_chain").unwrap();
        assert_eq!(abort.output, "Aborted tr_chain\n");

        let inspect = format_team_run_inspect(&root, "tr_chain", true).unwrap();
        assert!(inspect.ok);
        assert!(inspect.output.contains("Status:    aborted"));
        assert!(inspect.output.contains("Chain: VERIFIED (2 entries)"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn records_team_run_with_started_checkpoint() {
        let root =
            std::env::temp_dir().join(format!("unclecode-team-run-record-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let result = start_team_run_record(TeamRunRecordRequest {
            data_root: root.clone(),
            run_id: Some("tr_record".to_string()),
            objective: "record native queue run".to_string(),
            persona: "coder".to_string(),
            lanes_spec: "codex,opencode:anthropic/claude-sonnet-4-6".to_string(),
            gate: "warn".to_string(),
            runtime: "local".to_string(),
            workspace_root: PathBuf::from("/tmp/repo"),
            created_by: "test".to_string(),
        })
        .unwrap();

        assert_eq!(result.run_id, "tr_record");
        assert_eq!(result.persona, "coder");
        assert_eq!(result.lanes_summary, "2 [codex,opencode]");
        assert!(result.run_root.join("workers").is_dir());
        assert!(result.run_root.join("reviews").is_dir());

        let status = format_team_run_status(&root, Some("tr_record")).unwrap();
        assert!(status.contains("Status:    started"));
        assert!(status.contains("Objective: record native queue run"));

        let inspect = format_team_run_inspect(&root, "tr_record", true).unwrap();
        assert!(inspect.ok);
        assert!(inspect.output.contains("Chain: VERIFIED (1 entries)"));

        append_team_run_status_checkpoint(&result.run_root, "running").unwrap();
        append_team_task_received_checkpoint(&result.run_root, "tr_record", "w1", "abc").unwrap();
        append_team_action_checkpoint(
            &result.run_root,
            "tr_record",
            "w1",
            1,
            "run_shell",
            "def",
            "fed",
        )
        .unwrap();
        append_team_run_status_checkpoint(&result.run_root, "accepted").unwrap();
        let status = format_team_run_status(&root, Some("tr_record")).unwrap();
        assert!(status.contains("Status:    accepted"));
        assert!(status.contains("Steps:     2"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sweeps_stale_team_locks_and_formats_worker_envelope() {
        let root =
            std::env::temp_dir().join(format!("unclecode-team-locks-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let run_root = root.join("team-runs").join("tr_locks");
        let locks = run_root.join("locks");
        fs::create_dir_all(&locks).unwrap();
        fs::write(locks.join("dead.lock"), "w1:404").unwrap();
        fs::write(locks.join("live.lock"), "w2:200").unwrap();

        let sweep = sweep_stale_team_locks(&run_root, |pid| pid == 200);
        assert_eq!(sweep.swept, 1);
        assert_eq!(sweep.live, 1);
        assert!(!locks.join("dead.lock").exists());
        assert!(locks.join("live.lock").exists());

        let envelope = format_team_worker_envelope("w1", "coder", "done");
        assert_eq!(
            envelope,
            "WORKER_ID=w1\nPERSONA=coder\nSUBMISSION:done\n__UNCLECODE_SUBMIT__"
        );
        assert_eq!(apply_team_system_prefix(None, "task"), "task");
        assert_eq!(
            apply_team_system_prefix(Some("persona text"), "task"),
            "<persona>\npersona text\n</persona>\n\ntask"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reports_broken_team_run_hash_chain() {
        let root =
            std::env::temp_dir().join(format!("unclecode-team-run-broken-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let run_root = root.join("team-runs").join("tr_broken");
        fs::create_dir_all(&run_root).unwrap();
        fs::write(
            run_root.join("manifest.json"),
            r#"{"runId":"tr_broken","objective":"verify tamper","persona":"coder","lanes":1,"gate":"strict","runtime":"local","createdAt":1,"createdBy":"test","workspaceRoot":"/tmp/repo"}"#,
        )
        .unwrap();
        fs::write(
            run_root.join("checkpoints.ndjson"),
            r#"{"type":"team_run","runId":"tr_broken","status":"started"}"#,
        )
        .unwrap();

        let inspect = format_team_run_inspect(&root, "tr_broken", true).unwrap();
        assert!(!inspect.ok);
        assert!(inspect.output.contains("Chain: BROKEN at line 0"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn formats_team_lane_doctor_without_node_adapter_bridge() {
        let report = format_team_lane_doctor(
            |key| (key == "OPENAI_API_KEY").then_some("sk-test".to_string()),
            |binary| binary == "codex",
        );
        assert_eq!(report.ok_count, 2);
        assert!(report.output.contains("OK    openai"));
        assert!(report.output.contains("OK    codex"));
        assert!(report.output.contains("MISS  anthropic"));
        assert!(report.output.contains("Ready: 2/8  Missing: 6"));
    }
}
