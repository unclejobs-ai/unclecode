use serde_json::{json, Value};
use std::collections::HashMap;

use crate::provider_trace::provider_reasoning_delta_trace_with_item_id_json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponsesSseRecord {
    ResponseId(String),
    ReasoningDelta {
        kind: String,
        item_id: String,
        delta: String,
    },
    TextBlock {
        text: String,
    },
    ReasoningBlock {
        item_id: String,
        summary: String,
        text: String,
    },
    ToolUseBlock {
        id: String,
        name: String,
        input_json: String,
    },
}

pub fn parse_sse_data_blocks(input: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = Vec::new();

    for raw_line in input.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            flush_block(&mut blocks, &mut current);
            continue;
        }

        if let Some(data) = line.strip_prefix("data:") {
            let trimmed = data.trim();
            if !trimmed.is_empty() {
                current.push(trimmed.to_string());
            }
        }
    }

    flush_block(&mut blocks, &mut current);
    blocks
}

pub fn parse_responses_sse_records(input: &str) -> Vec<ResponsesSseRecord> {
    let mut records = Vec::new();
    let mut text_by_message_id: HashMap<String, String> = HashMap::new();
    let mut reasoning_summary_by_item_id: HashMap<String, String> = HashMap::new();
    let mut reasoning_text_by_item_id: HashMap<String, String> = HashMap::new();
    let mut fallback_counter = 0usize;

    for event in parse_sse_data_blocks(input) {
        let Some(event_type) = extract_json_string(&event, "type") else {
            continue;
        };

        match event_type.as_str() {
            "response.output_text.delta" => {
                let item_id = extract_json_string(&event, "item_id")
                    .unwrap_or_else(|| next_fallback_id("msg", &mut fallback_counter));
                let delta = extract_json_string(&event, "delta").unwrap_or_default();
                text_by_message_id
                    .entry(item_id)
                    .and_modify(|value| value.push_str(&delta))
                    .or_insert(delta);
            }
            "response.reasoning_summary_text.delta" => {
                let item_id = extract_json_string(&event, "item_id")
                    .unwrap_or_else(|| next_fallback_id("rsn", &mut fallback_counter));
                let delta = extract_json_string(&event, "delta").unwrap_or_default();
                reasoning_summary_by_item_id
                    .entry(item_id.clone())
                    .and_modify(|value| value.push_str(&delta))
                    .or_insert(delta.clone());
                if !delta.is_empty() {
                    records.push(ResponsesSseRecord::ReasoningDelta {
                        kind: "summary".to_string(),
                        item_id,
                        delta,
                    });
                }
            }
            "response.reasoning_text.delta" => {
                let item_id = extract_json_string(&event, "item_id")
                    .unwrap_or_else(|| next_fallback_id("rsn", &mut fallback_counter));
                let delta = extract_json_string(&event, "delta").unwrap_or_default();
                reasoning_text_by_item_id
                    .entry(item_id.clone())
                    .and_modify(|value| value.push_str(&delta))
                    .or_insert(delta.clone());
                if !delta.is_empty() {
                    records.push(ResponsesSseRecord::ReasoningDelta {
                        kind: "text".to_string(),
                        item_id,
                        delta,
                    });
                }
            }
            "response.completed" => {
                if let Some(response) = extract_json_object(&event, "response") {
                    if let Some(id) = extract_json_string(response, "id") {
                        records.push(ResponsesSseRecord::ResponseId(id));
                    }
                }
            }
            "response.output_item.done" => {
                let Some(item) = extract_json_object(&event, "item") else {
                    continue;
                };
                let item_type = extract_json_string(item, "type").unwrap_or_default();
                match item_type.as_str() {
                    "message" => {
                        if extract_json_string(item, "role").as_deref() != Some("assistant") {
                            continue;
                        }
                        let item_id = extract_json_string(item, "id");
                        let text_from_item =
                            extract_texts_from_array_field(item, "content").join("");
                        let text = if text_from_item.is_empty() {
                            item_id
                                .as_ref()
                                .and_then(|id| text_by_message_id.get(id))
                                .cloned()
                                .unwrap_or_default()
                        } else {
                            text_from_item
                        };
                        if !text.is_empty() {
                            records.push(ResponsesSseRecord::TextBlock { text });
                        }
                    }
                    "reasoning" => {
                        let item_id = extract_json_string(item, "id")
                            .unwrap_or_else(|| next_fallback_id("rsn", &mut fallback_counter));
                        let summary_from_item =
                            extract_texts_from_array_field(item, "summary").join("\n");
                        let text_from_item =
                            extract_texts_from_array_field(item, "content").join("\n");
                        let summary = if summary_from_item.is_empty() {
                            reasoning_summary_by_item_id
                                .get(&item_id)
                                .cloned()
                                .unwrap_or_default()
                        } else {
                            summary_from_item
                        };
                        let text = if text_from_item.is_empty() {
                            reasoning_text_by_item_id
                                .get(&item_id)
                                .cloned()
                                .unwrap_or_default()
                        } else {
                            text_from_item
                        };
                        if !summary.is_empty() || !text.is_empty() {
                            records.push(ResponsesSseRecord::ReasoningBlock {
                                item_id,
                                summary,
                                text,
                            });
                        }
                    }
                    "function_call" => {
                        let id = extract_json_string(item, "call_id")
                            .unwrap_or_else(|| next_fallback_id("toolu", &mut fallback_counter));
                        let name =
                            extract_json_string(item, "name").unwrap_or_else(|| "tool".to_string());
                        let arguments = extract_json_string(item, "arguments").unwrap_or_default();
                        let input_json =
                            crate::json_args::normalize_json_object_argument(&arguments)
                                .to_string();
                        records.push(ResponsesSseRecord::ToolUseBlock {
                            id,
                            name,
                            input_json,
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    records
}

pub fn parse_responses_sse_result_json(input: &str) -> Result<String, String> {
    let mut response_id = Value::Null;
    let mut content = Vec::new();
    let mut reasoning_deltas = Vec::new();

    for record in parse_responses_sse_records(input) {
        match record {
            ResponsesSseRecord::ResponseId(id) => {
                response_id = json!(id);
            }
            ResponsesSseRecord::ReasoningDelta {
                kind,
                item_id,
                delta,
            } => {
                reasoning_deltas.push(json!({
                    "kind": kind,
                    "itemId": item_id,
                    "delta": delta
                }));
            }
            ResponsesSseRecord::TextBlock { text } => {
                content.push(json!({
                    "type": "text",
                    "text": text
                }));
            }
            ResponsesSseRecord::ReasoningBlock {
                item_id,
                summary,
                text,
            } => {
                content.push(json!({
                    "type": "reasoning",
                    "itemId": item_id,
                    "summary": summary,
                    "text": text
                }));
            }
            ResponsesSseRecord::ToolUseBlock {
                id,
                name,
                input_json,
            } => {
                let input_value = serde_json::from_str::<Value>(&input_json)
                    .ok()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({}));
                content.push(json!({
                    "type": "tool_use",
                    "id": id,
                    "name": name,
                    "input": input_value
                }));
            }
        }
    }

    if content.is_empty() {
        content.push(json!({ "type": "text", "text": "" }));
    }

    serde_json::to_string(&json!({
        "responseId": response_id,
        "reasoningDeltas": reasoning_deltas,
        "content": content
    }))
    .map_err(|error| error.to_string())
}

pub fn parse_responses_sse_message_json(input: &str) -> Result<String, String> {
    let result_raw = parse_responses_sse_result_json(input)?;
    let result = serde_json::from_str::<Value>(&result_raw).map_err(|error| error.to_string())?;
    let message = responses_result_to_message(&result);

    serde_json::to_string(&json!({
        "responseId": result.get("responseId").cloned().unwrap_or(Value::Null),
        "reasoningDeltas": result.get("reasoningDeltas").cloned().unwrap_or_else(|| json!([])),
        "message": message
    }))
    .map_err(|error| error.to_string())
}

pub fn parse_responses_sse_provider_message_json(
    provider: &str,
    model: &str,
    input: &str,
) -> Result<String, String> {
    let result_raw = parse_responses_sse_result_json(input)?;
    let result = serde_json::from_str::<Value>(&result_raw).map_err(|error| error.to_string())?;
    let message = responses_result_to_message(&result);
    let actions = responses_result_to_actions(&result);
    let reasoning_traces = result
        .get("reasoningDeltas")
        .and_then(Value::as_array)
        .map(|deltas| {
            deltas
                .iter()
                .filter_map(|delta| {
                    let kind = delta.get("kind").and_then(Value::as_str)?;
                    let item_id = delta.get("itemId").and_then(Value::as_str)?;
                    let text = delta.get("delta").and_then(Value::as_str)?;
                    if text.is_empty() {
                        return None;
                    }
                    provider_reasoning_delta_trace_with_item_id_json(
                        provider, model, kind, item_id, text,
                    )
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    serde_json::to_string(&json!({
        "provider": provider,
        "responseId": result.get("responseId").cloned().unwrap_or(Value::Null),
        "message": message,
        "actions": actions,
        "traces": reasoning_traces
    }))
    .map_err(|error| error.to_string())
}

fn responses_result_to_message(result: &Value) -> Value {
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = content
        .iter()
        .filter_map(|item| {
            (item.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| item.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("");
    let tool_calls = content
        .iter()
        .filter_map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                return None;
            }
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let input = item.get("input").cloned().unwrap_or_else(|| json!({}));
            Some(json!({
                "id": id,
                "function": {
                    "name": name,
                    "arguments": serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string())
                }
            }))
        })
        .collect::<Vec<_>>();
    let mut message = json!({ "content": text });
    if !tool_calls.is_empty() {
        message["tool_calls"] = json!(tool_calls);
    }
    message
}

fn responses_result_to_actions(result: &Value) -> Vec<Value> {
    result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                return None;
            }
            let id = item.get("id").and_then(Value::as_str).unwrap_or("").trim();
            let tool = item.get("name").and_then(Value::as_str).unwrap_or("").trim();
            if id.is_empty() || tool.is_empty() {
                return None;
            }
            Some(json!({
                "callId": id,
                "tool": tool,
                "input": item.get("input").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({}))
            }))
        })
        .collect()
}

fn next_fallback_id(prefix: &str, counter: &mut usize) -> String {
    *counter += 1;
    format!("{prefix}_{counter}")
}

fn extract_json_object<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let start = json_value_start(raw, key)?;
    let rest = raw.get(start..)?;
    let offset = rest.find('{')?;
    let object_start = start + offset;
    let object_end = find_matching(raw, object_start, '{', '}')?;
    raw.get(object_start..=object_end)
}

fn extract_json_array<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let start = json_value_start(raw, key)?;
    let rest = raw.get(start..)?;
    let offset = rest.find('[')?;
    let array_start = start + offset;
    let array_end = find_matching(raw, array_start, '[', ']')?;
    raw.get(array_start..=array_end)
}

fn extract_texts_from_array_field(raw: &str, key: &str) -> Vec<String> {
    let Some(array) = extract_json_array(raw, key) else {
        return Vec::new();
    };
    extract_repeated_json_strings(array, "text")
}

fn extract_repeated_json_strings(raw: &str, key: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative_start) = raw
        .get(cursor..)
        .and_then(|slice| json_value_start(slice, key))
    {
        let start = cursor + relative_start;
        let Some((value, end)) = parse_json_string_at(raw, start) else {
            cursor = start.saturating_add(1);
            continue;
        };
        values.push(value);
        cursor = end;
    }
    values
}

fn extract_json_string(raw: &str, key: &str) -> Option<String> {
    parse_json_string_at(raw, json_value_start(raw, key)?).map(|(value, _)| value)
}

fn json_value_start(raw: &str, key: &str) -> Option<usize> {
    let needle = format!("\"{key}\"");
    let key_start = raw.find(&needle)?;
    let after_key = key_start + needle.len();
    let colon = raw.get(after_key..)?.find(':')? + after_key;
    let value_start = raw.get(colon + 1..)?.find(|ch: char| !ch.is_whitespace())? + colon + 1;
    Some(value_start)
}

fn parse_json_string_at(raw: &str, start: usize) -> Option<(String, usize)> {
    if raw.get(start..)?.chars().next()? != '"' {
        return None;
    }
    let mut output = String::new();
    let mut index = start + 1;
    while index < raw.len() {
        let ch = raw.get(index..)?.chars().next()?;
        match ch {
            '"' => return Some((output, index + ch.len_utf8())),
            '\\' => {
                index += ch.len_utf8();
                let escaped = raw.get(index..)?.chars().next()?;
                match escaped {
                    '"' => output.push('"'),
                    '\\' => output.push('\\'),
                    '/' => output.push('/'),
                    'b' => output.push('\u{0008}'),
                    'f' => output.push('\u{000c}'),
                    'n' => output.push('\n'),
                    'r' => output.push('\r'),
                    't' => output.push('\t'),
                    'u' => {
                        let escape_end = index + escaped.len_utf8() + 4;
                        let first =
                            parse_unicode_escape(raw.get(index + escaped.len_utf8()..escape_end)?)?;
                        index = escape_end;
                        if (0xD800..=0xDBFF).contains(&first) {
                            let rest = raw.get(index..)?;
                            if !rest.starts_with("\\u") {
                                return None;
                            }
                            let second_end = index + 6;
                            let second = parse_unicode_escape(raw.get(index + 2..second_end)?)?;
                            if !(0xDC00..=0xDFFF).contains(&second) {
                                return None;
                            }
                            let codepoint = 0x10000
                                + (((first as u32 - 0xD800) << 10) | (second as u32 - 0xDC00));
                            output.push(char::from_u32(codepoint)?);
                            index = second_end;
                            continue;
                        }
                        if (0xDC00..=0xDFFF).contains(&first) {
                            return None;
                        }
                        output.push(char::from_u32(first as u32)?);
                        continue;
                    }
                    _ => return None,
                }
            }
            _ => output.push(ch),
        }
        index += ch.len_utf8();
    }
    None
}

fn parse_unicode_escape(hex: &str) -> Option<u16> {
    if hex.len() != 4 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(hex, 16).ok()
}

fn find_matching(raw: &str, start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut escaped = false;
    let mut in_string = false;
    for (offset, ch) in raw.get(start..)?.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && in_string {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        if ch == open {
            depth += 1;
            continue;
        }
        if ch == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(start + offset);
            }
        }
    }
    None
}

fn flush_block(blocks: &mut Vec<String>, current: &mut Vec<String>) {
    if current.is_empty() {
        return;
    }
    blocks.push(current.join("\n"));
    current.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_data_blocks_from_responses_sse() {
        let input = [
            "event: response.output_text.delta",
            r#"data: {"type":"response.output_text.delta","delta":"he"}"#,
            r#"data: {"continuation":true}"#,
            "",
            ": keepalive",
            "",
            r#"data: {"type":"response.completed"}"#,
            "",
        ]
        .join("\n");

        assert_eq!(
            parse_sse_data_blocks(&input),
            vec![
                r#"{"type":"response.output_text.delta","delta":"he"}"#.to_string()
                    + "\n"
                    + r#"{"continuation":true}"#,
                r#"{"type":"response.completed"}"#.to_string(),
            ]
        );
    }

    #[test]
    fn flushes_last_block_without_trailing_blank_line() {
        assert_eq!(
            parse_sse_data_blocks(r#"data: {"ok":true}"#),
            vec![r#"{"ok":true}"#.to_string()]
        );
    }

    #[test]
    fn ignores_empty_data_lines_and_non_data_lines() {
        assert_eq!(
            parse_sse_data_blocks("event: ping\ndata:\n\ndata:   {\"ok\":true}   \n"),
            vec![r#"{"ok":true}"#.to_string()]
        );
    }

    #[test]
    fn parses_responses_text_tool_and_response_id_records() {
        let sse = [
            r#"data: {"type":"response.output_text.delta","item_id":"msg-1","delta":"Hel"}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"weather","arguments":"{\"city\":\"Seoul\"}"}}"#,
            "",
            r#"data: {"type":"response.completed","response":{"id":"resp-1"}}"#,
            "",
        ]
        .join("\n");

        assert_eq!(
            parse_responses_sse_records(&sse),
            vec![
                ResponsesSseRecord::TextBlock {
                    text: "Hello".to_string()
                },
                ResponsesSseRecord::ToolUseBlock {
                    id: "call-1".to_string(),
                    name: "weather".to_string(),
                    input_json: r#"{"city":"Seoul"}"#.to_string(),
                },
                ResponsesSseRecord::ResponseId("resp-1".to_string()),
            ]
        );
    }

    #[test]
    fn parses_responses_sse_result_json() {
        let sse = [
            r#"data: {"type":"response.reasoning_summary_text.delta","item_id":"rsn_1","delta":"thinking"}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"run_shell","arguments":"{\"command\":\"echo ok\"}"}}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
            "",
            r#"data: {"type":"response.completed","response":{"id":"resp_1"}}"#,
            "",
        ]
        .join("\n");
        let result: Value =
            serde_json::from_str(&parse_responses_sse_result_json(&sse).expect("json"))
                .expect("valid json");

        assert_eq!(result["responseId"], "resp_1");
        assert_eq!(result["reasoningDeltas"][0]["delta"], "thinking");
        assert_eq!(result["content"][0]["type"], "tool_use");
        assert_eq!(result["content"][0]["input"]["command"], "echo ok");
        assert_eq!(result["content"][1]["text"], "done");
    }

    #[test]
    fn parses_responses_sse_message_json() {
        let sse = [
            r#"data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"run_shell","arguments":"{\"command\":\"echo ok\"}"}}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
            "",
            r#"data: {"type":"response.completed","response":{"id":"resp_1"}}"#,
            "",
        ]
        .join("\n");
        let result: Value =
            serde_json::from_str(&parse_responses_sse_message_json(&sse).expect("json"))
                .expect("valid json");

        assert_eq!(result["responseId"], "resp_1");
        assert_eq!(result["message"]["content"], "done");
        assert_eq!(result["message"]["tool_calls"][0]["id"], "call_1");
        assert_eq!(
            result["message"]["tool_calls"][0]["function"]["arguments"],
            r#"{"command":"echo ok"}"#
        );
    }

    #[test]
    fn parses_responses_sse_provider_message_json_with_traces() {
        let sse = [
            r#"data: {"type":"response.reasoning_summary_text.delta","item_id":"rsn_1","delta":"thinking"}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"run_shell","arguments":"{\"command\":\"echo ok\"}"}}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
            "",
            r#"data: {"type":"response.completed","response":{"id":"resp_1"}}"#,
            "",
        ]
        .join("\n");
        let result: Value = serde_json::from_str(
            &parse_responses_sse_provider_message_json("openai", "gpt-5.4", &sse).expect("json"),
        )
        .expect("valid json");

        assert_eq!(result["provider"], "openai");
        assert_eq!(result["message"]["content"], "done");
        assert_eq!(result["actions"][0]["callId"], "call_1");
        assert_eq!(result["actions"][0]["tool"], "run_shell");
        assert_eq!(result["actions"][0]["input"]["command"], "echo ok");
        assert_eq!(result["traces"][0]["type"], "reasoning.delta");
        assert_eq!(result["traces"][0]["itemId"], "rsn_1");
        assert_eq!(result["traces"][0]["delta"], "thinking");
    }

    #[test]
    fn parses_reasoning_delta_and_done_fallback() {
        let sse = [
            r#"data: {"type":"response.reasoning_summary_text.delta","item_id":"rsn-1","delta":"plan"}"#,
            "",
            r#"data: {"type":"response.reasoning_text.delta","item_id":"rsn-1","delta":"detail"}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rsn-1","summary":[],"content":[]}}"#,
            "",
        ]
        .join("\n");

        assert_eq!(
            parse_responses_sse_records(&sse),
            vec![
                ResponsesSseRecord::ReasoningDelta {
                    kind: "summary".to_string(),
                    item_id: "rsn-1".to_string(),
                    delta: "plan".to_string(),
                },
                ResponsesSseRecord::ReasoningDelta {
                    kind: "text".to_string(),
                    item_id: "rsn-1".to_string(),
                    delta: "detail".to_string(),
                },
                ResponsesSseRecord::ReasoningBlock {
                    item_id: "rsn-1".to_string(),
                    summary: "plan".to_string(),
                    text: "detail".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parses_utf8_and_unicode_escaped_response_strings() {
        let sse = [
            r#"data: {"type":"response.output_item.done","item":{"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"한글 😀"}]}}"#,
            "",
            r#"data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"capture","arguments":"{\"text\":\"\uD55C\uAE00\"}"}}"#,
            "",
        ]
        .join("\n");

        assert_eq!(
            parse_responses_sse_records(&sse),
            vec![
                ResponsesSseRecord::TextBlock {
                    text: "한글 😀".to_string(),
                },
                ResponsesSseRecord::ToolUseBlock {
                    id: "call-1".to_string(),
                    name: "capture".to_string(),
                    input_json: r#"{"text":"한글"}"#.to_string(),
                },
            ]
        );
    }
}
