use crate::http_transport::describe_proxy_policy_fields;
use crate::model_registry::{openai_reasoning_support, provider_model_catalog};
use crate::ux_text::{display_width, pad_display_width, truncate_display_width};
use serde_json::{json, Value};

pub fn build_ux_panel_json(kind: &str, input_json: &str) -> Result<String, String> {
    let input: Value =
        serde_json::from_str(input_json).map_err(|error| format!("Invalid panel JSON: {error}"))?;
    let panel = match kind {
        "queue" => queue_panel(&input),
        "context" => context_panel(&input),
        "inline-command" => inline_command_panel(&input),
        "model-picker" => model_picker_panel(&input),
        "commands" => commands_panel(&input),
        "auth-picker" => auth_picker_panel(&input),
        "help" => help_panel(),
        "status" => status_panel(&input),
        "sessions" => sessions_panel(&input),
        "harness" => harness_panel(&input),
        "skills" => skills_panel(&input),
        "skill" => loaded_skill_panel(&input),
        "memories" => memories_panel(&input),
        "auth-secure-entry" => auth_secure_entry_panel(&input),
        "auth-progress" => auth_progress_panel(&input),
        _ => return Err(
            "Usage: unclecode rust ux panel <queue|context|inline-command|model-picker|commands|auth-picker|help|status|sessions|harness|skills|skill|memories|auth-secure-entry|auth-progress>"
                .to_string(),
        ),
    };
    serde_json::to_string(&panel).map_err(|error| error.to_string())
}

pub fn format_inline_command_summary_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid inline command summary JSON: {error}"))?;
    let panel = inline_command_panel(&input);
    let title = panel.get("title").and_then(Value::as_str).unwrap_or("");
    let lines = panel
        .get("lines")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut parts = vec![title.to_string()];
    for line in lines.iter().filter_map(Value::as_str).take(2) {
        parts.push(line.to_string());
    }
    Ok(parts.join(" · "))
}

pub fn format_auth_label_for_display_text(auth_label: &str) -> String {
    format_auth_label_for_display(auth_label.trim())
}

pub fn resolve_auth_launcher_lines_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid auth launcher lines JSON: {error}"))?;
    let mode = str_field(&input, "mode").unwrap_or("default");
    let auth_label = str_field(&input, "authLabel");
    let browser_oauth_available = bool_field_default(&input, "browserOAuthAvailable", true);
    let oauth_route = str_field(&input, "oauthRoute");
    let lines = match mode {
        "normalize" => normalize_auth_launcher_lines(
            &array_field_preserve_empty(&input, "lines"),
            auth_label,
            browser_oauth_available,
        ),
        _ => Some(build_default_auth_launcher_lines(
            auth_label,
            browser_oauth_available,
            oauth_route,
        )),
    };
    serde_json::to_string(&json!({ "lines": lines })).map_err(|error| error.to_string())
}

pub fn resolve_auth_status_panel_lines_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid auth status panel lines JSON: {error}"))?;
    let lines = array_field_preserve_empty(&input, "lines");
    let browser_oauth_available = bool_field_default(&input, "browserOAuthAvailable", true);
    let source = parse_auth_status_line(&lines, "source").unwrap_or_else(|| "none".to_string());
    let auth = parse_auth_status_line(&lines, "auth").unwrap_or_else(|| "none".to_string());
    let expires_at =
        parse_auth_status_line(&lines, "expiresAt").unwrap_or_else(|| "none".to_string());
    let expired = parse_auth_status_line(&lines, "expired")
        .map(|value| value.eq_ignore_ascii_case("yes"))
        .unwrap_or(false);
    let route = if browser_oauth_available {
        "Browser OAuth"
    } else {
        "Device OAuth"
    };
    let auth_display = format_auth_label_for_display(&source);

    let refined = if source == "none" {
        let mut out = vec![
            "Current".to_string(),
            "Auth · Not signed in".to_string(),
            format!("Route · {route}"),
            if browser_oauth_available {
                "Use /auth login or /auth key.".to_string()
            } else {
                "Use /auth login (device when available) or /auth key.".to_string()
            },
            String::new(),
            "Next".to_string(),
        ];
        out.extend(build_auth_launcher_next_lines(
            Some("none"),
            browser_oauth_available,
        ));
        out
    } else if auth == "api-key" {
        let mut out = vec![
            "Current".to_string(),
            format!("Auth · {auth_display}"),
            format!("Route · {route}"),
            "API key active.".to_string(),
            String::new(),
            "Next".to_string(),
        ];
        out.extend(build_auth_launcher_next_lines(
            Some("api-key-env"),
            browser_oauth_available,
        ));
        out
    } else if expires_at == "insufficient-scope" {
        let mut out = vec![
            "Current".to_string(),
            format!("Auth · {auth_display}"),
            format!("Route · {route}"),
            "OAuth token lacks model.request scope.".to_string(),
            String::new(),
            "Next".to_string(),
        ];
        out.extend(if browser_oauth_available {
            vec![
                "Use /auth login for proper browser OAuth.".to_string(),
                "/auth key opens secure API key entry.".to_string(),
            ]
        } else {
            vec![
                "Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID.".to_string(),
                "/auth key opens secure API key entry.".to_string(),
            ]
        });
        out
    } else if expired || expires_at == "refresh-required" {
        let mut out = vec![
            "Current".to_string(),
            format!("Auth · {auth_display}"),
            format!("Route · {route}"),
            "Browser OAuth needs refresh.".to_string(),
            String::new(),
            "Next".to_string(),
        ];
        out.extend(if browser_oauth_available {
            vec![
                "/auth login refreshes this shell.".to_string(),
                "/auth logout clears stale auth if needed.".to_string(),
            ]
        } else {
            vec![
                "OAuth refresh needs OPENAI_OAUTH_CLIENT_ID here.".to_string(),
                "/auth logout clears stale auth if needed.".to_string(),
            ]
        });
        out
    } else {
        vec![
            "Current".to_string(),
            format!("Auth · {auth_display}"),
            format!("Route · {route}"),
            "Saved browser OAuth found.".to_string(),
            String::new(),
            "Next".to_string(),
            "/auth status inspects auth or /auth logout switches auth.".to_string(),
        ]
    };
    serde_json::to_string(&json!({ "lines": refined })).map_err(|error| error.to_string())
}

pub fn resolve_auth_browser_failure_lines_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "{}"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid auth browser failure JSON: {error}"))?;
    let lines = array_field_preserve_empty(&input, "lines");
    let failed = bool_field(&input, "failed");
    let auth_label = str_field(&input, "authLabel").unwrap_or("none");
    let args = array_field_preserve_empty(&input, "args");
    let is_browser_auth = args.first().is_some_and(|value| value == "auth")
        && args.get(1).is_some_and(|value| value == "login")
        && args.iter().any(|value| value == "--browser");
    let missing_client_id = lines.iter().any(|line| is_missing_oauth_client_id(line));

    let refined = if !failed || !is_browser_auth || !missing_client_id {
        lines
    } else if auth_label.starts_with("api-key-") {
        vec![
            "Current".to_string(),
            format!("Auth · {}", format_auth_label_for_display(auth_label)),
            "Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID.".to_string(),
            String::new(),
            "Next".to_string(),
            "/auth status inspects auth or /auth logout switches.".to_string(),
            "/auth key opens secure API key entry.".to_string(),
        ]
    } else if auth_label.starts_with("oauth-") {
        vec![
            "Current".to_string(),
            format!("Auth · {}", format_auth_label_for_display(auth_label)),
            "Saved browser OAuth found.".to_string(),
            String::new(),
            "Next".to_string(),
            "/auth status inspects auth or /auth logout switches auth.".to_string(),
        ]
    } else {
        vec![
            "Current".to_string(),
            "Auth · Not signed in".to_string(),
            "Browser OAuth unavailable here.".to_string(),
            String::new(),
            "Next".to_string(),
            "Set OPENAI_OAUTH_CLIENT_ID for browser login.".to_string(),
            "Or use /auth key.".to_string(),
        ]
    };
    serde_json::to_string(&json!({ "lines": refined })).map_err(|error| error.to_string())
}

pub fn extract_auth_label_json(input_json: &str) -> Result<String, String> {
    let input = if input_json.trim().is_empty() {
        "[]"
    } else {
        input_json.trim()
    };
    let input: Value = serde_json::from_str(input)
        .map_err(|error| format!("Invalid auth label lines JSON: {error}"))?;
    let lines = if input.is_array() {
        input
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        array_field_preserve_empty(&input, "lines")
    };
    let auth_label = lines.iter().find_map(|line| {
        extract_auth_label_line(line)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    });
    serde_json::to_string(&json!({ "authLabel": auth_label })).map_err(|error| error.to_string())
}

pub fn build_model_suggestions_json(
    provider: &str,
    current_model: &str,
    normalized_input: &str,
) -> Result<String, String> {
    let catalog = provider_model_catalog(provider, Some(current_model), None);
    let current_model = current_model.trim();
    let normalized = normalized_input.trim().to_ascii_lowercase();
    let mut entries = catalog
        .models
        .iter()
        .take(8)
        .map(|model| {
            json!({
                "command": format!("/model {model}"),
                "description": model_suggestion_description(provider, model, current_model)
            })
        })
        .collect::<Vec<_>>();
    entries.push(json!({
        "command": "/model list",
        "description": "List available models and reasoning support."
    }));

    if normalized == "/model" {
        return serde_json::to_string(&entries).map_err(|error| error.to_string());
    }

    serde_json::to_string(
        &entries
            .into_iter()
            .filter(|entry| {
                entry
                    .get("command")
                    .and_then(Value::as_str)
                    .map(|command| command.to_ascii_lowercase().starts_with(&normalized))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|error| error.to_string())
}

pub fn build_slash_suggestions_json(
    normalized_input: &str,
    entries_json: &str,
) -> Result<String, String> {
    let input = if entries_json.trim().is_empty() {
        "[]"
    } else {
        entries_json.trim()
    };
    let entries: Vec<Value> = serde_json::from_str(input)
        .map_err(|error| format!("Invalid slash entries JSON: {error}"))?;
    let normalized = normalized_input.trim().to_ascii_lowercase();
    if !normalized.starts_with('/') {
        return Ok("[]".to_string());
    }

    let suggestions = if normalized == "/auth" || normalized.starts_with("/auth ") {
        auth_suggestions(&entries)
    } else if normalized == "/mode" || normalized.starts_with("/mode ") {
        mode_suggestions(&normalized, &entries)
    } else {
        scored_suggestions(&normalized, &entries)
    };
    serde_json::to_string(&suggestions).map_err(|error| error.to_string())
}

fn queue_panel(input: &Value) -> Value {
    let is_busy = bool_field(input, "isBusy");
    let busy_status = str_field(input, "busyStatus")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mode = str_field(input, "mode").filter(|value| !value.is_empty());
    let worker_budget = input.get("workerBudget").and_then(Value::as_u64);
    let queued_count = input
        .get("queuedCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let queued_items = input
        .get("queuedItems")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_u64)?;
                    let line = str_field(item, "line")?.trim();
                    if line.is_empty() {
                        return None;
                    }
                    Some((id, compact_preview(line, 28)))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let terminal_columns = input
        .get("terminalColumns")
        .and_then(Value::as_u64)
        .unwrap_or(100) as usize;
    let queue_paused = bool_field_default(input, "queuePaused", false);
    let blocked_reason = str_field(input, "blockedReason")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let active_prompt_preview = str_field(input, "activePromptPreview")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let last_completed_turn = parse_last_completed_turn(input);

    let mut lines = build_work_board_status_lines(is_busy, busy_status, mode, worker_budget);
    lines.push(String::new());
    lines.push("Board".to_string());
    lines.extend(build_work_board_grid_lines(
        WorkBoardInput {
            is_busy,
            busy_status,
            queued_count,
            queued_items: &queued_items,
            queue_paused,
            blocked_reason,
            active_prompt_preview,
            last_completed_turn: last_completed_turn.as_deref(),
        },
        terminal_columns,
    ));
    lines.extend([
        String::new(),
        "Steer".to_string(),
        if is_busy {
            "Enter queues follow-up · Ctrl+C/Esc interrupt · /queue clear drops".to_string()
        } else {
            "Start a turn first; queued follow-ups run in order after it finishes.".to_string()
        },
        if queue_paused && queued_count > 0 {
            "Queue paused after interrupt · send a new message to resume or /queue clear to drop."
                .to_string()
        } else {
            "Slash commands are not queued while busy; /cancel interrupts the active turn.".to_string()
        },
        "/queue clear drops queued follow-ups without stopping the active turn.".to_string(),
    ]);

    json!({ "title": "Work board", "lines": lines })
}

struct WorkBoardInput<'a> {
    is_busy: bool,
    busy_status: Option<&'a str>,
    queued_count: usize,
    queued_items: &'a [(u64, String)],
    queue_paused: bool,
    blocked_reason: Option<&'a str>,
    active_prompt_preview: Option<&'a str>,
    last_completed_turn: Option<&'a str>,
}

fn parse_last_completed_turn(input: &Value) -> Option<String> {
    let turn = input.get("lastCompletedTurn")?;
    let user = turn.get("user").and_then(Value::as_str)?.trim();
    let assistant = turn.get("assistant").and_then(Value::as_str)?.trim();
    if user.is_empty() || assistant.is_empty() {
        return None;
    }
    Some(format!(
        "{} → {}",
        compact_preview(user, 24),
        compact_preview(assistant, 32)
    ))
}

fn build_work_board_status_lines(
    is_busy: bool,
    busy_status: Option<&str>,
    mode: Option<&str>,
    worker_budget: Option<u64>,
) -> Vec<String> {
    let mut parts = Vec::new();
    parts.push(if is_busy {
        "State · running".to_string()
    } else {
        "State · idle".to_string()
    });
    if let Some(mode) = mode {
        parts.push(mode.to_string());
    }
    if let Some(worker_budget) = worker_budget {
        parts.push(format!("workers {worker_budget}"));
    } else if is_busy {
        if let Some(detail) = busy_status {
            parts.push(detail.to_string());
        }
    }
    vec![parts.join(" · ")]
}

fn build_work_board_grid_lines(input: WorkBoardInput<'_>, terminal_columns: usize) -> Vec<String> {
    let queued = build_work_board_column(
        "Queued",
        input.queued_count,
        build_queued_board_rows(input.queued_count, input.queued_items),
    );
    let running = build_work_board_column(
        "Running",
        usize::from(input.is_busy),
        build_running_board_rows(input.is_busy, input.busy_status, input.active_prompt_preview),
    );
    let blocked = build_work_board_column(
        "Blocked",
        work_board_blocked_count(input.queue_paused, input.queued_count, input.blocked_reason),
        build_blocked_board_rows(input.queue_paused, input.queued_count, input.blocked_reason),
    );
    let done_count = usize::from(input.last_completed_turn.is_some());
    let done = build_work_board_column(
        "Done",
        done_count,
        build_done_board_rows(input.last_completed_turn),
    );

    if terminal_columns >= 100 {
        format_work_board_four_columns(&[queued, running, blocked, done], 22)
    } else {
        format_work_board_two_by_two(&[queued, running, blocked, done], 36)
    }
}

struct WorkBoardColumn {
    label: String,
    rows: Vec<String>,
}

fn build_work_board_column(label: &str, count: usize, rows: Vec<String>) -> WorkBoardColumn {
    WorkBoardColumn {
        label: format!("{label} · {count}"),
        rows,
    }
}

fn build_queued_board_rows(queued_count: usize, queued_items: &[(u64, String)]) -> Vec<String> {
    if queued_count == 0 {
        return vec!["—".to_string()];
    }
    let mut rows = queued_items
        .iter()
        .take(3)
        .map(|(id, line)| format!("#{id} {line}"))
        .collect::<Vec<_>>();
    if queued_count > rows.len() {
        rows.push(format!("+{} more", queued_count - rows.len()));
    }
    rows
}

fn build_running_board_rows(
    is_busy: bool,
    busy_status: Option<&str>,
    active_prompt_preview: Option<&str>,
) -> Vec<String> {
    if !is_busy {
        return vec!["—".to_string()];
    }
    let mut rows = vec![format!(
        "⠋ {}",
        busy_status.unwrap_or("active turn")
    )];
    if let Some(preview) = active_prompt_preview {
        rows.push(compact_preview(preview, 28));
    }
    rows
}

fn work_board_blocked_count(
    queue_paused: bool,
    queued_count: usize,
    blocked_reason: Option<&str>,
) -> usize {
    if blocked_reason.is_some() {
        return 1;
    }
    if queue_paused && queued_count > 0 {
        return 1;
    }
    0
}

fn build_blocked_board_rows(
    queue_paused: bool,
    queued_count: usize,
    blocked_reason: Option<&str>,
) -> Vec<String> {
    if let Some(reason) = blocked_reason {
        return vec![compact_preview(reason, 28)];
    }
    if queue_paused && queued_count > 0 {
        return vec![format!("pause · {queued_count} queued")];
    }
    vec!["—".to_string()]
}

fn build_done_board_rows(last_completed_turn: Option<&str>) -> Vec<String> {
    last_completed_turn
        .map(|line| vec![line.to_string()])
        .unwrap_or_else(|| vec!["—".to_string()])
}

fn format_work_board_four_columns(columns: &[WorkBoardColumn; 4], col_width: usize) -> Vec<String> {
    let header = join_board_row(
        &[
            columns[0].label.as_str(),
            columns[1].label.as_str(),
            columns[2].label.as_str(),
            columns[3].label.as_str(),
        ],
        col_width,
    );
    let row_count = columns
        .iter()
        .map(|column| column.rows.len())
        .max()
        .unwrap_or(1);
    let mut lines = vec![header];
    for row_index in 0..row_count {
        lines.push(join_board_row(
            &[
                column_row_or_dash(&columns[0], row_index).as_str(),
                column_row_or_dash(&columns[1], row_index).as_str(),
                column_row_or_dash(&columns[2], row_index).as_str(),
                column_row_or_dash(&columns[3], row_index).as_str(),
            ],
            col_width,
        ));
    }
    lines
}

fn format_work_board_two_by_two(columns: &[WorkBoardColumn; 4], col_width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for pair in [(0, 1), (2, 3)] {
        lines.push(join_board_row(
            &[columns[pair.0].label.as_str(), columns[pair.1].label.as_str()],
            col_width,
        ));
        let row_count = columns[pair.0]
            .rows
            .len()
            .max(columns[pair.1].rows.len());
        for row_index in 0..row_count {
            lines.push(join_board_row(
                &[
                    column_row_or_dash(&columns[pair.0], row_index).as_str(),
                    column_row_or_dash(&columns[pair.1], row_index).as_str(),
                ],
                col_width,
            ));
        }
        if pair.0 == 0 {
            lines.push(String::new());
        }
    }
    lines
}

fn column_row_or_dash(column: &WorkBoardColumn, row_index: usize) -> String {
    column
        .rows
        .get(row_index)
        .cloned()
        .unwrap_or_else(|| "—".to_string())
}

fn join_board_row(cells: &[&str], col_width: usize) -> String {
    cells
        .iter()
        .map(|cell| pad_board_cell(cell, col_width))
        .collect::<Vec<_>>()
        .join(" │ ")
}

fn pad_board_cell(text: &str, width: usize) -> String {
    if display_width(text) >= width {
        return compact_preview(text, width);
    }
    pad_display_width(text, width)
}

fn context_panel(input: &Value) -> Value {
    let context = dedupe_strings(array_field(input, "contextSummaryLines"));
    let bridge = dedupe_strings(array_field(input, "bridgeLines"));
    let memory = dedupe_strings(array_field(input, "memoryLines"));
    let live = dedupe_strings(array_field(input, "traceLines"));
    let expanded = bool_field(input, "expanded");

    let issue_lines = context
        .iter()
        .filter(|line| line.to_ascii_lowercase().starts_with("auth issue:"))
        .cloned()
        .collect::<Vec<_>>();
    let guidance_lines = context
        .iter()
        .filter(|line| !line.to_ascii_lowercase().starts_with("auth issue:"))
        .cloned()
        .collect::<Vec<_>>();
    let source_lines = summarize_context_sources(&guidance_lines, &bridge, &memory);
    let health_lines = summarize_context_health(&context, &bridge, &memory, &live);

    if !expanded {
        let mut lines = vec![
            "Snapshot".to_string(),
            format!("Sources · {}", source_lines.join(" · ")),
            format!("Health · {}", health_lines.join(" · ")),
        ];
        if let Some(issue) = issue_lines.first() {
            lines.push(format!("! Issue   {}", compact_context_value(issue, 52)));
        }
        if let Some(guide) = guidance_lines.first() {
            lines.push(format!("□ Guide   {}", compact_context_value(guide, 52)));
        }
        if let Some(bridge_line) = bridge.first() {
            lines.push(format!(
                "□ Bridge  {}",
                compact_context_value(bridge_line, 52)
            ));
        }
        if let Some(memory_line) = memory.first() {
            lines.push(format!(
                "□ Memory  {}",
                compact_context_value(memory_line, 52)
            ));
        }
        if let Some(live_line) = live.first() {
            lines.push(format!(
                "→ Live    {}",
                compact_context_value(live_line, 52)
            ));
        }
        if lines.len() == 3
            && context.is_empty()
            && bridge.is_empty()
            && memory.is_empty()
            && live.is_empty()
        {
            lines.push("□ Empty   No workspace context yet.".to_string());
        }
        return json!({ "title": "Context", "lines": lines });
    }

    let mut lines = vec![
        "Snapshot".to_string(),
        format!("Sources · {}", source_lines.join(" · ")),
        format!("Health · {}", health_lines.join(" · ")),
    ];
    if !issue_lines.is_empty() {
        lines.extend(["".to_string(), "Issues".to_string()]);
        lines.extend(issue_lines);
    }
    if !guidance_lines.is_empty() {
        lines.extend(["".to_string(), "Guidance".to_string()]);
        lines.extend(guidance_lines);
    }
    if !bridge.is_empty() {
        lines.extend(["".to_string(), "Bridge".to_string()]);
        lines.extend(bridge);
    }
    if !memory.is_empty() {
        lines.extend(["".to_string(), "Memory".to_string()]);
        lines.extend(memory);
    }
    if !live.is_empty() {
        lines.extend(["".to_string(), "Live steps".to_string()]);
        lines.extend(live);
    }
    if lines.len() == 3 {
        lines.push("No workspace context yet.".to_string());
    }

    json!({ "title": "Context expanded", "lines": lines })
}

fn inline_command_panel(input: &Value) -> Value {
    let args = array_field(input, "args");
    let lines = array_field(input, "lines");
    json!({
        "title": inline_command_title(&args),
        "lines": if lines.is_empty() { vec!["No output.".to_string()] } else { lines }
    })
}

fn inline_command_title(args: &[String]) -> String {
    let key = args.join(" ");
    match key.as_str() {
        "doctor" => "Doctor".to_string(),
        "auth status" | "auth login" | "auth login --browser" | "auth key" => "Auth".to_string(),
        "mcp list" => "MCP".to_string(),
        "mode status" => "Mode".to_string(),
        _ if key.starts_with("auth login --api-key ") => "Auth".to_string(),
        _ => key,
    }
}

fn model_picker_panel(input: &Value) -> Value {
    let input_text = str_field(input, "input")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/model");
    let model_filter = input_text
        .strip_prefix("/model")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let current_model_hint = str_field(input, "currentModel")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let suggestions = input
        .get("suggestions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let command = str_field(item, "command")?.trim();
                    let description = str_field(item, "description").unwrap_or("").trim();
                    if command.is_empty() {
                        return None;
                    }
                    Some((command.to_string(), description.to_string()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = clamp_index(
        input
            .get("selectedIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        suggestions.len(),
    );
    let selected_command = suggestions
        .get(selected)
        .map(|(command, _)| command.as_str())
        .unwrap_or("");
    let model_entries = suggestions
        .iter()
        .enumerate()
        .filter(|(_, (command, _))| command.starts_with("/model ") && command != "/model list")
        .take(6)
        .collect::<Vec<_>>();
    let selected_model_command = if selected_command == "/model" {
        model_entries
            .first()
            .map(|(_, (command, _))| command.as_str())
            .unwrap_or("")
    } else {
        selected_command
    };
    let current_entry = model_entries
        .iter()
        .find(|(_, (_, description))| description.to_ascii_lowercase().contains("current"))
        .or_else(|| model_entries.first());
    let current_model = current_model_hint
        .map(ToString::to_string)
        .or_else(|| {
            current_entry.map(|(_, (command, _))| command.trim_start_matches("/model ").to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());
    let current_meta = current_entry
        .map(|(_, (_, description))| parse_current_model_description(description))
        .unwrap_or_else(|| ModelPickerCurrent {
            reasoning: "unknown".to_string(),
            support: None,
        });

    if model_entries.is_empty() {
        let mut lines = Vec::new();
        if let Some(current_model) = current_model_hint {
            lines.extend([
                "Current model".to_string(),
                format!("Model · {current_model}"),
                String::new(),
            ]);
        }
        lines.push("Filter".to_string());
        if let Some(filter) = model_filter {
            lines.push(format!("Query · {filter}"));
        } else {
            lines.push("Query · /model".to_string());
        }
        lines.push(String::new());
        lines.push(match model_filter {
            Some(filter) => format!("No model id matches {filter}. Current model unchanged."),
            None => "No exact model match.".to_string(),
        });
        lines.push("/model list shows the catalog.".to_string());
        lines.extend([
            String::new(),
            "Controls".to_string(),
            "Backspace edit · Enter keeps current · Esc close".to_string(),
        ]);
        return json!({ "title": "Model picker", "lines": lines });
    }

    let mut lines = vec![
        "Current model".to_string(),
        format!("Model · {current_model}"),
        format!("Thinking · {}", current_meta.reasoning),
        model_picker_reasoning_choice_line(&current_meta),
    ];
    if let Some(support) = current_meta.support.as_deref() {
        lines.push(format!("Supports · {support}"));
    }
    if let Some(filter) = model_filter {
        lines.push(format!("Filter · {filter}"));
    }
    lines.extend([String::new(), "Pick model".to_string()]);
    lines.extend(model_entries.iter().map(|(_, (command, description))| {
        let selected_row = selected_model_command == command;
        format!(
            "{} {}  {}",
            if selected_row { "›" } else { " " },
            command,
            compact_model_suggestion_description(description)
        )
    }));
    lines.extend([
        String::new(),
        "Controls".to_string(),
        "↑↓ choose model · Enter switch · append low/medium/high/default · Esc close".to_string(),
    ]);

    json!({ "title": "Model picker", "lines": lines })
}

fn commands_panel(input: &Value) -> Value {
    let input_text = str_field(input, "input")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/");
    let suggestions = input
        .get("suggestions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let command = str_field(item, "command")?.trim();
                    let description = str_field(item, "description").unwrap_or("").trim();
                    if command.is_empty() {
                        return None;
                    }
                    Some((command.to_string(), description.to_string()))
                })
                .take(6)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = clamp_index(
        input
            .get("selectedIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        suggestions.len(),
    );
    if suggestions.is_empty() {
        return json!({
            "title": "Commands",
            "lines": [
                format!("No matches for {input_text}."),
                "",
                "Try /model, /auth, /queue, or /context.",
            ]
        });
    }

    let mut lines = vec![format!("{input_text} matches"), String::new()];
    lines.extend(
        suggestions
            .iter()
            .enumerate()
            .map(|(index, (command, description))| {
                format!(
                    "{} {}  {}",
                    if index == selected { "›" } else { " " },
                    command,
                    description
                )
            }),
    );
    lines.extend([String::new(), "↑↓ move · Enter run".to_string()]);
    json!({ "title": "Commands", "lines": lines })
}

fn help_panel() -> Value {
    json!({
        "title": "Work-first shell",
        "lines": [
            "Composer is live.",
            "Esc opens sessions when idle; Ctrl+C/Esc interrupts active work.",
            "Shift+Tab cycles mode.",
            "/ starts commands. Tab completes.",
            "/context, /reasoning, /model, /sessions, /reload",
            "/doctor, /auth status, /auth login, /auth key, /mcp list, /mode status",
            "/research <topic>, /research status, /review, /commit",
            "/mmbridge context, /mmbridge review, /mmbridge gate, /mmbridge handoff, /mmbridge doctor",
            "/queue, /cancel, /skills, /skill <name>, /memories, /harness, /clear, /help, /exit",
            "/remember [session|project|user|agent] <text>",
            "AGENTS.md / CLAUDE.md load automatically."
        ]
    })
}

fn status_panel(input: &Value) -> Value {
    let provider = str_field(input, "provider").unwrap_or("unknown");
    let model = str_field(input, "model").unwrap_or("unknown");
    let mode = str_field(input, "mode").unwrap_or("default");
    let cwd = str_field(input, "cwd").unwrap_or(".");
    let reasoning_label = str_field(input, "reasoningLabel").unwrap_or("unknown");
    let auth_label = str_field(input, "authLabel").unwrap_or("none");
    let mut lines = vec![
        "Current".to_string(),
        format!("Provider · {provider}"),
        format!("Model · {model}"),
        format!("Reasoning · {reasoning_label}"),
        format!("Mode · {mode}"),
        format!("Auth · {}", format_auth_label_for_display(auth_label)),
    ];
    lines.extend(status_activity_lines(input));
    lines.extend(status_route_lines(input));
    lines.extend(status_context_lines(input));
    lines.extend([
        String::new(),
        "Workspace".to_string(),
        format!("Cwd · {cwd}"),
    ]);
    json!({
        "title": "Session status",
        "lines": lines
    })
}

fn status_activity_lines(input: &Value) -> Vec<String> {
    let has_activity = input.get("isBusy").is_some()
        || input.get("busyStatus").is_some()
        || input.get("currentTurnStartedAt").is_some()
        || input.get("lastTurnDurationMs").is_some();
    if !has_activity {
        return Vec::new();
    }

    let is_busy = bool_field(input, "isBusy");
    let mut lines = vec![
        String::new(),
        "Activity".to_string(),
        format!("State · {}", if is_busy { "running" } else { "idle" }),
    ];
    if is_busy {
        let detail = str_field(input, "busyStatus")
            .map(normalize_status_detail)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "active turn".to_string());
        lines.push(format!("Now · {detail}"));
        lines.push("Controls · Ctrl+C/Esc interrupt · Enter queues follow-up".to_string());
        if let (Some(started_at), Some(now_ms)) = (
            number_field(input, "currentTurnStartedAt"),
            number_field(input, "nowMs"),
        ) {
            lines.push(format!(
                "Elapsed · {}",
                format_panel_duration((now_ms - started_at).max(0))
            ));
        }
    } else if let Some(duration) = number_field(input, "lastTurnDurationMs") {
        lines.push(format!("Last reply · {}", format_panel_duration(duration)));
    }
    lines
}

fn status_route_lines(input: &Value) -> Vec<String> {
    if let Some(route_error) = str_field(input, "routeError")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return vec![
            String::new(),
            "Route".to_string(),
            format!(
                "Runtime · unavailable · {}",
                compact_preview(route_error, 72)
            ),
        ];
    }

    let Some(route) = input.get("route").filter(|value| value.is_object()) else {
        return Vec::new();
    };
    let label = str_field(route, "label").unwrap_or("unknown");
    let provider_id = str_field(route, "providerId").unwrap_or("unknown");
    let transport = str_field(route, "transport").unwrap_or("unknown");
    let endpoint = str_field(route, "endpointUrl").unwrap_or("unknown");
    let runtime = if bool_field(route, "runtimeSupported") {
        transport.to_string()
    } else {
        format!("{transport} · unsupported")
    };
    let mut lines = vec![
        String::new(),
        "Route".to_string(),
        format!("Runtime · {label} ({provider_id}) · {runtime}"),
        format!("Endpoint · {endpoint}"),
    ];
    if let Some(proxy) = route.get("proxyPolicy").filter(|value| value.is_object()) {
        lines.push(format!("Proxy · {}", format_status_proxy_policy(proxy)));
    }
    lines
}

fn status_context_lines(input: &Value) -> Vec<String> {
    let context = dedupe_strings(array_field(input, "contextSummaryLines"));
    let bridge = dedupe_strings(array_field(input, "bridgeLines"));
    let memory = dedupe_strings(array_field(input, "memoryLines"));
    let live = dedupe_strings(array_field(input, "traceLines"));
    let source_lines = summarize_context_sources(&context, &bridge, &memory);
    let health_lines = summarize_context_health(&context, &bridge, &memory, &live);
    let mut lines = vec![
        String::new(),
        "Context".to_string(),
        format!("Sources · {}", source_lines.join(" · ")),
        format!("Health · {}", health_lines.join(" · ")),
    ];
    if let Some(issue) = context
        .iter()
        .find(|line| line.to_ascii_lowercase().starts_with("auth issue:"))
    {
        lines.push(format!("Issue · {}", compact_context_value(issue, 72)));
    }
    if let Some(line) = context
        .iter()
        .find(|line| !line.to_ascii_lowercase().starts_with("auth issue:"))
    {
        lines.push(format!("Guide · {}", compact_context_value(line, 72)));
    } else if let Some(line) = bridge.first() {
        lines.push(format!("Bridge · {}", compact_context_value(line, 72)));
    } else if let Some(line) = memory.first() {
        lines.push(format!("Memory · {}", compact_context_value(line, 72)));
    } else if let Some(line) = live.first() {
        lines.push(format!("Live · {}", compact_context_value(line, 72)));
    } else {
        lines.push("Empty · No workspace context yet.".to_string());
    }
    lines
}

fn format_status_proxy_policy(proxy: &Value) -> String {
    let target_host = str_field(proxy, "targetHost").unwrap_or("unknown");
    let source = str_field(proxy, "source").unwrap_or("none");
    let no_proxy = array_field(proxy, "noProxy");
    describe_proxy_policy_fields(
        target_host,
        source,
        bool_field(proxy, "bypassed"),
        &no_proxy,
        str_field(proxy, "proxyUrl"),
    )
}

fn sessions_panel(input: &Value) -> Value {
    let lines = if bool_field(input, "loading") {
        vec!["Loading sessions…".to_string()]
    } else {
        let lines = array_field_preserve_empty(input, "lines");
        if lines.is_empty() {
            vec![
                "No recent sessions found.".to_string(),
                "Run unclecode work to start one, then press Esc here to resume.".to_string(),
                "Use /context for workspace guidance and memory.".to_string(),
            ]
        } else {
            lines
        }
    };
    json!({ "title": "Recent sessions", "lines": lines })
}

fn auth_picker_panel(input: &Value) -> Value {
    let auth_label = str_field(input, "authLabel");
    let browser_oauth_available = input
        .get("browserOAuthAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let suggestions = input
        .get("suggestions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let command = str_field(item, "command")?.trim();
                    let description = str_field(item, "description").unwrap_or("").trim();
                    if command.is_empty() {
                        return None;
                    }
                    Some((command.to_string(), description.to_string()))
                })
                .take(6)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = clamp_index(
        input
            .get("selectedIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        suggestions.len(),
    );
    let launcher_lines = normalize_auth_launcher_lines(
        &array_field_preserve_empty(input, "authLauncherLines"),
        auth_label,
        browser_oauth_available,
    )
    .unwrap_or_else(|| {
        build_default_auth_launcher_lines(auth_label, browser_oauth_available, None)
    });
    let signed_in = auth_label
        .map(|label| !label.is_empty() && label != "none")
        .unwrap_or(false);

    let mut lines = launcher_lines;
    lines.extend([String::new(), "Routes".to_string()]);
    lines.extend(
        suggestions
            .iter()
            .enumerate()
            .map(|(index, (command, description))| {
                format!(
                    "{} {}  {}",
                    if index == selected { "›" } else { " " },
                    command,
                    description
                )
            }),
    );
    lines.extend([
        String::new(),
        if signed_in {
            "Tip · /auth logout".to_string()
        } else {
            "Tip · /auth login".to_string()
        },
    ]);
    json!({ "title": "Auth", "lines": lines })
}

fn normalize_auth_launcher_lines(
    raw_lines: &[String],
    auth_label: Option<&str>,
    browser_oauth_available: bool,
) -> Option<Vec<String>> {
    if raw_lines.is_empty() {
        return None;
    }
    if raw_lines.iter().any(|line| line == "Current") {
        return Some(ensure_auth_launcher_route(
            raw_lines,
            auth_label,
            browser_oauth_available,
        ));
    }
    let lines = raw_lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }

    let remembered_auth_label = extract_auth_label(&lines)
        .or(auth_label)
        .map(str::to_string);
    let remembered_route = extract_auth_route(&lines).map(str::to_string);
    let contains = |needle: &str| {
        lines
            .iter()
            .any(|line| line.to_ascii_lowercase().contains(needle))
    };
    if contains("oauth login complete.") || contains("browser login complete.") {
        return Some(build_default_auth_launcher_lines(
            Some(remembered_auth_label.as_deref().unwrap_or("oauth-file")),
            browser_oauth_available,
            remembered_route.as_deref(),
        ));
    }
    if contains("saved auth found.") {
        return Some(build_default_auth_launcher_lines(
            Some(remembered_auth_label.as_deref().unwrap_or("oauth-file")),
            browser_oauth_available,
            remembered_route.as_deref(),
        ));
    }
    if contains("api key login saved.") {
        return Some(build_default_auth_launcher_lines(
            Some(remembered_auth_label.as_deref().unwrap_or("api-key-file")),
            browser_oauth_available,
            remembered_route.as_deref(),
        ));
    }
    if contains("signed out.") {
        return Some(build_default_auth_launcher_lines(
            Some("none"),
            browser_oauth_available,
            remembered_route.as_deref(),
        ));
    }
    if lines
        .iter()
        .any(|line| line.to_ascii_lowercase().starts_with("auth:"))
        && remembered_auth_label.is_some()
    {
        return Some(build_default_auth_launcher_lines(
            remembered_auth_label.as_deref(),
            browser_oauth_available,
            remembered_route.as_deref(),
        ));
    }
    None
}

fn ensure_auth_launcher_route(
    lines: &[String],
    auth_label: Option<&str>,
    browser_oauth_available: bool,
) -> Vec<String> {
    if lines
        .iter()
        .any(|line| line.trim().to_ascii_lowercase().starts_with("route · "))
    {
        return lines.to_vec();
    }
    let Some(route) = preferred_auth_route(auth_label, browser_oauth_available) else {
        return lines.to_vec();
    };
    let Some(auth_index) = lines
        .iter()
        .position(|line| line.trim().to_ascii_lowercase().starts_with("auth · "))
    else {
        return lines.to_vec();
    };
    let mut result = Vec::with_capacity(lines.len() + 1);
    result.extend_from_slice(&lines[..=auth_index]);
    result.push(format!("Route · {}", format_auth_route_label(route)));
    result.extend_from_slice(&lines[auth_index + 1..]);
    result
}

fn build_default_auth_launcher_lines(
    auth_label: Option<&str>,
    browser_oauth_available: bool,
    oauth_route: Option<&str>,
) -> Vec<String> {
    let signed_in = auth_label
        .map(|label| !label.is_empty() && label != "none")
        .unwrap_or(false);
    let route = oauth_route.or_else(|| preferred_auth_route(auth_label, browser_oauth_available));
    let mut lines = vec![
        "Current".to_string(),
        if signed_in {
            format!(
                "Auth · {}",
                format_auth_label_for_display(auth_label.unwrap_or("none"))
            )
        } else {
            "Auth · Not signed in".to_string()
        },
    ];
    if let Some(route) = route {
        lines.push(format!("Route · {}", format_auth_route_label(route)));
    }
    lines.push(format_auth_status_blurb(
        auth_label,
        browser_oauth_available,
    ));
    if !browser_oauth_available {
        lines.push("Browser OAuth unavailable in this shell.".to_string());
    }
    lines.extend([String::new(), "Next".to_string()]);
    lines.extend(build_auth_launcher_next_lines(
        auth_label,
        browser_oauth_available,
    ));
    lines
}

fn preferred_auth_route(
    auth_label: Option<&str>,
    browser_oauth_available: bool,
) -> Option<&'static str> {
    if auth_label
        .map(|label| {
            label == "none" || label.starts_with("api-key-") || label.starts_with("oauth-")
        })
        .unwrap_or(true)
    {
        return Some(if browser_oauth_available {
            "browser-oauth"
        } else {
            "device-oauth"
        });
    }
    None
}

fn format_auth_label_for_display(auth_label: &str) -> String {
    match auth_label {
        "oauth-file-api-blocked" => "OAuth file · API blocked".to_string(),
        "oauth-env-api-blocked" => "OAuth env · API blocked".to_string(),
        "oauth-file" => "Browser OAuth · file".to_string(),
        "oauth-env" => "Browser OAuth · env".to_string(),
        "api-key-file" => "API key · file".to_string(),
        "api-key-env" => "API key · env".to_string(),
        "none" => "Not signed in".to_string(),
        _ => auth_label.to_string(),
    }
}

fn format_auth_route_label(route: &str) -> String {
    match route {
        "device-oauth" => "Device OAuth".to_string(),
        "browser-oauth" => "Browser OAuth".to_string(),
        _ => route.to_string(),
    }
}

fn format_auth_status_blurb(auth_label: Option<&str>, browser_oauth_available: bool) -> String {
    let Some(auth_label) = auth_label else {
        return if browser_oauth_available {
            "Use /auth login or /auth key.".to_string()
        } else {
            "Use /auth login (device when available) or /auth key.".to_string()
        };
    };
    if auth_label == "none" {
        return if browser_oauth_available {
            "Use /auth login or /auth key.".to_string()
        } else {
            "Use /auth login (device when available) or /auth key.".to_string()
        };
    }
    if auth_label.starts_with("oauth-") {
        if auth_label.ends_with("-api-blocked") {
            return if browser_oauth_available {
                "Saved OAuth is not API-ready for model calls.".to_string()
            } else {
                "Saved OAuth is not API-ready. Browser login needs OPENAI_OAUTH_CLIENT_ID."
                    .to_string()
            };
        }
        return if browser_oauth_available {
            "Saved browser OAuth found.".to_string()
        } else {
            "Saved browser OAuth found. New browser login needs OPENAI_OAUTH_CLIENT_ID.".to_string()
        };
    }
    if auth_label.starts_with("api-key-") {
        return if browser_oauth_available {
            "API key ready. Browser OAuth is also available.".to_string()
        } else {
            "API key ready. /auth login may use device OAuth.".to_string()
        };
    }
    "OpenAI auth loaded.".to_string()
}

fn build_auth_launcher_next_lines(
    auth_label: Option<&str>,
    browser_oauth_available: bool,
) -> Vec<String> {
    let Some(auth_label) = auth_label else {
        return if browser_oauth_available {
            vec![
                "/auth login starts OAuth.".to_string(),
                "/auth key opens secure API key entry.".to_string(),
            ]
        } else {
            vec![
                "/auth login may use device OAuth.".to_string(),
                "/auth key opens secure API key entry.".to_string(),
            ]
        };
    };
    if auth_label == "none" {
        return if browser_oauth_available {
            vec![
                "/auth login starts OAuth.".to_string(),
                "/auth key opens secure API key entry.".to_string(),
            ]
        } else {
            vec![
                "/auth login may use device OAuth.".to_string(),
                "/auth key opens secure API key entry.".to_string(),
            ]
        };
    }
    if auth_label.starts_with("oauth-") {
        if auth_label.ends_with("-api-blocked") {
            return if browser_oauth_available {
                vec![
                    "/auth status inspects recovery.".to_string(),
                    "/auth login starts API-ready OAuth.".to_string(),
                    "/auth key opens secure API key entry.".to_string(),
                ]
            } else {
                vec![
                    "/auth status inspects recovery.".to_string(),
                    "/auth key opens secure API key entry.".to_string(),
                ]
            };
        }
        return vec![
            "/auth status inspects auth.".to_string(),
            "/auth logout switches auth.".to_string(),
        ];
    }
    if auth_label.starts_with("api-key-") {
        return if browser_oauth_available {
            vec![
                "/auth status inspects auth.".to_string(),
                "/auth login starts OAuth or /auth logout switches auth.".to_string(),
            ]
        } else {
            vec![
                "/auth status inspects auth.".to_string(),
                "/auth login may use device OAuth.".to_string(),
            ]
        };
    }
    vec!["/auth status inspects auth.".to_string()]
}

fn extract_auth_label(lines: &[String]) -> Option<&str> {
    lines.iter().find_map(|line| {
        extract_auth_label_line(line)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn extract_auth_route(lines: &[String]) -> Option<&str> {
    lines.iter().find_map(|line| {
        strip_ci_prefix(line.trim(), "Route:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn parse_auth_status_line(lines: &[String], key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    lines.iter().find_map(|line| {
        strip_ci_prefix(line.trim(), &prefix)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn extract_auth_label_line(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    strip_ci_prefix(trimmed, "Auth:")
        .or_else(|| strip_ci_prefix(trimmed, "Source:"))
        .or_else(|| strip_ci_prefix(trimmed, "Auth source:"))
}

fn is_missing_oauth_client_id(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("openai_oauth_client_id is required for oauth login")
        || lower.contains("openai_oauth_client_id is required for browser login")
        || lower.contains("browser oauth unavailable")
}

struct ModelPickerCurrent {
    reasoning: String,
    support: Option<String>,
}

fn parse_current_model_description(description: &str) -> ModelPickerCurrent {
    let normalized = format_model_suggestion_description(description);
    if normalized.eq_ignore_ascii_case("Reasoning unavailable") {
        return ModelPickerCurrent {
            reasoning: "unavailable".to_string(),
            support: None,
        };
    }
    let current = strip_ci_prefix(&normalized, "Current · ").unwrap_or(&normalized);
    let (reasoning_part, support) = current
        .split_once(" · supports ")
        .map(|(reasoning, support)| (reasoning, Some(support.to_string())))
        .unwrap_or((current, None));
    let reasoning = strip_ci_prefix(reasoning_part, "reasoning default ")
        .or_else(|| strip_ci_prefix(reasoning_part, "default "))
        .map(|effort| format!("default {}", effort.trim()))
        .unwrap_or_else(|| reasoning_part.trim().to_string());
    ModelPickerCurrent { reasoning, support }
}

fn compact_model_suggestion_description(description: &str) -> String {
    let normalized = format_model_suggestion_description(description);
    if normalized.eq_ignore_ascii_case("Reasoning unavailable") {
        return "reasoning unavailable".to_string();
    }
    let stripped = strip_ci_prefix(&normalized, "Current · ")
        .or_else(|| strip_ci_prefix(&normalized, "Default · "))
        .or_else(|| strip_ci_prefix(&normalized, "Available · "))
        .unwrap_or(&normalized);
    let active = strip_ci_prefix(&normalized, "Current · ").is_some();
    let reasoning_part = stripped
        .split_once(" · supports ")
        .map(|(reasoning, _)| reasoning)
        .unwrap_or(stripped)
        .trim();
    let effort = strip_ci_prefix(reasoning_part, "reasoning default ")
        .or_else(|| strip_ci_prefix(reasoning_part, "default "))
        .or_else(|| strip_ci_prefix(reasoning_part, "reasoning "))
        .unwrap_or(reasoning_part)
        .trim();
    if active {
        format!("active · reasoning {effort}")
    } else {
        format!("reasoning {effort}")
    }
}

fn model_picker_reasoning_choice_line(current_meta: &ModelPickerCurrent) -> String {
    match current_meta.support.as_deref() {
        Some(support) if !support.trim().is_empty() => {
            format!("Thinking choices · {} / default", support.replace(", ", " / "))
        }
        _ if current_meta.reasoning.eq_ignore_ascii_case("unavailable") => {
            "Thinking choices · unavailable for this model".to_string()
        }
        _ => "Thinking choices · low / medium / high / default".to_string(),
    }
}

fn format_model_suggestion_description(description: &str) -> String {
    let lower = description.to_ascii_lowercase();
    if lower.contains("reasoning unsupported") || lower.contains("reasoning unavailable") {
        "Reasoning unavailable".to_string()
    } else {
        description.trim().to_string()
    }
}

fn strip_ci_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
}

fn clamp_index(selected_index: usize, count: usize) -> usize {
    if count == 0 {
        0
    } else {
        selected_index.min(count - 1)
    }
}

fn compact_preview(input: &str, max_chars: usize) -> String {
    let normalized = input.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_display_width(&normalized, max_chars)
}

fn compact_context_value(input: &str, max_chars: usize) -> String {
    let normalized = input
        .trim()
        .replace("Auth issue: ", "")
        .replace("Loaded guidance: ", "")
        .replace("Loaded extension: ", "ext ")
        .replace("Loaded skills: ", "skills ")
        .replace("Skill catalog: ", "skills ")
        .replace("AGENTS.md: ", "AGENTS: ")
        .replace("CLAUDE.md: ", "CLAUDE: ");
    compact_preview(&normalized, max_chars)
}

fn array_field(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn array_field_preserve_empty(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn dedupe_strings(lines: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for line in lines {
        if !result.contains(&line) {
            result.push(line);
        }
    }
    result
}

fn summarize_context_sources(
    guidance_lines: &[String],
    bridge_lines: &[String],
    memory_lines: &[String],
) -> Vec<String> {
    let mut sources = Vec::new();
    if !guidance_lines.is_empty() {
        sources.push("guidance".to_string());
    }
    if !bridge_lines.is_empty() {
        sources.push("bridge".to_string());
    }
    if !memory_lines.is_empty() {
        sources.push("memory".to_string());
    }
    if sources.is_empty() {
        sources.push("none".to_string());
    }
    sources
}

fn summarize_context_health(
    context_lines: &[String],
    bridge_lines: &[String],
    memory_lines: &[String],
    live_lines: &[String],
) -> Vec<String> {
    let mut health = Vec::new();
    let all_lines = context_lines
        .iter()
        .chain(bridge_lines.iter())
        .chain(memory_lines.iter())
        .chain(live_lines.iter())
        .map(|line| line.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if all_lines.iter().any(|line| line.contains("auth issue:")) {
        health.push("auth issue".to_string());
    }
    if all_lines.iter().any(|line| {
        line.contains("no agents.md")
            || line.contains("no workspace context")
            || line.contains("missing context")
            || line.contains("not found")
    }) {
        health.push("missing source".to_string());
    }
    if all_lines
        .iter()
        .any(|line| line.contains("stale") || line.contains("reload") || line.contains("refresh"))
    {
        health.push("refreshable".to_string());
    }
    if health.is_empty() {
        health.push("ready".to_string());
    }
    health
}

fn harness_panel(input: &Value) -> Value {
    let mode = str_field(input, "mode").unwrap_or("default");
    let worker_budget = input
        .get("workerBudget")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let auto_continue = bool_field(input, "autoContinue");
    json!({
        "title": "Harness",
        "lines": [
            "Runtime",
            format!("Mode · {mode}"),
            format!("Workers · {worker_budget} max"),
            format!("Auto-continue · {}", if auto_continue { "enabled" } else { "disabled" }),
            "",
            "Commands",
            "unclecode harness status — full config",
            "unclecode harness apply yolo — low friction",
            "/mode set <profile> — change mode"
        ]
    })
}

fn skills_panel(input: &Value) -> Value {
    let mut lines = Vec::new();
    let skills = input.get("skills").and_then(Value::as_array);
    if let Some(skills) = skills {
        for skill in skills.iter().take(12) {
            let name = str_field(skill, "name").unwrap_or("skill");
            let scope = str_field(skill, "scope").unwrap_or("project");
            lines.push(format!("{name} · {scope}"));
            if let Some(summary) = str_field(skill, "summary").filter(|value| !value.is_empty()) {
                lines.push(format!("  {summary}"));
            }
        }
    }
    if lines.is_empty() {
        lines.push("No skills found.".to_string());
    }
    json!({ "title": "Skills", "lines": lines })
}

fn loaded_skill_panel(input: &Value) -> Value {
    let name = str_field(input, "name").unwrap_or("skill");
    let content = str_field(input, "content").unwrap_or("");
    let lines = content.lines().take(12).collect::<Vec<_>>();
    json!({ "title": format!("Skill · {name}"), "lines": lines })
}

fn memories_panel(input: &Value) -> Value {
    let session_memory = array_field(input, "sessionMemory");
    let project_memory = array_field(input, "projectMemory");
    let mut lines = vec!["Session".to_string()];
    if session_memory.is_empty() {
        lines.push("No session memories yet.".to_string());
    } else {
        lines.extend(session_memory);
    }
    lines.extend(["".to_string(), "Project".to_string()]);
    if project_memory.is_empty() {
        lines.push("No project memories yet.".to_string());
    } else {
        lines.extend(project_memory);
    }
    json!({ "title": "Memories", "lines": lines })
}

fn auth_secure_entry_panel(input: &Value) -> Value {
    let message = str_field(input, "message")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Paste key. Optional: --org <id> --project <id>.");
    json!({
        "title": "Auth",
        "lines": [
            "Current",
            "Secure API key entry.",
            "",
            "Next",
            message,
            "Enter saves · Esc cancels."
        ]
    })
}

fn auth_progress_panel(input: &Value) -> Value {
    let normalized_lines = array_field(input, "progressLines");
    if normalized_lines.is_empty() {
        return json!({
            "title": "Auth",
            "lines": ["Starting OAuth…", "Check the browser window."]
        });
    }

    let latest_code_line = normalized_lines
        .iter()
        .rev()
        .find(|line| line.starts_with("Enter code:"))
        .cloned();
    let latest_status_line = normalized_lines.last().cloned();
    let mut lines = Vec::new();
    if let Some(code_line) = latest_code_line.as_ref() {
        lines.push(code_line.clone());
    }
    if let Some(status_line) = latest_status_line.as_ref() {
        if Some(status_line) != latest_code_line.as_ref() {
            lines.push(status_line.clone());
        }
    }
    for line in normalized_lines {
        if Some(&line) != latest_code_line.as_ref() && Some(&line) != latest_status_line.as_ref() {
            lines.push(line);
        }
    }
    if latest_code_line.is_none() && latest_status_line.is_none() {
        lines.push("Check the browser window.".to_string());
    }
    json!({ "title": "Auth", "lines": lines })
}

fn model_suggestion_description(provider: &str, model: &str, current_model: &str) -> String {
    let active = model == current_model;
    if provider != "openai" {
        return if active {
            "Current · reasoning unavailable".to_string()
        } else {
            "Reasoning unavailable".to_string()
        };
    }
    let support = openai_reasoning_support(model);
    if support.status != "supported" {
        return if active {
            "Current · reasoning unavailable".to_string()
        } else {
            "Reasoning unavailable".to_string()
        };
    }
    let prefix = if active { "Current" } else { "Available" };
    format!(
        "{prefix} · reasoning default {} · supports {}",
        support
            .default_effort
            .unwrap_or_else(|| "medium".to_string()),
        support.supported_efforts.join(", ")
    )
}

fn auth_suggestions(entries: &[Value]) -> Vec<Value> {
    let mut matches = entries
        .iter()
        .filter(|entry| {
            let command = slash_command(entry);
            command.starts_with("/auth") || command == "/browser"
        })
        .cloned()
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        auth_order(slash_command(left))
            .cmp(&auth_order(slash_command(right)))
            .then_with(|| slash_command(left).cmp(slash_command(right)))
    });
    dedupe_suggestions(matches)
}

fn mode_suggestions(normalized: &str, entries: &[Value]) -> Vec<Value> {
    let mut suggestions = entries
        .iter()
        .filter(|entry| slash_command(entry) == "/mode status")
        .cloned()
        .collect::<Vec<_>>();
    suggestions.extend(MODE_PROFILE_IDS.iter().map(|mode| {
        json!({
            "command": format!("/mode set {mode}"),
            "description": if *mode == "yolo" {
                "Switch to YOLO mode.".to_string()
            } else {
                format!("Switch to {mode} mode.")
            }
        })
    }));
    suggestions
        .into_iter()
        .filter(|entry| {
            slash_command(entry)
                .to_ascii_lowercase()
                .starts_with(normalized)
        })
        .collect()
}

fn scored_suggestions(normalized: &str, entries: &[Value]) -> Vec<Value> {
    let tokens = normalized
        .split(' ')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let mut scored = entries
        .iter()
        .filter_map(|entry| {
            let command = slash_command(entry).to_ascii_lowercase();
            let score = if command.starts_with(normalized) {
                0
            } else if command.contains(normalized) {
                1
            } else if tokens.iter().all(|token| command.contains(token)) {
                2
            } else {
                return None;
            };
            Some((score, entry.clone()))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        left_score
            .cmp(right_score)
            .then_with(|| slash_command(left).len().cmp(&slash_command(right).len()))
            .then_with(|| slash_command(left).cmp(slash_command(right)))
    });
    dedupe_suggestions(scored.into_iter().map(|(_, entry)| entry).collect())
}

fn dedupe_suggestions(entries: Vec<Value>) -> Vec<Value> {
    let mut seen = Vec::<String>::new();
    let mut deduped = Vec::new();
    for entry in entries {
        let command = slash_command(&entry);
        if !seen.iter().any(|seen_command| seen_command == command) {
            seen.push(command.to_string());
            deduped.push(entry);
        }
    }
    deduped
}

fn auth_order(command: &str) -> usize {
    match command {
        "/auth status" => 0,
        "/auth login" => 1,
        "/auth key" => 2,
        "/auth logout" => 3,
        "/auth browser" => 4,
        "/browser" => 5,
        _ => 99,
    }
}

fn slash_command(entry: &Value) -> &str {
    entry.get("command").and_then(Value::as_str).unwrap_or("")
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn bool_field(input: &Value, key: &str) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn bool_field_default(input: &Value, key: &str, default: bool) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn number_field(input: &Value, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

fn normalize_status_detail(value: &str) -> String {
    let stripped = value
        .trim_start_matches(|ch: char| matches!(ch, '·' | '→' | '★' | '✓' | '✖' | '↔'))
        .trim();
    if stripped.is_empty() {
        return String::new();
    }
    let lower = stripped.to_ascii_lowercase();
    if lower.starts_with("read ") || lower.starts_with("write ") || lower.starts_with("search ")
    {
        return "Reading files".to_string();
    }
    if lower.starts_with("calling ") {
        return stripped
            .replacen("calling ", "model ", 1)
            .to_string();
    }
    if looks_like_internal_file_path(stripped) {
        return "Reading files".to_string();
    }
    stripped.to_string()
}

fn looks_like_internal_file_path(value: &str) -> bool {
    value.contains('/') && value.contains('.') && !value.contains(' ')
}

fn format_panel_duration(duration_ms: i64) -> String {
    let duration_ms = duration_ms.max(0);
    if duration_ms < 1000 {
        return format!("{duration_ms}ms");
    }
    if duration_ms < 10_000 {
        return format!("{:.1}s", duration_ms as f64 / 1000.0);
    }
    format!("{}s", duration_ms / 1000)
}

const MODE_PROFILE_IDS: &[&str] = &[
    "default",
    "ultrawork",
    "search",
    "analyze",
    "yolo",
    "plan",
    "build",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_work_board_with_backlog_and_steer_copy() {
        let panel = queue_panel(&json!({
            "isBusy": true,
            "busyStatus": "thinking",
            "mode": "yolo",
            "workerBudget": 4,
            "queuedCount": 2,
            "terminalColumns": 100,
            "activePromptPreview": "first active turn",
            "queuedItems": [
                {"id": 1, "line": "first queued follow-up"},
                {"id": 2, "line": "second queued follow-up"}
            ]
        }));
        let lines = panel.get("lines").and_then(Value::as_array).expect("lines");
        assert_eq!(
            panel.get("title").and_then(Value::as_str),
            Some("Work board")
        );
        assert!(lines.iter().any(|line| line.as_str() == Some("Board")));
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("Queued · 2"))));
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("Running · 1"))));
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("#1 first queued"))));
        assert!(lines.iter().any(|line| line == "Steer"));
        assert!(lines.iter().any(|line| line.as_str().is_some_and(|value| value
            .contains("Enter queues follow-up"))));
    }

    #[test]
    fn builds_work_board_queue_paused_blocked_column() {
        let panel = queue_panel(&json!({
            "isBusy": false,
            "queuePaused": true,
            "queuedCount": 2,
            "terminalColumns": 100,
            "queuedItems": [
                {"id": 1, "line": "second"},
                {"id": 2, "line": "third"}
            ]
        }));
        let lines = panel.get("lines").and_then(Value::as_array).expect("lines");
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("Blocked · 1"))));
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("pause · 2 queued"))));
        assert!(lines.iter().any(|line| line.as_str().is_some_and(|value| value
            .contains("Queue paused after interrupt"))));
    }

    #[test]
    fn builds_work_board_two_by_two_layout_at_80_columns() {
        let panel = queue_panel(&json!({
            "isBusy": true,
            "busyStatus": "thinking",
            "queuedCount": 1,
            "terminalColumns": 80,
            "queuedItems": [{"id": 1, "line": "queued follow-up"}],
            "lastCompletedTurn": {"user": "hi", "assistant": "hello there"}
        }));
        let lines = panel.get("lines").and_then(Value::as_array).expect("lines");
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("Queued · 1"))));
        assert!(!lines.iter().any(|line| line.as_str().is_some_and(|value| {
            value.contains("Queued · 1") && value.contains("Done · 1")
        })));
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("Done · 1"))));
        assert!(lines
            .iter()
            .any(|line| line.as_str().is_some_and(|value| value.contains("hi → hello"))));
    }

    #[test]
    fn builds_context_panel_with_sources_and_health() {
        let panel = context_panel(&json!({
            "contextSummaryLines": [
                "Auth issue: OpenAI token needs refresh.",
                "Loaded guidance: AGENTS.md, UNCLECODE.md",
                "AGENTS.md: Follow repository instructions."
            ],
            "bridgeLines": ["project-context bridge ready"],
            "memoryLines": ["Memory: recent Rust porting work"],
            "traceLines": ["provider.calling · openai"],
            "expanded": true
        }));
        let lines = panel.get("lines").and_then(Value::as_array).expect("lines");
        assert!(lines
            .iter()
            .any(|line| line == "Sources · guidance · bridge · memory"));
        assert!(lines
            .iter()
            .any(|line| line == "Health · auth issue · refreshable"));
        assert!(lines.iter().any(|line| line == "Issues"));
        assert!(lines.iter().any(|line| line == "Guidance"));
    }

    #[test]
    fn builds_inline_command_panel_titles_and_empty_output() {
        assert_eq!(
            inline_command_panel(&json!({"args":["doctor"],"lines":["ok"]}))
                .get("title")
                .and_then(Value::as_str),
            Some("Doctor")
        );
        let auth = inline_command_panel(
            &json!({"args":["auth","login","--api-key","sk-secret"],"lines":["signed in"]}),
        );
        assert_eq!(auth.get("title").and_then(Value::as_str), Some("Auth"));
        let mcp = inline_command_panel(&json!({"args":["mcp","list"],"lines":[]}));
        assert_eq!(mcp.get("title").and_then(Value::as_str), Some("MCP"));
        assert!(mcp
            .get("lines")
            .and_then(Value::as_array)
            .expect("lines")
            .iter()
            .any(|line| line == "No output."));
    }

    #[test]
    fn formats_inline_command_summary_from_panel_contract() {
        assert_eq!(
            format_inline_command_summary_json(
                r#"{"args":["doctor"],"lines":["Doctor summary","config PASS","auth PASS"]}"#,
            )
            .unwrap(),
            "Doctor · Doctor summary · config PASS"
        );
        assert_eq!(
            format_inline_command_summary_json(r#"{"args":["mcp","list"],"lines":[]}"#).unwrap(),
            "MCP · No output."
        );
    }

    #[test]
    fn builds_model_picker_panel_from_slash_suggestions() {
        let panel = model_picker_panel(&json!({
            "suggestions": [
                {"command": "/model", "description": "Show the current model and available model picks."},
                {"command": "/model list", "description": "List available models and reasoning support."},
                {"command": "/model gpt-5.4", "description": "Current · reasoning default medium · supports low, medium, high"},
                {"command": "/model gpt-5.4-mini", "description": "Available · reasoning default medium · supports low, medium, high"}
            ],
            "selectedIndex": 2
        }));
        assert_eq!(
            panel.get("title").and_then(Value::as_str),
            Some("Model picker")
        );
        assert_eq!(
            panel.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("Current model"),
                json!("Model · gpt-5.4"),
                json!("Thinking · default medium"),
                json!("Thinking choices · low / medium / high / default"),
                json!("Supports · low, medium, high"),
                json!(""),
                json!("Pick model"),
                json!("› /model gpt-5.4  active · reasoning medium"),
                json!("  /model gpt-5.4-mini  reasoning medium"),
                json!(""),
                json!("Controls"),
                json!("↑↓ choose model · Enter switch · append low/medium/high/default · Esc close"),
            ]
        );
    }

    #[test]
    fn model_picker_selects_first_model_when_root_model_command_is_selected() {
        let panel = model_picker_panel(&json!({
            "suggestions": [
                {"command": "/model", "description": "Show the current model and available model picks."},
                {"command": "/model list", "description": "List available models and reasoning support."},
                {"command": "/model gpt-5.4", "description": "Current · reasoning default medium · supports low, medium, high"},
                {"command": "/model gpt-5.4-mini", "description": "Available · reasoning default medium · supports low, medium, high"}
            ],
            "selectedIndex": 0
        }));
        let lines = panel.get("lines").and_then(Value::as_array).unwrap();
        assert!(lines.contains(&json!("› /model gpt-5.4  active · reasoning medium")));
        assert!(lines.contains(&json!("  /model gpt-5.4-mini  reasoning medium")));
    }

    #[test]
    fn model_picker_reports_no_matches_without_dead_selection() {
        let panel = model_picker_panel(&json!({
            "input": "/model gkdl",
            "currentModel": "gpt-5.4",
            "suggestions": [
                {"command": "/model list", "description": "List available models and reasoning support."}
            ],
            "selectedIndex": 0
        }));
        let lines = panel.get("lines").and_then(Value::as_array).unwrap();
        assert!(lines.contains(&json!("Current model")));
        assert!(lines.contains(&json!("Model · gpt-5.4")));
        assert!(lines.contains(&json!("Filter")));
        assert!(lines.contains(&json!("Query · gkdl")));
        assert!(lines.contains(&json!("No model id matches gkdl. Current model unchanged.")));
        assert!(lines.contains(&json!("Backspace edit · Enter keeps current · Esc close")));
        assert!(!lines.iter().any(|line| {
            line.as_str()
                .map(|value| value.starts_with('›'))
                .unwrap_or(false)
        }));
    }

    #[test]
    fn builds_general_commands_panel_from_slash_suggestions() {
        let panel = commands_panel(&json!({
            "input": "/re",
            "suggestions": [
                {
                    "command": "/reload",
                    "description": "Reload workspace guidance, skills, and extension context."
                },
                {
                    "command": "/review",
                    "description": "Run a focused review prompt."
                }
            ],
            "selectedIndex": 0
        }));
        assert_eq!(panel.get("title").and_then(Value::as_str), Some("Commands"));
        assert_eq!(
            panel.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("/re matches"),
                json!(""),
                json!("› /reload  Reload workspace guidance, skills, and extension context."),
                json!("  /review  Run a focused review prompt."),
                json!(""),
                json!("↑↓ move · Enter run"),
            ]
        );
    }

    #[test]
    fn builds_general_commands_panel_no_match_copy() {
        let panel = commands_panel(&json!({
            "input": "/zz",
            "suggestions": [],
            "selectedIndex": 0
        }));
        assert_eq!(panel.get("title").and_then(Value::as_str), Some("Commands"));
        assert_eq!(
            panel.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("No matches for /zz."),
                json!(""),
                json!("Try /model, /auth, /queue, or /context."),
            ]
        );
    }

    #[test]
    fn builds_help_and_status_panels() {
        let help = help_panel();
        assert_eq!(
            help.get("title").and_then(Value::as_str),
            Some("Work-first shell")
        );
        let help_lines = help
            .get("lines")
            .and_then(Value::as_array)
            .expect("help lines")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(help_lines.contains("/model"));
        assert!(help_lines.contains("/harness"));

        let status = status_panel(&json!({
            "provider": "openai",
            "model": "gpt-5.4",
            "mode": "default",
            "cwd": "/repo",
            "reasoningLabel": "medium (mode-default)",
            "authLabel": "api-key-env",
            "contextSummaryLines": [
                "Loaded guidance: AGENTS.md",
                "Auth issue: OAuth token missing model.request scope"
            ],
            "bridgeLines": ["project-context bridge ready"],
            "memoryLines": ["project memory ready"],
            "route": {
                "providerId": "openai",
                "label": "OpenAI",
                "transport": "native",
                "runtimeSupported": true,
                "endpointUrl": "https://api.openai.com/v1/responses",
                "proxyPolicy": {
                    "targetHost": "api.openai.com",
                    "proxyUrl": null,
                    "source": "none",
                    "bypassed": false,
                    "noProxy": []
                }
            }
        }));
        assert_eq!(
            status.get("title").and_then(Value::as_str),
            Some("Session status")
        );
        assert_eq!(
            status.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("Current"),
                json!("Provider · openai"),
                json!("Model · gpt-5.4"),
                json!("Reasoning · medium (mode-default)"),
                json!("Mode · default"),
                json!("Auth · API key · env"),
                json!(""),
                json!("Route"),
                json!("Runtime · OpenAI (openai) · native"),
                json!("Endpoint · https://api.openai.com/v1/responses"),
                json!("Proxy · direct to api.openai.com"),
                json!(""),
                json!("Context"),
                json!("Sources · guidance · bridge · memory"),
                json!("Health · auth issue"),
                json!("Issue · OAuth token missing model.request scope"),
                json!("Guide · AGENTS.md"),
                json!(""),
                json!("Workspace"),
                json!("Cwd · /repo"),
            ]
        );
    }

    #[test]
    fn status_panel_redacts_proxy_credentials() {
        let status = status_panel(&json!({
            "provider": "openai",
            "model": "gpt-5.4",
            "mode": "default",
            "cwd": "/repo",
            "reasoningLabel": "medium (mode-default)",
            "authLabel": "api-key-env",
            "route": {
                "providerId": "openai",
                "label": "OpenAI",
                "transport": "native",
                "runtimeSupported": true,
                "endpointUrl": "https://api.openai.com/v1/responses",
                "proxyPolicy": {
                    "targetHost": "api.openai.com",
                    "proxyUrl": "http://user:secret@proxy.local:8080",
                    "source": "HTTPS_PROXY",
                    "bypassed": false,
                    "noProxy": []
                }
            }
        }));
        let lines = status.get("lines").and_then(Value::as_array).unwrap();
        assert!(lines.contains(&json!(
            "Proxy · HTTPS_PROXY via http://redacted@proxy.local:8080/"
        )));
        assert!(!lines
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("secret")));
    }

    #[test]
    fn status_panel_shows_live_activity_when_available() {
        let status = status_panel(&json!({
            "provider": "openai",
            "model": "gpt-5.4",
            "mode": "default",
            "cwd": "/repo",
            "reasoningLabel": "medium (mode-default)",
            "authLabel": "api-key-env",
            "isBusy": true,
            "busyStatus": "· thinking inspect repo",
            "currentTurnStartedAt": 1000,
            "nowMs": 2480
        }));
        let lines = status.get("lines").and_then(Value::as_array).unwrap();
        assert!(lines.contains(&json!("Activity")));
        assert!(lines.contains(&json!("State · running")));
        assert!(lines.contains(&json!("Now · thinking inspect repo")));
        assert!(lines.contains(&json!("Elapsed · 1.5s")));
    }

    #[test]
    fn status_panel_marks_compat_unsupported_runtime_once() {
        let status = status_panel(&json!({
            "provider": "ollama",
            "model": "qwen3",
            "mode": "default",
            "cwd": "/repo",
            "reasoningLabel": "unsupported",
            "authLabel": "none",
            "route": {
                "providerId": "ollama",
                "label": "Ollama",
                "transport": "compat",
                "runtimeSupported": false,
                "endpointUrl": "http://localhost:11434/api/chat",
                "proxyPolicy": {
                    "targetHost": "localhost",
                    "proxyUrl": null,
                    "source": "NO_PROXY",
                    "bypassed": true,
                    "noProxy": ["localhost"]
                }
            }
        }));
        let lines = status.get("lines").and_then(Value::as_array).unwrap();
        assert!(lines.contains(&json!("Runtime · Ollama (ollama) · compat · unsupported")));
        assert!(!lines.iter().any(|line| line
            .as_str()
            .unwrap_or("")
            .contains("unsupported · unsupported")));
    }

    #[test]
    fn builds_recent_sessions_panels() {
        assert_eq!(
            sessions_panel(&json!({"loading": true}))
                .get("lines")
                .and_then(Value::as_array)
                .unwrap(),
            &vec![json!("Loading sessions…")]
        );
        let empty = sessions_panel(&json!({"lines": []}));
        assert_eq!(
            empty.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("No recent sessions found."),
                json!("Run unclecode work to start one, then press Esc here to resume."),
                json!("Use /context for workspace guidance and memory.")
            ]
        );
        let loaded = sessions_panel(&json!({"lines": ["session-1", "session-2"]}));
        assert_eq!(
            loaded.get("title").and_then(Value::as_str),
            Some("Recent sessions")
        );
        assert_eq!(
            loaded.get("lines").and_then(Value::as_array).unwrap(),
            &vec![json!("session-1"), json!("session-2")]
        );
    }

    #[test]
    fn builds_auth_picker_panel_with_launcher_and_routes() {
        let panel = auth_picker_panel(&json!({
            "suggestions": [
                {"command": "/auth status", "description": "Show auth source."},
                {"command": "/auth login", "description": "Sign in with browser OAuth."}
            ],
            "selectedIndex": 1,
            "authLabel": "oauth-file",
            "browserOAuthAvailable": true
        }));
        assert_eq!(panel.get("title").and_then(Value::as_str), Some("Auth"));
        assert_eq!(
            panel
                .get("lines")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .take(12)
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                json!("Current"),
                json!("Auth · Browser OAuth · file"),
                json!("Route · Browser OAuth"),
                json!("Saved browser OAuth found."),
                json!(""),
                json!("Next"),
                json!("/auth status inspects auth."),
                json!("/auth logout switches auth."),
                json!(""),
                json!("Routes"),
                json!("  /auth status  Show auth source."),
                json!("› /auth login  Sign in with browser OAuth."),
            ]
        );
    }

    #[test]
    fn normalizes_remembered_auth_launcher_lines() {
        let panel = auth_picker_panel(&json!({
            "suggestions": [
                {"command": "/auth status", "description": "Show auth source."},
                {"command": "/auth logout", "description": "Clear stored auth."}
            ],
            "selectedIndex": 0,
            "authLabel": "oauth-file",
            "browserOAuthAvailable": false,
            "authLauncherLines": [
                "Saved auth found.",
                "Auth: oauth-file",
                "Use `unclecode auth status` to inspect it."
            ]
        }));
        assert_eq!(
            panel
                .get("lines")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .take(11)
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                json!("Current"),
                json!("Auth · Browser OAuth · file"),
                json!("Route · Device OAuth"),
                json!("Saved browser OAuth found. New browser login needs OPENAI_OAUTH_CLIENT_ID."),
                json!("Browser OAuth unavailable in this shell."),
                json!(""),
                json!("Next"),
                json!("/auth status inspects auth."),
                json!("/auth logout switches auth."),
                json!(""),
                json!("Routes"),
            ]
        );
    }

    #[test]
    fn auth_launcher_lines_mark_api_blocked_oauth() {
        let out = resolve_auth_launcher_lines_json(
            &json!({
                "mode": "default",
                "authLabel": "oauth-file-api-blocked",
                "browserOAuthAvailable": false
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("Current"),
                json!("Auth · OAuth file · API blocked"),
                json!("Route · Device OAuth"),
                json!("Saved OAuth is not API-ready. Browser login needs OPENAI_OAUTH_CLIENT_ID."),
                json!("Browser OAuth unavailable in this shell."),
                json!(""),
                json!("Next"),
                json!("/auth status inspects recovery."),
                json!("/auth key opens secure API key entry."),
            ]
        );
    }

    #[test]
    fn resolves_browser_auth_failure_lines_with_extra_args() {
        let out = resolve_auth_browser_failure_lines_json(
            &json!({
                "args": ["auth", "login", "--browser", "--force"],
                "lines": ["Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID."],
                "failed": true,
                "authLabel": "api-key-env"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("Current"),
                json!("Auth · API key · env"),
                json!("Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID."),
                json!(""),
                json!("Next"),
                json!("/auth status inspects auth or /auth logout switches."),
                json!("/auth key opens secure API key entry."),
            ]
        );
    }

    #[test]
    fn extracts_auth_label_from_status_lines() {
        assert_eq!(
            extract_auth_label_json(
                &json!([
                    "Provider: openai",
                    "Source: oauth-file",
                    "Auth: api-key-env"
                ])
                .to_string()
            )
            .unwrap(),
            r#"{"authLabel":"oauth-file"}"#
        );
        assert_eq!(
            extract_auth_label_json(&json!({"lines": ["Auth source: api-key-file"]}).to_string())
                .unwrap(),
            r#"{"authLabel":"api-key-file"}"#
        );
        assert_eq!(
            extract_auth_label_json("[]").unwrap(),
            r#"{"authLabel":null}"#
        );
    }

    #[test]
    fn preserves_auth_launcher_section_spacing() {
        let panel = auth_picker_panel(&json!({
            "suggestions": [
                {"command": "/auth status", "description": "Show auth source."},
                {"command": "/auth login", "description": "Sign in with browser OAuth."}
            ],
            "selectedIndex": 1,
            "authLabel": "oauth-file",
            "browserOAuthAvailable": true,
            "authLauncherLines": [
                "Current",
                "Auth · Browser OAuth · file",
                "Browser OAuth needs refresh.",
                "",
                "Next",
                "/auth login refreshes this shell.",
                "/auth logout clears stale auth if needed."
            ]
        }));
        assert_eq!(
            panel
                .get("lines")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .take(12)
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                json!("Current"),
                json!("Auth · Browser OAuth · file"),
                json!("Route · Browser OAuth"),
                json!("Browser OAuth needs refresh."),
                json!(""),
                json!("Next"),
                json!("/auth login refreshes this shell."),
                json!("/auth logout clears stale auth if needed."),
                json!(""),
                json!("Routes"),
                json!("  /auth status  Show auth source."),
                json!("› /auth login  Sign in with browser OAuth."),
            ]
        );
    }

    #[test]
    fn builds_memories_panel_with_empty_fallbacks() {
        let populated = memories_panel(&json!({
            "sessionMemory": ["session-1"],
            "projectMemory": ["project-1"]
        }));
        assert_eq!(
            populated.get("title").and_then(Value::as_str),
            Some("Memories")
        );
        assert_eq!(
            populated.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("Session"),
                json!("session-1"),
                json!(""),
                json!("Project"),
                json!("project-1"),
            ]
        );

        let empty = memories_panel(&json!({}));
        let lines = empty.get("lines").and_then(Value::as_array).unwrap();
        assert!(lines.iter().any(|line| line == "No session memories yet."));
        assert!(lines.iter().any(|line| line == "No project memories yet."));
    }

    #[test]
    fn builds_auth_panels() {
        let secure = auth_secure_entry_panel(&json!({}));
        assert_eq!(secure.get("title").and_then(Value::as_str), Some("Auth"));
        assert_eq!(
            secure.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("Current"),
                json!("Secure API key entry."),
                json!(""),
                json!("Next"),
                json!("Paste key. Optional: --org <id> --project <id>."),
                json!("Enter saves · Esc cancels."),
            ]
        );

        let pending = auth_progress_panel(&json!({ "progressLines": [] }));
        assert_eq!(
            pending.get("lines").and_then(Value::as_array).unwrap(),
            &vec![json!("Starting OAuth…"), json!("Check the browser window.")]
        );

        let progress = auth_progress_panel(&json!({
            "progressLines": [
                "Opening browser…",
                "Enter code: ABCD-1234",
                "Waiting for device approval…"
            ]
        }));
        assert_eq!(
            progress.get("lines").and_then(Value::as_array).unwrap(),
            &vec![
                json!("Enter code: ABCD-1234"),
                json!("Waiting for device approval…"),
                json!("Opening browser…"),
            ]
        );
    }

    #[test]
    fn builds_model_suggestions_with_current_first() {
        let output = build_model_suggestions_json("openai", "gpt-5.4", "/model").expect("json");
        let parsed: Value = serde_json::from_str(&output).expect("parsed");
        let entries = parsed.as_array().expect("entries");
        assert_eq!(
            entries[0].get("command").and_then(Value::as_str),
            Some("/model gpt-5.4")
        );
        assert!(entries[0]
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("Current"));
        assert!(entries
            .iter()
            .any(|entry| entry.get("command").and_then(Value::as_str) == Some("/model list")));
    }

    #[test]
    fn scores_general_slash_suggestions_and_keeps_auth_order() {
        let entries = r#"[
            {"command":"/auth logout","description":"logout"},
            {"command":"/queue","description":"queue"},
            {"command":"/auth status","description":"status"},
            {"command":"/auth login","description":"login"},
            {"command":"/auth key","description":"key"}
        ]"#;
        let auth = build_slash_suggestions_json("/auth", entries).expect("auth");
        let parsed: Value = serde_json::from_str(&auth).expect("json");
        let commands = parsed
            .as_array()
            .expect("array")
            .iter()
            .map(slash_command)
            .collect::<Vec<_>>();
        assert_eq!(commands[..3], ["/auth status", "/auth login", "/auth key"]);

        let queue = build_slash_suggestions_json("/qu", entries).expect("queue");
        assert!(queue.contains("/queue"));
    }
}
