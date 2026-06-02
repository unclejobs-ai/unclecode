use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::redaction::redact_secrets;
use crate::{http_transport::resolve_proxy_policy, model_registry::resolve_provider_route};

pub fn provider_turn_started_trace_json(
    provider: &str,
    model: &str,
    prompt: &str,
    started_at: u64,
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "type": "turn.started",
        "level": "low-signal",
        "provider": provider.trim(),
        "model": model.trim(),
        "prompt": redact_secrets(prompt),
        "startedAt": started_at
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_route_trace_json(
    provider: &str,
    model: &str,
    started_at: u64,
) -> Result<String, String> {
    let provider = provider.trim();
    let model = model.trim();
    let trace = match resolve_provider_route(provider, Some(model)) {
        Ok(route) => {
            let proxy = resolve_proxy_policy(&route.endpoint_url)?;
            json!({
                "type": "provider.route",
                "level": "default",
                "provider": route.provider_id,
                "model": model,
                "label": route.label,
                "transport": route.transport,
                "runtimeSupported": route.runtime_supported,
                "endpointUrl": route.endpoint_url,
                "proxyPolicy": {
                    "proxyUrl": proxy.proxy_url,
                    "source": proxy.source,
                    "bypassed": proxy.bypassed,
                    "targetHost": proxy.target_host,
                    "noProxy": proxy.no_proxy,
                },
                "startedAt": started_at
            })
        }
        Err(error) => json!({
            "type": "provider.route",
            "level": "default",
            "provider": if provider.is_empty() { "unknown" } else { provider },
            "model": model,
            "error": error,
            "startedAt": started_at
        }),
    };
    serde_json::to_string(&trace).map_err(|error| error.to_string())
}

pub fn provider_calling_trace_json(
    provider: &str,
    model: &str,
    started_at: u64,
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "type": "provider.calling",
        "level": "default",
        "provider": provider.trim(),
        "model": model.trim(),
        "startedAt": started_at
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_turn_completed_trace_json(
    provider: &str,
    model: &str,
    text: &str,
    started_at: u64,
    completed_at: u64,
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "type": "turn.completed",
        "level": "low-signal",
        "provider": provider.trim(),
        "model": model.trim(),
        "text": redact_secrets(text),
        "startedAt": started_at,
        "completedAt": completed_at,
        "durationMs": completed_at.saturating_sub(started_at)
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_reasoning_delta_trace_json(
    provider: &str,
    model: &str,
    kind: &str,
    delta: &str,
) -> Result<String, String> {
    match provider {
        "openai" | "anthropic" | "gemini" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider reasoning-delta <openai|anthropic|gemini> <model> <summary|text>"
                    .to_string(),
            )
        }
    }
    match kind {
        "summary" | "text" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider reasoning-delta <openai|anthropic|gemini> <model> <summary|text>"
                    .to_string(),
            )
        }
    }

    serde_json::to_string(&json!({
        "type": "reasoning.delta",
        "level": "default",
        "provider": provider,
        "model": model,
        "kind": kind,
        "itemId": format!("chat_{}", current_epoch_ms()),
        "delta": redact_secrets(delta)
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_reasoning_delta_trace_with_item_id_json(
    provider: &str,
    model: &str,
    kind: &str,
    item_id: &str,
    delta: &str,
) -> Result<String, String> {
    validate_reasoning_delta_args(provider, kind)?;
    if item_id.trim().is_empty() {
        return Err(
            "Usage: unclecode rust provider reasoning-delta-record <openai|anthropic|gemini> <model> <summary|text> <item-id>"
                .to_string(),
        );
    }

    serde_json::to_string(&json!({
        "type": "reasoning.delta",
        "level": "default",
        "provider": provider,
        "model": model,
        "kind": kind,
        "itemId": item_id,
        "delta": redact_secrets(delta)
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_tool_started_trace_json(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    started_at: u64,
    input_json: &str,
) -> Result<String, String> {
    let input = serde_json::from_str::<Value>(input_json)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    serde_json::to_string(&json!({
        "type": "tool.started",
        "level": "default",
        "provider": provider,
        "toolName": tool_name,
        "toolCallId": tool_call_id,
        "input": input,
        "startedAt": started_at
    }))
    .map_err(|error| error.to_string())
}

fn validate_reasoning_delta_args(provider: &str, kind: &str) -> Result<(), String> {
    match provider {
        "openai" | "anthropic" | "gemini" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider reasoning-delta <openai|anthropic|gemini> <model> <summary|text>"
                    .to_string(),
            )
        }
    }
    match kind {
        "summary" | "text" => Ok(()),
        _ => Err(
            "Usage: unclecode rust provider reasoning-delta <openai|anthropic|gemini> <model> <summary|text>"
                .to_string(),
        ),
    }
}

pub fn provider_tool_execution_start_json(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    input_json: &str,
) -> Result<String, String> {
    let started_at = current_epoch_ms();
    let trace = serde_json::from_str::<Value>(&provider_tool_started_trace_json(
        provider,
        tool_name,
        tool_call_id,
        started_at,
        input_json,
    )?)
    .map_err(|error| error.to_string())?;

    serde_json::to_string(&json!({
        "provider": provider,
        "startedAt": started_at,
        "trace": trace
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_tool_completed_trace_json(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    started_at: u64,
    completed_at: u64,
    is_error: bool,
    output: &str,
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "type": "tool.completed",
        "level": "default",
        "provider": provider,
        "toolName": tool_name,
        "toolCallId": tool_call_id,
        "isError": is_error,
        "output": output,
        "startedAt": started_at,
        "completedAt": completed_at,
        "durationMs": completed_at.saturating_sub(started_at)
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_tool_result_json(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    kind: &str,
    is_error: bool,
    content: &str,
) -> Result<String, String> {
    let payload =
        provider_tool_result_payload(provider, tool_name, tool_call_id, kind, is_error, content)?;

    serde_json::to_string(&json!({
        "provider": provider,
        "payload": payload
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_tool_result_turn_entries_json(
    provider: &str,
    outcomes_json: &str,
) -> Result<String, String> {
    let source = if outcomes_json.trim().is_empty() {
        "[]"
    } else {
        outcomes_json
    };
    let outcomes = serde_json::from_str::<Value>(source)
        .map_err(|error| format!("Invalid tool result outcomes JSON: {error}"))?;
    let outcomes = outcomes
        .as_array()
        .ok_or("Tool result outcomes JSON must be an array")?;

    let mut payloads = Vec::with_capacity(outcomes.len());
    for outcome in outcomes {
        let outcome = outcome
            .as_object()
            .ok_or("Tool result outcome must be an object")?;
        let tool_name = required_string(outcome.get("toolName"), "toolName")?;
        let tool_call_id = required_string(outcome.get("toolCallId"), "toolCallId")?;
        let kind = required_string(outcome.get("kind"), "kind")?;
        let is_error = outcome
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(kind == "error");
        let content = outcome.get("content").and_then(Value::as_str).unwrap_or("");
        payloads.push(provider_tool_result_payload(
            provider,
            tool_name,
            tool_call_id,
            kind,
            is_error,
            content,
        )?);
    }

    let entries =
        match provider {
            "openai" => payloads,
            "anthropic" => vec![provider_tool_result_container_value(provider, payloads)?],
            "gemini" => vec![provider_tool_result_container_value(provider, payloads)?],
            _ => return Err(
                "Usage: unclecode rust provider tool-result-turn-entries <openai|anthropic|gemini>"
                    .to_string(),
            ),
        };

    serde_json::to_string(&json!({
        "provider": provider,
        "entries": entries
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_tool_execution_result_json(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    started_at: u64,
    completed_at: u64,
    is_error: bool,
    content: &str,
) -> Result<String, String> {
    match provider {
        "openai" | "anthropic" | "gemini" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider tool-execution-result <openai|anthropic|gemini> <tool-name> <tool-call-id> <started-at> <completed-at> <is-error yes|no>"
                    .to_string(),
            )
        }
    }
    let kind = if is_error { "error" } else { "success" };
    let trace = serde_json::from_str::<Value>(&provider_tool_completed_trace_json(
        provider,
        tool_name,
        tool_call_id,
        started_at,
        completed_at,
        is_error,
        content,
    )?)
    .map_err(|error| error.to_string())?;

    serde_json::to_string(&json!({
        "provider": provider,
        "trace": trace,
        "outcome": {
            "toolName": tool_name,
            "toolCallId": tool_call_id,
            "kind": kind,
            "isError": is_error,
            "content": content
        }
    }))
    .map_err(|error| error.to_string())
}

pub fn provider_tool_execution_finish_json(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    started_at: u64,
    is_error: bool,
    content: &str,
) -> Result<String, String> {
    provider_tool_execution_result_json(
        provider,
        tool_name,
        tool_call_id,
        started_at,
        current_epoch_ms(),
        is_error,
        content,
    )
}

pub fn provider_tool_execution_finish_result_json(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    started_at: u64,
    result_json: &str,
) -> Result<String, String> {
    let source = if result_json.trim().is_empty() {
        "{}"
    } else {
        result_json
    };
    let result = serde_json::from_str::<Value>(source)
        .map_err(|error| format!("Invalid tool handler result JSON: {error}"))?;
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = result.get("content").and_then(Value::as_str).unwrap_or("");
    provider_tool_execution_finish_json(
        provider,
        tool_name,
        tool_call_id,
        started_at,
        is_error,
        content,
    )
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn provider_tool_result_payload(
    provider: &str,
    tool_name: &str,
    tool_call_id: &str,
    kind: &str,
    is_error: bool,
    content: &str,
) -> Result<Value, String> {
    Ok(match provider {
        "openai" => json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content
        }),
        "anthropic" => json!({
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": content,
            "is_error": is_error
        }),
        "gemini" => {
            let response = if kind == "error" {
                json!({ "error": content })
            } else {
                json!({ "content": content, "isError": is_error })
            };
            json!({
                "functionResponse": {
                    "name": tool_name,
                    "id": tool_call_id,
                    "response": response
                }
            })
        }
        _ => {
            return Err(
                "Usage: unclecode rust provider tool-result <openai|anthropic|gemini> <tool-name> <tool-call-id> <success|error> <is-error yes|no>".to_string(),
            )
        }
    })
}

pub fn provider_tool_result_container_json(
    provider: &str,
    tool_results_json: &str,
) -> Result<String, String> {
    let source = if tool_results_json.trim().is_empty() {
        "[]"
    } else {
        tool_results_json
    };
    let tool_results = serde_json::from_str::<Value>(source)
        .map_err(|error| format!("Invalid tool results JSON: {error}"))?;
    let results = tool_results
        .as_array()
        .ok_or("Tool results JSON must be an array")?;

    let payload = provider_tool_result_container_value(provider, results.clone())?;

    serde_json::to_string(&json!({
        "provider": provider,
        "payload": payload
    }))
    .map_err(|error| error.to_string())
}

fn provider_tool_result_container_value(
    provider: &str,
    results: Vec<Value>,
) -> Result<Value, String> {
    Ok(match provider {
        "anthropic" => json!({
            "role": "user",
            "content": results
        }),
        "gemini" => json!({
            "role": "user",
            "parts": results
        }),
        _ => {
            return Err(
                "Usage: unclecode rust provider tool-result-container <anthropic|gemini>"
                    .to_string(),
            )
        }
    })
}

fn required_string<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a str, String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Tool result outcome missing {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_turn_lifecycle_traces_with_redaction_and_duration() {
        let openai_key = format!("{}{}", "sk-proj-", "a".repeat(30));
        let started: Value = serde_json::from_str(
            &provider_turn_started_trace_json(
                "openai",
                "gpt-5.4",
                &format!("inspect {openai_key}"),
                10,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(started["type"], "turn.started");
        assert_eq!(started["level"], "low-signal");
        assert_eq!(started["prompt"], "inspect [REDACTED]");

        let calling: Value =
            serde_json::from_str(&provider_calling_trace_json("openai", "gpt-5.4", 10).unwrap())
                .unwrap();
        assert_eq!(calling["type"], "provider.calling");
        assert_eq!(calling["startedAt"], 10);

        let completed: Value = serde_json::from_str(
            &provider_turn_completed_trace_json(
                "openai",
                "gpt-5.4",
                &format!("done {openai_key}"),
                10,
                25,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(completed["type"], "turn.completed");
        assert_eq!(completed["text"], "done [REDACTED]");
        assert_eq!(completed["durationMs"], 15);
    }

    #[test]
    fn builds_reasoning_delta_trace_with_redaction() {
        let openai_key = format!("{}{}", "sk-proj-", "1".repeat(20));
        let trace: Value = serde_json::from_str(
            &provider_reasoning_delta_trace_json(
                "openai",
                "gpt-5.4",
                "text",
                &format!("thinking {openai_key}"),
            )
            .expect("trace"),
        )
        .expect("json");

        assert_eq!(trace["type"], "reasoning.delta");
        assert_eq!(trace["provider"], "openai");
        assert_eq!(trace["model"], "gpt-5.4");
        assert_eq!(trace["kind"], "text");
        assert!(trace["itemId"]
            .as_str()
            .expect("item id")
            .starts_with("chat_"));
        assert_eq!(trace["delta"], "thinking [REDACTED]");
    }

    #[test]
    fn builds_provider_route_trace_with_proxy_policy() {
        let trace: Value =
            serde_json::from_str(&provider_route_trace_json("openai", "gpt-5.4", 42).unwrap())
                .unwrap();

        assert_eq!(trace["type"], "provider.route");
        assert_eq!(trace["provider"], "openai");
        assert_eq!(trace["label"], "OpenAI");
        assert_eq!(trace["endpointUrl"], "https://api.openai.com/v1/responses");
        assert_eq!(trace["proxyPolicy"]["targetHost"], "api.openai.com");
        assert_eq!(trace["startedAt"], 42);
    }

    #[test]
    fn builds_provider_route_trace_error_for_unknown_provider() {
        let trace: Value =
            serde_json::from_str(&provider_route_trace_json("unknown", "gpt-5.4", 42).unwrap())
                .unwrap();

        assert_eq!(trace["type"], "provider.route");
        assert_eq!(trace["provider"], "unknown");
        assert!(trace["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Unsupported runtime provider"));
    }

    #[test]
    fn builds_reasoning_delta_trace_with_stream_item_id() {
        let trace: Value = serde_json::from_str(
            &provider_reasoning_delta_trace_with_item_id_json(
                "openai",
                "gpt-5.4",
                "summary",
                "rs_123",
                "summary text",
            )
            .expect("trace"),
        )
        .expect("json");

        assert_eq!(trace["type"], "reasoning.delta");
        assert_eq!(trace["kind"], "summary");
        assert_eq!(trace["itemId"], "rs_123");
        assert_eq!(trace["delta"], "summary text");
    }

    #[test]
    fn builds_started_trace_with_object_input() {
        let trace: Value = serde_json::from_str(
            &provider_tool_started_trace_json("openai", "read", "call_1", 10, r#"{"path":"a"}"#)
                .expect("trace"),
        )
        .expect("json");
        assert_eq!(trace["type"], "tool.started");
        assert_eq!(trace["input"]["path"], "a");
    }

    #[test]
    fn builds_provider_tool_execution_start() {
        let started: Value = serde_json::from_str(
            &provider_tool_execution_start_json("openai", "read", "call_1", r#"{"path":"a"}"#)
                .expect("start"),
        )
        .expect("json");

        assert_eq!(started["trace"]["type"], "tool.started");
        assert_eq!(started["trace"]["input"]["path"], "a");
        assert!(started["startedAt"].as_u64().unwrap_or(0) > 0);
    }

    #[test]
    fn builds_completed_trace_duration() {
        let trace: Value = serde_json::from_str(
            &provider_tool_completed_trace_json("gemini", "run", "fc_1", 10, 15, true, "boom")
                .expect("trace"),
        )
        .expect("json");
        assert_eq!(trace["type"], "tool.completed");
        assert_eq!(trace["isError"], true);
        assert_eq!(trace["durationMs"], 5);
    }

    #[test]
    fn builds_provider_tool_result_payloads() {
        let openai: Value = serde_json::from_str(
            &provider_tool_result_json("openai", "read", "call_1", "success", false, "ok")
                .expect("openai"),
        )
        .expect("json");
        let gemini: Value = serde_json::from_str(
            &provider_tool_result_json("gemini", "read", "call_1", "error", true, "boom")
                .expect("gemini"),
        )
        .expect("json");

        assert_eq!(openai["payload"]["role"], "tool");
        assert_eq!(
            gemini["payload"]["functionResponse"]["response"]["error"],
            "boom"
        );
    }

    #[test]
    fn builds_provider_tool_result_turn_entries() {
        let openai: Value = serde_json::from_str(
            &provider_tool_result_turn_entries_json(
                "openai",
                r#"[{"toolName":"read","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]"#,
            )
            .expect("openai"),
        )
        .expect("json");
        let anthropic: Value = serde_json::from_str(
            &provider_tool_result_turn_entries_json(
                "anthropic",
                r#"[{"toolName":"read","toolCallId":"tu_1","kind":"error","isError":true,"content":"boom"}]"#,
            )
            .expect("anthropic"),
        )
        .expect("json");

        assert_eq!(openai["entries"][0]["role"], "tool");
        assert_eq!(anthropic["entries"][0]["role"], "user");
        assert_eq!(anthropic["entries"][0]["content"][0]["tool_use_id"], "tu_1");
    }

    #[test]
    fn builds_provider_tool_execution_result() {
        let result: Value = serde_json::from_str(
            &provider_tool_execution_result_json("openai", "read", "call_1", 10, 12, false, "ok")
                .expect("result"),
        )
        .expect("json");

        assert_eq!(result["trace"]["type"], "tool.completed");
        assert_eq!(result["trace"]["durationMs"], 2);
        assert_eq!(result["outcome"]["kind"], "success");
        assert_eq!(result["outcome"]["toolName"], "read");
    }

    #[test]
    fn builds_provider_tool_execution_finish_with_current_completed_at() {
        let result: Value = serde_json::from_str(
            &provider_tool_execution_finish_json("anthropic", "read", "tu_1", 1, true, "boom")
                .expect("finish"),
        )
        .expect("json");

        assert_eq!(result["trace"]["type"], "tool.completed");
        assert_eq!(result["trace"]["startedAt"], 1);
        assert!(result["trace"]["completedAt"].as_u64().unwrap_or(0) >= 1);
        assert_eq!(result["outcome"]["kind"], "error");
        assert_eq!(result["outcome"]["content"], "boom");
    }

    #[test]
    fn builds_provider_tool_execution_finish_from_handler_result() {
        let result: Value = serde_json::from_str(
            &provider_tool_execution_finish_result_json(
                "gemini",
                "read",
                "fc_1",
                1,
                r#"{"content":"ok"}"#,
            )
            .expect("finish"),
        )
        .expect("json");

        assert_eq!(result["trace"]["type"], "tool.completed");
        assert_eq!(result["outcome"]["kind"], "success");
        assert_eq!(result["outcome"]["isError"], false);
        assert_eq!(result["outcome"]["content"], "ok");
    }

    #[test]
    fn defaults_provider_tool_execution_finish_for_empty_handler_result() {
        let result: Value = serde_json::from_str(
            &provider_tool_execution_finish_result_json("openai", "read", "call_1", 1, "")
                .expect("finish"),
        )
        .expect("json");

        assert_eq!(result["outcome"]["kind"], "success");
        assert_eq!(result["outcome"]["isError"], false);
        assert_eq!(result["outcome"]["content"], "");
    }

    #[test]
    fn builds_provider_tool_result_containers() {
        let anthropic: Value = serde_json::from_str(
            &provider_tool_result_container_json(
                "anthropic",
                r#"[{"type":"tool_result","tool_use_id":"tu_1","content":"ok","is_error":false}]"#,
            )
            .expect("anthropic"),
        )
        .expect("json");
        let gemini: Value = serde_json::from_str(
            &provider_tool_result_container_json(
                "gemini",
                r#"[{"functionResponse":{"name":"read","id":"call_1","response":{"content":"ok"}}}]"#,
            )
            .expect("gemini"),
        )
        .expect("json");

        assert_eq!(anthropic["payload"]["role"], "user");
        assert_eq!(anthropic["payload"]["content"][0]["type"], "tool_result");
        assert_eq!(gemini["payload"]["role"], "user");
        assert_eq!(
            gemini["payload"]["parts"][0]["functionResponse"]["name"],
            "read"
        );
    }
}
