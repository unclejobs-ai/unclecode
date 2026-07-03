use serde_json::{json, Value};

pub fn classify_work_intent(prompt: &str, mode: &str) -> &'static str {
    let routing_prompt = extract_routing_prompt(prompt);
    if mode == "ultrawork" {
        return "complex";
    }
    if is_trivial_conversational_prompt(routing_prompt) {
        return "simple";
    }

    if mode == "search" || mode == "analyze" {
        return "research";
    }

    if routing_prompt.starts_with('/') {
        return "simple";
    }

    let file_path_count = extract_file_paths(routing_prompt).len();
    let lower_prompt = routing_prompt.to_lowercase();

    let complex_keyword = [
        "refactor",
        "migrate",
        "rewrite",
        "redesign",
        "rebuild",
        "all files",
        "entire",
        "every",
    ]
    .iter()
    .any(|keyword| lower_prompt.contains(keyword))
        || [
            "리팩터",
            "마이그레이션",
            "전체",
            "모든 파일",
            "재작성",
            "재설계",
        ]
        .iter()
        .any(|keyword| routing_prompt.contains(keyword));

    if file_path_count >= 3 || complex_keyword {
        return "complex";
    }

    let yolo_complex_keyword = [
        "fix",
        "implement",
        "add",
        "update",
        "change",
        "create",
        "build",
        "improve",
    ]
    .iter()
    .any(|keyword| lower_prompt.contains(keyword))
        || [
            "수정",
            "구현",
            "추가",
            "변경",
            "고쳐",
            "만들어",
            "개선",
            "빌드",
        ]
        .iter()
        .any(|keyword| routing_prompt.contains(keyword));

    if mode == "yolo" && (file_path_count >= 2 || yolo_complex_keyword) {
        return "complex";
    }

    "simple"
}

fn extract_routing_prompt(prompt: &str) -> &str {
    let trimmed = prompt.trim();
    const CONTEXT_END: &str = "</unclecode_context_packet>";
    const USER_REQUEST: &str = "User request:";

    if let Some(context_end) = trimmed.rfind(CONTEXT_END) {
        let after_context = trimmed[context_end + CONTEXT_END.len()..].trim();
        if let Some(user_request_start) = after_context.find(USER_REQUEST) {
            let user_request = after_context[user_request_start + USER_REQUEST.len()..].trim();
            if !user_request.is_empty() {
                return user_request;
            }
        }
        if !after_context.is_empty() {
            return after_context;
        }
    }

    trimmed
}

fn is_trivial_conversational_prompt(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_lowercase();
    const GREETINGS: &[&str] = &[
        "hi",
        "hello",
        "hey",
        "yo",
        "sup",
        "thanks",
        "thank you",
        "ty",
        "ok",
        "okay",
        "안녕",
        "하이",
        "헬로",
        "반갑",
        "고마",
        "고맙",
        "감사",
        "넵",
        "ㅇㅋ",
        "ㄱㅅ",
    ];
    GREETINGS.iter().any(|greeting| {
        if greeting.is_ascii() {
            lower == *greeting
                || lower.starts_with(&format!("{greeting} "))
                || lower.starts_with(&format!("{greeting}!"))
                || lower.starts_with(&format!("{greeting},"))
        } else {
            lower.starts_with(greeting)
        }
    })
}

pub fn classify_work_intent_json(input_json: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid orchestrator intent JSON: {error}"))?;
    let prompt = value
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or("Invalid orchestrator intent JSON: missing string field `prompt`")?;
    let mode = value
        .get("mode")
        .and_then(Value::as_str)
        .ok_or("Invalid orchestrator intent JSON: missing string field `mode`")?;
    serde_json::to_string(&json!({ "intent": classify_work_intent(prompt, mode) }))
        .map_err(|error| error.to_string())
}

pub fn resolve_worker_budget(mode: &str) -> u64 {
    match mode {
        "ultrawork" => 5,
        "yolo" => 4,
        "search" | "analyze" => 3,
        _ => 1,
    }
}

pub fn resolve_worker_budget_json(mode: &str) -> Result<String, String> {
    serde_json::to_string(&json!({ "workerBudget": resolve_worker_budget(mode) }))
        .map_err(|error| error.to_string())
}

pub fn build_complex_tasks_json(prompt: &str) -> Result<String, String> {
    let routing_prompt = extract_routing_prompt(prompt);
    let file_paths = extract_file_paths(routing_prompt);
    let tasks: Vec<Value> = if file_paths.is_empty() {
        vec![
            json!({
                "id": "task-1",
                "summary": "Investigate scope and current implementation",
                "prompt": format!(
                    "Read the relevant code to understand what exists today. Identify the files, functions, and types involved.\n\nRequest: {prompt}"
                ),
            }),
            json!({
                "id": "task-2",
                "summary": "Plan changes and identify risks",
                "prompt": format!(
                    "Based on the codebase, outline what needs to change, what tests are needed, and what could break.\n\nRequest: {prompt}"
                ),
            }),
            json!({
                "id": "task-3",
                "summary": "Verify constraints and edge cases",
                "prompt": format!(
                    "Check for edge cases, type safety concerns, and existing test coverage gaps related to this request.\n\nRequest: {prompt}"
                ),
            }),
        ]
    } else {
        file_paths
            .iter()
            .enumerate()
            .map(|(index, file_path)| {
                json!({
                    "id": format!("task-{}", index + 1),
                    "summary": format!("Inspect {file_path}"),
                    "prompt": format!(
                        "Inspect {file_path} for this request and report the concrete changes or risks.\n\nOriginal request: {prompt}"
                    ),
                })
            })
            .collect()
    };

    serde_json::to_string(&tasks).map_err(|error| error.to_string())
}

pub fn parse_plan_response_json(text: &str) -> Result<String, String> {
    let Some(start) = text.find('[') else {
        return Ok("[]".to_string());
    };
    let Some(end) = text.rfind(']') else {
        return Ok("[]".to_string());
    };
    if end < start {
        return Ok("[]".to_string());
    }

    let json_slice = &text[start..=end];
    let Ok(value) = serde_json::from_str::<Value>(json_slice) else {
        return Ok("[]".to_string());
    };
    let Some(items) = value.as_array() else {
        return Ok("[]".to_string());
    };

    let tasks: Vec<Value> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?;
            let summary = item.get("summary").and_then(Value::as_str)?;
            let prompt = item.get("prompt").and_then(Value::as_str)?;
            Some(json!({
                "id": id,
                "summary": summary,
                "prompt": prompt,
            }))
        })
        .collect();

    serde_json::to_string(&tasks).map_err(|error| error.to_string())
}

pub fn build_planner_prompt_json(input_json: &str) -> Result<String, String> {
    let value = parse_value(input_json, "planner prompt")?;
    let value = object_value(&value, "planner prompt")?;
    let prompt = string_field(value, "prompt", "planner prompt")?;
    Ok([
        "Break this request into 2-4 independent subtasks.".to_string(),
        "Return ONLY a JSON array of objects with {id, summary, prompt} fields.".to_string(),
        "Each subtask should be independently executable.".to_string(),
        format!("Request: {prompt}"),
    ]
    .join("\n"))
}

pub fn build_guardian_review_prompt_json(input_json: &str) -> Result<String, String> {
    let value = parse_value(input_json, "guardian review prompt")?;
    let value = object_value(&value, "guardian review prompt")?;
    let prompt = string_field(value, "prompt", "guardian review prompt")?;
    let results = result_summaries(value, "guardian review prompt")?;
    let executable_checks = value
        .get("executableChecks")
        .and_then(Value::as_str)
        .filter(|checks| !checks.trim().is_empty());

    let mut parts = vec![
        "Review the executor findings for gaps, contradictions, and missing verification."
            .to_string(),
        format!("Original request: {prompt}"),
        "Executor findings:".to_string(),
    ];
    parts.extend(
        results
            .iter()
            .enumerate()
            .map(|(index, summary)| format!("- [{}] {summary}", index + 1)),
    );
    if let Some(checks) = executable_checks {
        parts.push("Executable verification:".to_string());
        parts.push(checks.to_string());
    }

    Ok(parts.join("\n\n"))
}

pub fn build_synthesis_prompt_json(input_json: &str) -> Result<String, String> {
    let value = parse_value(input_json, "synthesis prompt")?;
    let value = object_value(&value, "synthesis prompt")?;
    let prompt = string_field(value, "prompt", "synthesis prompt")?;
    let model = string_field(value, "model", "synthesis prompt")?;
    let reasoning = string_field(value, "reasoning", "synthesis prompt")?;
    let results = result_summaries(value, "synthesis prompt")?;
    let guardian_summary = value
        .get("guardianSummary")
        .and_then(Value::as_str)
        .filter(|summary| !summary.trim().is_empty());

    let mut parts = vec![
        "Synthesize executor findings into a single answer for the original request.".to_string(),
        format!("Model: {model}"),
        format!("Reasoning: {reasoning}"),
        format!("Original request: {prompt}"),
        "Findings:".to_string(),
    ];
    parts.extend(
        results
            .iter()
            .enumerate()
            .map(|(index, summary)| format!("- [{}] {summary}", index + 1)),
    );
    if let Some(summary) = guardian_summary {
        parts.push("Guardian review:".to_string());
        parts.push(summary.to_string());
    }

    Ok(parts.join("\n\n"))
}

pub fn extract_changed_files_from_tasks_json(tasks_json: &str) -> Result<String, String> {
    let tasks: Value = serde_json::from_str(tasks_json)
        .map_err(|error| format!("Invalid orchestrator tasks JSON: {error}"))?;
    let tasks = tasks
        .as_array()
        .ok_or("Invalid orchestrator tasks JSON: expected an array")?;

    let mut files = Vec::new();
    for task in tasks {
        for field in ["summary", "prompt"] {
            if let Some(text) = task.get(field).and_then(Value::as_str) {
                for file_path in extract_file_paths(text) {
                    if !files.contains(&file_path) {
                        files.push(file_path);
                    }
                }
            }
        }
    }

    serde_json::to_string(&files).map_err(|error| error.to_string())
}

pub fn build_trace_event_json(input_json: &str) -> Result<String, String> {
    let value = parse_value(input_json, "trace event")?;
    let value = object_value(&value, "trace event")?;
    let kind = string_field(value, "kind", "trace event")?;

    let event = match kind {
        "ownership-pending" => {
            let worker_id = string_field(value, "workerId", "trace event")?;
            let task_id = string_field(value, "taskId", "trace event")?;
            let write_paths = string_array_field(value, "writePaths", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("{worker_id}-{task_id}-ownership"),
                "role": "executor",
                "kind": "agent-step",
                "status": "pending",
                "summary": format!("Waiting for write ownership: {}", write_paths.join(", ")),
            })
        }
        "executor-running" => {
            let worker_id = string_field(value, "workerId", "trace event")?;
            let task_id = string_field(value, "taskId", "trace event")?;
            let summary = string_field(value, "summary", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("{worker_id}-{task_id}"),
                "role": "executor",
                "kind": "agent-step",
                "status": "running",
                "summary": summary,
                "startedAt": started_at,
            })
        }
        "executor-completed" => {
            let worker_id = string_field(value, "workerId", "trace event")?;
            let task_id = string_field(value, "taskId", "trace event")?;
            let summary = string_field(value, "summary", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let completed_at = number_field(value, "completedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("{worker_id}-{task_id}"),
                "role": "executor",
                "kind": "agent-step",
                "status": "completed",
                "summary": summary,
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": completed_at.saturating_sub(started_at),
            })
        }
        "executor-failed" => {
            let worker_id = string_field(value, "workerId", "trace event")?;
            let task_id = string_field(value, "taskId", "trace event")?;
            let summary = string_field(value, "summary", "trace event")?;
            let message = string_field(value, "message", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let completed_at = number_field(value, "completedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("{worker_id}-{task_id}"),
                "role": "executor",
                "kind": "agent-step",
                "status": "failed",
                "summary": format!("{summary}: {message}"),
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": completed_at.saturating_sub(started_at),
            })
        }
        "turn-running" => {
            let started_at = number_field(value, "startedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("turn-{started_at}"),
                "role": "turn",
                "kind": "span",
                "status": "running",
                "summary": "Routing complex turn to planner",
                "startedAt": started_at,
            })
        }
        "turn-completed" => {
            let task_count = number_field(value, "taskCount", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let completed_at = number_field(value, "completedAt", "trace event")?;
            let plural = if task_count == 1 { "" } else { "s" };
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("turn-{started_at}"),
                "role": "turn",
                "kind": "span",
                "status": "completed",
                "summary": format!("Completed {task_count} task{plural}"),
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": completed_at.saturating_sub(started_at),
            })
        }
        "planner-completed" => {
            let task_count = number_field(value, "taskCount", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let completed_at = number_field(value, "completedAt", "trace event")?;
            let plural = if task_count == 1 { "" } else { "s" };
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("planner-{started_at}"),
                "role": "planner",
                "kind": "agent-step",
                "status": "completed",
                "summary": format!("Prepared {task_count} task{plural}"),
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": completed_at.saturating_sub(started_at),
            })
        }
        "planner-running" => {
            let prompt = string_field(value, "prompt", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("planner-{started_at}"),
                "role": "planner",
                "kind": "agent-step",
                "status": "running",
                "summary": format!("Planning: {prompt}"),
                "startedAt": started_at,
            })
        }
        "guardian-running" => {
            let started_at = number_field(value, "startedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("reviewer-{started_at}"),
                "role": "reviewer",
                "kind": "agent-step",
                "status": "running",
                "summary": "Guardian auto-review",
                "startedAt": started_at,
            })
        }
        "guardian-completed" => {
            let summary = string_field(value, "summary", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let completed_at = number_field(value, "completedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("reviewer-{started_at}"),
                "role": "reviewer",
                "kind": "agent-step",
                "status": "completed",
                "summary": format!("Guardian review: {summary}"),
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": completed_at.saturating_sub(started_at),
            })
        }
        "guardian-failed" => {
            let message = string_field(value, "message", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let completed_at = number_field(value, "completedAt", "trace event")?;
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("reviewer-{started_at}"),
                "role": "reviewer",
                "kind": "agent-step",
                "status": "failed",
                "summary": format!("Guardian review failed: {message}"),
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": completed_at.saturating_sub(started_at),
            })
        }
        "synthesis-running" => {
            let result_count = number_field(value, "resultCount", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let plural = if result_count == 1 { "" } else { "s" };
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("reviewer-{started_at}"),
                "role": "reviewer",
                "status": "running",
                "summary": format!("Synthesizing {result_count} executor result{plural}"),
                "startedAt": started_at,
            })
        }
        "synthesis-completed" => {
            let result_count = number_field(value, "resultCount", "trace event")?;
            let started_at = number_field(value, "startedAt", "trace event")?;
            let completed_at = number_field(value, "completedAt", "trace event")?;
            let plural = if result_count == 1 { "" } else { "s" };
            json!({
                "type": "orchestrator.step",
                "level": "high-signal",
                "stepId": format!("reviewer-{started_at}"),
                "role": "reviewer",
                "status": "completed",
                "summary": format!("Synthesized {result_count} executor result{plural}"),
                "startedAt": started_at,
                "completedAt": completed_at,
                "durationMs": completed_at.saturating_sub(started_at),
            })
        }
        _ => return Err(format!("Invalid orchestrator trace event kind `{kind}`")),
    };

    serde_json::to_string(&event).map_err(|error| error.to_string())
}

fn parse_value(input_json: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid orchestrator {label} JSON: {error}"))
}

fn number_field(
    value: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("Invalid orchestrator {label} JSON: missing number field `{field}`"))
}

fn string_array_field(
    value: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<Vec<String>, String> {
    let values = value.get(field).and_then(Value::as_array).ok_or_else(|| {
        format!("Invalid orchestrator {label} JSON: missing array field `{field}`")
    })?;
    values
        .iter()
        .map(|item| {
            item.as_str().map(ToString::to_string).ok_or_else(|| {
                format!("Invalid orchestrator {label} JSON: `{field}` entries must be strings")
            })
        })
        .collect()
}

fn object_value<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("Invalid orchestrator {label} JSON: expected an object"))
}

fn string_field<'a>(
    value: &'a serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Invalid orchestrator {label} JSON: missing string field `{field}`"))
}

fn result_summaries(
    value: &serde_json::Map<String, Value>,
    label: &str,
) -> Result<Vec<String>, String> {
    let results = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!("Invalid orchestrator {label} JSON: missing array field `results`")
        })?;
    let mut summaries = Vec::new();
    for result in results {
        let summary = result
            .get("summary")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!("Invalid orchestrator {label} JSON: result missing string field `summary`")
            })?;
        summaries.push(summary.to_string());
    }
    Ok(summaries)
}

fn extract_file_paths(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        while index < bytes.len() && !is_path_char(bytes[index]) {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && is_path_char(bytes[index]) {
            index += 1;
        }
        if start == index {
            continue;
        }

        let candidate = &text[start..index];
        if looks_like_path(candidate) && !paths.iter().any(|path| path == candidate) {
            paths.push(candidate.to_string());
        }
    }

    paths
}

fn is_path_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/')
}

fn looks_like_path(candidate: &str) -> bool {
    let Some(dot_index) = candidate.rfind('.') else {
        return false;
    };
    let extension_len = candidate.len().saturating_sub(dot_index + 1);
    (1..=5).contains(&extension_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_modes_and_prompts() {
        // non-trivial work in ultrawork is complex
        assert_eq!(
            classify_work_intent("look around the project", "ultrawork"),
            "complex"
        );
        assert_eq!(classify_work_intent("explain auth", "search"), "research");
        assert_eq!(classify_work_intent("/help", "yolo"), "simple");
        assert_eq!(classify_work_intent("fix the login bug", "yolo"), "complex");
        assert_eq!(classify_work_intent("전체 점검해", "default"), "complex");
        assert_eq!(classify_work_intent("what is this?", "yolo"), "simple");
    }

    #[test]
    fn greetings_are_simple_outside_ultrawork() {
        for mode in ["yolo", "default", "build"] {
            assert_eq!(classify_work_intent("hi", mode), "simple", "hi in {mode}");
            assert_eq!(
                classify_work_intent("hello", mode),
                "simple",
                "hello in {mode}"
            );
            assert_eq!(
                classify_work_intent("하이요", mode),
                "simple",
                "하이요 in {mode}"
            );
            assert_eq!(
                classify_work_intent("반갑다", mode),
                "simple",
                "반갑다 in {mode}"
            );
        }
        assert_eq!(classify_work_intent("hi", "ultrawork"), "complex");
        // real tasks still classify as work even in full-autonomy modes
        assert_eq!(
            classify_work_intent("create a landing page", "yolo"),
            "complex"
        );
    }

    #[test]
    fn context_packet_metadata_does_not_force_complex_routing() {
        let prompt = r#"<unclecode_context_packet id="packet-1" version="1">
Included:
- workspace guidance: Loaded guidance: CLAUDE.md, AGENTS.md, UNCLECODE.md, rules/modular-code-enforcement.md
Excluded raw artifacts:
- 99 raw artifacts withheld from model-ready context.
</unclecode_context_packet>

User request:
Say hello from full-screen TUI QA."#;

        assert_eq!(classify_work_intent(prompt, "default"), "simple");
    }

    #[test]
    fn yolo_greeting_with_context_packet_stays_simple() {
        let prompt = r#"<unclecode_context_packet id="packet-1" version="1">
Included:
- workspace guidance: Loaded guidance: CLAUDE.md, AGENTS.md, UNCLECODE.md, rules/modular-code-enforcement.md
Excluded raw artifacts:
- 99 raw artifacts withheld from model-ready context.
</unclecode_context_packet>

User request:
hi"#;

        assert_eq!(classify_work_intent(prompt, "yolo"), "simple");
    }

    #[test]
    fn resolves_worker_budget_by_mode() {
        assert_eq!(resolve_worker_budget("default"), 1);
        assert_eq!(resolve_worker_budget("search"), 3);
        assert_eq!(resolve_worker_budget("analyze"), 3);
        assert_eq!(resolve_worker_budget("yolo"), 4);
        assert_eq!(resolve_worker_budget("ultrawork"), 5);
        let output = resolve_worker_budget_json("yolo").unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["workerBudget"], 4);
    }

    #[test]
    fn builds_file_scoped_complex_tasks() {
        let output =
            build_complex_tasks_json("check packages/a.ts and rust/src/lib.rs please").unwrap();
        let tasks: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(tasks.as_array().unwrap().len(), 2);
        assert_eq!(tasks[0]["summary"], "Inspect packages/a.ts");
        assert!(tasks[1]["prompt"]
            .as_str()
            .unwrap()
            .contains("Original request: check packages/a.ts"));
    }

    #[test]
    fn complex_tasks_ignore_context_packet_file_metadata() {
        let output = build_complex_tasks_json(
            r#"<unclecode_context_packet id="packet-1" version="1">
Included:
- workspace guidance: Loaded guidance: CLAUDE.md, AGENTS.md, UNCLECODE.md, rules/modular-code-enforcement.md
</unclecode_context_packet>

User request:
check packages/a.ts and rust/src/lib.rs please"#,
        )
        .unwrap();
        let tasks: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(tasks.as_array().unwrap().len(), 2);
        assert_eq!(tasks[0]["summary"], "Inspect packages/a.ts");
        assert_eq!(tasks[1]["summary"], "Inspect rust/src/lib.rs");
    }

    #[test]
    fn parses_agent_plan_response() {
        let output = parse_plan_response_json(
            r#"Here:
[{"id":"task-1","summary":"Read files","prompt":"Read src/index.ts"},{"id":"bad","summary":2,"prompt":"skip"},{"id":"task-2","summary":"Fix bug","prompt":"Fix auth.ts"}]"#,
        )
        .unwrap();
        let tasks: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(tasks.as_array().unwrap().len(), 2);
        assert_eq!(tasks[0]["id"], "task-1");
        assert_eq!(tasks[1]["summary"], "Fix bug");

        assert_eq!(parse_plan_response_json("no json").unwrap(), "[]");
        assert_eq!(parse_plan_response_json("[invalid").unwrap(), "[]");
        assert_eq!(
            parse_plan_response_json(r#"["not objects"]"#).unwrap(),
            "[]"
        );
    }

    #[test]
    fn extracts_changed_files_from_task_text() {
        let output = extract_changed_files_from_tasks_json(
            r#"[{"summary":"Inspect a.ts","prompt":"Edit src/a.ts and src/b.ts"},{"summary":"src/a.ts","prompt":"again"}]"#,
        )
        .unwrap();
        let files: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(files, json!(["a.ts", "src/a.ts", "src/b.ts"]));
    }

    #[test]
    fn builds_agent_prompts() {
        let planner = build_planner_prompt_json(r#"{"prompt":"refactor login"}"#).unwrap();
        assert!(planner.starts_with("Break this request into 2-4 independent subtasks."));
        assert!(planner.ends_with("Request: refactor login"));

        let guardian = build_guardian_review_prompt_json(
            r#"{"prompt":"ship it","results":[{"summary":"result one"},{"summary":"result two"}],"executableChecks":"lint PASS"}"#,
        )
        .unwrap();
        assert!(guardian.starts_with("Review the executor findings"));
        assert!(guardian.contains("- [2] result two"));
        assert!(guardian.contains("Executable verification:\n\nlint PASS"));

        let synthesis = build_synthesis_prompt_json(
            r#"{"prompt":"ship it","model":"gpt-5.4","reasoning":"high","results":[{"summary":"result one"}],"guardianSummary":"looks good"}"#,
        )
        .unwrap();
        assert!(synthesis.starts_with("Synthesize executor findings"));
        assert!(synthesis.contains("Model: gpt-5.4"));
        assert!(synthesis.contains("Guardian review:\n\nlooks good"));
    }

    #[test]
    fn builds_orchestrator_trace_events() {
        let running = build_trace_event_json(
            r#"{"kind":"executor-running","workerId":"executor-1","taskId":"task-1","summary":"Inspect login.ts","startedAt":10}"#,
        )
        .unwrap();
        let running: Value = serde_json::from_str(&running).unwrap();
        assert_eq!(running["stepId"], "executor-1-task-1");
        assert_eq!(running["kind"], "agent-step");
        assert_eq!(running["summary"], "Inspect login.ts");

        let completed = build_trace_event_json(
            r#"{"kind":"turn-completed","taskCount":2,"startedAt":10,"completedAt":25}"#,
        )
        .unwrap();
        let completed: Value = serde_json::from_str(&completed).unwrap();
        assert_eq!(completed["stepId"], "turn-10");
        assert_eq!(completed["summary"], "Completed 2 tasks");
        assert_eq!(completed["durationMs"], 15);

        let guardian = build_trace_event_json(
            r#"{"kind":"guardian-failed","message":"boom","startedAt":5,"completedAt":8}"#,
        )
        .unwrap();
        let guardian: Value = serde_json::from_str(&guardian).unwrap();
        assert_eq!(guardian["role"], "reviewer");
        assert_eq!(guardian["summary"], "Guardian review failed: boom");

        let planner = build_trace_event_json(
            r#"{"kind":"planner-running","prompt":"refactor login","startedAt":12}"#,
        )
        .unwrap();
        let planner: Value = serde_json::from_str(&planner).unwrap();
        assert_eq!(planner["stepId"], "planner-12");
        assert_eq!(planner["summary"], "Planning: refactor login");

        let synthesis = build_trace_event_json(
            r#"{"kind":"synthesis-completed","resultCount":1,"startedAt":20,"completedAt":30}"#,
        )
        .unwrap();
        let synthesis: Value = serde_json::from_str(&synthesis).unwrap();
        assert_eq!(synthesis["summary"], "Synthesized 1 executor result");
        assert_eq!(synthesis["durationMs"], 10);
    }
}
