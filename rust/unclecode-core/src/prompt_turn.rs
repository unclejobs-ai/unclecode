use serde_json::{json, Value};

pub fn summarize_work_shell_prompt(value: &str) -> String {
    summarize(value, 52, 49)
}

pub fn summarize_work_shell_text(value: &str) -> String {
    summarize(value, 72, 69)
}

pub fn summarize_work_shell_prompt_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "prompt summary")?;
    let value = string_field(&input, "value").unwrap_or("");
    serde_json::to_string(&json!({ "summary": summarize_work_shell_prompt(value) }))
        .map_err(|error| error.to_string())
}

pub fn summarize_work_shell_text_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "text summary")?;
    let value = string_field(&input, "value").unwrap_or("");
    serde_json::to_string(&json!({ "summary": summarize_work_shell_text(value) }))
        .map_err(|error| error.to_string())
}

pub fn create_chat_prompt_turn_input_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "chat prompt turn input")?;
    let line = string_field(&input, "line").unwrap_or("");
    let composer = input.get("composer").and_then(Value::as_object);
    let transcript_text = composer
        .and_then(|value| value.get("transcriptText"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let prompt = composer
        .and_then(|value| value.get("prompt"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let attachments = composer
        .and_then(|value| value.get("attachments"))
        .cloned()
        .unwrap_or_else(|| json!([]));

    serde_json::to_string(&json!({
        "transcriptText": transcript_text,
        "prompt": prompt,
        "attachments": attachments,
        "sessionSummary": format!("Chat: {}", summarize_work_shell_prompt(prompt)),
        "failureSummary": format!("Chat failed: {}", summarize_work_shell_prompt(line)),
    }))
    .map_err(|error| error.to_string())
}

pub fn create_prompt_command_turn_input_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "prompt command turn input")?;
    let transcript_text = string_field(&input, "transcriptText").unwrap_or("");
    let prompt = string_field(&input, "prompt").unwrap_or("");
    let prompt_command = input.get("promptCommand").unwrap_or(&Value::Null);
    let kind = string_field(prompt_command, "kind").unwrap_or("");
    let label = if kind == "review" {
        "Review"
    } else {
        "Commit draft"
    };
    let focus = string_field(prompt_command, "focus").unwrap_or("current changes");
    let failure_focus = string_field(prompt_command, "focus").unwrap_or(transcript_text);

    serde_json::to_string(&json!({
        "transcriptText": transcript_text,
        "prompt": prompt,
        "sessionSummary": format!("{label}: {}", summarize_work_shell_prompt(focus)),
        "failureSummary": format!("{label} failed: {}", summarize_work_shell_prompt(failure_focus)),
    }))
    .map_err(|error| error.to_string())
}

pub fn create_conversation_turn_summary_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "conversation turn summary")?;
    let transcript_text = string_field(&input, "transcriptText").unwrap_or("");
    let assistant_text = string_field(&input, "assistantText").unwrap_or("");
    serde_json::to_string(&json!({
        "summary": summarize_work_shell_text(&format!("Q: {transcript_text} · A: {assistant_text}")),
    }))
    .map_err(|error| error.to_string())
}

pub fn detect_edit_intent_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "edit intent")?;
    let text = string_field(&input, "text").unwrap_or("");
    serde_json::to_string(&json!({ "detected": detect_edit_intent(text) }))
        .map_err(|error| error.to_string())
}

pub fn resolve_read_only_mode_guard_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "read-only mode guard")?;
    let mode = string_field(&input, "mode").unwrap_or("");
    let prompt = string_field(&input, "prompt").unwrap_or("");
    let message = if mode == "search" && detect_edit_intent(prompt) {
        Value::String(
            "Search mode is read-only. Switch with /mode set yolo, then resend your edit request.".to_string(),
        )
    } else if mode == "plan" && detect_edit_intent(prompt) {
        Value::String(
            "Plan mode blocks edits. Switch with /mode set build or yolo, then resend.".to_string(),
        )
    } else {
        Value::Null
    };
    serde_json::to_string(&json!({ "message": message })).map_err(|error| error.to_string())
}

pub fn resolve_permission_stall_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "permission stall")?;
    let text = string_field(&input, "text")
        .or_else(|| string_field(&input, "assistantText"))
        .unwrap_or("");
    serde_json::to_string(&json!({
        "detected": detect_permission_seeking_stall(text),
        "cleaned": strip_permission_seeking_stall_outro(text),
    }))
    .map_err(|error| error.to_string())
}

pub fn build_permission_stall_continue_prompt_json(input_json: &str) -> Result<String, String> {
    let input = parse_value(input_json, "permission stall continue prompt")?;
    let original_prompt = string_field(&input, "originalPrompt")
        .or_else(|| string_field(&input, "prompt"))
        .unwrap_or("");
    let previous_answer = string_field(&input, "previousAnswer").unwrap_or("");
    serde_json::to_string(&json!({
        "prompt": build_permission_stall_continue_prompt(original_prompt, previous_answer),
    }))
    .map_err(|error| error.to_string())
}

pub fn detect_edit_intent(text: &str) -> bool {
    let normalized = text.trim();
    if normalized.is_empty() {
        return false;
    }
    let lower = normalized.to_lowercase();
    [
        "edit",
        "modify",
        "change",
        "update",
        "fix",
        "patch",
        "implement",
        "add",
        "remove",
        "delete",
        "refactor",
        "rewrite",
        "create",
    ]
    .iter()
    .any(|keyword| contains_word(&lower, keyword))
        || [
            "수정",
            "변경",
            "고쳐",
            "구현",
            "추가",
            "삭제",
            "리팩터",
            "리팩토",
            "바꿔",
            "만들어",
            "넣어",
            "보강",
        ]
        .iter()
        .any(|keyword| normalized.contains(keyword))
}

pub fn detect_permission_seeking_stall(text: &str) -> bool {
    let paragraphs = split_reply_paragraphs(text);
    let Some(last_paragraph) = paragraphs.last() else {
        return false;
    };
    if is_permission_seeking_segment(last_paragraph) {
        return true;
    }

    let sentences = split_reply_sentences(last_paragraph);
    sentences.len() > 1
        && sentences
            .last()
            .map(|sentence| is_permission_seeking_segment(sentence))
            .unwrap_or(false)
}

pub fn strip_permission_seeking_stall_outro(text: &str) -> String {
    let normalized = text.trim();
    if normalized.is_empty() {
        return normalized.to_string();
    }

    let paragraphs = split_reply_paragraphs(normalized);
    let Some(last_paragraph) = paragraphs.last() else {
        return normalized.to_string();
    };
    if paragraphs.len() > 1 && is_permission_seeking_segment(last_paragraph) {
        return paragraphs[..paragraphs.len() - 1]
            .join("\n\n")
            .trim()
            .to_string();
    }

    let sentences = split_reply_sentences(last_paragraph);
    if sentences.len() > 1
        && sentences
            .last()
            .map(|sentence| is_permission_seeking_segment(sentence))
            .unwrap_or(false)
    {
        let trimmed_paragraph = sentences[..sentences.len() - 1]
            .join(" ")
            .trim()
            .to_string();
        let mut kept = paragraphs[..paragraphs.len() - 1].to_vec();
        if !trimmed_paragraph.is_empty() {
            kept.push(trimmed_paragraph);
        }
        return kept.join("\n\n").trim().to_string();
    }

    normalized.to_string()
}

pub fn build_permission_stall_continue_prompt(
    original_prompt: &str,
    previous_answer: &str,
) -> String {
    [
        "Continue automatically without asking for permission.".to_string(),
        "Do not say \"if you want\", \"if you'd like\", \"let me know\", \"계속할까요\", \"진행할까요\", or \"원하시면\".".to_string(),
        "Perform the next concrete pass now and report the completed work plus verification.".to_string(),
        format!("Original request: {original_prompt}"),
        if previous_answer.is_empty() {
            String::new()
        } else {
            format!("Previous partial answer:\n{previous_answer}")
        },
    ]
    .into_iter()
    .filter(|segment| !segment.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

fn summarize(value: &str, max_len: usize, slice_len: usize) -> String {
    if value.chars().count() > max_len {
        format!("{}...", value.chars().take(slice_len).collect::<String>())
    } else {
        value.to_string()
    }
}

fn split_reply_paragraphs(text: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current = Vec::new();
    let mut blank_seen = false;

    for line in text.trim().lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blank_seen = true;
            }
            continue;
        }
        if blank_seen && !current.is_empty() {
            paragraphs.push(current.join("\n").trim().to_string());
            current.clear();
        }
        blank_seen = false;
        current.push(line.trim().to_string());
    }
    if !current.is_empty() {
        paragraphs.push(current.join("\n").trim().to_string());
    }
    paragraphs
        .into_iter()
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn split_reply_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut start = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for (idx, (byte_index, ch)) in chars.iter().enumerate() {
        if !matches!(ch, '.' | '!' | '?') {
            continue;
        }
        let next_is_space = chars
            .get(idx + 1)
            .map(|(_, next)| next.is_whitespace())
            .unwrap_or(true);
        if next_is_space {
            let end = byte_index + ch.len_utf8();
            let segment = text[start..end].trim();
            if !segment.is_empty() {
                sentences.push(segment.to_string());
            }
            start = chars
                .get(idx + 1)
                .map(|(next_index, _)| *next_index)
                .unwrap_or(text.len());
        }
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        sentences.push(tail.to_string());
    }
    sentences
}

fn is_permission_seeking_segment(text: &str) -> bool {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return false;
    }
    let lower = normalized.to_lowercase();

    lower.starts_with("if you want")
        || lower.starts_with("if you'd like")
        || lower.starts_with("if you want me to")
        || lower.starts_with("if you'd like me to")
        || lower.starts_with("let me know if you want")
        || lower.starts_with("let me know if you would like")
        || lower.starts_with("tell me if you want")
        || lower.starts_with("tell me if you would like")
        || starts_with_any(
            &lower,
            &[
                "i can continue",
                "i can keep going",
                "i can also continue",
                "i can also keep going",
                "i can take another pass",
                "i can handle the rest",
                "i can do the rest",
                "i can clean up the remaining",
                "i could continue",
                "i could keep going",
                "i could also continue",
                "i could also keep going",
                "i could take another pass",
                "i could handle the rest",
                "i could do the rest",
                "i could clean up the remaining",
                "happy to continue",
                "happy to keep going",
                "happy to take another pass",
            ],
        )
        || (contains_any(&normalized, &["계속", "진행", "이어서"])
            && contains_any(
                &normalized,
                &["할까요", "할게요", "하겠습니다", "해도 될까요"],
            ))
        || (contains_any(&normalized, &["원하시면", "원한다면", "필요하시면"])
            && contains_any(&normalized, &["진행", "계속", "수정"]))
}

fn contains_word(text: &str, word: &str) -> bool {
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .any(|part| part == word)
}

fn starts_with_any(text: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|prefix| text.starts_with(prefix))
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn parse_value(input_json: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str(input_json).map_err(|error| format!("Invalid {label} JSON: {error}"))
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_prompt_turn_summaries() {
        let chat = serde_json::from_str::<Value>(
            &create_chat_prompt_turn_input_json(
                r#"{"line":"review everything in this repo please","composer":{"prompt":"review everything in this repo please","transcriptText":"review everything in this repo please","attachments":["img-1"]}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            chat["sessionSummary"],
            "Chat: review everything in this repo please"
        );
        assert_eq!(chat["attachments"][0], "img-1");

        let command = serde_json::from_str::<Value>(
            &create_prompt_command_turn_input_json(
                r#"{"transcriptText":"/review auth flow","prompt":"prompt-body","promptCommand":{"kind":"review","focus":"auth flow"}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(command["sessionSummary"], "Review: auth flow");
        assert_eq!(command["failureSummary"], "Review failed: auth flow");

        let summary = serde_json::from_str::<Value>(
            &create_conversation_turn_summary_json(
                r#"{"transcriptText":"question","assistantText":"answer"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(summary["summary"], "Q: question · A: answer");
    }

    #[test]
    fn detects_edit_intent_and_read_only_guard() {
        assert!(detect_edit_intent("provider parity 구현해줘"));
        assert!(!detect_edit_intent("summarize current repo"));

        let guarded = serde_json::from_str::<Value>(
            &resolve_read_only_mode_guard_json(
                r#"{"mode":"search","prompt":"Anthropic parity 구현해줘"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(guarded["message"]
            .as_str()
            .unwrap()
            .contains("Search mode is read-only"));

        let plan_guarded = serde_json::from_str::<Value>(
            &resolve_read_only_mode_guard_json(
                r#"{"mode":"plan","prompt":"Anthropic parity 구현해줘"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(plan_guarded["message"]
            .as_str()
            .unwrap()
            .contains("Plan mode blocks edits"));

        let unguarded = serde_json::from_str::<Value>(
            &resolve_read_only_mode_guard_json(
                r#"{"mode":"default","prompt":"Anthropic parity 구현해줘"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(unguarded["message"].is_null());
    }

    #[test]
    fn detects_and_strips_permission_stalls() {
        assert!(detect_permission_seeking_stall(
            "Done.\n\nIf you want, I can continue."
        ));
        assert_eq!(
            strip_permission_seeking_stall_outro("Done.\n\nIf you want, I can continue."),
            "Done."
        );
        assert!(detect_permission_seeking_stall(
            "완료했습니다.\n\n계속 진행할까요?"
        ));
        assert!(detect_permission_seeking_stall(
            "원하시면 나머지도 수정하겠습니다."
        ));

        let result = serde_json::from_str::<Value>(
            &resolve_permission_stall_json(r#"{"text":"Done.\n\nIf you want, I can continue."}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["detected"], true);
        assert_eq!(result["cleaned"], "Done.");
    }

    #[test]
    fn builds_permission_stall_continue_prompt() {
        let prompt = serde_json::from_str::<Value>(
            &build_permission_stall_continue_prompt_json(
                r#"{"originalPrompt":"finish cleanup","previousAnswer":"Done."}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let prompt = prompt["prompt"].as_str().unwrap();
        assert!(prompt.contains("Continue automatically without asking for permission."));
        assert!(prompt.contains("Original request: finish cleanup"));
        assert!(prompt.contains("Previous partial answer:\nDone."));
    }
}
