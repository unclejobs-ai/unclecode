use crate::http_transport::{describe_proxy_policy, resolve_proxy_policy};
use crate::model_registry::resolve_provider_route;

pub fn provider_request_error_message(
    provider: &str,
    status: u16,
    response_body: &str,
    attempts: Option<usize>,
) -> Result<String, String> {
    let route = resolve_provider_route(provider, None)?;
    let proxy = resolve_proxy_policy(&route.endpoint_url)?;
    let body = response_body.trim();
    let mut lines = vec![
        format!("{} request failed with status {}", route.label, status),
        format!("Route · {} · {}", route.provider_id, route.endpoint_url),
        format!("Proxy · {}", describe_proxy_policy(&proxy)),
        format!("Auth · {}", describe_auth_state(status)),
        format!("Retry · {}", describe_retry_state(status, attempts)),
    ];
    if !body.is_empty() {
        lines.push(format!("Response · {}", compact_body(body, 320)));
    }
    Ok(lines.join("\n"))
}

fn describe_auth_state(status: u16) -> &'static str {
    match status {
        401 => "rejected credentials; inspect /auth status or refresh login",
        403 => "credentials accepted but permission/scope denied",
        429 => "provider rate limit or quota gate",
        _ => "not the primary signal",
    }
}

fn describe_retry_state(status: u16, attempts: Option<usize>) -> String {
    let prefix = attempts
        .map(|attempts| format!("{attempts} attempt{}", if attempts == 1 { "" } else { "s" }))
        .unwrap_or_else(|| "attempt count unavailable".to_string());
    if matches!(status, 429 | 500 | 502 | 503 | 504) {
        format!("{prefix}; transient status")
    } else {
        format!("{prefix}; not retryable by default")
    }
}

fn compact_body(body: &str, max_chars: usize) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    normalized
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>()
        + "..."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_provider_request_error_without_body() {
        let message = provider_request_error_message("openai", 401, " \n", Some(1)).unwrap();
        assert!(message.contains("OpenAI request failed with status 401"));
        assert!(message.contains("Route · openai · https://api.openai.com/v1/responses"));
        assert!(message.contains("Auth · rejected credentials"));
        assert!(message.contains("Retry · 1 attempt; not retryable by default"));
    }

    #[test]
    fn formats_provider_request_error_with_trimmed_body() {
        let message = provider_request_error_message("anthropic", 500, " boom\n", Some(3)).unwrap();
        assert!(message.contains("Anthropic request failed with status 500"));
        assert!(message.contains("Route · anthropic · https://api.anthropic.com/v1/messages"));
        assert!(message.contains("Retry · 3 attempts; transient status"));
        assert!(message.contains("Response · boom"));
    }
}
