use crate::http_transport::resolve_proxy_policy;
use crate::model_registry::{provider_route_json, resolve_provider_route};
use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_status_command_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid status command JSON: {error}"))?;
    let line = input
        .get("line")
        .and_then(Value::as_str)
        .unwrap_or("/status");
    let panel_input = build_status_panel_input(&input)?;
    let panel =
        serde_json::from_str::<Value>(&build_ux_panel_json("status", &panel_input.to_string())?)
            .map_err(|error| format!("Invalid status panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "entries": [
            { "role": "user", "text": line },
            { "role": "system", "text": "Status shown. Live steps return on the next action." },
        ],
        "panel": panel,
    }))
    .map_err(|error| error.to_string())
}

pub(crate) fn build_status_panel_input(input: &Value) -> Result<Value, String> {
    let provider = input
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let model = input.get("model").and_then(Value::as_str).unwrap_or("");
    let mut panel_input = input.clone();
    if let Some(object) = panel_input.as_object_mut() {
        match resolve_provider_route(provider, Some(model)) {
            Ok(route) => match resolve_proxy_policy(&route.endpoint_url)
                .and_then(|proxy| provider_route_json(&route, &proxy))
                .and_then(|raw| {
                    serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())
                }) {
                Ok(route_value) => {
                    object.insert("route".to_string(), route_value);
                    object.remove("routeError");
                }
                Err(error) => {
                    object.insert("routeError".to_string(), Value::String(error));
                    object.remove("route");
                }
            },
            Err(error) => {
                object.insert("routeError".to_string(), Value::String(error));
                object.remove("route");
            }
        }
    }
    Ok(panel_input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_status_result_with_route_and_context() {
        let result = resolve_status_command_json(
            r#"{
                "line": "/status",
                "provider": "openai",
                "model": "gpt-5.4",
                "mode": "default",
                "cwd": "/repo",
                "reasoningLabel": "medium (mode-default)",
                "authLabel": "api-key-env",
                "contextSummaryLines": ["Loaded guidance: AGENTS.md"],
                "bridgeLines": ["bridge ready"],
                "memoryLines": [],
                "traceLines": []
            }"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["entries"][1]["text"],
            "Status shown. Live steps return on the next action."
        );
        assert_eq!(parsed["panel"]["title"], "Session status");
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Runtime · OpenAI")));
        assert!(parsed["panel"]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Sources · guidance")));
    }
}
