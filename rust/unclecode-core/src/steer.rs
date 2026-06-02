use serde_json::{json, Value};

pub fn resolve_busy_submit_json(line: &str, queued_count: usize) -> Result<String, String> {
    let value = resolve_busy_submit_value(line, queued_count);
    serde_json::to_string(&value)
        .map_err(|error| format!("Failed to serialize steer action: {error}"))
}

pub fn resolve_drain_start_json(
    is_draining: bool,
    is_busy: bool,
    queued_count: usize,
) -> Result<String, String> {
    let action = if is_draining || is_busy || queued_count == 0 {
        "skip"
    } else {
        "drain"
    };
    serde_json::to_string(&json!({ "action": action }))
        .map_err(|error| format!("Failed to serialize drain start action: {error}"))
}

pub fn resolve_drain_step_json(item_json: &str, queued_count: usize) -> Result<String, String> {
    let item: Value = serde_json::from_str(item_json.trim())
        .map_err(|error| format!("Invalid drain item JSON: {error}"))?;
    if item.is_null() {
        return serde_json::to_string(&json!({
            "action": "empty",
            "queuedCount": 0,
        }))
        .map_err(|error| format!("Failed to serialize drain step action: {error}"));
    }

    let id = item
        .get("id")
        .and_then(Value::as_u64)
        .ok_or("Invalid drain item JSON: missing id")?;
    let line = item
        .get("line")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or("Invalid drain item JSON: missing line")?;

    serde_json::to_string(&json!({
        "action": "run",
        "queuedCount": queued_count.saturating_sub(1),
        "message": format!("Running queued follow-up #{id}: {}", compact_preview(line, 72)),
        "item": {
            "id": id,
            "line": line,
        }
    }))
    .map_err(|error| format!("Failed to serialize drain step action: {error}"))
}

fn resolve_busy_submit_value(line: &str, queued_count: usize) -> Value {
    let line = line.trim();
    if line.is_empty() {
        return json!({
            "action": "ignore",
        });
    }
    if line == "/queue" {
        return json!({
            "action": "show_queue",
            "line": line,
        });
    }
    if line == "/queue clear" {
        return json!({
            "action": "clear_queue",
            "line": line,
            "message": "Queue cleared. Active turn is still running.",
        });
    }
    if line.starts_with('/') {
        return json!({
            "action": "reject_slash",
            "line": line,
            "message": "Busy. Slash commands are not queued. Wait for this turn, or open /queue to inspect pending follow-ups.",
        });
    }

    json!({
        "action": "queue",
        "line": line,
        "displayIndex": queued_count.saturating_add(1),
        "message": format!(
            "Queued follow-up #{}. It will run automatically after the active turn. /queue shows backlog; /queue clear drops queued follow-ups.",
            queued_count.saturating_add(1)
        ),
    })
}

fn compact_preview(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let keep = limit.saturating_sub(1);
    format!("{}…", trimmed.chars().take(keep).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_busy_queue_surface() {
        assert_eq!(
            resolve_busy_submit_json("/queue", 0).expect("json"),
            r#"{"action":"show_queue","line":"/queue"}"#
        );
    }

    #[test]
    fn rejects_busy_slash_commands() {
        let value = resolve_busy_submit_value("/model gpt-5.4", 0);
        assert_eq!(value["action"], "reject_slash");
        assert_eq!(
            value["message"],
            "Busy. Slash commands are not queued. Wait for this turn, or open /queue to inspect pending follow-ups."
        );
    }

    #[test]
    fn clears_queue_while_busy() {
        let value = resolve_busy_submit_value("/queue clear", 2);
        assert_eq!(value["action"], "clear_queue");
        assert_eq!(value["line"], "/queue clear");
        assert_eq!(
            value["message"],
            "Queue cleared. Active turn is still running."
        );
    }

    #[test]
    fn queues_busy_chat_with_display_index() {
        let value = resolve_busy_submit_value("  next task  ", 2);
        assert_eq!(value["action"], "queue");
        assert_eq!(value["line"], "next task");
        assert_eq!(value["displayIndex"], 3);
        assert_eq!(
            value["message"],
            "Queued follow-up #3. It will run automatically after the active turn. /queue shows backlog; /queue clear drops queued follow-ups."
        );
    }

    #[test]
    fn resolves_drain_start_state() {
        assert_eq!(
            resolve_drain_start_json(false, false, 1).expect("json"),
            r#"{"action":"drain"}"#
        );
        assert_eq!(
            resolve_drain_start_json(true, false, 1).expect("json"),
            r#"{"action":"skip"}"#
        );
        assert_eq!(
            resolve_drain_start_json(false, true, 1).expect("json"),
            r#"{"action":"skip"}"#
        );
        assert_eq!(
            resolve_drain_start_json(false, false, 0).expect("json"),
            r#"{"action":"skip"}"#
        );
    }

    #[test]
    fn resolves_drain_step_state() {
        assert_eq!(
            resolve_drain_step_json("null", 1).expect("json"),
            r#"{"action":"empty","queuedCount":0}"#
        );
        let value = serde_json::from_str::<Value>(
            &resolve_drain_step_json(r#"{"id":2,"line":" next "}"#, 3).expect("json"),
        )
        .expect("value");
        assert_eq!(value["action"], "run");
        assert_eq!(value["queuedCount"], 2);
        assert_eq!(value["message"], "Running queued follow-up #2: next");
        assert_eq!(value["item"]["id"], 2);
        assert_eq!(value["item"]["line"], "next");
    }
}
