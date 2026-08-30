use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use unclecode_core::app_reasoning::resolve_app_reasoning_effort;
use unclecode_core::auth::{
    openai_auth_supports_api_calls, resolve_openai_auth, resolve_openai_auth_status,
};
use unclecode_core::context_guidance::build_workspace_guidance_json;
use unclecode_core::context_skills::discover_skill_metadata_json;
use unclecode_core::model_registry::{detect_provider_for_model, provider_label};
use unclecode_core::provider_prompt::build_provider_system_prompt;
use unclecode_core::queue::WorkQueue;
use unclecode_core::research_run::research_run_report;
use unclecode_core::research_status::research_status_report;
use unclecode_core::team_mini_loop::{run_provider_mini_loop, ProviderMiniLoopRequest};
use unclecode_core::ux_text::format_work_shell_error_message;

const OPENAI_DEFAULT_MODEL: &str = "gpt-5.5";
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEEPSEEK_DEFAULT_MODEL: &str = "deepseek-chat";
const DEEPSEEK_DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const GEMINI_DEFAULT_MODEL: &str = "gemini-2.5-pro";
const GEMINI_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const WORK_PROMPT_STEP_LIMIT: usize = 16;
const WORK_PROMPT_COST_LIMIT_USD: f64 = 2.0;
const WORK_PI_TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedWorkArgs {
    cwd: PathBuf,
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    session_id: Option<String>,
    engine: Option<String>,
    prompt: Option<String>,
    show_help: bool,
    show_tools: bool,
}

#[derive(Debug, Clone)]
struct WorkRuntimeConfig {
    cwd: PathBuf,
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: String,
    system_prompt: String,
    reasoning_effort: Option<String>,
    allow_run_shell: bool,
    engine: String,
}

pub fn top_level_work_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("work") | Some("tui") => Some(args[1..].to_vec()),
        _ => None,
    }
}

/// Reports whether post-command `work` args describe an interactive,
/// promptless session. Parser-backed so option values (`--engine pi`) are
/// never mistaken for a prompt; `--help`/`--tools` stay Rust-native, and any
/// positional prompt means a one-shot turn.
pub fn work_args_are_interactive_promptless(args: &[OsString]) -> bool {
    let parsed = parse_work_args(args, PathBuf::from("."));
    !parsed.show_help
        && !parsed.show_tools
        && parsed
            .prompt
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
}

pub fn work_args_have_prompt(args: &[OsString]) -> bool {
    parse_work_args(args, PathBuf::from("."))
        .prompt
        .is_some_and(|value| !value.trim().is_empty())
}

pub fn work_args_request_metadata(args: &[OsString]) -> bool {
    let parsed = parse_work_args(args, PathBuf::from("."));
    parsed.show_help || parsed.show_tools
}

pub fn work_args_request_native_engine(args: &[OsString]) -> bool {
    parse_work_args(args, PathBuf::from("."))
        .engine
        .as_deref()
        == Some("native")
}

pub fn run_top_level_work_command(args: &[OsString]) -> Result<u8, String> {
    let parsed = parse_work_args(
        args,
        env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    );
    if parsed.show_help {
        print_work_help();
        return Ok(0);
    }
    if parsed.show_tools {
        print_tools();
        return Ok(0);
    }

    let mut config = load_runtime_config(&parsed)?;
    let Some(prompt) = parsed
        .prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return run_interactive_work(&mut config, parsed.session_id.as_deref());
    };

    let result = run_work_prompt_turn(&config, prompt)
        .map_err(|error| format_work_shell_error_message(&error))?;

    if result.status == "submitted" {
        println!("{}", result.submission);
        return Ok(0);
    }

    eprintln!("work prompt did not complete: {}", result.status);
    if !result.submission.trim().is_empty() {
        eprintln!("{}", result.submission);
    }
    Ok(1)
}

fn parse_work_args(args: &[OsString], caller_cwd: PathBuf) -> ParsedWorkArgs {
    let string_args = args
        .iter()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let mut cwd = normalize_path(&caller_cwd);
    let mut provider = None;
    let mut model = None;
    let mut reasoning = None;
    let mut session_id = None;
    let mut engine = None;
    let mut prompt_parts = Vec::new();
    let mut show_help = false;
    let mut show_tools = false;

    let mut index = 0;
    while index < string_args.len() {
        let arg = string_args[index].as_str();
        match arg {
            "--help" | "-h" => show_help = true,
            "--tools" => show_tools = true,
            "--cwd" => {
                let next = string_args
                    .get(index + 1)
                    .map(String::as_str)
                    .unwrap_or(".");
                cwd = lexical_resolve(&cwd, next);
                index += 1;
            }
            "--provider" => {
                if let Some(next) = string_args.get(index + 1).map(String::as_str) {
                    if matches!(next, "anthropic" | "gemini" | "openai" | "deepseek") {
                        provider = Some(next.to_string());
                    }
                }
                index += 1;
            }
            "--model" => {
                model = string_args.get(index + 1).cloned();
                index += 1;
            }
            "--reasoning" => {
                if let Some(next) = string_args.get(index + 1).map(String::as_str) {
                    if matches!(next, "low" | "medium" | "high") {
                        reasoning = Some(next.to_string());
                    }
                }
                index += 1;
            }
            "--session-id" => {
                session_id = string_args.get(index + 1).cloned();
                index += 1;
            }
            "--engine" => {
                if let Some(next) = string_args.get(index + 1).map(String::as_str) {
                    if matches!(next, "native" | "pi") {
                        engine = Some(next.to_string());
                    }
                }
                index += 1;
            }
            _ => prompt_parts.push(arg.to_string()),
        }
        index += 1;
    }

    ParsedWorkArgs {
        cwd,
        provider,
        model,
        reasoning,
        session_id,
        engine,
        prompt: (!prompt_parts.is_empty()).then(|| prompt_parts.join(" ")),
        show_help,
        show_tools,
    }
}

fn load_runtime_config(parsed: &ParsedWorkArgs) -> Result<WorkRuntimeConfig, String> {
    let provider = resolve_provider(parsed.provider.as_deref(), &parsed.cwd)?;
    let model = resolve_model(&provider, parsed.model.as_deref(), &parsed.cwd);
    let api_key = resolve_api_key(&provider, &parsed.cwd).ok();
    let base_url = resolve_base_url(&provider, &parsed.cwd);
    let system_prompt =
        build_provider_system_prompt(load_system_prompt_appendix(&parsed.cwd).as_deref());
    let reasoning_effort = resolve_reasoning(&provider, &model, parsed.reasoning.as_deref());
    let allow_run_shell =
        env_value("UNCLECODE_ALLOW_RUN_SHELL", &parsed.cwd).as_deref() == Some("1");
    Ok(WorkRuntimeConfig {
        cwd: parsed.cwd.clone(),
        provider,
        model,
        api_key,
        base_url,
        system_prompt,
        reasoning_effort,
        allow_run_shell,
        engine: parsed.engine.clone().unwrap_or_else(default_work_engine),
    })
}

fn run_work_prompt_turn(
    config: &WorkRuntimeConfig,
    prompt: &str,
) -> Result<unclecode_core::team_mini_loop::ProviderMiniLoopResult, String> {
    if config.engine == "pi" {
        return run_pi_bridge_turn(config, prompt);
    }
    run_provider_mini_loop(ProviderMiniLoopRequest {
        runtime: config.provider.clone(),
        api_key: config
            .api_key
            .clone()
            .map(Ok)
            .unwrap_or_else(|| resolve_api_key(&config.provider, &config.cwd))?,
        model: config.model.clone(),
        base_url: config.base_url.clone(),
        system_prompt: config.system_prompt.clone(),
        prompt: prompt.to_string(),
        cwd: config.cwd.clone(),
        reasoning_effort: config.reasoning_effort.clone(),
        step_limit: WORK_PROMPT_STEP_LIMIT,
        cost_limit_usd: WORK_PROMPT_COST_LIMIT_USD,
        allowed_tools: work_allowed_tools(),
        allow_run_shell: config.allow_run_shell,
        checkpoint: None,
    })
}

fn run_interactive_work(
    config: &mut WorkRuntimeConfig,
    session_id: Option<&str>,
) -> Result<u8, String> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut history = Vec::<(String, String)>::new();
    let mut queue = WorkQueue::new();

    print_interactive_banner(config, session_id);
    loop {
        print!("unclecode> ");
        io::stdout()
            .flush()
            .map_err(|error| format!("Failed to flush stdout: {error}"))?;
        let Some(line) = lines.next() else {
            println!();
            break;
        };
        let line = line.map_err(|error| format!("Failed to read stdin: {error}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if matches!(trimmed, "/exit" | "/quit") {
            break;
        }
        if handle_interactive_command(trimmed, config, &mut queue, &mut history)? {
            continue;
        }
        if handle_shell_reentry(trimmed) {
            continue;
        }
        run_interactive_turn(config, &mut history, trimmed)?;
    }
    Ok(0)
}

fn print_interactive_banner(config: &WorkRuntimeConfig, session_id: Option<&str>) {
    println!("UncleCode · {}", provider_label(&config.provider));
    println!(
        "{} · {} · {}",
        config.model,
        config
            .reasoning_effort
            .as_deref()
            .unwrap_or("reasoning unsupported"),
        config.cwd.display()
    );
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        println!("session · {session_id}");
    }
    println!("Commands: /help /status /context /research status /auth status /model [id] /tools /queue [text] /drain /exit");
}

fn handle_interactive_command(
    line: &str,
    config: &mut WorkRuntimeConfig,
    queue: &mut WorkQueue,
    history: &mut Vec<(String, String)>,
) -> Result<bool, String> {
    if line == "/help" {
        print_interactive_help();
        return Ok(true);
    }
    if line == "/tools" {
        print_tools();
        return Ok(true);
    }
    if line == "/status" {
        print_status(config, queue);
        return Ok(true);
    }
    if line == "/context" || line == "/research status" {
        print_research_status(&config.cwd)?;
        return Ok(true);
    }
    if let Some(rest) = line.strip_prefix("/research ") {
        let prompt = rest.trim();
        if prompt.is_empty() {
            print_research_status(&config.cwd)?;
        } else {
            print_research_run(&config.cwd, prompt)?;
        }
        return Ok(true);
    }
    if line == "/auth" || line == "/auth status" {
        print_auth_status();
        return Ok(true);
    }
    if line.starts_with("/auth ") {
        println!("Auth changes run from the shell. Type /exit, then run `OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser`, `unclecode auth login --api-key-stdin`, or `unclecode auth logout`.");
        return Ok(true);
    }
    if let Some(rest) = line.strip_prefix("/model") {
        handle_model_command(rest.trim(), config)?;
        return Ok(true);
    }
    if let Some(rest) = line.strip_prefix("/provider") {
        handle_provider_command(rest.trim(), config)?;
        return Ok(true);
    }
    if let Some(rest) = line.strip_prefix("/queue") {
        handle_queue_command(rest.trim(), queue);
        return Ok(true);
    }
    if line == "/drain" {
        drain_queue(config, queue, history)?;
        return Ok(true);
    }
    if line.starts_with('/') {
        println!("Unknown command: {line}");
        return Ok(true);
    }
    Ok(false)
}

fn handle_shell_reentry(line: &str) -> bool {
    if line != "unclecode" && !line.starts_with("unclecode ") {
        return false;
    }
    println!("Already inside UncleCode. Type /help for commands or /exit to return to your shell.");
    if line == "unclecode auth status" {
        println!("Use /auth status here.");
    } else if line.starts_with("unclecode auth ") {
        println!("Auth login/logout changes run from the shell after /exit. For API-ready OAuth, use OPENAI_OAUTH_CLIENT_ID with `unclecode auth login --browser`; API key login also works.");
    } else if line != "unclecode" {
        println!("To run that shell command, leave this session first with /exit.");
    }
    true
}

fn resolve_pi_turn_entry(cwd: &Path) -> Result<PathBuf, String> {
    if let Some(explicit) = env::var_os("UNCLECODE_PI_TURN_ENTRY") {
        let candidate = PathBuf::from(explicit);
        if candidate.exists() {
            return Ok(candidate);
        }
        return Err(format!(
            "UNCLECODE_PI_TURN_ENTRY points at a missing file: {}",
            candidate.display()
        ));
    }
    let mut roots = Vec::new();
    if let Ok(exe) = env::current_exe() {
        roots.extend(exe.ancestors().map(Path::to_path_buf));
    }
    roots.extend(cwd.ancestors().map(Path::to_path_buf));
    for root in roots {
        let candidate = root.join("apps/unclecode-cli/dist/index.js");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(
        "could not locate apps/unclecode-cli/dist/index.js for the pi engine; run `npm run build` or set UNCLECODE_PI_TURN_ENTRY"
            .to_string(),
    )
}

fn run_pi_bridge_turn(
    config: &WorkRuntimeConfig,
    prompt: &str,
) -> Result<unclecode_core::team_mini_loop::ProviderMiniLoopResult, String> {
    let entry = resolve_pi_turn_entry(&config.cwd)?;
    run_pi_bridge_turn_with_entry(config, prompt, &entry)
}

fn run_pi_bridge_turn_with_entry(
    config: &WorkRuntimeConfig,
    prompt: &str,
    entry: &Path,
) -> Result<unclecode_core::team_mini_loop::ProviderMiniLoopResult, String> {
    run_pi_bridge_turn_with_entry_timeout(config, prompt, entry, WORK_PI_TURN_TIMEOUT)
}

fn run_pi_bridge_turn_with_entry_timeout(
    config: &WorkRuntimeConfig,
    prompt: &str,
    entry: &Path,
    timeout: std::time::Duration,
) -> Result<unclecode_core::team_mini_loop::ProviderMiniLoopResult, String> {
    let request = serde_json::json!({
        "provider": config.provider,
        "model": config.model,
        "prompt": prompt,
        "cwd": config.cwd,
        "apiKey": config.api_key,
        "baseUrl": config.base_url,
        "systemPrompt": config.system_prompt,
        "reasoningEffort": config.reasoning_effort,
        "allowedTools": work_pi_allowed_tools(),
        "allowRunShell": config.allow_run_shell,
        "stepLimit": WORK_PROMPT_STEP_LIMIT,
        "costLimitUsd": WORK_PROMPT_COST_LIMIT_USD,
    });
    let mut command = Command::new("node");
    command
        .arg(entry)
        .arg("work-pi-turn")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn the pi turn helper: {error}"))?;
    let child_pid = child.id();
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pi turn helper stdin was not piped".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pi turn helper stdout was not piped".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "pi turn helper stderr was not piped".to_string())?;
    let request_body = request.to_string();
    let writer = std::thread::spawn(move || {
        stdin
            .write_all(request_body.as_bytes())
            .map_err(|error| format!("failed to send the pi turn request: {error}"))
    });
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .map_err(|error| format!("failed to read pi turn stdout: {error}"))?;
        Ok::<Vec<u8>, String>(bytes)
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .read_to_end(&mut bytes)
            .map_err(|error| format!("failed to read pi turn stderr: {error}"))?;
        Ok::<Vec<u8>, String>(bytes)
    });

    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    let mut termination_warning = None;
    let status = 'wait: loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to wait for the pi turn helper: {error}"))?
        {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            timed_out = true;
            if let Err(error) = terminate_pi_turn_process_tree(child_pid) {
                termination_warning = Some(error);
            }
            let _ = child.kill();
            let kill_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                if let Some(status) = child.try_wait().map_err(|error| {
                    format!("failed to reap the timed-out pi turn helper: {error}")
                })? {
                    break 'wait status;
                }
                if std::time::Instant::now() >= kill_deadline {
                    return Err("pi turn helper did not exit after forced termination".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        } else {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    };
    if !timed_out {
        let _ = terminate_pi_turn_process_tree(child_pid);
    }
    let writer_result = writer
        .join()
        .map_err(|_| "pi turn helper stdin writer panicked".to_string())?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| "pi turn helper stdout reader panicked".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "pi turn helper stderr reader panicked".to_string())??;
    if timed_out {
        let cleanup_warning = termination_warning
            .map(|warning| format!("; process-tree cleanup warning: {warning}"))
            .unwrap_or_default();
        return Err(format!(
            "pi turn helper timed out after {}ms{cleanup_warning}",
            timeout.as_millis()
        ));
    }
    writer_result?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("pi turn helper exited unsuccessfully: {status}")
        } else {
            format!("pi turn helper exited unsuccessfully: {status}: {detail}")
        });
    }
    let body = String::from_utf8_lossy(&stdout);
    let parsed: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|error| format!("pi turn helper returned invalid JSON: {error}"))?;
    match parsed.get("status").and_then(serde_json::Value::as_str) {
        Some("ok") => {
            let steps = parsed
                .get("steps")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| {
                    "pi turn helper response is missing a valid steps count".to_string()
                })?;
            let cost_usd = parsed
                .get("costUsd")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| "pi turn helper response is missing a valid costUsd".to_string())?;
            Ok(unclecode_core::team_mini_loop::ProviderMiniLoopResult {
                status: "submitted".to_string(),
                submission: parsed
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                steps,
                cost_usd,
            })
        }
        Some("error") => Err(parsed
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("pi turn helper failed without an error message")
            .to_string()),
        _ => Err(format!(
            "pi turn helper returned an unexpected payload: {}",
            body.trim()
        )),
    }
}

fn terminate_pi_turn_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err(format!("invalid pi turn helper PID: {pid}"));
        }
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        let group = -(pid as i32);
        let term_result = unsafe { kill(group, 15) };
        let term_error = std::io::Error::last_os_error();
        if term_result != 0 && term_error.raw_os_error() != Some(3) {
            return Err(format!(
                "failed to terminate pi turn helper process group {pid}: {term_error}"
            ));
        }
        let grace_deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < grace_deadline {
            let alive = unsafe { kill(group, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(1);
            if !alive {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let kill_result = unsafe { kill(group, 9) };
        let kill_error = std::io::Error::last_os_error();
        if kill_result == 0 || kill_error.raw_os_error() == Some(3) {
            return Ok(());
        }
        if kill_error.raw_os_error() == Some(1) {
            let leader_kill_result = unsafe { kill(pid as i32, 9) };
            let leader_kill_error = std::io::Error::last_os_error();
            if leader_kill_result == 0 || leader_kill_error.raw_os_error() == Some(3) {
                return Ok(());
            }
            return Err(format!(
                "failed to kill pi turn helper process group {pid}: {kill_error}; \
                 failed to kill its leader: {leader_kill_error}"
            ));
        }
        Err(format!(
            "failed to kill pi turn helper process group {pid}: {kill_error}"
        ))
    }
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| {
                format!("failed to start taskkill for pi turn helper {pid}: {error}")
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "taskkill failed for pi turn helper {pid}: {status}"
            ))
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err("pi turn helper timeout termination is unsupported on this platform".to_string())
    }
}

fn run_interactive_turn(
    config: &WorkRuntimeConfig,
    history: &mut Vec<(String, String)>,
    line: &str,
) -> Result<(), String> {
    println!("Thinking...");
    let prompt = contextual_prompt(history, line);
    match run_work_prompt_turn(config, &prompt) {
        Ok(result) if result.status == "submitted" => {
            println!("{}", result.submission);
            history.push(("user".to_string(), line.to_string()));
            history.push(("assistant".to_string(), result.submission));
            cap_history(history);
        }
        Ok(result) => {
            println!("work prompt did not complete: {}", result.status);
            if !result.submission.trim().is_empty() {
                println!("{}", result.submission);
            }
        }
        Err(error) => println!("Error: {}", format_work_shell_error_message(&error)),
    }
    Ok(())
}

fn contextual_prompt(history: &[(String, String)], line: &str) -> String {
    if history.is_empty() {
        return line.to_string();
    }
    let transcript = history
        .iter()
        .map(|(role, text)| format!("{role}: {text}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("Conversation so far:\n{transcript}\n\nuser: {line}")
}

fn cap_history(history: &mut Vec<(String, String)>) {
    let max_entries = 8;
    if history.len() > max_entries {
        history.drain(0..history.len() - max_entries);
    }
}

fn handle_model_command(rest: &str, config: &mut WorkRuntimeConfig) -> Result<(), String> {
    if rest.is_empty() {
        println!("model: {}", config.model);
        println!("provider: {}", config.provider);
        return Ok(());
    }
    let provider = detect_provider_for_model(rest).to_string();
    switch_runtime(config, &provider, Some(rest))?;
    println!("model: {}", config.model);
    println!("provider: {}", config.provider);
    Ok(())
}

fn handle_provider_command(rest: &str, config: &mut WorkRuntimeConfig) -> Result<(), String> {
    if rest.is_empty() {
        println!("provider: {}", config.provider);
        return Ok(());
    }
    switch_runtime(config, rest, None)?;
    println!("provider: {}", config.provider);
    println!("model: {}", config.model);
    Ok(())
}

fn switch_runtime(
    config: &mut WorkRuntimeConfig,
    provider: &str,
    model: Option<&str>,
) -> Result<(), String> {
    let provider = resolve_provider(Some(provider), &config.cwd)?;
    let model = resolve_model(&provider, model, &config.cwd);
    config.api_key = resolve_api_key(&provider, &config.cwd).ok();
    config.base_url = resolve_base_url(&provider, &config.cwd);
    config.reasoning_effort = resolve_reasoning(&provider, &model, None);
    config.provider = provider;
    config.model = model;
    Ok(())
}

fn handle_queue_command(rest: &str, queue: &mut WorkQueue) {
    if rest.is_empty() {
        let items = queue.snapshot();
        if items.is_empty() {
            println!("queue: empty");
            return;
        }
        for item in items {
            println!("#{} {}", item.id, item.line);
        }
        return;
    }
    match queue.push(rest) {
        Some(item) => println!("queued #{} {}", item.id, item.line),
        None => println!("queue: empty input ignored"),
    }
}

fn drain_queue(
    config: &WorkRuntimeConfig,
    queue: &mut WorkQueue,
    history: &mut Vec<(String, String)>,
) -> Result<(), String> {
    if queue.is_empty() {
        println!("queue: empty");
        return Ok(());
    }
    while let Some(item) = queue.pop() {
        println!("drain #{} {}", item.id, item.line);
        run_interactive_turn(config, history, &item.line)?;
    }
    Ok(())
}

fn resolve_provider(flag: Option<&str>, cwd: &Path) -> Result<String, String> {
    if let Some(provider) = flag {
        return match provider {
            "anthropic" | "gemini" | "openai" | "deepseek" => Ok(provider.to_string()),
            other => Err(format!("Unsupported runtime provider: {other}")),
        };
    }
    let provider = env_value("LLM_PROVIDER", cwd).unwrap_or_else(|| "openai".to_string());
    match provider.as_str() {
        "anthropic" | "gemini" | "openai" | "deepseek" => Ok(provider),
        other => Err(format!("Unsupported runtime provider: {other}")),
    }
}

fn resolve_model(provider: &str, flag: Option<&str>, cwd: &Path) -> String {
    if let Some(model) = flag.map(str::trim).filter(|value| !value.is_empty()) {
        return model.to_string();
    }
    let (env_name, default_model) = match provider {
        "anthropic" => ("ANTHROPIC_MODEL", ANTHROPIC_DEFAULT_MODEL),
        "gemini" => ("GEMINI_MODEL", GEMINI_DEFAULT_MODEL),
        "deepseek" => ("DEEPSEEK_MODEL", DEEPSEEK_DEFAULT_MODEL),
        _ => ("OPENAI_MODEL", OPENAI_DEFAULT_MODEL),
    };
    env_value(env_name, cwd).unwrap_or_else(|| default_model.to_string())
}

fn resolve_api_key(provider: &str, cwd: &Path) -> Result<String, String> {
    match provider {
        "openai" => {
            let auth = resolve_openai_auth(|key| env_value(key, cwd));
            if auth.status == "ok" {
                if auth.auth_type == "oauth" && auth.runtime.as_deref() == Some("codex") {
                    return Err("OpenAI OAuth is present but missing model.request scope for API calls. Use unclecode auth login --api-key-stdin, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID.".to_string());
                }
                return auth
                    .bearer_token
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "OpenAI auth resolved without a bearer token.".to_string());
            }
            Err(match auth.reason.as_deref() {
                Some("auth-refresh-required") => "OpenAI auth needs refresh. Run unclecode auth login --browser, unclecode auth login --api-key-stdin, or provide OPENAI_AUTH_TOKEN / OPENAI_API_KEY.".to_string(),
                Some("auth-insufficient-scope") => "OpenAI OAuth is present but missing model.request scope for API calls. Use unclecode auth login --api-key-stdin, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID.".to_string(),
                _ => "OPENAI_API_KEY or a valid UncleCode OpenAI login is required when LLM_PROVIDER=openai".to_string(),
            })
        }
        "anthropic" => env_value("ANTHROPIC_API_KEY", cwd)
            .ok_or_else(|| "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic".to_string()),
        "gemini" => env_value("GEMINI_API_KEY", cwd)
            .ok_or_else(|| "GEMINI_API_KEY is required when LLM_PROVIDER=gemini".to_string()),
        "deepseek" => env_value("DEEPSEEK_API_KEY", cwd)
            .ok_or_else(|| "DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek".to_string()),
        other => Err(format!("Unsupported runtime provider: {other}")),
    }
}

fn resolve_base_url(provider: &str, cwd: &Path) -> String {
    let (env_names, default_url): (&[&str], &str) = match provider {
        "anthropic" => (
            &["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL"],
            ANTHROPIC_DEFAULT_BASE_URL,
        ),
        "gemini" => (
            &["GEMINI_BASE_URL", "GEMINI_API_BASE_URL"],
            GEMINI_DEFAULT_BASE_URL,
        ),
        "deepseek" => (&["DEEPSEEK_BASE_URL"], DEEPSEEK_DEFAULT_BASE_URL),
        _ => (
            &["OPENAI_BASE_URL", "OPENAI_API_BASE_URL"],
            OPENAI_DEFAULT_BASE_URL,
        ),
    };
    let resolved = env_value_any(env_names, cwd)
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_url.to_string());
    if provider == "deepseek" {
        resolved
            .strip_suffix("/chat/completions")
            .unwrap_or(&resolved)
            .trim_end_matches('/')
            .to_string()
    } else {
        resolved
    }
}

fn resolve_reasoning(provider: &str, model: &str, override_effort: Option<&str>) -> Option<String> {
    resolve_app_reasoning_effort(provider, model, "default", override_effort)
}

fn load_system_prompt_appendix(cwd: &Path) -> Option<String> {
    let home = env_value("HOME", cwd).map(PathBuf::from);
    let home = home.as_deref().unwrap_or_else(|| Path::new("."));
    let skills = discover_skill_metadata_json(cwd, home).unwrap_or_else(|_| "[]".to_string());
    let raw = build_workspace_guidance_json(cwd, Some(home), &skills).ok()?;
    json_string_field(&raw, "systemPromptAppendix").filter(|value| !value.trim().is_empty())
}

fn env_value(key: &str, cwd: &Path) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| dotenv_value(key, Path::new(".")))
        .or_else(|| dotenv_value(key, cwd))
}

fn env_value_any(keys: &[&str], cwd: &Path) -> Option<String> {
    keys.iter().find_map(|key| env_value(key, cwd))
}

fn dotenv_value(key: &str, cwd: &Path) -> Option<String> {
    let raw = fs::read_to_string(cwd.join(".env")).ok()?;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once('=') else {
            continue;
        };
        if raw_key.trim() != key {
            continue;
        }
        return Some(trim_dotenv_quotes(raw_value.trim()).to_string())
            .filter(|value| !value.trim().is_empty());
    }
    None
}

fn trim_dotenv_quotes(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn json_string_field(raw: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\"");
    let start = raw.find(&marker)?;
    let after_key = raw[start + marker.len()..].trim_start();
    let after_colon = after_key.strip_prefix(':')?.trim_start();
    let quoted = after_colon.strip_prefix('"')?;
    let mut escaped = false;
    let mut value = String::new();
    for ch in quoted.chars() {
        if escaped {
            match ch {
                '"' => value.push('"'),
                '\\' => value.push('\\'),
                'n' => value.push('\n'),
                'r' => value.push('\r'),
                't' => value.push('\t'),
                other => value.push(other),
            }
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

fn lexical_resolve(base: &Path, input: &str) -> PathBuf {
    let input_path = Path::new(input);
    let combined = if input_path.is_absolute() {
        input_path.to_path_buf()
    } else {
        base.join(input_path)
    };
    normalize_path(&combined)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::Prefix(_) => out.push(component.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

fn print_work_help() {
    println!("UncleCode Work (repo-local)");
    println!();
    println!("Usage:");
    println!("  unclecode work");
    println!("  unclecode tui");
    println!("  unclecode work \"summarize this project\"");
    println!("  unclecode work --provider gemini --cwd E:\\\\repo --model gemini-2.5-flash");
    println!();
    println!("Flags:");
    println!("  --help   Show this help text");
    println!("  --tools  List available local tools");
    println!("  --cwd    Set the workspace root");
    println!("  --provider  Choose openai, anthropic, gemini, or deepseek");
    println!("  --model  Override the model for the chosen provider");
    println!("  --reasoning  Override reasoning effort: low, medium, high");
    println!("  --session-id  Resume a persisted work session id");
    println!(
        "  --engine  pi (default, pi-mono runtime + OAuth) or native (legacy provider runtime)"
    );
    println!();
    println!("Prompt and interactive line modes are Rust-native.");
}

fn print_interactive_help() {
    println!("/help             Show commands");
    println!("/status           Show provider, model, cwd, queue, and shell-tool state");
    println!("/context          Show latest Work context status");
    println!("/research status  Show latest Work context status");
    println!("/research <topic> Refresh local Work context for a topic");
    println!("/auth status      Show OpenAI auth source, type, expiry, and scope state");
    println!("/model            Show current model");
    println!("/model <id>       Switch model and auto-route provider by model family");
    println!("/provider <name>  Switch provider: openai, anthropic, gemini, or deepseek");
    println!("/tools            Show available local tools");
    println!("/queue [text]     Show queue or enqueue a follow-up");
    println!("/drain            Run queued follow-ups in order");
    println!("/exit             Leave the Rust work session");
}

fn resolve_default_work_engine(configured: Option<&str>) -> String {
    match configured {
        Some("native") => "native".to_string(),
        _ => "pi".to_string(),
    }
}

fn default_work_engine() -> String {
    resolve_default_work_engine(env::var("UNCLECODE_WORK_ENGINE").ok().as_deref())
}

fn codex_oauth_credentials_available(cwd: &Path) -> bool {
    let auth = resolve_openai_auth(|key| env_value(key, cwd));
    auth.auth_type == "oauth" && auth.runtime.as_deref() == Some("codex")
}

fn work_auth_label(config: &WorkRuntimeConfig) -> &'static str {
    if config.api_key.is_some() {
        return "ready";
    }
    if config.engine == "pi"
        && config.provider == "openai"
        && codex_oauth_credentials_available(&config.cwd)
    {
        return "ready (codex oauth)";
    }
    "missing"
}

fn print_status(config: &WorkRuntimeConfig, queue: &WorkQueue) {
    println!("provider: {}", config.provider);
    println!("model: {}", config.model);
    println!(
        "reasoning: {}",
        config.reasoning_effort.as_deref().unwrap_or("unsupported")
    );
    println!("cwd: {}", config.cwd.display());
    println!("engine: {}", config.engine);
    println!("auth: {}", work_auth_label(config));
    println!("queue: {}", queue.len());
    println!(
        "run_shell: {}",
        if config.allow_run_shell {
            "enabled"
        } else {
            "disabled"
        }
    );
}

fn print_research_status(cwd: &Path) -> Result<(), String> {
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    let report = research_status_report(cwd, home_dir.as_deref(), |key| env::var(key).ok())?;
    println!("{}", report.lines.join("\n"));
    Ok(())
}

fn print_research_run(cwd: &Path, prompt: &str) -> Result<(), String> {
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    let report = research_run_report(cwd, home_dir.as_deref(), |key| env::var(key).ok(), prompt)?;
    println!("{}", report.lines.join("\n"));
    Ok(())
}

fn print_auth_status() {
    let status = resolve_openai_auth_status(|key| env_value(key, Path::new(".")));
    println!("auth provider: openai");
    println!("auth source: {}", status.active_source);
    println!("auth type: {}", status.auth_type);
    println!(
        "organization: {}",
        status.organization_id.as_deref().unwrap_or("none")
    );
    println!(
        "project: {}",
        status.project_id.as_deref().unwrap_or("none")
    );
    println!("runtime: {}", status.runtime.as_deref().unwrap_or("none"));
    println!(
        "expiresAt: {}",
        status.expires_at.as_deref().unwrap_or("none")
    );
    println!(
        "api ready: {}",
        if openai_auth_supports_api_calls(&status) {
            "yes"
        } else {
            "no"
        }
    );
    if !openai_auth_supports_api_calls(&status) {
        println!("fix: /exit then run `unclecode auth login --api-key-stdin`, set OPENAI_API_KEY, or use browser OAuth with OPENAI_OAUTH_CLIENT_ID.");
    }
}

fn print_tools() {
    println!("Available Rust-native work tools:");
    println!("  list_files   List workspace files matching a glob pattern.");
    println!("  read_file    Read a UTF-8 text file from the workspace.");
    println!("  write_file   Write a UTF-8 text file inside the workspace.");
    println!("  search_text  Search workspace text with ripgrep.");
    println!("  run_shell    Run a shell command only when UNCLECODE_ALLOW_RUN_SHELL=1.");
    println!("Pi engine code-intelligence tools:");
    println!("  lsp_query    Query diagnostics, definitions, references, hover, or symbols.");
    println!("  lsp_rename   Rename a symbol across language-server references.");
    println!("  ast_search   Search source code by AST structure.");
    println!("  ast_rewrite  Preview or apply an AST-aware rewrite.");
}

fn work_allowed_tools() -> Vec<String> {
    vec![
        "list_files".to_string(),
        "read_file".to_string(),
        "write_file".to_string(),
        "search_text".to_string(),
        "run_shell".to_string(),
    ]
}

fn work_pi_allowed_tools() -> Vec<String> {
    let mut tools = work_allowed_tools();
    tools.extend([
        "lsp_query".to_string(),
        "lsp_rename".to_string(),
        "ast_search".to_string(),
        "ast_rewrite".to_string(),
    ]);
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_help_tools_and_prompt_to_native_work() {
        assert!(top_level_work_args(&[OsString::from("work"), OsString::from("--help")]).is_some());
        assert!(
            top_level_work_args(&[OsString::from("work"), OsString::from("--tools")]).is_some()
        );
        assert!(top_level_work_args(&[OsString::from("work"), OsString::from("hello")]).is_some());
        assert!(top_level_work_args(&[OsString::from("work")]).is_some());
        assert!(top_level_work_args(&[OsString::from("tui")]).is_some());
    }

    #[test]
    fn interactive_promptless_work_args_exclude_prompts_help_and_tools() {
        assert!(work_args_are_interactive_promptless(&[]));
        // Option values are consumed by the parser, never read as a prompt.
        assert!(work_args_are_interactive_promptless(&[
            OsString::from("--engine"),
            OsString::from("pi"),
            OsString::from("--model"),
            OsString::from("gpt-5.5"),
        ]));
        // Help and tools stay on the Rust-native path.
        assert!(!work_args_are_interactive_promptless(&[OsString::from(
            "--help"
        )]));
        assert!(!work_args_are_interactive_promptless(&[OsString::from(
            "-h"
        )]));
        assert!(!work_args_are_interactive_promptless(&[OsString::from(
            "--tools"
        )]));
        // Any positional means a one-shot turn.
        assert!(!work_args_are_interactive_promptless(&[
            OsString::from("--engine"),
            OsString::from("pi"),
            OsString::from("fix"),
            OsString::from("tests"),
        ]));
    }

    #[test]
    fn parses_prompt_mode_flags() {
        let parsed = parse_work_args(
            &[
                OsString::from("--cwd"),
                OsString::from("repo"),
                OsString::from("--provider"),
                OsString::from("openai"),
                OsString::from("--model"),
                OsString::from("gpt-5.5"),
                OsString::from("--reasoning"),
                OsString::from("high"),
                OsString::from("fix"),
                OsString::from("tests"),
            ],
            PathBuf::from("/tmp"),
        );

        assert_eq!(parsed.cwd, PathBuf::from("/tmp/repo"));
        assert_eq!(parsed.provider.as_deref(), Some("openai"));
        assert_eq!(parsed.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(parsed.reasoning.as_deref(), Some("high"));
        assert_eq!(parsed.prompt.as_deref(), Some("fix tests"));
    }

    #[test]
    fn parses_deepseek_provider_for_the_native_work_entrypoint() {
        let parsed = parse_work_args(
            &[
                OsString::from("--provider"),
                OsString::from("deepseek"),
                OsString::from("--model"),
                OsString::from("deepseek-reasoner"),
                OsString::from("review"),
            ],
            PathBuf::from("/tmp"),
        );

        assert_eq!(parsed.provider.as_deref(), Some("deepseek"));
        assert_eq!(parsed.model.as_deref(), Some("deepseek-reasoner"));
        assert_eq!(parsed.prompt.as_deref(), Some("review"));
    }

    #[test]
    fn shell_reentry_is_not_treated_as_a_model_prompt() {
        assert!(handle_shell_reentry("unclecode"));
        assert!(handle_shell_reentry("unclecode auth status"));
        assert!(!handle_shell_reentry("inspect unclecode binary"));
        assert!(!handle_shell_reentry("/status"));
    }

    #[test]
    fn default_engine_is_pi_unless_explicitly_overridden() {
        assert_eq!(resolve_default_work_engine(None), "pi");
        assert_eq!(resolve_default_work_engine(Some("native")), "native");
        assert_eq!(resolve_default_work_engine(Some("unknown")), "pi");
    }

    #[test]
    fn auth_label_reports_codex_oauth_only_for_the_pi_engine() {
        let mut config = WorkRuntimeConfig {
            cwd: PathBuf::from("/tmp"),
            provider: "openai".to_string(),
            model: "gpt-5.6-sol".to_string(),
            api_key: Some("sk-test".to_string()),
            base_url: String::new(),
            system_prompt: String::new(),
            reasoning_effort: None,
            allow_run_shell: false,
            engine: "native".to_string(),
        };
        assert_eq!(work_auth_label(&config), "ready");

        config.api_key = None;
        assert_eq!(work_auth_label(&config), "missing");
    }

    #[test]
    fn parses_engine_flag_and_ignores_unknown_values() {
        let parsed = parse_work_args(
            &[
                OsString::from("--engine"),
                OsString::from("pi"),
                OsString::from("hello"),
            ],
            PathBuf::from("/tmp"),
        );
        assert_eq!(parsed.engine.as_deref(), Some("pi"));
        assert_eq!(parsed.prompt.as_deref(), Some("hello"));

        let invalid = parse_work_args(
            &[
                OsString::from("--engine"),
                OsString::from("bogus"),
                OsString::from("hello"),
            ],
            PathBuf::from("/tmp"),
        );
        assert!(invalid.engine.is_none());
        assert_eq!(invalid.prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn pi_engine_turn_delegates_to_node_helper() {
        let dir = env::temp_dir().join(format!("unclecode-pi-turn-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("stub.mjs");
        fs::write(
            &stub,
            "let input=\"\";process.stdin.on(\"data\",(d)=>input+=d).on(\"end\",()=>{const r=JSON.parse(input);process.stdout.write(JSON.stringify({status:\"ok\",text:`PI:${r.prompt}@${r.model} base=${r.baseUrl} tools=${r.allowedTools.join(\",\")} shell=${r.allowRunShell} steps=${r.stepLimit} cost=${r.costLimitUsd}`,steps:2,costUsd:0.25}))});",
        )
        .unwrap();
        let config = WorkRuntimeConfig {
            cwd: dir.clone(),
            provider: "openai".to_string(),
            model: "test-model".to_string(),
            api_key: None,
            base_url: "http://127.0.0.1:43123/v1".to_string(),
            system_prompt: String::new(),
            reasoning_effort: None,
            allow_run_shell: false,
            engine: "pi".to_string(),
        };
        let result = run_pi_bridge_turn_with_entry(&config, "hello", &stub);
        fs::remove_dir_all(&dir).ok();

        let result = result.unwrap();
        assert_eq!(result.status, "submitted");
        assert_eq!(result.steps, 2);
        assert_eq!(result.cost_usd, 0.25);
        assert_eq!(
            result.submission,

            "PI:hello@test-model base=http://127.0.0.1:43123/v1 tools=list_files,read_file,write_file,search_text,run_shell,lsp_query,lsp_rename,ast_search,ast_rewrite shell=false steps=16 cost=2"
        );
    }
    #[cfg(unix)]
    #[test]
    fn pi_engine_turn_terminates_inherited_pipe_descendants_after_helper_exit() {
        let dir = env::temp_dir().join(format!(
            "unclecode-pi-turn-descendant-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("descendant.mjs");
        let descendant = dir.join("descendant-child.mjs");
        let outcome = dir.join("descendant-outcome.txt");
        fs::write(
            &descendant,
            r#"import {writeFileSync} from "node:fs";
const outcome = process.argv[2];
process.on("SIGTERM", () => {
  writeFileSync(outcome, "sigterm");
  process.exit(0);
});
process.send?.("ready");
setTimeout(() => {
  writeFileSync(outcome, "fallback");
  process.exit(0);
}, 10000);"#,
        )
        .unwrap();
        fs::write(
            &stub,
            r#"import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
let input = "";
process.stdin.on("data", (data) => input += data).on("end", () => {
  JSON.parse(input);
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./descendant-child.mjs", import.meta.url)),
    fileURLToPath(new URL("./descendant-outcome.txt", import.meta.url)),
  ], {stdio: ["ignore", "inherit", "inherit", "ipc"]});
  child.once("message", (message) => {
    if (message !== "ready") process.exit(2);
    child.disconnect();
    child.unref();
    process.stdout.write(JSON.stringify({status: "ok", text: "done", steps: 1, costUsd: 0}));
  });
});"#,
        )
        .unwrap();
        let config = WorkRuntimeConfig {
            cwd: dir.clone(),
            provider: "openai".to_string(),
            model: "test-model".to_string(),
            api_key: None,
            base_url: "http://127.0.0.1:43123/v1".to_string(),
            system_prompt: String::new(),
            reasoning_effort: None,
            allow_run_shell: false,
            engine: "pi".to_string(),
        };
        let result = run_pi_bridge_turn_with_entry_timeout(
            &config,
            "hello",
            &stub,
            std::time::Duration::from_secs(3),
        );
        let descendant_outcome = fs::read_to_string(&outcome);
        fs::remove_dir_all(&dir).ok();

        assert_eq!(result.unwrap().submission, "done");
        assert_eq!(
            descendant_outcome.unwrap(),
            "sigterm",
            "descendant should be terminated with the helper process group before its fallback"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pi_engine_turn_times_out_and_terminates_the_helper() {
        let dir = env::temp_dir().join(format!(
            "unclecode-pi-turn-timeout-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("stall.mjs");
        fs::write(
            &stub,
            "process.on(\"SIGTERM\",()=>{});process.stdin.resume();setInterval(()=>{},1000);",
        )
        .unwrap();
        let config = WorkRuntimeConfig {
            cwd: dir.clone(),
            provider: "openai".to_string(),
            model: "test-model".to_string(),
            api_key: None,
            base_url: "http://127.0.0.1:43123/v1".to_string(),
            system_prompt: String::new(),
            reasoning_effort: None,
            allow_run_shell: false,
            engine: "pi".to_string(),
        };
        let started = std::time::Instant::now();
        let result = run_pi_bridge_turn_with_entry_timeout(
            &config,
            "hello",
            &stub,
            std::time::Duration::from_millis(50),
        );
        fs::remove_dir_all(&dir).ok();

        let error = result.err().expect("stalled helper should time out");
        assert!(error.contains("timed out after 50ms"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
