use crate::ux_panels::build_ux_panel_json;
use serde_json::{json, Value};

pub fn resolve_auth_progress_result_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid auth progress result JSON: {error}"))?;
    let progress_lines = input
        .get("progressLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let panel_input = json!({ "progressLines": progress_lines });
    let panel = serde_json::from_str::<Value>(&build_ux_panel_json(
        "auth-progress",
        &panel_input.to_string(),
    )?)
    .map_err(|error| format!("Invalid auth progress panel JSON: {error}"))?;

    serde_json::to_string(&json!({
        "patch": {
            "panel": panel
        }
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_auth_progress_panel_patch() {
        let result = resolve_auth_progress_result_json(
            r#"{"progressLines":["Opening browser…","Enter code: ABCD-1234","Waiting for device approval…"]}"#,
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["patch"]["panel"]["title"], "Auth");
        assert_eq!(
            parsed["patch"]["panel"]["lines"][0],
            "Enter code: ABCD-1234"
        );
        assert_eq!(
            parsed["patch"]["panel"]["lines"][1],
            "Waiting for device approval…"
        );
    }
}
