use std::env;
use std::ffi::OsString;
use std::path::Path;

use unclecode_core::harness::{
    apply_harness_preset, harness_preset_ids, inspect_harness_status, HarnessStatus,
};

pub fn top_level_harness_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("harness") | Some("/harness") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/harness ") => Some(
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

pub fn run_top_level_harness_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_harness_help();
            Ok(0)
        }
        Some("status") => {
            print_harness_status(&current_dir()?);
            Ok(0)
        }
        Some("explain") => {
            print_harness_explain();
            Ok(0)
        }
        Some("apply") => {
            let preset = args.get(1).and_then(|arg| arg.to_str()).ok_or_else(|| {
                format!(
                    "Usage: unclecode harness apply <{}>",
                    harness_preset_ids().join("|")
                )
            })?;
            apply_harness_preset_for_cli(&current_dir()?, preset)
        }
        _ => Err(harness_usage()),
    }
}

fn print_harness_help() {
    println!("{}", harness_usage());
    println!();
    println!("Rust-native harness commands:");
    println!("  unclecode harness status");
    println!("  unclecode harness explain");
    println!(
        "  unclecode harness apply <{}>",
        harness_preset_ids().join("|")
    );
}

fn harness_usage() -> String {
    "Usage: unclecode harness <status|explain|apply>".to_string()
}

fn current_dir() -> Result<std::path::PathBuf, String> {
    env::current_dir().map_err(|error| format!("Failed to resolve current directory: {error}"))
}

fn apply_harness_preset_for_cli(cwd: &Path, preset: &str) -> Result<u8, String> {
    if !harness_preset_ids().contains(&preset) {
        return Err(format!(
            "Unknown preset: {preset}. Available: {}",
            harness_preset_ids().join(", ")
        ));
    }

    let status = inspect_harness_status(cwd);
    if !status.exists {
        return Err(format!(
            "No .codex/config.toml found at {}\nRun 'unclecode harness init' or create the config first.",
            status.config_path.display()
        ));
    }

    for change in apply_harness_preset(cwd, preset)? {
        if change.changed {
            println!("  {} -> \"{}\"", change.key, change.value);
        } else {
            println!("  {} not found in config (skipped)", change.key);
        }
    }

    println!();
    println!(
        "{preset} preset applied to {}",
        status.config_path.display()
    );
    println!();
    println!("Current status:");
    print_harness_status(cwd);
    Ok(0)
}

fn print_harness_status(cwd: &Path) {
    for line in format_harness_status_lines(&inspect_harness_status(cwd)) {
        println!("{line}");
    }
}

fn format_harness_status_lines(status: &HarnessStatus) -> Vec<String> {
    if !status.exists {
        return vec![
            format!("Config: {} (not found)", status.config_path.display()),
            String::new(),
            "No .codex/config.toml found.".to_string(),
            "Run 'unclecode harness init' or create the config manually.".to_string(),
        ];
    }

    vec![
        format!("Config: {}", status.config_path.display()),
        String::new(),
        format!("Model: {}", status.model.as_deref().unwrap_or("default")),
        format!(
            "Reasoning: {}",
            status.reasoning_effort.as_deref().unwrap_or("default")
        ),
        format!(
            "Approvals: {}",
            status.approvals.as_deref().unwrap_or("user")
        ),
        format!(
            "Trust: {}",
            status.trust_level.as_deref().unwrap_or("default")
        ),
        format!(
            "Multi-agent: {}",
            if status.multi_agent {
                "enabled"
            } else {
                "disabled"
            }
        ),
        format!(
            "MCP servers: {}",
            if status.mcp_servers.is_empty() {
                "none".to_string()
            } else {
                status.mcp_servers.join(", ")
            }
        ),
        format!(
            "Status line: {}",
            if status.status_line.is_empty() {
                "default".to_string()
            } else {
                status.status_line.join(", ")
            }
        ),
    ]
}

fn print_harness_explain() {
    for line in [
        "UncleCode harness controls how the agent runtime behaves.",
        "",
        "Profiles:",
        "  yolo    - Low friction. Medium reasoning, auto-approve local workspace tools.",
        "            Remote/MCP/background tasks still require approval.",
        "  default - Balanced. User approval for all tool execution.",
        "",
        "The harness reads from .codex/config.toml and applies overlays",
        "for model, reasoning effort, approval policy, and TUI status line.",
        "",
        "Commands:",
        "  unclecode harness status  - Show current harness configuration",
        "  unclecode harness apply yolo - Apply the YOLO low-friction preset",
        "  unclecode harness explain - Show this help",
    ] {
        println!("{line}");
    }
}
