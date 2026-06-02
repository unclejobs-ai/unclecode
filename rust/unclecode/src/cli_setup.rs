use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use unclecode_core::setup_report::{session_store_root_from_env, setup_report_text};

pub fn top_level_setup_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("setup") => Some(args[1..].to_vec()),
        _ => None,
    }
}

pub fn run_top_level_setup_command(args: &[OsString]) -> Result<u8, String> {
    if let Some(arg) = args.first().and_then(|arg| arg.to_str()) {
        match arg {
            "--help" | "-h" | "help" => {
                print_setup_help();
                return Ok(0);
            }
            _ => return Err(setup_usage()),
        }
    }
    let cwd = env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    let session_root = session_store_root_from_env(|key| env::var(key).ok(), home_dir);
    println!(
        "{}",
        setup_report_text(&cwd, &session_root, |key| env::var(key).ok())?
    );
    Ok(0)
}

fn print_setup_help() {
    println!("{}", setup_usage());
    println!();
    println!("Rust-native setup command:");
    println!("  unclecode setup");
}

fn setup_usage() -> String {
    "Usage: unclecode setup".to_string()
}
