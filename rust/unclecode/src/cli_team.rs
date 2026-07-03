use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use unclecode_core::http_transport::post_json_with_headers;
use unclecode_core::sha256::sha256_hex;
use unclecode_core::team_mini_loop::{run_team_mini_loop, TeamMiniLoopRequest};
use unclecode_core::team_runtime::{
    abort_team_run, append_team_run_status_checkpoint, append_team_task_received_checkpoint,
    apply_team_system_prefix, build_team_worker_spawn_args_from_spec, build_team_worker_specs,
    format_team_lane_doctor, format_team_run_inspect, format_team_run_status,
    format_team_runs_list, format_team_worker_envelope, resolve_team_worker_options,
    start_team_run_record, sweep_stale_team_locks, TeamRunRecordRequest, TeamRunRecordResult,
    TeamWorkerOptionsRequest, TeamWorkerSpec,
};

const WORKER_STREAM_CAP_BYTES: usize = 1_000_000;
const OPENAI_DEFAULT_MODEL: &str = "gpt-5.5";
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const GEMINI_DEFAULT_MODEL: &str = "gemini-2.5-pro";
const GEMINI_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const CODEX_DEFAULT_MODEL: &str = "gpt-5.5";
const OPENCODE_DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4-6";
const CURSOR_DEFAULT_MODEL: &str = "composer-2.5";
const HERMES_DEFAULT_AGENT: &str = "claude";
const HERMES_DEFAULT_FORMAT: &str = "text";
const GLM_DEFAULT_BASE_URL: &str = "https://api.z.ai/api/coding/paas/v4";
const GLM_DEFAULT_MODEL: &str = "glm-5.1";

pub fn top_level_team_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("team") => {
            if is_native_team_surface(&args[1..]) {
                Some(args[1..].to_vec())
            } else {
                None
            }
        }
        Some("/team") => {
            if is_native_team_surface(&args[1..]) {
                Some(args[1..].to_vec())
            } else {
                None
            }
        }
        Some(command) if command.starts_with("/team ") => {
            let parsed = command
                .split_whitespace()
                .skip(1)
                .map(OsString::from)
                .chain(args[1..].iter().cloned())
                .collect::<Vec<_>>();
            if is_native_team_surface(&parsed) {
                Some(parsed)
            } else {
                None
            }
        }
        _ => None,
    }
}

pub fn run_top_level_team_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_team_help();
            Ok(0)
        }
        Some("ls") | Some("list") => {
            print!("{}", format_team_runs_list(&team_data_root())?);
            Ok(0)
        }
        Some("run") => {
            if args
                .get(1)
                .and_then(|arg| arg.to_str())
                .is_some_and(|value| value == "--help" || value == "-h" || value == "help")
            {
                print_team_help();
                return Ok(0);
            }
            let parsed = parse_run_args(&args[1..])?;
            let result = start_team_run_record(TeamRunRecordRequest {
                data_root: team_data_root(),
                run_id: parsed.record.clone(),
                objective: parsed.objective.join(" "),
                persona: parsed.persona.clone(),
                lanes_spec: parsed.lanes.clone(),
                gate: parsed.gate.clone(),
                runtime: parsed.runtime.clone(),
                workspace_root: env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                created_by: env::var("USER").unwrap_or_else(|_| "unclecode-cli".to_string()),
            })?;
            if parsed.quiet {
                println!("{}", result.run_id);
            } else {
                println!("RUN_ID={}", result.run_id);
                println!("RUN_ROOT={}", result.run_root.display());
                println!(
                    "persona={} lanes={} gate={} runtime={}",
                    result.persona, result.lanes_summary, result.gate, result.runtime
                );
            }
            if parsed.dispatch {
                run_team_dispatch(&result, &parsed)
            } else {
                Ok(0)
            }
        }
        Some("worker") => {
            if args.iter().any(|arg| {
                arg.to_str()
                    .is_some_and(|value| value == "--help" || value == "-h")
            }) {
                print_team_worker_help();
                return Ok(0);
            }
            run_team_worker(&args[1..])
        }
        Some("status") => {
            let run_id = args.get(1).and_then(|arg| arg.to_str());
            print!("{}", format_team_run_status(&team_data_root(), run_id)?);
            Ok(0)
        }
        Some("inspect") => {
            let parsed = parse_inspect_args(&args[1..])?;
            let result = format_team_run_inspect(&team_data_root(), &parsed.run_id, parsed.verify)?;
            print!("{}", result.output);
            Ok(if result.ok { 0 } else { 1 })
        }
        Some("abort") => {
            let run_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .filter(|value| !value.is_empty())
                .ok_or_else(team_usage)?;
            let result = abort_team_run(&team_data_root(), run_id)?;
            if let Some(warning) = result.warning {
                eprintln!("{warning}");
            }
            print!("{}", result.output);
            Ok(0)
        }
        Some("doctor") => {
            let report = format_team_lane_doctor(|key| env::var(key).ok(), binary_on_path);
            print!("{}", report.output);
            Ok(if report.ok_count == 0 { 1 } else { 0 })
        }
        _ => Err(team_usage()),
    }
}

fn is_native_team_surface(args: &[OsString]) -> bool {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") | Some("ls") | Some("list")
        | Some("status") | Some("inspect") | Some("abort") | Some("doctor") => true,
        Some("run") => is_native_record_run_surface(&args[1..]),
        Some("worker") => is_native_worker_surface(&args[1..]),
        _ => false,
    }
}

fn team_data_root() -> PathBuf {
    env::var_os("UNCLECODE_DATA_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".data")
        })
}

fn print_team_help() {
    println!("{}", team_usage());
    println!();
    println!("Rust-native team commands:");
    println!("  unclecode team run [options] <objective...>");
    println!("  unclecode team ls");
    println!("  unclecode team status [runId]");
    println!("  unclecode team inspect [--verify] <runId>");
    println!("  unclecode team abort <runId>");
    println!("  unclecode team doctor");
    println!("  unclecode team run --dispatch [options] <objective...>");
    println!("  UNCLECODE_TEAM_WORKER_LIVE=0 unclecode team worker [options]");
    println!();
    println!(
        "Live openai/anthropic/gemini/cursor/codex/opencode/glm/hermes workers are Rust-native."
    );
}

fn print_team_worker_help() {
    println!("Usage: unclecode team worker --persona <id> --worker-id <id> --task <text> [--runtime <id>] [--model <id>] [--extras <json>]");
    println!();
    println!("Rust-native worker dry-run is enabled with UNCLECODE_TEAM_WORKER_LIVE=0; live openai/anthropic/gemini/cursor/codex/opencode/glm/hermes workers are native.");
}

fn team_usage() -> String {
    "Usage: unclecode team <run [options] <objective...>|ls|status [runId]|inspect [--verify] <runId>|abort <runId>|doctor>".to_string()
}

struct RunArgs {
    objective: Vec<String>,
    persona: String,
    lanes: String,
    gate: String,
    runtime: String,
    record: Option<String>,
    quiet: bool,
    dispatch: bool,
    worker_timeout_ms: u64,
}

fn is_native_record_run_surface(args: &[OsString]) -> bool {
    args.iter().all(|arg| {
        !arg.to_str()
            .is_some_and(|value| value.starts_with("--dispatch="))
    })
}

fn is_native_worker_surface(args: &[OsString]) -> bool {
    args.iter().any(|arg| {
        arg.to_str()
            .is_some_and(|value| value == "--help" || value == "-h")
    }) || env::var("UNCLECODE_TEAM_WORKER_LIVE").ok().as_deref() == Some("0")
        || worker_runtime_arg(args)
            .as_deref()
            .is_some_and(is_rust_native_cli_worker_runtime)
}

fn parse_run_args(args: &[OsString]) -> Result<RunArgs, String> {
    let mut objective = Vec::new();
    let mut persona = "coder".to_string();
    let mut lanes = "1".to_string();
    let mut gate = "strict".to_string();
    let mut runtime = "local".to_string();
    let mut record = None;
    let mut quiet = false;
    let mut dispatch = false;
    let mut worker_timeout_ms = 600_000;
    let mut index = 0;

    while index < args.len() {
        let value = args[index].to_str().ok_or_else(team_usage)?;
        if value == "--" {
            objective.extend(
                args[index + 1..]
                    .iter()
                    .map(|arg| arg.to_string_lossy().into_owned()),
            );
            break;
        }
        if value == "--quiet" {
            quiet = true;
            index += 1;
            continue;
        }
        if value == "--dispatch" {
            dispatch = true;
            index += 1;
            continue;
        }
        if value.starts_with("--dispatch=") {
            return Err(team_usage());
        }
        if let Some(next) = take_option_value("--persona", value, args, &mut index)? {
            persona = next;
            continue;
        }
        if let Some(next) = take_option_value("--lanes", value, args, &mut index)? {
            lanes = next;
            continue;
        }
        if let Some(next) = take_option_value("--gate", value, args, &mut index)? {
            gate = next;
            continue;
        }
        if let Some(next) = take_option_value("--runtime", value, args, &mut index)? {
            runtime = next;
            continue;
        }
        if let Some(next) = take_option_value("--record", value, args, &mut index)? {
            record = Some(next);
            continue;
        }
        if let Some(next) = take_option_value("--worker-timeout", value, args, &mut index)? {
            worker_timeout_ms = next.parse::<u64>().map_err(|_| {
                format!("Invalid --worker-timeout \"{next}\". Expected non-negative integer ms.")
            })?;
            continue;
        }
        if value.starts_with('-') {
            return Err(team_usage());
        }
        objective.push(value.to_string());
        index += 1;
    }

    if objective.is_empty() {
        return Err("`unclecode team run` requires an objective string.".to_string());
    }

    Ok(RunArgs {
        objective,
        persona,
        lanes,
        gate,
        runtime,
        record,
        quiet,
        dispatch,
        worker_timeout_ms,
    })
}

fn run_team_worker(args: &[OsString]) -> Result<u8, String> {
    if env::var("UNCLECODE_TEAM_RUN_ID")
        .ok()
        .filter(|value| !value.is_empty())
        .is_none()
        || env::var("UNCLECODE_TEAM_RUN_ROOT")
            .ok()
            .filter(|value| !value.is_empty())
            .is_none()
    {
        eprintln!("team worker: missing UNCLECODE_TEAM_RUN_ID or UNCLECODE_TEAM_RUN_ROOT.");
        return Ok(2);
    }
    let parsed = match parse_worker_args(args).and_then(|args| {
        resolve_team_worker_options(TeamWorkerOptionsRequest {
            persona: args.persona,
            worker_id: args.worker_id,
            task: args.task,
            runtime: Some(args.runtime),
            model: args.model,
            extras_json: args.extras,
        })
    }) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("team worker: {error}");
            return Ok(2);
        }
    };
    if env::var("UNCLECODE_TEAM_WORKER_LIVE").ok().as_deref() == Some("0") {
        println!(
            "{}",
            format_team_worker_envelope(&parsed.worker_id, &parsed.persona, &parsed.task)
        );
        return Ok(0);
    }
    if !is_rust_native_cli_worker_runtime(&parsed.runtime) {
        return Err(format!(
            "team worker: runtime {} still uses the temporary TypeScript bridge.",
            parsed.runtime
        ));
    }
    let code = run_native_cli_worker(&parsed)?;
    Ok(code)
}

fn run_team_dispatch(result: &TeamRunRecordResult, parsed: &RunArgs) -> Result<u8, String> {
    let _lock = TeamRunLock::acquire(&result.run_root)?;
    let objective = parsed.objective.join(" ");
    let workers = build_team_worker_specs(&parsed.lanes, &result.persona, &objective)?;
    if !parsed.quiet {
        println!("Dispatching {} worker(s)...", workers.len());
    }

    append_team_run_status_checkpoint(&result.run_root, "running")?;
    let sweep = sweep_stale_team_locks(&result.run_root, is_pid_alive);

    let command =
        env::current_exe().map_err(|error| format!("Failed to resolve current exe: {error}"))?;
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let env_vars = env::vars_os().collect::<Vec<_>>();
    let mut handles = Vec::with_capacity(workers.len());
    for worker in workers {
        let command = command.clone();
        let cwd = cwd.clone();
        let env_vars = env_vars.clone();
        let run_id = result.run_id.clone();
        let run_root = result.run_root.clone();
        let timeout_ms = parsed.worker_timeout_ms;
        handles.push(thread::spawn(move || {
            run_worker_process(command, cwd, env_vars, run_id, run_root, worker, timeout_ms)
        }));
    }

    let mut outcomes = Vec::with_capacity(handles.len());
    for handle in handles {
        outcomes.push(
            handle
                .join()
                .map_err(|_| "team dispatch worker thread panicked".to_string())??,
        );
    }

    let final_status = resolve_dispatch_status(&outcomes);
    append_team_run_status_checkpoint(&result.run_root, final_status)?;

    if !parsed.quiet {
        println!("Final status: {final_status}");
        for outcome in &outcomes {
            print_worker_output(outcome);
            println!(
                "  {} {:<22} {:<9} exit={} {}ms",
                outcome.worker_id,
                outcome.persona,
                outcome.status,
                outcome.exit_code,
                outcome.duration_ms
            );
        }
        if sweep.swept > 0 {
            println!(
                "Stale lock sweep: removed={} live={}",
                sweep.swept, sweep.live
            );
        }
    }

    Ok(if final_status == "accepted" { 0 } else { 1 })
}

fn take_option_value(
    name: &str,
    value: &str,
    args: &[OsString],
    index: &mut usize,
) -> Result<Option<String>, String> {
    if let Some(inline) = value.strip_prefix(&format!("{name}=")) {
        *index += 1;
        return Ok(Some(inline.to_string()));
    }
    if value == name {
        let next = args
            .get(*index + 1)
            .and_then(|arg| arg.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(team_usage)?;
        *index += 2;
        return Ok(Some(next.to_string()));
    }
    Ok(None)
}

struct WorkerArgs {
    worker_id: String,
    persona: String,
    task: String,
    runtime: String,
    model: Option<String>,
    extras: Option<String>,
}

fn parse_worker_args(args: &[OsString]) -> Result<WorkerArgs, String> {
    let mut worker_id = None;
    let mut persona = None;
    let mut task = None;
    let mut runtime = "openai".to_string();
    let mut model = None;
    let mut extras = None;
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_str().ok_or_else(team_usage)?;
        if let Some(next) = take_option_value("--worker-id", value, args, &mut index)? {
            worker_id = Some(next);
            continue;
        }
        if let Some(next) = take_option_value("--persona", value, args, &mut index)? {
            persona = Some(next);
            continue;
        }
        if let Some(next) = take_option_value("--task", value, args, &mut index)? {
            task = Some(next);
            continue;
        }
        if let Some(next) = take_option_value("--runtime", value, args, &mut index)? {
            runtime = next;
            continue;
        }
        if let Some(next) = take_option_value("--model", value, args, &mut index)? {
            model = Some(next);
            continue;
        }
        if let Some(next) = take_option_value("--extras", value, args, &mut index)? {
            extras = Some(next);
            continue;
        }
        return Err(team_usage());
    }
    Ok(WorkerArgs {
        worker_id: worker_id.ok_or("Missing team worker id")?,
        persona: persona.ok_or("Missing team worker persona")?,
        task: task.ok_or("Missing team worker task")?,
        runtime,
        model,
        extras,
    })
}

fn worker_runtime_arg(args: &[OsString]) -> Option<String> {
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_str()?;
        if let Some(inline) = value.strip_prefix("--runtime=") {
            return Some(inline.to_string());
        }
        if value == "--runtime" {
            return args
                .get(index + 1)
                .and_then(|arg| arg.to_str())
                .map(ToString::to_string);
        }
        index += 1;
    }
    None
}

fn is_rust_native_cli_worker_runtime(runtime: &str) -> bool {
    matches!(
        runtime,
        "openai" | "anthropic" | "gemini" | "cursor" | "codex" | "opencode" | "hermes" | "glm"
    )
}

fn run_native_cli_worker(spec: &TeamWorkerSpec) -> Result<u8, String> {
    let run_id = env::var("UNCLECODE_TEAM_RUN_ID")
        .map_err(|_| "team worker: missing UNCLECODE_TEAM_RUN_ID".to_string())?;
    let run_root = env::var_os("UNCLECODE_TEAM_RUN_ROOT")
        .map(PathBuf::from)
        .ok_or("team worker: missing UNCLECODE_TEAM_RUN_ROOT".to_string())?;
    append_team_task_received_checkpoint(
        &run_root,
        &run_id,
        &spec.worker_id,
        &sha256_hex(&spec.task),
    )?;

    let result = match spec.runtime.as_str() {
        "openai" | "anthropic" | "gemini" => run_sdk_worker(spec, &run_id, &run_root),
        "cursor" => run_cursor_worker(spec),
        "codex" => run_codex_worker(spec),
        "opencode" => run_opencode_worker(spec),
        "hermes" => run_hermes_worker(spec),
        "glm" => run_glm_worker(spec),
        runtime => Err(format!("team worker: runtime {runtime} is not Rust-native")),
    };
    match result {
        Ok((ok, submission)) => {
            println!(
                "{}",
                format_team_worker_envelope(&spec.worker_id, &spec.persona, &submission)
            );
            Ok(if ok { 0 } else { 1 })
        }
        Err(error) => {
            eprintln!("team worker: {error}");
            println!(
                "{}",
                format_team_worker_envelope(&spec.worker_id, &spec.persona, &error)
            );
            Ok(1)
        }
    }
}

fn run_sdk_worker(
    spec: &TeamWorkerSpec,
    run_id: &str,
    run_root: &std::path::Path,
) -> Result<(bool, String), String> {
    let api_key = sdk_api_key(spec)?;
    let model = spec
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| sdk_default_model(&spec.runtime));
    let base_url = sdk_base_url(&spec.runtime);
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let result = run_team_mini_loop(TeamMiniLoopRequest {
        runtime: spec.runtime.clone(),
        api_key,
        model: model.to_string(),
        base_url,
        run_root: run_root.to_path_buf(),
        run_id: run_id.to_string(),
        worker_id: spec.worker_id.clone(),
        persona: spec.persona.clone(),
        task: spec.task.clone(),
        cwd,
        reasoning_effort: env::var("OPENAI_REASONING_EFFORT")
            .ok()
            .filter(|value| spec.runtime == "openai" && !value.trim().is_empty()),
    })?;
    let ok = result.status == "submitted";
    let submission = if ok {
        result.submission
    } else {
        format!("{}: {}", result.status, result.submission)
    };
    Ok((ok, submission))
}

fn sdk_api_key(spec: &TeamWorkerSpec) -> Result<String, String> {
    let env_name = match spec.runtime.as_str() {
        "openai" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        runtime => return Err(format!("team worker: runtime {runtime} is not an SDK lane")),
    };
    env::var(env_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "{} lane requires {env_name} - refusing to dispatch worker {}",
                spec.runtime, spec.worker_id
            )
        })
}

fn sdk_default_model(runtime: &str) -> &'static str {
    match runtime {
        "openai" => OPENAI_DEFAULT_MODEL,
        "anthropic" => ANTHROPIC_DEFAULT_MODEL,
        "gemini" => GEMINI_DEFAULT_MODEL,
        _ => OPENAI_DEFAULT_MODEL,
    }
}

fn sdk_base_url(runtime: &str) -> String {
    let (env_names, default_url): (&[&str], &str) = match runtime {
        "openai" => (
            &["OPENAI_BASE_URL", "OPENAI_API_BASE_URL"],
            OPENAI_DEFAULT_BASE_URL,
        ),
        "anthropic" => (
            &["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL"],
            ANTHROPIC_DEFAULT_BASE_URL,
        ),
        "gemini" => (
            &["GEMINI_BASE_URL", "GEMINI_API_BASE_URL"],
            GEMINI_DEFAULT_BASE_URL,
        ),
        _ => (
            &["OPENAI_BASE_URL", "OPENAI_API_BASE_URL"],
            OPENAI_DEFAULT_BASE_URL,
        ),
    };
    env_var_any(env_names)
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_url.to_string())
}

fn env_var_any(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn run_cursor_worker(spec: &TeamWorkerSpec) -> Result<(bool, String), String> {
    let binary = "cursor-agent";
    require_binary(binary, &spec.runtime, &spec.worker_id)?;
    let api_key = env::var("CURSOR_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "cursor lane requires CURSOR_API_KEY - refusing to dispatch worker {}",
                spec.worker_id
            )
        })?;
    let model = spec.model.as_deref().unwrap_or(CURSOR_DEFAULT_MODEL);
    let prompt = apply_team_system_prefix(team_persona_system_prompt(&spec.persona), &spec.task);
    let output = run_cli_adapter_command_with_env(
        binary,
        &[
            "--print",
            "--output-format",
            "json",
            "--model",
            model,
            "--force",
            &prompt,
        ],
        &[("CURSOR_API_KEY", api_key.as_str())],
    )?;
    if output.exit_code != 0 {
        return Ok((false, command_failure_detail(&output)));
    }
    let submission = json_string_field(&output.stdout, "result")
        .or_else(|| json_string_field(&output.stdout, "message"))
        .unwrap_or_else(|| output.stdout.trim().to_string());
    if submission.is_empty() {
        return Ok((
            false,
            format!(
                "cursor-agent --print exited 0 but produced no output{}",
                stderr_suffix(&output.stderr)
            ),
        ));
    }
    let status = json_string_field(&output.stdout, "status")
        .or_else(|| json_string_field(&output.stdout, "subtype"))
        .unwrap_or_else(|| "finished".to_string());
    Ok((!matches!(status.as_str(), "error" | "failed"), submission))
}

fn run_codex_worker(spec: &TeamWorkerSpec) -> Result<(bool, String), String> {
    let binary = "codex";
    require_binary(binary, &spec.runtime, &spec.worker_id)?;
    let model = spec.model.as_deref().unwrap_or(CODEX_DEFAULT_MODEL);
    let prompt = apply_team_system_prefix(team_persona_system_prompt(&spec.persona), &spec.task);
    let output = run_cli_adapter_command(binary, &["exec", "--json", "--model", model, &prompt])?;
    if output.exit_code != 0 {
        return Ok((false, command_failure_detail(&output)));
    }
    let submission = parse_last_codex_agent_message(&output.stdout)
        .unwrap_or_else(|| output.stdout.trim().to_string());
    if submission.is_empty() {
        return Ok((
            false,
            format!(
                "codex exec exited 0 but produced no output{}",
                stderr_suffix(&output.stderr)
            ),
        ));
    }
    Ok((true, submission))
}

fn run_opencode_worker(spec: &TeamWorkerSpec) -> Result<(bool, String), String> {
    let binary = "opencode";
    require_binary(binary, &spec.runtime, &spec.worker_id)?;
    let model = spec.model.as_deref().unwrap_or(OPENCODE_DEFAULT_MODEL);
    let prompt = apply_team_system_prefix(team_persona_system_prompt(&spec.persona), &spec.task);
    let output = run_cli_adapter_command(binary, &["run", "--model", model, &prompt])?;
    if output.exit_code != 0 {
        return Ok((false, command_failure_detail(&output)));
    }
    let submission = output.stdout.trim().to_string();
    if submission.is_empty() {
        return Ok((
            false,
            format!(
                "opencode run exited 0 but produced no output{}",
                stderr_suffix(&output.stderr)
            ),
        ));
    }
    Ok((true, submission))
}

fn run_hermes_worker(spec: &TeamWorkerSpec) -> Result<(bool, String), String> {
    let binary = "acpx";
    require_binary(binary, &spec.runtime, &spec.worker_id)?;
    let agent = spec_extra(spec, "agent").unwrap_or(HERMES_DEFAULT_AGENT);
    if !is_known_acpx_agent(agent) {
        return Err(format!(
            "hermes lane: unknown acpx agent \"{agent}\". Known: {}",
            ACPX_AGENTS.join(", ")
        ));
    }
    let format = spec_extra(spec, "format").unwrap_or(HERMES_DEFAULT_FORMAT);
    let approve = spec_extra(spec, "approve").unwrap_or("all");
    let prompt = apply_team_system_prefix(team_persona_system_prompt(&spec.persona), &spec.task);
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = cwd.to_string_lossy().into_owned();
    let mut args = vec!["--cwd", cwd.as_str(), "--format", format];
    if approve == "all" {
        args.push("--approve-all");
    } else if approve == "reads" {
        args.push("--approve-reads");
    }
    if let Some(model) = spec
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        args.extend(["--model", model]);
    }
    args.extend([agent, "exec", "--", prompt.as_str()]);
    let output = run_cli_adapter_command(binary, &args)?;
    if output.exit_code != 0 {
        return Ok((false, command_failure_detail(&output)));
    }
    let submission = output.stdout.trim().to_string();
    if submission.is_empty() {
        return Ok((
            false,
            format!(
                "acpx {agent} exec exited 0 but produced no output{}",
                stderr_suffix(&output.stderr)
            ),
        ));
    }
    Ok((true, submission))
}

fn run_glm_worker(spec: &TeamWorkerSpec) -> Result<(bool, String), String> {
    let api_key = env::var("GLM_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "glm lane requires GLM_API_KEY - refusing to dispatch worker {}",
                spec.worker_id
            )
        })?;
    let base_url = env::var("GLM_BASE_URL")
        .ok()
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| GLM_DEFAULT_BASE_URL.to_string());
    let url = format!("{base_url}/chat/completions");
    let model = spec.model.as_deref().unwrap_or(GLM_DEFAULT_MODEL);
    let headers = format!(
        "{{\"Authorization\":\"Bearer {}\",\"Content-Type\":\"application/json\"}}",
        json_escape(&api_key)
    );
    let body = glm_request_body(model, team_persona_system_prompt(&spec.persona), &spec.task);
    let response = post_json_with_headers(&url, &headers, &body)?;
    if !response.ok {
        return Ok((
            false,
            format!("glm http {}: {}", response.status, response.body),
        ));
    }
    let content = json_string_field(&response.body, "content").unwrap_or_default();
    Ok((!content.is_empty(), content))
}

struct CliAdapterOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

fn run_cli_adapter_command(binary: &str, args: &[&str]) -> Result<CliAdapterOutput, String> {
    run_cli_adapter_command_with_env(binary, args, &[])
}

fn run_cli_adapter_command_with_env(
    binary: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<CliAdapterOutput, String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .envs(env::vars_os())
        .stdin(Stdio::null());
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let output = command
        .output()
        .map_err(|error| format!("failed to run `{binary}`: {error}"))?;
    Ok(CliAdapterOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

fn require_binary(binary: &str, runtime: &str, worker_id: &str) -> Result<(), String> {
    if binary_on_path(binary) {
        Ok(())
    } else {
        Err(format!(
            "{runtime} lane requires `{binary}` on PATH - refusing to dispatch worker {worker_id}"
        ))
    }
}

fn command_failure_detail(output: &CliAdapterOutput) -> String {
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = output.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    format!("exit code {}", output.exit_code)
}

fn stderr_suffix(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    }
}

fn parse_last_codex_agent_message(stdout: &str) -> Option<String> {
    let mut last = None;
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some(content) = json_string_field(line, "content") else {
            continue;
        };
        if json_string_field(line, "type").as_deref() == Some("agent_message") {
            last = Some(content);
        }
    }
    last
}

fn json_string_field(line: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let start = line.find(&needle)?;
    let after_key = &line[start + needle.len()..];
    let colon = after_key.find(':')?;
    let mut rest = after_key[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    rest = &rest[1..];
    let mut value = String::new();
    let mut escaped = false;
    for ch in rest.chars() {
        if escaped {
            value.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '"' => '"',
                '\\' => '\\',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(value);
        }
        value.push(ch);
    }
    None
}

fn glm_request_body(model: &str, system_prompt: Option<&str>, task: &str) -> String {
    let mut messages = Vec::new();
    if let Some(system_prompt) = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        messages.push(format!(
            "{{\"role\":\"system\",\"content\":\"{}\"}}",
            json_escape(system_prompt)
        ));
    }
    messages.push(format!(
        "{{\"role\":\"user\",\"content\":\"{}\"}}",
        json_escape(task)
    ));
    format!(
        "{{\"model\":\"{}\",\"messages\":[{}]}}",
        json_escape(model),
        messages.join(",")
    )
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out
}

fn spec_extra<'a>(spec: &'a TeamWorkerSpec, key: &str) -> Option<&'a str> {
    spec.extras
        .iter()
        .find_map(|(name, value)| (name == key).then_some(value.as_str()))
}

const ACPX_AGENTS: &[&str] = &[
    "claude", "codex", "copilot", "cursor", "droid", "gemini", "iflow", "kilocode", "kimi", "kiro",
    "openclaw", "opencode", "pi", "qoder", "qwen", "trae",
];

fn is_known_acpx_agent(agent: &str) -> bool {
    ACPX_AGENTS.contains(&agent)
}

fn team_persona_system_prompt(persona: &str) -> Option<&'static str> {
    match persona {
        "coder" => Some("You are an UncleCode coding agent. Implement a narrow fix or feature, cite concrete evidence, and report verification honestly."),
        "builder" => Some("You are an UncleCode builder agent. Deliver the bounded feature slice end-to-end and verify the result."),
        "hardener" => Some("You are an UncleCode hardener agent. Improve robustness and security without changing intended behavior."),
        "auditor" => Some("You are an UncleCode auditor agent. Analyze and report with grounded evidence; do not make unsupported claims."),
        "agentless-fix" => Some("You are an UncleCode agentless-fix lane. Localize the issue, propose the minimum patch, and submit."),
        "agentless-then-agent" => Some("You are an UncleCode agentless-then-agent lane. Try a direct localization first, then escalate only as needed."),
        "mini" => Some("You are an UncleCode mini lane. Keep the response concise and action-oriented."),
        _ => None,
    }
}

struct TeamRunLock {
    path: PathBuf,
}

impl TeamRunLock {
    fn acquire(run_root: &std::path::Path) -> Result<Self, String> {
        let path = run_root.join(".lock");
        fs::write(
            &path,
            format!("{}:{}", std::process::id(), current_millis()),
        )
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
        Ok(Self { path })
    }
}

impl Drop for TeamRunLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct WorkerOutcome {
    worker_id: String,
    persona: String,
    status: &'static str,
    exit_code: i32,
    signal: Option<String>,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
    duration_ms: u128,
}

fn run_worker_process(
    command: PathBuf,
    cwd: PathBuf,
    env_vars: Vec<(OsString, OsString)>,
    run_id: String,
    run_root: PathBuf,
    worker: TeamWorkerSpec,
    timeout_ms: u64,
) -> Result<WorkerOutcome, String> {
    let base_args = vec!["team".to_string(), "worker".to_string()];
    let spawn_args = build_team_worker_spawn_args_from_spec(&base_args, &worker)?;
    let started = Instant::now();
    let mut child = Command::new(command)
        .args(spawn_args)
        .current_dir(cwd)
        .envs(env_vars)
        .env("UNCLECODE_TEAM_RUN_ID", &run_id)
        .env("UNCLECODE_TEAM_RUN_ROOT", &run_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to spawn team worker {}: {error}", worker.worker_id))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture team worker stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture team worker stderr")?;
    let stdout_handle = thread::spawn(move || read_capped_stream(stdout));
    let stderr_handle = thread::spawn(move || read_capped_stream(stderr));

    let mut killed_by_timeout = false;
    let exit_status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to wait for worker {}: {error}", worker.worker_id))?
        {
            break status;
        }
        if timeout_ms > 0 && started.elapsed() >= Duration::from_millis(timeout_ms) {
            killed_by_timeout = true;
            let _ = child.kill();
            break child
                .wait()
                .map_err(|error| format!("Failed to reap worker {}: {error}", worker.worker_id))?;
        }
        thread::sleep(Duration::from_millis(20));
    };

    let (stdout, stdout_truncated) = stdout_handle
        .join()
        .map_err(|_| "team worker stdout reader panicked".to_string())?;
    let (stderr, stderr_truncated) = stderr_handle
        .join()
        .map_err(|_| "team worker stderr reader panicked".to_string())?;
    let exit_code = exit_status.code().unwrap_or(-1);
    let signal = exit_signal_name(&exit_status);
    let status = if killed_by_timeout {
        "killed"
    } else if exit_code == 0 {
        "completed"
    } else {
        "failed"
    };

    Ok(WorkerOutcome {
        worker_id: worker.worker_id,
        persona: worker.persona,
        status,
        exit_code,
        signal,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        duration_ms: started.elapsed().as_millis(),
    })
}

fn read_capped_stream<R: Read>(mut reader: R) -> (String, bool) {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        let remaining = WORKER_STREAM_CAP_BYTES.saturating_sub(bytes.len());
        if remaining == 0 {
            truncated = true;
            continue;
        }
        let take = read.min(remaining);
        bytes.extend_from_slice(&buffer[..take]);
        if take < read {
            truncated = true;
        }
    }
    (String::from_utf8_lossy(&bytes).into_owned(), truncated)
}

fn resolve_dispatch_status(outcomes: &[WorkerOutcome]) -> &'static str {
    if outcomes.iter().all(|outcome| outcome.status == "completed") {
        "accepted"
    } else if outcomes.iter().any(|outcome| outcome.status == "killed") {
        "killed"
    } else {
        "errored"
    }
}

fn print_worker_output(outcome: &WorkerOutcome) {
    for line in outcome.stdout.lines().filter(|line| !line.is_empty()) {
        println!("[{}] {line}", outcome.worker_id);
    }
    for line in outcome.stderr.lines().filter(|line| !line.is_empty()) {
        eprintln!("[{}!] {line}", outcome.worker_id);
    }
    if outcome.stdout_truncated {
        println!(
            "[{}] stdout truncated at {WORKER_STREAM_CAP_BYTES} bytes",
            outcome.worker_id
        );
    }
    if outcome.stderr_truncated {
        eprintln!(
            "[{}!] stderr truncated at {WORKER_STREAM_CAP_BYTES} bytes",
            outcome.worker_id
        );
    }
    if let Some(signal) = outcome.signal.as_deref() {
        eprintln!("[{}!] signal={signal}", outcome.worker_id);
    }
}

fn current_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn is_pid_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        if pid > i32::MAX as i64 {
            return false;
        }
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let result = unsafe { kill(pid as i32, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn exit_signal_name(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| match signal {
            1 => "SIGHUP".to_string(),
            2 => "SIGINT".to_string(),
            3 => "SIGQUIT".to_string(),
            6 => "SIGABRT".to_string(),
            9 => "SIGKILL".to_string(),
            15 => "SIGTERM".to_string(),
            value => format!("SIG{value}"),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

struct InspectArgs {
    run_id: String,
    verify: bool,
}

fn parse_inspect_args(args: &[OsString]) -> Result<InspectArgs, String> {
    let mut run_id = None;
    let mut verify = false;
    for arg in args {
        let value = arg.to_str().ok_or_else(team_usage)?;
        match value {
            "--verify" => verify = true,
            "--help" | "-h" => return Err(team_usage()),
            value if value.starts_with('-') => return Err(team_usage()),
            value => {
                if run_id.is_some() {
                    return Err(team_usage());
                }
                run_id = Some(value.to_string());
            }
        }
    }
    Ok(InspectArgs {
        run_id: run_id.ok_or_else(team_usage)?,
        verify,
    })
}

fn binary_on_path(binary: &str) -> bool {
    let Some(path_env) = env::var_os("PATH") else {
        return false;
    };
    for dir in env::split_paths(&path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in binary_candidates(&dir, binary) {
            if is_executable_file(&candidate) {
                return true;
            }
        }
    }
    false
}

fn binary_candidates(dir: &std::path::Path, binary: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let exts = env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
        exts.split(';')
            .map(|ext| dir.join(format!("{binary}{ext}")))
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![dir.join(binary)]
    }
}

fn is_executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
