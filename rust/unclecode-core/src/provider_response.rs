use crate::model_pricing::estimate_cost_usd;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenAIChatResponseRecord {
    Content(String),
    Reasoning(String),
    ToolCall {
        id: String,
        name: String,
        arguments_json: String,
    },
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
    },
}

pub fn parse_openai_chat_response_records(
    raw: &str,
) -> Result<Vec<OpenAIChatResponseRecord>, String> {
    parse_openai_chat_response_records_for_model(raw, None)
}

pub fn parse_openai_chat_response_records_for_model(
    raw: &str,
    model: Option<&str>,
) -> Result<Vec<OpenAIChatResponseRecord>, String> {
    if raw.trim_start().starts_with("data:") {
        return parse_openai_chat_sse_response_records(raw, model);
    }

    let payload: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid OpenAI chat response JSON: {error}"))?;
    let message = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .unwrap_or(&Value::Null);

    let mut records = Vec::new();
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        push_openai_content_records(&mut records, content, model);
    }
    if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
        if !reasoning.is_empty() {
            records.push(OpenAIChatResponseRecord::Reasoning(reasoning.to_string()));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for tool_call in tool_calls {
            let function = tool_call.get("function").unwrap_or(&Value::Null);
            records.push(OpenAIChatResponseRecord::ToolCall {
                id: tool_call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                name: function
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                arguments_json: function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_string(),
            });
        }
    }

    let usage = payload.get("usage").unwrap_or(&Value::Null);
    records.push(OpenAIChatResponseRecord::Usage {
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_tokens: usage
            .get("prompt_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .or_else(|| usage.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    });

    Ok(records)
}

fn push_openai_content_records(
    records: &mut Vec<OpenAIChatResponseRecord>,
    content: &str,
    model: Option<&str>,
) {
    let cleaned = strip_deepseek_chat_template_tokens(content);
    if !model_may_leak_kimi_tool_calls(model) {
        records.push(OpenAIChatResponseRecord::Content(cleaned));
        return;
    }

    let (visible, healed_tool_calls) = heal_kimi_tool_calls_from_content(&cleaned);
    if !visible.is_empty() {
        records.push(OpenAIChatResponseRecord::Content(visible));
    }
    records.extend(
        healed_tool_calls
            .into_iter()
            .map(|call| OpenAIChatResponseRecord::ToolCall {
                id: call.id,
                name: call.name,
                arguments_json: call.arguments_json,
            }),
    );
}

pub fn is_openai_chat_stream_progress_chunk_json(chunk_json: &str) -> Result<String, String> {
    let payload: Value = serde_json::from_str(chunk_json)
        .map_err(|error| format!("Invalid OpenAI chat stream chunk JSON: {error}"))?;
    serde_json::to_string(&json!({
        "progress": is_openai_chat_stream_progress_chunk(&payload)
    }))
    .map_err(|error| error.to_string())
}

pub fn parse_openai_chat_response_json(raw: &str) -> Result<String, String> {
    parse_openai_chat_response_json_for_model(raw, None)
}

pub fn parse_openai_chat_response_json_for_model(
    raw: &str,
    model: Option<&str>,
) -> Result<String, String> {
    let records = parse_openai_chat_response_records_for_model(raw, model)?;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    let mut actions = Vec::new();
    let mut prompt_tokens = 0;
    let mut completion_tokens = 0;
    let mut cache_read_tokens = 0;

    for record in records {
        match record {
            OpenAIChatResponseRecord::Content(value) => content.push_str(&value),
            OpenAIChatResponseRecord::Reasoning(value) => reasoning.push_str(&value),
            OpenAIChatResponseRecord::ToolCall {
                id,
                name,
                arguments_json,
            } => {
                let tool = name.trim();
                tool_calls.push(json!({
                    "id": id,
                    "name": name,
                    "argumentsJson": arguments_json
                }));
                if !tool.is_empty() {
                    actions.push(json!({
                        "callId": if id.trim().is_empty() { tool } else { id.trim() },
                        "tool": tool,
                        "input": parse_tool_input(&arguments_json),
                    }));
                }
            }
            OpenAIChatResponseRecord::Usage {
                prompt_tokens: prompt,
                completion_tokens: completion,
                cache_read_tokens: cached,
            } => {
                prompt_tokens = prompt;
                completion_tokens = completion;
                cache_read_tokens = cached;
            }
        }
    }

    serde_json::to_string(&json!({
        "content": content,
        "reasoning": reasoning,
        "toolCalls": tool_calls,
        "actions": actions,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "cacheReadTokens": cache_read_tokens,
        "costUsd": model
            .map(|model| estimate_cost_usd(model, prompt_tokens as f64, completion_tokens as f64))
            .unwrap_or(0.0)
    }))
    .map_err(|error| error.to_string())
}

#[derive(Debug, Default)]
struct StreamToolCall {
    id: String,
    name: String,
    arguments_json: String,
}

fn parse_openai_chat_sse_response_records(
    raw: &str,
    model: Option<&str>,
) -> Result<Vec<OpenAIChatResponseRecord>, String> {
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: BTreeMap<usize, StreamToolCall> = BTreeMap::new();
    let mut prompt_tokens = 0;
    let mut completion_tokens = 0;
    let mut cache_read_tokens = 0;

    for data in openai_sse_data_blocks(raw) {
        if data == "[DONE]" {
            continue;
        }
        let payload: Value = serde_json::from_str(&data)
            .map_err(|error| format!("Invalid OpenAI chat SSE JSON: {error}"))?;
        let usage = payload.get("usage").unwrap_or(&Value::Null);
        prompt_tokens = usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(prompt_tokens);
        completion_tokens = usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(completion_tokens);
        cache_read_tokens = usage
            .get("prompt_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .or_else(|| usage.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(cache_read_tokens);
        if !is_openai_chat_stream_progress_chunk(&payload) {
            continue;
        }

        for choice in payload
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let delta = choice.get("delta").unwrap_or(&Value::Null);
            if let Some(value) = delta.get("content").and_then(Value::as_str) {
                let cleaned = strip_deepseek_chat_template_tokens(value);
                if model_may_leak_kimi_tool_calls(model) {
                    let (visible, healed_tool_calls) = heal_kimi_tool_calls_from_content(&cleaned);
                    content.push_str(&visible);
                    for healed in healed_tool_calls {
                        let index = tool_calls.len();
                        tool_calls.insert(index, healed);
                    }
                } else {
                    content.push_str(&cleaned);
                }
            }
            if let Some(value) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
            {
                reasoning.push_str(value);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|index| index as usize)
                        .unwrap_or_else(|| tool_calls.len());
                    let entry = tool_calls.entry(index).or_default();
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        entry.id.push_str(id);
                    }
                    let function = call.get("function").unwrap_or(&Value::Null);
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        entry.name.push_str(name);
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        entry.arguments_json.push_str(arguments);
                    }
                }
            }
        }
    }

    let mut records = Vec::new();
    if !content.is_empty() {
        records.push(OpenAIChatResponseRecord::Content(content));
    }
    if !reasoning.is_empty() {
        records.push(OpenAIChatResponseRecord::Reasoning(reasoning));
    }
    for (index, call) in tool_calls {
        if call.name.trim().is_empty() {
            continue;
        }
        records.push(OpenAIChatResponseRecord::ToolCall {
            id: if call.id.trim().is_empty() {
                format!("call_stream_{index}")
            } else {
                call.id
            },
            name: call.name,
            arguments_json: if call.arguments_json.trim().is_empty() {
                "{}".to_string()
            } else {
                call.arguments_json
            },
        });
    }
    records.push(OpenAIChatResponseRecord::Usage {
        prompt_tokens,
        completion_tokens,
        cache_read_tokens,
    });
    Ok(records)
}

fn openai_sse_data_blocks(raw: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            if !current.is_empty() {
                blocks.push(current.trim().to_string());
                current.clear();
            }
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(data.trim_start());
        }
    }
    if !current.is_empty() {
        blocks.push(current.trim().to_string());
    }
    blocks
}

fn is_openai_chat_stream_progress_chunk(payload: &Value) -> bool {
    if payload.get("usage").is_some_and(|usage| !usage.is_null()) {
        return true;
    }
    payload
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                let delta = choice.get("delta").unwrap_or(&Value::Null);
                non_empty_str(delta.get("content"))
                    || non_empty_str(delta.get("reasoning_content"))
                    || non_empty_str(delta.get("reasoning"))
                    || delta
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| {
                            calls.iter().any(|call| {
                                non_empty_str(call.get("id"))
                                    || non_empty_str(
                                        call.get("function")
                                            .and_then(|function| function.get("name")),
                                    )
                                    || non_empty_str(
                                        call.get("function")
                                            .and_then(|function| function.get("arguments")),
                                    )
                            })
                        })
            })
        })
}

fn non_empty_str(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

fn model_may_leak_kimi_tool_calls(model: Option<&str>) -> bool {
    model
        .unwrap_or_default()
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|part| part == "kimi" || part == "k2")
}

fn heal_kimi_tool_calls_from_content(content: &str) -> (String, Vec<StreamToolCall>) {
    const SECTION_BEGIN: &str = "<|tool_calls_section_begin|>";
    const SECTION_END: &str = "<|tool_calls_section_end|>";
    const CALL_BEGIN: &str = "<|tool_call_begin|>";
    const ARG_BEGIN: &str = "<|tool_call_argument_begin|>";
    const CALL_END: &str = "<|tool_call_end|>";

    let mut visible = String::new();
    let mut calls = Vec::new();
    let mut rest = content;
    while let Some(section_start) = rest.find(SECTION_BEGIN) {
        visible.push_str(&rest[..section_start]);
        rest = &rest[section_start + SECTION_BEGIN.len()..];
        let Some(section_end) = rest.find(SECTION_END) else {
            visible.push_str(SECTION_BEGIN);
            visible.push_str(rest);
            return (visible, calls);
        };
        let section = &rest[..section_end];
        let mut call_rest = section;
        while let Some(call_start) = call_rest.find(CALL_BEGIN) {
            call_rest = &call_rest[call_start + CALL_BEGIN.len()..];
            let Some(arg_start) = call_rest.find(ARG_BEGIN) else {
                break;
            };
            let raw_name = call_rest[..arg_start].trim();
            call_rest = &call_rest[arg_start + ARG_BEGIN.len()..];
            let Some(call_end) = call_rest.find(CALL_END) else {
                break;
            };
            let arguments = call_rest[..call_end].trim();
            call_rest = &call_rest[call_end + CALL_END.len()..];
            let name = raw_name
                .lines()
                .filter_map(|line| line.trim().split_whitespace().last())
                .next_back()
                .unwrap_or("tool");
            calls.push(StreamToolCall {
                id: format!("call_kimi_{}", calls.len()),
                name: name.to_string(),
                arguments_json: if arguments.is_empty() {
                    "{}".to_string()
                } else {
                    arguments.to_string()
                },
            });
        }
        rest = &rest[section_end + SECTION_END.len()..];
    }
    visible.push_str(rest);
    (visible, calls)
}

fn strip_deepseek_chat_template_tokens(content: &str) -> String {
    let bar = '\u{ff5c}';
    let gap = '\u{2581}';
    [
        format!("<{bar}tool{gap}calls{gap}begin{bar}>"),
        format!("<{bar}tool{gap}call{gap}begin{bar}>"),
        format!("<{bar}tool{gap}call{gap}end{bar}>"),
        format!("<{bar}tool{gap}calls{gap}end{bar}>"),
        format!("<{bar}tool{gap}sep{bar}>"),
    ]
    .iter()
    .fold(content.to_string(), |text, token| text.replace(token, ""))
}

pub fn openai_tool_calls_to_actions_json(tool_calls_json: &str) -> Result<String, String> {
    let source = if tool_calls_json.trim().is_empty() {
        "[]"
    } else {
        tool_calls_json
    };
    let tool_calls = serde_json::from_str::<Value>(source)
        .map_err(|error| format!("Invalid OpenAI tool calls JSON: {error}"))?;
    let tool_calls = tool_calls
        .as_array()
        .ok_or("OpenAI tool calls JSON must be an array")?;

    let mut actions = Vec::new();
    for tool_call in tool_calls {
        let function = tool_call.get("function").unwrap_or(&Value::Null);
        let name = function
            .get("name")
            .or_else(|| tool_call.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            continue;
        }
        let id = tool_call
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let arguments_json = function
            .get("arguments")
            .or_else(|| tool_call.get("argumentsJson"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        actions.push(json!({
            "callId": if id.is_empty() { name } else { id },
            "tool": name,
            "input": parse_tool_input(arguments_json),
        }));
    }

    serde_json::to_string(&json!({ "actions": actions })).map_err(|error| error.to_string())
}

fn parse_tool_input(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_reasoning_tool_calls_and_usage() {
        let records = parse_openai_chat_response_records(
            r#"{
                "choices":[{"message":{
                    "content":"Hello",
                    "reasoning_content":"Thinking",
                    "tool_calls":[{"id":"call-1","function":{"name":"weather","arguments":"{\"city\":\"Seoul\"}"}}]
                }}],
                "usage":{"prompt_tokens":12,"completion_tokens":34,"prompt_tokens_details":{"cached_tokens":8}}
            }"#,
        )
        .unwrap();

        assert_eq!(
            records,
            vec![
                OpenAIChatResponseRecord::Content("Hello".to_string()),
                OpenAIChatResponseRecord::Reasoning("Thinking".to_string()),
                OpenAIChatResponseRecord::ToolCall {
                    id: "call-1".to_string(),
                    name: "weather".to_string(),
                    arguments_json: r#"{"city":"Seoul"}"#.to_string(),
                },
                OpenAIChatResponseRecord::Usage {
                    prompt_tokens: 12,
                    completion_tokens: 34,
                    cache_read_tokens: 8,
                },
            ]
        );
    }

    #[test]
    fn defaults_missing_optional_fields() {
        let records =
            parse_openai_chat_response_records(r#"{"choices":[{"message":{}}]}"#).unwrap();
        assert_eq!(
            records,
            vec![OpenAIChatResponseRecord::Usage {
                prompt_tokens: 0,
                completion_tokens: 0,
                cache_read_tokens: 0,
            }]
        );
    }

    #[test]
    fn parses_openai_chat_sse_and_ignores_role_only_keepalives() {
        let records = parse_openai_chat_response_records_for_model(
            r#"data: {"choices":[{"delta":{"role":"assistant"}}]}

data: {"choices":[{"delta":{"content":"Hel"}}]}

data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"weather","arguments":"{\"city\":"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Seoul\"}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2}}}

data: [DONE]
"#,
            Some("gpt-5.4"),
        )
        .unwrap();

        assert_eq!(
            records,
            vec![
                OpenAIChatResponseRecord::Content("Hello".to_string()),
                OpenAIChatResponseRecord::ToolCall {
                    id: "call-1".to_string(),
                    name: "weather".to_string(),
                    arguments_json: r#"{"city":"Seoul"}"#.to_string(),
                },
                OpenAIChatResponseRecord::Usage {
                    prompt_tokens: 3,
                    completion_tokens: 4,
                    cache_read_tokens: 2,
                },
            ]
        );
    }

    #[test]
    fn heals_kimi_chat_template_tool_calls_from_sse_content() {
        let parsed = parse_openai_chat_response_json_for_model(
            r#"data: {"choices":[{"delta":{"content":"<|tool_calls_section_begin|><|tool_call_begin|>weather<|tool_call_argument_begin|>{\"city\":\"Seoul\"}<|tool_call_end|><|tool_calls_section_end|>"}}]}

data: [DONE]
"#,
            Some("moonshotai/kimi-k2-instruct"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&parsed).unwrap();

        assert_eq!(parsed["content"], "");
        assert_eq!(parsed["toolCalls"][0]["name"], "weather");
        assert_eq!(
            parsed["toolCalls"][0]["argumentsJson"],
            r#"{"city":"Seoul"}"#
        );
        assert_eq!(parsed["actions"][0]["tool"], "weather");
    }

    #[test]
    fn heals_kimi_chat_template_tool_calls_from_json_content() {
        let parsed = parse_openai_chat_response_json_for_model(
            r#"{
                "choices":[{"message":{
                    "content":"<|tool_calls_section_begin|><|tool_call_begin|>run_shell<|tool_call_argument_begin|>{\"command\":\"printf ok\"}<|tool_call_end|><|tool_calls_section_end|>"
                }}],
                "usage":{"prompt_tokens":3,"completion_tokens":4}
            }"#,
            Some("moonshotai/kimi-k2-instruct"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&parsed).unwrap();

        assert_eq!(parsed["content"], "");
        assert_eq!(parsed["toolCalls"][0]["name"], "run_shell");
        assert_eq!(
            parsed["toolCalls"][0]["argumentsJson"],
            r#"{"command":"printf ok"}"#
        );
        assert_eq!(parsed["actions"][0]["tool"], "run_shell");
        assert_eq!(parsed["actions"][0]["input"]["command"], "printf ok");
    }

    #[test]
    fn reports_progress_only_for_meaningful_chat_stream_chunks() {
        let keepalive: Value = serde_json::from_str(
            &is_openai_chat_stream_progress_chunk_json(
                r#"{"choices":[{"delta":{"role":"assistant"}}]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(keepalive["progress"], false);

        let content: Value = serde_json::from_str(
            &is_openai_chat_stream_progress_chunk_json(
                r#"{"choices":[{"delta":{"reasoning_content":"thinking"}}]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(content["progress"], true);
    }

    #[test]
    fn parses_openai_chat_response_json_envelope() {
        let raw = parse_openai_chat_response_json_for_model(
            r#"{
                "choices":[{"message":{
                    "content":"Hello",
                    "reasoning_content":"Thinking",
                    "tool_calls":[{"id":"call-1","function":{"name":"weather","arguments":"{\"city\":\"Seoul\"}"}}]
                }}],
                "usage":{"prompt_tokens":12,"completion_tokens":34}
            }"#,
            Some("gpt-5.6-sol"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(parsed["content"], "Hello");
        assert_eq!(parsed["reasoning"], "Thinking");
        assert_eq!(parsed["toolCalls"][0]["id"], "call-1");
        assert_eq!(
            parsed["toolCalls"][0]["argumentsJson"],
            r#"{"city":"Seoul"}"#
        );
        assert_eq!(parsed["actions"][0]["callId"], "call-1");
        assert_eq!(parsed["actions"][0]["input"]["city"], "Seoul");
        assert_eq!(parsed["promptTokens"], 12);
        assert_eq!(parsed["completionTokens"], 34);
        assert!(parsed["costUsd"].as_f64().unwrap_or(0.0) > 0.0);
    }

    #[test]
    fn openai_chat_response_json_defaults_cost_to_zero_without_model() {
        let raw = parse_openai_chat_response_json(
            r#"{
                "choices":[{"message":{"content":"Hello"}}],
                "usage":{"prompt_tokens":12,"completion_tokens":34}
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(parsed["costUsd"], 0.0);
    }

    #[test]
    fn converts_openai_tool_calls_to_actions() {
        let raw = openai_tool_calls_to_actions_json(
            r#"[
                {"id":"call-1","function":{"name":"weather","arguments":"{\"city\":\"Seoul\"}"}},
                {"id":"","name":"fallback","argumentsJson":"not-json"},
                {"id":"ignored","function":{"name":"","arguments":"{}"}}
            ]"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(parsed["actions"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["actions"][0]["callId"], "call-1");
        assert_eq!(parsed["actions"][0]["input"]["city"], "Seoul");
        assert_eq!(parsed["actions"][1]["callId"], "fallback");
        assert_eq!(parsed["actions"][1]["input"], json!({}));
    }
}
