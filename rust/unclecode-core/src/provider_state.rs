use serde_json::{json, Value};

use crate::anthropic_request::build_anthropic_user_message_json;
use crate::gemini_request::build_gemini_user_content_json;
use crate::provider_request::build_openai_user_message_json;
use crate::provider_trace::provider_tool_result_turn_entries_json;

pub fn reset_provider_turn_state_json(
    provider: &str,
    system_prompt: &str,
) -> Result<String, String> {
    let state = match provider {
        "openai" => vec![json!({ "role": "system", "content": system_prompt })],
        "anthropic" | "gemini" => Vec::new(),
        _ => {
            return Err(
                "Usage: unclecode rust provider reset-state <openai|anthropic|gemini>".to_string(),
            )
        }
    };

    serde_json::to_string(&json!({
        "provider": provider,
        "state": state
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_provider_runtime_settings_json(
    provider: &str,
    current_model: &str,
    current_reasoning_json: &str,
    settings_json: &str,
) -> Result<String, String> {
    match provider {
        "openai" | "anthropic" | "gemini" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider runtime-settings <openai|anthropic|gemini> <current-model>"
                    .to_string(),
            )
        }
    }

    let settings = parse_object(settings_json, "settings")?;
    let model = settings
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| current_model.trim())
        .to_string();

    let reasoning = if provider == "openai" {
        settings
            .get("reasoning")
            .cloned()
            .or_else(|| parse_optional_json_value(current_reasoning_json))
    } else {
        None
    };

    serde_json::to_string(&json!({
        "provider": provider,
        "model": model,
        "reasoning": reasoning,
    }))
    .map_err(|error| error.to_string())
}

pub fn append_provider_turn_state_json(
    provider: &str,
    state_json: &str,
    entries_json: &str,
) -> Result<String, String> {
    match provider {
        "openai" | "anthropic" | "gemini" => {}
        _ => {
            return Err(
                "Usage: unclecode rust provider append-state <openai|anthropic|gemini>".to_string(),
            )
        }
    }

    let mut state = parse_array(state_json, "state")?;
    let entries = parse_array(entries_json, "entries")?;
    state.extend(entries);

    serde_json::to_string(&json!({
        "provider": provider,
        "state": state
    }))
    .map_err(|error| error.to_string())
}

pub fn start_provider_turn_state_json(
    provider: &str,
    state_json: &str,
    prompt: &str,
    attachments_json: &str,
) -> Result<String, String> {
    let entry_raw = match provider {
        "openai" => build_openai_user_message_json(prompt, attachments_json)?,
        "anthropic" => build_anthropic_user_message_json(prompt, attachments_json)?,
        "gemini" => build_gemini_user_content_json(prompt, attachments_json)?,
        _ => {
            return Err(
                "Usage: unclecode rust provider start-turn <openai|anthropic|gemini> <prompt>"
                    .to_string(),
            )
        }
    };
    let entry = serde_json::from_str::<Value>(&entry_raw)
        .map_err(|error| format!("Invalid generated user entry JSON: {error}"))?;
    append_provider_turn_state_json(
        provider,
        state_json,
        &serde_json::to_string(&vec![entry]).map_err(|error| error.to_string())?,
    )
}

pub fn append_provider_tool_result_turn_json(
    provider: &str,
    state_json: &str,
    outcomes_json: &str,
) -> Result<String, String> {
    let entries_raw = provider_tool_result_turn_entries_json(provider, outcomes_json)?;
    let entries_payload = serde_json::from_str::<Value>(&entries_raw)
        .map_err(|error| format!("Invalid generated tool result entries JSON: {error}"))?;
    let entries = entries_payload
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .ok_or("Generated tool result entries JSON must include entries array")?;
    append_provider_turn_state_json(
        provider,
        state_json,
        &serde_json::to_string(&entries).map_err(|error| error.to_string())?,
    )
}

fn parse_array(source: &str, name: &str) -> Result<Vec<Value>, String> {
    let input = if source.trim().is_empty() {
        "[]"
    } else {
        source
    };
    let parsed = serde_json::from_str::<Value>(input)
        .map_err(|error| format!("Invalid {name} JSON: {error}"))?;
    parsed
        .as_array()
        .cloned()
        .ok_or_else(|| format!("{name} JSON must be an array"))
}

fn parse_object(source: &str, name: &str) -> Result<serde_json::Map<String, Value>, String> {
    let input = if source.trim().is_empty() {
        "{}"
    } else {
        source
    };
    let parsed = serde_json::from_str::<Value>(input)
        .map_err(|error| format!("Invalid {name} JSON: {error}"))?;
    parsed
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{name} JSON must be an object"))
}

fn parse_optional_json_value(source: &str) -> Option<Value> {
    let input = source.trim();
    if input.is_empty() || input == "-" {
        return None;
    }
    serde_json::from_str::<Value>(input).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resets_provider_turn_state_by_provider_shape() {
        let raw = reset_provider_turn_state_json("openai", "system prompt").expect("state");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["provider"], "openai");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 1);
        assert_eq!(parsed["state"][0]["role"], "system");
        assert_eq!(parsed["state"][0]["content"], "system prompt");

        let raw = reset_provider_turn_state_json("gemini", "ignored").expect("state");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["provider"], "gemini");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 0);

        assert!(reset_provider_turn_state_json("unknown", "").is_err());
    }

    #[test]
    fn resolves_provider_runtime_settings_by_provider() {
        let raw = resolve_provider_runtime_settings_json(
            "openai",
            "gpt-5.4",
            r#"{"effort":"high","support":{"status":"supported"}}"#,
            r#"{"model":" gpt-5.5 ","reasoning":{"effort":"low","support":{"status":"supported"}}}"#,
        )
        .expect("settings");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["provider"], "openai");
        assert_eq!(parsed["model"], "gpt-5.5");
        assert_eq!(parsed["reasoning"]["effort"], "low");

        let raw = resolve_provider_runtime_settings_json(
            "gemini",
            "gemini-2.5-pro",
            r#"{"effort":"high"}"#,
            r#"{"model":"   "}"#,
        )
        .expect("settings");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["provider"], "gemini");
        assert_eq!(parsed["model"], "gemini-2.5-pro");
        assert!(parsed["reasoning"].is_null());
    }

    #[test]
    fn appends_provider_turn_state_entries() {
        let raw = append_provider_turn_state_json(
            "anthropic",
            r#"[{"role":"user","content":"hi"}]"#,
            r#"[{"role":"assistant","content":[{"type":"text","text":"ok"}]}]"#,
        )
        .expect("state");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["provider"], "anthropic");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 2);
        assert_eq!(parsed["state"][1]["role"], "assistant");
    }

    #[test]
    fn starts_provider_turn_with_provider_specific_user_entry() {
        let raw = start_provider_turn_state_json(
            "openai",
            r#"[{"role":"system","content":"s"}]"#,
            "inspect",
            "[]",
        )
        .expect("state");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["provider"], "openai");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 2);
        assert_eq!(parsed["state"][1]["role"], "user");
        assert_eq!(parsed["state"][1]["content"], "inspect");

        let raw = start_provider_turn_state_json("gemini", "[]", "inspect", "[]").expect("state");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["state"][0]["role"], "user");
        assert!(parsed["state"][0]["parts"].is_array());
    }

    #[test]
    fn rejects_non_array_state_entries() {
        assert!(append_provider_turn_state_json("openai", "{}", "[]").is_err());
        assert!(append_provider_turn_state_json("gemini", "[]", "{}").is_err());
    }

    #[test]
    fn appends_provider_tool_result_turn() {
        let raw = append_provider_tool_result_turn_json(
            "gemini",
            r#"[{"role":"user","parts":[{"text":"run"}]}]"#,
            r#"[{"toolName":"read","toolCallId":"fc_1","kind":"success","isError":false,"content":"ok"}]"#,
        )
        .expect("state");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["provider"], "gemini");
        assert_eq!(parsed["state"].as_array().expect("array").len(), 2);
        assert_eq!(parsed["state"][1]["role"], "user");
        assert_eq!(
            parsed["state"][1]["parts"][0]["functionResponse"]["response"]["content"],
            "ok"
        );
    }
}
