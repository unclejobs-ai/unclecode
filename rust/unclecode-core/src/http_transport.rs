use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Url;
use serde_json::{json, Value};
use std::env;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpTransportResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
    pub attempts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyPolicy {
    pub target_host: String,
    pub proxy_url: Option<String>,
    pub source: String,
    pub bypassed: bool,
    pub no_proxy: Vec<String>,
}

pub fn post_json_with_headers(
    url: &str,
    headers_json: &str,
    body: &str,
) -> Result<HttpTransportResponse, String> {
    post_json_with_headers_retry(url, headers_json, body, 3, Duration::from_millis(125))
}

pub fn post_json_with_headers_retry(
    url: &str,
    headers_json: &str,
    body: &str,
    max_attempts: usize,
    retry_delay: Duration,
) -> Result<HttpTransportResponse, String> {
    let headers_value: Value = serde_json::from_str(headers_json)
        .map_err(|error| format!("Invalid HTTP headers JSON: {error}"))?;
    let mut headers = HeaderMap::new();
    if let Some(object) = headers_value.as_object() {
        for (key, value) in object {
            let Some(value) = value.as_str() else {
                continue;
            };
            let name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|error| format!("Invalid HTTP header name {key}: {error}"))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|error| format!("Invalid HTTP header value for {key}: {error}"))?;
            headers.insert(name, header_value);
        }
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;
    let max_attempts = max_attempts.max(1);
    let mut last_error = None;
    for attempt in 1..=max_attempts {
        let response = client
            .post(url)
            .headers(headers.clone())
            .body(body.to_string())
            .send();
        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let ok = response.status().is_success();
                let body = response
                    .text()
                    .map_err(|error| format!("Failed to read HTTP response body: {error}"))?;
                if should_retry_http_status(status) && attempt < max_attempts {
                    sleep_before_retry(retry_delay);
                    continue;
                }
                return Ok(HttpTransportResponse {
                    status,
                    ok,
                    body,
                    attempts: attempt,
                });
            }
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt < max_attempts {
                    sleep_before_retry(retry_delay);
                    continue;
                }
            }
        }
    }

    Err(format!(
        "HTTP POST failed after {max_attempts} attempts: {}",
        last_error.unwrap_or_else(|| "unknown transport error".to_string())
    ))
}

pub fn resolve_proxy_policy(url: &str) -> Result<ProxyPolicy, String> {
    resolve_proxy_policy_with_env(url, |key| env::var(key).ok())
}

pub fn resolve_proxy_policy_with_env<F>(url: &str, get_env: F) -> Result<ProxyPolicy, String>
where
    F: Fn(&str) -> Option<String>,
{
    let parsed = Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    let scheme = parsed.scheme();
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let no_proxy_raw = first_env(&get_env, &["NO_PROXY", "no_proxy"]).unwrap_or_default();
    let no_proxy = no_proxy_raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if host_matches_no_proxy(&host, &no_proxy) {
        return Ok(ProxyPolicy {
            target_host: host,
            proxy_url: None,
            source: "NO_PROXY".to_string(),
            bypassed: true,
            no_proxy,
        });
    }

    let selected = match scheme {
        "https" => first_env_named(&get_env, &["HTTPS_PROXY", "https_proxy"])
            .or_else(|| first_env_named(&get_env, &["ALL_PROXY", "all_proxy"])),
        "http" => first_env_named(&get_env, &["HTTP_PROXY", "http_proxy"])
            .or_else(|| first_env_named(&get_env, &["ALL_PROXY", "all_proxy"])),
        _ => first_env_named(&get_env, &["ALL_PROXY", "all_proxy"]),
    };
    Ok(ProxyPolicy {
        target_host: host,
        proxy_url: selected.as_ref().map(|(_, value)| value.clone()),
        source: selected
            .map(|(key, _)| key.to_string())
            .unwrap_or_else(|| "none".to_string()),
        bypassed: false,
        no_proxy,
    })
}

pub fn http_transport_response_json(response: &HttpTransportResponse) -> Result<String, String> {
    serde_json::to_string(&json!({
        "status": response.status,
        "ok": response.ok,
        "body": response.body,
        "text": response.body,
        "attempts": response.attempts
    }))
    .map_err(|error| error.to_string())
}

pub fn proxy_policy_json(policy: &ProxyPolicy) -> Result<String, String> {
    serde_json::to_string(&json!({
        "targetHost": policy.target_host,
        "proxyUrl": policy.proxy_url.as_deref().map(redact_proxy_url_for_display),
        "source": policy.source,
        "bypassed": policy.bypassed,
        "noProxy": policy.no_proxy,
    }))
    .map_err(|error| error.to_string())
}

pub fn describe_proxy_policy(policy: &ProxyPolicy) -> String {
    describe_proxy_policy_fields(
        &policy.target_host,
        &policy.source,
        policy.bypassed,
        &policy.no_proxy,
        policy.proxy_url.as_deref(),
    )
}

pub fn describe_proxy_policy_fields(
    target_host: &str,
    source: &str,
    bypassed: bool,
    no_proxy: &[String],
    proxy_url: Option<&str>,
) -> String {
    if bypassed {
        let suffix = if no_proxy.is_empty() {
            "NO_PROXY".to_string()
        } else {
            format!("NO_PROXY {}", no_proxy.join(","))
        };
        return format!("bypassed for {target_host} via {suffix}");
    }
    match proxy_url.filter(|value| !value.trim().is_empty()) {
        Some(url) => format!("{source} via {}", redact_proxy_url_for_display(url)),
        None => format!("direct to {target_host}"),
    }
}

pub fn redact_proxy_url_for_display(url: &str) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return "[invalid proxy URL]".to_string();
    };
    if parsed.username().is_empty() && parsed.password().is_none() {
        return url.to_string();
    }
    let _ = parsed.set_username("redacted");
    let _ = parsed.set_password(None);
    parsed.to_string()
}

fn first_env<F>(get_env: &F, keys: &[&str]) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    first_env_named(get_env, keys).map(|(_, value)| value)
}

fn first_env_named<F>(get_env: &F, keys: &[&str]) -> Option<(String, String)>
where
    F: Fn(&str) -> Option<String>,
{
    keys.iter().find_map(|key| {
        get_env(key)
            .filter(|value| !value.trim().is_empty())
            .map(|value| ((*key).to_string(), value))
    })
}

fn host_matches_no_proxy(host: &str, no_proxy: &[String]) -> bool {
    no_proxy.iter().any(|entry| {
        let normalized = entry.trim().trim_start_matches('.').to_ascii_lowercase();
        entry.trim() == "*"
            || host == normalized
            || (!normalized.is_empty() && host.ends_with(&format!(".{normalized}")))
    })
}

fn should_retry_http_status(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

fn sleep_before_retry(delay: Duration) {
    if !delay.is_zero() {
        std::thread::sleep(delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn posts_body_and_headers_over_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(request.contains("POST /test HTTP/1.1"));
            assert!(request.contains("x-test: yes"));
            assert!(request.ends_with("hello"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .unwrap();
        });

        let response = post_json_with_headers(
            &format!("http://{address}/test"),
            r#"{"x-test":"yes"}"#,
            "hello",
        )
        .unwrap();
        handle.join().unwrap();

        assert_eq!(
            response,
            HttpTransportResponse {
                status: 200,
                ok: true,
                body: "ok".to_string(),
                attempts: 1,
            }
        );
    }

    #[test]
    fn retries_transient_server_failures() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0_u8; 4096];
                let size = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..size]);
                assert!(request.contains("POST /retry HTTP/1.1"));
                assert!(request.ends_with("hello"));
                if index == 0 {
                    stream
                        .write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 4\r\nconnection: close\r\n\r\nbusy",
                        )
                        .unwrap();
                } else {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                        )
                        .unwrap();
                }
            }
        });

        let response = post_json_with_headers_retry(
            &format!("http://{address}/retry"),
            "{}",
            "hello",
            3,
            Duration::ZERO,
        )
        .unwrap();
        handle.join().unwrap();

        assert_eq!(response.status, 200);
        assert!(response.ok);
        assert_eq!(response.body, "ok");
        assert_eq!(response.attempts, 2);
    }

    #[test]
    fn resolves_proxy_policy_with_specific_proxy_precedence() {
        let policy =
            resolve_proxy_policy_with_env("https://api.openai.com/v1/chat", |key| match key {
                "HTTPS_PROXY" => Some("http://secure-proxy:8080".to_string()),
                "ALL_PROXY" => Some("http://all-proxy:8080".to_string()),
                _ => None,
            })
            .unwrap();

        assert_eq!(policy.target_host, "api.openai.com");
        assert_eq!(
            policy.proxy_url.as_deref(),
            Some("http://secure-proxy:8080")
        );
        assert_eq!(policy.source, "HTTPS_PROXY");
        assert!(!policy.bypassed);
    }

    #[test]
    fn resolves_proxy_policy_with_no_proxy_bypass() {
        let policy =
            resolve_proxy_policy_with_env("https://api.openai.com/v1/chat", |key| match key {
                "HTTPS_PROXY" => Some("http://secure-proxy:8080".to_string()),
                "NO_PROXY" => Some(".openai.com,localhost".to_string()),
                _ => None,
            })
            .unwrap();

        assert_eq!(policy.proxy_url, None);
        assert_eq!(policy.source, "NO_PROXY");
        assert!(policy.bypassed);
        assert_eq!(policy.no_proxy, vec![".openai.com", "localhost"]);
    }

    #[test]
    fn redacts_proxy_credentials_for_display() {
        assert_eq!(
            redact_proxy_url_for_display("http://proxy.local:8080"),
            "http://proxy.local:8080"
        );
        assert_eq!(
            redact_proxy_url_for_display("http://user:secret@proxy.local:8080"),
            "http://redacted@proxy.local:8080/"
        );
        let policy = ProxyPolicy {
            target_host: "api.openai.com".to_string(),
            proxy_url: Some("http://user:secret@proxy.local:8080".to_string()),
            source: "HTTPS_PROXY".to_string(),
            bypassed: false,
            no_proxy: vec![],
        };
        assert_eq!(
            describe_proxy_policy(&policy),
            "HTTPS_PROXY via http://redacted@proxy.local:8080/"
        );
    }
}
