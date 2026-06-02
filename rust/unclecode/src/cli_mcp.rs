use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use unclecode_core::mcp_host::{
    format_mcp_host_inspect, format_mcp_host_registry, load_mcp_host_registry,
};

pub fn top_level_mcp_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("mcp") | Some("/mcp") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/mcp ") => Some(
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

pub fn run_top_level_mcp_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_mcp_help();
            Ok(0)
        }
        Some("list") => {
            let cwd = resolve_workspace_dir()?;
            let user_home = env::var_os("HOME").map(PathBuf::from);
            let entries = load_mcp_host_registry(&cwd, user_home.as_deref())?;
            println!("{}", format_mcp_host_registry(&entries));
            Ok(0)
        }
        Some("inspect") => {
            let server_name = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or_else(mcp_usage)?;
            if args.len() > 2 {
                return Err(mcp_usage());
            }
            let cwd = resolve_workspace_dir()?;
            let user_home = env::var_os("HOME").map(PathBuf::from);
            let entries = load_mcp_host_registry(&cwd, user_home.as_deref())?;
            println!("{}", format_mcp_host_inspect(&entries, server_name));
            Ok(0)
        }
        _ => Err(mcp_usage()),
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

fn print_mcp_help() {
    println!("{}", mcp_usage());
    println!();
    println!("Rust-native MCP commands:");
    println!("  unclecode mcp list");
    println!("  unclecode mcp inspect <server>");
}

fn mcp_usage() -> String {
    "Usage: unclecode mcp <list|inspect> [server]".to_string()
}
