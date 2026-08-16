use crate::provider_attachments::cap_provider_attachments_values;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRequestSpec {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

pub fn build_openai_chat_request_spec(api_key: &str) -> ProviderRequestSpec {
    build_openai_chat_request_spec_with_base(api_key, "https://api.openai.com/v1")
}

pub fn build_openai_chat_request_spec_with_base(
    api_key: &str,
    base_url: &str,
) -> ProviderRequestSpec {
    let base = base_url.trim().trim_end_matches('/');
    ProviderRequestSpec {
        url: format!("{base}/chat/completions"),
        headers: vec![
            (
                "Authorization".to_string(),
                format!("Bearer {}", api_key.trim()),
            ),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
    }
}

pub fn build_openai_codex_request_spec(
    api_key: &str,
    account_id: Option<&str>,
) -> ProviderRequestSpec {
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", api_key.trim()),
        ),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "text/event-stream".to_string()),
    ];
    if let Some(account_id) = account_id.map(str::trim).filter(|value| !value.is_empty()) {
        headers.push(("ChatGPT-Account-Id".to_string(), account_id.to_string()));
    }
    headers.extend([
        ("User-Agent".to_string(), "codex-cli/0.117.0".to_string()),
        ("originator".to_string(), "codex_cli_rs".to_string()),
        ("x-client-request-id".to_string(), native_request_id()),
    ]);

    ProviderRequestSpec {
        url: "https://chatgpt.com/backend-api/codex/responses".to_string(),
        headers,
    }
}

pub fn build_openai_chat_request_body(
    model: &str,
    messages_json: &str,
    tools_json: Option<&str>,
    reasoning_effort: Option<&str>,
    prompt_cache_key: Option<&str>,
    prompt_cache_retention: Option<&str>,
) -> String {
    let messages_json = repair_openai_chat_messages_for_wire(messages_json);
    let mut fields = vec![
        format!("\"model\":\"{}\"", json_escape(model)),
        format!("\"messages\":{}", messages_json),
    ];
    if let Some(cache_key) = prompt_cache_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        fields.push(format!(
            "\"prompt_cache_key\":\"{}\"",
            json_escape(cache_key)
        ));
    }
    if let Some(retention) = prompt_cache_retention
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        fields.push(format!(
            "\"prompt_cache_retention\":\"{}\"",
            json_escape(retention)
        ));
    }
    if let Some(tools_json) = tools_json.map(str::trim).filter(|value| !value.is_empty()) {
        fields.push(format!("\"tools\":{tools_json}"));
    }
    if openai_chat_model_supports_tool_choice(model) {
        fields.push("\"tool_choice\":\"auto\"".to_string());
    }
    if let Some(effort) = normalize_reasoning_effort(reasoning_effort)
        .filter(|_| openai_chat_model_supports_reasoning(model))
    {
        fields.push(format!(
            "\"reasoning\":{{\"effort\":\"{}\"}}",
            json_escape(effort)
        ));
    }
    format!("{{{}}}", fields.join(","))
}

pub fn repair_openai_chat_messages_for_wire(messages_json: &str) -> String {
    if !openai_chat_messages_need_repair(messages_json) {
        return messages_json.trim().to_string();
    }

    repair_openai_chat_messages_json(messages_json)
        .unwrap_or_else(|_| messages_json.trim().to_string())
}

pub fn repair_openai_chat_messages_json(messages_json: &str) -> Result<String, String> {
    let messages: Value = serde_json::from_str(messages_json)
        .map_err(|error| format!("Invalid OpenAI messages JSON: {error}"))?;
    serde_json::to_string(&repair_openai_chat_messages(&messages))
        .map_err(|error| error.to_string())
}

pub fn build_openai_codex_request_body(
    model: &str,
    instructions: &str,
    input_json: &str,
    tools_json: &str,
    tool_choice: &str,
    reasoning_effort: Option<&str>,
    prompt_cache_key: Option<&str>,
    prompt_cache_retention: Option<&str>,
) -> String {
    let reasoning = if let Some(effort) = normalize_reasoning_effort(reasoning_effort) {
        format!(
            "\"reasoning\":{{\"effort\":\"{}\",\"summary\":\"auto\"}}",
            json_escape(effort)
        )
    } else {
        "\"reasoning\":{\"effort\":\"none\"}".to_string()
    };
    let include = if normalize_reasoning_effort(reasoning_effort).is_some() {
        "\"include\":[\"reasoning.encrypted_content\"]"
    } else {
        "\"include\":[]"
    };
    let prompt_cache = prompt_cache_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|cache_key| {
            let mut fields = vec![format!(
                "\"prompt_cache_key\":\"{}\"",
                json_escape(cache_key)
            )];
            if let Some(retention) = prompt_cache_retention
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                fields.push(format!(
                    "\"prompt_cache_retention\":\"{}\"",
                    json_escape(retention)
                ));
            }
            format!("{},", fields.join(","))
        })
        .unwrap_or_default();
    format!(
        "{{\"model\":\"{}\",\"instructions\":\"{}\",\"input\":{},\"tools\":{},\"tool_choice\":\"{}\",\"parallel_tool_calls\":true,{}{},\"store\":false,\"stream\":true,{},\"text\":{{\"format\":{{\"type\":\"text\"}},\"verbosity\":\"medium\"}}}}",
        json_escape(model),
        json_escape(instructions),
        input_json.trim(),
        tools_json.trim(),
        json_escape(tool_choice),
        prompt_cache,
        reasoning,
        include,
    )
}

pub fn resolve_runtime_reasoning_effort_json(reasoning_json: &str) -> Result<String, String> {
    let reasoning: Value = serde_json::from_str(reasoning_json)
        .map_err(|error| format!("Invalid runtime reasoning JSON: {error}"))?;
    let support = reasoning.get("support").and_then(Value::as_object);
    let support_status = support
        .and_then(|support| support.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("unsupported");
    let requested_effort = reasoning
        .get("effort")
        .and_then(Value::as_str)
        .unwrap_or("");
    let effort = if support_status == "supported" && requested_effort != "unsupported" {
        normalize_reasoning_effort(Some(requested_effort))
    } else {
        None
    };
    serde_json::to_string(&json!({
        "enabled": effort.is_some(),
        "effort": effort,
        "cliValue": effort.unwrap_or("-"),
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_provider_tool_policy_json(
    surface: &str,
    tools_json: &str,
) -> Result<String, String> {
    let tools_json = tools_json.trim();
    let tools_json = if tools_json.is_empty() {
        "[]"
    } else {
        tools_json
    };
    let tools: Value = serde_json::from_str(tools_json)
        .map_err(|error| format!("Invalid tool definitions JSON: {error}"))?;
    let tool_count = tools.as_array().map(Vec::len).unwrap_or(0);
    let has_tools = tool_count > 0;
    let surface = surface.trim();
    let include_tools = match surface {
        "openai-chat-live" | "gemini-live" => true,
        "openai-chat-query" | "gemini-query" => has_tools,
        "openai-codex-live" => true,
        _ => {
            return Err(format!(
                "Unsupported provider tool policy surface: {surface}"
            ))
        }
    };
    let tool_choice = match surface {
        "openai-codex-live" => {
            if has_tools {
                "auto"
            } else {
                "none"
            }
        }
        _ => "auto",
    };
    serde_json::to_string(&json!({
        "surface": surface,
        "toolCount": tool_count,
        "hasTools": has_tools,
        "includeTools": include_tools,
        "toolChoice": tool_choice,
    }))
    .map_err(|error| error.to_string())
}

pub fn tool_definitions_to_chat_tools_json(definitions_json: &str) -> Result<String, String> {
    let definitions: Value = serde_json::from_str(definitions_json)
        .map_err(|error| format!("Invalid tool definitions JSON: {error}"))?;
    let tools = definitions
        .as_array()
        .map(|definitions| {
            definitions
                .iter()
                .map(|definition| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": definition.get("name").and_then(Value::as_str).unwrap_or("tool"),
                            "description": definition.get("description").and_then(Value::as_str).unwrap_or(""),
                            "parameters": definition.get("input_schema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
                        }
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::to_string(&tools).map_err(|error| error.to_string())
}

pub fn provider_query_messages_to_openai_json(
    messages_json: &str,
    default_system_prompt: &str,
) -> Result<String, String> {
    let messages: Value = serde_json::from_str(messages_json)
        .map_err(|error| format!("Invalid provider query messages JSON: {error}"))?;
    let mut out = Vec::new();
    let mut saw_system = false;

    if let Some(messages) = messages.as_array() {
        for message in messages {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            match role {
                "system" => {
                    out.push(json!({ "role": "system", "content": content }));
                    saw_system = true;
                }
                "user" => {
                    out.push(json!({ "role": "user", "content": content }));
                }
                "assistant" => {
                    let tool_calls = message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_else(|| provider_tool_calls(message.get("toolCalls")));
                    let mut wire = json!({ "role": "assistant", "content": content });
                    if !tool_calls.is_empty() {
                        if let Some(object) = wire.as_object_mut() {
                            object.insert("tool_calls".to_string(), Value::Array(tool_calls));
                        }
                    }
                    out.push(wire);
                }
                "tool" => {
                    out.push(json!({
                        "role": "tool",
                        "content": content,
                        "tool_call_id": message
                            .get("callId")
                            .or_else(|| message.get("tool_call_id"))
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                    }));
                }
                _ => {}
            }
        }
    }

    if !saw_system && !default_system_prompt.trim().is_empty() {
        out.insert(
            0,
            json!({ "role": "system", "content": default_system_prompt }),
        );
    }

    serde_json::to_string(&out).map_err(|error| error.to_string())
}

fn openai_chat_messages_need_repair(messages_json: &str) -> bool {
    let Ok(messages) = serde_json::from_str::<Value>(messages_json) else {
        return false;
    };
    let Some(messages) = messages.as_array() else {
        return false;
    };
    let mut pending: Vec<String> = Vec::new();

    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if pending.is_empty() {
            if role == "tool" {
                return true;
            }
            pending = assistant_tool_call_ids(message);
            continue;
        }

        if role == "tool" {
            let Some(expected) = pending.first() else {
                return true;
            };
            let actual = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if actual != expected {
                return true;
            }
            pending.remove(0);
            continue;
        }

        return true;
    }

    !pending.is_empty()
}

fn repair_openai_chat_messages(messages: &Value) -> Vec<Value> {
    let Some(messages) = messages.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut pending: Vec<(String, String)> = Vec::new();

    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if pending.is_empty() {
            if role == "tool" {
                out.push(stale_tool_result_user_message(message));
                continue;
            }
            out.push(message.clone());
            pending = assistant_tool_calls_for_repair(message);
            continue;
        }

        if role == "tool" {
            let actual = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(index) = pending.iter().position(|(call_id, _)| call_id == actual) {
                for (missing_id, missing_name) in pending.drain(..index) {
                    out.push(synthetic_tool_message(&missing_id, &missing_name));
                }
                pending.remove(0);
                out.push(message.clone());
            } else {
                out.push(stale_tool_result_user_message(message));
            }
            continue;
        }

        flush_pending_tool_messages(&mut out, &mut pending);
        out.push(message.clone());
        pending = assistant_tool_calls_for_repair(message);
    }

    flush_pending_tool_messages(&mut out, &mut pending);
    out
}

fn assistant_tool_call_ids(message: &Value) -> Vec<String> {
    assistant_tool_calls_for_repair(message)
        .into_iter()
        .map(|(call_id, _)| call_id)
        .collect()
}

fn assistant_tool_calls_for_repair(message: &Value) -> Vec<(String, String)> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .map(|(index, call)| {
                    let function = call.get("function").unwrap_or(&Value::Null);
                    let call_id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("call_missing_{index}"));
                    let name = function
                        .get("name")
                        .or_else(|| call.get("name"))
                        .and_then(Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or("tool")
                        .to_string();
                    (call_id, name)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn flush_pending_tool_messages(out: &mut Vec<Value>, pending: &mut Vec<(String, String)>) {
    for (call_id, name) in pending.drain(..) {
        out.push(synthetic_tool_message(&call_id, &name));
    }
}

fn synthetic_tool_message(call_id: &str, name: &str) -> Value {
    json!({
        "role": "tool",
        "tool_call_id": call_id,
        "content": format!("Tool call `{name}` was not executed; the user or runtime rejected or skipped it.")
    })
}

fn stale_tool_result_user_message(message: &Value) -> Value {
    let call_id = message
        .get("tool_call_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let content = message_content_as_text(message.get("content"));
    json!({
        "role": "user",
        "content": format!(
            "<stale-tool-result id=\"{}\" is-error=\"true\">\n{}\n</stale-tool-result>",
            xml_escape(call_id),
            content
        )
    })
}

fn message_content_as_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.to_string(),
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn build_openai_user_message_json(
    prompt: &str,
    attachments_json: &str,
) -> Result<String, String> {
    let attachments: Value = serde_json::from_str(attachments_json)
        .map_err(|error| format!("Invalid OpenAI attachments JSON: {error}"))?;
    let capped_attachments = attachments
        .as_array()
        .map(|attachments| cap_provider_attachments_values(attachments))
        .unwrap_or_default();
    let content = (!capped_attachments.is_empty())
        .then_some(capped_attachments.as_slice())
        .map(|attachments| {
            let mut parts = vec![json!({ "type": "text", "text": prompt })];
            for attachment in attachments {
                let data_url = attachment
                    .get("dataUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if data_url.is_empty() {
                    continue;
                }
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": data_url }
                }));
            }
            Value::Array(parts)
        })
        .unwrap_or_else(|| Value::String(prompt.to_string()));

    serde_json::to_string(&json!({
        "role": "user",
        "content": content
    }))
    .map_err(|error| error.to_string())
}

pub fn build_openai_assistant_message_json(
    content: &str,
    tool_calls_json: &str,
) -> Result<String, String> {
    let tool_calls: Value = serde_json::from_str(tool_calls_json)
        .map_err(|error| format!("Invalid OpenAI tool calls JSON: {error}"))?;
    let mut message = json!({
        "role": "assistant",
        "content": content
    });
    if let Some(calls) = tool_calls.as_array().filter(|calls| !calls.is_empty()) {
        message["tool_calls"] = Value::Array(calls.clone());
    }
    serde_json::to_string(&message).map_err(|error| error.to_string())
}

pub fn build_openai_tool_message_json(tool_call_id: &str, content: &str) -> Result<String, String> {
    serde_json::to_string(&json!({
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": content
    }))
    .map_err(|error| error.to_string())
}

fn provider_tool_calls(tool_calls: Option<&Value>) -> Vec<Value> {
    tool_calls
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.get("callId").and_then(Value::as_str).unwrap_or("tool"),
                        "type": "function",
                        "function": {
                            "name": call.get("name").and_then(Value::as_str).unwrap_or("tool"),
                            "arguments": call.get("argumentsJson").and_then(Value::as_str).unwrap_or("{}")
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_reasoning_effort(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")
}

fn openai_chat_model_supports_reasoning(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    !(normalized.contains("kimi")
        || normalized.contains("moonshot")
        || normalized.contains("deepseek")
        || normalized.starts_with("glm-"))
}

fn openai_chat_model_supports_tool_choice(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    !(normalized.contains("deepseek") || normalized.contains("mistral"))
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0C}' => escaped.push_str("\\f"),
            ch if ch.is_control() => escaped.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => escaped.push(ch),
        }
    }
    escaped
}

fn native_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("uc-rs-{}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_openai_chat_request_spec() {
        let spec = build_openai_chat_request_spec(" sk-test ");
        assert_eq!(spec.url, "https://api.openai.com/v1/chat/completions");
        assert!(spec
            .headers
            .contains(&("Authorization".to_string(), "Bearer sk-test".to_string())));
        assert!(spec
            .headers
            .contains(&("Content-Type".to_string(), "application/json".to_string())));
    }

    #[test]
    fn builds_openai_codex_request_spec_with_account_and_native_request_id() {
        let spec = build_openai_codex_request_spec("token", Some("acct_123"));
        assert_eq!(spec.url, "https://chatgpt.com/backend-api/codex/responses");
        assert!(spec
            .headers
            .contains(&("ChatGPT-Account-Id".to_string(), "acct_123".to_string())));
        assert!(spec
            .headers
            .contains(&("Accept".to_string(), "text/event-stream".to_string())));
        assert!(spec
            .headers
            .iter()
            .any(|(key, value)| key == "x-client-request-id" && value.starts_with("uc-rs-")));
    }

    #[test]
    fn builds_openai_chat_request_body_with_optional_tools_and_reasoning() {
        let body = build_openai_chat_request_body(
            "gpt-5.4",
            r#"[{"role":"user","content":"hi"}]"#,
            Some(r#"[{"type":"function","function":{"name":"run","parameters":{}}}]"#),
            Some("high"),
            Some("unclecode-cache"),
            Some("24h"),
        );
        assert_eq!(
            body,
            r#"{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}],"prompt_cache_key":"unclecode-cache","prompt_cache_retention":"24h","tools":[{"type":"function","function":{"name":"run","parameters":{}}}],"tool_choice":"auto","reasoning":{"effort":"high"}}"#
        );
    }

    #[test]
    fn repairs_partial_openai_tool_results_for_strict_backends() {
        let body = build_openai_chat_request_body(
            "moonshotai/kimi-k2-instruct",
            r#"[
                {"role":"user","content":"run checks"},
                {"role":"assistant","content":"","tool_calls":[
                    {"id":"call-a","type":"function","function":{"name":"shell","arguments":"{\"cmd\":\"a\"}"}},
                    {"id":"call-b","type":"function","function":{"name":"shell","arguments":"{\"cmd\":\"b\"}"}}
                ]},
                {"role":"tool","tool_call_id":"call-a","content":"ok"},
                {"role":"user","content":"continue"}
            ]"#,
            None,
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&body).unwrap();
        let messages = parsed["messages"].as_array().unwrap();

        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[2]["tool_call_id"], "call-a");
        assert_eq!(messages[3]["role"], "tool");
        assert_eq!(messages[3]["tool_call_id"], "call-b");
        assert!(messages[3]["content"]
            .as_str()
            .unwrap()
            .contains("was not executed"));
        assert_eq!(messages[4]["role"], "user");
        assert_eq!(messages[4]["content"], "continue");
    }

    #[test]
    fn applies_reduced_compat_policy_to_chat_request_body() {
        let kimi = build_openai_chat_request_body(
            "moonshotai/kimi-k2-instruct",
            r#"[{"role":"user","content":"hi"}]"#,
            None,
            Some("high"),
            None,
            None,
        );
        assert!(!kimi.contains(r#""reasoning""#));
        assert!(kimi.contains(r#""tool_choice":"auto""#));

        let deepseek = build_openai_chat_request_body(
            "deepseek-r1:8b",
            r#"[{"role":"user","content":"hi"}]"#,
            None,
            Some("high"),
            None,
            None,
        );
        assert!(!deepseek.contains(r#""reasoning""#));
        assert!(!deepseek.contains(r#""tool_choice":"auto""#));
    }

    #[test]
    fn downgrades_orphan_openai_tool_results_to_user_context() {
        let repaired = repair_openai_chat_messages_json(
            r#"[
                {"role":"user","content":"hi"},
                {"role":"tool","tool_call_id":"call-old","content":"late result"}
            ]"#,
        )
        .unwrap();
        let messages: Value = serde_json::from_str(&repaired).unwrap();
        let messages = messages.as_array().unwrap();

        assert_eq!(messages[1]["role"], "user");
        assert!(messages[1]["content"]
            .as_str()
            .unwrap()
            .contains("<stale-tool-result id=\"call-old\""));
    }

    #[test]
    fn builds_openai_codex_request_body_with_reasoning_contract() {
        let body = build_openai_codex_request_body(
            "gpt-5.4",
            "System\nPrompt",
            r#"[{"type":"message","role":"user","content":[]}]"#,
            "[]",
            "none",
            Some("medium"),
            Some("unclecode-cache"),
            Some("24h"),
        );
        assert!(body.contains(r#""instructions":"System\nPrompt""#));
        assert!(body.contains(r#""tool_choice":"none""#));
        assert!(body.contains(r#""parallel_tool_calls":true"#));
        assert!(body.contains(r#""reasoning":{"effort":"medium","summary":"auto"}"#));
        assert!(body.contains(r#""include":["reasoning.encrypted_content"]"#));
        assert!(body.contains(r#""prompt_cache_key":"unclecode-cache""#));
        assert!(body.contains(r#""prompt_cache_retention":"24h""#));
        assert!(body.contains(r#""store":false"#));
        assert!(body.contains(r#""stream":true"#));
    }

    #[test]
    fn resolves_runtime_reasoning_effort_contract() {
        let enabled: serde_json::Value = serde_json::from_str(
            &resolve_runtime_reasoning_effort_json(
                r#"{"effort":"high","source":"mode-default","support":{"status":"supported","defaultEffort":"medium","supportedEfforts":["low","medium","high"]}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(enabled["enabled"], true);
        assert_eq!(enabled["effort"], "high");
        assert_eq!(enabled["cliValue"], "high");

        let disabled: serde_json::Value = serde_json::from_str(
            &resolve_runtime_reasoning_effort_json(
                r#"{"effort":"unsupported","source":"model-capability","support":{"status":"unsupported","supportedEfforts":[]}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(disabled["enabled"], false);
        assert!(disabled["effort"].is_null());
        assert_eq!(disabled["cliValue"], "-");
    }

    #[test]
    fn resolves_provider_tool_policy_by_surface() {
        let tools = r#"[{"name":"run"}]"#;
        let live: serde_json::Value = serde_json::from_str(
            &resolve_provider_tool_policy_json("openai-chat-live", "[]").unwrap(),
        )
        .unwrap();
        assert_eq!(live["includeTools"], true);
        assert_eq!(live["toolChoice"], "auto");

        let query: serde_json::Value = serde_json::from_str(
            &resolve_provider_tool_policy_json("openai-chat-query", "[]").unwrap(),
        )
        .unwrap();
        assert_eq!(query["includeTools"], false);
        assert_eq!(query["hasTools"], false);

        let codex: serde_json::Value = serde_json::from_str(
            &resolve_provider_tool_policy_json("openai-codex-live", tools).unwrap(),
        )
        .unwrap();
        assert_eq!(codex["includeTools"], true);
        assert_eq!(codex["toolChoice"], "auto");

        let codex_without_tools: serde_json::Value = serde_json::from_str(
            &resolve_provider_tool_policy_json("openai-codex-live", "[]").unwrap(),
        )
        .unwrap();
        assert_eq!(codex_without_tools["toolChoice"], "none");

        assert!(resolve_provider_tool_policy_json("unknown", "[]").is_err());
    }

    #[test]
    fn converts_tool_definitions_to_chat_tools() {
        let tools = tool_definitions_to_chat_tools_json(
            r#"[{"name":"run","description":"Run command","input_schema":{"type":"object","properties":{"cmd":{"type":"string"}}}}]"#,
        )
        .unwrap();
        assert_eq!(
            tools,
            r#"[{"function":{"description":"Run command","name":"run","parameters":{"properties":{"cmd":{"type":"string"}},"type":"object"}},"type":"function"}]"#
        );
    }

    #[test]
    fn converts_provider_query_messages_to_openai_messages() {
        let messages = provider_query_messages_to_openai_json(
            r#"[
                {"role":"user","content":"hi"},
                {"role":"assistant","content":"calling","toolCalls":[{"callId":"call-1","name":"weather","argumentsJson":"{\"city\":\"Seoul\"}"}]},
                {"role":"tool","callId":"call-1","content":"sunny"}
            ]"#,
            "system prompt",
        )
        .unwrap();
        assert_eq!(
            messages,
            r#"[{"content":"system prompt","role":"system"},{"content":"hi","role":"user"},{"content":"calling","role":"assistant","tool_calls":[{"function":{"arguments":"{\"city\":\"Seoul\"}","name":"weather"},"id":"call-1","type":"function"}]},{"content":"sunny","role":"tool","tool_call_id":"call-1"}]"#
        );
    }

    #[test]
    fn builds_openai_user_message_with_image_attachments() {
        let output = build_openai_user_message_json(
            "inspect",
            r#"[{"dataUrl":"data:image/png;base64,AAAA"},{"dataUrl":""}]"#,
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"content":[{"text":"inspect","type":"text"},{"image_url":{"url":"data:image/png;base64,AAAA"},"type":"image_url"}],"role":"user"}"#
        );
    }

    #[test]
    fn builds_openai_assistant_and_tool_messages() {
        let assistant = build_openai_assistant_message_json(
            "working",
            r#"[{"id":"call_1","function":{"name":"run_shell","arguments":"{}"}}]"#,
        )
        .unwrap();
        let tool = build_openai_tool_message_json("call_1", "ok").unwrap();

        assert_eq!(
            assistant,
            r#"{"content":"working","role":"assistant","tool_calls":[{"function":{"arguments":"{}","name":"run_shell"},"id":"call_1"}]}"#
        );
        assert_eq!(
            tool,
            r#"{"content":"ok","role":"tool","tool_call_id":"call_1"}"#
        );
    }
}
