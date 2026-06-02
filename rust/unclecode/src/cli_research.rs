use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use unclecode_core::research_run::research_run_report;
use unclecode_core::research_status::research_status_report;

pub fn top_level_research_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("research") | Some("/research") => {
            if is_native_research_surface(&args[1..]) {
                Some(args[1..].to_vec())
            } else {
                None
            }
        }
        Some(command) if command.starts_with("/research ") => {
            let parsed = command
                .split_whitespace()
                .skip(1)
                .map(OsString::from)
                .chain(args[1..].iter().cloned())
                .collect::<Vec<_>>();
            if is_native_research_surface(&parsed) {
                Some(parsed)
            } else {
                None
            }
        }
        _ => None,
    }
}

pub fn run_top_level_research_command(args: &[OsString]) -> Result<u8, String> {
    let mut json = false;
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_research_help();
            return Ok(0);
        }
        Some("status") => {}
        Some("run") => return run_research_run_command(&args[1..]),
        _ => return Err(research_usage()),
    }
    for arg in &args[1..] {
        match arg.to_str() {
            Some("--json") => json = true,
            Some("--help") | Some("-h") => {
                println!("{}", research_status_usage());
                return Ok(0);
            }
            _ => return Err(research_status_usage()),
        }
    }

    let cwd = resolve_workspace_dir()?;
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    let report = research_status_report(&cwd, home_dir.as_deref(), |key| env::var(key).ok())?;
    if json {
        println!("{}", report.json);
    } else {
        println!("{}", report.lines.join("\n"));
    }
    Ok(0)
}

fn is_native_research_surface(args: &[OsString]) -> bool {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => true,
        Some("status") => true,
        Some("run") => true,
        _ => false,
    }
}

fn resolve_workspace_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("UNCLECODE_WORK_CWD") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    env::current_dir().map_err(|error| format!("Failed to resolve current directory: {error}"))
}

fn run_research_run_command(args: &[OsString]) -> Result<u8, String> {
    let mut json = false;
    let mut prompt_parts = Vec::new();
    for arg in args {
        match arg.to_str() {
            Some("--json") => json = true,
            Some("--help") | Some("-h") => {
                println!("{}", research_run_usage());
                return Ok(0);
            }
            Some(value) if value.starts_with("--") => return Err(research_run_usage()),
            Some(value) => prompt_parts.push(value.to_string()),
            None => return Err("Research prompt must be valid UTF-8.".to_string()),
        }
    }
    let prompt = prompt_parts.join(" ");
    if prompt.trim().is_empty() {
        return Err(research_run_usage());
    }

    let cwd = resolve_workspace_dir()?;
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    let report = research_run_report(&cwd, home_dir.as_deref(), |key| env::var(key).ok(), &prompt)?;
    if json {
        println!("{}", report.json);
    } else {
        println!("{}", report.lines.join("\n"));
    }
    Ok(0)
}

fn print_research_help() {
    println!("{}", research_usage());
    println!();
    println!("Rust-native research commands:");
    println!("  unclecode research status");
    println!("  unclecode research status --json");
    println!("  unclecode research run <prompt...> [--json]");
}

fn research_usage() -> String {
    "Usage: unclecode research <status|run>".to_string()
}

fn research_status_usage() -> String {
    "Usage: unclecode research status [--json]".to_string()
}

fn research_run_usage() -> String {
    "Usage: unclecode research run <prompt...> [--json]".to_string()
}
