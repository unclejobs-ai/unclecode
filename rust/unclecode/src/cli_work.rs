use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};

use unclecode_core::app_reasoning::resolve_app_reasoning_effort;
use unclecode_core::auth::{resolve_openai_auth, resolve_openai_auth_status};
use unclecode_core::context_guidance::build_workspace_guidance_json;
use unclecode_core::context_skills::discover_skill_metadata_json;
use unclecode_core::model_registry::{detect_provider_for_model, provider_label};
use unclecode_core::provider_prompt::build_provider_system_prompt;
use unclecode_core::queue::WorkQueue;
use unclecode_core::team_mini_loop::{run_provider_mini_loop, ProviderMiniLoopRequest};
use unclecode_core::ux_text::format_work_shell_error_message;

const OPENAI_DEFAULT_MODEL: &str = "gpt-5.5";
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const GEMINI_DEFAULT_MODEL: &str = "gemini-2.5-pro";
const GEMINI_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const WORK_PROMPT_STEP_LIMIT: usize = 16;
const WORK_PROMPT_COST_LIMIT_USD: f64 = 2.0;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedWorkArgs {
    cwd: PathBuf,
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    session_id: Option<String>,
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
}

pub fn top_level_work_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("work") | Some("tui") => Some(args[1..].to_vec()),
        _ => None,
    }
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
                    if matches!(next, "anthropic" | "gemini" | "openai") {
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
    })
}

fn run_work_prompt_turn(
    config: &WorkRuntimeConfig,
    prompt: &str,
) -> Result<unclecode_core::team_mini_loop::ProviderMiniLoopResult, String> {
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
    println!(
        "Commands: /help /status /auth status /model [id] /provider <name> /tools /queue [text] /drain /exit"
    );
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
    if line == "/auth" || line == "/auth status" {
        print_auth_status();
        return Ok(true);
    }
    if line.starts_with("/auth ") {
        println!("Auth changes run from the shell. Type /exit, then run `unclecode auth login --device` or `unclecode auth logout`.");
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
        println!("Auth login/logout changes run from the shell after /exit.");
    } else if line != "unclecode" {
        println!("To run that shell command, leave this session first with /exit.");
    }
    true
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
        return Ok(provider.to_string());
    }
    let provider = env_value("LLM_PROVIDER", cwd).unwrap_or_else(|| "openai".to_string());
    match provider.as_str() {
        "anthropic" | "gemini" | "openai" => Ok(provider),
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
        _ => ("OPENAI_MODEL", OPENAI_DEFAULT_MODEL),
    };
    env_value(env_name, cwd).unwrap_or_else(|| default_model.to_string())
}

fn resolve_api_key(provider: &str, cwd: &Path) -> Result<String, String> {
    match provider {
        "openai" => {
            let auth = resolve_openai_auth(|key| env_value(key, cwd));
            if auth.status == "ok" {
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
        other => Err(format!("Unsupported runtime provider: {other}")),
    }
}

fn resolve_base_url(provider: &str, cwd: &Path) -> String {
    let (env_name, default_url) = match provider {
        "anthropic" => ("ANTHROPIC_BASE_URL", ANTHROPIC_DEFAULT_BASE_URL),
        "gemini" => ("GEMINI_BASE_URL", GEMINI_DEFAULT_BASE_URL),
        _ => ("OPENAI_BASE_URL", OPENAI_DEFAULT_BASE_URL),
    };
    env_value(env_name, cwd)
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_url.to_string())
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
    println!("  --provider  Choose openai, anthropic, or gemini");
    println!("  --model  Override the model for the chosen provider");
    println!("  --reasoning  Override reasoning effort: low, medium, high");
    println!("  --session-id  Resume a persisted work session id");
    println!();
    println!("Prompt and interactive line modes are Rust-native.");
}

fn print_interactive_help() {
    println!("/help             Show commands");
    println!("/status           Show provider, model, cwd, queue, and shell-tool state");
    println!("/auth status      Show OpenAI auth source, type, expiry, and scope state");
    println!("/model            Show current model");
    println!("/model <id>       Switch model and auto-route provider by model family");
    println!("/provider <name>  Switch provider: openai, anthropic, or gemini");
    println!("/tools            Show available local tools");
    println!("/queue [text]     Show queue or enqueue a follow-up");
    println!("/drain            Run queued follow-ups in order");
    println!("/exit             Leave the Rust work session");
}

fn print_status(config: &WorkRuntimeConfig, queue: &WorkQueue) {
    println!("provider: {}", config.provider);
    println!("model: {}", config.model);
    println!(
        "reasoning: {}",
        config.reasoning_effort.as_deref().unwrap_or("unsupported")
    );
    println!("cwd: {}", config.cwd.display());
    println!(
        "auth: {}",
        if config.api_key.is_some() {
            "ready"
        } else {
            "missing"
        }
    );
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

fn print_auth_status() {
    let status = resolve_openai_auth_status(|key| env_value(key, Path::new(".")));
    println!("auth provider: openai");
    println!("auth source: {}", status.active_source);
    println!("auth type: {}", status.auth_type);
    println!(
        "organization: {}",
        status.organization_id.unwrap_or_else(|| "none".to_string())
    );
    println!(
        "project: {}",
        status.project_id.unwrap_or_else(|| "none".to_string())
    );
    println!(
        "expiresAt: {}",
        status.expires_at.as_deref().unwrap_or("none")
    );
    println!("expired: {}", if status.is_expired { "yes" } else { "no" });
    if status.expires_at.as_deref() == Some("insufficient-scope") {
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
    fn shell_reentry_is_not_treated_as_a_model_prompt() {
        assert!(handle_shell_reentry("unclecode"));
        assert!(handle_shell_reentry("unclecode auth status"));
        assert!(!handle_shell_reentry("inspect unclecode binary"));
        assert!(!handle_shell_reentry("/status"));
    }
}
