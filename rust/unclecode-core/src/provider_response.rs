use crate::model_pricing::estimate_cost_usd;
use serde_json::{json, Value};

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
    },
}

pub fn parse_openai_chat_response_records(
    raw: &str,
) -> Result<Vec<OpenAIChatResponseRecord>, String> {
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
        records.push(OpenAIChatResponseRecord::Content(content.to_string()));
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
    });

    Ok(records)
}

pub fn parse_openai_chat_response_json(raw: &str) -> Result<String, String> {
    parse_openai_chat_response_json_for_model(raw, None)
}

pub fn parse_openai_chat_response_json_for_model(
    raw: &str,
    model: Option<&str>,
) -> Result<String, String> {
    let records = parse_openai_chat_response_records(raw)?;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    let mut actions = Vec::new();
    let mut prompt_tokens = 0;
    let mut completion_tokens = 0;

    for record in records {
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
        "costUsd": model
            .map(|model| estimate_cost_usd(model, prompt_tokens as f64, completion_tokens as f64))
            .unwrap_or(0.0)
    }))
    .map_err(|error| error.to_string())
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
                "usage":{"prompt_tokens":12,"completion_tokens":34}
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
            }]
        );
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
            Some("gpt-5.5"),
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
