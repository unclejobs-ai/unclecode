use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use unclecode_core::config_explain::config_explain_text;

pub fn top_level_config_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("config") | Some("/config") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/config ") => Some(
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

pub fn run_top_level_config_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_config_help();
            Ok(0)
        }
        Some("explain") => {
            let mut mode = None;
            let mut model = None;
            let mut index = 1;
            while index < args.len() {
                match args[index].to_str() {
                    Some("--mode") => {
                        mode = args.get(index + 1).and_then(|arg| arg.to_str());
                        if mode.is_none() {
                            return Err(
                                "Usage: unclecode config explain [--mode <mode>] [--model <model>]"
                                    .to_string(),
                            );
                        }
                        index += 2;
                    }
                    Some("--model") => {
                        model = args.get(index + 1).and_then(|arg| arg.to_str());
                        if model.is_none() {
                            return Err(
                                "Usage: unclecode config explain [--mode <mode>] [--model <model>]"
                                    .to_string(),
                            );
                        }
                        index += 2;
                    }
                    Some("--help") | Some("-h") => {
                        println!("{}", config_explain_usage());
                        return Ok(0);
                    }
                    _ => return Err(config_explain_usage()),
                }
            }
            let cwd = env::current_dir()
                .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
            let user_home = env::var_os("HOME").map(PathBuf::from);
            println!(
                "{}",
                config_explain_text(&cwd, user_home.as_deref(), mode, model)?
            );
            Ok(0)
        }
        _ => Err(config_usage()),
    }
}

fn print_config_help() {
    println!("{}", config_usage());
    println!();
    println!("Rust-native config commands:");
    println!("  unclecode config explain [--mode <mode>] [--model <model>]");
}

fn config_usage() -> String {
    "Usage: unclecode config <explain>".to_string()
}

fn config_explain_usage() -> String {
    "Usage: unclecode config explain [--mode <mode>] [--model <model>]".to_string()
}
