use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn openai_messages_to_responses_input_json(messages_json: &str) -> Result<String, String> {
    let messages: Value = serde_json::from_str(messages_json)
        .map_err(|error| format!("Invalid OpenAI messages JSON: {error}"))?;
    let input = openai_messages_to_responses_input(&messages);
    serde_json::to_string(&input).map_err(|error| error.to_string())
}

pub fn slice_responses_input_to_latest_tool_turn_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid Responses input JSON: {error}"))?;
    let sliced = slice_responses_input_to_latest_tool_turn(&input);
    serde_json::to_string(&sliced).map_err(|error| error.to_string())
}

pub fn build_latest_responses_input_json(messages_json: &str) -> Result<String, String> {
    let converted = openai_messages_to_responses_input_json(messages_json)?;
    slice_responses_input_to_latest_tool_turn_json(&converted)
}

pub fn tool_definitions_to_responses_tools_json(definitions_json: &str) -> Result<String, String> {
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
                        "name": definition.get("name").and_then(Value::as_str).unwrap_or("tool"),
                        "description": definition.get("description").and_then(Value::as_str).unwrap_or(""),
                        "parameters": definition.get("input_schema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                        "strict": false
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::to_string(&tools).map_err(|error| error.to_string())
}

fn openai_messages_to_responses_input(messages: &Value) -> Vec<Value> {
    let mut input = Vec::new();
    let Some(messages) = messages.as_array() else {
        return input;
    };

    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");

        if role == "tool" {
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            input.push(json!({
                "type": "function_call_output",
                "call_id": message.get("tool_call_id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(native_call_id),
                "output": [{ "type": "input_text", "text": content }]
            }));
            continue;
        }

        if role == "assistant" {
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            if !content.is_empty() {
                input.push(json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": content }]
                }));
            }
        } else if role == "user" || role == "developer" {
            let content_blocks = responses_content_blocks(message.get("content"));
            if !content_blocks.is_empty() {
                input.push(json!({
                    "type": "message",
                    "role": role,
                    "content": content_blocks
                }));
            }
        }

        if role == "assistant" {
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for tool_call in tool_calls {
                    let function = tool_call.get("function").unwrap_or(&Value::Null);
                    input.push(json!({
                        "type": "function_call",
                        "call_id": tool_call.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(native_call_id),
                        "name": function.get("name").and_then(Value::as_str).unwrap_or("tool"),
                        "arguments": function.get("arguments").and_then(Value::as_str).unwrap_or("{}")
                    }));
                }
            }
        }
    }

    input
}

fn responses_content_blocks(content: Option<&Value>) -> Vec<Value> {
    let mut blocks = Vec::new();
    match content {
        Some(Value::String(text)) if !text.is_empty() => {
            blocks.push(json!({ "type": "input_text", "text": text }));
        }
        Some(Value::Array(parts)) => {
            for part in parts {
                let Some(part_type) = part.get("type").and_then(Value::as_str) else {
                    continue;
                };
                if part_type == "text" {
                    if let Some(text) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        blocks.push(json!({ "type": "input_text", "text": text }));
                    }
                } else if part_type == "image_url" {
                    if let Some(url) = part
                        .get("image_url")
                        .and_then(|value| value.get("url"))
                        .and_then(Value::as_str)
                    {
                        blocks.push(json!({ "type": "input_image", "image_url": url }));
                    }
                }
            }
        }
        _ => {}
    }
    blocks
}

fn slice_responses_input_to_latest_tool_turn(input: &Value) -> Vec<Value> {
    let items = match input.as_array() {
        Some(items) => items.clone(),
        None => return Vec::new(),
    };
    let mut trailing_output_start: Option<usize> = None;

    for index in (0..items.len()).rev() {
        if is_tool_output_with_call_id(&items[index]) {
            trailing_output_start = Some(index);
            continue;
        }
        if trailing_output_start.is_some() {
            break;
        }
    }

    let Some(trailing_output_start) = trailing_output_start else {
        return remove_unpaired_responses_tool_items(items);
    };

    let trailing_call_ids: HashSet<String> = items[trailing_output_start..]
        .iter()
        .filter_map(call_id_for_tool_output)
        .collect();
    let mut remaining_call_ids = trailing_call_ids.clone();

    let mut start_index = trailing_output_start;
    for index in (0..trailing_output_start).rev() {
        let item = &items[index];
        if item_type(item) == Some("function_call") {
            if let Some(call_id) = call_id(item) {
                if trailing_call_ids.contains(call_id) {
                    start_index = index;
                    remaining_call_ids.remove(call_id);
                    continue;
                }
            }
        }
        if item_type(item) == Some("message") && remaining_call_ids.is_empty() {
            start_index = index;
            break;
        }
    }

    if !remaining_call_ids.is_empty() {
        for index in (0..trailing_output_start).rev() {
            if item_type(&items[index]) == Some("message") {
                start_index = index;
                break;
            }
        }
    }

    remove_unpaired_responses_tool_items(items[start_index..].to_vec())
}

fn remove_unpaired_responses_tool_items(items: Vec<Value>) -> Vec<Value> {
    let call_ids: HashSet<String> = items
        .iter()
        .filter(|item| item_type(item) == Some("function_call"))
        .filter_map(call_id)
        .map(str::to_string)
        .collect();
    let output_ids: HashSet<String> = items.iter().filter_map(call_id_for_tool_output).collect();

    items
        .into_iter()
        .filter(|item| {
            if item_type(item) == Some("function_call") {
                return call_id(item).is_some_and(|id| output_ids.contains(id));
            }
            if item_type(item) == Some("function_call_output") {
                return call_id(item).is_some_and(|id| call_ids.contains(id));
            }
            true
        })
        .collect()
}

fn item_type(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn call_id(item: &Value) -> Option<&str> {
    item.get("call_id").and_then(Value::as_str)
}

fn call_id_for_tool_output(item: &Value) -> Option<String> {
    if item_type(item) == Some("function_call_output") {
        call_id(item).map(str::to_string)
    } else {
        None
    }
}

fn is_tool_output_with_call_id(item: &Value) -> bool {
    call_id_for_tool_output(item).is_some()
}

fn native_call_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("call_rs_{}_{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_openai_messages_to_responses_input() {
        let input = openai_messages_to_responses_input_json(
            r#"[
                {"role":"user","content":"hello"},
                {"role":"assistant","content":"calling tool","tool_calls":[{"id":"call-1","function":{"name":"weather","arguments":"{\"city\":\"Seoul\"}"}}]},
                {"role":"tool","tool_call_id":"call-1","content":"sunny"}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            input,
            r#"[{"content":[{"text":"hello","type":"input_text"}],"role":"user","type":"message"},{"content":[{"text":"calling tool","type":"output_text"}],"role":"assistant","type":"message"},{"arguments":"{\"city\":\"Seoul\"}","call_id":"call-1","name":"weather","type":"function_call"},{"call_id":"call-1","output":[{"text":"sunny","type":"input_text"}],"type":"function_call_output"}]"#
        );
    }

    #[test]
    fn preserves_image_url_parts_as_input_images() {
        let input = openai_messages_to_responses_input_json(
            r#"[{"role":"user","content":[{"type":"text","text":"What is in this screenshot?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,abc123"}}]}]"#,
        )
        .unwrap();
        assert_eq!(
            input,
            r#"[{"content":[{"text":"What is in this screenshot?","type":"input_text"},{"image_url":"data:image/png;base64,abc123","type":"input_image"}],"role":"user","type":"message"}]"#
        );
    }

    #[test]
    fn slices_latest_tool_turn_and_drops_dangling_calls() {
        let input = slice_responses_input_to_latest_tool_turn_json(
            r#"[
                {"type":"message","role":"user","content":[{"type":"input_text","text":"Old question"}]},
                {"type":"function_call","call_id":"call-old","name":"search","arguments":"{\"q\":\"old\"}"},
                {"type":"function_call_output","call_id":"call-old","output":[{"type":"input_text","text":"old result"}]},
                {"type":"message","role":"user","content":[{"type":"input_text","text":"New question"}]},
                {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Calling weather"}]},
                {"type":"function_call","call_id":"call-new","name":"weather","arguments":"{\"city\":\"Seoul\"}"},
                {"type":"function_call_output","call_id":"call-new","output":[{"type":"input_text","text":"Sunny, 19C"}]}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            input,
            r#"[{"content":[{"text":"Calling weather","type":"output_text"}],"role":"assistant","type":"message"},{"arguments":"{\"city\":\"Seoul\"}","call_id":"call-new","name":"weather","type":"function_call"},{"call_id":"call-new","output":[{"text":"Sunny, 19C","type":"input_text"}],"type":"function_call_output"}]"#
        );

        let input = slice_responses_input_to_latest_tool_turn_json(
            r#"[
                {"type":"message","role":"user","content":[{"type":"input_text","text":"Question"}]},
                {"type":"function_call","call_id":"call-complete","name":"search","arguments":"{}"},
                {"type":"function_call","call_id":"call-dangling","name":"search","arguments":"{}"},
                {"type":"function_call_output","call_id":"call-complete","output":[{"type":"input_text","text":"done"}]}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            input,
            r#"[{"content":[{"text":"Question","type":"input_text"}],"role":"user","type":"message"},{"arguments":"{}","call_id":"call-complete","name":"search","type":"function_call"},{"call_id":"call-complete","output":[{"text":"done","type":"input_text"}],"type":"function_call_output"}]"#
        );
    }

    #[test]
    fn converts_tool_definitions_to_responses_tools() {
        let tools = tool_definitions_to_responses_tools_json(
            r#"[{"name":"weather","description":"Get weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}}}}]"#,
        )
        .unwrap();
        assert_eq!(
            tools,
            r#"[{"description":"Get weather","name":"weather","parameters":{"properties":{"city":{"type":"string"}},"type":"object"},"strict":false,"type":"function"}]"#
        );
    }
}
