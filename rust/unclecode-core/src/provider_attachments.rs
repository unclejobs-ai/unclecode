use serde_json::{json, Value};

const PROVIDER_MAX_ATTACHMENT_COUNT: usize = 5;
const PROVIDER_MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

pub fn cap_provider_attachments_result_json(attachments_json: &str) -> Result<String, String> {
    let attachments = parse_attachments(attachments_json)?;
    let capped = cap_provider_attachments_values(&attachments);
    let changed = capped.len() != attachments.len()
        || capped
            .iter()
            .zip(attachments.iter())
            .any(|(left, right)| left != right);

    serde_json::to_string(&json!({
        "changed": changed,
        "attachments": capped
    }))
    .map_err(|error| error.to_string())
}

pub fn cap_provider_attachments_json(attachments_json: &str) -> Result<String, String> {
    let attachments = parse_attachments(attachments_json)?;
    serde_json::to_string(&cap_provider_attachments_values(&attachments))
        .map_err(|error| error.to_string())
}

pub fn cap_provider_attachments_values(attachments: &[Value]) -> Vec<Value> {
    if attachments.len() <= PROVIDER_MAX_ATTACHMENT_COUNT
        && attachments.iter().all(|attachment| {
            attachment_data_url_bytes(attachment) <= PROVIDER_MAX_ATTACHMENT_BYTES
        })
    {
        return attachments.to_vec();
    }

    attachments
        .iter()
        .filter(|attachment| attachment_data_url_bytes(attachment) <= PROVIDER_MAX_ATTACHMENT_BYTES)
        .take(PROVIDER_MAX_ATTACHMENT_COUNT)
        .cloned()
        .collect()
}

fn parse_attachments(attachments_json: &str) -> Result<Vec<Value>, String> {
    let input = if attachments_json.trim().is_empty() {
        "[]"
    } else {
        attachments_json
    };
    let parsed = serde_json::from_str::<Value>(input)
        .map_err(|error| format!("Invalid provider attachments JSON: {error}"))?;
    parsed
        .as_array()
        .cloned()
        .ok_or("Provider attachments JSON must be an array".to_string())
}

fn attachment_data_url_bytes(attachment: &Value) -> usize {
    attachment
        .get("dataUrl")
        .and_then(Value::as_str)
        .map(estimate_data_url_bytes)
        .unwrap_or(0)
}

fn estimate_data_url_bytes(data_url: &str) -> usize {
    let payload = data_url
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(data_url);
    let trailing_pad = payload
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count();
    (payload.len() * 3 / 4).saturating_sub(trailing_pad)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(data_url: &str) -> Value {
        json!({
            "type": "image",
            "mimeType": "image/png",
            "dataUrl": data_url,
            "path": "(clipboard)",
            "displayName": "a.png"
        })
    }

    #[test]
    fn reports_unchanged_when_under_caps() {
        let raw = cap_provider_attachments_result_json(
            r#"[{"type":"image","mimeType":"image/png","dataUrl":"data:image/png;base64,aGVsbG8="}]"#,
        )
        .expect("caps");
        let parsed: Value = serde_json::from_str(&raw).expect("json");

        assert_eq!(parsed["changed"], false);
        assert_eq!(parsed["attachments"].as_array().expect("array").len(), 1);
    }

    #[test]
    fn caps_count_and_oversized_items() {
        let small = attachment("data:image/png;base64,aGVsbG8=");
        let oversized = attachment(&format!(
            "data:image/png;base64,{}",
            "a".repeat((PROVIDER_MAX_ATTACHMENT_BYTES + 1) * 4 / 3 + 8)
        ));
        let attachments = json!([small, oversized, small, small, small, small, small]);
        let capped = cap_provider_attachments_values(attachments.as_array().expect("array"));

        assert_eq!(capped.len(), 5);
        assert!(capped
            .iter()
            .all(|item| item["dataUrl"] == small["dataUrl"]));
    }

    #[test]
    fn accepts_exact_size_boundary() {
        let payload_len = ((PROVIDER_MAX_ATTACHMENT_BYTES + 2) / 3) * 4;
        let attachment = attachment(&format!(
            "data:image/png;base64,{}=",
            "a".repeat(payload_len - 1)
        ));

        assert_eq!(
            attachment_data_url_bytes(&attachment),
            PROVIDER_MAX_ATTACHMENT_BYTES
        );
        assert_eq!(cap_provider_attachments_values(&[attachment]).len(), 1);
    }
}
