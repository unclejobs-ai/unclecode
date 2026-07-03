use unclecode_core::auth::{openai_auth_supports_api_calls, OpenAIAuthStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SavedAuthLoginDecision {
    UseSaved,
    ContinueLogin,
}

pub(crate) fn saved_auth_login_decision(
    status: &OpenAIAuthStatus,
    can_start_api_oauth: bool,
) -> Result<SavedAuthLoginDecision, String> {
    if status.active_source == "none" {
        return Ok(SavedAuthLoginDecision::ContinueLogin);
    }
    if openai_auth_supports_api_calls(status) {
        return Ok(SavedAuthLoginDecision::UseSaved);
    }
    if can_start_api_oauth
        || (status.is_expired && status.expires_at.as_deref() != Some("insufficient-scope"))
    {
        return Ok(SavedAuthLoginDecision::ContinueLogin);
    }
    Err(format!(
        "Saved OAuth was found at {} but it is not API-ready for OpenAI API tool calling (runtime: {}). Use `OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser` or `unclecode auth login --api-key-stdin`.",
        status.active_source,
        status.runtime.as_deref().unwrap_or("none")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_codex_oauth_does_not_short_circuit_api_ready_login() {
        let status = OpenAIAuthStatus {
            active_source: "oauth-file".to_string(),
            auth_type: "oauth".to_string(),
            organization_id: None,
            project_id: None,
            runtime: Some("codex".to_string()),
            expires_at: None,
            is_expired: false,
        };

        assert_eq!(
            saved_auth_login_decision(&status, true).unwrap(),
            SavedAuthLoginDecision::ContinueLogin
        );
        let error = saved_auth_login_decision(&status, false).unwrap_err();
        assert!(error.contains("not API-ready"));
        assert!(error.contains("OPENAI_OAUTH_CLIENT_ID"));
    }

    #[test]
    fn saved_insufficient_scope_oauth_reports_api_ready_recovery() {
        let status = OpenAIAuthStatus {
            active_source: "oauth-file".to_string(),
            auth_type: "oauth".to_string(),
            organization_id: None,
            project_id: None,
            runtime: None,
            expires_at: Some("insufficient-scope".to_string()),
            is_expired: true,
        };

        assert_eq!(
            saved_auth_login_decision(&status, true).unwrap(),
            SavedAuthLoginDecision::ContinueLogin
        );
        let error = saved_auth_login_decision(&status, false).unwrap_err();
        assert!(error.contains("not API-ready"));
        assert!(error.contains("oauth-file"));
    }
}
