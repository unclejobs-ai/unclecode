use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Instant;
use unclecode_core::aci::{
    delete_text_file, list_files, read_text_file, view_text_file, view_text_file_json,
    write_text_file,
};
use unclecode_core::aci_edit::{line_edit_json, lint_failure_message, restore_file};
use unclecode_core::aci_patch::{apply_unified_patch_json, parse_unified_diff_json};
use unclecode_core::aci_safe::{
    delete_text_file_no_symlinks, read_text_file_no_symlinks,
    write_text_file_atomically_no_symlinks,
};
use unclecode_core::aci_search::{find_files_json, glob_files, search_text, search_text_json};
use unclecode_core::anthropic_request::{
    build_anthropic_messages_request_json, build_anthropic_messages_request_spec_with_base,
    build_anthropic_tool_result_block_json, build_anthropic_user_message_json,
    parse_anthropic_response_json_for_model, provider_query_messages_to_anthropic_json,
};
use unclecode_core::app_reasoning::resolve_app_reasoning_config_json;
use unclecode_core::auth::{
    build_openai_auth_request_spec, build_openai_authorization_code_token_body,
    build_openai_authorization_url, build_openai_codex_device_authorization_body,
    build_openai_codex_device_token_body, build_openai_device_authorization_body,
    build_openai_device_token_body, clear_openai_credentials, inspect_openai_oauth_token,
    openai_auth_supports_api_calls, openai_credentials_path, parse_openai_callback_code,
    parse_openai_codex_device_authorization_response, parse_openai_codex_device_token_response,
    parse_openai_device_authorization_response, parse_openai_oauth_token_response,
    read_openai_credentials_file, resolve_openai_auth, resolve_openai_auth_status,
    write_openai_api_key_credentials, write_openai_oauth_credentials, write_openai_raw_credentials,
    StoredApiKeyCredential, StoredOAuthCredential, StoredOpenAICredential,
};
use unclecode_core::auth_key_command::{
    resolve_auth_key_command_json, resolve_auth_key_submit_result_json,
};
use unclecode_core::auth_progress_command::resolve_auth_progress_result_json;
use unclecode_core::clear_command::resolve_clear_command_json;
use unclecode_core::command_router::{
    cli_slash_help_text, extension_manifests_json, extension_slash_commands_json,
    resolve_prompt_slash_command_json, resolve_work_shell_inline_action_json,
    route_cli_slash_command_json, route_work_shell_slash_command_json,
    route_work_shell_submit_json, work_shell_builtin_submit_command_json,
    work_shell_local_submit_command_json,
};
use unclecode_core::composer_input::resolve_composer_input_json;
use unclecode_core::context_command::{apply_auth_issue_lines_json, resolve_context_command_json};
use unclecode_core::context_guidance::build_workspace_guidance_json;
use unclecode_core::context_packet::{
    build_context_selection_json, detect_hotspots_json, estimate_context_tokens,
    summarize_diff_json, token_budget_json,
};
use unclecode_core::context_skills::{
    discover_skill_metadata_json, list_available_skills_json, load_named_skill_json,
};
use unclecode_core::gemini_request::{
    build_gemini_function_response_part_json, build_gemini_generate_content_request_json,
    build_gemini_generate_content_request_spec_with_base, build_gemini_user_content_json,
    parse_gemini_response_json_for_model, provider_query_messages_to_gemini_json,
    tool_definitions_to_gemini_function_declarations_json,
};
use unclecode_core::harness::{apply_harness_preset, harness_preset_ids, inspect_harness_status};
use unclecode_core::harness_command::resolve_harness_command_json;
use unclecode_core::help_command::resolve_help_command_json;
use unclecode_core::http_transport::{
    http_transport_response_json, post_json_with_headers, proxy_policy_json,
    redact_proxy_url_for_display, resolve_proxy_policy,
};
use unclecode_core::inline_command::{
    resolve_inline_command_result_json, resolve_inline_command_visibility_json,
};
use unclecode_core::json_args::normalize_json_object_argument;
use unclecode_core::memory_command::{
    resolve_memories_command_json, resolve_remember_command_json,
};
use unclecode_core::model_builtin_command::resolve_model_builtin_command_json;
use unclecode_core::model_command::resolve_model_command_json;
use unclecode_core::model_pricing::{estimate_cost_usd, model_price};
use unclecode_core::model_registry::{
    detect_provider_for_model, openai_compat_policy_json, openai_model_registry,
    openai_reasoning_support, provider_capability_json, provider_label, provider_model_catalog,
    provider_route_json, provider_route_proxy_policy, provider_runtime_decision_json,
    resolve_provider_route,
};
use unclecode_core::openai_query::{run_openai_chat_completion_json, run_openai_chat_query_json};
use unclecode_core::orchestrator::{
    build_complex_tasks_json, build_guardian_review_prompt_json, build_planner_prompt_json,
    build_synthesis_prompt_json, build_trace_event_json, classify_work_intent_json,
    extract_changed_files_from_tasks_json, parse_plan_response_json, resolve_worker_budget_json,
};
use unclecode_core::path_guard::assert_within_workspace_string;
use unclecode_core::post_turn_command::resolve_post_turn_success_result_json;
use unclecode_core::prompt_command::build_prompt_command_prompt_json;
use unclecode_core::prompt_failure_command::resolve_prompt_failure_result_json;
use unclecode_core::prompt_lifecycle_command::{
    resolve_prompt_finalize_result_json, resolve_prompt_start_result_json,
};
use unclecode_core::prompt_success_command::resolve_prompt_success_result_json;
use unclecode_core::prompt_turn::{
    build_permission_stall_continue_prompt_json, create_chat_prompt_turn_input_json,
    create_conversation_turn_summary_json, create_prompt_command_turn_input_json,
    detect_edit_intent_json, resolve_permission_stall_json, resolve_read_only_mode_guard_json,
    summarize_work_shell_prompt_json, summarize_work_shell_text_json,
};
use unclecode_core::provider_attachments::cap_provider_attachments_result_json;
use unclecode_core::provider_dispatch::provider_tool_dispatch_plan_json;
use unclecode_core::provider_error::provider_request_error_message;
use unclecode_core::provider_loop::{
    provider_iteration_action_plan_json, provider_loop_decision_json, provider_loop_limit_json,
};
use unclecode_core::provider_prompt::build_provider_system_prompt;
use unclecode_core::provider_request::{
    build_openai_assistant_message_json, build_openai_chat_request_body,
    build_openai_chat_request_spec, build_openai_codex_request_body,
    build_openai_codex_request_spec, build_openai_tool_message_json,
    build_openai_user_message_json, provider_query_messages_to_openai_json,
    resolve_provider_tool_policy_json, resolve_runtime_reasoning_effort_json,
    tool_definitions_to_chat_tools_json, ProviderRequestSpec,
};
use unclecode_core::provider_response::{
    is_openai_chat_stream_progress_chunk_json, openai_tool_calls_to_actions_json,
    parse_openai_chat_response_json_for_model, parse_openai_chat_response_records,
    OpenAIChatResponseRecord,
};
use unclecode_core::provider_state::{
    append_provider_tool_result_turn_json, append_provider_turn_state_json,
    reset_provider_turn_state_json, resolve_provider_runtime_settings_json,
    start_provider_turn_state_json,
};
use unclecode_core::provider_step::{provider_complete_turn_step_json, provider_turn_step_json};
use unclecode_core::provider_trace::{
    provider_calling_trace_json, provider_reasoning_delta_trace_json,
    provider_reasoning_delta_trace_with_item_id_json, provider_route_trace_json,
    provider_tool_completed_trace_json, provider_tool_execution_finish_json,
    provider_tool_execution_finish_result_json, provider_tool_execution_result_json,
    provider_tool_execution_start_json, provider_tool_result_container_json,
    provider_tool_result_json, provider_tool_result_turn_entries_json,
    provider_tool_started_trace_json, provider_turn_completed_trace_json,
    provider_turn_started_trace_json,
};
use unclecode_core::provider_transport::{
    post_anthropic_messages_json, post_gemini_generate_content_json, post_openai_chat_json,
    post_openai_codex_json, provider_request_spec_json,
};
use unclecode_core::queue::{
    queue_item_json, queue_items_json, queue_length_json, queue_limit_acceptance_json,
    queue_limit_rejection_json, PersistentWorkQueue, QueueAttachmentArtifact, QueueMoveDirection,
    QueuePushError, WorkQueue,
};
use unclecode_core::queue_command::resolve_queue_command_json;
use unclecode_core::reasoning_builtin_command::resolve_reasoning_builtin_command_json;
use unclecode_core::reasoning_command::resolve_reasoning_command_json;
use unclecode_core::redaction::redact_secrets;
use unclecode_core::reload_command::resolve_reload_command_json;
use unclecode_core::repo_context::{
    build_repo_map_json, build_worktree_fingerprint_json, check_freshness_json,
    get_repo_map_cache_token,
};
use unclecode_core::responses_input::{
    build_latest_responses_input_json, tool_definitions_to_responses_tools_json,
};
use unclecode_core::runtime::{run_command, run_shell_command, RuntimeCommand};
use unclecode_core::sensitive_input_command::resolve_sensitive_input_cancel_result_json;
use unclecode_core::session::{
    persist_work_shell_session_snapshot_json, resume_work_shell_session_json,
    scan_session_persistence_notices_json, session_paths, SessionLog, WorkShellSessionSnapshot,
    WorkShellSessionStore,
};
use unclecode_core::sessions_command::resolve_sessions_command_json;
use unclecode_core::sha256::{sha256_base64url_bytes, sha256_hex_bytes};
use unclecode_core::skill_command::resolve_skill_command_json;
use unclecode_core::skills_command::resolve_skills_command_json;
use unclecode_core::sse::{
    parse_responses_sse_message_json, parse_responses_sse_provider_message_json,
    parse_responses_sse_records, parse_responses_sse_result_json, parse_sse_data_blocks,
    ResponsesSseRecord,
};
use unclecode_core::status_command::resolve_status_command_json;
use unclecode_core::steer::{
    resolve_busy_submit_json, resolve_drain_start_json, resolve_drain_step_json,
};
use unclecode_core::team_runtime::{
    build_team_worker_spawn_args_json, finalize_team_worktree_json, format_team_run_status,
    format_team_runs_list, list_team_runs_json, parse_team_lanes_json, prepare_team_worktree_json,
    resolve_team_child_env_json, resolve_team_dispatch_status_json, resolve_team_run_config_json,
    resolve_team_worker_close_outcome_json, resolve_team_worker_options_json,
};
use unclecode_core::tools_command::resolve_tools_command_json;
use unclecode_core::trace_mode_command::resolve_trace_mode_command_json;
use unclecode_core::ux_input::{
    resolve_attachment_dedup_json, resolve_clipboard_attachment_cap_json,
    resolve_composer_preview_mode_json, resolve_work_shell_input_action_json,
    resolve_work_shell_slash_selection_json, resolve_work_shell_slash_submit_block_json,
    resolve_work_shell_submit_action_json,
};
use unclecode_core::ux_model::build_model_panel_json;
use unclecode_core::ux_panels::{
    build_model_suggestions_json, build_slash_suggestions_json, build_ux_panel_json,
    extract_auth_label_json, format_auth_label_for_display_text,
    format_inline_command_summary_json, resolve_auth_browser_failure_lines_json,
    resolve_auth_launcher_lines_json, resolve_auth_status_panel_lines_json,
};
use unclecode_core::ux_text::{
    build_attachment_preview_lines_json, build_terminal_inline_image_sequence_json,
    build_work_shell_transition_json, classify_work_shell_panel_line_json,
    format_inline_image_support_line_from_env, format_runtime_label_json, format_trace_line_json,
    format_work_shell_error_message, format_work_shell_footer_line_json,
    format_work_shell_mode_label, format_work_shell_provider_title,
    format_work_shell_status_line_json, format_work_shell_thinking_line,
    format_work_shell_usage_line_json, normalize_busy_status, normalize_markdown_display_text,
    resolve_work_shell_attachment_layout_json, resolve_work_shell_composer_dock_layout_json,
    resolve_work_shell_entry_presentation_json, resolve_work_shell_panel_layout_json,
    resolve_work_shell_viewport_layout_json, work_shell_composer_hint_json,
    work_shell_empty_conversation_hint, wrap_display_text_json,
};
use unclecode_core::work_runtime_args::{
    build_work_command_args_json, parse_work_runtime_args_json, resolve_work_entrypoint_paths_json,
    with_work_cwd_json,
};
use unclecode_core::work_shell_state::{
    resolve_work_shell_append_entries_patch_json, resolve_work_shell_auth_state_patch_json,
    resolve_work_shell_busy_state_patch_json, resolve_work_shell_dashboard_home_patch_json,
    resolve_work_shell_dashboard_home_sync_state_json, resolve_work_shell_initial_state_json,
    resolve_work_shell_mode_default_reasoning_json, resolve_work_shell_trace_line_patch_json,
    resolve_work_shell_trace_mode_patch_json, should_refresh_work_shell_dashboard_home_json,
};
use unclecode_core::work_shell_trace::resolve_work_shell_trace_event_json;

mod cli_auth;
mod cli_auth_saved;
mod cli_center;
mod cli_config;
mod cli_doctor;
mod cli_harness;
mod cli_mcp;
mod cli_mode;
mod cli_model;
mod cli_queue;
mod cli_research;
mod cli_resume;
mod cli_sessions;
mod cli_setup;
mod cli_team;
mod cli_team_background;
mod cli_work;

const TS_ENTRYPOINT: &str = "apps/unclecode-cli/dist/index.js";
const TS_WORK_ENTRYPOINT: &str = "apps/unclecode-cli/dist/work-entry.js";
const NODE_NO_EXPERIMENTAL_WARNING: &str = "--no-warnings=ExperimentalWarning";

fn main() -> ExitCode {
    let started_at = Instant::now();
    match run_with_start(env::args_os().skip(1).collect(), started_at) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
fn run(args: Vec<OsString>) -> Result<u8, String> {
    run_with_start(args, Instant::now())
}

fn run_with_start(args: Vec<OsString>, started_at: Instant) -> Result<u8, String> {
    if args.first().and_then(|arg| arg.to_str()) == Some("--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    }
    if args.first().and_then(|arg| arg.to_str()) == Some("--help") {
        println!("UncleCode workspace shell");
        println!();
        println!("Usage:");
        println!("  unclecode [command]");
        println!("  unclecode rust <native-command>");
        println!();
        println!("Native commands:");
        println!("  unclecode center");
        println!("  unclecode model list openai");
        println!("  unclecode model route auto gpt-5.5");
        println!("  unclecode queue list <session-id>");
        println!("  unclecode team ls");
        println!();
        println!("Native probes:");
        println!("  unclecode --version");
        println!("  unclecode --rust-version");
        println!("  unclecode rust perf startup");
        println!("  unclecode rust --help           # grouped native subcommand catalog");
        return Ok(0);
    }
    if args.first().and_then(|arg| arg.to_str()) == Some("rust")
        && args.get(1).and_then(|arg| arg.to_str()) == Some("--help")
    {
        print_rust_native_help();
        return Ok(0);
    }
    if args.first().and_then(|arg| arg.to_str()) == Some("--rust-version") {
        println!("unclecode-rust {}", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    }
    if args.is_empty() {
        if should_launch_full_tui(&args, io::stdin().is_terminal(), io::stdout().is_terminal()) {
            return launch_typescript_tui_bridge(&[]);
        }
        return cli_work::run_top_level_work_command(&[]);
    }
    if args.first().and_then(|arg| arg.to_str()) == Some("tui")
        && should_launch_full_tui(&args, io::stdin().is_terminal(), io::stdout().is_terminal())
    {
        return launch_typescript_tui_bridge(&args[1..]);
    }
    if args.first().and_then(|arg| arg.to_str()) == Some("rust") {
        return run_native_rust_command(&args[1..], started_at);
    }
    if let Some(auth_args) = cli_auth::top_level_auth_args(&args) {
        return cli_auth::run_top_level_auth_command(&auth_args);
    }
    if let Some(center_args) = cli_center::top_level_center_args(&args) {
        if should_launch_full_center(
            &center_args,
            io::stdin().is_terminal(),
            io::stdout().is_terminal(),
        ) {
            return launch_typescript_command_bridge("center", &center_args);
        }
        return cli_center::run_top_level_center_command(&center_args);
    }
    if let Some(config_args) = cli_config::top_level_config_args(&args) {
        return cli_config::run_top_level_config_command(&config_args);
    }
    if let Some(doctor_args) = cli_doctor::top_level_doctor_args(&args) {
        return cli_doctor::run_top_level_doctor_command(&doctor_args);
    }
    if let Some(harness_args) = cli_harness::top_level_harness_args(&args) {
        return cli_harness::run_top_level_harness_command(&harness_args);
    }
    if let Some(mcp_args) = cli_mcp::top_level_mcp_args(&args) {
        return cli_mcp::run_top_level_mcp_command(&mcp_args);
    }
    if let Some(model_args) = cli_model::top_level_model_args(&args) {
        return cli_model::run_top_level_model_command(&model_args);
    }
    if let Some(queue_args) = cli_queue::top_level_queue_args(&args) {
        return cli_queue::run_top_level_queue_command(&queue_args);
    }
    if let Some(mode_args) = cli_mode::top_level_mode_args(&args) {
        return cli_mode::run_top_level_mode_command(&mode_args);
    }
    if let Some(research_args) = cli_research::top_level_research_args(&args) {
        return cli_research::run_top_level_research_command(&research_args);
    }
    if let Some(sessions_args) = cli_sessions::top_level_sessions_args(&args) {
        return cli_sessions::run_top_level_sessions_command(&sessions_args);
    }
    if let Some(resume_args) = cli_resume::top_level_resume_args(&args) {
        return cli_resume::run_top_level_resume_command(&resume_args);
    }
    if let Some(setup_args) = cli_setup::top_level_setup_args(&args) {
        return cli_setup::run_top_level_setup_command(&setup_args);
    }
    if let Some(team_args) = cli_team::top_level_team_args(&args) {
        return cli_team::run_top_level_team_command(&team_args);
    }
    if let Some(work_args) = cli_work::top_level_work_args(&args) {
        return match select_public_work_route(
            &work_args,
            io::stdin().is_terminal(),
            io::stdout().is_terminal(),
        ) {
            PublicWorkRoute::TypescriptTui => launch_typescript_tui_bridge(&work_args),
            PublicWorkRoute::TypescriptOwner => launch_typescript_work_owner_bridge(&work_args),
            PublicWorkRoute::RustNative => cli_work::run_top_level_work_command(&work_args),
        };
    }

    let command = args
        .first()
        .and_then(|arg| arg.to_str())
        .unwrap_or("<non-utf8>");
    let mut buffer = String::new();
    use std::fmt::Write as _;
    let _ = writeln!(
        buffer,
        "Unsupported UncleCode command on the Rust-native CLI: {command}"
    );
    let _ = writeln!(buffer, "Try `unclecode --help` or `unclecode rust --help`.");
    buffer.push_str("\n");
    buffer.push_str(&print_rust_native_help_string());
    Err(buffer)
}

fn print_rust_native_help() {
    print!("{}", print_rust_native_help_string());
}

fn print_rust_native_help_string() -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(out, "UncleCode native subcommands (Rust):");
    let _ = writeln!(out);
    let topics: &[(&str, &[&str])] = &[
        (
            "Provider I/O",
            &[
                "rust provider <openai-request-spec|openai-post|gemini-post|anthropic-post|openai-query-messages|gemini-query-messages|anthropic-query-messages|...>",
            ],
        ),
        (
            "Model & route",
            &[
                "rust model <openai-registry|openai-reasoning|openai-compat-policy-json|price|estimate-cost|detect-provider|provider-route|provider-runtime-json|capability|catalog|label>",
            ],
        ),
        (
            "Auth",
            &[
                "rust auth <status|resolve|inspect-oauth-token|authorization-url|parse-callback|request-spec|parse-token-response|...>",
            ],
        ),
        (
            "Queue & session",
            &[
                "rust queue <push|pop|list|len|clear> <session-id>",
                "rust session <persist|list>",
            ],
        ),
        (
            "Orchestrator",
            &[
                "rust orchestrator <classify-intent|complex-tasks|parse-plan-response|worker-budget|planner-prompt|guardian-review-prompt|synthesis-prompt|changed-files|trace-event>",
            ],
        ),
        (
            "Team mode",
            &[
                "rust team <run-config|worktree-prepare|worktree-finalize|worker-options|lanes|worker-spawn-args|dispatch-status|child-env|worker-close-outcome|list-runs|list-text|status-text>",
            ],
        ),
        (
            "Context & UX",
            &[
                "rust context <guidance|repo-map|worktree-fingerprint|freshness|selection|token-budget|hotspots|diff|skills|skill-load|auth-issues>",
                "rust ux <panel|model-panel|model-suggestions|model-command|reasoning-command|skills-command|help-command|...>",
            ],
        ),
        (
            "Work shell & runtime",
            &[
                "rust work-runtime <parse-args|build-command-args|with-cwd|entrypoint-paths>",
                "rust composer <resolve <cwd>>",
                "rust command <route|work-shell-route|submit-route|prompt-command|local-command|builtin-command|inline-action|help>",
            ],
        ),
        (
            "Tooling & probes",
            &[
                "rust aci <list|read|view|view-json|write|search|search-json|find-json|glob|apply-patch|parse-patch>",
                "rust json <normalize-object-arg>",
                "rust sse <data-blocks|responses-records|responses-result|responses-message>",
                "rust harness <inspect|apply|presets|preset> [args...]",
                "rust path assert [allow-missing|existing]",
                "rust http <post|proxy-policy>",
                "rust perf startup",
                "rust redact | rust sha256 | rust sha256-base64url",
            ],
        ),
    ];
    for (topic, lines) in topics {
        let _ = writeln!(out, "[{}]", topic);
        for line in *lines {
            let _ = writeln!(out, "  unclecode {}", line);
        }
        let _ = writeln!(out);
    }
    out
}

fn should_launch_full_tui(args: &[OsString], stdin_is_tty: bool, stdout_is_tty: bool) -> bool {
    if !stdin_is_tty || !stdout_is_tty {
        return false;
    }
    if args.is_empty() {
        return true;
    }
    if args.first().and_then(|arg| arg.to_str()) != Some("tui") {
        return false;
    }
    !args
        .iter()
        .skip(1)
        .any(|arg| matches!(arg.to_str(), Some("--help") | Some("-h") | Some("--tools")))
}

fn should_launch_work_tui(work_args: &[OsString], stdin_is_tty: bool, stdout_is_tty: bool) -> bool {
    stdin_is_tty && stdout_is_tty && cli_work::work_args_are_interactive_promptless(work_args)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicWorkRoute {
    TypescriptTui,
    TypescriptOwner,
    RustNative,
}

fn select_public_work_route(
    work_args: &[OsString],
    stdin_is_tty: bool,
    stdout_is_tty: bool,
) -> PublicWorkRoute {
    if cli_work::work_args_request_metadata(work_args) {
        PublicWorkRoute::RustNative
    } else if cli_work::work_args_have_prompt(work_args) || !stdin_is_tty {
        PublicWorkRoute::TypescriptOwner
    } else if should_launch_work_tui(work_args, stdin_is_tty, stdout_is_tty) {
        PublicWorkRoute::TypescriptTui
    } else {
        PublicWorkRoute::RustNative
    }
}

fn should_launch_full_center(args: &[OsString], stdin_is_tty: bool, stdout_is_tty: bool) -> bool {
    if !stdin_is_tty || !stdout_is_tty {
        return false;
    }
    !args.iter().any(|arg| {
        matches!(
            arg.to_str(),
            Some("--help") | Some("-h") | Some("help") | Some("sessions") | Some("list")
        )
    })
}

fn launch_typescript_tui_bridge(tui_args: &[OsString]) -> Result<u8, String> {
    launch_typescript_command_bridge("tui", tui_args)
}

fn launch_typescript_work_owner_bridge(work_args: &[OsString]) -> Result<u8, String> {
    launch_typescript_entrypoint_bridge(TS_WORK_ENTRYPOINT, None, work_args)
}

fn launch_typescript_command_bridge(
    command: &str,
    command_args: &[OsString],
) -> Result<u8, String> {
    launch_typescript_entrypoint_bridge(TS_ENTRYPOINT, Some(command), command_args)
}

fn launch_typescript_entrypoint_bridge(
    entrypoint_path: &str,
    command: Option<&str>,
    command_args: &[OsString],
) -> Result<u8, String> {
    let repo_root = find_repo_root()?;
    let entrypoint = repo_root.join(entrypoint_path);
    if !entrypoint.exists() {
        return Err("TypeScript runtime bridge is not built yet. Run `npm run build`.".to_string());
    }

    repair_typescript_native_modules_if_needed(&repo_root)?;

    let mut child = Command::new(node_binary());
    child.arg(entrypoint);
    if let Some(command) = command {
        child.arg(command);
    }
    let status = child
        .args(command_args)
        .current_dir(work_cwd()?)
        .envs(env::vars_os())
        .env(
            "NODE_OPTIONS",
            node_options_with_experimental_warning_suppressed(env::var_os("NODE_OPTIONS")),
        )
        .env("UNCLECODE_FORCE_TS_TUI", "1")
        .status()
        .map_err(|error| format!("Failed to launch UncleCode TypeScript runtime: {error}"))?;

    Ok(status.code().unwrap_or(1).clamp(0, 255) as u8)
}

fn repair_typescript_native_modules_if_needed(repo_root: &Path) -> Result<(), String> {
    if env::var_os("UNCLECODE_SKIP_NATIVE_REBUILD").is_some() {
        return Ok(());
    }

    repair_typescript_native_modules_with_runner(
        repo_root,
        || probe_better_sqlite3(repo_root),
        || rebuild_better_sqlite3(repo_root),
    )
    .map(|_| ())
}

#[derive(Debug, PartialEq, Eq)]
enum NativeModuleRepairOutcome {
    Healthy,
    IgnoredFailure,
    Rebuilt,
}

struct NativeModuleProbeResult {
    success: bool,
    stdout: String,
    stderr: String,
}

impl NativeModuleProbeResult {
    fn combined_output(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }
}

struct NativeModuleRebuildResult {
    success: bool,
    code: Option<i32>,
}

fn probe_better_sqlite3(repo_root: &Path) -> Result<NativeModuleProbeResult, String> {
    let output = Command::new(node_binary())
        .arg("-e")
        .arg("const Database = require('better-sqlite3'); const database = new Database(':memory:'); database.close();")
        .current_dir(repo_root)
        .envs(env::vars_os())
        .env(
            "NODE_OPTIONS",
            node_options_with_experimental_warning_suppressed(env::var_os("NODE_OPTIONS")),
        )
        .output()
        .map_err(|error| format!("Failed to probe better-sqlite3 native module: {error}"))?;

    Ok(NativeModuleProbeResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn rebuild_better_sqlite3(repo_root: &Path) -> Result<NativeModuleRebuildResult, String> {
    let status = Command::new(npm_binary())
        .args(["rebuild", "better-sqlite3"])
        .current_dir(repo_root)
        .envs(env::vars_os())
        .status()
        .map_err(|error| format!("Failed to run `npm rebuild better-sqlite3`: {error}"))?;

    Ok(NativeModuleRebuildResult {
        success: status.success(),
        code: status.code(),
    })
}

fn repair_typescript_native_modules_with_runner<Probe, Rebuild>(
    repo_root: &Path,
    probe: Probe,
    rebuild: Rebuild,
) -> Result<NativeModuleRepairOutcome, String>
where
    Probe: FnOnce() -> Result<NativeModuleProbeResult, String>,
    Rebuild: FnOnce() -> Result<NativeModuleRebuildResult, String>,
{
    let output = probe()?;

    if output.success {
        return Ok(NativeModuleRepairOutcome::Healthy);
    }

    if !is_better_sqlite3_native_version_mismatch(&output.combined_output()) {
        return Ok(NativeModuleRepairOutcome::IgnoredFailure);
    }

    eprintln!(
        "UncleCode detected a better-sqlite3 Node ABI mismatch; rebuilding native module once..."
    );
    let status = rebuild()?;

    if status.success {
        return Ok(NativeModuleRepairOutcome::Rebuilt);
    }

    Err(format!(
        "`npm rebuild better-sqlite3` failed with exit code {}. Run it manually from {} and retry `unclecode`.",
        status.code.unwrap_or(1),
        repo_root.display()
    ))
}

fn is_better_sqlite3_native_version_mismatch(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("better_sqlite3.node")
        && (lower.contains("node_module_version")
            || lower.contains("compiled against a different node.js version")
            || lower.contains("err_dlopen_failed"))
}

fn node_options_with_experimental_warning_suppressed(existing: Option<OsString>) -> OsString {
    let Some(existing) = existing else {
        return OsString::from(NODE_NO_EXPERIMENTAL_WARNING);
    };
    let existing_text = existing.to_string_lossy();
    if existing_text
        .split_whitespace()
        .any(|option| option == "--no-warnings" || option == NODE_NO_EXPERIMENTAL_WARNING)
    {
        return existing;
    }
    let mut combined = existing;
    if !combined.is_empty() {
        combined.push(" ");
    }
    combined.push(NODE_NO_EXPERIMENTAL_WARNING);
    combined
}

fn npm_binary() -> OsString {
    let node = node_binary();
    npm_binary_for_node(&node)
}

fn npm_binary_for_node(node: &OsStr) -> OsString {
    let npm_name = npm_executable_name();
    let node_path = PathBuf::from(node);
    if let Some(sibling) = sibling_npm_binary(&node_path, npm_name) {
        return sibling;
    }
    if let Some(resolved_node) = resolve_executable_on_path(node) {
        if let Some(sibling) = sibling_npm_binary(&resolved_node, npm_name) {
            return sibling;
        }
    }
    OsString::from(npm_name)
}

fn sibling_npm_binary(node_path: &Path, npm_name: &str) -> Option<OsString> {
    if node_path.components().count() <= 1 {
        return None;
    }
    let sibling = node_path.parent()?.join(npm_name);
    if sibling.is_file() {
        return Some(sibling.into_os_string());
    }
    None
}

fn resolve_executable_on_path(binary: &OsStr) -> Option<PathBuf> {
    let path = PathBuf::from(binary);
    if path.components().count() > 1 {
        return path.is_file().then_some(path);
    }
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            for extension in ["exe", "cmd", "bat"] {
                let candidate = dir.join(format!("{}.{}", binary.to_string_lossy(), extension));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn npm_executable_name() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn run_native_rust_command(args: &[OsString], started_at: Instant) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("queue-smoke") => {
            let mut queue = WorkQueue::new();
            let first = queue
                .push("first queued follow-up")
                .ok_or("failed to queue first item")?;
            let second = queue
                .push("second queued follow-up")
                .ok_or("failed to queue second item")?;
            println!("queued {} {}", first.id, first.line);
            println!("queued {} {}", second.id, second.line);
            println!("pending {}", queue.len());
            Ok(0)
        }
        Some("session-smoke") => {
            let path = env::temp_dir().join(format!(
                "unclecode-rust-session-{}.ndjson",
                std::process::id()
            ));
            let log = SessionLog::new(&path);
            log.append("system", "rust session smoke")
                .map_err(|error| format!("Failed to append session log: {error}"))?;
            println!("{}", path.display());
            Ok(0)
        }
        Some("session") => run_native_session_command(&args[1..]),
        Some("auth") => run_native_auth_command(&args[1..]),
        Some("model") => run_native_model_command(&args[1..]),
        Some("json") => run_native_json_command(&args[1..]),
        Some("sse") => run_native_sse_command(&args[1..]),
        Some("redact") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            print!("{}", redact_secrets(&input));
            Ok(0)
        }
        Some("sha256") => {
            let mut input = Vec::new();
            io::stdin()
                .read_to_end(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", sha256_hex_bytes(&input));
            Ok(0)
        }
        Some("sha256-base64url") => {
            let mut input = Vec::new();
            io::stdin()
                .read_to_end(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", sha256_base64url_bytes(&input));
            Ok(0)
        }
        Some("run") => {
            let separator = args
                .iter()
                .position(|arg| arg == "--")
                .map(|index| index + 1)
                .unwrap_or(1);
            let command_args = &args[separator..];
            let program = command_args
                .first()
                .ok_or("Usage: unclecode rust run -- <program> [args...]")?;
            let output = run_command(&RuntimeCommand {
                program: program.clone(),
                args: command_args[1..].to_vec(),
                cwd: work_cwd()?,
            })
            .map_err(|error| format!("Failed to run command: {error}"))?;
            print!("{}", output.stdout);
            eprint!("{}", output.stderr);
            Ok(output.status.clamp(0, 255) as u8)
        }
        Some("shell") => {
            let separator = args
                .iter()
                .position(|arg| arg == "--")
                .map(|index| index + 1)
                .unwrap_or(1);
            let command = args[separator..]
                .iter()
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            if command.trim().is_empty() {
                return Err("Usage: unclecode rust shell -- <command>".to_string());
            }
            let output = run_shell_command(&command, work_cwd()?)
                .map_err(|error| format!("Failed to run shell command: {error}"))?;
            print!("{}", output.stdout);
            eprint!("{}", output.stderr);
            Ok(output.status.clamp(0, 255) as u8)
        }
        Some("harness") => run_native_harness_command(&args[1..]),
        Some("http") => run_native_http_command(&args[1..]),
        Some("path") => run_native_path_command(&args[1..]),
        Some("perf") => run_native_perf_command(&args[1..], started_at),
        Some("provider") => run_native_provider_command(&args[1..]),
        Some("queue") => run_native_queue_command(&args[1..]),
        Some("aci") => run_native_aci_command(&args[1..]),
        Some("command") => run_native_command_router_command(&args[1..]),
        Some("composer") => run_native_composer_command(&args[1..]),
        Some("context") => run_native_context_command(&args[1..]),
        Some("orchestrator") => run_native_orchestrator_command(&args[1..]),
        Some("steer") => run_native_steer_command(&args[1..]),
        Some("team") => run_native_team_command(&args[1..]),
        Some("ux") => run_native_ux_command(&args[1..]),
        Some("work-runtime") => run_native_work_runtime_command(&args[1..]),
        _ => Err(format!(
            "Unrecognized Rust-native subcommand. Try `unclecode rust --help`.\n\n{}",
            print_rust_native_help_string()
        )),
    }
}

fn run_native_team_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("run-config") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_team_run_config_json(&input)?);
            Ok(0)
        }
        Some("worktree-prepare") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", prepare_team_worktree_json(&input)?);
            Ok(0)
        }
        Some("worktree-finalize") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", finalize_team_worktree_json(&input)?);
            Ok(0)
        }
        Some("worker-options") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_team_worker_options_json(&input)?);
            Ok(0)
        }
        Some("lanes") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", parse_team_lanes_json(&input)?);
            Ok(0)
        }
        Some("worker-spawn-args") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_team_worker_spawn_args_json(&input)?);
            Ok(0)
        }
        Some("dispatch-status") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_team_dispatch_status_json(&input)?);
            Ok(0)
        }
        Some("child-env") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_team_child_env_json(&input)?);
            Ok(0)
        }
        Some("worker-close-outcome") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_team_worker_close_outcome_json(&input)?);
            Ok(0)
        }
        Some("list-runs") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", list_team_runs_json(&input)?);
            Ok(0)
        }
        Some("list-text") => {
            let data_root = args
                .get(1)
                .map(PathBuf::from)
                .ok_or("Usage: unclecode rust team list-text <data-root>")?;
            print!("{}", format_team_runs_list(&data_root)?);
            Ok(0)
        }
        Some("status-text") => {
            let data_root = args
                .get(1)
                .map(PathBuf::from)
                .ok_or("Usage: unclecode rust team status-text <data-root> [runId]")?;
            let run_id = args.get(2).and_then(|arg| arg.to_str());
            print!("{}", format_team_run_status(&data_root, run_id)?);
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust team <run-config|worktree-prepare|worktree-finalize|worker-options|lanes|worker-spawn-args|dispatch-status|child-env|worker-close-outcome|list-runs|list-text|status-text>"
                .to_string(),
        ),
    }
}

fn run_native_work_runtime_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("parse-args") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", parse_work_runtime_args_json(&input)?);
            Ok(0)
        }
        Some("build-command-args") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_work_command_args_json(&input)?);
            Ok(0)
        }
        Some("with-cwd") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", with_work_cwd_json(&input)?);
            Ok(0)
        }
        Some("entrypoint-paths") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_entrypoint_paths_json(&input)?);
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust work-runtime <parse-args|build-command-args|with-cwd|entrypoint-paths>"
                .to_string(),
        ),
    }
}

fn run_native_orchestrator_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("classify-intent") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", classify_work_intent_json(&input)?);
            Ok(0)
        }
        Some("complex-tasks") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_complex_tasks_json(&input)?);
            Ok(0)
        }
        Some("parse-plan-response") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", parse_plan_response_json(&input)?);
            Ok(0)
        }
        Some("worker-budget") => {
            let mode = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust orchestrator worker-budget <mode>")?;
            println!("{}", resolve_worker_budget_json(mode)?);
            Ok(0)
        }
        Some("planner-prompt") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_planner_prompt_json(&input)?);
            Ok(0)
        }
        Some("guardian-review-prompt") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_guardian_review_prompt_json(&input)?);
            Ok(0)
        }
        Some("synthesis-prompt") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_synthesis_prompt_json(&input)?);
            Ok(0)
        }
        Some("changed-files") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", extract_changed_files_from_tasks_json(&input)?);
            Ok(0)
        }
        Some("trace-event") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_trace_event_json(&input)?);
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust orchestrator <classify-intent|complex-tasks|parse-plan-response|worker-budget|planner-prompt|guardian-review-prompt|synthesis-prompt|changed-files|trace-event>"
                .to_string(),
        ),
    }
}

fn run_native_steer_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("busy-submit") => {
            let queued_count = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Usage: unclecode rust steer busy-submit <queued-count>")?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_busy_submit_json(&input, queued_count)?);
            Ok(0)
        }
        Some("drain-start") => {
            let is_draining = parse_bool_arg(args.get(1), "is-draining")?;
            let is_busy = parse_bool_arg(args.get(2), "is-busy")?;
            let queued_count = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Usage: unclecode rust steer drain-start <is-draining> <is-busy> <queued-count>")?;
            println!("{}", resolve_drain_start_json(is_draining, is_busy, queued_count)?);
            Ok(0)
        }
        Some("drain-step") => {
            let queued_count = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Usage: unclecode rust steer drain-step <queued-count>")?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            if input.trim().is_empty() {
                input = "null".to_string();
            }
            println!("{}", resolve_drain_step_json(&input, queued_count)?);
            Ok(0)
        }
        _ => Err("Usage: unclecode rust steer <busy-submit <queued-count>|drain-start <is-draining> <is-busy> <queued-count>|drain-step <queued-count>>".to_string()),
    }
}

fn parse_bool_arg(value: Option<&OsString>, name: &str) -> Result<bool, String> {
    match value.and_then(|arg| arg.to_str()) {
        Some("true") | Some("1") | Some("yes") => Ok(true),
        Some("false") | Some("0") | Some("no") => Ok(false),
        _ => Err(format!("Expected boolean {name}")),
    }
}

fn run_native_composer_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("resolve") => {
            let cwd = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust composer resolve <cwd>")?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_composer_input_json(&input, cwd)?);
            Ok(0)
        }
        _ => Err("Usage: unclecode rust composer <resolve <cwd>>".to_string()),
    }
}

fn run_native_command_router_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("route") => {
            let input = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust command route <slash-input>")?;
            println!("{}", route_cli_slash_command_json(input)?);
            Ok(0)
        }
        Some("work-shell-route") => {
            let input = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust command work-shell-route <slash-input>")?;
            println!("{}", route_work_shell_slash_command_json(input)?);
            Ok(0)
        }
        Some("submit-route") => {
            let is_busy = parse_bool_arg(args.get(1), "is-busy")?;
            let composer_mode = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust command submit-route <is-busy> <composer-mode> <has-inline>")?;
            let has_inline = parse_bool_arg(args.get(3), "has-inline")?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                route_work_shell_submit_json(&input, is_busy, composer_mode, has_inline)?
            );
            Ok(0)
        }
        Some("prompt-command") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_prompt_command_prompt_json(&input)?);
            Ok(0)
        }
        Some("prompt-slash-command") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_prompt_slash_command_json(&input)?);
            Ok(0)
        }
        Some("local-command") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", work_shell_local_submit_command_json(&input)?);
            Ok(0)
        }
        Some("builtin-command") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", work_shell_builtin_submit_command_json(&input)?);
            Ok(0)
        }
        Some("inline-action") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_inline_action_json(&input)?);
            Ok(0)
        }
        Some("help") => {
            println!("{}", cli_slash_help_text());
            Ok(0)
        }
        Some("extension-slash-commands") => {
            let workspace_root = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust command extension-slash-commands <workspace-root> <user-home-dir|->")?;
            let user_home_dir = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-");
            println!(
                "{}",
                extension_slash_commands_json(workspace_root, user_home_dir)?
            );
            Ok(0)
        }
        Some("extension-manifests") => {
            let workspace_root = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust command extension-manifests <workspace-root> <user-home-dir|->")?;
            let user_home_dir = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-");
            println!("{}", extension_manifests_json(workspace_root, user_home_dir)?);
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust command <route|work-shell-route|submit-route|prompt-command|prompt-slash-command|local-command|builtin-command|inline-action|extension-slash-commands|extension-manifests|help>"
                .to_string(),
        ),
    }
}

fn run_native_path_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("assert") => {
            let allow_missing = match args.get(1).and_then(|arg| arg.to_str()) {
                Some("allow-missing") => true,
                Some("existing") | None => false,
                _ => {
                    return Err(
                        "Usage: unclecode rust path assert [allow-missing|existing]".to_string()
                    )
                }
            };
            let mut candidate = String::new();
            io::stdin()
                .read_to_string(&mut candidate)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            print!(
                "{}",
                assert_within_workspace_string(
                    work_cwd()?,
                    candidate.trim_end_matches('\n'),
                    allow_missing
                )
                .map_err(|error| error.to_string())?
            );
            Ok(0)
        }
        _ => Err("Usage: unclecode rust path assert [allow-missing|existing]".to_string()),
    }
}

fn run_native_ux_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("panel") => {
            let kind = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or(
                    "Usage: unclecode rust ux panel <queue|context|inline-command|model-picker|commands|auth-picker|help|status|sessions|harness|skills|skill|memories|auth-secure-entry|auth-progress>",
                )?;
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", build_ux_panel_json(kind, input)?);
            Ok(0)
        }
        Some("model-suggestions") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust ux model-suggestions <provider> <current-model> <normalized-input>")?;
            let current_model = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust ux model-suggestions <provider> <current-model> <normalized-input>")?;
            let normalized = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust ux model-suggestions <provider> <current-model> <normalized-input>")?;
            println!(
                "{}",
                build_model_suggestions_json(provider, current_model, normalized)?
            );
            Ok(0)
        }
        Some("model-panel") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", build_model_panel_json(input)?);
            Ok(0)
        }
        Some("model-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_model_command_json(input)?);
            Ok(0)
        }
        Some("model-builtin-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_model_builtin_command_json(input)?);
            Ok(0)
        }
        Some("reasoning-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_reasoning_command_json(input)?);
            Ok(0)
        }
        Some("reasoning-builtin-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_reasoning_builtin_command_json(input)?);
            Ok(0)
        }
        Some("trace-mode-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_trace_mode_command_json(input)?);
            Ok(0)
        }
        Some("skills-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_skills_command_json(input)?);
            Ok(0)
        }
        Some("help-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_help_command_json(input)?);
            Ok(0)
        }
        Some("context-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_context_command_json(input)?);
            Ok(0)
        }
        Some("queue-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_queue_command_json(input)?);
            Ok(0)
        }
        Some("auth-key-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_auth_key_command_json(input)?);
            Ok(0)
        }
        Some("auth-key-submit-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_auth_key_submit_result_json(input)?);
            Ok(0)
        }
        Some("auth-progress-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_auth_progress_result_json(input)?);
            Ok(0)
        }
        Some("sensitive-input-cancel-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_sensitive_input_cancel_result_json(input)?);
            Ok(0)
        }
        Some("skill-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_skill_command_json(input)?);
            Ok(0)
        }
        Some("tools-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_tools_command_json(input)?);
            Ok(0)
        }
        Some("status-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_status_command_json(input)?);
            Ok(0)
        }
        Some("clear-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_clear_command_json(input)?);
            Ok(0)
        }
        Some("harness-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_harness_command_json(input)?);
            Ok(0)
        }
        Some("sessions-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_sessions_command_json(input)?);
            Ok(0)
        }
        Some("reload-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_reload_command_json(input)?);
            Ok(0)
        }
        Some("memories-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_memories_command_json(input)?);
            Ok(0)
        }
        Some("remember-command") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_remember_command_json(input)?);
            Ok(0)
        }
        Some("inline-command-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_inline_command_result_json(input)?);
            Ok(0)
        }
        Some("inline-command-visibility") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_inline_command_visibility_json(input)?);
            Ok(0)
        }
        Some("prompt-failure-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_prompt_failure_result_json(input)?);
            Ok(0)
        }
        Some("prompt-success-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_prompt_success_result_json(input)?);
            Ok(0)
        }
        Some("prompt-start-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_prompt_start_result_json(input)?);
            Ok(0)
        }
        Some("prompt-finalize-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_prompt_finalize_result_json(input)?);
            Ok(0)
        }
        Some("post-turn-success-result") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let input = if input_json.trim().is_empty() {
                "{}"
            } else {
                input_json.trim()
            };
            println!("{}", resolve_post_turn_success_result_json(input)?);
            Ok(0)
        }
        Some("slash-suggestions") => {
            let normalized = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust ux slash-suggestions <normalized-input>")?;
            let mut entries_json = String::new();
            io::stdin()
                .read_to_string(&mut entries_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_slash_suggestions_json(normalized, &entries_json)?
            );
            Ok(0)
        }
        Some("input-action") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_input_action_json(&input_json)?);
            Ok(0)
        }
        Some("submit-action") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_submit_action_json(&input_json)?);
            Ok(0)
        }
        Some("slash-submit-block") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                resolve_work_shell_slash_submit_block_json(&input_json)?
            );
            Ok(0)
        }
        Some("slash-selection") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_slash_selection_json(&input_json)?);
            Ok(0)
        }
        Some("clipboard-cap") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_clipboard_attachment_cap_json(&input_json)?);
            Ok(0)
        }
        Some("attachment-dedup") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_attachment_dedup_json(&input_json)?);
            Ok(0)
        }
        Some("auth-label") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", format_auth_label_for_display_text(&input));
            Ok(0)
        }
        Some("auth-extract-label") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", extract_auth_label_json(&input_json)?);
            Ok(0)
        }
        Some("auth-launcher-lines") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_auth_launcher_lines_json(&input_json)?);
            Ok(0)
        }
        Some("auth-status-panel-lines") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_auth_status_panel_lines_json(&input_json)?);
            Ok(0)
        }
        Some("auth-browser-failure-lines") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_auth_browser_failure_lines_json(&input_json)?);
            Ok(0)
        }
        Some("composer-preview-mode") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_composer_preview_mode_json(&input_json)?);
            Ok(0)
        }
        Some("prompt-turn") => {
            let operation = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust ux prompt-turn <summary-prompt|summary-text|chat-input|prompt-command-input|conversation-summary|edit-intent|read-only-guard|permission-stall|continue-prompt>")?;
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let output = match operation {
                "summary-prompt" => summarize_work_shell_prompt_json(&input_json)?,
                "summary-text" => summarize_work_shell_text_json(&input_json)?,
                "chat-input" => create_chat_prompt_turn_input_json(&input_json)?,
                "prompt-command-input" => create_prompt_command_turn_input_json(&input_json)?,
                "conversation-summary" => create_conversation_turn_summary_json(&input_json)?,
                "edit-intent" => detect_edit_intent_json(&input_json)?,
                "read-only-guard" => resolve_read_only_mode_guard_json(&input_json)?,
                "permission-stall" => resolve_permission_stall_json(&input_json)?,
                "continue-prompt" => build_permission_stall_continue_prompt_json(&input_json)?,
                _ => {
                    return Err("Usage: unclecode rust ux prompt-turn <summary-prompt|summary-text|chat-input|prompt-command-input|conversation-summary|edit-intent|read-only-guard|permission-stall|continue-prompt>".to_string())
                }
            };
            println!("{output}");
            Ok(0)
        }
        Some("trace-event") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_trace_event_json(&input_json)?);
            Ok(0)
        }
        Some("trace-line-patch") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_trace_line_patch_json(&input_json)?);
            Ok(0)
        }
        Some("trace-mode-patch") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_trace_mode_patch_json(&input_json)?);
            Ok(0)
        }
        Some("busy-state-patch") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_busy_state_patch_json(&input_json)?);
            Ok(0)
        }
        Some("auth-state-patch") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_auth_state_patch_json(&input_json)?);
            Ok(0)
        }
        Some("dashboard-home-patch") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_dashboard_home_patch_json(&input_json)?);
            Ok(0)
        }
        Some("dashboard-home-sync-state") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                resolve_work_shell_dashboard_home_sync_state_json(&input_json)?
            );
            Ok(0)
        }
        Some("dashboard-home-refresh") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", should_refresh_work_shell_dashboard_home_json(&input_json)?);
            Ok(0)
        }
        Some("initial-state") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_work_shell_initial_state_json(&input_json)?);
            Ok(0)
        }
        Some("append-entries-patch") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                resolve_work_shell_append_entries_patch_json(&input_json)?
            );
            Ok(0)
        }
        Some("mode-default-reasoning") => {
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                resolve_work_shell_mode_default_reasoning_json(&input_json)?
            );
            Ok(0)
        }
        Some("text") => {
            let operation = args.get(1).and_then(|arg| arg.to_str()).ok_or(
                "Usage: unclecode rust ux text <normalize-markdown|busy-status|trace-line|attachment-preview|inline-command-summary|inline-image-support|inline-image-sequence|work-shell-transition|wrap-display|panel-line-class|panel-layout|entry-presentation|attachment-layout|viewport-layout|composer-dock-layout|error-message|provider-title|runtime-label|empty-conversation-hint|composer-hint|thinking-line|mode-label|status-line|usage-line|footer-line>",
            )?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            match operation {
                "normalize-markdown" => println!("{}", normalize_markdown_display_text(&input)),
                "busy-status" => println!("{}", normalize_busy_status(Some(&input))),
                "trace-line" => println!("{}", format_trace_line_json(&input)?),
                "attachment-preview" => println!("{}", build_attachment_preview_lines_json(&input)?),
                "inline-command-summary" => println!("{}", format_inline_command_summary_json(&input)?),
                "inline-image-support" => println!(
                    "{}",
                    format_inline_image_support_line_from_env(|key| env::var(key).ok())
                ),
                "inline-image-sequence" => {
                    if let Some(sequence) =
                        build_terminal_inline_image_sequence_json(&input, |key| env::var(key).ok())?
                    {
                        println!("{sequence}");
                    }
                }
                "work-shell-transition" => println!("{}", build_work_shell_transition_json(&input)?),
                "wrap-display" => println!("{}", wrap_display_text_json(&input)?),
                "panel-line-class" => println!("{}", classify_work_shell_panel_line_json(&input)?),
                "panel-layout" => println!("{}", resolve_work_shell_panel_layout_json(&input)?),
                "entry-presentation" => {
                    println!("{}", resolve_work_shell_entry_presentation_json(input.trim())?)
                }
                "attachment-layout" => {
                    println!("{}", resolve_work_shell_attachment_layout_json(&input)?)
                }
                "viewport-layout" => println!("{}", resolve_work_shell_viewport_layout_json(&input)?),
                "composer-dock-layout" => {
                    println!("{}", resolve_work_shell_composer_dock_layout_json(&input)?)
                }
                "error-message" => println!("{}", format_work_shell_error_message(&input)),
                "provider-title" => println!("{}", format_work_shell_provider_title(input.trim())),
                "runtime-label" => println!("{}", format_runtime_label_json(&input)?),
                "empty-conversation-hint" => println!("{}", work_shell_empty_conversation_hint()),
                "composer-hint" => println!("{}", work_shell_composer_hint_json(&input)?),
                "thinking-line" => println!("{}", format_work_shell_thinking_line(input.trim())),
                "mode-label" => println!("{}", format_work_shell_mode_label(input.trim())),
                "status-line" => println!("{}", format_work_shell_status_line_json(&input)?),
                "usage-line" => println!("{}", format_work_shell_usage_line_json(&input)?),
                "footer-line" => println!("{}", format_work_shell_footer_line_json(&input)?),
                _ => {
                    return Err(
                        "Usage: unclecode rust ux text <normalize-markdown|busy-status|trace-line|attachment-preview|inline-command-summary|inline-image-support|inline-image-sequence|work-shell-transition|wrap-display|panel-line-class|panel-layout|entry-presentation|attachment-layout|viewport-layout|composer-dock-layout|error-message|provider-title|runtime-label|empty-conversation-hint|composer-hint|thinking-line|mode-label|status-line|usage-line|footer-line>"
                            .to_string(),
                    )
                }
            }
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust ux <panel|model-suggestions|model-panel|model-command|model-builtin-command|reasoning-command|reasoning-builtin-command|trace-mode-command|skills-command|help-command|context-command|queue-command|auth-key-command|auth-key-submit-result|auth-progress-result|sensitive-input-cancel-result|skill-command|tools-command|status-command|clear-command|harness-command|sessions-command|reload-command|memories-command|remember-command|inline-command-result|inline-command-visibility|prompt-failure-result|prompt-success-result|prompt-start-result|prompt-finalize-result|post-turn-success-result|slash-suggestions|input-action|submit-action|slash-submit-block|slash-selection|clipboard-cap|attachment-dedup|auth-label|auth-extract-label|auth-launcher-lines|auth-status-panel-lines|auth-browser-failure-lines|composer-preview-mode|prompt-turn|trace-event|trace-line-patch|trace-mode-patch|busy-state-patch|auth-state-patch|dashboard-home-patch|dashboard-home-sync-state|dashboard-home-refresh|initial-state|append-entries-patch|mode-default-reasoning|text>"
                .to_string(),
        ),
    }
}

fn run_native_context_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("guidance") => {
            let cwd = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context guidance <cwd> <home-dir|->")?;
            let home = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context guidance <cwd> <home-dir|->")?;
            let mut skills_json = String::new();
            io::stdin()
                .read_to_string(&mut skills_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_workspace_guidance_json(
                    Path::new(cwd),
                    (home != "-").then_some(Path::new(home)),
                    if skills_json.trim().is_empty() {
                        "[]"
                    } else {
                        &skills_json
                    },
                )?
            );
            Ok(0)
        }
        Some("repo-map-token") => {
            let root_dir = context_root_arg(args, "repo-map-token")?;
            println!("{}", get_repo_map_cache_token(Path::new(root_dir)));
            Ok(0)
        }
        Some("repo-map") => {
            let root_dir = context_root_arg(args, "repo-map")?;
            println!("{}", build_repo_map_json(Path::new(root_dir))?);
            Ok(0)
        }
        Some("worktree-fingerprint") => {
            let root_dir = context_root_arg(args, "worktree-fingerprint")?;
            println!("{}", build_worktree_fingerprint_json(Path::new(root_dir))?);
            Ok(0)
        }
        Some("freshness") => {
            let root_dir = context_root_arg(args, "freshness")?;
            let mut packet_json = String::new();
            io::stdin()
                .read_to_string(&mut packet_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", check_freshness_json(Path::new(root_dir), &packet_json)?);
            Ok(0)
        }
        Some("token-budget") => {
            let mode = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context token-budget <mode>")?;
            println!("{}", token_budget_json(mode)?);
            Ok(0)
        }
        Some("estimate-tokens") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", estimate_context_tokens(&input));
            Ok(0)
        }
        Some("hotspots") => {
            let top_n = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .unwrap_or("10")
                .parse::<usize>()
                .map_err(|error| format!("Invalid hotspot count: {error}"))?;
            let mut repo_map_json = String::new();
            io::stdin()
                .read_to_string(&mut repo_map_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", detect_hotspots_json(&repo_map_json, top_n)?);
            Ok(0)
        }
        Some("diff") => {
            let root_dir = context_root_arg(args, "diff")?;
            let since_sha = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context diff <root-dir> <since-sha>")?;
            println!("{}", summarize_diff_json(Path::new(root_dir), since_sha)?);
            Ok(0)
        }
        Some("selection") => {
            let root_dir = context_root_arg(args, "selection")?;
            let mode = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context selection <root-dir> <mode> [since-sha|-]")?;
            let since_sha = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-");
            let mut repo_map_json = String::new();
            io::stdin()
                .read_to_string(&mut repo_map_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_context_selection_json(Path::new(root_dir), mode, since_sha, &repo_map_json)?
            );
            Ok(0)
        }
        Some("skills") => {
            let mode = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context skills <metadata|list> <cwd> <home-dir>")?;
            let cwd = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context skills <metadata|list> <cwd> <home-dir>")?;
            let home = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context skills <metadata|list> <cwd> <home-dir>")?;
            let output = match mode {
                "metadata" => discover_skill_metadata_json(Path::new(cwd), Path::new(home))?,
                "list" => list_available_skills_json(Path::new(cwd), Path::new(home))?,
                _ => return Err("Usage: unclecode rust context skills <metadata|list> <cwd> <home-dir>".to_string()),
            };
            println!("{output}");
            Ok(0)
        }
        Some("skill-load") => {
            let name = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context skill-load <name> <cwd> <home-dir>")?;
            let cwd = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context skill-load <name> <cwd> <home-dir>")?;
            let home = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust context skill-load <name> <cwd> <home-dir>")?;
            println!("{}", load_named_skill_json(name, Path::new(cwd), Path::new(home))?);
            Ok(0)
        }
        Some("auth-issues") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", apply_auth_issue_lines_json(&input)?);
            Ok(0)
        }
        _ => Err("Usage: unclecode rust context <guidance|repo-map|repo-map-token|worktree-fingerprint|freshness|selection|token-budget|estimate-tokens|hotspots|diff|skills|skill-load|auth-issues>".to_string()),
    }
}

fn context_root_arg<'a>(args: &'a [OsString], command: &str) -> Result<&'a str, String> {
    args.get(1)
        .and_then(|arg| arg.to_str())
        .ok_or_else(|| format!("Usage: unclecode rust context {command} <root-dir>"))
}

fn run_native_http_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("post") => {
            let url = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust http post <url>")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let headers_json = parts.first().copied().unwrap_or("{}");
            let body = parts.get(1).copied().unwrap_or("");
            let response = post_json_with_headers(url, headers_json, body)?;
            println!("{}", http_transport_response_json(&response)?);
            Ok(0)
        }
        Some("proxy-policy") => {
            let url = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust http proxy-policy <url>")?;
            println!("{}", proxy_policy_json(&resolve_proxy_policy(url)?)?);
            Ok(0)
        }
        _ => Err("Usage: unclecode rust http <post|proxy-policy>".to_string()),
    }
}

fn run_native_harness_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("inspect") => {
            let cwd = args.get(1).map(PathBuf::from).unwrap_or(work_cwd()?);
            let status = inspect_harness_status(&cwd);
            println!(
                "configPath\t{}",
                escape_field(&status.config_path.to_string_lossy())
            );
            println!("exists\t{}", status.exists);
            print_optional_field("model", status.model.as_deref());
            print_optional_field("reasoningEffort", status.reasoning_effort.as_deref());
            print_optional_field("approvals", status.approvals.as_deref());
            print_optional_field("trustLevel", status.trust_level.as_deref());
            println!("multiAgent\t{}", status.multi_agent);
            for item in status.status_line {
                println!("statusLine\t{}", escape_field(&item));
            }
            for item in status.mcp_servers {
                println!("mcpServer\t{}", escape_field(&item));
            }
            Ok(0)
        }
        Some("apply") => {
            let preset = args.get(1).and_then(|arg| arg.to_str()).ok_or_else(|| {
                format!(
                    "Usage: unclecode rust harness apply <{}> [cwd]",
                    harness_preset_ids().join("|")
                )
            })?;
            let cwd = args.get(2).map(PathBuf::from).unwrap_or(work_cwd()?);
            let changes = apply_harness_preset(&cwd, preset)?;
            for change in changes {
                println!(
                    "change\tkey={}\tvalue={}\tchanged={}",
                    escape_field(&change.key),
                    escape_field(&change.value),
                    change.changed
                );
            }
            Ok(0)
        }
        Some("presets") => {
            for preset in harness_preset_ids() {
                println!("preset\tid={}", escape_field(preset));
            }
            Ok(0)
        }
        Some("preset") => {
            let preset = args.get(1).and_then(|arg| arg.to_str()).ok_or_else(|| {
                format!(
                    "Usage: unclecode rust harness preset <{}>",
                    harness_preset_ids().join("|")
                )
            })?;
            let patch = unclecode_core::harness::harness_preset_patch(preset).ok_or_else(|| {
                format!(
                    "Unknown preset: {preset}. Available: {}",
                    harness_preset_ids().join(", ")
                )
            })?;
            for (key, value) in patch {
                println!(
                    "patch\tkey={}\tvalue={}",
                    escape_field(key),
                    escape_field(value)
                );
            }
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust harness <inspect|apply|presets|preset> [args...]".to_string(),
        ),
    }
}

fn run_native_perf_command(args: &[OsString], started_at: Instant) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("startup") => {
            println!("probe=native-startup");
            println!(
                "elapsedMs={:.3}",
                started_at.elapsed().as_secs_f64() * 1000.0
            );
            Ok(0)
        }
        _ => Err("Usage: unclecode rust perf <startup>".to_string()),
    }
}

fn print_optional_field(key: &str, value: Option<&str>) {
    println!("{key}\t{}", value.map(escape_field).unwrap_or_default());
}

fn escape_field(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

fn run_native_json_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("normalize-object-arg") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", normalize_json_object_argument(&input));
            Ok(0)
        }
        _ => Err("Usage: unclecode rust json <normalize-object-arg>".to_string()),
    }
}

fn run_native_sse_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("data-blocks") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let mut stdout = io::stdout().lock();
            for block in parse_sse_data_blocks(&input) {
                stdout
                    .write_all(block.as_bytes())
                    .map_err(|error| format!("Failed to write stdout: {error}"))?;
                stdout
                    .write_all(&[0])
                    .map_err(|error| format!("Failed to write stdout: {error}"))?;
            }
            Ok(0)
        }
        Some("responses-records") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            for record in parse_responses_sse_records(&input) {
                match record {
                    ResponsesSseRecord::ResponseId(id) => {
                        println!("responseId\tid={}", escape_field(&id));
                    }
                    ResponsesSseRecord::ReasoningDelta {
                        kind,
                        item_id,
                        delta,
                    } => {
                        println!(
                            "reasoningDelta\tkind={}\titemId={}\tdelta={}",
                            escape_field(&kind),
                            escape_field(&item_id),
                            escape_field(&delta)
                        );
                    }
                    ResponsesSseRecord::TextBlock { text } => {
                        println!("block\ttype=text\ttext={}", escape_field(&text));
                    }
                    ResponsesSseRecord::ReasoningBlock {
                        item_id,
                        summary,
                        text,
                    } => {
                        println!(
                            "block\ttype=reasoning\titemId={}\tsummary={}\ttext={}",
                            escape_field(&item_id),
                            escape_field(&summary),
                            escape_field(&text)
                        );
                    }
                    ResponsesSseRecord::ToolUseBlock {
                        id,
                        name,
                        input_json,
                    } => {
                        println!(
                            "block\ttype=tool_use\tid={}\tname={}\tinputJson={}",
                            escape_field(&id),
                            escape_field(&name),
                            escape_field(&input_json)
                        );
                    }
                }
            }
            Ok(0)
        }
        Some("responses-result") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", parse_responses_sse_result_json(&input)?);
            Ok(0)
        }
        Some("responses-message") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", parse_responses_sse_message_json(&input)?);
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust sse <data-blocks|responses-records|responses-result|responses-message>"
                .to_string(),
        ),
    }
}

fn run_native_provider_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("system-prompt") => {
            let mut appendix = String::new();
            io::stdin()
                .read_to_string(&mut appendix)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_provider_system_prompt(Some(&appendix)));
            Ok(0)
        }
        Some("tool-policy") => {
            let surface = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider tool-policy <surface>")?;
            let mut tools_json = String::new();
            io::stdin()
                .read_to_string(&mut tools_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_provider_tool_policy_json(surface, &tools_json)?);
            Ok(0)
        }
        Some("openai-request-spec") | Some("openai-request-spec-json") => {
            let emit_json = args.first().and_then(|arg| arg.to_str()) == Some("openai-request-spec-json");
            let runtime = args.get(1).and_then(|arg| arg.to_str()).ok_or(
                "Usage: unclecode rust provider openai-request-spec[-json] <api|codex> [account-id|-]",
            )?;
            let account_id = args.get(2).and_then(|arg| arg.to_str()).unwrap_or("-");
            let mut api_key = String::new();
            io::stdin()
                .read_to_string(&mut api_key)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let spec = match runtime {
                "api" => build_openai_chat_request_spec(api_key.trim()),
                "codex" => build_openai_codex_request_spec(
                    api_key.trim(),
                    (account_id != "-").then_some(account_id),
                ),
                _ => return Err(
                    "Usage: unclecode rust provider openai-request-spec[-json] <api|codex> [account-id|-]"
                        .to_string(),
                ),
            };
            if emit_json {
                println!("{}", provider_request_spec_json(&spec.url, &spec.headers));
            } else {
                print_provider_request_spec(&spec);
            }
            Ok(0)
        }
        Some("openai-post") => {
            let runtime = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-post <api|codex> [account-id|-]")?;
            let account_id = args.get(2).and_then(|arg| arg.to_str()).unwrap_or("-");
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let api_key = parts.first().copied().unwrap_or("");
            let body = parts.get(1).copied().unwrap_or("");
            let base_url = env::var("OPENAI_API_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
            let response_json = match runtime {
                "api" => post_openai_chat_json(api_key, body, &base_url)?,
                "codex" => post_openai_codex_json(api_key, body, (account_id != "-").then_some(account_id))?,
                _ => return Err(
                    "Usage: unclecode rust provider openai-post <api|codex> [account-id|-]"
                        .to_string(),
                ),
            };
            println!("{response_json}");
            Ok(0)
        }
        Some("openai-chat-body") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-chat-body <model> <reasoning-effort|-> <include-tools yes|no>")?;
            let reasoning = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-chat-body <model> <reasoning-effort|-> <include-tools yes|no>")?;
            let include_tools = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-chat-body <model> <reasoning-effort|-> <include-tools yes|no>")?;
            let prompt_cache_key = args.get(4).and_then(|arg| arg.to_str());
            let prompt_cache_retention = args.get(5).and_then(|arg| arg.to_str());
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let messages_json = parts.first().copied().unwrap_or("[]");
            let tools_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                build_openai_chat_request_body(
                    model,
                    messages_json,
                    (include_tools == "yes").then_some(tools_json),
                    (reasoning != "-").then_some(reasoning),
                    prompt_cache_key.filter(|value| *value != "-"),
                    prompt_cache_retention.filter(|value| *value != "-"),
                )
            );
            Ok(0)
        }
        Some("openai-codex-body") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-codex-body <model> <reasoning-effort|-> <tool-choice auto|none>")?;
            let reasoning = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-codex-body <model> <reasoning-effort|-> <tool-choice auto|none>")?;
            let tool_choice = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-codex-body <model> <reasoning-effort|-> <tool-choice auto|none>")?;
            let prompt_cache_key = args.get(4).and_then(|arg| arg.to_str());
            let prompt_cache_retention = args.get(5).and_then(|arg| arg.to_str());
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let instructions = parts.first().copied().unwrap_or("");
            let input_json = parts.get(1).copied().unwrap_or("[]");
            let tools_json = parts.get(2).copied().unwrap_or("[]");
            println!(
                "{}",
                build_openai_codex_request_body(
                    model,
                    instructions,
                    input_json,
                    tools_json,
                    tool_choice,
                    (reasoning != "-").then_some(reasoning),
                    prompt_cache_key.filter(|value| *value != "-"),
                    prompt_cache_retention.filter(|value| *value != "-"),
                )
            );
            Ok(0)
        }
        Some("reasoning-effort") => {
            let mut reasoning_json = String::new();
            io::stdin()
                .read_to_string(&mut reasoning_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", resolve_runtime_reasoning_effort_json(&reasoning_json)?);
            Ok(0)
        }
        Some("app-reasoning") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider app-reasoning <provider> <model> <mode> [override|-]")?;
            let model = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider app-reasoning <provider> <model> <mode> [override|-]")?;
            let mode = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider app-reasoning <provider> <model> <mode> [override|-]")?;
            let override_effort = args
                .get(4)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-");
            println!(
                "{}",
                resolve_app_reasoning_config_json(provider, model, mode, override_effort)?
            );
            Ok(0)
        }
        Some("openai-chat-tools") => {
            let mut definitions_json = String::new();
            io::stdin()
                .read_to_string(&mut definitions_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", tool_definitions_to_chat_tools_json(&definitions_json)?);
            Ok(0)
        }
        Some("openai-query-messages") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let default_system_prompt = parts.first().copied().unwrap_or("");
            let messages_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                provider_query_messages_to_openai_json(messages_json, default_system_prompt)?
            );
            Ok(0)
        }
        Some("openai-chat-response") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            for record in parse_openai_chat_response_records(&raw)? {
                print_openai_chat_response_record(&record);
            }
            Ok(0)
        }
        Some("openai-chat-response-json") => {
            let model = args
                .get(1)
                .and_then(|value| value.to_str())
                .filter(|value| *value != "-");
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let source = if raw.trim().is_empty() {
                r#"{"choices":[{"message":{}}]}"#
            } else {
                &raw
            };
            println!("{}", parse_openai_chat_response_json_for_model(source, model)?);
            Ok(0)
        }
        Some("openai-chat-stream-progress") => {
            let mut chunk_json = String::new();
            io::stdin()
                .read_to_string(&mut chunk_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", is_openai_chat_stream_progress_chunk_json(&chunk_json)?);
            Ok(0)
        }
        Some("request-error") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let status = parse_u16_arg(args.get(2), "status")?;
            let attempts = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok());
            let mut response_body = String::new();
            io::stdin()
                .read_to_string(&mut response_body)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_request_error_message(provider, status, &response_body, attempts)?
            );
            Ok(0)
        }
        Some("openai-tool-actions") => {
            let mut tool_calls_json = String::new();
            io::stdin()
                .read_to_string(&mut tool_calls_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", openai_tool_calls_to_actions_json(&tool_calls_json)?);
            Ok(0)
        }
        Some("openai-chat-query") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-chat-query <model> <reasoning-effort|->")?;
            let reasoning = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-chat-query <model> <reasoning-effort|->")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let api_key = parts.first().copied().unwrap_or("");
            let system_prompt = parts.get(1).copied().unwrap_or("");
            let messages_json = parts.get(2).copied().unwrap_or("[]");
            let tools_json = parts.get(3).copied().unwrap_or("[]");
            let base_url = env::var("OPENAI_API_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
            println!(
                "{}",
                run_openai_chat_query_json(
                    api_key,
                    model,
                    system_prompt,
                    messages_json,
                    tools_json,
                    (reasoning != "-").then_some(reasoning),
                    &base_url,
                )?
            );
            Ok(0)
        }
        Some("openai-chat-complete") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-chat-complete <model> <reasoning-effort|->")?;
            let reasoning = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-chat-complete <model> <reasoning-effort|->")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let api_key = parts.first().copied().unwrap_or("");
            let messages_json = parts.get(1).copied().unwrap_or("[]");
            let tools_json = parts.get(2).copied().unwrap_or("[]");
            let base_url = env::var("OPENAI_API_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
            println!(
                "{}",
                run_openai_chat_completion_json(
                    api_key,
                    model,
                    messages_json,
                    tools_json,
                    (reasoning != "-").then_some(reasoning),
                    &base_url,
                )?
            );
            Ok(0)
        }
        Some("loop-decision") => {
            let iteration = parse_usize_arg(args.get(1), "iteration")?;
            let action_count = parse_usize_arg(args.get(2), "action-count")?;
            let max_iterations = parse_usize_arg(args.get(3), "max-iterations")?;
            let mut assistant_text = String::new();
            io::stdin()
                .read_to_string(&mut assistant_text)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_loop_decision_json(
                    iteration,
                    max_iterations,
                    action_count,
                    assistant_text.trim_end_matches(['\r', '\n']),
                )
            );
            Ok(0)
        }
        Some("iteration-action-plan") => {
            let iteration = parse_usize_arg(args.get(1), "iteration")?;
            let action_count = parse_usize_arg(args.get(2), "action-count")?;
            let max_iterations = parse_usize_arg(args.get(3), "max-iterations")?;
            let mut assistant_text = String::new();
            io::stdin()
                .read_to_string(&mut assistant_text)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_iteration_action_plan_json(
                    iteration,
                    max_iterations,
                    action_count,
                    assistant_text.trim_end_matches(['\r', '\n']),
                )
            );
            Ok(0)
        }
        Some("loop-limit") => {
            println!("{}", provider_loop_limit_json());
            Ok(0)
        }
        Some("turn-step") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let iteration = parse_usize_arg(args.get(2), "iteration")?;
            let action_count = parse_usize_arg(args.get(3), "action-count")?;
            let max_iterations = parse_usize_arg(args.get(4), "max-iterations")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let previous_assistant_text = parts.first().copied().unwrap_or("");
            let response_text = parts.get(1).copied().unwrap_or("");
            let state_json = parts.get(2).copied().unwrap_or("[]");
            let response_entries_json = parts.get(3).copied().unwrap_or("[]");
            println!(
                "{}",
                provider_turn_step_json(
                    provider,
                    iteration,
                    max_iterations,
                    previous_assistant_text,
                    response_text,
                    action_count,
                    state_json,
                    response_entries_json,
                )?
            );
            Ok(0)
        }
        Some("complete-turn-step") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let iteration = parse_usize_arg(args.get(2), "iteration")?;
            let action_count = parse_usize_arg(args.get(3), "action-count")?;
            let max_iterations = parse_usize_arg(args.get(4), "max-iterations")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let previous_assistant_text = parts.first().copied().unwrap_or("");
            let response_text = parts.get(1).copied().unwrap_or("");
            let state_json = parts.get(2).copied().unwrap_or("[]");
            let response_entries_json = parts.get(3).copied().unwrap_or("[]");
            let tool_outcomes_json = parts.get(4).copied().unwrap_or("[]");
            println!(
                "{}",
                provider_complete_turn_step_json(
                    provider,
                    iteration,
                    max_iterations,
                    previous_assistant_text,
                    response_text,
                    action_count,
                    state_json,
                    response_entries_json,
                    tool_outcomes_json,
                )?
            );
            Ok(0)
        }
        Some("tool-dispatch-plan") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let actions_json = parts.first().copied().unwrap_or("[]");
            let handler_names_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                provider_tool_dispatch_plan_json(provider, actions_json, handler_names_json)?
            );
            Ok(0)
        }
        Some("append-state") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let state_json = parts.first().copied().unwrap_or("[]");
            let entries_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                append_provider_turn_state_json(provider, state_json, entries_json)?
            );
            Ok(0)
        }
        Some("start-turn") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let prompt = parse_str_arg(args.get(2), "prompt")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let state_json = parts.first().copied().unwrap_or("[]");
            let attachments_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                start_provider_turn_state_json(provider, state_json, prompt, attachments_json)?
            );
            Ok(0)
        }
        Some("reset-state") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let mut system_prompt = String::new();
            io::stdin()
                .read_to_string(&mut system_prompt)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", reset_provider_turn_state_json(provider, &system_prompt)?);
            Ok(0)
        }
        Some("runtime-settings") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let current_model = parse_str_arg(args.get(2), "current-model")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let current_reasoning_json = parts.first().copied().unwrap_or("-");
            let settings_json = parts.get(1).copied().unwrap_or("{}");
            println!(
                "{}",
                resolve_provider_runtime_settings_json(
                    provider,
                    current_model,
                    current_reasoning_json,
                    settings_json
                )?
            );
            Ok(0)
        }
        Some("attachment-caps") => {
            let mut attachments_json = String::new();
            io::stdin()
                .read_to_string(&mut attachments_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", cap_provider_attachments_result_json(&attachments_json)?);
            Ok(0)
        }
        Some("tool-result-turn-step") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let state_json = parts.first().copied().unwrap_or("[]");
            let outcomes_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                append_provider_tool_result_turn_json(provider, state_json, outcomes_json)?
            );
            Ok(0)
        }
        Some("reasoning-delta") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let model = parse_str_arg(args.get(2), "model")?;
            let kind = parse_str_arg(args.get(3), "kind")?;
            let mut delta = String::new();
            io::stdin()
                .read_to_string(&mut delta)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_reasoning_delta_trace_json(provider, model, kind, &delta)?
            );
            Ok(0)
        }
        Some("reasoning-delta-record") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let model = parse_str_arg(args.get(2), "model")?;
            let kind = parse_str_arg(args.get(3), "kind")?;
            let item_id = parse_str_arg(args.get(4), "item-id")?;
            let mut delta = String::new();
            io::stdin()
                .read_to_string(&mut delta)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_reasoning_delta_trace_with_item_id_json(
                    provider, model, kind, item_id, &delta,
                )?
            );
            Ok(0)
        }
        Some("route-trace") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let model = parse_str_arg(args.get(2), "model")?;
            let started_at = parse_u64_arg(args.get(3), "started-at")?;
            println!("{}", provider_route_trace_json(provider, model, started_at)?);
            Ok(0)
        }
        Some("turn-started-trace") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let model = parse_str_arg(args.get(2), "model")?;
            let started_at = parse_u64_arg(args.get(3), "started-at")?;
            let mut prompt = String::new();
            io::stdin()
                .read_to_string(&mut prompt)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_turn_started_trace_json(provider, model, &prompt, started_at)?
            );
            Ok(0)
        }
        Some("calling-trace") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let model = parse_str_arg(args.get(2), "model")?;
            let started_at = parse_u64_arg(args.get(3), "started-at")?;
            println!("{}", provider_calling_trace_json(provider, model, started_at)?);
            Ok(0)
        }
        Some("turn-completed-trace") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let model = parse_str_arg(args.get(2), "model")?;
            let started_at = parse_u64_arg(args.get(3), "started-at")?;
            let completed_at = parse_u64_arg(args.get(4), "completed-at")?;
            let mut text = String::new();
            io::stdin()
                .read_to_string(&mut text)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_turn_completed_trace_json(
                    provider,
                    model,
                    &text,
                    started_at,
                    completed_at,
                )?
            );
            Ok(0)
        }
        Some("openai-responses-message") => {
            let model = parse_str_arg(args.get(1), "model")?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                parse_responses_sse_provider_message_json("openai", model, &input)?
            );
            Ok(0)
        }
        Some("tool-trace-started") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let tool_name = parse_str_arg(args.get(2), "tool-name")?;
            let tool_call_id = parse_str_arg(args.get(3), "tool-call-id")?;
            let started_at = parse_u64_arg(args.get(4), "started-at")?;
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_started_trace_json(
                    provider,
                    tool_name,
                    tool_call_id,
                    started_at,
                    &input_json,
                )?
            );
            Ok(0)
        }
        Some("tool-trace-completed") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let tool_name = parse_str_arg(args.get(2), "tool-name")?;
            let tool_call_id = parse_str_arg(args.get(3), "tool-call-id")?;
            let started_at = parse_u64_arg(args.get(4), "started-at")?;
            let completed_at = parse_u64_arg(args.get(5), "completed-at")?;
            let is_error = parse_str_arg(args.get(6), "is-error")? == "yes";
            let mut output = String::new();
            io::stdin()
                .read_to_string(&mut output)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_completed_trace_json(
                    provider,
                    tool_name,
                    tool_call_id,
                    started_at,
                    completed_at,
                    is_error,
                    &output,
                )?
            );
            Ok(0)
        }
        Some("tool-execution-start") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let tool_name = parse_str_arg(args.get(2), "tool-name")?;
            let tool_call_id = parse_str_arg(args.get(3), "tool-call-id")?;
            let mut input_json = String::new();
            io::stdin()
                .read_to_string(&mut input_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_execution_start_json(provider, tool_name, tool_call_id, &input_json)?
            );
            Ok(0)
        }
        Some("tool-execution-result") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let tool_name = parse_str_arg(args.get(2), "tool-name")?;
            let tool_call_id = parse_str_arg(args.get(3), "tool-call-id")?;
            let started_at = parse_u64_arg(args.get(4), "started-at")?;
            let completed_at = parse_u64_arg(args.get(5), "completed-at")?;
            let is_error = parse_str_arg(args.get(6), "is-error")? == "yes";
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_execution_result_json(
                    provider,
                    tool_name,
                    tool_call_id,
                    started_at,
                    completed_at,
                    is_error,
                    &content,
                )?
            );
            Ok(0)
        }
        Some("tool-execution-finish") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let tool_name = parse_str_arg(args.get(2), "tool-name")?;
            let tool_call_id = parse_str_arg(args.get(3), "tool-call-id")?;
            let started_at = parse_u64_arg(args.get(4), "started-at")?;
            let is_error = parse_str_arg(args.get(5), "is-error")? == "yes";
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_execution_finish_json(
                    provider,
                    tool_name,
                    tool_call_id,
                    started_at,
                    is_error,
                    &content,
                )?
            );
            Ok(0)
        }
        Some("tool-execution-finish-result") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let tool_name = parse_str_arg(args.get(2), "tool-name")?;
            let tool_call_id = parse_str_arg(args.get(3), "tool-call-id")?;
            let started_at = parse_u64_arg(args.get(4), "started-at")?;
            let mut result_json = String::new();
            io::stdin()
                .read_to_string(&mut result_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_execution_finish_result_json(
                    provider,
                    tool_name,
                    tool_call_id,
                    started_at,
                    &result_json,
                )?
            );
            Ok(0)
        }
        Some("tool-result") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let tool_name = parse_str_arg(args.get(2), "tool-name")?;
            let tool_call_id = parse_str_arg(args.get(3), "tool-call-id")?;
            let kind = parse_str_arg(args.get(4), "kind")?;
            let is_error = parse_str_arg(args.get(5), "is-error")? == "yes";
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_result_json(provider, tool_name, tool_call_id, kind, is_error, &content)?
            );
            Ok(0)
        }
        Some("tool-result-container") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let mut tool_results_json = String::new();
            io::stdin()
                .read_to_string(&mut tool_results_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_result_container_json(provider, &tool_results_json)?
            );
            Ok(0)
        }
        Some("tool-result-turn-entries") => {
            let provider = parse_str_arg(args.get(1), "provider")?;
            let mut outcomes_json = String::new();
            io::stdin()
                .read_to_string(&mut outcomes_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                provider_tool_result_turn_entries_json(provider, &outcomes_json)?
            );
            Ok(0)
        }
        Some("openai-user-message") => {
            let prompt = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-user-message <prompt>")?;
            let mut attachments_json = String::new();
            io::stdin()
                .read_to_string(&mut attachments_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_openai_user_message_json(prompt, &attachments_json)?
            );
            Ok(0)
        }
        Some("openai-assistant-message") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let content = parts.first().copied().unwrap_or("");
            let tool_calls_json = parts.get(1).copied().unwrap_or("[]");
            let reasoning_content = parts.get(2).copied().filter(|value| !value.is_empty());
            println!(
                "{}",
                build_openai_assistant_message_json(content, tool_calls_json, reasoning_content)?
            );
            Ok(0)
        }
        Some("openai-tool-message") => {
            let tool_call_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider openai-tool-message <tool-call-id>")?;
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_openai_tool_message_json(tool_call_id, &content)?);
            Ok(0)
        }
        Some("openai-responses-input") => {
            let mut messages_json = String::new();
            io::stdin()
                .read_to_string(&mut messages_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", build_latest_responses_input_json(&messages_json)?);
            Ok(0)
        }
        Some("openai-responses-tools") => {
            let mut definitions_json = String::new();
            io::stdin()
                .read_to_string(&mut definitions_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                tool_definitions_to_responses_tools_json(&definitions_json)?
            );
            Ok(0)
        }
        Some("gemini-request-spec") | Some("gemini-request-spec-json") => {
            let emit_json = args.first().and_then(|arg| arg.to_str()) == Some("gemini-request-spec-json");
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-request-spec[-json] <model>")?;
            let mut api_key = String::new();
            io::stdin()
                .read_to_string(&mut api_key)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let base_url = env::var("GEMINI_API_BASE_URL")
                .unwrap_or_else(|_| "https://generativelanguage.googleapis.com/v1beta".to_string());
            let spec =
                build_gemini_generate_content_request_spec_with_base(&api_key, model, &base_url);
            if emit_json {
                println!("{}", provider_request_spec_json(&spec.url, &spec.headers));
            } else {
                print_gemini_request_spec(&spec.url, &spec.headers);
            }
            Ok(0)
        }
        Some("gemini-post") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-post <model>")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let api_key = parts.first().copied().unwrap_or("");
            let body = parts.get(1).copied().unwrap_or("");
            let base_url = env::var("GEMINI_API_BASE_URL")
                .unwrap_or_else(|_| "https://generativelanguage.googleapis.com/v1beta".to_string());
            println!(
                "{}",
                post_gemini_generate_content_json(api_key, model, body, &base_url)?
            );
            Ok(0)
        }
        Some("gemini-query-messages") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let default_system_prompt = parts.first().copied().unwrap_or("");
            let messages_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                provider_query_messages_to_gemini_json(messages_json, default_system_prompt)?
            );
            Ok(0)
        }
        Some("gemini-tools") => {
            let mut definitions_json = String::new();
            io::stdin()
                .read_to_string(&mut definitions_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                tool_definitions_to_gemini_function_declarations_json(&definitions_json)?
            );
            Ok(0)
        }
        Some("gemini-user-content") => {
            let prompt = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-user-content <prompt>")?;
            let mut attachments_json = String::new();
            io::stdin()
                .read_to_string(&mut attachments_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_gemini_user_content_json(prompt, &attachments_json)?
            );
            Ok(0)
        }
        Some("gemini-function-response") => {
            let name = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-function-response <name> <call-id> <success|error> <is-error yes|no>")?;
            let call_id = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-function-response <name> <call-id> <success|error> <is-error yes|no>")?;
            let kind = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-function-response <name> <call-id> <success|error> <is-error yes|no>")?;
            let is_error = args
                .get(4)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-function-response <name> <call-id> <success|error> <is-error yes|no>")?
                == "yes";
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_gemini_function_response_part_json(name, call_id, kind, &content, is_error)?
            );
            Ok(0)
        }
        Some("gemini-response") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-");
            let mut response_json = String::new();
            io::stdin()
                .read_to_string(&mut response_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                parse_gemini_response_json_for_model(&response_json, model)?
            );
            Ok(0)
        }
        Some("gemini-generate-request") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-generate-request <model> <include-tools yes|no>")?;
            let include_tools = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider gemini-generate-request <model> <include-tools yes|no>")?
                == "yes";
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let system_instruction = parts.first().copied().unwrap_or("");
            let contents_json = parts.get(1).copied().unwrap_or("[]");
            let function_declarations_json = parts.get(2).copied().unwrap_or("[]");
            println!(
                "{}",
                build_gemini_generate_content_request_json(
                    model,
                    system_instruction,
                    contents_json,
                    function_declarations_json,
                    include_tools,
                )?
            );
            Ok(0)
        }
        Some("anthropic-request-spec") | Some("anthropic-request-spec-json") => {
            let emit_json = args.first().and_then(|arg| arg.to_str()) == Some("anthropic-request-spec-json");
            let mut api_key = String::new();
            io::stdin()
                .read_to_string(&mut api_key)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let base_url = env::var("ANTHROPIC_API_BASE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com/v1".to_string());
            let spec = build_anthropic_messages_request_spec_with_base(&api_key, &base_url);
            if emit_json {
                println!("{}", provider_request_spec_json(&spec.url, &spec.headers));
            } else {
                print_provider_request_spec(&spec);
            }
            Ok(0)
        }
        Some("anthropic-post") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let api_key = parts.first().copied().unwrap_or("");
            let body = parts.get(1).copied().unwrap_or("");
            let base_url = env::var("ANTHROPIC_API_BASE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com/v1".to_string());
            println!("{}", post_anthropic_messages_json(api_key, body, &base_url)?);
            Ok(0)
        }
        Some("anthropic-query-messages") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let default_system_prompt = parts.first().copied().unwrap_or("");
            let messages_json = parts.get(1).copied().unwrap_or("[]");
            println!(
                "{}",
                provider_query_messages_to_anthropic_json(messages_json, default_system_prompt)?
            );
            Ok(0)
        }
        Some("anthropic-user-message") => {
            let prompt = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider anthropic-user-message <prompt>")?;
            let mut attachments_json = String::new();
            io::stdin()
                .read_to_string(&mut attachments_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_anthropic_user_message_json(prompt, &attachments_json)?
            );
            Ok(0)
        }
        Some("anthropic-tool-result") => {
            let tool_use_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider anthropic-tool-result <tool-use-id> <is-error yes|no|->")?;
            let is_error = match args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider anthropic-tool-result <tool-use-id> <is-error yes|no|->")?
            {
                "yes" => Some(true),
                "no" => Some(false),
                "-" => None,
                _ => {
                    return Err(
                        "Usage: unclecode rust provider anthropic-tool-result <tool-use-id> <is-error yes|no|->"
                            .to_string(),
                    )
                }
            };
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                build_anthropic_tool_result_block_json(tool_use_id, &content, is_error)?
            );
            Ok(0)
        }
        Some("anthropic-response") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-");
            let mut response_json = String::new();
            io::stdin()
                .read_to_string(&mut response_json)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                parse_anthropic_response_json_for_model(&response_json, model)?
            );
            Ok(0)
        }
        Some("anthropic-messages-request") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust provider anthropic-messages-request <model>")?;
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parts = split_nul_parts(&raw);
            let system = parts.first().copied().unwrap_or("");
            let messages_json = parts.get(1).copied().unwrap_or("[]");
            let tools_json = parts.get(2).copied().unwrap_or("[]");
            println!(
                "{}",
                build_anthropic_messages_request_json(model, system, messages_json, tools_json)?
            );
            Ok(0)
        }
        _ => Err("Usage: unclecode rust provider <system-prompt|tool-policy|openai-request-spec|openai-request-spec-json|openai-post|openai-chat-body|openai-codex-body|reasoning-effort|app-reasoning|openai-chat-tools|openai-query-messages|openai-chat-response|openai-chat-response-json|openai-chat-stream-progress|openai-tool-actions|openai-chat-query|openai-chat-complete|request-error|loop-decision|iteration-action-plan|loop-limit|turn-step|complete-turn-step|tool-dispatch-plan|reset-state|runtime-settings|append-state|start-turn|attachment-caps|tool-result-turn-step|reasoning-delta|reasoning-delta-record|route-trace|turn-started-trace|calling-trace|turn-completed-trace|openai-responses-message|tool-trace-started|tool-trace-completed|tool-execution-start|tool-execution-result|tool-execution-finish|tool-execution-finish-result|tool-result|tool-result-container|tool-result-turn-entries|openai-user-message|openai-assistant-message|openai-tool-message|openai-responses-input|openai-responses-tools|gemini-request-spec|gemini-request-spec-json|gemini-post|gemini-query-messages|gemini-tools|gemini-user-content|gemini-function-response|gemini-response|gemini-generate-request|anthropic-request-spec|anthropic-request-spec-json|anthropic-post|anthropic-query-messages|anthropic-user-message|anthropic-tool-result|anthropic-response|anthropic-messages-request>".to_string()),
    }
}

fn split_nul_parts(raw: &str) -> Vec<&str> {
    raw.split('\0').collect()
}

fn parse_usize_arg(arg: Option<&OsString>, name: &str) -> Result<usize, String> {
    arg.and_then(|value| value.to_str())
        .ok_or_else(|| {
            "Usage: unclecode rust provider loop-decision <iteration> <action-count> <max-iterations>".to_string()
        })?
        .parse::<usize>()
        .map_err(|error| format!("Invalid {name}: {error}"))
}

fn parse_u64_arg(arg: Option<&OsString>, name: &str) -> Result<u64, String> {
    arg.and_then(|value| value.to_str())
        .ok_or_else(|| format!("Missing {name}"))?
        .parse::<u64>()
        .map_err(|error| format!("Invalid {name}: {error}"))
}

fn parse_u16_arg(arg: Option<&OsString>, name: &str) -> Result<u16, String> {
    arg.and_then(|value| value.to_str())
        .ok_or_else(|| format!("Missing {name}"))?
        .parse::<u16>()
        .map_err(|error| format!("Invalid {name}: {error}"))
}

fn parse_str_arg<'a>(arg: Option<&'a OsString>, name: &str) -> Result<&'a str, String> {
    arg.and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {name}"))
}

fn print_provider_request_spec(spec: &ProviderRequestSpec) {
    println!("url\t{}", escape_field(&spec.url));
    for (key, value) in &spec.headers {
        println!(
            "header\tkey={}\tvalue={}",
            escape_field(key),
            escape_field(value)
        );
    }
}

fn print_gemini_request_spec(url: &str, headers: &[(String, String)]) {
    println!("url\t{}", escape_field(url));
    for (key, value) in headers {
        println!(
            "header\tkey={}\tvalue={}",
            escape_field(key),
            escape_field(value)
        );
    }
}

fn print_openai_chat_response_record(record: &OpenAIChatResponseRecord) {
    match record {
        OpenAIChatResponseRecord::Content(content) => {
            println!("content\ttext={}", escape_field(content));
        }
        OpenAIChatResponseRecord::Reasoning(reasoning) => {
            println!("reasoning\ttext={}", escape_field(reasoning));
        }
        OpenAIChatResponseRecord::ToolCall {
            id,
            name,
            arguments_json,
        } => {
            println!(
                "toolCall\tid={}\tname={}\targumentsJson={}",
                escape_field(id),
                escape_field(name),
                escape_field(arguments_json)
            );
        }
        OpenAIChatResponseRecord::Usage {
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
        } => {
            println!(
                "usage\tpromptTokens={prompt_tokens}\tcompletionTokens={completion_tokens}\tcacheReadTokens={cache_read_tokens}"
            );
        }
    }
}

fn run_native_model_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("openai-registry") => {
            let registry = openai_model_registry(env::var("OPENAI_MODEL").ok().as_deref());
            println!("provider={}", registry.provider_id);
            println!("defaultModel={}", registry.default_model);
            for model in registry.models {
                let support = openai_reasoning_support(&model);
                println!(
                    "model={}\treasoning={}\tdefaultEffort={}\tsupportedEfforts={}",
                    model,
                    support.status,
                    support.default_effort.unwrap_or_else(|| "none".to_string()),
                    support.supported_efforts.join(",")
                );
            }
            Ok(0)
        }
        Some("openai-reasoning") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model openai-reasoning <model-id>")?;
            let support = openai_reasoning_support(model);
            println!("status={}", support.status);
            println!(
                "defaultEffort={}",
                support.default_effort.unwrap_or_else(|| "none".to_string())
            );
            println!("supportedEfforts={}", support.supported_efforts.join(","));
            Ok(0)
        }
        Some("price") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model price <model-id>")?;
            match model_price(model) {
                Some(price) => {
                    println!("found=yes");
                    println!("inputUsdPer1M={}", price.input_usd_per_1m);
                    println!("outputUsdPer1M={}", price.output_usd_per_1m);
                }
                None => {
                    println!("found=no");
                    println!("inputUsdPer1M=0");
                    println!("outputUsdPer1M=0");
                }
            }
            Ok(0)
        }
        Some("estimate-cost") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model estimate-cost <model-id> <prompt-tokens> <completion-tokens>")?;
            let prompt_tokens = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model estimate-cost <model-id> <prompt-tokens> <completion-tokens>")?
                .parse::<f64>()
                .map_err(|error| format!("Invalid prompt token count: {error}"))?;
            let completion_tokens = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model estimate-cost <model-id> <prompt-tokens> <completion-tokens>")?
                .parse::<f64>()
                .map_err(|error| format!("Invalid completion token count: {error}"))?;
            println!(
                "costUsd={}",
                estimate_cost_usd(model, prompt_tokens, completion_tokens)
            );
            Ok(0)
        }
        Some("detect-provider") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model detect-provider <model-id>")?;
            println!("provider={}", detect_provider_for_model(model));
            Ok(0)
        }
        Some("provider-route") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model provider-route <provider-id|auto> [model-id]")?;
            let route = resolve_provider_route(provider, args.get(2).and_then(|arg| arg.to_str()))?;
            println!("provider={}", route.provider_id);
            println!("label={}", route.label);
            println!("transport={}", route.transport);
            println!(
                "runtimeSupported={}",
                if route.runtime_supported { "yes" } else { "no" }
            );
            println!("defaultModel={}", route.default_model);
            println!("endpointUrl={}", route.endpoint_url);
            let proxy = provider_route_proxy_policy(&route)?;
            println!(
                "proxyUrl={}",
                proxy
                    .proxy_url
                    .as_deref()
                    .map(redact_proxy_url_for_display)
                    .unwrap_or_default()
            );
            println!("proxySource={}", proxy.source);
            println!(
                "proxyBypassed={}",
                if proxy.bypassed { "yes" } else { "no" }
            );
            println!("proxyTargetHost={}", proxy.target_host);
            println!("noProxy={}", proxy.no_proxy.join(","));
            println!("envKeys={}", route.env_keys.join(","));
            Ok(0)
        }
        Some("provider-route-json") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model provider-route-json <provider-id|auto> [model-id]")?;
            let route = resolve_provider_route(provider, args.get(2).and_then(|arg| arg.to_str()))?;
            let proxy = provider_route_proxy_policy(&route)?;
            println!("{}", provider_route_json(&route, &proxy)?);
            Ok(0)
        }
        Some("provider-runtime-json") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model provider-runtime-json <provider-id|auto> [model-id]")?;
            let route = resolve_provider_route(provider, args.get(2).and_then(|arg| arg.to_str()))?;
            println!("{}", provider_runtime_decision_json(&route)?);
            Ok(0)
        }
        Some("openai-compat-policy-json") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model openai-compat-policy-json <provider-id> <model-id> [endpoint-url]")?;
            let model = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model openai-compat-policy-json <provider-id> <model-id> [endpoint-url]")?;
            println!(
                "{}",
                openai_compat_policy_json(provider, model, args.get(3).and_then(|arg| arg.to_str()))?
            );
            Ok(0)
        }
        Some("capability") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model capability <provider-id> <capability> [model-id]")?;
            let capability = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model capability <provider-id> <capability> [model-id]")?;
            let model = args.get(3).and_then(|arg| arg.to_str()).unwrap_or_default();
            println!("{}", provider_capability_json(provider, capability, model)?);
            Ok(0)
        }
        Some("label") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model label <provider-id>")?;
            println!("label={}", provider_label(provider));
            Ok(0)
        }
        Some("catalog") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust model catalog <provider-id>")?;
            let active_key = format!("{}_MODEL", provider.to_ascii_uppercase());
            let custom_key = format!("{}_MODELS", provider.to_ascii_uppercase());
            let catalog = provider_model_catalog(
                provider,
                env::var(&active_key).ok().as_deref(),
                env::var(&custom_key).ok().as_deref(),
            );
            println!("provider={}", catalog.provider_id);
            println!("label={}", catalog.label);
            for model in catalog.models {
                println!("model={model}");
            }
            Ok(0)
        }
        _ => Err("Usage: unclecode rust model <openai-registry|openai-reasoning <model-id>|price <model-id>|estimate-cost <model-id> <prompt-tokens> <completion-tokens>|detect-provider <model-id>|provider-route <provider-id|auto> [model-id]|provider-route-json <provider-id|auto> [model-id]|provider-runtime-json <provider-id|auto> [model-id]|openai-compat-policy-json <provider-id> <model-id> [endpoint-url]|capability <provider-id> <capability> [model-id]|label <provider-id>|catalog <provider-id>>".to_string()),
    }
}

fn run_native_auth_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("status") => {
            let status = resolve_openai_auth_status(|key| env::var(key).ok());
            let json_output = match args.get(1).and_then(|arg| arg.to_str()) {
                None => false,
                Some("--json") => true,
                Some("--help") | Some("-h") => {
                    println!("Usage: unclecode rust auth status [--json]");
                    return Ok(0);
                }
                Some(_) => return Err("Usage: unclecode rust auth status [--json]".to_string()),
            };
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string(&cli_auth::openai_auth_status_json(&status))
                        .map_err(|error| format!("Failed to encode auth status JSON: {error}"))?
                );
                return Ok(0);
            }
            println!("provider=openai");
            println!("activeSource={}", status.active_source);
            println!("authType={}", status.auth_type);
            println!(
                "organizationId={}",
                status.organization_id.as_deref().unwrap_or("none")
            );
            println!(
                "projectId={}",
                status.project_id.as_deref().unwrap_or("none")
            );
            println!(
                "runtime={}",
                status.runtime.as_deref().unwrap_or("none")
            );
            println!(
                "expiresAt={}",
                status.expires_at.as_deref().unwrap_or("none")
            );
            println!("expired={}", if status.is_expired { "yes" } else { "no" });
            println!(
                "apiReady={}",
                if openai_auth_supports_api_calls(&status) {
                    "yes"
                } else {
                    "no"
                }
            );
            Ok(0)
        }
        Some("resolve") => {
            let auth = resolve_openai_auth(|key| env::var(key).ok());
            println!("status={}", auth.status);
            println!("authType={}", auth.auth_type);
            println!("source={}", auth.source);
            println!(
                "bearerToken={}",
                auth.bearer_token.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "organizationId={}",
                auth.organization_id.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "projectId={}",
                auth.project_id.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "accountId={}",
                auth.account_id.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "runtime={}",
                auth.runtime.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "reason={}",
                auth.reason.unwrap_or_else(|| "none".to_string())
            );
            Ok(0)
        }
        Some("inspect-oauth-token") => {
            let mut token = String::new();
            io::stdin()
                .read_to_string(&mut token)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let inspection = inspect_openai_oauth_token(token.trim());
            println!(
                "payloadValid={}",
                if inspection.payload_valid { "true" } else { "false" }
            );
            println!(
                "hasModelRequestScope={}",
                if inspection.has_model_request_scope {
                    "true"
                } else {
                    "false"
                }
            );
            println!(
                "clientId={}",
                inspection.client_id.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "expiresAt={}",
                inspection
                    .expires_at
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            );
            println!(
                "expired={}",
                if inspection.is_expired { "true" } else { "false" }
            );
            Ok(0)
        }
        Some("authorization-url") => {
            let client_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth authorization-url <client-id> <redirect-uri> <state> <code-challenge> <base-url|-> <scopes...>")?;
            let redirect_uri = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth authorization-url <client-id> <redirect-uri> <state> <code-challenge> <base-url|-> <scopes...>")?;
            let state = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth authorization-url <client-id> <redirect-uri> <state> <code-challenge> <base-url|-> <scopes...>")?;
            let code_challenge = args
                .get(4)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth authorization-url <client-id> <redirect-uri> <state> <code-challenge> <base-url|-> <scopes...>")?;
            let base_url = args
                .get(5)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth authorization-url <client-id> <redirect-uri> <state> <code-challenge> <base-url|-> <scopes...>")?;
            let scopes = args[6..]
                .iter()
                .filter_map(|arg| arg.to_str())
                .map(ToString::to_string)
                .collect::<Vec<_>>();
            if scopes.is_empty() {
                return Err("Usage: unclecode rust auth authorization-url <client-id> <redirect-uri> <state> <code-challenge> <base-url|-> <scopes...>".to_string());
            }
            println!(
                "{}",
                build_openai_authorization_url(
                    client_id,
                    redirect_uri,
                    state,
                    code_challenge,
                    &scopes,
                    (base_url != "-").then_some(base_url),
                )
            );
            Ok(0)
        }
        Some("parse-callback") => {
            let expected_state = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth parse-callback <expected-state>")?;
            let mut request_url = String::new();
            io::stdin()
                .read_to_string(&mut request_url)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let code = parse_openai_callback_code(request_url.trim(), expected_state)?;
            println!("code={}", escape_field(&code));
            Ok(0)
        }
        Some("request-spec") => {
            let spec_type = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth request-spec <device-code|device-token|authorization-code|codex-device-code|codex-device-token> <base-url|->")?;
            let base_url = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth request-spec <device-code|device-token|authorization-code|codex-device-code|codex-device-token> <base-url|->")?;
            let spec = build_openai_auth_request_spec(spec_type, (base_url != "-").then_some(base_url))?;
            println!("url={}", escape_field(&spec.url));
            println!("contentType={}", escape_field(&spec.content_type));
            Ok(0)
        }
        Some("request-body") => {
            let body_type = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust auth request-body <device-code|device-token|authorization-code|codex-device-code|codex-device-token> [args...]")?;
            let body = match body_type {
                "device-code" => {
                    let client_id = args
                        .get(2)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body device-code <client-id> <scopes...>")?;
                    let scopes = args[3..]
                        .iter()
                        .filter_map(|arg| arg.to_str())
                        .map(ToString::to_string)
                        .collect::<Vec<_>>();
                    if scopes.is_empty() {
                        return Err("Usage: unclecode rust auth request-body device-code <client-id> <scopes...>".to_string());
                    }
                    build_openai_device_authorization_body(client_id, &scopes)
                }
                "device-token" => {
                    let client_id = args
                        .get(2)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body device-token <client-id> <device-code>")?;
                    let device_code = args
                        .get(3)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body device-token <client-id> <device-code>")?;
                    build_openai_device_token_body(client_id, device_code)
                }
                "authorization-code" => {
                    let client_id = args
                        .get(2)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body authorization-code <client-id> <code> <code-verifier> <redirect-uri>")?;
                    let code = args
                        .get(3)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body authorization-code <client-id> <code> <code-verifier> <redirect-uri>")?;
                    let code_verifier = args
                        .get(4)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body authorization-code <client-id> <code> <code-verifier> <redirect-uri>")?;
                    let redirect_uri = args
                        .get(5)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body authorization-code <client-id> <code> <code-verifier> <redirect-uri>")?;
                    build_openai_authorization_code_token_body(
                        client_id,
                        code,
                        code_verifier,
                        redirect_uri,
                    )
                }
                "codex-device-code" => {
                    let client_id = args
                        .get(2)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body codex-device-code <client-id>")?;
                    build_openai_codex_device_authorization_body(client_id)
                }
                "codex-device-token" => {
                    let device_auth_id = args
                        .get(2)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body codex-device-token <device-auth-id> <user-code>")?;
                    let user_code = args
                        .get(3)
                        .and_then(|arg| arg.to_str())
                        .ok_or("Usage: unclecode rust auth request-body codex-device-token <device-auth-id> <user-code>")?;
                    build_openai_codex_device_token_body(device_auth_id, user_code)
                }
                _ => return Err("Usage: unclecode rust auth request-body <device-code|device-token|authorization-code|codex-device-code|codex-device-token> [args...]".to_string()),
            };
            println!("{body}");
            Ok(0)
        }
        Some("parse-token-response") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parsed = parse_openai_oauth_token_response(&raw);
            println!(
                "accessToken={}",
                parsed.access_token.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "refreshToken={}",
                parsed.refresh_token.unwrap_or_else(|| "none".to_string())
            );
            println!("error={}", parsed.error.unwrap_or_else(|| "none".to_string()));
            Ok(0)
        }
        Some("parse-device-response") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parsed = parse_openai_device_authorization_response(&raw);
            println!(
                "deviceCode={}",
                parsed.device_code.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "userCode={}",
                parsed.user_code.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "verificationUri={}",
                parsed.verification_uri.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "expiresIn={}",
                parsed
                    .expires_in
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            );
            println!(
                "interval={}",
                parsed
                    .interval
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            );
            println!("error={}", parsed.error.unwrap_or_else(|| "none".to_string()));
            Ok(0)
        }
        Some("parse-codex-device-response") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parsed = parse_openai_codex_device_authorization_response(&raw);
            println!(
                "deviceAuthId={}",
                parsed
                    .device_auth_id
                    .unwrap_or_else(|| "none".to_string())
            );
            println!(
                "userCode={}",
                parsed.user_code.unwrap_or_else(|| "none".to_string())
            );
            println!(
                "interval={}",
                parsed
                    .interval
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            );
            println!("error={}", parsed.error.unwrap_or_else(|| "none".to_string()));
            Ok(0)
        }
        Some("parse-codex-token-response") => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let parsed = parse_openai_codex_device_token_response(&raw);
            println!(
                "authorizationCode={}",
                parsed
                    .authorization_code
                    .unwrap_or_else(|| "none".to_string())
            );
            println!(
                "codeVerifier={}",
                parsed.code_verifier.unwrap_or_else(|| "none".to_string())
            );
            println!("error={}", parsed.error.unwrap_or_else(|| "none".to_string()));
            Ok(0)
        }
        Some("read-credentials") => {
            let path = openai_credentials_path(|key| env::var(key).ok());
            match read_openai_credentials_file(path)
                .map_err(|error| format!("Failed to read OpenAI credentials: {error}"))?
            {
                Some(StoredOpenAICredential::ApiKey {
                    api_key,
                    organization_id,
                    project_id,
                }) => {
                    println!("status=ok");
                    println!("authType=api-key");
                    println!("apiKey={api_key}");
                    println!(
                        "organizationId={}",
                        organization_id.unwrap_or_else(|| "none".to_string())
                    );
                    println!(
                        "projectId={}",
                        project_id.unwrap_or_else(|| "none".to_string())
                    );
                }
                Some(StoredOpenAICredential::OAuth {
                    access_token,
                    refresh_token,
                    expires_at,
                    organization_id,
                    project_id,
                    account_id,
                    runtime,
                }) => {
                    println!("status=ok");
                    println!("authType=oauth");
                    println!("accessToken={access_token}");
                    println!("refreshToken={refresh_token}");
                    println!(
                        "expiresAt={}",
                        expires_at
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "none".to_string())
                    );
                    println!(
                        "organizationId={}",
                        organization_id.unwrap_or_else(|| "none".to_string())
                    );
                    println!(
                        "projectId={}",
                        project_id.unwrap_or_else(|| "none".to_string())
                    );
                    println!(
                        "accountId={}",
                        account_id.unwrap_or_else(|| "none".to_string())
                    );
                    println!("runtime={}", runtime.unwrap_or_else(|| "none".to_string()));
                }
                None => {
                    println!("status=missing");
                    println!("authType=none");
                }
            }
            Ok(0)
        }
        Some("write-raw") => {
            let mut contents = String::new();
            io::stdin()
                .read_to_string(&mut contents)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let path = openai_credentials_path(|key| env::var(key).ok());
            write_openai_raw_credentials(path, &contents)
                .map_err(|error| format!("Failed to save OpenAI credentials: {error}"))?;
            println!("saved=raw-file");
            Ok(0)
        }
        Some("save-api-key") => {
            let organization_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-")
                .map(str::to_string);
            let project_id = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-")
                .map(str::to_string);
            let mut api_key = String::new();
            io::stdin()
                .read_to_string(&mut api_key)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let api_key = api_key.trim().to_string();
            if api_key.is_empty() {
                return Err("API key must not be empty.".to_string());
            }
            let path = openai_credentials_path(|key| env::var(key).ok());
            write_openai_api_key_credentials(
                path,
                &StoredApiKeyCredential {
                    api_key,
                    organization_id,
                    project_id,
                },
            )
            .map_err(|error| format!("Failed to save OpenAI credentials: {error}"))?;
            println!("saved=api-key-file");
            Ok(0)
        }
        Some("save-oauth") => {
            let runtime = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value == "api" || *value == "codex")
                .map(str::to_string)
                .ok_or("Usage: unclecode rust auth save-oauth <api|codex> [org|-] [project|-] [account|-]")?;
            let organization_id = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-")
                .map(str::to_string);
            let project_id = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-")
                .map(str::to_string);
            let account_id = args
                .get(4)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-")
                .map(str::to_string);
            let mut tokens = String::new();
            io::stdin()
                .read_to_string(&mut tokens)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let mut lines = tokens.lines();
            let access_token = lines.next().unwrap_or_default().trim().to_string();
            let refresh_token = lines.next().unwrap_or_default().trim().to_string();
            if access_token.is_empty() || refresh_token.is_empty() {
                return Err("OAuth access and refresh tokens must not be empty.".to_string());
            }
            let path = openai_credentials_path(|key| env::var(key).ok());
            write_openai_oauth_credentials(
                path,
                &StoredOAuthCredential {
                    access_token,
                    refresh_token,
                    organization_id,
                    project_id,
                    account_id,
                    runtime: Some(runtime),
                },
            )
            .map_err(|error| format!("Failed to save OpenAI OAuth credentials: {error}"))?;
            println!("saved=oauth-file");
            Ok(0)
        }
        Some("logout") => {
            let path = openai_credentials_path(|key| env::var(key).ok());
            clear_openai_credentials(path)
                .map_err(|error| format!("Failed to clear OpenAI credentials: {error}"))?;
            println!("cleared=yes");
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust auth <status|resolve|inspect-oauth-token|authorization-url|parse-callback|request-spec|request-body|parse-token-response|parse-device-response|parse-codex-device-response|parse-codex-token-response|read-credentials|write-raw|save-api-key [org|-] [project|-]|save-oauth <api|codex> [org|-] [project|-] [account|-]|logout>"
                .to_string(),
        ),
    }
}

fn run_native_session_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("scan-notices") => {
            let root_dir = args
                .get(1)
                .map(PathBuf::from)
                .ok_or("Usage: unclecode rust session scan-notices <root-dir>")?;
            println!("{}", scan_session_persistence_notices_json(&root_dir)?);
            Ok(0)
        }
        Some("paths") => {
            let root_dir = args
                .get(1)
                .map(PathBuf::from)
                .ok_or("Usage: unclecode rust session paths <root-dir> <project-path> <session-id>")?;
            let project_path = args
                .get(2)
                .map(PathBuf::from)
                .ok_or("Usage: unclecode rust session paths <root-dir> <project-path> <session-id>")?;
            let session_id = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust session paths <root-dir> <project-path> <session-id>")?;
            let paths = session_paths(&root_dir, &project_path, session_id);
            println!(
                "{{\"projectDir\":\"{}\",\"sessionDir\":\"{}\",\"eventLogPath\":\"{}\",\"checkpointPath\":\"{}\",\"projectMemoryDir\":\"{}\",\"projectMemoryDbPath\":\"{}\",\"researchArtifactsDir\":\"{}\"}}",
                escape_json(&paths.project_dir.to_string_lossy()),
                escape_json(&paths.session_dir.to_string_lossy()),
                escape_json(&paths.event_log_path.to_string_lossy()),
                escape_json(&paths.checkpoint_path.to_string_lossy()),
                escape_json(&paths.project_memory_dir.to_string_lossy()),
                escape_json(&paths.project_memory_db_path.to_string_lossy()),
                escape_json(&paths.research_artifacts_dir.to_string_lossy()),
            );
            Ok(0)
        }
        Some("persist") => {
            let cwd = work_cwd()?;
            let session_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust session persist <session-id> <model> <mode> <state> <trace-mode|-> <reasoning-effort|->")?;
            let model = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust session persist <session-id> <model> <mode> <state> <trace-mode|-> <reasoning-effort|->")?;
            let mode = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust session persist <session-id> <model> <mode> <state> <trace-mode|-> <reasoning-effort|->")?;
            let state = args
                .get(4)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust session persist <session-id> <model> <mode> <state> <trace-mode|-> <reasoning-effort|->")?;
            let trace_mode = args
                .get(5)
                .and_then(|arg| arg.to_str())
                .filter(|value| *value != "-")
                .map(str::to_string);
            let reasoning_effort = args
                .get(6)
                .and_then(|arg| arg.to_str())
                .filter(|value| matches!(*value, "low" | "medium" | "high"))
                .map(str::to_string);
            let mut summary = String::new();
            io::stdin()
                .read_to_string(&mut summary)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let store = WorkShellSessionStore::new(session_store_root());
            store
                .persist_work_shell_snapshot(&WorkShellSessionSnapshot {
                    session_id: session_id.to_string(),
                    project_path: cwd.to_string_lossy().to_string(),
                    model: model.to_string(),
                    mode: mode.to_string(),
                    state: state.to_string(),
                    summary,
                    trace_mode,
                    reasoning_effort,
                    ui_locale: None,
                    last_submitted_context_receipt_id: None,
                    owner_mutation_revision: None,
                    entries: vec![],
                    agent_console: None,
                    pause_checkpoint: None,
                })
                .map_err(|error| format!("Failed to persist session snapshot: {error}"))?;
            println!("Persisted {session_id}");
            Ok(0)
        }
        Some("persist-json") => {
            let cwd = work_cwd()?;
            let mut payload = String::new();
            io::stdin()
                .read_to_string(&mut payload)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let store = WorkShellSessionStore::new(session_store_root());
            let session_id = persist_work_shell_session_snapshot_json(&store, &cwd, &payload)?;
            println!("Persisted {session_id}");
            Ok(0)
        }
        Some("list") => {
            let cwd = work_cwd()?;
            let store = WorkShellSessionStore::new(session_store_root());
            let lines = store
                .list_session_lines(&cwd)
                .map_err(|error| format!("Failed to list sessions: {error}"))?;
            if lines.is_empty() {
                println!("No resumable sessions.");
                println!("Run work, doctor, or research to create one.");
            } else {
                for (index, session) in lines.iter().enumerate() {
                    println!(
                        "{}. {} · {} · {}",
                        index + 1,
                        session.session_id,
                        session.state,
                        session.summary
                    );
                }
            }
            Ok(0)
        }
        Some("resume") => {
            let cwd = work_cwd()?;
            let session_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust session resume <session-id>")?;
            let store = WorkShellSessionStore::new(session_store_root());
            let Some(resumed) = store
                .resume_work_shell_session(&cwd, session_id)
                .map_err(|error| format!("Failed to resume session: {error}"))?
            else {
                return Err(format!("Session not found: {session_id}"));
            };
            println!("sessionId={}", resumed.session_id);
            if let Some(trace_mode) = resumed.trace_mode {
                println!("traceMode={trace_mode}");
            }
            if let Some(reasoning_effort) = resumed.reasoning_effort {
                println!("reasoningEffort={reasoning_effort}");
            }
            println!("contextLine=Resumed session: {session_id}");
            Ok(0)
        }
        Some("resume-json") => {
            let cwd = work_cwd()?;
            let session_id = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust session resume-json <session-id>")?;
            let store = WorkShellSessionStore::new(session_store_root());
            let Some(json) = resume_work_shell_session_json(&store, &cwd, session_id)?
            else {
                return Err(format!("Session not found: {session_id}"));
            };
            println!("{json}");
            Ok(0)
        }
        _ => Err("Usage: unclecode rust session <scan-notices <root-dir>|persist <session-id> <model> <mode> <state> <trace-mode|-> <reasoning-effort|->|persist-json|list|resume <session-id>|resume-json <session-id>|paths <root-dir> <project-path> <session-id>>".to_string()),
    }
}

fn parse_native_queue_envelope(
    input: &str,
) -> Result<(String, u64, Vec<QueueAttachmentArtifact>), String> {
    let value: serde_json::Value =
        serde_json::from_str(input).map_err(|error| format!("Invalid queue envelope: {error}"))?;
    let line = value
        .get("line")
        .and_then(serde_json::Value::as_str)
        .ok_or("Queue envelope line must be a string.")?;
    let created_at = value
        .get("createdAt")
        .and_then(serde_json::Value::as_u64)
        .ok_or("Queue envelope createdAt must be an unsigned integer.")?;
    let attachments = value
        .get("attachments")
        .and_then(serde_json::Value::as_array)
        .ok_or("Queue envelope attachments must be an array.")?
        .iter()
        .map(|artifact| {
            let reference = artifact
                .get("ref")
                .and_then(serde_json::Value::as_str)
                .filter(|candidate| !candidate.trim().is_empty())
                .ok_or("Queue attachment ref must be a non-empty string.")?;
            let schema = artifact
                .get("schema")
                .and_then(serde_json::Value::as_str)
                .filter(|candidate| !candidate.trim().is_empty())
                .ok_or("Queue attachment schema must be a non-empty string.")?;
            let sha256 = artifact
                .get("sha256")
                .and_then(serde_json::Value::as_str)
                .filter(|candidate| candidate.len() == 64)
                .ok_or("Queue attachment sha256 must be a 64-character string.")?;
            let size = artifact
                .get("size")
                .and_then(serde_json::Value::as_u64)
                .ok_or("Queue attachment size must be an unsigned integer.")?;
            Ok::<QueueAttachmentArtifact, &'static str>(QueueAttachmentArtifact {
                reference: reference.to_string(),
                schema: schema.to_string(),
                sha256: sha256.to_string(),
                size,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((line.to_string(), created_at, attachments))
}

fn run_native_queue_command(args: &[OsString]) -> Result<u8, String> {
    let cwd = work_cwd()?;
    let session_id = args
        .get(1)
        .and_then(|arg| arg.to_str())
        .ok_or("Usage: unclecode rust queue <push|pop|list|len|clear> <session-id> [line]")?;
    let queue = PersistentWorkQueue::new(queue_path(&cwd, session_id));
    match args.first().and_then(|arg| arg.to_str()) {
        Some("validate-envelope-json") | Some("push-envelope-json") => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read queue envelope: {error}"))?;
            let (line, created_at, attachments) = parse_native_queue_envelope(&input)?;
            let result = if args.first().and_then(|arg| arg.to_str())
                == Some("validate-envelope-json")
            {
                queue
                    .preflight_push_with_artifacts(line, created_at, attachments)
                    .map(|()| None)
            } else {
                queue.push_with_artifacts(line, created_at, attachments)
            };
            match result {
                Ok(Some(item)) => println!("{}", queue_item_json(Some(&item))),
                Ok(None) => println!("{}", queue_limit_acceptance_json()),
                Err(QueuePushError::Rejected(error)) => {
                    println!("{}", queue_limit_rejection_json(&error));
                }
                Err(QueuePushError::Io(error)) => {
                    return Err(format!("Failed to access queue: {error}"));
                }
            }
            Ok(0)
        }
        Some("push") | Some("push-json") => {
            let line = args[2..]
                .iter()
                .map(|arg| arg.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            match queue.push(line) {
                Ok(Some(item)) => {
                    if args.first().and_then(|arg| arg.to_str()) == Some("push-json") {
                        println!("{}", queue_item_json(Some(&item)));
                    } else {
                        println!("{} {}", item.id, item.line);
                    }
                }
                Ok(None) => return Err("Queue line must not be empty.".to_string()),
                Err(QueuePushError::Rejected(error))
                    if args.first().and_then(|arg| arg.to_str()) == Some("push-json") =>
                {
                    println!("{}", queue_limit_rejection_json(&error));
                }
                Err(error) => return Err(format!("Failed to push queue item: {error}")),
            }
            Ok(0)
        }
        Some("pop") | Some("pop-json") => {
            let item = queue
                .pop()
                .map_err(|error| format!("Failed to pop queue item: {error}"))?;
            if args.first().and_then(|arg| arg.to_str()) == Some("pop-json") {
                println!("{}", queue_item_json(item.as_ref()));
            } else if let Some(item) = item {
                println!("{} {}", item.id, item.line);
            }
            Ok(0)
        }
        Some("claim-json") => {
            let item = queue
                .claim()
                .map_err(|error| format!("Failed to claim queue item: {error}"))?;
            println!("{}", queue_item_json(item.as_ref()));
            Ok(0)
        }
        Some("ack-json") | Some("nack-json") => {
            let id = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or("Usage: unclecode rust queue <ack-json|nack-json> <session-id> <id>")?;
            let item = if args.first().and_then(|arg| arg.to_str()) == Some("ack-json") {
                queue.ack(id)
            } else {
                queue.nack(id)
            }
            .map_err(|error| format!("Failed to settle queue item: {error}"))?;
            println!("{}", queue_item_json(item.as_ref()));
            Ok(0)
        }
        Some("quarantine-json") => {
            let id = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or("Usage: unclecode rust queue quarantine-json <session-id> <id>")?;
            let mut reason = String::new();
            io::stdin()
                .read_to_string(&mut reason)
                .map_err(|error| format!("Failed to read quarantine reason: {error}"))?;
            let item = queue
                .quarantine(id, reason)
                .map_err(|error| format!("Failed to quarantine queue item: {error}"))?;
            println!("{}", queue_item_json(item.as_ref()));
            Ok(0)
        }
        Some("recover-json") => {
            let items = queue
                .recover_stale_in_flight()
                .map_err(|error| format!("Failed to recover stale queue claims: {error}"))?;
            println!("{}", queue_items_json(&items));
            Ok(0)
        }
        Some("retry-json") | Some("discard-json") => {
            let id = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or("Usage: unclecode rust queue <retry-json|discard-json> <session-id> <id>")?;
            let item = if args.first().and_then(|arg| arg.to_str()) == Some("retry-json") {
                queue.retry(id)
            } else {
                queue.discard(id)
            }
            .map_err(|error| format!("Failed to recover queue item: {error}"))?;
            println!("{}", queue_item_json(item.as_ref()));
            Ok(0)
        }
        Some("remove-json") => {
            let id = args.get(2).and_then(|arg| arg.to_str()).and_then(|value| value.parse::<u64>().ok())
                .ok_or("Usage: unclecode rust queue remove-json <session-id> <id>")?;
            let item = queue.remove(id).map_err(|error| format!("Failed to remove queue item: {error}"))?;
            println!("{}", queue_item_json(item.as_ref()));
            Ok(0)
        }
        Some("move-json") => {
            let id = args.get(2).and_then(|arg| arg.to_str()).and_then(|value| value.parse::<u64>().ok())
                .ok_or("Usage: unclecode rust queue move-json <session-id> <id> <up|down>")?;
            let direction = match args.get(3).and_then(|arg| arg.to_str()) {
                Some("up") => QueueMoveDirection::Up,
                Some("down") => QueueMoveDirection::Down,
                _ => return Err("Usage: unclecode rust queue move-json <session-id> <id> <up|down>".to_string()),
            };
            let item = queue.move_item(id, direction).map_err(|error| format!("Failed to move queue item: {error}"))?;
            println!("{}", queue_item_json(item.as_ref()));
            Ok(0)
        }
        Some("list") => {
            let items = queue
                .snapshot()
                .map_err(|error| format!("Failed to list queue items: {error}"))?;
            println!("{}", queue_items_json(&items));
            Ok(0)
        }
        Some("len") | Some("len-json") => {
            let length = queue
                .len()
                .map_err(|error| format!("Failed to read queue length: {error}"))?;
            if args.first().and_then(|arg| arg.to_str()) == Some("len-json") {
                println!("{}", queue_length_json(length));
            } else {
                println!("{length}");
            }
            Ok(0)
        }
        Some("clear") => {
            queue
                .clear()
                .map_err(|error| format!("Failed to clear queue: {error}"))?;
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust queue <validate-envelope-json|push|push-json|push-envelope-json|pop|pop-json|claim-json|ack-json|nack-json|quarantine-json|recover-json|retry-json|discard-json|remove-json|move-json|list|len|len-json|clear> <session-id> [args]".to_string(),
        ),
    }
}

fn run_native_aci_command(args: &[OsString]) -> Result<u8, String> {
    let cwd = work_cwd()?;
    match args.first().and_then(|arg| arg.to_str()) {
        Some("list") => {
            let path = args.get(1).cloned().unwrap_or_else(|| OsString::from("."));
            let entries =
                list_files(&cwd, PathBuf::from(path)).map_err(|error| error.to_string())?;
            if entries.is_empty() {
                println!("(empty directory)");
            } else {
                for entry in entries {
                    println!("{} {}", entry.kind, entry.name);
                }
            }
            Ok(0)
        }
        Some("read") => {
            let path = args.get(1).ok_or("Usage: unclecode rust aci read <path>")?;
            let content =
                read_text_file(&cwd, PathBuf::from(path)).map_err(|error| error.to_string())?;
            print!("{content}");
            Ok(0)
        }
        Some("read-no-symlinks") => {
            let path = args
                .get(1)
                .ok_or("Usage: unclecode rust aci read-no-symlinks <path>")?;
            let content = read_text_file_no_symlinks(&cwd, PathBuf::from(path))
                .map_err(|error| error.to_string())?;
            print!("{content}");
            Ok(0)
        }
        Some("view") => {
            let path = args.get(1).ok_or("Usage: unclecode rust aci view <path> [window]")?;
            let window = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(100);
            let view = view_text_file(&cwd, PathBuf::from(path), window)
                .map_err(|error| error.to_string())?;
            println!("{}", view.content);
            Ok(0)
        }
        Some("view-json") => {
            let path = args
                .get(1)
                .ok_or("Usage: unclecode rust aci view-json <path> [window] [start]")?;
            let window = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(100);
            let start = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(1);
            println!(
                "{}",
                view_text_file_json(&cwd, PathBuf::from(path), window, start)
                    .map_err(|error| error.to_string())?
            );
            Ok(0)
        }
        Some("write") => {
            let path = args.get(1).ok_or("Usage: unclecode rust aci write <path>")?;
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            write_text_file(&cwd, PathBuf::from(path), &content).map_err(|error| error.to_string())?;
            println!("Wrote {}", path.to_string_lossy());
            Ok(0)
        }
        Some("write-atomic-no-symlinks") => {
            let path = args
                .get(1)
                .ok_or("Usage: unclecode rust aci write-atomic-no-symlinks <path>")?;
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            write_text_file_atomically_no_symlinks(&cwd, PathBuf::from(path), &content)
                .map_err(|error| error.to_string())?;
            println!("Wrote {}", path.to_string_lossy());
            Ok(0)
        }
        Some("delete") => {
            let path = args.get(1).ok_or("Usage: unclecode rust aci delete <path>")?;
            delete_text_file(&cwd, PathBuf::from(path)).map_err(|error| error.to_string())?;
            println!("Deleted {}", path.to_string_lossy());
            Ok(0)
        }
        Some("delete-no-symlinks") => {
            let path = args
                .get(1)
                .ok_or("Usage: unclecode rust aci delete-no-symlinks <path>")?;
            delete_text_file_no_symlinks(&cwd, PathBuf::from(path))
                .map_err(|error| error.to_string())?;
            println!("Deleted {}", path.to_string_lossy());
            Ok(0)
        }
        Some("edit-json") => {
            let path = args
                .get(1)
                .ok_or("Usage: unclecode rust aci edit-json <path> <start-line> <end-line>")?;
            let start_line = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Usage: unclecode rust aci edit-json <path> <start-line> <end-line>")?;
            let end_line = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Usage: unclecode rust aci edit-json <path> <start-line> <end-line>")?;
            let mut replacement = String::new();
            io::stdin()
                .read_to_string(&mut replacement)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                line_edit_json(&cwd, PathBuf::from(path), start_line, end_line, &replacement)
                    .map_err(|error| error.to_string())?
            );
            Ok(0)
        }
        Some("restore") => {
            let path = args.get(1).ok_or("Usage: unclecode rust aci restore <path>")?;
            let mut content = String::new();
            io::stdin()
                .read_to_string(&mut content)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            restore_file(&cwd, PathBuf::from(path), &content)
                .map_err(|error| error.to_string())?;
            println!("Restored {}", path.to_string_lossy());
            Ok(0)
        }
        Some("lint-failure-message") => {
            let start_line = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Usage: unclecode rust aci lint-failure-message <start-line> <snippet-context>")?;
            let snippet_context = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Usage: unclecode rust aci lint-failure-message <start-line> <snippet-context>")?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            let mut parts = input.splitn(4, '\0');
            let original = parts.next().unwrap_or_default();
            let proposed = parts.next().unwrap_or_default();
            let replacement = parts.next().unwrap_or_default();
            let findings = parts.next().unwrap_or_default();
            print!(
                "{}",
                lint_failure_message(
                    original,
                    proposed,
                    start_line,
                    replacement,
                    snippet_context,
                    findings,
                )
            );
            Ok(0)
        }
        Some("search") => {
            let query = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust aci search <query> [path]")?;
            let path = args.get(2).cloned().unwrap_or_else(|| OsString::from("."));
            let result = search_text(&cwd, query, PathBuf::from(path), 50)
                .map_err(|error| error.to_string())?;
            if result.hits.is_empty() {
                println!("(no matches)");
            } else {
                for hit in result.hits {
                    match (hit.line, hit.text) {
                        (Some(line), Some(text)) => println!("{}:{line}:{text}", hit.path),
                        _ => println!("{}", hit.path),
                    }
                }
            }
            if result.truncated {
                println!("... {} total hits; refine query", result.total_hits);
            }
            Ok(0)
        }
        Some("search-json") => {
            let query = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust aci search-json <query> [path] [cap] [max-count-per-file] [glob...]")?;
            let path = args.get(2).cloned().unwrap_or_else(|| OsString::from("."));
            let cap = args
                .get(3)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(50);
            let max_count_per_file = args
                .get(4)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or_else(|| cap.max(1));
            let globs = args
                .iter()
                .skip(5)
                .filter_map(|arg| arg.to_str().map(ToString::to_string))
                .collect::<Vec<_>>();
            println!(
                "{}",
                search_text_json(
                    &cwd,
                    query,
                    PathBuf::from(path),
                    cap,
                    max_count_per_file,
                    &globs,
                )
                .map_err(|error| error.to_string())?
            );
            Ok(0)
        }
        Some("find-json") => {
            let pattern = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust aci find-json <pattern> [cap] [glob...]")?;
            let cap = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(50);
            let globs = args
                .iter()
                .skip(3)
                .filter_map(|arg| arg.to_str().map(ToString::to_string))
                .collect::<Vec<_>>();
            println!(
                "{}",
                find_files_json(&cwd, pattern, cap, &globs).map_err(|error| error.to_string())?
            );
            Ok(0)
        }
        Some("glob") => {
            let pattern = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or("Usage: unclecode rust aci glob <pattern>")?;
            let result = glob_files(&cwd, pattern, 50).map_err(|error| error.to_string())?;
            if result.hits.is_empty() {
                println!("(no matches)");
            } else {
                for hit in result.hits {
                    println!("{}", hit.path);
                }
            }
            if result.truncated {
                println!("... {} total hits; tighten pattern", result.total_hits);
            }
            Ok(0)
        }
        Some("apply-patch") => {
            let mut patch = String::new();
            io::stdin()
                .read_to_string(&mut patch)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!(
                "{}",
                apply_unified_patch_json(&cwd, &patch).map_err(|error| error.to_string())?
            );
            Ok(0)
        }
        Some("parse-patch") => {
            let mut patch = String::new();
            io::stdin()
                .read_to_string(&mut patch)
                .map_err(|error| format!("Failed to read stdin: {error}"))?;
            println!("{}", parse_unified_diff_json(&patch));
            Ok(0)
        }
        _ => Err(
            "Usage: unclecode rust aci <list [path]|read <path>|read-no-symlinks <path>|view <path> [window]|view-json <path> [window] [start]|write <path>|write-atomic-no-symlinks <path>|edit-json <path> <start-line> <end-line>|restore <path>|lint-failure-message <start-line> <snippet-context>|search <query> [path]|search-json <query> [path] [cap] [max-count-per-file] [glob...]|find-json <pattern> [cap] [glob...]|glob <pattern>|apply-patch|parse-patch>".to_string(),
        ),
    }
}

fn session_store_root() -> PathBuf {
    if let Some(root) = env::var_os("UNCLECODE_SESSION_STORE_ROOT") {
        let root = PathBuf::from(root);
        if !root.as_os_str().is_empty() {
            return root;
        }
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".unclecode")
        .join("state")
}

fn node_binary() -> OsString {
    env::var_os("UNCLECODE_NODE").unwrap_or_else(|| OsString::from("node"))
}

fn queue_path(workspace_root: &Path, session_id: &str) -> PathBuf {
    workspace_root
        .join(".unclecode")
        .join("work-queues")
        .join(format!("{}.queue", sanitize_session_id(session_id)))
}

fn work_cwd() -> Result<PathBuf, String> {
    if let Some(cwd) = env::var_os("UNCLECODE_WORK_CWD") {
        let cwd = PathBuf::from(cwd);
        if !cwd.as_os_str().is_empty() {
            return Ok(cwd);
        }
    }
    env::current_dir().map_err(|error| format!("Failed to read current directory: {error}"))
}

fn sanitize_session_id(session_id: &str) -> String {
    let sanitized = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}

fn escape_json(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            ch if ch.is_control() => escaped.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => escaped.push(ch),
        }
    }
    escaped
}

fn find_repo_root() -> Result<PathBuf, String> {
    if let Some(root) = env::var_os("UNCLECODE_REPO_ROOT").map(PathBuf::from) {
        if is_repo_root(&root) {
            return Ok(root);
        }
        return Err(format!(
            "UNCLECODE_REPO_ROOT does not look like this workspace: {}",
            root.display()
        ));
    }

    let cwd =
        env::current_dir().map_err(|error| format!("Failed to read current directory: {error}"))?;
    if let Some(root) = find_repo_root_from(&cwd) {
        return Ok(root);
    }

    if let Ok(exe) = env::current_exe() {
        for ancestor in exe.ancestors() {
            if let Some(root) = find_repo_root_from(ancestor) {
                return Ok(root);
            }
        }
    }

    Err("Could not find UncleCode workspace root. Set UNCLECODE_REPO_ROOT.".to_string())
}

fn find_repo_root_from(start: &Path) -> Option<PathBuf> {
    for candidate in start.ancestors() {
        if is_repo_root(candidate) {
            return Some(candidate.to_path_buf());
        }
    }
    None
}

fn is_repo_root(path: &Path) -> bool {
    path.join("package.json").is_file()
        && path.join("apps/unclecode-cli").is_dir()
        && path.join("packages/orchestrator").is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::ffi::OsString;
    use std::sync::{Mutex, MutexGuard};

    static QUEUE_TEST_WORK_CWD_LOCK: Mutex<()> = Mutex::new(());

    struct QueueTestWorkCwd {
        root: PathBuf,
        previous: Option<OsString>,
        _lock: MutexGuard<'static, ()>,
    }

    impl QueueTestWorkCwd {
        fn new(session_id: &str) -> Self {
            let lock = QUEUE_TEST_WORK_CWD_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let root = env::temp_dir().join(format!(
                "unclecode-queue-cli-test-{}-{session_id}",
                std::process::id()
            ));
            assert!(!root.exists(), "queue test root must be unique");
            std::fs::create_dir(&root).expect("create queue test work cwd");
            let previous = env::var_os("UNCLECODE_WORK_CWD");
            // SAFETY: queue CLI tests serialize mutations of this process-global
            // variable with QUEUE_TEST_WORK_CWD_LOCK and restore it in Drop.
            unsafe { env::set_var("UNCLECODE_WORK_CWD", &root) };
            Self {
                root,
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for QueueTestWorkCwd {
        fn drop(&mut self) {
            // SAFETY: the matching process-global mutation is serialized by the
            // guard held until this Drop implementation completes.
            unsafe {
                match self.previous.take() {
                    Some(previous) => env::set_var("UNCLECODE_WORK_CWD", previous),
                    None => env::remove_var("UNCLECODE_WORK_CWD"),
                }
            }
            if let Err(error) = std::fs::remove_dir_all(&self.root) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    panic!("failed to clean queue test work cwd: {error}");
                }
            }
        }
    }

    #[test]
    fn detects_workspace_root_shape() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest_dir
            .parent()
            .and_then(Path::parent)
            .expect("workspace root");

        assert!(is_repo_root(root));
        assert_eq!(
            find_repo_root_from(&root.join("rust/unclecode/src")),
            Some(root.to_path_buf())
        );
    }

    #[test]
    fn rust_version_flag_does_not_need_node_bridge() {
        assert_eq!(run(vec![OsString::from("--rust-version")]), Ok(0));
    }

    #[test]
    fn version_and_help_flags_do_not_need_node_bridge() {
        assert_eq!(run(vec![OsString::from("--version")]), Ok(0));
        assert_eq!(run(vec![OsString::from("--help")]), Ok(0));
    }

    #[test]
    fn full_screen_tui_launches_only_for_interactive_tty_without_help_flags() {
        assert!(should_launch_full_tui(&[], true, true));
        assert!(should_launch_full_tui(&[OsString::from("tui")], true, true));
        assert!(!should_launch_full_tui(
            &[OsString::from("tui")],
            false,
            true
        ));
        assert!(!should_launch_full_tui(
            &[OsString::from("tui")],
            true,
            false
        ));
        assert!(!should_launch_full_tui(
            &[OsString::from("tui"), OsString::from("--help")],
            true,
            true
        ));
        assert!(!should_launch_full_tui(
            &[OsString::from("work")],
            true,
            true
        ));
    }

    #[test]
    fn public_work_routes_prompts_to_the_typescript_owner_and_keeps_tty_ink() {
        assert_eq!(
            select_public_work_route(&[], true, true),
            PublicWorkRoute::TypescriptTui
        );
        assert_eq!(
            select_public_work_route(
                &[OsString::from("--engine"), OsString::from("pi")],
                true,
                true
            ),
            PublicWorkRoute::TypescriptTui
        );

        for (stdin_is_tty, stdout_is_tty) in
            [(true, true), (false, true), (true, false), (false, false)]
        {
            assert_eq!(
                select_public_work_route(
                    &[OsString::from("summarize the repo")],
                    stdin_is_tty,
                    stdout_is_tty,
                ),
                PublicWorkRoute::TypescriptOwner,
                "positional prompts must never enter the Rust mini-loop"
            );
        }

        assert_eq!(
            select_public_work_route(&[], false, true),
            PublicWorkRoute::TypescriptOwner,
            "piped stdin is a non-interactive owner prompt"
        );
        assert_eq!(
            select_public_work_route(&[], true, false),
            PublicWorkRoute::RustNative,
            "a promptless TTY with redirected output preserves the native fallback"
        );
        assert_eq!(
            select_public_work_route(&[OsString::from("--help")], false, false),
            PublicWorkRoute::RustNative
        );
        assert_eq!(
            select_public_work_route(&[OsString::from("--tools")], true, true),
            PublicWorkRoute::RustNative
        );
    }

    #[test]
    fn full_screen_tui_node_options_suppress_experimental_warnings() {
        assert_eq!(
            node_options_with_experimental_warning_suppressed(None),
            OsString::from(NODE_NO_EXPERIMENTAL_WARNING)
        );
        assert_eq!(
            node_options_with_experimental_warning_suppressed(Some(OsString::from(
                "--max-old-space-size=4096"
            ))),
            OsString::from("--max-old-space-size=4096 --no-warnings=ExperimentalWarning")
        );
        assert_eq!(
            node_options_with_experimental_warning_suppressed(Some(OsString::from(
                "--no-warnings"
            ))),
            OsString::from("--no-warnings")
        );
        assert_eq!(
            node_options_with_experimental_warning_suppressed(Some(OsString::from(
                NODE_NO_EXPERIMENTAL_WARNING
            ))),
            OsString::from(NODE_NO_EXPERIMENTAL_WARNING)
        );
    }

    #[test]
    fn better_sqlite3_native_version_mismatch_detection_is_specific() {
        assert!(is_better_sqlite3_native_version_mismatch(
            "The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n\
             was compiled against a different Node.js version using\n\
             NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 127."
        ));
        assert!(is_better_sqlite3_native_version_mismatch(
            "ERR_DLOPEN_FAILED: better_sqlite3.node was compiled against NODE_MODULE_VERSION 137"
        ));
        assert!(!is_better_sqlite3_native_version_mismatch(
            "Cannot find module 'better-sqlite3'"
        ));
        assert!(!is_better_sqlite3_native_version_mismatch(
            "NODE_MODULE_VERSION mismatch in another native module"
        ));
    }

    #[test]
    fn better_sqlite3_probe_exercises_lazy_native_binding() {
        let temp_dir = env::temp_dir().join(format!(
            "unclecode-better-sqlite-probe-{}",
            std::process::id()
        ));
        let module_dir = temp_dir.join("node_modules").join("better-sqlite3");
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&module_dir).expect("fake better-sqlite3 module");
        std::fs::write(
            module_dir.join("index.js"),
            r#"module.exports = class Database {
                constructor() {
                    throw new Error("The module '/fake/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.");
                }
                close() {}
            };"#,
        )
        .expect("fake better-sqlite3 source");

        let result = probe_better_sqlite3(&temp_dir).expect("native module probe");
        let _ = std::fs::remove_dir_all(&temp_dir);

        assert!(!result.success, "probe must instantiate the native binding");
        assert!(is_better_sqlite3_native_version_mismatch(
            &result.combined_output()
        ));
    }

    #[test]
    fn better_sqlite3_native_repair_rebuilds_once_for_abi_mismatch() {
        let probe_calls = Cell::new(0);
        let rebuild_calls = Cell::new(0);

        let outcome = repair_typescript_native_modules_with_runner(
            Path::new("/repo"),
            || {
                probe_calls.set(probe_calls.get() + 1);
                Ok(NativeModuleProbeResult {
                    success: false,
                    stdout: String::new(),
                    stderr: "The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n\
                             was compiled against a different Node.js version using\n\
                             NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 127."
                        .to_string(),
                })
            },
            || {
                rebuild_calls.set(rebuild_calls.get() + 1);
                Ok(NativeModuleRebuildResult {
                    success: true,
                    code: Some(0),
                })
            },
        )
        .expect("repair succeeds");

        assert_eq!(outcome, NativeModuleRepairOutcome::Rebuilt);
        assert_eq!(probe_calls.get(), 1);
        assert_eq!(rebuild_calls.get(), 1);
    }

    #[test]
    fn better_sqlite3_native_repair_ignores_non_abi_require_failures() {
        let rebuild_calls = Cell::new(0);

        let outcome = repair_typescript_native_modules_with_runner(
            Path::new("/repo"),
            || {
                Ok(NativeModuleProbeResult {
                    success: false,
                    stdout: String::new(),
                    stderr: "Cannot find module 'better-sqlite3'".to_string(),
                })
            },
            || {
                rebuild_calls.set(rebuild_calls.get() + 1);
                Ok(NativeModuleRebuildResult {
                    success: true,
                    code: Some(0),
                })
            },
        )
        .expect("unrelated require failure is left to normal launch");

        assert_eq!(outcome, NativeModuleRepairOutcome::IgnoredFailure);
        assert_eq!(rebuild_calls.get(), 0);
    }

    #[test]
    fn npm_binary_for_node_prefers_sibling_npm_from_same_toolchain() {
        let temp_dir = env::temp_dir().join(format!(
            "unclecode-npm-bin-{}-{}",
            std::process::id(),
            npm_executable_name()
        ));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).expect("temp dir");

        let node_path = temp_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        let npm_path = temp_dir.join(npm_executable_name());
        std::fs::write(&node_path, "").expect("node shim");
        std::fs::write(&npm_path, "").expect("npm shim");

        assert_eq!(
            PathBuf::from(npm_binary_for_node(node_path.as_os_str())),
            npm_path
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn full_screen_center_launches_only_for_interactive_tty_default_view() {
        assert!(should_launch_full_center(&[], true, true));
        assert!(!should_launch_full_center(&[], false, true));
        assert!(!should_launch_full_center(&[], true, false));
        assert!(!should_launch_full_center(
            &[OsString::from("--help")],
            true,
            true
        ));
        assert!(!should_launch_full_center(
            &[OsString::from("sessions")],
            true,
            true
        ));
        assert!(!should_launch_full_center(
            &[OsString::from("list")],
            true,
            true
        ));
    }

    #[test]
    fn native_top_level_help_surfaces_do_not_need_node_bridge() {
        for args in [
            vec![OsString::from("config"), OsString::from("--help")],
            vec![OsString::from("center"), OsString::from("--help")],
            vec![OsString::from("mcp"), OsString::from("--help")],
            vec![OsString::from("mode"), OsString::from("--help")],
            vec![OsString::from("harness"), OsString::from("--help")],
            vec![OsString::from("sessions"), OsString::from("--help")],
            vec![OsString::from("setup"), OsString::from("--help")],
            vec![OsString::from("doctor"), OsString::from("--help")],
            vec![OsString::from("work"), OsString::from("--help")],
            vec![OsString::from("tui"), OsString::from("--help")],
        ] {
            assert_eq!(run(args), Ok(0));
        }
    }

    #[test]
    fn unknown_top_level_command_does_not_fall_back_to_node_bridge() {
        let result = run(vec![OsString::from("legacy-only-command")]);

        assert!(
            matches!(result, Err(ref error) if error.contains("Unsupported UncleCode command on the Rust-native CLI"))
        );
    }

    #[test]
    fn native_config_explain_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![OsString::from("config"), OsString::from("--help")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("config"),
                OsString::from("explain"),
                OsString::from("--mode"),
                OsString::from("search")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_doctor_does_not_need_node_bridge() {
        assert_eq!(run(vec![OsString::from("doctor")]), Ok(0));
        assert_eq!(
            run(vec![OsString::from("doctor"), OsString::from("--help")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![OsString::from("doctor"), OsString::from("--verbose")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![OsString::from("doctor"), OsString::from("--json")]),
            Ok(0)
        );
        assert_eq!(run(vec![OsString::from("/doctor")]), Ok(0));
    }

    #[test]
    fn native_auth_routes_only_owned_surfaces() {
        assert_eq!(run(vec![OsString::from("auth")]), Ok(0));
        assert_eq!(
            run(vec![OsString::from("auth"), OsString::from("--help")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("auth"),
                OsString::from("login"),
                OsString::from("--help")
            ]),
            Ok(0)
        );
        assert!(cli_auth::top_level_auth_args(&[
            OsString::from("auth"),
            OsString::from("login"),
            OsString::from("--api-key-stdin")
        ])
        .is_some());
        assert!(cli_auth::top_level_auth_args(&[
            OsString::from("auth"),
            OsString::from("login"),
            OsString::from("--browser")
        ])
        .is_some());
        assert!(cli_auth::top_level_auth_args(&[
            OsString::from("auth"),
            OsString::from("login"),
            OsString::from("--device")
        ])
        .is_some());
    }

    #[test]
    fn native_mcp_list_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![OsString::from("mcp"), OsString::from("--help")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![OsString::from("mcp"), OsString::from("list")]),
            Ok(0)
        );
        assert_eq!(run(vec![OsString::from("/mcp list")]), Ok(0));
    }

    #[test]
    fn native_research_status_does_not_need_node_bridge() {
        assert_eq!(run(vec![OsString::from("research")]), Ok(0));
        assert_eq!(
            run(vec![OsString::from("research"), OsString::from("--help")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![OsString::from("research"), OsString::from("status")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("research"),
                OsString::from("status"),
                OsString::from("--json")
            ]),
            Ok(0)
        );
        assert_eq!(run(vec![OsString::from("/research status")]), Ok(0));
        assert_eq!(
            run(vec![
                OsString::from("research"),
                OsString::from("run"),
                OsString::from("--help")
            ]),
            Ok(0)
        );
        assert!(cli_research::top_level_research_args(&[
            OsString::from("research"),
            OsString::from("run"),
            OsString::from("summarize")
        ])
        .is_some());
    }

    #[test]
    fn native_setup_does_not_need_node_bridge() {
        assert_eq!(run(vec![OsString::from("setup")]), Ok(0));
        assert_eq!(
            run(vec![OsString::from("setup"), OsString::from("--help")]),
            Ok(0)
        );
    }

    #[test]
    fn native_team_status_surfaces_do_not_need_node_bridge() {
        assert_eq!(run(vec![OsString::from("team")]), Ok(0));
        assert_eq!(
            run(vec![OsString::from("team"), OsString::from("--help")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![OsString::from("team"), OsString::from("ls")]),
            Ok(0)
        );
        assert_eq!(
            run(vec![OsString::from("team"), OsString::from("status")]),
            Ok(0)
        );
        assert_eq!(run(vec![OsString::from("/team status")]), Ok(0));
    }

    #[test]
    fn native_queue_smoke_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![OsString::from("rust"), OsString::from("queue-smoke")]),
            Ok(0)
        );
    }

    #[test]
    fn native_auth_request_spec_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("auth"),
                OsString::from("request-spec"),
                OsString::from("authorization-code"),
                OsString::from("https://auth.openai.com")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_context_guidance_does_not_need_node_bridge() {
        let root = find_repo_root().expect("repo root");
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("guidance"),
                OsString::from(root.to_string_lossy().to_string()),
                OsString::from("-")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_context_repo_map_does_not_need_node_bridge() {
        let root = find_repo_root().expect("repo root");
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("repo-map-token"),
                OsString::from(root.to_string_lossy().to_string())
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("repo-map"),
                OsString::from(root.to_string_lossy().to_string())
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("worktree-fingerprint"),
                OsString::from(root.to_string_lossy().to_string())
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("token-budget"),
                OsString::from("default")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("estimate-tokens")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_context_auth_issues_do_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("auth-issues")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_context_skills_do_not_need_node_bridge() {
        let root = env::temp_dir().join(format!(
            "unclecode-context-skills-test-{}",
            std::process::id()
        ));
        let skill_dir = root.join(".codex/skills/analyze");
        std::fs::create_dir_all(&skill_dir).expect("skill dir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: analyze\ndescription: Inspect deeply.\n---\n# Analyze\nBody\n",
        )
        .expect("skill");
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("skills"),
                OsString::from("metadata"),
                OsString::from(root.to_string_lossy().to_string()),
                OsString::from(root.to_string_lossy().to_string())
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("context"),
                OsString::from("skill-load"),
                OsString::from("analyze"),
                OsString::from(root.to_string_lossy().to_string()),
                OsString::from(root.to_string_lossy().to_string())
            ]),
            Ok(0)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_ux_panel_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("panel"),
                OsString::from("queue")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("panel"),
                OsString::from("context")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("panel"),
                OsString::from("inline-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("model-suggestions"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
                OsString::from("/model")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("model-panel")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("model-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("model-builtin-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("reasoning-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("reasoning-builtin-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("trace-mode-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("skills-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("help-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("context-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("queue-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-key-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-key-submit-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-progress-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("sensitive-input-cancel-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("skill-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("tools-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("status-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("clear-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("harness-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("sessions-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("reload-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("memories-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("remember-command")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("inline-command-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("prompt-failure-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("prompt-success-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("prompt-start-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("prompt-finalize-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("post-turn-success-result")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("slash-suggestions"),
                OsString::from("/auth")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("slash-selection")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("clipboard-cap")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("attachment-dedup")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-label")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-extract-label")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-launcher-lines")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-status-panel-lines")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("auth-browser-failure-lines")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("composer-preview-mode")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("dashboard-home-patch")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("dashboard-home-sync-state")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("dashboard-home-refresh")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("text"),
                OsString::from("composer-dock-layout")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("text"),
                OsString::from("runtime-label")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("ux"),
                OsString::from("text"),
                OsString::from("normalize-markdown")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_aci_list_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("aci"),
                OsString::from("list"),
                OsString::from(".")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_orchestrator_complex_tasks_do_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("orchestrator"),
                OsString::from("complex-tasks")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_model_registry_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("model"),
                OsString::from("list"),
                OsString::from("openai")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("model"),
                OsString::from("route"),
                OsString::from("auto"),
                OsString::from("gpt-5.5")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("/model"),
                OsString::from("reasoning"),
                OsString::from("gpt-5.5")
            ]),
            Ok(0)
        );
        assert_eq!(run(vec![OsString::from("/model gpt-5.5")]), Ok(0));
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("openai-registry")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("openai-reasoning"),
                OsString::from("gpt-5.4")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("price"),
                OsString::from("gpt-4.1-mini")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("estimate-cost"),
                OsString::from("gpt-4.1-mini"),
                OsString::from("1000000"),
                OsString::from("1000000")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("detect-provider"),
                OsString::from("claude-sonnet-4-6")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("provider-route"),
                OsString::from("auto"),
                OsString::from("gemini-2.5-flash")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("provider-route-json"),
                OsString::from("auto"),
                OsString::from("gpt-5.5")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("provider-runtime-json"),
                OsString::from("auto"),
                OsString::from("claude-sonnet-4-6")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("capability"),
                OsString::from("openai"),
                OsString::from("prompt-caching"),
                OsString::from("gpt-5.5")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("model"),
                OsString::from("catalog"),
                OsString::from("gemini")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_command_router_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("command"),
                OsString::from("route"),
                OsString::from("/mode set analyze")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("command"),
                OsString::from("work-shell-route"),
                OsString::from("/review auth flow")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("command"),
                OsString::from("submit-route"),
                OsString::from("false"),
                OsString::from("default"),
                OsString::from("true")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("command"),
                OsString::from("help")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("command"),
                OsString::from("extension-slash-commands"),
                OsString::from("."),
                OsString::from("-")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("command"),
                OsString::from("extension-manifests"),
                OsString::from("."),
                OsString::from("-")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_composer_resolver_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("composer"),
                OsString::from("resolve"),
                OsString::from(".")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_steer_busy_submit_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("steer"),
                OsString::from("busy-submit"),
                OsString::from("0")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("steer"),
                OsString::from("drain-start"),
                OsString::from("false"),
                OsString::from("false"),
                OsString::from("1")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("steer"),
                OsString::from("drain-step"),
                OsString::from("1")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_shell_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("shell"),
                OsString::from("--"),
                OsString::from("printf shell-ok")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_http_proxy_policy_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("http"),
                OsString::from("proxy-policy"),
                OsString::from("https://api.openai.com/v1/chat")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_openai_request_spec_json_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("system-prompt")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-policy"),
                OsString::from("openai-codex-live")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("openai-request-spec-json"),
                OsString::from("api")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_gemini_request_spec_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("gemini-request-spec"),
                OsString::from("gemini-2.5-flash")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_gemini_request_spec_json_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("gemini-request-spec-json"),
                OsString::from("gemini-2.5-flash")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_anthropic_request_spec_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("anthropic-request-spec")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_anthropic_request_spec_json_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("anthropic-request-spec-json")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_loop_decision_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("loop-decision"),
                OsString::from("7"),
                OsString::from("1"),
                OsString::from("8"),
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("loop-limit"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_iteration_action_plan_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("iteration-action-plan"),
                OsString::from("0"),
                OsString::from("1"),
                OsString::from("8"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_turn_step_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("turn-step"),
                OsString::from("openai"),
                OsString::from("0"),
                OsString::from("0"),
                OsString::from("8"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_complete_turn_step_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("complete-turn-step"),
                OsString::from("openai"),
                OsString::from("0"),
                OsString::from("0"),
                OsString::from("8"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_dispatch_plan_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-dispatch-plan"),
                OsString::from("openai"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_append_state_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("reset-state"),
                OsString::from("openai"),
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("runtime-settings"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("app-reasoning"),
                OsString::from("openai"),
                OsString::from("gpt-5.5"),
                OsString::from("ultrawork"),
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("append-state"),
                OsString::from("openai"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_start_turn_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("start-turn"),
                OsString::from("openai"),
                OsString::from("inspect"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_attachment_caps_do_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("attachment-caps"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_result_turn_step_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-result-turn-step"),
                OsString::from("gemini"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_reasoning_delta_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("reasoning-delta"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
                OsString::from("text"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_reasoning_delta_record_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("reasoning-delta-record"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
                OsString::from("summary"),
                OsString::from("rs_1"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_route_trace_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("route-trace"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
                OsString::from("42"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_lifecycle_traces_do_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("turn-started-trace"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
                OsString::from("42"),
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("calling-trace"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
                OsString::from("42"),
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("turn-completed-trace"),
                OsString::from("openai"),
                OsString::from("gpt-5.4"),
                OsString::from("42"),
                OsString::from("48"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_openai_responses_message_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("openai-responses-message"),
                OsString::from("gpt-5.4"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_openai_chat_response_json_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("openai-chat-response-json"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_request_error_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("request-error"),
                OsString::from("openai"),
                OsString::from("401"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_openai_tool_actions_do_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("openai-tool-actions"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_trace_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-trace-completed"),
                OsString::from("openai"),
                OsString::from("read_file"),
                OsString::from("call_1"),
                OsString::from("10"),
                OsString::from("12"),
                OsString::from("no"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_execution_start_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-execution-start"),
                OsString::from("openai"),
                OsString::from("read_file"),
                OsString::from("call_1"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_execution_result_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-execution-result"),
                OsString::from("openai"),
                OsString::from("read_file"),
                OsString::from("call_1"),
                OsString::from("10"),
                OsString::from("12"),
                OsString::from("no"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_execution_finish_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-execution-finish"),
                OsString::from("openai"),
                OsString::from("read_file"),
                OsString::from("call_1"),
                OsString::from("10"),
                OsString::from("no"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_execution_finish_result_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-execution-finish-result"),
                OsString::from("openai"),
                OsString::from("read_file"),
                OsString::from("call_1"),
                OsString::from("10"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_result_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-result"),
                OsString::from("gemini"),
                OsString::from("read_file"),
                OsString::from("call_1"),
                OsString::from("success"),
                OsString::from("no"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_result_container_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-result-container"),
                OsString::from("anthropic"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_provider_tool_result_turn_entries_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("provider"),
                OsString::from("tool-result-turn-entries"),
                OsString::from("gemini"),
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_responses_result_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("sse"),
                OsString::from("responses-result")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_responses_message_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("sse"),
                OsString::from("responses-message")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_queue_commands_do_not_need_node_bridge() {
        let session_id = format!("test-queue-{}", std::process::id());
        let work_cwd = QueueTestWorkCwd::new(&session_id);
        let test_root = work_cwd.root.clone();
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("queue"),
                OsString::from("clear"),
                OsString::from(&session_id)
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("queue"),
                OsString::from("push-json"),
                OsString::from(&session_id),
                OsString::from("queued"),
                OsString::from("line")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("queue"),
                OsString::from("list"),
                OsString::from(&session_id)
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("queue"),
                OsString::from("len-json"),
                OsString::from(&session_id)
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("queue"),
                OsString::from("pop-json"),
                OsString::from(&session_id)
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("queue"),
                OsString::from("push"),
                OsString::from(&session_id),
                OsString::from("top-level"),
                OsString::from("queue")
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("queue"),
                OsString::from("list"),
                OsString::from(&session_id)
            ]),
            Ok(0)
        );
        assert_eq!(
            run(vec![
                OsString::from("queue"),
                OsString::from("pop"),
                OsString::from(&session_id)
            ]),
            Ok(0)
        );
        drop(work_cwd);
        assert!(
            !test_root.exists(),
            "queue CLI test must remove its temp work cwd"
        );
    }

    #[test]
    fn native_session_persist_usage_is_rust_owned() {
        assert!(matches!(
            run(vec![
                OsString::from("rust"),
                OsString::from("session"),
                OsString::from("list")
            ]),
            Ok(0) | Err(_)
        ));
    }

    #[test]
    fn native_session_paths_do_not_need_node_bridge() {
        let root = env::temp_dir().join(format!(
            "unclecode-session-paths-test-{}",
            std::process::id()
        ));
        let project = env::current_dir().expect("cwd");
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("session"),
                OsString::from("paths"),
                OsString::from(root),
                OsString::from(project),
                OsString::from("work-session-1")
            ]),
            Ok(0)
        );
    }

    #[test]
    fn native_sha256_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![OsString::from("rust"), OsString::from("sha256")]),
            Ok(0)
        );
    }

    #[test]
    fn native_sha256_base64url_does_not_need_node_bridge() {
        assert_eq!(
            run(vec![
                OsString::from("rust"),
                OsString::from("sha256-base64url")
            ]),
            Ok(0)
        );
    }
}
