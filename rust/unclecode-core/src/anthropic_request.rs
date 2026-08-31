use crate::json_args::normalize_json_object_argument;
use crate::model_pricing::estimate_cost_usd;
use crate::provider_attachments::cap_provider_attachments_values;
use crate::provider_request::ProviderRequestSpec;
use serde_json::{json, Value};

const ANTHROPIC_CACHE_READ_MULTIPLIER: f64 = 0.1;
const ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER: f64 = 1.25;
const ANTHROPIC_CACHE_WRITE_1H_MULTIPLIER: f64 = 2.0;

pub fn build_anthropic_messages_request_spec(api_key: &str) -> ProviderRequestSpec {
    build_anthropic_messages_request_spec_with_base(api_key, "https://api.anthropic.com/v1")
}

pub fn build_anthropic_messages_request_spec_with_base(
    api_key: &str,
    base_url: &str,
) -> ProviderRequestSpec {
    let base = base_url.trim().trim_end_matches('/');
    ProviderRequestSpec {
        url: format!("{base}/messages"),
        headers: vec![
            ("x-api-key".to_string(), api_key.trim().to_string()),
            ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
    }
}

pub fn provider_query_messages_to_anthropic_json(
    messages_json: &str,
    default_system_prompt: &str,
) -> Result<String, String> {
    let messages: Value = serde_json::from_str(messages_json)
        .map_err(|error| format!("Invalid provider query messages JSON: {error}"))?;
    let mut system = default_system_prompt.to_string();
    let mut wire_messages = Vec::new();

    if let Some(messages) = messages.as_array() {
        for message in messages {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            match role {
                "system" => {
                    system = content.to_string();
                }
                "user" => {
                    wire_messages.push(json!({
                        "role": "user",
                        "content": content
                    }));
                }
                "assistant" => {
                    let mut blocks = Vec::new();
                    if !content.is_empty() {
                        blocks.push(json!({ "type": "text", "text": content }));
                    }
                    if let Some(tool_calls) = message.get("toolCalls").and_then(Value::as_array) {
                        for call in tool_calls {
                            let args_json = call
                                .get("argumentsJson")
                                .and_then(Value::as_str)
                                .unwrap_or("{}");
                            let input: Value =
                                serde_json::from_str(normalize_json_object_argument(args_json))
                                    .unwrap_or_else(|_| json!({}));
                            blocks.push(json!({
                                "type": "tool_use",
                                "id": call.get("callId").and_then(Value::as_str).unwrap_or("tool"),
                                "name": call.get("name").and_then(Value::as_str).unwrap_or("tool"),
                                "input": input
                            }));
                        }
                    }
                    if blocks.is_empty() {
                        blocks.push(json!({ "type": "text", "text": "" }));
                    }
                    wire_messages.push(json!({
                        "role": "assistant",
                        "content": blocks
                    }));
                }
                "tool" => {
                    wire_messages.push(json!({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": message.get("callId").and_then(Value::as_str).unwrap_or("tool"),
                            "content": content
                        }]
                    }));
                }
                _ => {}
            }
        }
    }

    serde_json::to_string(&json!({
        "system": system,
        "messages": wire_messages
    }))
    .map_err(|error| error.to_string())
}

pub fn build_anthropic_user_message_json(
    prompt: &str,
    attachments_json: &str,
) -> Result<String, String> {
    let attachments: Value = serde_json::from_str(attachments_json)
        .map_err(|error| format!("Invalid Anthropic attachments JSON: {error}"))?;
    let supported_mimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    let mut blocks = vec![json!({ "type": "text", "text": prompt })];

    if let Some(attachments) = attachments.as_array() {
        for attachment in cap_provider_attachments_values(attachments) {
            let mime_type = attachment
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !supported_mimes.contains(&mime_type) {
                continue;
            }
            let data_url = attachment
                .get("dataUrl")
                .and_then(Value::as_str)
                .unwrap_or("");
            let data = data_url
                .find(',')
                .map(|index| &data_url[index + 1..])
                .unwrap_or("");
            if data.is_empty() {
                continue;
            }
            blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type,
                    "data": data
                }
            }));
        }
    }

    let content = if blocks.len() > 1 {
        Value::Array(blocks)
    } else {
        Value::String(prompt.to_string())
    };
    serde_json::to_string(&json!({
        "role": "user",
        "content": content
    }))
    .map_err(|error| error.to_string())
}

pub fn build_anthropic_tool_result_block_json(
    tool_use_id: &str,
    content: &str,
    is_error: Option<bool>,
) -> Result<String, String> {
    let mut block = json!({
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content
    });
    if let Some(is_error) = is_error {
        block["is_error"] = Value::Bool(is_error);
    }
    serde_json::to_string(&block).map_err(|error| error.to_string())
}

pub fn parse_anthropic_response_json(response_json: &str) -> Result<String, String> {
    parse_anthropic_response_json_for_model(response_json, None)
}

pub fn parse_anthropic_response_json_for_model(
    response_json: &str,
    model: Option<&str>,
) -> Result<String, String> {
    let response: Value = serde_json::from_str(response_json)
        .map_err(|error| format!("Invalid Anthropic response JSON: {error}"))?;
    let content_blocks = response
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let text_parts = content_blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let content = text_parts.join("\n");

    let mut actions = Vec::new();
    for block in &content_blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let id = block.get("id").and_then(Value::as_str).unwrap_or("");
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
        actions.push(json!({
            "callId": id,
            "tool": name,
            "input": if input.is_object() { input } else { json!({}) }
        }));
    }

    let usage = response.get("usage").unwrap_or(&Value::Null);
    let prompt_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read_tokens = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let (cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_creation) =
        anthropic_cache_creation_buckets(usage);

    let mut parsed = json!({
        "content": content,
        "actions": actions,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "costUsd": model
            .map(|model| {
                estimate_anthropic_cost_usd(
                    model,
                    prompt_tokens,
                    completion_tokens,
                    cache_read_tokens,
                    cache_write_5m_tokens,
                    cache_write_1h_tokens,
                )
            })
            .unwrap_or(0.0),
        "assistantMessage": {
            "role": "assistant",
            "content": content_blocks
        }
    });
    if let Some(cache_creation) = cache_creation {
        parsed["cacheCreation"] = cache_creation;
        parsed["cacheWrite5mTokens"] = json!(cache_write_5m_tokens);
        parsed["cacheWrite1hTokens"] = json!(cache_write_1h_tokens);
    }

    serde_json::to_string(&parsed).map_err(|error| error.to_string())
}

fn anthropic_cache_creation_buckets(usage: &Value) -> (u64, u64, u64, Option<Value>) {
    let aggregate = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let Some(cache_creation) = usage
        .get("cache_creation")
        .filter(|value| value.is_object())
    else {
        // The Messages API historically exposed only the aggregate counter.
        // Its ephemeral cache control defaults to the 5-minute write rate.
        return (aggregate, aggregate, 0, None);
    };

    let cache_write_5m_tokens = cache_creation
        .get("ephemeral_5m_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write_1h_tokens = cache_creation
        .get("ephemeral_1h_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    // Keep compatibility with responses that provide both the aggregate and
    // only one of the duration buckets: unspecified creation tokens use the
    // default 5-minute duration. If the aggregate is absent, the buckets win.
    let specified_buckets = cache_write_5m_tokens.saturating_add(cache_write_1h_tokens);
    let cache_write_5m_tokens =
        cache_write_5m_tokens.saturating_add(aggregate.saturating_sub(specified_buckets));
    let cache_write_tokens = cache_write_5m_tokens.saturating_add(cache_write_1h_tokens);
    (
        cache_write_tokens,
        cache_write_5m_tokens,
        cache_write_1h_tokens,
        Some(cache_creation.clone()),
    )
}

fn estimate_anthropic_cost_usd(
    model: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
    cache_read_tokens: u64,
    cache_write_5m_tokens: u64,
    cache_write_1h_tokens: u64,
) -> f64 {
    estimate_cost_usd(model, prompt_tokens as f64, completion_tokens as f64)
        + estimate_cost_usd(
            model,
            cache_read_tokens as f64 * ANTHROPIC_CACHE_READ_MULTIPLIER,
            0.0,
        )
        + estimate_cost_usd(
            model,
            cache_write_5m_tokens as f64 * ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER,
            0.0,
        )
        + estimate_cost_usd(
            model,
            cache_write_1h_tokens as f64 * ANTHROPIC_CACHE_WRITE_1H_MULTIPLIER,
            0.0,
        )
}

pub fn build_anthropic_messages_request_json(
    model: &str,
    system: &str,
    messages_json: &str,
    tools_json: &str,
) -> Result<String, String> {
    let mut messages: Value = serde_json::from_str(messages_json)
        .map_err(|error| format!("Invalid Anthropic messages JSON: {error}"))?;
    let tools: Value = serde_json::from_str(tools_json)
        .map_err(|error| format!("Invalid Anthropic tools JSON: {error}"))?;

    let mut breakpoints = 0;
    if let Some(messages) = messages.as_array_mut() {
        for message in messages.iter_mut().rev() {
            if apply_anthropic_message_cache_control(message) {
                breakpoints += 1;
                if breakpoints == 2 {
                    break;
                }
            }
        }
    }

    let mut request = json!({
        "model": model,
        "max_tokens": 2048,
        "messages": messages,
        "tools": tools
    });
    if !system.trim().is_empty() {
        request["system"] = json!([{
            "type": "text",
            "text": system,
            "cache_control": { "type": "ephemeral" }
        }]);
    }

    serde_json::to_string(&request).map_err(|error| error.to_string())
}

fn apply_anthropic_message_cache_control(message: &mut Value) -> bool {
    let Some(content) = message.get_mut("content") else {
        return false;
    };
    if let Some(text) = content.as_str().map(str::to_string) {
        if text.is_empty() {
            return false;
        }
        *content = json!([{
            "type": "text",
            "text": text,
            "cache_control": { "type": "ephemeral" }
        }]);
        return true;
    }
    let Some(blocks) = content.as_array_mut() else {
        return false;
    };
    let Some(block) = blocks.iter_mut().rev().find(|block| {
        !matches!(
            block.get("type").and_then(Value::as_str),
            Some("thinking" | "redacted_thinking")
        )
    }) else {
        return false;
    };
    let Some(block) = block.as_object_mut() else {
        return false;
    };
    block.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_provider_query_messages_to_anthropic_messages() {
        let output = provider_query_messages_to_anthropic_json(
            r#"[
                {"role":"system","content":"worker"},
                {"role":"user","content":"run shell"},
                {"role":"assistant","content":"","toolCalls":[{"callId":"tu_1","name":"run_shell","argumentsJson":"{\"command\":\"echo hi\"}"}]},
                {"role":"tool","callId":"tu_1","content":"hi"}
            ]"#,
            "default",
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"messages":[{"content":"run shell","role":"user"},{"content":[{"id":"tu_1","input":{"command":"echo hi"},"name":"run_shell","type":"tool_use"}],"role":"assistant"},{"content":[{"content":"hi","tool_use_id":"tu_1","type":"tool_result"}],"role":"user"}],"system":"worker"}"#
        );
    }

    #[test]
    fn assistant_without_content_gets_empty_text_block() {
        let output = provider_query_messages_to_anthropic_json(
            r#"[{"role":"assistant","content":""}]"#,
            "default",
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"messages":[{"content":[{"text":"","type":"text"}],"role":"assistant"}],"system":"default"}"#
        );
    }

    #[test]
    fn builds_anthropic_messages_request_spec() {
        let spec = build_anthropic_messages_request_spec_with_base(
            "sk-ant-test",
            "http://127.0.0.1:7777/v1/",
        );

        assert_eq!(spec.url, "http://127.0.0.1:7777/v1/messages");
        assert_eq!(
            spec.headers,
            vec![
                ("x-api-key".to_string(), "sk-ant-test".to_string()),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ("Content-Type".to_string(), "application/json".to_string())
            ]
        );
    }

    #[test]
    fn builds_anthropic_user_message_with_supported_inline_images() {
        let output = build_anthropic_user_message_json(
            "inspect",
            r#"[{"mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"},{"mimeType":"image/svg+xml","dataUrl":"data:image/svg+xml;base64,BBBB"},{"mimeType":"image/jpeg","dataUrl":"data:image/jpeg;base64,"}]"#,
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"content":[{"text":"inspect","type":"text"},{"source":{"data":"AAAA","media_type":"image/png","type":"base64"},"type":"image"}],"role":"user"}"#
        );
    }

    #[test]
    fn builds_plain_anthropic_user_message_without_image_blocks() {
        let output = build_anthropic_user_message_json("hello", "[]").unwrap();

        assert_eq!(output, r#"{"content":"hello","role":"user"}"#);
    }

    #[test]
    fn builds_anthropic_tool_result_blocks() {
        let success = build_anthropic_tool_result_block_json("tu_1", "ok", Some(false)).unwrap();
        let error = build_anthropic_tool_result_block_json("tu_2", "boom", Some(true)).unwrap();
        let unspecified = build_anthropic_tool_result_block_json("tu_3", "plain", None).unwrap();

        assert_eq!(
            success,
            r#"{"content":"ok","is_error":false,"tool_use_id":"tu_1","type":"tool_result"}"#
        );
        assert_eq!(
            error,
            r#"{"content":"boom","is_error":true,"tool_use_id":"tu_2","type":"tool_result"}"#
        );
        assert_eq!(
            unspecified,
            r#"{"content":"plain","tool_use_id":"tu_3","type":"tool_result"}"#
        );
    }

    #[test]
    fn parses_anthropic_response_text_actions_and_usage() {
        let output = parse_anthropic_response_json_for_model(
            r#"{
                "content":[
                    {"type":"text","text":"running"},
                    {"type":"tool_use","id":"tu_1","name":"run_shell","input":{"command":"echo hi"}}
                ],
                "usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}
            }"#,
            Some("claude-sonnet-4-6"),
        )
        .unwrap();

        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["content"], "running");
        assert_eq!(parsed["actions"][0]["callId"], "tu_1");
        assert_eq!(parsed["actions"][0]["input"]["command"], "echo hi");
        assert_eq!(parsed["assistantMessage"]["role"], "assistant");
        assert_eq!(parsed["promptTokens"], 2);
        assert_eq!(parsed["completionTokens"], 3);
        assert_eq!(parsed["cacheReadTokens"], 5);
        assert_eq!(parsed["cacheWriteTokens"], 7);
        assert!((parsed["costUsd"].as_f64().unwrap_or(0.0) - 0.000_078_75).abs() < f64::EPSILON);
    }

    #[test]
    fn prices_anthropic_cache_creation_buckets_separately() {
        let output = parse_anthropic_response_json_for_model(
            r#"{
                "content":[{"type":"text","text":"done"}],
                "usage":{
                    "input_tokens":100000,
                    "output_tokens":200000,
                    "cache_read_input_tokens":300000,
                    "cache_creation_input_tokens":500000,
                    "cache_creation":{
                        "ephemeral_5m_input_tokens":200000,
                        "ephemeral_1h_input_tokens":300000
                    }
                }
            }"#,
            Some("claude-sonnet-4-6"),
        )
        .unwrap();

        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["cacheWriteTokens"], 500000);
        assert_eq!(parsed["cacheWrite5mTokens"], 200000);
        assert_eq!(parsed["cacheWrite1hTokens"], 300000);
        assert_eq!(parsed["cacheCreation"]["ephemeral_5m_input_tokens"], 200000);
        assert_eq!(parsed["cacheCreation"]["ephemeral_1h_input_tokens"], 300000);
        // $0.30 ordinary + $0.09 cache read + $0.75 5m write + $1.80 1h write
        // + $3.00 output = $5.94.
        assert!((parsed["costUsd"].as_f64().unwrap_or(0.0) - 5.94).abs() < 1e-12);
    }

    #[test]
    fn builds_anthropic_messages_request() {
        let output = build_anthropic_messages_request_json(
            "claude-sonnet-4-6",
            "system",
            r#"[{"role":"user","content":"first"},{"role":"assistant","content":[{"type":"text","text":"answer"}]},{"role":"user","content":"latest"}]"#,
            r#"[{"name":"run_shell"}]"#,
        )
        .unwrap();

        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["system"][0]["text"], "system");
        assert_eq!(parsed["system"][0]["cache_control"]["type"], "ephemeral");
        assert!(parsed["messages"][0]["content"].is_string());
        assert_eq!(
            parsed["messages"][1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(
            parsed["messages"][2]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
    }

    #[test]
    fn omits_empty_anthropic_system_blocks() {
        let output = build_anthropic_messages_request_json(
            "claude-sonnet-4-6",
            "",
            r#"[{"role":"user","content":"hello"}]"#,
            "[]",
        )
        .unwrap();

        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert!(parsed.get("system").is_none());
    }
}
