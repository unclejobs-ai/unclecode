# Auth Broker Gateway Threat Model

Date: 2026-06-03

## Decision

Adopt the gajae-style auth broker/gateway pattern only behind these controls. The gateway may hold provider credentials and forward OpenAI-compatible requests, so it must be treated as a credential-bearing security boundary, not as a generic proxy.

## Assets

- Provider API keys, OAuth access tokens, refresh tokens, and account ids.
- User prompts, tool results, file snippets, and model responses.
- Provider route metadata, proxy configuration, and audit logs.

## Trust Boundaries

- CLI/TUI host to gateway over loopback or explicitly configured private network.
- Gateway to provider endpoint over TLS.
- Local credential store to gateway process.
- Tool execution results crossing back into model context.

## Required Controls

- Bind to `127.0.0.1` by default. Any non-loopback bind requires explicit config and must not be enabled by a default profile.
- `/healthz` may be unauthenticated; every other endpoint requires bearer authentication.
- Do not allow `--no-auth` or equivalent on non-loopback listeners.
- Do not use wildcard CORS when bearer authentication is enabled.
- Store token files under a user-only directory with directory mode `0700` and file mode `0600`.
- Never return provider credentials, refresh tokens, or raw authorization headers in RPC frames, logs, traces, or UI diagnostics.
- Gateway forwarding must use an allowlist of provider hosts and routes. It must not forward arbitrary URLs.
- Header forwarding must be allowlisted. Strip incoming `Authorization`, proxy, cookie, and hop-by-hop headers unless the gateway generated them.
- Redact prompts and tool outputs from audit logs by default; record request ids, route, provider, model, status, and latency.
- Support token rotation and revocation without restarting all clients.
- Rate-limit authenticated clients and reject replayed command ids where feasible.
- Keep proxy policy resolution explicit. Environment proxy settings must be visible in route metadata and must not silently override a configured no-proxy rule.

## SSRF And Exfiltration Risks

The largest adoption risk is turning a credentialed gateway into a generic URL fetcher. Provider target host and path must be selected from registry metadata, not request payload fields. Model id and body fields may not influence the upstream base URL.

The second risk is credential leakage through debugging. Any request/response capture must redact authorization, account id, refresh token, cookies, and provider-specific credential fields before leaving the gateway process.

## Remote Access Gate

Remote gateway access is out of scope unless one of these is present:

- mTLS between host and gateway.
- Tailscale or equivalent private-network identity with ACLs.
- A short-lived bearer token minted by an authenticated local broker.

Remote access must also define who can revoke clients and where audit events are retained.

## Adoption Checklist

- Implement route allowlist before adding any remote bind option.
- Add contract tests for unauthenticated `/healthz`, authenticated provider routes, and rejected arbitrary upstream URLs.
- Add log redaction tests for provider auth headers and OAuth payload fields.
- Add config validation rejecting wildcard CORS plus bearer auth.
- Add integration tests confirming token files are created with user-only permissions.
