use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIAuthStatus {
    pub active_source: String,
    pub auth_type: String,
    pub organization_id: Option<String>,
    pub project_id: Option<String>,
    pub runtime: Option<String>,
    pub expires_at: Option<String>,
    pub is_expired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIAuthRecovery {
    pub reason: &'static str,
    pub preferred_fix: &'static str,
    pub commands: [&'static str; 4],
    pub verify: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedOpenAIAuth {
    pub status: String,
    pub auth_type: String,
    pub source: String,
    pub bearer_token: Option<String>,
    pub organization_id: Option<String>,
    pub project_id: Option<String>,
    pub account_id: Option<String>,
    pub runtime: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredApiKeyCredential {
    pub api_key: String,
    pub organization_id: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredOAuthCredential {
    pub access_token: String,
    pub refresh_token: String,
    pub organization_id: Option<String>,
    pub project_id: Option<String>,
    pub account_id: Option<String>,
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredOpenAICredential {
    ApiKey {
        api_key: String,
        organization_id: Option<String>,
        project_id: Option<String>,
    },
    OAuth {
        access_token: String,
        refresh_token: String,
        expires_at: Option<u64>,
        organization_id: Option<String>,
        project_id: Option<String>,
        account_id: Option<String>,
        runtime: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIOAuthTokenInspection {
    pub payload_valid: bool,
    pub client_id: Option<String>,
    pub has_model_request_scope: bool,
    pub expires_at: Option<u64>,
    pub is_expired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIOAuthTokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIDeviceAuthorizationResponse {
    pub device_code: Option<String>,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub expires_in: Option<u64>,
    pub interval: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAICodexDeviceAuthorizationResponse {
    pub device_auth_id: Option<String>,
    pub user_code: Option<String>,
    pub interval: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAICodexDeviceTokenResponse {
    pub authorization_code: Option<String>,
    pub code_verifier: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIAuthRequestSpec {
    pub url: String,
    pub content_type: String,
}

pub fn build_openai_auth_request_spec(
    kind: &str,
    base_url: Option<&str>,
) -> Result<OpenAIAuthRequestSpec, String> {
    let base = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://auth.openai.com")
        .trim()
        .trim_end_matches('/');
    let (path, content_type) = match kind {
        "device-code" => ("/oauth/device/code", "application/x-www-form-urlencoded"),
        "device-token" | "authorization-code" => {
            ("/oauth/token", "application/x-www-form-urlencoded")
        }
        "codex-device-code" => ("/api/accounts/deviceauth/usercode", "application/json"),
        "codex-device-token" => ("/api/accounts/deviceauth/token", "application/json"),
        _ => {
            return Err("Usage: unclecode rust auth request-spec <device-code|device-token|authorization-code|codex-device-code|codex-device-token> <base-url|->".to_string())
        }
    };

    Ok(OpenAIAuthRequestSpec {
        url: format!("{base}{path}"),
        content_type: content_type.to_string(),
    })
}

pub fn build_openai_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
    scopes: &[String],
    base_url: Option<&str>,
) -> String {
    let base = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://auth.openai.com")
        .trim_end_matches('/');
    let pairs = [
        ("client_id", client_id.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("response_type", "code".to_string()),
        ("state", state.to_string()),
        ("code_challenge", code_challenge.to_string()),
        ("code_challenge_method", "S256".to_string()),
        ("scope", scopes.join(" ")),
    ];
    let query = pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", url_form_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}/oauth/authorize?{query}")
}

pub fn parse_openai_callback_code(
    request_url: &str,
    expected_state: &str,
) -> Result<String, String> {
    let query = request_url
        .split_once('?')
        .map(|(_, query)| query.split_once('#').map(|(head, _)| head).unwrap_or(query))
        .unwrap_or("");
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = url_form_decode(raw_key)?;
        let value = url_form_decode(raw_value)?;
        match key.as_str() {
            "code" => code = Some(value),
            "state" => state = Some(value),
            _ => {}
        }
    }

    let Some(code) = code.filter(|value| !value.is_empty()) else {
        return Err("Missing authorization code.".to_string());
    };
    if state.as_deref() != Some(expected_state) {
        return Err("Invalid OAuth state.".to_string());
    }
    Ok(code)
}

pub fn build_openai_device_authorization_body(client_id: &str, scopes: &[String]) -> String {
    form_encode_pairs(&[
        ("client_id", client_id.to_string()),
        ("scope", scopes.join(" ")),
    ])
}

pub fn build_openai_device_token_body(client_id: &str, device_code: &str) -> String {
    form_encode_pairs(&[
        ("client_id", client_id.to_string()),
        ("device_code", device_code.to_string()),
        (
            "grant_type",
            "urn:ietf:params:oauth:grant-type:device_code".to_string(),
        ),
    ])
}

pub fn build_openai_authorization_code_token_body(
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> String {
    form_encode_pairs(&[
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("code_verifier", code_verifier.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("grant_type", "authorization_code".to_string()),
    ])
}

pub fn build_openai_codex_device_authorization_body(client_id: &str) -> String {
    format!("{{\"client_id\":\"{}\"}}", json_escape(client_id))
}

pub fn build_openai_codex_device_token_body(device_auth_id: &str, user_code: &str) -> String {
    format!(
        "{{\"device_auth_id\":\"{}\",\"user_code\":\"{}\"}}",
        json_escape(device_auth_id),
        json_escape(user_code)
    )
}

pub fn openai_credentials_path(env_get: impl Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(path) =
        normalize_credential(env_get("UNCLECODE_OPENAI_CREDENTIALS_PATH").as_deref())
    {
        return PathBuf::from(path);
    }
    let home = env_get("HOME").unwrap_or_else(|| ".".to_string());
    PathBuf::from(home).join(".unclecode/credentials/openai.json")
}

pub fn write_openai_api_key_credentials(
    path: PathBuf,
    credential: &StoredApiKeyCredential,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = format!(
        "{{\n  \"authType\": \"api-key\",\n  \"apiKey\": \"{}\",\n  \"organizationId\": {},\n  \"projectId\": {}\n}}\n",
        json_escape(&credential.api_key),
        json_optional_string(credential.organization_id.as_deref()),
        json_optional_string(credential.project_id.as_deref()),
    );
    fs::write(&path, serialized)?;
    set_private_file_permissions(&path)?;
    Ok(())
}

pub fn write_openai_oauth_credentials(
    path: PathBuf,
    credential: &StoredOAuthCredential,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = format!(
        "{{\n  \"authType\": \"oauth\",\n  \"accessToken\": \"{}\",\n  \"refreshToken\": \"{}\",\n  \"expiresAt\": null,\n  \"organizationId\": {},\n  \"projectId\": {},\n  \"accountId\": {},\n  \"runtime\": {}\n}}\n",
        json_escape(&credential.access_token),
        json_escape(&credential.refresh_token),
        json_optional_string(credential.organization_id.as_deref()),
        json_optional_string(credential.project_id.as_deref()),
        json_optional_string(credential.account_id.as_deref()),
        json_optional_string(credential.runtime.as_deref()),
    );
    fs::write(&path, serialized)?;
    set_private_file_permissions(&path)?;
    Ok(())
}

pub fn write_openai_raw_credentials(path: PathBuf, contents: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, contents)?;
    set_private_file_permissions(&path)?;
    Ok(())
}

pub fn read_openai_credentials_file(path: PathBuf) -> io::Result<Option<StoredOpenAICredential>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    Ok(parse_stored_openai_credential(&raw))
}

pub fn parse_openai_oauth_token_response(raw: &str) -> OpenAIOAuthTokenResponse {
    OpenAIOAuthTokenResponse {
        access_token: normalize_json_token(extract_json_string(raw, "access_token")),
        refresh_token: normalize_json_token(extract_json_string(raw, "refresh_token")),
        error: normalize_json_token(extract_json_string(raw, "error")),
    }
}

pub fn parse_openai_device_authorization_response(raw: &str) -> OpenAIDeviceAuthorizationResponse {
    OpenAIDeviceAuthorizationResponse {
        device_code: normalize_json_token(extract_json_string(raw, "device_code")),
        user_code: normalize_json_token(extract_json_string(raw, "user_code")),
        verification_uri: normalize_json_token(extract_json_string(raw, "verification_uri")),
        expires_in: extract_json_number(raw, "expires_in"),
        interval: extract_json_number(raw, "interval"),
        error: normalize_json_token(extract_json_string(raw, "error")),
    }
}

pub fn parse_openai_codex_device_authorization_response(
    raw: &str,
) -> OpenAICodexDeviceAuthorizationResponse {
    OpenAICodexDeviceAuthorizationResponse {
        device_auth_id: normalize_json_token(extract_json_string(raw, "device_auth_id")),
        user_code: normalize_json_token(extract_json_string(raw, "user_code")),
        interval: extract_json_number(raw, "interval"),
        error: normalize_json_token(extract_json_string(raw, "error")),
    }
}

pub fn parse_openai_codex_device_token_response(raw: &str) -> OpenAICodexDeviceTokenResponse {
    OpenAICodexDeviceTokenResponse {
        authorization_code: normalize_json_token(extract_json_string(raw, "authorization_code")),
        code_verifier: normalize_json_token(extract_json_string(raw, "code_verifier")),
        error: normalize_json_token(extract_json_string(raw, "error")),
    }
}

pub fn resolve_reusable_openai_oauth_client_id(
    env_get: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let home = env_get("HOME").unwrap_or_else(|| ".".to_string());
    let codex_auth_path = PathBuf::from(home).join(".codex/auth.json");
    if let Ok(raw) = fs::read_to_string(codex_auth_path) {
        let id_token = normalize_credential(
            extract_json_string(&raw, "idToken")
                .or_else(|| extract_json_string(&raw, "id_token"))
                .as_deref(),
        );
        let access_token = normalize_credential(
            extract_json_string(&raw, "accessToken")
                .or_else(|| extract_json_string(&raw, "access_token"))
                .as_deref(),
        );
        if let Some(client_id) = id_token
            .as_deref()
            .and_then(|token| inspect_openai_oauth_token(token).client_id)
        {
            return Some(client_id);
        }
        if let Some(client_id) = access_token
            .as_deref()
            .and_then(|token| inspect_openai_oauth_token(token).client_id)
        {
            return Some(client_id);
        }
    }

    normalize_credential(env_get("OPENAI_OAUTH_CLIENT_ID").as_deref())
}

pub fn clear_openai_credentials(path: PathBuf) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn resolve_openai_auth_status(env_get: impl Fn(&str) -> Option<String>) -> OpenAIAuthStatus {
    let resolved = resolve_openai_auth(env_get);
    OpenAIAuthStatus {
        active_source: match resolved.source.as_str() {
            "env-openai-auth-token" => "oauth-env".to_string(),
            "env-openai-api-key" => "api-key-env".to_string(),
            "unclecode-api-key-file" => "api-key-file".to_string(),
            "unclecode-auth-file" | "codex-auth-file" if resolved.auth_type == "api-key" => {
                "api-key-file".to_string()
            }
            "unclecode-auth-file" | "codex-auth-file" => "oauth-file".to_string(),
            _ => "none".to_string(),
        },
        auth_type: resolved.auth_type,
        organization_id: resolved.organization_id,
        project_id: resolved.project_id,
        runtime: resolved.runtime,
        expires_at: match resolved.reason.as_deref() {
            Some("auth-refresh-required") => Some("refresh-required".to_string()),
            Some("auth-insufficient-scope") => Some("insufficient-scope".to_string()),
            _ => None,
        },
        is_expired: resolved.status != "ok",
    }
}

pub fn openai_auth_supports_api_calls(status: &OpenAIAuthStatus) -> bool {
    status.active_source != "none"
        && !status.is_expired
        && !(status.auth_type == "oauth" && status.runtime.as_deref() == Some("codex"))
}

pub fn openai_auth_status_recovery(status: &OpenAIAuthStatus) -> Option<OpenAIAuthRecovery> {
    if openai_auth_supports_api_calls(status) {
        return None;
    }

    Some(OpenAIAuthRecovery {
        reason: openai_auth_recovery_reason(status),
        preferred_fix:
            "Run browser OAuth with an API-capable OpenAI OAuth client, or use API key login. Codex device OAuth can sign in but is not API-ready for OpenAI API calls.",
        commands: [
            "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
            "unclecode auth login --api-key-stdin",
            "OPENAI_API_KEY=<key> npm run qa:live",
            "npm run qa:live",
        ],
        verify: "npm run qa:live",
    })
}

fn openai_auth_recovery_reason(status: &OpenAIAuthStatus) -> &'static str {
    if status.active_source == "none" {
        return "openai-auth-missing";
    }
    if status.is_expired {
        return "openai-auth-needs-refresh";
    }
    if status.auth_type == "oauth" && status.runtime.as_deref() == Some("codex") {
        return "openai-oauth-codex-runtime-not-api-ready";
    }
    if status.auth_type == "oauth" {
        return "openai-oauth-insufficient-scope";
    }
    "openai-auth-not-api-ready"
}

pub fn resolve_openai_auth(env_get: impl Fn(&str) -> Option<String>) -> ResolvedOpenAIAuth {
    if let Some(token) = normalize_credential(env_get("OPENAI_AUTH_TOKEN").as_deref()) {
        if is_expired(&token) {
            return ResolvedOpenAIAuth {
                status: "expired".to_string(),
                auth_type: "oauth".to_string(),
                source: "env-openai-auth-token".to_string(),
                bearer_token: None,
                organization_id: normalize_credential(env_get("OPENAI_ORG_ID").as_deref()),
                project_id: normalize_credential(env_get("OPENAI_PROJECT_ID").as_deref()),
                account_id: None,
                runtime: None,
                reason: Some("auth-token-expired".to_string()),
            };
        }
        return ResolvedOpenAIAuth {
            status: "ok".to_string(),
            auth_type: "oauth".to_string(),
            source: "env-openai-auth-token".to_string(),
            bearer_token: Some(token.clone()),
            organization_id: normalize_credential(env_get("OPENAI_ORG_ID").as_deref()),
            project_id: normalize_credential(env_get("OPENAI_PROJECT_ID").as_deref()),
            account_id: None,
            runtime: Some(if has_required_model_request_scope(&token) {
                "api".to_string()
            } else {
                "codex".to_string()
            }),
            reason: None,
        };
    }

    if let Some(api_key) = normalize_credential(env_get("OPENAI_API_KEY").as_deref()) {
        return ResolvedOpenAIAuth {
            status: "ok".to_string(),
            auth_type: "api-key".to_string(),
            source: "env-openai-api-key".to_string(),
            bearer_token: Some(api_key),
            organization_id: normalize_credential(env_get("OPENAI_ORG_ID").as_deref()),
            project_id: normalize_credential(env_get("OPENAI_PROJECT_ID").as_deref()),
            account_id: None,
            runtime: None,
            reason: None,
        };
    }

    let home = env_get("HOME").unwrap_or_else(|| ".".to_string());
    let mut paths = Vec::new();
    if let Some(path) =
        normalize_credential(env_get("UNCLECODE_OPENAI_CREDENTIALS_PATH").as_deref())
    {
        paths.push(PathBuf::from(path));
    } else {
        paths.push(PathBuf::from(&home).join(".unclecode/credentials/openai.json"));
        paths.push(PathBuf::from(&home).join(".codex/auth.json"));
    }

    let mut best_failure: Option<ResolvedOpenAIAuth> = None;
    for path in paths {
        let source = if path.to_string_lossy().contains("/.codex/") {
            "codex-auth-file"
        } else {
            "unclecode-auth-file"
        };
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => {
                remember_failure(
                    &mut best_failure,
                    missing_resolved_auth("auth-file-missing"),
                );
                continue;
            }
        };
        if extract_json_string(&raw, "authType").as_deref() == Some("api-key") {
            if let Some(api_key) =
                normalize_credential(extract_json_string(&raw, "apiKey").as_deref())
            {
                return ResolvedOpenAIAuth {
                    status: "ok".to_string(),
                    auth_type: "api-key".to_string(),
                    source: "unclecode-api-key-file".to_string(),
                    bearer_token: Some(api_key),
                    organization_id: normalize_credential(
                        extract_json_string(&raw, "organizationId").as_deref(),
                    ),
                    project_id: normalize_credential(
                        extract_json_string(&raw, "projectId").as_deref(),
                    ),
                    account_id: None,
                    runtime: None,
                    reason: None,
                };
            }
        }

        let access_token = normalize_credential(
            extract_json_string(&raw, "accessToken").as_deref(),
        )
        .or_else(|| normalize_credential(extract_json_string(&raw, "access_token").as_deref()));
        let refresh_token = normalize_credential(
            extract_json_string(&raw, "refreshToken").as_deref(),
        )
        .or_else(|| normalize_credential(extract_json_string(&raw, "refresh_token").as_deref()));
        let runtime = extract_json_string(&raw, "runtime").or_else(|| {
            if source == "codex-auth-file" {
                Some("codex".to_string())
            } else {
                None
            }
        });
        let organization_id =
            normalize_credential(extract_json_string(&raw, "organizationId").as_deref());
        let project_id = normalize_credential(extract_json_string(&raw, "projectId").as_deref());
        let account_id = normalize_credential(extract_json_string(&raw, "accountId").as_deref())
            .or_else(|| normalize_credential(extract_json_string(&raw, "account_id").as_deref()));

        let Some(access_token) = access_token else {
            remember_failure(
                &mut best_failure,
                missing_resolved_auth("auth-token-missing"),
            );
            continue;
        };
        if is_expired(&access_token) {
            let status = ResolvedOpenAIAuth {
                status: if refresh_token.is_some() {
                    "missing"
                } else {
                    "expired"
                }
                .to_string(),
                auth_type: "oauth".to_string(),
                source: source.to_string(),
                bearer_token: None,
                organization_id: organization_id.clone(),
                project_id: project_id.clone(),
                account_id: None,
                runtime: None,
                reason: Some(if refresh_token.is_some() {
                    "auth-refresh-required".to_string()
                } else {
                    "auth-token-expired".to_string()
                }),
            };
            remember_failure(&mut best_failure, status);
            continue;
        }
        if !has_required_model_request_scope(&access_token) && runtime.as_deref() != Some("codex") {
            remember_failure(
                &mut best_failure,
                ResolvedOpenAIAuth {
                    status: "missing".to_string(),
                    auth_type: "oauth".to_string(),
                    source: source.to_string(),
                    bearer_token: None,
                    organization_id: organization_id.clone(),
                    project_id: project_id.clone(),
                    account_id: None,
                    runtime: None,
                    reason: Some("auth-insufficient-scope".to_string()),
                },
            );
            continue;
        }
        return ResolvedOpenAIAuth {
            status: "ok".to_string(),
            auth_type: "oauth".to_string(),
            source: source.to_string(),
            bearer_token: Some(access_token),
            organization_id,
            project_id,
            account_id,
            runtime: Some(runtime.unwrap_or_else(|| "api".to_string())),
            reason: None,
        };
    }

    best_failure.unwrap_or_else(|| missing_resolved_auth("auth-file-missing"))
}

fn missing_resolved_auth(reason: &str) -> ResolvedOpenAIAuth {
    ResolvedOpenAIAuth {
        status: "missing".to_string(),
        auth_type: "none".to_string(),
        source: "none".to_string(),
        bearer_token: None,
        organization_id: None,
        project_id: None,
        account_id: None,
        runtime: None,
        reason: Some(reason.to_string()),
    }
}

fn remember_failure(best: &mut Option<ResolvedOpenAIAuth>, candidate: ResolvedOpenAIAuth) {
    if failure_rank(&candidate) > best.as_ref().map(failure_rank).unwrap_or(0) {
        *best = Some(candidate);
    }
}

fn failure_rank(status: &ResolvedOpenAIAuth) -> u8 {
    match status.reason.as_deref() {
        Some("auth-insufficient-scope") => 4,
        Some("auth-refresh-required") => 3,
        Some("auth-token-expired") => 2,
        Some("auth-token-missing") => 1,
        _ => 1,
    }
}

fn normalize_credential(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or_default().trim();
    let normalized = trimmed.to_ascii_lowercase();
    if trimmed.is_empty()
        || normalized == "changeme"
        || normalized.starts_with("your_")
        || normalized.starts_with("example_")
        || normalized.contains("api_key_here")
        || normalized.contains("token_here")
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_present_string(value: Option<String>) -> Option<String> {
    match value {
        Some(value) if !value.is_empty() => Some(value),
        Some(_) => Some(String::new()),
        None => None,
    }
}

fn parse_stored_openai_credential(raw: &str) -> Option<StoredOpenAICredential> {
    match extract_json_string(raw, "authType").as_deref()? {
        "api-key" => Some(StoredOpenAICredential::ApiKey {
            api_key: extract_json_string(raw, "apiKey").unwrap_or_default(),
            organization_id: normalize_present_string(extract_json_string(raw, "organizationId")),
            project_id: normalize_present_string(extract_json_string(raw, "projectId")),
        }),
        "oauth" => Some(StoredOpenAICredential::OAuth {
            access_token: extract_json_string(raw, "accessToken").unwrap_or_default(),
            refresh_token: extract_json_string(raw, "refreshToken").unwrap_or_default(),
            expires_at: extract_json_number(raw, "expiresAt"),
            organization_id: normalize_present_string(extract_json_string(raw, "organizationId")),
            project_id: normalize_present_string(extract_json_string(raw, "projectId")),
            account_id: normalize_present_string(extract_json_string(raw, "accountId")),
            runtime: extract_json_string(raw, "runtime")
                .filter(|runtime| runtime == "api" || runtime == "codex"),
        }),
        _ => None,
    }
}

fn json_optional_string(value: Option<&str>) -> String {
    value
        .map(|value| format!("\"{}\"", json_escape(value)))
        .unwrap_or_else(|| "null".to_string())
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped
}

#[cfg(unix)]
fn set_private_file_permissions(path: &PathBuf) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let permissions = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &PathBuf) -> io::Result<()> {
    Ok(())
}

fn is_expired(token: &str) -> bool {
    token_expired_at(jwt_expiry(token))
}

fn has_required_model_request_scope(token: &str) -> bool {
    inspect_openai_oauth_token(token).has_model_request_scope
}

pub fn inspect_openai_oauth_token(token: &str) -> OpenAIOAuthTokenInspection {
    let Some(payload) = jwt_payload(token) else {
        return OpenAIOAuthTokenInspection {
            payload_valid: false,
            client_id: None,
            has_model_request_scope: true,
            expires_at: None,
            is_expired: false,
        };
    };
    let payload_valid = is_json_object_payload(&payload);
    if !payload_valid {
        return OpenAIOAuthTokenInspection {
            payload_valid,
            client_id: None,
            has_model_request_scope: true,
            expires_at: None,
            is_expired: false,
        };
    }

    let expires_at = extract_json_number(&payload, "exp");
    let scopes = extract_oauth_scopes(&payload);

    OpenAIOAuthTokenInspection {
        payload_valid,
        client_id: extract_oauth_client_id(&payload),
        has_model_request_scope: scopes.is_empty()
            || scopes.iter().any(|scope| scope == "model.request"),
        expires_at,
        is_expired: token_expired_at(expires_at),
    }
}

fn jwt_expiry(token: &str) -> Option<u64> {
    let payload = jwt_payload(token)?;
    extract_json_number(&payload, "exp")
}

fn jwt_payload(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = decode_base64url(payload)?;
    String::from_utf8(bytes).ok()
}

fn decode_base64url(input: &str) -> Option<Vec<u8>> {
    let mut bits = 0u32;
    let mut bit_count = 0u8;
    let mut out = Vec::new();
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        bits = (bits << 6) | value;
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    Some(out)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn token_expired_at(expires_at: Option<u64>) -> bool {
    expires_at
        .map(|exp| exp <= now_seconds() + 60)
        .unwrap_or(false)
}

fn is_json_object_payload(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.starts_with('{') && trimmed.ends_with('}')
}

fn extract_oauth_client_id(raw: &str) -> Option<String> {
    normalize_json_token(extract_json_string(raw, "client_id"))
        .or_else(|| {
            extract_string_array(raw, "aud").and_then(|values| {
                values
                    .into_iter()
                    .find_map(|value| normalize_json_token(Some(value)))
            })
        })
        .or_else(|| normalize_json_token(extract_json_string(raw, "aud")))
}

fn extract_oauth_scopes(raw: &str) -> Vec<String> {
    if json_value_start(raw, "scp").is_some() {
        return extract_scope_values(raw, "scp");
    }
    if json_value_start(raw, "scope").is_some() {
        return extract_scope_values(raw, "scope");
    }
    Vec::new()
}

fn extract_scope_values(raw: &str, key: &str) -> Vec<String> {
    if let Some(values) = extract_string_array(raw, key) {
        return values
            .into_iter()
            .filter_map(|value| normalize_json_token(Some(value)))
            .collect();
    }
    extract_json_string(raw, key)
        .map(|scope| scope.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

fn normalize_json_token(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn extract_json_string(raw: &str, key: &str) -> Option<String> {
    let start = json_value_start(raw, key)?;
    let mut chars = raw[start..].chars();
    if chars.next()? != '"' {
        return None;
    }
    let start = start + 1;
    let mut result = String::new();
    let mut escaped = false;
    for ch in raw[start..].chars() {
        if escaped {
            result.push(match ch {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(result),
            other => result.push(other),
        }
    }
    None
}

fn extract_json_number(raw: &str, key: &str) -> Option<u64> {
    let start = json_value_start(raw, key)?;
    let digits = raw[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

fn extract_string_array(raw: &str, key: &str) -> Option<Vec<String>> {
    let start = json_value_start(raw, key)?;
    let mut chars = raw[start..].chars();
    if chars.next()? != '[' {
        return None;
    }
    let start = start + 1;
    let end = raw[start..].find(']')? + start;
    let mut values = Vec::new();
    let mut rest = &raw[start..end];
    while let Some(index) = rest.find('"') {
        rest = &rest[index + 1..];
        let end = rest.find('"')?;
        values.push(rest[..end].to_string());
        rest = &rest[end + 1..];
    }
    Some(values)
}

fn json_value_start(raw: &str, key: &str) -> Option<usize> {
    let pattern = format!("\"{key}\"");
    let key_start = raw.find(&pattern)? + pattern.len();
    let colon_offset = raw[key_start..].find(':')? + key_start + 1;
    let whitespace = raw[colon_offset..]
        .chars()
        .take_while(|ch| ch.is_whitespace())
        .map(char::len_utf8)
        .sum::<usize>();
    Some(colon_offset + whitespace)
}

fn url_form_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn form_encode_pairs(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", url_form_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn url_form_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' => {
                let hex = value
                    .get(index + 1..index + 3)
                    .ok_or_else(|| "Invalid percent escape in callback URL.".to_string())?;
                let byte = u8::from_str_radix(hex, 16)
                    .map_err(|_| "Invalid percent escape in callback URL.".to_string())?;
                decoded.push(byte);
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| "Invalid UTF-8 in callback URL.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(payload: &str) -> String {
        format!("x.{}.y", base64url(payload.as_bytes()))
    }

    fn base64url(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        let mut index = 0;
        while index < bytes.len() {
            let b0 = bytes[index];
            let b1 = bytes.get(index + 1).copied().unwrap_or(0);
            let b2 = bytes.get(index + 2).copied().unwrap_or(0);
            out.push(TABLE[(b0 >> 2) as usize] as char);
            out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
            if index + 1 < bytes.len() {
                out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
            }
            if index + 2 < bytes.len() {
                out.push(TABLE[(b2 & 0x3f) as usize] as char);
            }
            index += 3;
        }
        out
    }

    #[test]
    fn detects_env_api_key() {
        let status = resolve_openai_auth_status(|key| match key {
            "OPENAI_API_KEY" => Some("sk-test".to_string()),
            _ => None,
        });
        assert_eq!(status.active_source, "api-key-env");
        assert!(!status.is_expired);
        assert!(openai_auth_supports_api_calls(&status));
    }

    #[test]
    fn codex_oauth_file_is_not_openai_api_ready() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-codex-oauth-runtime-{}",
            std::process::id()
        ));
        let codex_dir = root.join(".codex");
        fs::create_dir_all(&codex_dir).expect("create codex dir");
        fs::write(
            codex_dir.join("auth.json"),
            r#"{"tokens":{"access_token":"not-a-jwt","refresh_token":"rt-test"}}"#,
        )
        .expect("write codex auth");

        let status = resolve_openai_auth_status(|key| match key {
            "HOME" => Some(root.to_string_lossy().to_string()),
            _ => None,
        });

        assert_eq!(status.active_source, "oauth-file");
        assert_eq!(status.auth_type, "oauth");
        assert_eq!(status.runtime.as_deref(), Some("codex"));
        assert!(!openai_auth_supports_api_calls(&status));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detects_insufficient_scope() {
        let token = jwt(r#"{"exp":9999999999,"scp":["openid"]}"#);
        assert!(!has_required_model_request_scope(&token));
    }

    #[test]
    fn inspects_oauth_token_client_scope_and_expiry() {
        let token = jwt(
            r#"{"exp":9999999999,"client_id":" app_client_123 ","scp":["openid","model.request"]}"#,
        );
        let inspection = inspect_openai_oauth_token(&token);
        assert!(inspection.payload_valid);
        assert_eq!(inspection.client_id.as_deref(), Some("app_client_123"));
        assert!(inspection.has_model_request_scope);
        assert_eq!(inspection.expires_at, Some(9999999999));
        assert!(!inspection.is_expired);
    }

    #[test]
    fn inspects_oauth_token_audience_fallback() {
        let token = jwt(r#"{"aud":["","aud_client_123"],"scope":"openid profile"}"#);
        let inspection = inspect_openai_oauth_token(&token);
        assert_eq!(inspection.client_id.as_deref(), Some("aud_client_123"));
        assert!(!inspection.has_model_request_scope);
    }

    #[test]
    fn resolves_reusable_openai_client_id_from_codex_auth() {
        let root =
            std::env::temp_dir().join(format!("unclecode-reusable-client-{}", std::process::id()));
        let codex_dir = root.join(".codex");
        fs::create_dir_all(&codex_dir).expect("create codex dir");
        fs::write(
            codex_dir.join("auth.json"),
            format!(
                r#"{{"auth_mode":"chatgpt","tokens":{{"id_token":"{}"}}}}"#,
                jwt(r#"{"aud":["","codex_client_123"]}"#)
            ),
        )
        .expect("write codex auth");

        let client_id = resolve_reusable_openai_oauth_client_id(|key| match key {
            "HOME" => Some(root.to_string_lossy().to_string()),
            _ => None,
        });

        assert_eq!(client_id.as_deref(), Some("codex_client_123"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_oauth_token_payload_defaults_to_permissive_scope() {
        let inspection = inspect_openai_oauth_token("not-a-jwt");
        assert!(!inspection.payload_valid);
        assert_eq!(inspection.client_id, None);
        assert!(inspection.has_model_request_scope);
        assert!(!inspection.is_expired);
    }

    #[test]
    fn builds_openai_authorization_url_with_pkce_context() {
        let url = build_openai_authorization_url(
            "client_123",
            "http://localhost:7777/callback",
            "state 123",
            "challenge_123",
            &[
                "openid".to_string(),
                "profile".to_string(),
                "model.request".to_string(),
            ],
            None,
        );
        assert!(url.starts_with("https://auth.openai.com/oauth/authorize?"));
        assert!(url.contains("client_id=client_123"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A7777%2Fcallback"));
        assert!(url.contains("state=state+123"));
        assert!(url.contains("scope=openid+profile+model.request"));
    }

    #[test]
    fn parses_openai_callback_code_and_rejects_wrong_state() {
        assert_eq!(
            parse_openai_callback_code(
                "http://localhost:7777/callback?code=code%20123&state=state_123",
                "state_123"
            )
            .unwrap(),
            "code 123"
        );
        assert!(parse_openai_callback_code(
            "http://localhost:7777/callback?code=code_123&state=wrong",
            "state_123"
        )
        .is_err());
    }

    #[test]
    fn builds_openai_oauth_form_bodies() {
        assert_eq!(
            build_openai_device_authorization_body(
                "client_123",
                &["openid".to_string(), "model.request".to_string()]
            ),
            "client_id=client_123&scope=openid+model.request"
        );
        assert_eq!(
            build_openai_device_token_body("client_123", "device 123"),
            "client_id=client_123&device_code=device+123&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
        );
        assert_eq!(
            build_openai_authorization_code_token_body(
                "client_123",
                "code_123",
                "verifier_123",
                "http://localhost:7777/callback"
            ),
            "client_id=client_123&code=code_123&code_verifier=verifier_123&redirect_uri=http%3A%2F%2Flocalhost%3A7777%2Fcallback&grant_type=authorization_code"
        );
    }

    #[test]
    fn builds_openai_auth_request_specs() {
        let token =
            build_openai_auth_request_spec("authorization-code", Some("http://auth.local/"))
                .unwrap();
        assert_eq!(token.url, "http://auth.local/oauth/token");
        assert_eq!(token.content_type, "application/x-www-form-urlencoded");

        let codex = build_openai_auth_request_spec("codex-device-token", Some("http://auth.local"))
            .unwrap();
        assert_eq!(codex.url, "http://auth.local/api/accounts/deviceauth/token");
        assert_eq!(codex.content_type, "application/json");
    }

    #[test]
    fn builds_openai_codex_json_bodies() {
        assert_eq!(
            build_openai_codex_device_authorization_body("client_123"),
            r#"{"client_id":"client_123"}"#
        );
        assert_eq!(
            build_openai_codex_device_token_body("device-auth-123", "user_123"),
            r#"{"device_auth_id":"device-auth-123","user_code":"user_123"}"#
        );
    }

    #[test]
    fn parses_oauth_token_response_fields() {
        let response = parse_openai_oauth_token_response(
            r#"{"access_token":" at_123 ","refresh_token":"rt_123","error":"slow_down"}"#,
        );
        assert_eq!(response.access_token.as_deref(), Some("at_123"));
        assert_eq!(response.refresh_token.as_deref(), Some("rt_123"));
        assert_eq!(response.error.as_deref(), Some("slow_down"));
    }

    #[test]
    fn malformed_oauth_token_response_has_no_fields() {
        let response = parse_openai_oauth_token_response("{broken");
        assert_eq!(response.access_token, None);
        assert_eq!(response.refresh_token, None);
        assert_eq!(response.error, None);
    }

    #[test]
    fn parses_device_authorization_response_fields() {
        let response = parse_openai_device_authorization_response(
            r#"{"device_code":" device_123 ","user_code":"user_123","verification_uri":"https://auth.openai.com/activate","expires_in":900,"interval":5}"#,
        );
        assert_eq!(response.device_code.as_deref(), Some("device_123"));
        assert_eq!(response.user_code.as_deref(), Some("user_123"));
        assert_eq!(
            response.verification_uri.as_deref(),
            Some("https://auth.openai.com/activate")
        );
        assert_eq!(response.expires_in, Some(900));
        assert_eq!(response.interval, Some(5));
    }

    #[test]
    fn parses_codex_device_authorization_response_fields() {
        let response = parse_openai_codex_device_authorization_response(
            r#"{"device_auth_id":" device-auth-123 ","user_code":"user_123","interval":0}"#,
        );
        assert_eq!(response.device_auth_id.as_deref(), Some("device-auth-123"));
        assert_eq!(response.user_code.as_deref(), Some("user_123"));
        assert_eq!(response.interval, Some(0));
    }

    #[test]
    fn parses_codex_device_token_response_fields() {
        let response = parse_openai_codex_device_token_response(
            r#"{"authorization_code":" code_123 ","code_verifier":"verifier_123"}"#,
        );
        assert_eq!(response.authorization_code.as_deref(), Some("code_123"));
        assert_eq!(response.code_verifier.as_deref(), Some("verifier_123"));
    }

    #[test]
    fn writes_and_clears_api_key_credentials() {
        let root =
            std::env::temp_dir().join(format!("unclecode-auth-write-{}", std::process::id()));
        let path = root.join("openai.json");
        write_openai_api_key_credentials(
            path.clone(),
            &StoredApiKeyCredential {
                api_key: "sk-test".to_string(),
                organization_id: Some("org_123".to_string()),
                project_id: None,
            },
        )
        .expect("write credential");
        let raw = fs::read_to_string(&path).expect("read credential");
        assert!(raw.contains("\"authType\": \"api-key\""));
        assert!(raw.contains("\"apiKey\": \"sk-test\""));
        assert!(raw.contains("\"organizationId\": \"org_123\""));

        clear_openai_credentials(path.clone()).expect("clear credential");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn writes_oauth_credentials() {
        let root =
            std::env::temp_dir().join(format!("unclecode-auth-oauth-write-{}", std::process::id()));
        let path = root.join("openai.json");
        write_openai_oauth_credentials(
            path.clone(),
            &StoredOAuthCredential {
                access_token: "at_test".to_string(),
                refresh_token: "rt_test".to_string(),
                organization_id: None,
                project_id: Some("proj_123".to_string()),
                account_id: Some("acct_123".to_string()),
                runtime: Some("api".to_string()),
            },
        )
        .expect("write oauth credential");
        let raw = fs::read_to_string(&path).expect("read credential");
        assert!(raw.contains("\"authType\": \"oauth\""));
        assert!(raw.contains("\"accessToken\": \"at_test\""));
        assert!(raw.contains("\"refreshToken\": \"rt_test\""));
        assert!(raw.contains("\"projectId\": \"proj_123\""));
        assert!(raw.contains("\"accountId\": \"acct_123\""));
        assert!(raw.contains("\"runtime\": \"api\""));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_stored_openai_credentials_file() {
        let root = std::env::temp_dir().join(format!("unclecode-auth-read-{}", std::process::id()));
        let path = root.join("openai.json");
        write_openai_raw_credentials(
            path.clone(),
            r#"{"authType":"oauth","accessToken":"at_123","refreshToken":"rt_123","expiresAt":123,"organizationId":"org_123","projectId":"proj_123","accountId":"acct_123","runtime":"codex"}"#,
        )
        .expect("write raw credential");

        let credential = read_openai_credentials_file(path)
            .expect("read credential")
            .expect("credential");
        assert_eq!(
            credential,
            StoredOpenAICredential::OAuth {
                access_token: "at_123".to_string(),
                refresh_token: "rt_123".to_string(),
                expires_at: Some(123),
                organization_id: Some("org_123".to_string()),
                project_id: Some("proj_123".to_string()),
                account_id: Some("acct_123".to_string()),
                runtime: Some("codex".to_string()),
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_openai_credentials_read_as_missing() {
        let root =
            std::env::temp_dir().join(format!("unclecode-auth-malformed-{}", std::process::id()));
        let path = root.join("openai.json");
        write_openai_raw_credentials(path.clone(), "{broken").expect("write malformed credential");

        let credential = read_openai_credentials_file(path).expect("read credential");
        assert_eq!(credential, None);
        let _ = fs::remove_dir_all(root);
    }
}
