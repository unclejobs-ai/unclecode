use crate::http_transport::HttpTransportResponse;
use crate::json_args::normalize_json_object_argument;
use crate::model_pricing::estimate_cost_usd;
use crate::provider_request::{
    build_openai_chat_request_body, provider_query_messages_to_openai_json,
    tool_definitions_to_chat_tools_json,
};
use crate::provider_response::{parse_openai_chat_response_records, OpenAIChatResponseRecord};
use crate::provider_transport::post_openai_chat_response;
use serde_json::{json, Value};

pub fn run_openai_chat_query_json(
    api_key: &str,
    model: &str,
    system_prompt: &str,
    messages_json: &str,
    tools_json: &str,
    reasoning_effort: Option<&str>,
    base_url: &str,
) -> Result<String, String> {
    let response = post_openai_chat(
        api_key,
        model,
        system_prompt,
        messages_json,
        tools_json,
        reasoning_effort,
        base_url,
    )?;
    parse_query_response(model, response)
}

pub fn run_openai_chat_completion_json(
    api_key: &str,
    model: &str,
    messages_json: &str,
    tools_json: &str,
    reasoning_effort: Option<&str>,
    base_url: &str,
) -> Result<String, String> {
    let response = post_openai_chat(
        api_key,
        model,
        "",
        messages_json,
        tools_json,
        reasoning_effort,
        base_url,
    )?;
    parse_completion_response(response)
}

fn post_openai_chat(
    api_key: &str,
    model: &str,
    system_prompt: &str,
    messages_json: &str,
    tools_json: &str,
    reasoning_effort: Option<&str>,
    base_url: &str,
) -> Result<HttpTransportResponse, String> {
    let wire_messages = provider_query_messages_to_openai_json(messages_json, system_prompt)?;
    let wire_tools = tool_definitions_to_chat_tools_json(tools_json)?;
    let include_tools = has_array_items(&wire_tools);
    let body = build_openai_chat_request_body(
        model,
        &wire_messages,
        include_tools.then_some(wire_tools.as_str()),
        reasoning_effort,
    );
    post_openai_chat_response(api_key, &body, base_url)
}

fn parse_query_response(model: &str, response: HttpTransportResponse) -> Result<String, String> {
    if !response.ok {
        let body = response.body.trim();
        return Err(if body.is_empty() {
            format!("OpenAI request failed with status {}", response.status)
        } else {
            format!(
                "OpenAI request failed with status {}: {body}",
                response.status
            )
        });
    }

    let mut content = String::new();
    let mut prompt_tokens = 0_u64;
    let mut completion_tokens = 0_u64;
    let mut actions = Vec::new();
    for record in parse_openai_chat_response_records(&response.body)? {
        match record {
            OpenAIChatResponseRecord::Content(value) => content = value,
            OpenAIChatResponseRecord::Reasoning(_) => {}
            OpenAIChatResponseRecord::ToolCall {
                id,
                name,
                arguments_json,
            } => {
                let tool = name.trim();
                if tool.is_empty() {
                    continue;
                }
                actions.push(json!({
                    "callId": if id.trim().is_empty() { tool } else { id.trim() },
                    "tool": tool,
                    "input": parse_tool_input(&arguments_json),
                }));
            }
            OpenAIChatResponseRecord::Usage {
                prompt_tokens: prompt,
                completion_tokens: completion,
            } => {
                prompt_tokens = prompt;
                completion_tokens = completion;
            }
        }
    }

    serde_json::to_string(&json!({
        "content": content,
        "actions": actions,
        "costUsd": estimate_cost_usd(model, prompt_tokens as f64, completion_tokens as f64),
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "attempts": response.attempts,
    }))
    .map_err(|error| error.to_string())
}

fn parse_completion_response(response: HttpTransportResponse) -> Result<String, String> {
    if !response.ok {
        let body = response.body.trim();
        return Err(if body.is_empty() {
            format!("OpenAI request failed with status {}", response.status)
        } else {
            format!(
                "OpenAI request failed with status {}: {body}",
                response.status
            )
        });
    }

    let mut content = String::new();
    let mut reasoning = String::new();
    let mut prompt_tokens = 0_u64;
    let mut completion_tokens = 0_u64;
    let mut tool_calls = Vec::new();
    let mut actions = Vec::new();
    for record in parse_openai_chat_response_records(&response.body)? {
        match record {
            OpenAIChatResponseRecord::Content(value) => content = value,
            OpenAIChatResponseRecord::Reasoning(value) => reasoning = value,
            OpenAIChatResponseRecord::ToolCall {
                id,
                name,
                arguments_json,
            } => {
                let tool = name.trim();
                tool_calls.push(json!({
                    "id": id,
                    "function": {
                        "name": name,
                        "arguments": arguments_json,
                    }
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
            } => {
                prompt_tokens = prompt;
                completion_tokens = completion;
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
        "attempts": response.attempts,
    }))
    .map_err(|error| error.to_string())
}

fn parse_tool_input(arguments_json: &str) -> Value {
    serde_json::from_str(normalize_json_object_argument(arguments_json))
        .unwrap_or_else(|_| json!({}))
}

fn has_array_items(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().map(|items| !items.is_empty()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn runs_openai_chat_query_over_rust_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 8192];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(request.contains("POST /v1/chat/completions HTTP/1.1"));
            assert!(request.contains("authorization: Bearer sk-test"));
            assert!(request.contains(r#""tool_choice":"auto""#));
            assert!(request.contains(r#""name":"run_shell""#));
            stream.write_all(
                br#"HTTP/1.1 200 OK
connection: close

{"choices":[{"message":{"content":"running","tool_calls":[{"id":"call_1","function":{"name":"run_shell","arguments":"{\"command\":\"echo ok\"}"}}]}}],"usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}"#,
            ).unwrap();
        });

        let output = run_openai_chat_query_json(
            "sk-test",
            "gpt-4.1-mini",
            "system",
            r#"[{"role":"user","content":"run"}]"#,
            r#"[{"name":"run_shell","description":"Run shell","input_schema":{"type":"object","properties":{"command":{"type":"string"}}}}]"#,
            None,
            &format!("http://{address}/v1"),
        )
        .unwrap();
        handle.join().unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["content"], "running");
        assert_eq!(parsed["actions"][0]["tool"], "run_shell");
        assert_eq!(parsed["actions"][0]["input"]["command"], "echo ok");
        assert_eq!(parsed["costUsd"], 2.0);
    }

    #[test]
    fn runs_openai_chat_completion_over_rust_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 8192];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(request.contains("POST /v1/chat/completions HTTP/1.1"));
            assert!(request.contains(r#""role":"user""#));
            stream.write_all(
                br#"HTTP/1.1 200 OK
connection: close

{"choices":[{"message":{"content":"done","reasoning_content":"thinking","tool_calls":[{"id":"call_2","function":{"name":"inspect","arguments":"{\"path\":\"src\"}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}"#,
            ).unwrap();
        });

        let output = run_openai_chat_completion_json(
            "sk-test",
            "gpt-5.4",
            r#"[{"role":"user","content":"inspect"}]"#,
            r#"[{"name":"inspect","description":"Inspect","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}]"#,
            Some("high"),
            &format!("http://{address}/v1"),
        )
        .unwrap();
        handle.join().unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["content"], "done");
        assert_eq!(parsed["reasoning"], "thinking");
        assert_eq!(parsed["toolCalls"][0]["function"]["name"], "inspect");
        assert_eq!(parsed["actions"][0]["tool"], "inspect");
        assert_eq!(parsed["actions"][0]["input"]["path"], "src");
    }
}
