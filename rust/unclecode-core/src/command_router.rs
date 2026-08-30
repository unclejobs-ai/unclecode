use serde_json::json;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashRouteKind {
    Plain,
    Matched,
    Dynamic,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashRoute {
    pub kind: SlashRouteKind,
    pub route: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuiltinSlashCommand {
    command: &'static str,
    route: &'static [&'static str],
    description: &'static str,
    aliases: &'static [&'static str],
}

const CLI_SLASH_COMMANDS: &[BuiltinSlashCommand] = &[
    BuiltinSlashCommand {
        command: "/help",
        route: &["--help"],
        description: "Show the shell help surface.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/work",
        route: &["work"],
        description: "Launch the real coding assistant entrypoint.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/doctor",
        route: &["doctor"],
        description: "Run the doctor surface.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/sessions",
        route: &["sessions"],
        description: "List resumable local sessions.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mode status",
        route: &["mode", "status"],
        description: "Show the active mode and its source.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mode set <mode>",
        route: &["mode", "set", "<mode>"],
        description: "Persist a mode in project config.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/research status",
        route: &["research", "status"],
        description: "Show Work context status.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mcp list",
        route: &["mcp", "list"],
        description: "List merged MCP servers.",
        aliases: &[],
    },
];

const WORK_SHELL_SLASH_COMMANDS: &[BuiltinSlashCommand] = &[
    BuiltinSlashCommand {
        command: "/doctor",
        route: &["doctor"],
        description: "Run the doctor surface.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/auth status",
        route: &["auth", "status"],
        description: "Show the current auth surface status.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/auth login",
        route: &["auth", "login"],
        description: "Start the best available OAuth login.",
        aliases: &["/auth browser", "/browser"],
    },
    BuiltinSlashCommand {
        command: "/auth browser",
        route: &["auth", "login", "--browser"],
        description: "Open browser auth login.",
        aliases: &["/auth login", "/browser"],
    },
    BuiltinSlashCommand {
        command: "/browser",
        route: &["auth", "login", "--browser"],
        description: "Open browser auth login.",
        aliases: &["/auth login", "/auth browser"],
    },
    BuiltinSlashCommand {
        command: "/auth logout",
        route: &["auth", "logout"],
        description: "Clear stored local auth credentials.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/reload",
        route: &["reload"],
        description: "Reload workspace guidance, skills, and extension context.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/cache",
        route: &["cache"],
        description: "Inspect prompt-cache reuse, writes, and token savings.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/agents",
        route: &["agents"],
        description: "Open agent run status and transcripts.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/jobs",
        route: &["jobs"],
        description: "Open background job status.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/todo",
        route: &["todo"],
        description: "Open current WorkGraph progress.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/model",
        route: &["model"],
        description: "Show the current model and available model picks.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/model list",
        route: &["model", "list"],
        description: "List available models and reasoning support.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mcp list",
        route: &["mcp", "list"],
        description: "List merged MCP servers.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mmbridge context",
        route: &["mmbridge", "context"],
        description: "Assemble mmbridge context for the current workspace via MCP.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mmbridge review",
        route: &["mmbridge", "review"],
        description: "Run an mmbridge review for the current workspace via MCP.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mmbridge gate",
        route: &["mmbridge", "gate"],
        description: "Check mmbridge review freshness for the current workspace via MCP.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mmbridge handoff",
        route: &["mmbridge", "handoff"],
        description: "Show the latest mmbridge handoff artifact via MCP.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mmbridge health",
        route: &["mmbridge", "health"],
        description: "Check mmbridge MCP handshake and tool availability.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mmbridge doctor",
        route: &["mmbridge", "doctor"],
        description: "Inspect mmbridge adapter/runtime readiness via MCP.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/mode status",
        route: &["mode", "status"],
        description: "Show the active mode and its source.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/research",
        route: &["research", "run"],
        description: "Refresh local Work context for the given topic or workspace question.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/research status",
        route: &["research", "status"],
        description: "Show the latest local Work context status.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/cancel",
        route: &["cancel"],
        description: "Interrupt the active turn and pause queued follow-ups.",
        aliases: &["/interrupt", "/stop"],
    },
    BuiltinSlashCommand {
        command: "/review",
        route: &["review"],
        description: "Inspect SCC Quality Engine gates, critic findings, and evidence without starting a model turn.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/review run",
        route: &["prompt", "review"],
        description: "Run a model-backed code review. Optional focus text may follow.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/code-review",
        route: &["prompt", "review"],
        description: "Run a model-backed code review. Optional focus text may follow.",
        aliases: &[],
    },
    BuiltinSlashCommand {
        command: "/commit",
        route: &["prompt", "commit"],
        description: "Draft a Lore-protocol commit message for the current changes.",
        aliases: &[],
    },
];

pub fn route_cli_slash_command(input: &str) -> SlashRoute {
    let normalized = normalize_slash_input(input);
    if !normalized.starts_with('/') {
        return SlashRoute {
            kind: SlashRouteKind::Plain,
            route: Vec::new(),
        };
    }

    if let Some(entry) = resolve_builtin(&normalized, CLI_SLASH_COMMANDS) {
        return SlashRoute {
            kind: SlashRouteKind::Matched,
            route: entry.route.iter().map(|item| item.to_string()).collect(),
        };
    }

    let tokens = normalized
        .trim_start_matches('/')
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    if tokens.first() == Some(&"mode") && tokens.get(1) == Some(&"set") {
        if let Some(mode) = tokens.get(2) {
            return SlashRoute {
                kind: SlashRouteKind::Dynamic,
                route: vec!["mode".to_string(), "set".to_string(), (*mode).to_string()],
            };
        }
    }

    SlashRoute {
        kind: SlashRouteKind::Fallback,
        route: tokens.iter().map(|token| (*token).to_string()).collect(),
    }
}

pub fn route_work_shell_slash_command(input: &str) -> SlashRoute {
    let normalized = normalize_slash_input(input);
    if !normalized.starts_with('/') {
        return SlashRoute {
            kind: SlashRouteKind::Plain,
            route: Vec::new(),
        };
    }

    if normalized.starts_with("/auth login --api-key ") {
        return SlashRoute {
            kind: SlashRouteKind::Dynamic,
            route: normalized
                .trim_start_matches('/')
                .split(' ')
                .map(str::to_string)
                .collect(),
        };
    }

    if normalized == "/auth login --browser" {
        return SlashRoute {
            kind: SlashRouteKind::Dynamic,
            route: vec![
                "auth".to_string(),
                "login".to_string(),
                "--browser".to_string(),
            ],
        };
    }

    if let Some(entry) = resolve_builtin(&normalized, WORK_SHELL_SLASH_COMMANDS) {
        return SlashRoute {
            kind: SlashRouteKind::Matched,
            route: entry.route.iter().map(|item| item.to_string()).collect(),
        };
    }

    for (command, kind) in [
        ("/review run", "review"),
        ("/code-review", "review"),
        // Compatibility: an argument-bearing legacy `/review <focus>` remains
        // executable, while the exact bare command is intercepted locally.
        ("/review", "review"),
        ("/commit", "commit"),
    ] {
        if let Some(route) = route_prompt_style(&normalized, command, kind) {
            return SlashRoute {
                kind: SlashRouteKind::Dynamic,
                route,
            };
        }
    }

    if let Some(route) = route_research(&normalized) {
        return SlashRoute {
            kind: SlashRouteKind::Dynamic,
            route,
        };
    }

    if let Some(route) = route_mode(&normalized) {
        return SlashRoute {
            kind: SlashRouteKind::Dynamic,
            route,
        };
    }

    SlashRoute {
        kind: SlashRouteKind::Fallback,
        route: Vec::new(),
    }
}

pub fn route_cli_slash_command_json(input: &str) -> Result<String, String> {
    slash_route_json(route_cli_slash_command(input))
}

pub fn route_work_shell_slash_command_json(input: &str) -> Result<String, String> {
    slash_route_json(route_work_shell_slash_command(input))
}

pub fn route_work_shell_submit_json(
    input: &str,
    is_busy: bool,
    composer_mode: &str,
    has_inline_command_runner: bool,
) -> Result<String, String> {
    let line = normalize_submit_line(input);
    let route = if line.is_empty() || is_busy {
        json!({ "kind": "ignore" })
    } else if composer_mode == "api-key-entry" {
        json!({ "kind": "secure-api-key-entry", "line": line })
    } else if let Some(command) = work_shell_builtin_submit_command(&line) {
        json!({ "kind": "builtin", "line": line, "command": command })
    } else {
        let slash_route = route_work_shell_slash_command(&line);
        if slash_route.route.first().map(String::as_str) == Some("prompt") {
            prompt_submit_route(&line, &slash_route.route)
        } else if !slash_route.route.is_empty() && has_inline_command_runner {
            json!({ "kind": "inline-command", "line": line, "slashCommand": slash_route.route })
        } else if let Some(local_command) = work_shell_local_submit_command(&line) {
            json!({ "kind": "local-command", "line": line, "localCommand": local_command })
        } else if is_work_shell_console_invalid_form(&line) {
            // Marked, not swallowed: TypeScript still gets its turn at
            // extension commands above, and only the terminal
            // nothing-matched leaf becomes a silent no-op.
            json!({ "kind": "chat", "line": line, "consoleInvalid": true })
        } else {
            json!({ "kind": "chat", "line": line })
        }
    };
    serde_json::to_string(&route).map_err(|error| error.to_string())
}

pub fn work_shell_local_submit_command_json(input: &str) -> Result<String, String> {
    let line = normalize_submit_line(input);
    match work_shell_local_submit_command(&line) {
        Some(command) => serde_json::to_string(&command).map_err(|error| error.to_string()),
        None => Ok("null".to_string()),
    }
}

pub fn work_shell_builtin_submit_command_json(input: &str) -> Result<String, String> {
    let line = normalize_submit_line(input);
    match work_shell_builtin_submit_command(&line) {
        Some(command) => serde_json::to_string(&command).map_err(|error| error.to_string()),
        None => Ok("null".to_string()),
    }
}

pub fn resolve_prompt_slash_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid prompt slash command JSON: {error}"))?;
    let route = input
        .get("slashCommand")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    match prompt_command_from_route(&route) {
        Some(command) => serde_json::to_string(&command).map_err(|error| error.to_string()),
        None => Ok("null".to_string()),
    }
}

pub fn resolve_work_shell_inline_action_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work-shell inline action JSON: {error}"))?;
    let args = input
        .get("args")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let normalized = args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = normalize_submit_line(&normalized);

    let result = match normalized.as_str() {
        "doctor" => Some(json!({ "actionId": "doctor" })),
        "auth status" => Some(json!({ "actionId": "auth-status" })),
        "auth login" | "auth login --browser" => Some(json!({ "actionId": "browser-login" })),
        "auth logout" => Some(json!({ "actionId": "auth-logout" })),
        "mcp list" => Some(json!({ "actionId": "mcp-list" })),
        "mode status" => Some(json!({ "actionId": "mode-status" })),
        _ if normalized.starts_with("mode set ") => Some(json!({
            "actionId": "mode-set",
            "prompt": args.iter().skip(2).map(String::as_str).collect::<Vec<_>>().join(" ").trim()
        })),
        "research status" => Some(json!({ "actionId": "research-status" })),
        "research run" => Some(json!({ "actionId": "new-research" })),
        "mmbridge context" => Some(json!({ "actionId": "mmbridge-context" })),
        "mmbridge review" => Some(json!({ "actionId": "mmbridge-review" })),
        "mmbridge gate" => Some(json!({ "actionId": "mmbridge-gate" })),
        "mmbridge handoff" => Some(json!({ "actionId": "mmbridge-handoff" })),
        "mmbridge health" => Some(json!({ "actionId": "mmbridge-health" })),
        "mmbridge doctor" => Some(json!({ "actionId": "mmbridge-doctor" })),
        _ if normalized.starts_with("auth login --api-key ") => {
            Some(json!({ "actionId": "api-key-login" }))
        }
        _ if normalized.starts_with("research run ") => Some(json!({
            "actionId": "new-research",
            "prompt": args.iter().skip(2).map(String::as_str).collect::<Vec<_>>().join(" ").trim()
        })),
        _ => None,
    };

    match result {
        Some(value) => serde_json::to_string(&value).map_err(|error| error.to_string()),
        None => Ok("null".to_string()),
    }
}

fn slash_route_json(routed: SlashRoute) -> Result<String, String> {
    serde_json::to_string(&json!({
        "kind": match routed.kind {
            SlashRouteKind::Plain => "plain",
            SlashRouteKind::Matched => "matched",
            SlashRouteKind::Dynamic => "dynamic",
            SlashRouteKind::Fallback => "fallback",
        },
        "route": routed.route,
    }))
    .map_err(|error| error.to_string())
}

fn normalize_submit_line(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The one place that decides which Agent Console tab a slash command opens.
/// The idle builtin route and the busy steer decision both read this map, so a
/// console command can never resolve to one tab while the shell is idle and to
/// a different one mid-turn.
pub fn work_shell_agent_console_tab(line: &str) -> Option<&'static str> {
    match line {
        "/agents" => Some("agents"),
        "/jobs" => Some("jobs"),
        "/todo" => Some("plan"),
        "/review" => Some("quality"),
        _ => None,
    }
}

/// A console-like line that cannot open a console: a form that would have
/// unique-prefix matched a console command before console commands became
/// exact-only (`/tod`, `/job`, `/agen`), or an exact console command carrying
/// arguments (`/agents extra`). Both mean the operator is mid-word or mistyped
/// an argument. There is nothing to run and nothing worth saying, so callers
/// fail them closed silently instead of echoing unknown-command guidance.
///
/// A prefix that could also mean a runnable command (`/a`, `/auth`) is not
/// covered — that keeps the ordinary unknown-command guidance intact. The
/// console tab map above stays the only place naming these commands.
pub fn is_work_shell_console_invalid_form(line: &str) -> bool {
    if work_shell_agent_console_tab(line).is_some() {
        return false;
    }
    let Some(token) = line.split_whitespace().next() else {
        return false;
    };
    if work_shell_agent_console_tab(token).is_some() {
        return true;
    }
    if token.strip_prefix('/').unwrap_or("").len() < 3 {
        return false;
    }
    let console_matches = WORK_SHELL_SLASH_COMMANDS
        .iter()
        .filter(|entry| work_shell_agent_console_tab(entry.command).is_some())
        .filter(|entry| entry.command.starts_with(token))
        .count();
    if console_matches != 1 {
        return false;
    }
    !WORK_SHELL_SLASH_COMMANDS
        .iter()
        .filter(|entry| work_shell_agent_console_tab(entry.command).is_none())
        .any(|entry| {
            entry.command.starts_with(token)
                || entry
                    .aliases
                    .iter()
                    .any(|alias| alias.starts_with(token))
        })
}

fn work_shell_builtin_submit_command(line: &str) -> Option<Value> {
    if let Some(tab) = work_shell_agent_console_tab(line) {
        return Some(json!({ "kind": "agent-console", "tab": tab }));
    }
    let queue_parts = line.split_whitespace().collect::<Vec<_>>();
    if let ["/queue", "remove", id] = queue_parts.as_slice() {
        if id.parse::<u64>().is_ok_and(|value| value > 0) {
            return Some(json!({ "kind": "queue-remove", "id": id.parse::<u64>().ok() }));
        }
    }
    if let ["/queue", "move", id, direction @ ("up" | "down")] = queue_parts.as_slice() {
        if id.parse::<u64>().is_ok_and(|value| value > 0) {
            return Some(
                json!({ "kind": "queue-move", "id": id.parse::<u64>().ok(), "direction": direction }),
            );
        }
    }
    match line {
        "/exit" => Some(json!({ "kind": "exit" })),
        "/clear" => Some(json!({ "kind": "clear" })),
        "/help" => Some(json!({ "kind": "help" })),
        "/context" | "/con" => Some(json!({ "kind": "context" })),
        "/cache" => Some(json!({ "kind": "cache" })),
        "/reload" => Some(json!({ "kind": "reload" })),
        "/status" => Some(json!({ "kind": "status" })),
        "/sessions" => Some(json!({ "kind": "sessions" })),
        "/tools" => Some(json!({ "kind": "tools" })),
        "/policy" => Some(json!({ "kind": "policy" })),
        "/skills" => Some(json!({ "kind": "skills" })),
        "/queue" => Some(json!({ "kind": "queue" })),
        "/queue clear" => Some(json!({ "kind": "queue-clear" })),
        "/queue resume" => Some(json!({ "kind": "queue-resume" })),
        "/cancel" | "/interrupt" | "/stop" => Some(json!({ "kind": "cancel" })),
        "/harness" => Some(json!({ "kind": "harness" })),
        "/auth key" => Some(json!({ "kind": "auth-key" })),
        "/verbose" | "/v" => Some(json!({ "kind": "trace-mode", "traceMode": "verbose" })),
        "/minimal" | "/m" => Some(json!({ "kind": "trace-mode", "traceMode": "minimal" })),
        _ if line.starts_with("/reasoning") => Some(json!({ "kind": "reasoning", "line": line })),
        _ if line.starts_with("/model") => Some(json!({ "kind": "model", "line": line })),
        _ if line.starts_with("/skill ") => {
            let skill_name = line["/skill ".len()..].trim();
            if skill_name.is_empty() {
                Some(json!({ "kind": "skill", "line": line }))
            } else {
                Some(json!({ "kind": "skill", "line": line, "skillName": skill_name }))
            }
        }
        _ => None,
    }
}

fn prompt_submit_route(line: &str, route: &[String]) -> Value {
    let prompt_command = prompt_command_from_route(route).unwrap_or_else(|| json!({ "kind": "" }));
    json!({
        "kind": "prompt-command",
        "line": line,
        "promptCommand": prompt_command,
    })
}

fn prompt_command_from_route(route: &[String]) -> Option<Value> {
    if route.first().map(String::as_str) != Some("prompt") {
        return None;
    }
    let kind = route.get(1).map(String::as_str)?;
    if kind != "review" && kind != "commit" {
        return None;
    }
    let focus = route.iter().skip(2).cloned().collect::<Vec<_>>().join(" ");
    Some(if focus.is_empty() {
        json!({ "kind": kind })
    } else {
        json!({ "kind": kind, "focus": focus })
    })
}

fn work_shell_local_submit_command(line: &str) -> Option<Value> {
    if line == "/memories" {
        return Some(json!({ "kind": "memories" }));
    }
    if !line.starts_with("/remember") {
        return None;
    }
    let parts = line.split_whitespace().collect::<Vec<_>>();
    let scope = match parts.get(1).copied() {
        Some("session") | Some("project") | Some("user") | Some("agent") => parts[1],
        _ => "project",
    };
    let summary_start = if scope == "project" { 1 } else { 2 };
    let summary = parts
        .iter()
        .skip(summary_start)
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    if summary.is_empty() {
        Some(json!({
            "kind": "remember",
            "usageError": "Usage: /remember [session|project|user|agent] <text>",
        }))
    } else {
        Some(json!({
            "kind": "remember",
            "scope": scope,
            "summary": summary,
        }))
    }
}

pub fn cli_slash_help_text() -> String {
    let lines = std::iter::once("Slash commands".to_string()).chain(
        CLI_SLASH_COMMANDS
            .iter()
            .map(|entry| format!("{} - {}", entry.command, entry.description)),
    );
    lines.collect::<Vec<_>>().join("\n")
}

pub fn extension_slash_commands_json(
    workspace_root: &str,
    user_home_dir: Option<&str>,
) -> Result<String, String> {
    let mut commands = Vec::new();
    for file_path in extension_manifest_files(workspace_root, user_home_dir) {
        let Some(manifest) = read_manifest_json(&file_path) else {
            continue;
        };
        let Some(manifest_commands) = manifest.get("commands").and_then(Value::as_array) else {
            continue;
        };
        for command in manifest_commands {
            let command_text = command
                .get("command")
                .and_then(Value::as_str)
                .map(normalize_slash_input)
                .unwrap_or_default();
            let route_to = command
                .get("routeTo")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !command_text.starts_with('/') || route_to.is_empty() {
                continue;
            }
            let description = command
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let aliases = command
                .get("aliases")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            commands.push(json!({
                "command": command_text,
                "routeTo": route_to,
                "metadata": {
                    "name": description,
                    "description": description,
                    "type": "local",
                    "source": "plugin",
                    "aliases": aliases,
                    "userInvocable": true
                }
            }));
        }
    }

    serde_json::to_string(&commands).map_err(|error| error.to_string())
}

pub fn extension_manifests_json(
    workspace_root: &str,
    user_home_dir: Option<&str>,
) -> Result<String, String> {
    let mut config_overlays = Vec::new();
    let mut summaries = Vec::new();

    for file_path in extension_manifest_files(workspace_root, user_home_dir) {
        let Some(manifest) = read_manifest_json(&file_path) else {
            continue;
        };
        let name = manifest
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                file_path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("extension")
                    .to_string()
            });

        if let Some(config) = manifest.get("config") {
            config_overlays.push(json!({
                "name": name,
                "config": config
            }));
        }

        let status_lines = manifest
            .get("status")
            .and_then(|status| status.get("lines"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        summaries.push(json!({
            "name": name,
            "sourcePath": file_path.to_string_lossy(),
            "statusLines": status_lines
        }));
    }

    serde_json::to_string(&json!({
        "configOverlays": config_overlays,
        "summaries": summaries
    }))
    .map_err(|error| error.to_string())
}

fn resolve_builtin(
    input: &str,
    commands: &'static [BuiltinSlashCommand],
) -> Option<&'static BuiltinSlashCommand> {
    let exact = commands
        .iter()
        .find(|entry| normalize_slash_input(entry.command) == input);
    if exact.is_some() {
        return exact;
    }

    let exact_alias = commands.iter().find(|entry| {
        entry
            .aliases
            .iter()
            .any(|alias| normalize_slash_input(alias) == input)
    });
    if exact_alias.is_some() {
        return exact_alias;
    }

    let slash_body = input.strip_prefix('/').unwrap_or(input);
    if slash_body.len() < 3 {
        return None;
    }

    // Console commands are exact-only. `/agent`, `/job`, and `/tod` would
    // otherwise prefix-resolve to `agents`/`jobs`/`todo` routes the CLI cannot
    // run, so they are dropped from the candidate pool here. The console tab
    // classifier stays the single owner of which commands those are — there is
    // no second list to drift.
    let matches = commands
        .iter()
        .filter(|entry| work_shell_agent_console_tab(entry.command).is_none())
        .filter(|entry| {
            normalize_slash_input(entry.command).starts_with(input)
                || entry
                    .aliases
                    .iter()
                    .any(|alias| normalize_slash_input(alias).starts_with(input))
        })
        .collect::<Vec<_>>();

    if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    }
}

fn route_prompt_style(normalized: &str, command: &str, kind: &str) -> Option<Vec<String>> {
    if normalized == command {
        return Some(vec!["prompt".to_string(), kind.to_string()]);
    }
    if !normalized.starts_with(&format!("{command} ")) {
        return None;
    }
    let mut route = vec!["prompt".to_string(), kind.to_string()];
    route.extend(
        normalized[command.len()..]
            .split_whitespace()
            .map(str::to_string),
    );
    Some(route)
}

fn route_research(normalized: &str) -> Option<Vec<String>> {
    if normalized == "/research" {
        return Some(vec!["research".to_string(), "run".to_string()]);
    }
    if !normalized.starts_with("/research ") {
        return None;
    }
    let tail = normalized["/research".len()..].trim();
    if tail.is_empty() {
        return Some(vec!["research".to_string(), "run".to_string()]);
    }
    if tail == "status" {
        return Some(vec!["research".to_string(), "status".to_string()]);
    }
    let mut route = vec!["research".to_string(), "run".to_string()];
    route.extend(tail.split_whitespace().map(str::to_string));
    Some(route)
}

fn route_mode(normalized: &str) -> Option<Vec<String>> {
    if normalized == "/mode" || normalized == "/mode status" {
        return Some(vec!["mode".to_string(), "status".to_string()]);
    }
    if !normalized.starts_with("/mode set ") {
        return None;
    }
    let next_mode = normalized["/mode set ".len()..].trim();
    if next_mode.is_empty() {
        return None;
    }
    Some(vec![
        "mode".to_string(),
        "set".to_string(),
        next_mode.to_string(),
    ])
}

fn normalize_slash_input(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extension_manifest_files(workspace_root: &str, user_home_dir: Option<&str>) -> Vec<PathBuf> {
    let user_home = user_home_dir
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from));
    let mut manifest_files =
        list_manifest_files(Path::new(workspace_root).join(".unclecode/extensions"));
    if let Some(home) = user_home {
        manifest_files.extend(list_manifest_files(home.join(".unclecode/extensions")));
    }
    manifest_files
}

fn list_manifest_files(root: PathBuf) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}

fn read_manifest_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn routes_builtin_cli_slash_commands() {
        assert_eq!(
            route_cli_slash_command("/help"),
            SlashRoute {
                kind: SlashRouteKind::Matched,
                route: vec!["--help".to_string()]
            }
        );
        assert_eq!(
            route_cli_slash_command("/ses"),
            SlashRoute {
                kind: SlashRouteKind::Matched,
                route: vec!["sessions".to_string()]
            }
        );
        assert_eq!(
            route_cli_slash_command("/mode set analyze"),
            SlashRoute {
                kind: SlashRouteKind::Dynamic,
                route: vec!["mode".to_string(), "set".to_string(), "analyze".to_string()]
            }
        );
    }

    #[test]
    fn preserves_fallback_and_plain_routes() {
        assert_eq!(
            route_cli_slash_command("summarize this"),
            SlashRoute {
                kind: SlashRouteKind::Plain,
                route: Vec::new()
            }
        );
        assert_eq!(
            route_cli_slash_command("/unknown arg"),
            SlashRoute {
                kind: SlashRouteKind::Fallback,
                route: vec!["unknown".to_string(), "arg".to_string()]
            }
        );
    }

    #[test]
    fn routes_work_shell_builtins_and_dynamic_commands() {
        assert_eq!(
            route_work_shell_slash_command("/auth status"),
            SlashRoute {
                kind: SlashRouteKind::Matched,
                route: vec!["auth".to_string(), "status".to_string()]
            }
        );
        assert_eq!(
            route_work_shell_slash_command("/browser"),
            SlashRoute {
                kind: SlashRouteKind::Matched,
                route: vec![
                    "auth".to_string(),
                    "login".to_string(),
                    "--browser".to_string()
                ]
            }
        );
        assert_eq!(
            route_work_shell_slash_command("/stop"),
            SlashRoute {
                kind: SlashRouteKind::Matched,
                route: vec!["cancel".to_string()]
            }
        );
        assert_eq!(
            route_work_shell_slash_command("/review auth flow"),
            SlashRoute {
                kind: SlashRouteKind::Dynamic,
                route: vec![
                    "prompt".to_string(),
                    "review".to_string(),
                    "auth".to_string(),
                    "flow".to_string()
                ]
            }
        );
        assert_eq!(
            route_work_shell_slash_command("/research current workspace"),
            SlashRoute {
                kind: SlashRouteKind::Dynamic,
                route: vec![
                    "research".to_string(),
                    "run".to_string(),
                    "current".to_string(),
                    "workspace".to_string()
                ]
            }
        );
        assert_eq!(
            route_work_shell_slash_command("/auth login --api-key sk-file-123"),
            SlashRoute {
                kind: SlashRouteKind::Dynamic,
                route: vec![
                    "auth".to_string(),
                    "login".to_string(),
                    "--api-key".to_string(),
                    "sk-file-123".to_string()
                ]
            }
        );
        assert_eq!(
            route_work_shell_slash_command("/auth login --browser"),
            SlashRoute {
                kind: SlashRouteKind::Dynamic,
                route: vec![
                    "auth".to_string(),
                    "login".to_string(),
                    "--browser".to_string()
                ]
            }
        );
    }

    #[test]
    fn leaves_unknown_work_shell_routes_for_extensions() {
        assert_eq!(
            route_work_shell_slash_command("/unknown"),
            SlashRoute {
                kind: SlashRouteKind::Fallback,
                route: Vec::new()
            }
        );
        assert_eq!(
            route_work_shell_slash_command("/aut"),
            SlashRoute {
                kind: SlashRouteKind::Fallback,
                route: Vec::new()
            }
        );
    }

    #[test]
    fn routes_work_shell_submit_contract() {
        assert_eq!(
            serde_json::from_str::<Value>(
                &route_work_shell_submit_json("   ", false, "default", true).unwrap()
            )
            .unwrap()["kind"],
            "ignore"
        );
        let secure = serde_json::from_str::<Value>(
            &route_work_shell_submit_json("secret", false, "api-key-entry", true).unwrap(),
        )
        .unwrap();
        assert_eq!(secure["kind"], "secure-api-key-entry");
        assert_eq!(secure["line"], "secret");

        let builtin = serde_json::from_str::<Value>(
            &route_work_shell_submit_json("/help", false, "default", true).unwrap(),
        )
        .unwrap();
        assert_eq!(builtin["kind"], "builtin");
        assert_eq!(builtin["command"]["kind"], "help");

        let prompt = serde_json::from_str::<Value>(
            &route_work_shell_submit_json("/review auth flow", false, "default", true).unwrap(),
        )
        .unwrap();
        assert_eq!(prompt["kind"], "prompt-command");
        assert_eq!(prompt["promptCommand"]["kind"], "review");
        assert_eq!(prompt["promptCommand"]["focus"], "auth flow");

        let inline = serde_json::from_str::<Value>(
            &route_work_shell_submit_json("/doctor", false, "default", true).unwrap(),
        )
        .unwrap();
        assert_eq!(inline["kind"], "inline-command");
        assert_eq!(inline["slashCommand"][0], "doctor");

        let local = serde_json::from_str::<Value>(
            &route_work_shell_submit_json("/remember session keep this", false, "default", false)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(local["kind"], "local-command");
        assert_eq!(local["localCommand"]["scope"], "session");
        assert_eq!(local["localCommand"]["summary"], "keep this");

        let chat = serde_json::from_str::<Value>(
            &route_work_shell_submit_json("finish cleanup", false, "default", false).unwrap(),
        )
        .unwrap();
        assert_eq!(chat["kind"], "chat");
        assert_eq!(chat["line"], "finish cleanup");
    }

    #[test]
    fn resolves_prompt_slash_command_contract() {
        assert_eq!(
            resolve_prompt_slash_command_json(
                r#"{"slashCommand":["prompt","review","auth","flow"]}"#
            )
            .unwrap(),
            r#"{"focus":"auth flow","kind":"review"}"#
        );
        assert_eq!(
            resolve_prompt_slash_command_json(r#"{"slashCommand":["prompt","commit"]}"#).unwrap(),
            r#"{"kind":"commit"}"#
        );
        assert_eq!(
            resolve_prompt_slash_command_json(r#"{"slashCommand":["doctor"]}"#).unwrap(),
            "null"
        );
    }

    #[test]
    fn resolves_work_shell_inline_action_contract() {
        let doctor = serde_json::from_str::<Value>(
            &resolve_work_shell_inline_action_json(r#"{"args":["doctor"]}"#).unwrap(),
        )
        .unwrap();
        assert_eq!(doctor["actionId"], "doctor");

        let api_key = serde_json::from_str::<Value>(
            &resolve_work_shell_inline_action_json(
                r#"{"args":["auth","login","--api-key","sk-test"]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(api_key["actionId"], "api-key-login");

        let mode_set = serde_json::from_str::<Value>(
            &resolve_work_shell_inline_action_json(r#"{"args":["mode","set","search"]}"#).unwrap(),
        )
        .unwrap();
        assert_eq!(mode_set["actionId"], "mode-set");
        assert_eq!(mode_set["prompt"], "search");

        let research = serde_json::from_str::<Value>(
            &resolve_work_shell_inline_action_json(
                r#"{"args":["research","run","summarize","current","workspace"]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(research["actionId"], "new-research");
        assert_eq!(research["prompt"], "summarize current workspace");

        assert_eq!(
            resolve_work_shell_inline_action_json(r#"{"args":["unknown"]}"#).unwrap(),
            "null"
        );
    }

    #[test]
    fn resolves_local_submit_commands_as_json() {
        assert_eq!(
            serde_json::from_str::<Value>(
                &work_shell_local_submit_command_json("/memories").unwrap()
            )
            .unwrap()["kind"],
            "memories"
        );

        let remember = serde_json::from_str::<Value>(
            &work_shell_local_submit_command_json("/remember agent keep routing in rust").unwrap(),
        )
        .unwrap();
        assert_eq!(remember["kind"], "remember");
        assert_eq!(remember["scope"], "agent");
        assert_eq!(remember["summary"], "keep routing in rust");

        let usage_error = serde_json::from_str::<Value>(
            &work_shell_local_submit_command_json("/remember").unwrap(),
        )
        .unwrap();
        assert_eq!(usage_error["kind"], "remember");
        assert!(usage_error["usageError"]
            .as_str()
            .unwrap()
            .starts_with("Usage:"));

        assert_eq!(
            serde_json::from_str::<Value>(
                &work_shell_local_submit_command_json("/unknown").unwrap()
            )
            .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn resolves_builtin_submit_commands_as_json() {
        assert_eq!(
            serde_json::from_str::<Value>(
                &work_shell_builtin_submit_command_json("/queue").unwrap()
            )
            .unwrap()["kind"],
            "queue"
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                &work_shell_builtin_submit_command_json("/queue clear").unwrap()
            )
            .unwrap()["kind"],
            "queue-clear"
        );
        let resume = serde_json::from_str::<Value>(
            &work_shell_builtin_submit_command_json("/queue resume").unwrap(),
        )
        .unwrap();
        assert_eq!(resume["kind"], "queue-resume");

        let remove = serde_json::from_str::<Value>(
            &work_shell_builtin_submit_command_json("/queue remove 42").unwrap(),
        )
        .unwrap();
        assert_eq!(remove["kind"], "queue-remove");
        assert_eq!(remove["id"], 42);

        let moved = serde_json::from_str::<Value>(
            &work_shell_builtin_submit_command_json("/queue move 42 up").unwrap(),
        )
        .unwrap();
        assert_eq!(moved["kind"], "queue-move");
        assert_eq!(moved["id"], 42);
        assert_eq!(moved["direction"], "up");
        assert_eq!(
            serde_json::from_str::<Value>(
                &work_shell_builtin_submit_command_json("/cancel").unwrap()
            )
            .unwrap()["kind"],
            "cancel"
        );

        let trace = serde_json::from_str::<Value>(
            &work_shell_builtin_submit_command_json("/verbose").unwrap(),
        )
        .unwrap();
        assert_eq!(trace["kind"], "trace-mode");
        assert_eq!(trace["traceMode"], "verbose");

        let model = serde_json::from_str::<Value>(
            &work_shell_builtin_submit_command_json("/model gpt-5.4").unwrap(),
        )
        .unwrap();
        assert_eq!(model["kind"], "model");
        assert_eq!(model["line"], "/model gpt-5.4");

        let skill = serde_json::from_str::<Value>(
            &work_shell_builtin_submit_command_json("/skill autopilot").unwrap(),
        )
        .unwrap();
        assert_eq!(skill["kind"], "skill");
        assert_eq!(skill["skillName"], "autopilot");

        assert_eq!(
            serde_json::from_str::<Value>(
                &work_shell_builtin_submit_command_json("/unknown").unwrap()
            )
            .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn routes_agent_console_commands_to_one_builtin_shape() {
        assert_eq!(
            work_shell_builtin_submit_command("/agents"),
            Some(json!({ "kind": "agent-console", "tab": "agents" })),
        );
        assert_eq!(
            work_shell_builtin_submit_command("/jobs"),
            Some(json!({ "kind": "agent-console", "tab": "jobs" })),
        );
        assert_eq!(
            work_shell_builtin_submit_command("/todo"),
            Some(json!({ "kind": "agent-console", "tab": "plan" })),
        );
        assert_eq!(
            work_shell_builtin_submit_command("/review"),
            Some(json!({ "kind": "agent-console", "tab": "quality" })),
        );
        assert_eq!(work_shell_agent_console_tab("/queue"), None);
        assert_eq!(work_shell_agent_console_tab("/agents extra"), None);
    }

    #[test]
    fn routes_agent_console_submits_as_builtins() {
        for (line, tab) in [
            ("/agents", "agents"),
            ("/jobs", "jobs"),
            ("/todo", "plan"),
            ("/review", "quality"),
        ] {
            let route = serde_json::from_str::<Value>(
                &route_work_shell_submit_json(line, false, "default", true).unwrap(),
            )
            .unwrap();
            assert_eq!(route["kind"], "builtin");
            assert_eq!(route["line"], line);
            assert_eq!(
                route["command"],
                json!({ "kind": "agent-console", "tab": tab })
            );
        }
    }

    #[test]
    fn lists_agent_console_commands_in_the_work_shell_slash_table() {
        for command in ["/agents", "/jobs", "/todo"] {
            assert_eq!(
                route_work_shell_slash_command(command),
                SlashRoute {
                    kind: SlashRouteKind::Matched,
                    route: vec![command.trim_start_matches('/').to_string()],
                }
            );
        }
    }

    #[test]
    fn keeps_agent_console_commands_out_of_prefix_routing() {
        for prefix in ["/agent", "/agen", "/job", "/tod"] {
            assert_eq!(
                route_work_shell_slash_command(prefix),
                SlashRoute {
                    kind: SlashRouteKind::Fallback,
                    route: Vec::new(),
                },
                "{prefix} must not prefix-resolve to a console route"
            );
            assert_eq!(work_shell_builtin_submit_command(prefix), None);
            assert_eq!(
                serde_json::from_str::<Value>(
                    &route_work_shell_submit_json(prefix, false, "default", true).unwrap(),
                )
                .unwrap()["kind"],
                "chat",
                "{prefix} must not become an inline command"
            );
        }
    }

    #[test]
    fn keeps_argument_bearing_console_lines_closed() {
        for line in ["/agents extra", "/jobs 1", "/todo now"] {
            assert_eq!(work_shell_agent_console_tab(line), None);
            assert_eq!(work_shell_builtin_submit_command(line), None);
            assert_eq!(
                route_work_shell_slash_command(line),
                SlashRoute {
                    kind: SlashRouteKind::Fallback,
                    route: Vec::new(),
                }
            );
            assert_eq!(
                serde_json::from_str::<Value>(
                    &route_work_shell_submit_json(line, false, "default", true).unwrap(),
                )
                .unwrap()["kind"],
                "chat"
            );
        }
    }

    #[test]
    fn marks_console_like_invalid_forms_as_silent_no_ops() {
        for line in [
            "/agent",
            "/agen",
            "/age",
            "/job",
            "/tod",
            "/agents extra",
            "/jobs extra",
            "/todo extra",
        ] {
            assert!(
                is_work_shell_console_invalid_form(line),
                "{line} must be a console-invalid form"
            );
            let route = serde_json::from_str::<Value>(
                &route_work_shell_submit_json(line, false, "default", true).unwrap(),
            )
            .unwrap();
            assert_eq!(route["kind"], "chat");
            assert_eq!(
                route["consoleInvalid"], true,
                "{line} must be marked console-invalid"
            );
        }

        for line in [
            "/agents",
            "/jobs",
            "/todo",
            "/a",
            "/auth",
            "/definitely-unknown",
            "finish cleanup",
        ] {
            assert!(
                !is_work_shell_console_invalid_form(line),
                "{line} must keep ordinary handling"
            );
        }

        let unknown = serde_json::from_str::<Value>(
            &route_work_shell_submit_json("/definitely-unknown", false, "default", true).unwrap(),
        )
        .unwrap();
        assert_eq!(unknown["kind"], "chat");
        assert_eq!(unknown["consoleInvalid"], Value::Null);
    }

    #[test]
    fn renders_route_json_contract() {
        let raw = route_cli_slash_command_json("/mode status").unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(parsed["kind"], "matched");
        assert_eq!(parsed["route"][0], "mode");
        assert_eq!(parsed["route"][1], "status");
    }

    #[test]
    fn loads_extension_slash_commands_from_manifests() {
        let root =
            std::env::temp_dir().join(format!("unclecode-rust-extension-{}", std::process::id()));
        let extension_dir = root.join(".unclecode/extensions");
        fs::create_dir_all(&extension_dir).unwrap();
        fs::write(
            extension_dir.join("focus.json"),
            r#"{
                "commands": [
                    {
                        "command": "/focus",
                        "routeTo": ["doctor"],
                        "description": "Run doctor from a plugin command.",
                        "aliases": ["/f"]
                    },
                    {
                        "command": "invalid",
                        "routeTo": ["doctor"],
                        "description": "ignored"
                    }
                ]
            }"#,
        )
        .unwrap();

        let raw = extension_slash_commands_json(root.to_str().unwrap(), None).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 1);
        assert_eq!(parsed[0]["command"], "/focus");
        assert_eq!(parsed[0]["routeTo"][0], "doctor");
        assert_eq!(parsed[0]["metadata"]["source"], "plugin");
        assert_eq!(parsed[0]["metadata"]["aliases"][0], "/f");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn loads_extension_config_overlays_and_summaries_from_manifests() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-rust-extension-summary-{}",
            std::process::id()
        ));
        let extension_dir = root.join(".unclecode/extensions");
        fs::create_dir_all(&extension_dir).unwrap();
        fs::write(
            extension_dir.join("focus.json"),
            r#"{
                "name": "focus-tools",
                "config": {
                    "model": "plugin-model",
                    "prompt": {
                        "sections": {
                            "focus-note": {
                                "title": "Focus Note",
                                "body": "Stay locked on the highest-value task."
                            }
                        }
                    }
                },
                "status": {
                    "lines": ["/focus ready", "plugin-model overlay active"]
                }
            }"#,
        )
        .unwrap();

        let raw = extension_manifests_json(root.to_str().unwrap(), None).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["configOverlays"][0]["name"], "focus-tools");
        assert_eq!(
            parsed["configOverlays"][0]["config"]["model"],
            "plugin-model"
        );
        assert_eq!(parsed["summaries"][0]["name"], "focus-tools");
        assert_eq!(parsed["summaries"][0]["statusLines"][0], "/focus ready");

        let _ = fs::remove_dir_all(root);
    }
}
