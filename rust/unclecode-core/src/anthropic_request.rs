use crate::json_args::normalize_json_object_argument;
use crate::model_pricing::estimate_cost_usd;
use crate::provider_attachments::cap_provider_attachments_values;
use crate::provider_request::ProviderRequestSpec;
use serde_json::{json, Value};

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

    serde_json::to_string(&json!({
        "content": content,
        "actions": actions,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "costUsd": model
            .map(|model| estimate_cost_usd(model, prompt_tokens as f64, completion_tokens as f64))
            .unwrap_or(0.0),
        "assistantMessage": {
            "role": "assistant",
            "content": content_blocks
        }
    }))
    .map_err(|error| error.to_string())
}

pub fn build_anthropic_messages_request_json(
    model: &str,
    system: &str,
    messages_json: &str,
    tools_json: &str,
) -> Result<String, String> {
    let messages: Value = serde_json::from_str(messages_json)
        .map_err(|error| format!("Invalid Anthropic messages JSON: {error}"))?;
    let tools: Value = serde_json::from_str(tools_json)
        .map_err(|error| format!("Invalid Anthropic tools JSON: {error}"))?;

    serde_json::to_string(&json!({
        "model": model,
        "max_tokens": 2048,
        "system": system,
        "messages": messages,
        "tools": tools
    }))
    .map_err(|error| error.to_string())
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
                "usage":{"input_tokens":2,"output_tokens":3}
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
        assert!(parsed["costUsd"].as_f64().unwrap_or(0.0) > 0.0);
    }

    #[test]
    fn builds_anthropic_messages_request() {
        let output = build_anthropic_messages_request_json(
            "claude-sonnet-4-6",
            "system",
            r#"[{"role":"user","content":"hi"}]"#,
            r#"[{"name":"run_shell"}]"#,
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"max_tokens":2048,"messages":[{"content":"hi","role":"user"}],"model":"claude-sonnet-4-6","system":"system","tools":[{"name":"run_shell"}]}"#
        );
    }
}
