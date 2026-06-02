use crate::anthropic_request::build_anthropic_messages_request_spec_with_base;
use crate::gemini_request::build_gemini_generate_content_request_spec_with_base;
use crate::http_transport::{
    http_transport_response_json, post_json_with_headers, HttpTransportResponse,
};
use crate::provider_request::{
    build_openai_chat_request_spec_with_base, build_openai_codex_request_spec, ProviderRequestSpec,
};
use serde_json::{json, Map, Value};

pub fn post_anthropic_messages_json(
    api_key: &str,
    body: &str,
    base_url: &str,
) -> Result<String, String> {
    post_provider_spec_json(
        &build_anthropic_messages_request_spec_with_base(api_key, base_url),
        body,
    )
}

pub fn post_gemini_generate_content_json(
    api_key: &str,
    model: &str,
    body: &str,
    base_url: &str,
) -> Result<String, String> {
    let spec = build_gemini_generate_content_request_spec_with_base(api_key, model, base_url);
    post_provider_url_json(&spec.url, &spec.headers, body)
}

pub fn post_openai_chat_json(api_key: &str, body: &str, base_url: &str) -> Result<String, String> {
    http_transport_response_json(&post_openai_chat_response(api_key, body, base_url)?)
}

pub fn post_openai_chat_response(
    api_key: &str,
    body: &str,
    base_url: &str,
) -> Result<HttpTransportResponse, String> {
    post_provider_spec(
        &build_openai_chat_request_spec_with_base(api_key, base_url),
        body,
    )
}

pub fn post_openai_codex_json(
    api_key: &str,
    body: &str,
    account_id: Option<&str>,
) -> Result<String, String> {
    post_provider_spec_json(&build_openai_codex_request_spec(api_key, account_id), body)
}

fn post_provider_spec_json(spec: &ProviderRequestSpec, body: &str) -> Result<String, String> {
    http_transport_response_json(&post_provider_spec(spec, body)?)
}

fn post_provider_spec(
    spec: &ProviderRequestSpec,
    body: &str,
) -> Result<HttpTransportResponse, String> {
    post_provider_url(&spec.url, &spec.headers, body)
}

fn post_provider_url_json(
    url: &str,
    headers: &[(String, String)],
    body: &str,
) -> Result<String, String> {
    http_transport_response_json(&post_provider_url(url, headers, body)?)
}

fn post_provider_url(
    url: &str,
    headers: &[(String, String)],
    body: &str,
) -> Result<HttpTransportResponse, String> {
    post_json_with_headers(url, &headers_json(headers), body)
}

pub fn headers_json(headers: &[(String, String)]) -> String {
    let mut object = Map::new();
    for (key, value) in headers {
        object.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(object).to_string()
}

pub fn provider_request_spec_json(url: &str, headers: &[(String, String)]) -> String {
    let mut headers_object = Map::new();
    for (key, value) in headers {
        headers_object.insert(key.clone(), Value::String(value.clone()));
    }
    json!({
        "url": url,
        "headers": headers_object
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn renders_request_spec_json_with_header_object() {
        let raw = provider_request_spec_json(
            "https://example.test/v1",
            &[("x-test".to_string(), "yes".to_string())],
        );
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["url"], "https://example.test/v1");
        assert_eq!(parsed["headers"]["x-test"], "yes");
    }

    #[test]
    fn posts_openai_chat_via_provider_transport() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(request.contains("POST /v1/chat/completions HTTP/1.1"));
            assert!(request.contains("authorization: Bearer sk-test"));
            assert!(request.ends_with(r#"{"model":"gpt-5.5"}"#));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .unwrap();
        });

        let raw = post_openai_chat_json(
            "sk-test",
            r#"{"model":"gpt-5.5"}"#,
            &format!("http://{address}/v1"),
        )
        .unwrap();
        handle.join().unwrap();

        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["text"], "ok");
    }
}
