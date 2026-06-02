use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use unclecode_core::auth::{
    build_openai_auth_request_spec, build_openai_authorization_code_token_body,
    build_openai_authorization_url, build_openai_codex_device_authorization_body,
    build_openai_codex_device_token_body, build_openai_device_authorization_body,
    build_openai_device_token_body, clear_openai_credentials, inspect_openai_oauth_token,
    openai_credentials_path, parse_openai_callback_code,
    parse_openai_codex_device_authorization_response, parse_openai_codex_device_token_response,
    parse_openai_device_authorization_response, parse_openai_oauth_token_response,
    resolve_openai_auth_status, resolve_reusable_openai_oauth_client_id,
    write_openai_api_key_credentials, write_openai_oauth_credentials, StoredApiKeyCredential,
    StoredOAuthCredential,
};
use unclecode_core::http_transport::{post_json_with_headers, HttpTransportResponse};
use unclecode_core::sha256::sha256_base64url_bytes;

static LOGIN_TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn top_level_auth_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("auth") | Some("/auth") => {
            if is_native_auth_surface(&args[1..]) {
                Some(args[1..].to_vec())
            } else {
                None
            }
        }
        Some(command) if command.starts_with("/auth ") => {
            let parsed = command
                .split_whitespace()
                .skip(1)
                .map(OsString::from)
                .chain(args[1..].iter().cloned())
                .collect::<Vec<_>>();
            if is_native_auth_surface(&parsed) {
                Some(parsed)
            } else {
                None
            }
        }
        _ => None,
    }
}

pub fn run_top_level_auth_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_auth_help();
            Ok(0)
        }
        Some("login") => run_login_command(&args[1..]),
        Some("status") => {
            print_openai_auth_status();
            Ok(0)
        }
        Some("logout") => {
            clear_local_openai_credentials()?;
            let status = resolve_openai_auth_status(|key| env::var(key).ok());
            if status.active_source == "none" {
                println!("Signed out.");
                println!("Auth: none");
            } else {
                println!("Local credentials cleared.");
                println!("Auth: {}", status.active_source);
            }
            Ok(0)
        }
        _ => Err(auth_usage()),
    }
}

fn is_native_auth_surface(args: &[OsString]) -> bool {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("--help") | Some("-h") | Some("help") | Some("status") | Some("logout") => true,
        Some("login") => true,
        _ => false,
    }
}

fn run_login_command(args: &[OsString]) -> Result<u8, String> {
    let mut api_key_stdin = false;
    let mut print_url = false;
    let mut browser = false;
    let mut device = false;
    let mut organization_id = None;
    let mut project_id = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].to_str() {
            Some("--help") | Some("-h") => {
                print_auth_login_help();
                return Ok(0);
            }
            Some("--api-key-stdin") => {
                api_key_stdin = true;
                index += 1;
            }
            Some("--api-key") => {
                return Err("Passing API keys on argv is disabled. Use `unclecode auth login --api-key-stdin` and pipe the key on stdin.".to_string());
            }
            Some("--browser") => {
                browser = true;
                index += 1;
            }
            Some("--device") => {
                device = true;
                index += 1;
            }
            Some("--print") => {
                print_url = true;
                index += 1;
            }
            Some("--org") => {
                organization_id = Some(next_flag_value(args, index, "--org")?.to_string());
                index += 2;
            }
            Some("--project") => {
                project_id = Some(next_flag_value(args, index, "--project")?.to_string());
                index += 2;
            }
            _ => return Err(auth_login_usage()),
        }
    }

    if api_key_stdin {
        if browser || device || print_url {
            return Err("Choose exactly one auth login method: OAuth browser, device login, or --api-key-stdin.".to_string());
        }
        return login_with_api_key_stdin(organization_id, project_id);
    }

    if browser && device {
        return Err(
            "Choose exactly one auth login method: OAuth browser, device login, or --api-key-stdin."
                .to_string(),
        );
    }

    let browser_client_id = env_trimmed("OPENAI_OAUTH_CLIENT_ID");
    let reusable_client_id = resolve_reusable_openai_oauth_client_id(|key| env::var(key).ok());
    let has_explicit_method = api_key_stdin || print_url || browser || device;

    if !has_explicit_method && handle_saved_auth_login()? {
        return Ok(0);
    }

    if print_url && !device {
        let client_id = browser_client_id.as_deref().ok_or_else(|| {
            "Browser OAuth needs OPENAI_OAUTH_CLIENT_ID. Reused Codex auth can start device OAuth instead. Run `unclecode auth login --device`.".to_string()
        })?;
        return print_browser_oauth_url_with_client(client_id);
    }

    if device {
        let client_id = reusable_client_id
            .as_deref()
            .or(browser_client_id.as_deref())
            .ok_or_else(|| "OPENAI_OAUTH_CLIENT_ID is required for device login.".to_string())?;
        if browser_client_id.is_none() && reusable_client_id.is_some() {
            return login_with_codex_device_oauth(client_id);
        }
        return login_with_device_oauth(client_id);
    }

    if browser {
        return login_with_browser_oauth();
    }

    if let Some(client_id) = browser_client_id.as_deref() {
        return login_with_browser_oauth_with_client(client_id);
    }
    if let Some(client_id) = reusable_client_id.as_deref() {
        return login_with_codex_device_oauth(client_id);
    }

    Err("OPENAI_OAUTH_CLIENT_ID is required for OAuth login. Existing ~/.codex/auth.json is reused automatically when present.".to_string())
}

fn login_with_api_key_stdin(
    organization_id: Option<String>,
    project_id: Option<String>,
) -> Result<u8, String> {
    if io::stdin().is_terminal() {
        return Err(
            "`unclecode auth login --api-key-stdin` expects the API key on stdin.".to_string(),
        );
    }

    let mut api_key = String::new();
    io::stdin()
        .read_to_string(&mut api_key)
        .map_err(|error| format!("Failed to read API key from stdin: {error}"))?;
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("No API key received on stdin.".to_string());
    }

    let path = openai_credentials_path(|key| env::var(key).ok());
    write_openai_api_key_credentials(
        path,
        &StoredApiKeyCredential {
            api_key,
            organization_id,
            project_id,
        },
    )
    .map_err(|error| format!("Failed to save OpenAI API key credentials: {error}"))?;
    println!("API key login saved.");
    println!("Source: api-key-file");
    Ok(0)
}

fn print_browser_oauth_url_with_client(client_id: &str) -> Result<u8, String> {
    let redirect_uri = browser_oauth_redirect_uri();
    let base_url = browser_oauth_base_url();
    println!(
        "{}",
        browser_authorization_url(client_id, &redirect_uri, base_url.as_deref()).0
    );
    Ok(0)
}

fn login_with_browser_oauth() -> Result<u8, String> {
    let client_id = browser_oauth_client_id()?;
    login_with_browser_oauth_with_client(&client_id)
}

fn login_with_browser_oauth_with_client(client_id: &str) -> Result<u8, String> {
    let redirect_uri = browser_oauth_redirect_uri();
    let base_url = browser_oauth_base_url();
    let (url, state, code_verifier) =
        browser_authorization_url(client_id, &redirect_uri, base_url.as_deref());

    println!("{url}");
    println!("Waiting for OAuth callback on {redirect_uri}");
    let callback_url = wait_for_browser_oauth_callback(&redirect_uri)?;
    let code = parse_openai_callback_code(&callback_url, &state)?;
    let body =
        build_openai_authorization_code_token_body(client_id, &code, &code_verifier, &redirect_uri);
    let response = post_oauth_request("authorization-code", base_url.as_deref(), &body)?;
    let tokens = parse_openai_oauth_token_response(&response);
    if let Some(error) = tokens.error {
        return Err(error);
    }
    let access_token = tokens
        .access_token
        .ok_or_else(|| "Missing access token in OAuth response.".to_string())?;
    let refresh_token = tokens
        .refresh_token
        .ok_or_else(|| "Missing refresh token in OAuth response.".to_string())?;
    ensure_model_request_scope(&access_token)?;
    save_oauth_credentials(access_token, refresh_token, "api")?;
    println!("Login successful.");
    Ok(0)
}

fn login_with_device_oauth(client_id: &str) -> Result<u8, String> {
    let base_url = browser_oauth_base_url();
    let scopes = oauth_scopes();
    let authorization_body = build_openai_device_authorization_body(client_id, &scopes);
    let authorization_response =
        post_oauth_request("device-code", base_url.as_deref(), &authorization_body)?;
    let authorization = parse_openai_device_authorization_response(&authorization_response);
    if let Some(error) = authorization.error {
        return Err(error);
    }
    let device_code = authorization
        .device_code
        .ok_or_else(|| "Missing device code in OAuth response.".to_string())?;
    let user_code = authorization
        .user_code
        .ok_or_else(|| "Missing user code in OAuth response.".to_string())?;
    let verification_uri = authorization
        .verification_uri
        .ok_or_else(|| "Missing verification URI in OAuth response.".to_string())?;
    let mut interval = authorization.interval.unwrap_or(5);
    let expires_in = authorization.expires_in.unwrap_or(15 * 60);
    println!("Starting device login.");
    println!("Please visit {verification_uri} and enter code: {user_code}");

    let started_at = Instant::now();
    while started_at.elapsed().as_secs() < expires_in {
        let token_body = build_openai_device_token_body(client_id, &device_code);
        let token_response = post_oauth_request("device-token", base_url.as_deref(), &token_body)?;
        let tokens = parse_openai_oauth_token_response(&token_response);
        match tokens.error.as_deref() {
            Some("authorization_pending") => {
                sleep(Duration::from_secs(interval));
                continue;
            }
            Some("slow_down") => {
                interval = interval.saturating_add(5).max(5);
                sleep(Duration::from_secs(interval));
                continue;
            }
            Some("expired_token") => break,
            Some(error) => return Err(error.to_string()),
            None => {}
        }
        let access_token = tokens
            .access_token
            .ok_or_else(|| "Missing access token in device authorization response.".to_string())?;
        let refresh_token = tokens
            .refresh_token
            .ok_or_else(|| "Missing refresh token in device authorization response.".to_string())?;
        ensure_model_request_scope(&access_token)?;
        save_oauth_credentials(access_token, refresh_token, "api")?;
        println!("Login successful.");
        return Ok(0);
    }

    Err("Device authorization did not complete in time.".to_string())
}

fn login_with_codex_device_oauth(client_id: &str) -> Result<u8, String> {
    let base_url = browser_oauth_base_url()
        .unwrap_or_else(|| "https://auth.openai.com".to_string())
        .trim_end_matches('/')
        .to_string();
    let authorization_body = build_openai_codex_device_authorization_body(client_id);
    let authorization_response =
        post_oauth_response("codex-device-code", Some(&base_url), &authorization_body)?;
    let authorization =
        parse_openai_codex_device_authorization_response(&authorization_response.body);
    if !authorization_response.ok {
        return Err(authorization
            .error
            .unwrap_or_else(|| "Codex device authorization request failed.".to_string()));
    }
    let device_auth_id = authorization
        .device_auth_id
        .ok_or_else(|| "Missing device auth id in Codex authorization response.".to_string())?;
    let user_code = authorization
        .user_code
        .ok_or_else(|| "Missing user code in Codex authorization response.".to_string())?;
    let interval = authorization.interval.unwrap_or(5);
    println!("Starting device login.");
    println!("Please visit {base_url}/codex/device and enter code: {user_code}");

    let started_at = Instant::now();
    while started_at.elapsed().as_secs() < 15 * 60 {
        if interval > 0 {
            sleep(Duration::from_secs(interval));
        }

        let token_body = build_openai_codex_device_token_body(&device_auth_id, &user_code);
        let token_response =
            post_oauth_response("codex-device-token", Some(&base_url), &token_body)?;
        if token_response.status == 403 || token_response.status == 404 {
            if interval == 0 {
                sleep(Duration::from_secs(1));
            }
            continue;
        }
        let exchange = parse_openai_codex_device_token_response(&token_response.body);
        if !token_response.ok {
            return Err(exchange
                .error
                .unwrap_or_else(|| "Codex device authorization polling failed.".to_string()));
        }
        let authorization_code = exchange.authorization_code.ok_or_else(|| {
            "Missing authorization code in Codex device authorization response.".to_string()
        })?;
        let code_verifier = exchange.code_verifier.ok_or_else(|| {
            "Missing code verifier in Codex device authorization response.".to_string()
        })?;
        let redirect_uri = format!("{base_url}/deviceauth/callback");
        let code_body = build_openai_authorization_code_token_body(
            client_id,
            &authorization_code,
            &code_verifier,
            &redirect_uri,
        );
        let response = post_oauth_response("authorization-code", Some(&base_url), &code_body)?;
        let tokens = parse_openai_oauth_token_response(&response.body);
        if !response.ok {
            return Err(tokens
                .error
                .unwrap_or_else(|| "Codex authorization-code exchange failed.".to_string()));
        }
        let access_token = tokens
            .access_token
            .ok_or_else(|| "Missing access token in Codex OAuth response.".to_string())?;
        let refresh_token = tokens
            .refresh_token
            .ok_or_else(|| "Missing refresh token in Codex OAuth response.".to_string())?;
        save_oauth_credentials(access_token, refresh_token, "codex")?;
        println!("Login successful.");
        return Ok(0);
    }

    Err("Codex device authorization did not complete in time.".to_string())
}

fn browser_oauth_client_id() -> Result<String, String> {
    env::var("OPENAI_OAUTH_CLIENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Browser OAuth needs OPENAI_OAUTH_CLIENT_ID. Reused Codex auth can start device OAuth instead. Run `unclecode auth login --device`.".to_string())
}

fn browser_oauth_redirect_uri() -> String {
    env::var("OPENAI_OAUTH_REDIRECT_URI")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://localhost:7777/callback".to_string())
}

fn browser_oauth_base_url() -> Option<String> {
    env::var("OPENAI_OAUTH_BASE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn oauth_scopes() -> Vec<String> {
    [
        "openid",
        "profile",
        "offline_access",
        "model.request",
        "api.model.read",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect()
}

fn browser_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    base_url: Option<&str>,
) -> (String, String, String) {
    let state = random_url_token();
    let code_verifier = random_url_token();
    let code_challenge = sha256_base64url_bytes(code_verifier.as_bytes());
    let scopes = oauth_scopes();
    (
        build_openai_authorization_url(
            client_id,
            redirect_uri,
            &state,
            &code_challenge,
            &scopes,
            base_url,
        ),
        state,
        code_verifier,
    )
}

fn post_oauth_request(kind: &str, base_url: Option<&str>, body: &str) -> Result<String, String> {
    Ok(post_oauth_response(kind, base_url, body)?.body)
}

fn post_oauth_response(
    kind: &str,
    base_url: Option<&str>,
    body: &str,
) -> Result<HttpTransportResponse, String> {
    let spec = build_openai_auth_request_spec(kind, base_url)?;
    let headers = format!("{{\"content-type\":\"{}\"}}", spec.content_type);
    post_json_with_headers(&spec.url, &headers, body)
}

fn ensure_model_request_scope(access_token: &str) -> Result<(), String> {
    if inspect_openai_oauth_token(access_token).has_model_request_scope {
        return Ok(());
    }
    Err("OAuth token lacks model.request scope. Use API key login or proper browser OAuth with OPENAI_OAUTH_CLIENT_ID.".to_string())
}

fn save_oauth_credentials(
    access_token: String,
    refresh_token: String,
    runtime: &str,
) -> Result<(), String> {
    let path = openai_credentials_path(|key| env::var(key).ok());
    write_openai_oauth_credentials(
        path,
        &StoredOAuthCredential {
            access_token,
            refresh_token,
            organization_id: None,
            project_id: None,
            account_id: None,
            runtime: Some(runtime.to_string()),
        },
    )
    .map_err(|error| format!("Failed to save OpenAI OAuth credentials: {error}"))
}

fn wait_for_browser_oauth_callback(redirect_uri: &str) -> Result<String, String> {
    let redirect = parse_local_http_url(redirect_uri)?;
    let bind_host = if redirect.host == "localhost" {
        "127.0.0.1"
    } else {
        redirect.host.as_str()
    };
    let listener = TcpListener::bind((bind_host, redirect.port))
        .map_err(|error| format!("Failed to listen for OAuth callback: {error}"))?;
    for incoming in listener.incoming() {
        let mut stream =
            incoming.map_err(|error| format!("Failed to accept OAuth callback: {error}"))?;
        let request_target = {
            let mut reader = BufReader::new(&mut stream);
            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .map_err(|error| format!("Failed to read OAuth callback: {error}"))?;
            request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_string()
        };
        let request_path = request_target
            .split_once('?')
            .map(|(path, _)| path)
            .unwrap_or(&request_target);
        if request_path != redirect.path {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
            continue;
        }
        let body = "UncleCode login received. You can return to the terminal.\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        return Ok(format!(
            "{}://{}:{}{}",
            redirect.scheme, redirect.host, redirect.port, request_target
        ));
    }
    Err("OAuth callback listener closed before a callback arrived.".to_string())
}

struct ParsedLocalHttpUrl {
    scheme: String,
    host: String,
    port: u16,
    path: String,
}

fn parse_local_http_url(url: &str) -> Result<ParsedLocalHttpUrl, String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| "OAuth redirect URI must include http://.".to_string())?;
    if scheme != "http" {
        return Err("OAuth redirect URI must use http for local callback login.".to_string());
    }
    let (authority, path_with_query) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = authority
        .rsplit_once(':')
        .map(|(host, port)| (host, port.parse::<u16>()))
        .unwrap_or((authority, Ok(80)));
    let port = port.map_err(|_| "OAuth redirect URI has an invalid port.".to_string())?;
    let path = format!(
        "/{}",
        path_with_query
            .split_once('?')
            .map(|(path, _)| path)
            .unwrap_or(path_with_query)
    );
    Ok(ParsedLocalHttpUrl {
        scheme: scheme.to_string(),
        host: host.to_string(),
        port,
        path,
    })
}

fn random_url_token() -> String {
    let mut bytes = [0_u8; 32];
    if File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_ok()
        && bytes.iter().any(|value| *value != 0)
    {
        return sha256_base64url_bytes(&bytes);
    }
    let counter = LOGIN_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    sha256_base64url_bytes(format!("{nanos}-{}-{counter}", std::process::id()).as_bytes())
}

fn next_flag_value<'a>(args: &'a [OsString], index: usize, flag: &str) -> Result<&'a str, String> {
    args.get(index + 1)
        .and_then(|arg| arg.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{flag} expects a value"))
}

fn handle_saved_auth_login() -> Result<bool, String> {
    let status = resolve_openai_auth_status(|key| env::var(key).ok());
    if status.active_source != "none" && !status.is_expired {
        println!("Saved auth found.");
        println!("Auth: {}", status.active_source);
        println!("Use `unclecode auth status` to inspect it. The next model request will verify provider access.");
        return Ok(true);
    }
    if status.active_source != "none" && status.expires_at.as_deref() == Some("insufficient-scope")
    {
        return Err("Saved OAuth was found but it lacks model.request scope for UncleCode API calls. Use unclecode auth login --api-key-stdin, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID.".to_string());
    }
    Ok(false)
}

fn env_trimmed(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn print_openai_auth_status() {
    let status = resolve_openai_auth_status(|key| env::var(key).ok());
    println!("provider: openai");
    println!("source: {}", status.active_source);
    println!("auth: {}", status.auth_type);
    println!(
        "organization: {}",
        status.organization_id.unwrap_or_else(|| "none".to_string())
    );
    println!(
        "project: {}",
        status.project_id.unwrap_or_else(|| "none".to_string())
    );
    println!(
        "expiresAt: {}",
        status.expires_at.unwrap_or_else(|| "none".to_string())
    );
    println!("expired: {}", if status.is_expired { "yes" } else { "no" });
}

fn clear_local_openai_credentials() -> Result<(), String> {
    let path = openai_credentials_path(|key| env::var(key).ok());
    clear_openai_credentials(path)
        .map_err(|error| format!("Failed to clear OpenAI credentials: {error}"))
}

fn print_auth_help() {
    println!("{}", auth_usage());
    println!();
    println!("Rust-native auth commands:");
    println!("  unclecode auth status");
    println!("  unclecode auth logout");
    println!("  printf '%s' \"$OPENAI_API_KEY\" | unclecode auth login --api-key-stdin");
    println!("  OPENAI_OAUTH_CLIENT_ID=... unclecode auth login --print");
    println!("  OPENAI_OAUTH_CLIENT_ID=... unclecode auth login --browser");
    println!("  OPENAI_OAUTH_CLIENT_ID=... unclecode auth login --device");
}

fn print_auth_login_help() {
    println!("{}", auth_login_usage());
    println!();
    println!("Examples:");
    println!("  printf '%s' \"$OPENAI_API_KEY\" | unclecode auth login --api-key-stdin");
    println!(
        "  printf '%s' \"$OPENAI_API_KEY\" | unclecode auth login --api-key-stdin --org org_123 --project proj_123"
    );
    println!("  OPENAI_OAUTH_CLIENT_ID=... unclecode auth login --print");
    println!("  OPENAI_OAUTH_CLIENT_ID=... unclecode auth login --browser");
    println!("  OPENAI_OAUTH_CLIENT_ID=... unclecode auth login --device");
}

fn auth_usage() -> String {
    "Usage: unclecode auth <login|status|logout>".to_string()
}

fn auth_login_usage() -> String {
    "Usage: unclecode auth login (--api-key-stdin [--org <org>] [--project <project>] | --print | --browser | --device)".to_string()
}
