use crate::aci::{view_text_file, write_text_file};
use crate::aci_patch::apply_unified_patch;
use crate::aci_search::{glob_files, search_text};
use crate::anthropic_request::{
    build_anthropic_messages_request_json, build_anthropic_messages_request_spec_with_base,
    parse_anthropic_response_json_for_model, provider_query_messages_to_anthropic_json,
};
use crate::gemini_request::{
    build_gemini_generate_content_request_spec_with_base,
    build_gemini_generate_content_rest_request_json, parse_gemini_response_json_for_model,
    provider_query_messages_to_gemini_json, tool_definitions_to_gemini_function_declarations_json,
};
use crate::http_transport::post_json_with_headers;
use crate::openai_query::run_openai_chat_query_json;
use crate::provider_transport::headers_json;
use crate::sha256::sha256_hex;
use crate::team_runtime::append_team_action_checkpoint;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SUBMIT_MARKER: &str = "__UNCLECODE_SUBMIT__";
const RUN_SHELL_TIMEOUT_MS: u64 = 60_000;
const RUN_SHELL_OUTPUT_CAP_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq)]
struct MiniLoopAction {
    call_id: String,
    tool: String,
    input: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MiniLoopObservation {
    stdout: String,
    stderr: String,
    exit_code: i32,
    truncated: bool,
}

struct PersonaConfig {
    system_prompt: &'static str,
    step_limit: usize,
    cost_limit_usd: f64,
    allowed_tools: &'static [&'static str],
}

pub struct TeamMiniLoopRequest {
    pub runtime: String,
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub run_root: PathBuf,
    pub run_id: String,
    pub worker_id: String,
    pub persona: String,
    pub task: String,
    pub cwd: PathBuf,
    pub reasoning_effort: Option<String>,
}

pub struct TeamMiniLoopResult {
    pub status: String,
    pub submission: String,
    pub steps: usize,
    pub cost_usd: f64,
}

pub struct ProviderMiniLoopRequest {
    pub runtime: String,
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub system_prompt: String,
    pub prompt: String,
    pub cwd: PathBuf,
    pub reasoning_effort: Option<String>,
    pub step_limit: usize,
    pub cost_limit_usd: f64,
    pub allowed_tools: Vec<String>,
    pub allow_run_shell: bool,
    pub checkpoint: Option<TeamMiniLoopCheckpoint>,
}

pub struct TeamMiniLoopCheckpoint {
    pub run_root: PathBuf,
    pub run_id: String,
    pub worker_id: String,
}

pub struct ProviderMiniLoopResult {
    pub status: String,
    pub submission: String,
    pub steps: usize,
    pub cost_usd: f64,
}

pub fn run_team_mini_loop(input: TeamMiniLoopRequest) -> Result<TeamMiniLoopResult, String> {
    let config = persona_config(&input.persona)?;
    let result = run_provider_mini_loop(ProviderMiniLoopRequest {
        runtime: input.runtime,
        api_key: input.api_key,
        model: input.model,
        base_url: input.base_url,
        system_prompt: config.system_prompt.to_string(),
        prompt: input.task,
        cwd: input.cwd,
        reasoning_effort: input.reasoning_effort,
        step_limit: config.step_limit,
        cost_limit_usd: config.cost_limit_usd,
        allowed_tools: config
            .allowed_tools
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
        allow_run_shell: true,
        checkpoint: Some(TeamMiniLoopCheckpoint {
            run_root: input.run_root,
            run_id: input.run_id,
            worker_id: input.worker_id,
        }),
    })?;
    Ok(TeamMiniLoopResult {
        status: result.status,
        submission: result.submission,
        steps: result.steps,
        cost_usd: result.cost_usd,
    })
}

pub fn run_provider_mini_loop(
    input: ProviderMiniLoopRequest,
) -> Result<ProviderMiniLoopResult, String> {
    let tools_json = tools_json_for_allowed(&input.allowed_tools);
    let mut messages = vec![
        json!({ "role": "system", "content": input.system_prompt }),
        json!({ "role": "user", "content": input.prompt }),
    ];
    let mut steps = 0_usize;
    let mut cost_usd = 0.0_f64;

    loop {
        if steps >= input.step_limit {
            return Ok(exit_result(
                "limits_exceeded",
                "step limit reached",
                steps,
                cost_usd,
            ));
        }
        if cost_usd >= input.cost_limit_usd {
            return Ok(exit_result(
                "limits_exceeded",
                "cost limit reached",
                steps,
                cost_usd,
            ));
        }

        let response = query_provider(&input, &messages, &tools_json)?;
        steps += 1;
        cost_usd += response.cost_usd;
        messages.push(assistant_message(
            &response.content,
            &response.actions,
            steps,
        ));

        if response.actions.is_empty() {
            return Ok(exit_result("submitted", &response.content, steps, cost_usd));
        }

        for action in response.actions {
            if !input.allowed_tools.iter().any(|tool| tool == &action.tool) {
                messages.push(tool_message(
                    &action,
                    &MiniLoopObservation {
                        stdout: String::new(),
                        stderr: format!("Tool \"{}\" is not allowed in this runtime", action.tool),
                        exit_code: -1,
                        truncated: false,
                    },
                    steps,
                ));
                continue;
            }

            let observation = execute_action(&action, &input.cwd, input.allow_run_shell);
            messages.push(tool_message(&action, &observation, steps));

            if let Some(submission) = detect_submit(&observation) {
                return Ok(exit_result("submitted", &submission, steps, cost_usd));
            }

            if let Some(checkpoint) = &input.checkpoint {
                append_team_action_checkpoint(
                    &checkpoint.run_root,
                    &checkpoint.run_id,
                    &checkpoint.worker_id,
                    steps,
                    &action.tool,
                    &sha256_hex(
                        &serde_json::to_string(&action.input).unwrap_or_else(|_| "{}".to_string()),
                    ),
                    &sha256_hex(&format!("{}{}", observation.stdout, observation.stderr)),
                )?;
            }
        }
    }
}

struct ModelResponse {
    content: String,
    actions: Vec<MiniLoopAction>,
    cost_usd: f64,
}

fn query_provider(
    input: &ProviderMiniLoopRequest,
    messages: &[Value],
    tools_json: &str,
) -> Result<ModelResponse, String> {
    let messages_json = serde_json::to_string(messages).map_err(|error| error.to_string())?;
    let raw = match input.runtime.as_str() {
        "openai" => run_openai_chat_query_json(
            &input.api_key,
            &input.model,
            "",
            &messages_json,
            tools_json,
            input.reasoning_effort.as_deref(),
            &input.base_url,
        )?,
        "anthropic" => query_anthropic(
            &input.api_key,
            &input.model,
            &input.base_url,
            &messages_json,
            tools_json,
        )?,
        "gemini" => query_gemini(
            &input.api_key,
            &input.model,
            &input.base_url,
            &messages_json,
            tools_json,
        )?,
        runtime => {
            return Err(format!(
                "provider mini-loop: unsupported SDK runtime {runtime}"
            ))
        }
    };
    parse_model_response(&raw)
}

fn query_anthropic(
    api_key: &str,
    model: &str,
    base_url: &str,
    messages_json: &str,
    tools_json: &str,
) -> Result<String, String> {
    let converted = provider_query_messages_to_anthropic_json(messages_json, "")?;
    let converted: Value = serde_json::from_str(&converted).map_err(|error| error.to_string())?;
    let system = converted
        .get("system")
        .and_then(Value::as_str)
        .unwrap_or("");
    let wire_messages = converted
        .get("messages")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .to_string();
    let body = build_anthropic_messages_request_json(model, system, &wire_messages, tools_json)?;
    let spec = build_anthropic_messages_request_spec_with_base(api_key, base_url);
    let response = post_json_with_headers(&spec.url, &headers_json(&spec.headers), &body)?;
    if !response.ok {
        return Err(format!(
            "Anthropic request failed with status {}: {}",
            response.status, response.body
        ));
    }
    parse_anthropic_response_json_for_model(&response.body, Some(model))
}

fn query_gemini(
    api_key: &str,
    model: &str,
    base_url: &str,
    messages_json: &str,
    tools_json: &str,
) -> Result<String, String> {
    let converted = provider_query_messages_to_gemini_json(messages_json, "")?;
    let converted: Value = serde_json::from_str(&converted).map_err(|error| error.to_string())?;
    let system_instruction = converted
        .get("systemInstruction")
        .and_then(Value::as_str)
        .unwrap_or("");
    let contents = converted
        .get("contents")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .to_string();
    let declarations = tool_definitions_to_gemini_function_declarations_json(tools_json)?;
    let include_tools = has_array_items(&declarations);
    let body = build_gemini_generate_content_rest_request_json(
        system_instruction,
        &contents,
        &declarations,
        include_tools,
    )?;
    let spec = build_gemini_generate_content_request_spec_with_base(api_key, model, base_url);
    let response = post_json_with_headers(&spec.url, &headers_json(&spec.headers), &body)?;
    if !response.ok {
        return Err(format!(
            "Gemini request failed with status {}: {}",
            response.status, response.body
        ));
    }
    parse_gemini_response_json_for_model(&response.body, Some(model))
}

fn parse_model_response(raw: &str) -> Result<ModelResponse, String> {
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid model response JSON: {error}"))?;
    let content = parsed
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let actions = parsed
        .get("actions")
        .and_then(Value::as_array)
        .map(|actions| {
            actions
                .iter()
                .filter_map(parse_action)
                .collect::<Vec<MiniLoopAction>>()
        })
        .unwrap_or_default();
    let cost_usd = parsed.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
    Ok(ModelResponse {
        content,
        actions,
        cost_usd,
    })
}

fn parse_action(value: &Value) -> Option<MiniLoopAction> {
    let tool = value
        .get("tool")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?
        .to_string();
    let call_id = value
        .get("callId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&tool)
        .to_string();
    let input = value.get("input").cloned().unwrap_or_else(|| json!({}));
    Some(MiniLoopAction {
        call_id,
        tool,
        input: if input.is_object() { input } else { json!({}) },
    })
}

fn assistant_message(content: &str, actions: &[MiniLoopAction], step: usize) -> Value {
    let mut message = json!({
        "role": "assistant",
        "content": content,
        "stepIndex": step,
    });
    if !actions.is_empty() {
        message["toolCalls"] = Value::Array(
            actions
                .iter()
                .map(|action| {
                    json!({
                        "callId": action.call_id,
                        "name": action.tool,
                        "argumentsJson": serde_json::to_string(&action.input).unwrap_or_else(|_| "{}".to_string()),
                    })
                })
                .collect(),
        );
    }
    message
}

fn tool_message(action: &MiniLoopAction, observation: &MiniLoopObservation, step: usize) -> Value {
    json!({
        "role": "tool",
        "content": if observation.stdout.is_empty() { &observation.stderr } else { &observation.stdout },
        "callId": action.call_id,
        "stepIndex": step,
    })
}

fn execute_action(
    action: &MiniLoopAction,
    cwd: &Path,
    allow_run_shell: bool,
) -> MiniLoopObservation {
    match action.tool.as_str() {
        "run_shell" => dispatch_run_shell(action, cwd, allow_run_shell),
        "read_file" => dispatch_read_file(action, cwd),
        "write_file" => dispatch_write_file(action, cwd),
        "search_text" => dispatch_search_text(action, cwd),
        "list_files" => dispatch_list_files(action, cwd),
        "apply_patch" => dispatch_apply_patch(action, cwd),
        _ => error_observation(&format!("Unknown tool: {}", action.tool)),
    }
}

fn dispatch_run_shell(
    action: &MiniLoopAction,
    cwd: &Path,
    allow_run_shell: bool,
) -> MiniLoopObservation {
    if !allow_run_shell {
        return error_observation(
            "run_shell is disabled by default. Set UNCLECODE_ALLOW_RUN_SHELL=1 to enable it.",
        );
    }
    let command = read_string(&action.input, "command");
    if command.trim().is_empty() {
        return error_observation("run_shell: empty command");
    }
    run_shell_observation(&command, cwd)
}

fn dispatch_read_file(action: &MiniLoopAction, cwd: &Path) -> MiniLoopObservation {
    let path = read_string(&action.input, "path");
    if path.is_empty() {
        return error_observation("read_file: missing path");
    }
    let window = action
        .input
        .get("window")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
        .unwrap_or(100);
    match view_text_file(cwd, &path, window) {
        Ok(view) => MiniLoopObservation {
            stdout: view.content,
            stderr: String::new(),
            exit_code: 0,
            truncated: view.total_lines > view.window_end,
        },
        Err(error) => error_observation(&format!("read_file: {error}")),
    }
}

fn dispatch_write_file(action: &MiniLoopAction, cwd: &Path) -> MiniLoopObservation {
    let path = read_string(&action.input, "path");
    if path.is_empty() {
        return error_observation("write_file: missing path");
    }
    let contents = read_string(&action.input, "contents");
    match write_text_file(cwd, &path, &contents) {
        Ok(()) => MiniLoopObservation {
            stdout: format!("wrote {} bytes to {path}", contents.len()),
            stderr: String::new(),
            exit_code: 0,
            truncated: false,
        },
        Err(error) => error_observation(&format!("write_file: {error}")),
    }
}

fn dispatch_search_text(action: &MiniLoopAction, cwd: &Path) -> MiniLoopObservation {
    let query = read_string(&action.input, "query");
    if query.is_empty() {
        return error_observation("search_text: missing query");
    }
    let path = read_string(&action.input, "path");
    let path = if path.is_empty() { "." } else { path.as_str() };
    match search_text(cwd, &query, path, 50) {
        Ok(result) => {
            let mut lines = result
                .hits
                .iter()
                .map(|hit| match (hit.line, hit.text.as_deref()) {
                    (Some(line), Some(text)) => format!("{}:{line}:{text}", hit.path),
                    _ => hit.path.clone(),
                })
                .collect::<Vec<_>>();
            if lines.is_empty() {
                lines.push("(no matches)".to_string());
            }
            if result.truncated {
                lines.push(format!(
                    "... {} total hits; refine query",
                    result.total_hits
                ));
            }
            MiniLoopObservation {
                stdout: lines.join("\n"),
                stderr: String::new(),
                exit_code: 0,
                truncated: result.truncated,
            }
        }
        Err(error) => error_observation(&format!("search_text: {error}")),
    }
}

fn dispatch_list_files(action: &MiniLoopAction, cwd: &Path) -> MiniLoopObservation {
    let pattern = read_string(&action.input, "pattern");
    let pattern = if pattern.is_empty() {
        "**/*"
    } else {
        pattern.as_str()
    };
    match glob_files(cwd, pattern, 50) {
        Ok(result) => {
            let mut lines = result
                .hits
                .iter()
                .map(|hit| hit.path.clone())
                .collect::<Vec<_>>();
            if lines.is_empty() {
                lines.push("(no matches)".to_string());
            }
            if result.truncated {
                lines.push(format!(
                    "... {} total hits; tighten pattern",
                    result.total_hits
                ));
            }
            MiniLoopObservation {
                stdout: lines.join("\n"),
                stderr: String::new(),
                exit_code: 0,
                truncated: result.truncated,
            }
        }
        Err(error) => error_observation(&format!("list_files: {error}")),
    }
}

fn dispatch_apply_patch(action: &MiniLoopAction, cwd: &Path) -> MiniLoopObservation {
    let patch = read_string(&action.input, "patch");
    if patch.is_empty() {
        return error_observation("apply_patch: missing patch");
    }
    match apply_unified_patch(cwd, &patch) {
        Ok(result) => MiniLoopObservation {
            stdout: result
                .applied
                .iter()
                .map(|entry| format!("{} ({} hunks)", entry.path, entry.hunk_count))
                .collect::<Vec<_>>()
                .join("\n"),
            stderr: result
                .rejected
                .iter()
                .map(|entry| format!("{}@hunk{}: {}", entry.path, entry.hunk_index, entry.reason))
                .collect::<Vec<_>>()
                .join("\n"),
            exit_code: if result.rejected.is_empty() { 0 } else { 1 },
            truncated: false,
        },
        Err(error) => error_observation(&format!("apply_patch: {error}")),
    }
}

fn run_shell_observation(command: &str, cwd: &Path) -> MiniLoopObservation {
    let child = if cfg!(windows) {
        Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", command])
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        Command::new("/bin/sh")
            .args(["-c", command])
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    };
    let mut child = match child {
        Ok(child) => child,
        Err(error) => return error_observation(&format!("run_shell: {error}")),
    };

    let Some(stdout) = child.stdout.take() else {
        return error_observation("run_shell: failed to capture stdout");
    };
    let Some(stderr) = child.stderr.take() else {
        return error_observation("run_shell: failed to capture stderr");
    };
    let stdout_handle = thread::spawn(move || read_capped(stdout));
    let stderr_handle = thread::spawn(move || read_capped(stderr));
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                return error_observation(&format!("run_shell: failed to wait: {error}"));
            }
        }
        if started.elapsed() >= Duration::from_millis(RUN_SHELL_TIMEOUT_MS) {
            timed_out = true;
            let _ = child.kill();
            match child.wait() {
                Ok(status) => break status,
                Err(error) => {
                    return error_observation(&format!("run_shell: failed to reap: {error}"));
                }
            }
        }
        thread::sleep(Duration::from_millis(10));
    };
    let (stdout, stdout_truncated) = stdout_handle
        .join()
        .unwrap_or_else(|_| (String::new(), false));
    let (mut stderr, stderr_truncated) = stderr_handle
        .join()
        .unwrap_or_else(|_| (String::new(), false));
    if timed_out {
        if !stderr.trim().is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "run_shell: timed out after {RUN_SHELL_TIMEOUT_MS}ms"
        ));
    }
    MiniLoopObservation {
        stdout,
        stderr,
        exit_code: if timed_out {
            -1
        } else {
            status.code().unwrap_or(-1)
        },
        truncated: stdout_truncated || stderr_truncated,
    }
}

fn read_capped<R: Read>(mut reader: R) -> (String, bool) {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        let remaining = RUN_SHELL_OUTPUT_CAP_BYTES.saturating_sub(bytes.len());
        if remaining == 0 {
            truncated = true;
            continue;
        }
        let take = read.min(remaining);
        bytes.extend_from_slice(&buffer[..take]);
        if take < read {
            truncated = true;
        }
    }
    (String::from_utf8_lossy(&bytes).into_owned(), truncated)
}

fn detect_submit(observation: &MiniLoopObservation) -> Option<String> {
    if observation.exit_code != 0 {
        return None;
    }
    let lines = observation.stdout.lines().collect::<Vec<_>>();
    let first_non_empty = lines
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim())
        .unwrap_or("");
    if first_non_empty != SUBMIT_MARKER {
        return None;
    }
    let marker_index = lines.iter().position(|line| line.trim() == SUBMIT_MARKER)?;
    Some(lines[marker_index + 1..].join("\n").trim().to_string())
}

fn exit_result(
    status: &str,
    submission: &str,
    steps: usize,
    cost_usd: f64,
) -> ProviderMiniLoopResult {
    ProviderMiniLoopResult {
        status: status.to_string(),
        submission: submission.to_string(),
        steps,
        cost_usd,
    }
}

fn error_observation(message: &str) -> MiniLoopObservation {
    MiniLoopObservation {
        stdout: String::new(),
        stderr: message.to_string(),
        exit_code: -1,
        truncated: false,
    }
}

fn read_string(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn has_array_items(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().map(|items| !items.is_empty()))
        .unwrap_or(false)
}

fn persona_config(persona: &str) -> Result<PersonaConfig, String> {
    match persona {
        "coder" => Ok(PersonaConfig {
            system_prompt: concat!(
                "You are an UncleCode coding agent operating in a sandboxed workspace.\n",
                "- Take one bash action at a time. Wait for output before the next action.\n",
                "- Cite the file path and content hash whenever you assert a fact about the codebase.\n",
                "- When the task is complete, print exactly the line \"__UNCLECODE_SUBMIT__\" followed by your final patch summary on subsequent lines.\n",
                "- Never claim a test passes without an observation that captures the exit code.\n\n",
                "Persona: coder. You implement a single-objective fix or small feature plus a regression test.\n",
                "Prefer narrow edits over refactors. Stop as soon as the regression test passes."
            ),
            step_limit: 12,
            cost_limit_usd: 0.8,
            allowed_tools: &["read_file", "write_file", "search_text", "list_files", "run_shell"],
        }),
        "builder" => Ok(PersonaConfig {
            system_prompt: concat!(
                "You are an UncleCode coding agent operating in a sandboxed workspace.\n",
                "- Take one bash action at a time. Wait for output before the next action.\n",
                "- Cite the file path and content hash whenever you assert a fact about the codebase.\n",
                "- When the task is complete, print exactly the line \"__UNCLECODE_SUBMIT__\" followed by your final patch summary on subsequent lines.\n",
                "- Never claim a test passes without an observation that captures the exit code.\n\n",
                "Persona: builder. You deliver a bounded feature slice end-to-end with verification.\n",
                "Plan briefly, edit broadly within the slice, run tests after each meaningful change."
            ),
            step_limit: 20,
            cost_limit_usd: 2.0,
            allowed_tools: &["read_file", "write_file", "search_text", "list_files", "run_shell"],
        }),
        "hardener" => Ok(PersonaConfig {
            system_prompt: concat!(
                "You are an UncleCode coding agent operating in a sandboxed workspace.\n",
                "- Take one bash action at a time. Wait for output before the next action.\n",
                "- Cite the file path and content hash whenever you assert a fact about the codebase.\n",
                "- When the task is complete, print exactly the line \"__UNCLECODE_SUBMIT__\" followed by your final patch summary on subsequent lines.\n",
                "- Never claim a test passes without an observation that captures the exit code.\n\n",
                "Persona: hardener. You apply security or robustness changes without altering product behavior.\n",
                "Bias toward minimum-surface patches. Prefer explicit denylist + audit log over silent fixes."
            ),
            step_limit: 14,
            cost_limit_usd: 1.5,
            allowed_tools: &["read_file", "write_file", "search_text", "list_files"],
        }),
        "auditor" => Ok(PersonaConfig {
            system_prompt: concat!(
                "You are an UncleCode coding agent operating in a sandboxed workspace.\n",
                "- Take one bash action at a time. Wait for output before the next action.\n",
                "- Cite the file path and content hash whenever you assert a fact about the codebase.\n",
                "- When the task is complete, print exactly the line \"__UNCLECODE_SUBMIT__\" followed by your final patch summary on subsequent lines.\n",
                "- Never claim a test passes without an observation that captures the exit code.\n\n",
                "Persona: auditor. You analyze and report. You do not write or run shell commands.\n",
                "Cite every claim. Output a markdown report when finished, then submit."
            ),
            step_limit: 6,
            cost_limit_usd: 0.3,
            allowed_tools: &["read_file", "search_text", "list_files"],
        }),
        "agentless-fix" => Ok(PersonaConfig {
            system_prompt: concat!(
                "You are an UncleCode coding agent operating in a sandboxed workspace.\n",
                "- Take one bash action at a time. Wait for output before the next action.\n",
                "- Cite the file path and content hash whenever you assert a fact about the codebase.\n",
                "- When the task is complete, print exactly the line \"__UNCLECODE_SUBMIT__\" followed by your final patch summary on subsequent lines.\n",
                "- Never claim a test passes without an observation that captures the exit code.\n\n",
                "Persona: agentless-fix. Two-phase: hierarchical localization + multi-candidate patch.\n",
                "No iterative loop. Localize then propose patches and submit."
            ),
            step_limit: 4,
            cost_limit_usd: 0.2,
            allowed_tools: &["read_file", "search_text", "list_files", "write_file"],
        }),
        "agentless-then-agent" => Ok(PersonaConfig {
            system_prompt: concat!(
                "You are an UncleCode coding agent operating in a sandboxed workspace.\n",
                "- Take one bash action at a time. Wait for output before the next action.\n",
                "- Cite the file path and content hash whenever you assert a fact about the codebase.\n",
                "- When the task is complete, print exactly the line \"__UNCLECODE_SUBMIT__\" followed by your final patch summary on subsequent lines.\n",
                "- Never claim a test passes without an observation that captures the exit code.\n\n",
                "Persona: agentless-then-agent. Try agentless first; on failure, escalate into iterative\n",
                "edit-test loop with the same budget as a coder persona."
            ),
            step_limit: 16,
            cost_limit_usd: 1.5,
            allowed_tools: &["read_file", "write_file", "search_text", "list_files", "run_shell"],
        }),
        "mini" => Ok(PersonaConfig {
            system_prompt: concat!(
                "You are an UncleCode coding agent operating in a sandboxed workspace.\n",
                "- Take one bash action at a time. Wait for output before the next action.\n",
                "- Cite the file path and content hash whenever you assert a fact about the codebase.\n",
                "- When the task is complete, print exactly the line \"__UNCLECODE_SUBMIT__\" followed by your final patch summary on subsequent lines.\n",
                "- Never claim a test passes without an observation that captures the exit code.\n\n",
                "Persona: mini. Bare-bones bash-only loop. No ACI tooling — diagnostics and parity checks only."
            ),
            step_limit: 12,
            cost_limit_usd: 0.5,
            allowed_tools: &["run_shell"],
        }),
        _ => Err(format!("Unknown persona \"{persona}\"")),
    }
}

pub fn team_default_tools_json() -> String {
    default_tools_value().to_string()
}

fn tools_json_for_allowed(allowed_tools: &[String]) -> String {
    let allowed = default_tools_value()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .map(|name| allowed_tools.iter().any(|allowed| allowed == name))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    Value::Array(allowed).to_string()
}

fn default_tools_value() -> Value {
    json!([
        {
            "name": "run_shell",
            "description": "Run a shell command in the worker workspace. Returns combined stdout/stderr and the exit code.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Shell command to execute via /bin/sh -c."
                    }
                },
                "required": ["command"]
            }
        },
        {
            "name": "read_file",
            "description": "Open a workspace-relative file and return a numbered window of lines.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative file path." },
                    "window": { "type": "number", "description": "Visible line window size (default 100)." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "write_file",
            "description": "Overwrite (or create) a workspace-relative file with the given contents.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative file path." },
                    "contents": { "type": "string", "description": "Full file contents to write (UTF-8)." }
                },
                "required": ["path", "contents"]
            }
        },
        {
            "name": "search_text",
            "description": "Search the workspace for a pattern with ripgrep; returns at most 50 path:line:text hits.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Regex or fixed string to search for." },
                    "path": { "type": "string", "description": "Workspace-relative subdirectory to scope the search (optional)." }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_files",
            "description": "List workspace files matching the given glob pattern (default '**/*').",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern (e.g. 'src/**/*.ts')." }
                }
            }
        },
        {
            "name": "apply_patch",
            "description": "Apply a unified diff to the workspace. Reports applied and rejected hunks.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "patch": { "type": "string", "description": "Unified diff (multi-file) to apply." }
                },
                "required": ["patch"]
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_runtime::{
        format_team_run_inspect, start_team_run_record, TeamRunRecordRequest,
    };
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn runs_openai_team_mini_loop_with_tool_checkpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for request_index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0_u8; 16384];
                let size = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..size]);
                assert!(request.contains("POST /v1/chat/completions HTTP/1.1"));
                assert!(request.contains("authorization: Bearer sk-test"));
                if request_index == 0 {
                    assert!(request.contains(r#""name":"run_shell""#));
                    write_response(
                        &mut stream,
                        r#"{"choices":[{"message":{"content":"running","tool_calls":[{"id":"call_1","function":{"name":"run_shell","arguments":"{\"command\":\"printf first\"}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#,
                    );
                } else {
                    assert!(request.contains(r#""role":"tool""#));
                    assert!(request.contains("first"));
                    write_response(
                        &mut stream,
                        r#"{"choices":[{"message":{"content":"final submission"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#,
                    );
                }
            }
        });

        let data_root =
            std::env::temp_dir().join(format!("unclecode-team-mini-loop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data_root);
        let run = start_team_run_record(TeamRunRecordRequest {
            data_root: data_root.clone(),
            run_id: Some("tr_mini_loop".to_string()),
            objective: "mini loop".to_string(),
            persona: "coder".to_string(),
            lanes_spec: "openai".to_string(),
            gate: "warn".to_string(),
            runtime: "local".to_string(),
            isolation: "shared".to_string(),
            workspace_root: data_root.clone(),
            created_by: "test".to_string(),
        })
        .unwrap();

        let result = run_team_mini_loop(TeamMiniLoopRequest {
            runtime: "openai".to_string(),
            api_key: "sk-test".to_string(),
            model: "gpt-5.5".to_string(),
            base_url: format!("http://{address}/v1"),
            run_root: run.run_root,
            run_id: "tr_mini_loop".to_string(),
            worker_id: "w1".to_string(),
            persona: "coder".to_string(),
            task: "run printf first".to_string(),
            cwd: data_root.clone(),
            reasoning_effort: None,
        })
        .unwrap();
        handle.join().unwrap();

        assert_eq!(result.status, "submitted");
        assert_eq!(result.steps, 2);
        assert_eq!(result.submission, "final submission");
        let inspect = format_team_run_inspect(&data_root, "tr_mini_loop", true).unwrap();
        assert!(inspect.ok);
        assert!(inspect.output.contains("Steps:     1"));
        assert!(inspect.output.contains("Chain: VERIFIED (2 entries)"));
        let _ = fs::remove_dir_all(&data_root);
    }

    #[test]
    fn detects_submit_marker_from_tool_output() {
        let observation = MiniLoopObservation {
            stdout: format!("{SUBMIT_MARKER}\npatched files"),
            stderr: String::new(),
            exit_code: 0,
            truncated: false,
        };

        assert_eq!(
            detect_submit(&observation).as_deref(),
            Some("patched files")
        );
    }

    fn write_response(stream: &mut std::net::TcpStream, body: &str) {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    }
}
