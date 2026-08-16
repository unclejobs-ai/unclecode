use crate::json_args::normalize_json_object_argument;
use crate::model_pricing::estimate_cost_usd;
use crate::provider_attachments::cap_provider_attachments_values;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiRequestSpec {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

pub fn build_gemini_generate_content_request_spec(api_key: &str, model: &str) -> GeminiRequestSpec {
    build_gemini_generate_content_request_spec_with_base(
        api_key,
        model,
        "https://generativelanguage.googleapis.com/v1beta",
    )
}

pub fn build_gemini_generate_content_request_spec_with_base(
    api_key: &str,
    model: &str,
    base_url: &str,
) -> GeminiRequestSpec {
    let base = base_url.trim().trim_end_matches('/');
    GeminiRequestSpec {
        url: format!(
            "{base}/models/{}:generateContent",
            percent_encode_path_segment(model.trim())
        ),
        headers: vec![
            ("x-goog-api-key".to_string(), api_key.trim().to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
    }
}

pub fn provider_query_messages_to_gemini_json(
    messages_json: &str,
    default_system_prompt: &str,
) -> Result<String, String> {
    let messages: Value = serde_json::from_str(messages_json)
        .map_err(|error| format!("Invalid provider query messages JSON: {error}"))?;
    let mut system_instruction = default_system_prompt.to_string();
    let mut contents = Vec::new();
    let mut pending_tool_names: Vec<(String, String)> = Vec::new();

    if let Some(messages) = messages.as_array() {
        for message in messages {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            match role {
                "system" => {
                    system_instruction = content.to_string();
                }
                "user" => {
                    contents.push(json!({
                        "role": "user",
                        "parts": [{ "text": content }]
                    }));
                }
                "assistant" => {
                    let mut parts = Vec::new();
                    if !content.is_empty() {
                        parts.push(json!({ "text": content }));
                    }
                    if let Some(tool_calls) = message.get("toolCalls").and_then(Value::as_array) {
                        for call in tool_calls {
                            let args_json = call
                                .get("argumentsJson")
                                .and_then(Value::as_str)
                                .unwrap_or("{}");
                            let args: Value =
                                serde_json::from_str(normalize_json_object_argument(args_json))
                                    .unwrap_or_else(|_| json!({}));
                            let call_id =
                                call.get("callId").and_then(Value::as_str).unwrap_or("tool");
                            let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
                            pending_tool_names.push((call_id.to_string(), name.to_string()));
                            parts.push(json!({
                                "functionCall": {
                                    "id": call_id,
                                    "name": name,
                                    "args": args
                                }
                            }));
                        }
                    }
                    if parts.is_empty() {
                        parts.push(json!({ "text": "" }));
                    }
                    contents.push(json!({
                        "role": "model",
                        "parts": parts
                    }));
                }
                "tool" => {
                    let call_id = message
                        .get("callId")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let response_name = pending_tool_names
                        .iter()
                        .position(|(pending_call_id, _)| pending_call_id == call_id)
                        .map(|index| pending_tool_names.remove(index).1)
                        .unwrap_or_else(|| call_id.to_string());
                    contents.push(json!({
                        "role": "user",
                        "parts": [{
                            "functionResponse": {
                                "id": call_id,
                                "name": response_name,
                                "response": { "output": content }
                            }
                        }]
                    }));
                }
                _ => {}
            }
        }
    }

    serde_json::to_string(&json!({
        "systemInstruction": system_instruction,
        "contents": contents
    }))
    .map_err(|error| error.to_string())
}

pub fn tool_definitions_to_gemini_function_declarations_json(
    definitions_json: &str,
) -> Result<String, String> {
    let definitions: Value = serde_json::from_str(definitions_json)
        .map_err(|error| format!("Invalid tool definitions JSON: {error}"))?;
    let declarations = definitions
        .as_array()
        .map(|definitions| {
            definitions
                .iter()
                .map(|definition| {
                    json!({
                        "name": definition.get("name").and_then(Value::as_str).unwrap_or("tool"),
                        "description": definition.get("description").and_then(Value::as_str).unwrap_or(""),
                        "parametersJsonSchema": definition.get("input_schema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::to_string(&declarations).map_err(|error| error.to_string())
}

pub fn build_gemini_user_content_json(
    prompt: &str,
    attachments_json: &str,
) -> Result<String, String> {
    let attachments: Value = serde_json::from_str(attachments_json)
        .map_err(|error| format!("Invalid Gemini attachments JSON: {error}"))?;
    let mut parts = vec![json!({ "text": prompt })];

    if let Some(attachments) = attachments.as_array() {
        for attachment in cap_provider_attachments_values(attachments) {
            let mime_type = attachment
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("");
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
            parts.push(json!({
                "inlineData": {
                    "mimeType": mime_type,
                    "data": data
                }
            }));
        }
    }

    serde_json::to_string(&json!({
        "role": "user",
        "parts": parts
    }))
    .map_err(|error| error.to_string())
}

pub fn build_gemini_function_response_part_json(
    name: &str,
    call_id: &str,
    kind: &str,
    content: &str,
    is_error: bool,
) -> Result<String, String> {
    let response = match kind {
        "success" => json!({
            "content": content,
            "isError": is_error
        }),
        "error" => json!({
            "error": content
        }),
        _ => return Err(
            "Usage: unclecode rust provider gemini-function-response <name> <call-id> <success|error> <is-error yes|no>".to_string(),
        ),
    };

    serde_json::to_string(&json!({
        "functionResponse": {
            "name": name,
            "id": call_id,
            "response": response
        }
    }))
    .map_err(|error| error.to_string())
}

pub fn parse_gemini_response_json(response_json: &str) -> Result<String, String> {
    parse_gemini_response_json_for_model(response_json, None)
}

pub fn parse_gemini_response_json_for_model(
    response_json: &str,
    model: Option<&str>,
) -> Result<String, String> {
    let response: Value = serde_json::from_str(response_json)
        .map_err(|error| format!("Invalid Gemini response JSON: {error}"))?;
    let candidate = response
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first());
    let parts = candidate
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let text_parts = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    let fallback_text = response.get("text").and_then(Value::as_str).unwrap_or("");
    let content = if text_parts.is_empty() {
        fallback_text.to_string()
    } else {
        text_parts.join("\n")
    };

    let mut actions = Vec::new();
    for part in &parts {
        let Some(call) = part.get("functionCall") else {
            continue;
        };
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            continue;
        }
        let call_id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or(name);
        let input = call.get("args").cloned().unwrap_or_else(|| json!({}));
        actions.push(json!({
            "callId": call_id,
            "tool": name,
            "input": if input.is_object() { input } else { json!({}) }
        }));
    }

    let usage = response.get("usageMetadata").unwrap_or(&Value::Null);
    let prompt_tokens = usage
        .get("promptTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion_tokens = usage
        .get("candidatesTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read_tokens = usage
        .get("cachedContentTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    serde_json::to_string(&json!({
        "content": content,
        "actions": actions,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "cacheReadTokens": cache_read_tokens,
        "costUsd": model
            .map(|model| estimate_cost_usd(model, prompt_tokens as f64, completion_tokens as f64))
            .unwrap_or(0.0),
        "modelContent": {
            "role": "model",
            "parts": parts
        }
    }))
    .map_err(|error| error.to_string())
}

pub fn build_gemini_generate_content_request_json(
    model: &str,
    system_instruction: &str,
    contents_json: &str,
    function_declarations_json: &str,
    include_tools: bool,
) -> Result<String, String> {
    let contents: Value = serde_json::from_str(contents_json)
        .map_err(|error| format!("Invalid Gemini contents JSON: {error}"))?;
    let function_declarations: Value = serde_json::from_str(function_declarations_json)
        .map_err(|error| format!("Invalid Gemini function declarations JSON: {error}"))?;
    let tools = if include_tools {
        json!([{ "functionDeclarations": function_declarations }])
    } else {
        json!([])
    };

    serde_json::to_string(&json!({
        "model": model,
        "contents": contents,
        "config": {
            "systemInstruction": system_instruction,
            "tools": tools,
            "toolConfig": {
                "functionCallingConfig": {
                    "mode": "AUTO"
                }
            }
        }
    }))
    .map_err(|error| error.to_string())
}

pub fn build_gemini_generate_content_rest_request_json(
    system_instruction: &str,
    contents_json: &str,
    function_declarations_json: &str,
    include_tools: bool,
) -> Result<String, String> {
    let contents: Value = serde_json::from_str(contents_json)
        .map_err(|error| format!("Invalid Gemini contents JSON: {error}"))?;
    let function_declarations: Value = serde_json::from_str(function_declarations_json)
        .map_err(|error| format!("Invalid Gemini function declarations JSON: {error}"))?;

    let mut body = Map::new();
    body.insert("contents".to_string(), contents);
    if !system_instruction.trim().is_empty() {
        body.insert(
            "systemInstruction".to_string(),
            json!({ "parts": [{ "text": system_instruction }] }),
        );
    }
    if include_tools {
        let declarations = gemini_function_declarations_for_rest(&function_declarations);
        if declarations
            .as_array()
            .is_some_and(|values| !values.is_empty())
        {
            body.insert(
                "tools".to_string(),
                json!([{ "functionDeclarations": declarations }]),
            );
            body.insert(
                "toolConfig".to_string(),
                json!({
                    "functionCallingConfig": {
                        "mode": "AUTO"
                    }
                }),
            );
        }
    }

    serde_json::to_string(&Value::Object(body)).map_err(|error| error.to_string())
}

fn gemini_function_declarations_for_rest(function_declarations: &Value) -> Value {
    let declarations = function_declarations
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|declaration| {
                    let Some(object) = declaration.as_object() else {
                        return declaration.clone();
                    };
                    let mut normalized = Map::new();
                    for (key, value) in object {
                        if key == "parametersJsonSchema" {
                            if !object.contains_key("parameters") {
                                normalized.insert("parameters".to_string(), value.clone());
                            }
                            continue;
                        }
                        normalized.insert(key.clone(), value.clone());
                    }
                    Value::Object(normalized)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(declarations)
}

fn percent_encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_provider_query_messages_to_gemini_contents() {
        let output = provider_query_messages_to_gemini_json(
            r#"[
                {"role":"system","content":"worker"},
                {"role":"user","content":"run shell"},
                {"role":"assistant","content":"","toolCalls":[{"callId":"fc_1","name":"run_shell","argumentsJson":"{\"command\":\"echo hi\"}"}]},
                {"role":"tool","callId":"fc_1","content":"hi"}
            ]"#,
            "default",
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"contents":[{"parts":[{"text":"run shell"}],"role":"user"},{"parts":[{"functionCall":{"args":{"command":"echo hi"},"id":"fc_1","name":"run_shell"}}],"role":"model"},{"parts":[{"functionResponse":{"id":"fc_1","name":"run_shell","response":{"output":"hi"}}}],"role":"user"}],"systemInstruction":"worker"}"#
        );
    }

    #[test]
    fn builds_gemini_generate_content_request_spec() {
        let spec = build_gemini_generate_content_request_spec_with_base(
            "g-test",
            "publishers/google/gemini",
            "http://127.0.0.1:7777/v1beta/",
        );

        assert_eq!(
            spec.url,
            "http://127.0.0.1:7777/v1beta/models/publishers%2Fgoogle%2Fgemini:generateContent"
        );
        assert_eq!(
            spec.headers,
            vec![
                ("x-goog-api-key".to_string(), "g-test".to_string()),
                ("Content-Type".to_string(), "application/json".to_string())
            ]
        );
    }

    #[test]
    fn converts_tool_definitions_to_gemini_function_declarations() {
        let output = tool_definitions_to_gemini_function_declarations_json(
            r#"[{"name":"run_shell","description":"Run shell","input_schema":{"type":"object","properties":{"command":{"type":"string"}}}}]"#,
        )
        .unwrap();

        assert_eq!(
            output,
            r#"[{"description":"Run shell","name":"run_shell","parametersJsonSchema":{"properties":{"command":{"type":"string"}},"type":"object"}}]"#
        );
    }

    #[test]
    fn builds_gemini_user_content_with_inline_attachment_data() {
        let output = build_gemini_user_content_json(
            "inspect",
            r#"[{"mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"},{"mimeType":"image/png","dataUrl":"data:image/png;base64,"}]"#,
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"parts":[{"text":"inspect"},{"inlineData":{"data":"AAAA","mimeType":"image/png"}}],"role":"user"}"#
        );
    }

    #[test]
    fn builds_gemini_function_response_parts() {
        let success =
            build_gemini_function_response_part_json("run_shell", "fc_1", "success", "ok", false)
                .unwrap();
        let error =
            build_gemini_function_response_part_json("run_shell", "fc_2", "error", "boom", true)
                .unwrap();

        assert_eq!(
            success,
            r#"{"functionResponse":{"id":"fc_1","name":"run_shell","response":{"content":"ok","isError":false}}}"#
        );
        assert_eq!(
            error,
            r#"{"functionResponse":{"id":"fc_2","name":"run_shell","response":{"error":"boom"}}}"#
        );
    }

    #[test]
    fn parses_gemini_response_text_actions_and_usage() {
        let output = parse_gemini_response_json_for_model(
            r#"{
                "candidates":[{"content":{"parts":[
                    {"text":"running"},
                    {"functionCall":{"id":"fc_1","name":"run_shell","args":{"command":"echo hi"}}}
                ]}}],
                "usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"cachedContentTokenCount":2}
            }"#,
            Some("gemini-2.5-pro"),
        )
        .unwrap();

        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["content"], "running");
        assert_eq!(parsed["actions"][0]["callId"], "fc_1");
        assert_eq!(parsed["actions"][0]["input"]["command"], "echo hi");
        assert_eq!(parsed["modelContent"]["role"], "model");
        assert_eq!(parsed["promptTokens"], 5);
        assert_eq!(parsed["completionTokens"], 3);
        assert_eq!(parsed["cacheReadTokens"], 2);
        assert!(parsed["costUsd"].as_f64().unwrap_or(0.0) > 0.0);
    }

    #[test]
    fn parses_gemini_response_fallback_text() {
        let output = parse_gemini_response_json(r#"{"text":"fallback"}"#).unwrap();

        assert_eq!(
            output,
            r#"{"actions":[],"cacheReadTokens":0,"completionTokens":0,"content":"fallback","costUsd":0.0,"modelContent":{"parts":[],"role":"model"},"promptTokens":0}"#
        );
    }

    #[test]
    fn builds_gemini_generate_content_request() {
        let output = build_gemini_generate_content_request_json(
            "gemini-3.1-flash",
            "system",
            r#"[{"role":"user","parts":[{"text":"hi"}]}]"#,
            r#"[{"name":"run_shell"}]"#,
            true,
        )
        .unwrap();

        assert_eq!(
            output,
            r#"{"config":{"systemInstruction":"system","toolConfig":{"functionCallingConfig":{"mode":"AUTO"}},"tools":[{"functionDeclarations":[{"name":"run_shell"}]}]},"contents":[{"parts":[{"text":"hi"}],"role":"user"}],"model":"gemini-3.1-flash"}"#
        );
    }

    #[test]
    fn builds_gemini_generate_content_rest_request() {
        let output = build_gemini_generate_content_rest_request_json(
            "system",
            r#"[{"role":"user","parts":[{"text":"hi"}]}]"#,
            r#"[{"name":"run_shell","parametersJsonSchema":{"type":"object","properties":{"command":{"type":"string"}}}}]"#,
            true,
        )
        .unwrap();

        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert!(parsed.get("model").is_none());
        assert!(parsed.get("config").is_none());
        assert_eq!(parsed["systemInstruction"]["parts"][0]["text"], "system");
        assert_eq!(
            parsed["tools"][0]["functionDeclarations"][0]["parameters"]["properties"]["command"]
                ["type"],
            "string"
        );
        assert!(parsed["tools"][0]["functionDeclarations"][0]
            .get("parametersJsonSchema")
            .is_none());
        assert_eq!(
            parsed["toolConfig"]["functionCallingConfig"]["mode"],
            "AUTO"
        );
    }
}
