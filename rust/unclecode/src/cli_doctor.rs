use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use unclecode_core::doctor_report::doctor_report;

pub fn top_level_doctor_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("doctor") | Some("/doctor") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/doctor ") => Some(
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

pub fn run_top_level_doctor_command(args: &[OsString]) -> Result<u8, String> {
    let mut verbose = false;
    let mut json = false;
    for arg in args {
        match arg.to_str() {
            Some("--help") | Some("-h") | Some("help") => {
                print_doctor_help();
                return Ok(0);
            }
            Some("--verbose") => verbose = true,
            Some("--json") => {
                json = true;
                verbose = true;
            }
            _ => return Err(doctor_usage()),
        }
    }
    let cwd = env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    let report = doctor_report(&cwd, home_dir.as_deref(), verbose, |key| env::var(key).ok())?;
    if json {
        println!("{}", report.json);
    } else {
        println!("{}", report.lines.join("\n"));
    }
    Ok(0)
}

fn print_doctor_help() {
    println!("{}", doctor_usage());
    println!();
    println!("Rust-native doctor options:");
    println!("  unclecode doctor");
    println!("  unclecode doctor --verbose");
    println!("  unclecode doctor --json");
}

fn doctor_usage() -> String {
    "Usage: unclecode doctor [--verbose] [--json]".to_string()
}
