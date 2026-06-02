use std::env;
use std::ffi::OsString;

use unclecode_core::mode::{
    current_workspace_root, is_mode_profile_id, mode_profile, persist_project_mode,
    resolve_mode_status, MODE_PROFILE_IDS,
};

pub fn top_level_mode_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("mode") | Some("/mode") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/mode ") => Some(
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

pub fn run_top_level_mode_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("--help") | Some("-h") | Some("help") => {
            print_mode_help();
            Ok(0)
        }
        None | Some("status") => {
            print_mode_status()?;
            Ok(0)
        }
        Some("set") => {
            let mode = args.get(1).and_then(|arg| arg.to_str()).ok_or_else(|| {
                format!("Usage: unclecode mode set <{}>", MODE_PROFILE_IDS.join("|"))
            })?;
            if !is_mode_profile_id(mode) {
                return Err(format!("Unsupported mode: {mode}"));
            }
            let workspace_root = current_workspace_root()?;
            let config_path = persist_project_mode(&workspace_root, mode)?;
            let profile = mode_profile(mode);
            println!("Active mode saved: {}", profile.id);
            println!("Label: {}", profile.label);
            println!("Config path: {}", config_path.display());
            Ok(0)
        }
        _ => Err(mode_usage()),
    }
}

fn print_mode_status() -> Result<(), String> {
    let workspace_root = current_workspace_root()?;
    let status = resolve_mode_status(&workspace_root, |key| env::var(key).ok());
    println!("Active mode: {}", status.profile.id);
    println!("Label: {}", status.profile.label);
    println!("Source: {}", status.source_label);
    println!("Editing: {}", status.profile.editing);
    println!("Search depth: {}", status.profile.search_depth);
    println!("Background tasks: {}", status.profile.background_tasks);
    println!("Explanation style: {}", status.profile.explanation_style);
    Ok(())
}

fn print_mode_help() {
    println!("{}", mode_usage());
    println!();
    println!("Rust-native mode commands:");
    println!("  unclecode mode status");
    println!("  unclecode mode set <{}>", MODE_PROFILE_IDS.join("|"));
}

fn mode_usage() -> String {
    "Usage: unclecode mode <status|set>".to_string()
}
