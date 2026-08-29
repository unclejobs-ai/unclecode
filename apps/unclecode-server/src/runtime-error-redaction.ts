const MAX_RUNTIME_RPC_ERROR_LENGTH = 512;

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const JSON_STRING_PROPERTY = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
const NAMED_VALUE = /\b([A-Za-z][A-Za-z0-9_-]*)\s*([=:])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/g;
const QUERY_PARAMETER = /([?&])([^=&\s]+)=([^&#\s]*)/g;
const COOKIE_HEADER = /\b((?:Set-)?Cookie)\s*:\s*[^\r\n]*/gi;
const COOKIE_NAMED_VALUE = /\b([A-Za-z][A-Za-z0-9_-]*Cookie)\s*([=:])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi;
const MAX_CREDENTIAL_NAME_CHARS = 512;
const JSON_SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
});

function decodeJsonStringKey(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index + 1 >= value.length) {
      decoded += character;
      continue;
    }
    const escape = value[index + 1]!;
    if (escape === "u" && /^[0-9A-Fa-f]{4}$/.test(value.slice(index + 2, index + 6))) {
      decoded += String.fromCharCode(Number.parseInt(value.slice(index + 2, index + 6), 16));
      index += 5;
      continue;
    }
    const simpleEscape = JSON_SIMPLE_ESCAPES[escape];
    if (simpleEscape !== undefined) {
      decoded += simpleEscape;
      index += 1;
      continue;
    }
    decoded += character;
  }
  return decoded;
}

function isCredentialName(value: string): boolean {
  if (value.length > MAX_CREDENTIAL_NAME_CHARS) return true;
  let decoded = decodeJsonStringKey(value);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed query names are still checked in their original form.
  }
  const compact = decoded.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return compact === "key"
    || compact === "jwt"
    || compact.endsWith("jwt")
    || compact === "session"
    || compact.endsWith("session")
    || compact.endsWith("sessionid")
    || compact.endsWith("sessionkey")
    || compact.endsWith("sessiontoken")
    || compact.endsWith("sessionsecret")
    || compact.endsWith("sessioncredential")
    || compact.endsWith("cookie")
    || compact.endsWith("signingkey")
    || compact.endsWith("signingtoken")
    || compact.endsWith("signingsecret")
    || compact.endsWith("signingcredential")
    || compact.endsWith("apikey")
    || compact.endsWith("accesstoken")
    || compact.endsWith("refreshtoken")
    || compact.endsWith("authtoken")
    || compact.endsWith("token")
    || compact.endsWith("clientsecret")
    || compact.endsWith("secret")
    || compact.endsWith("password")
    || compact.endsWith("credential")
    || compact.endsWith("credentials")
    || compact.endsWith("oauth")
    || compact.endsWith("authorization")
    || compact.endsWith("privatekey");
}

/**
 * Redact and bound diagnostic text before it crosses a runtime client,
 * projection, receipt, or CLI boundary. The function intentionally preserves
 * useful prose and parameter names while discarding credential values.
 */
export function redactRuntimeDiagnostic(message: string, maxLength = MAX_RUNTIME_RPC_ERROR_LENGTH): string {
  const boundedLength = Number.isSafeInteger(maxLength) && maxLength > 0
    ? maxLength
    : MAX_RUNTIME_RPC_ERROR_LENGTH;
  const redacted = message
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY]")
    .replace(COOKIE_HEADER, "$1: [REDACTED]")
    .replace(COOKIE_NAMED_VALUE, (match, name: string, separator: string, value: string) => value === "[REDACTED]"
      ? match
      : `${name}${separator}[REDACTED]`)
    .replace(JSON_STRING_PROPERTY, (match, key: string) => isCredentialName(key)
      ? `"${key}":"[REDACTED]"`
      : match)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1[REDACTED]@")
    .replace(QUERY_PARAMETER, (match, prefix: string, name: string) => isCredentialName(name)
      ? `${prefix}${name}=[REDACTED]`
      : match)
    .replace(/\b((?:Proxy-)?Authorization\s*[:=]\s*Basic)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'",;]+)/gi, "$1 [REDACTED]")
    .replace(/\b((?:Proxy-)?Authorization\s*[:=]\s*Bearer)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'",;]+)/gi, "$1 [REDACTED]")
    .replace(/\b(Bearer)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9._~+/=-]{8,}\b)/gi, "$1 [REDACTED]")
    .replace(NAMED_VALUE, (match, name: string, separator: string, value: string) => {
      const compactName = name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      const isRedactedAuthorizationScheme = compactName.endsWith("authorization")
        && /^(?:Basic|Bearer)$/i.test(value);
      return isCredentialName(name) && !isRedactedAuthorizationScheme && value !== "[REDACTED]"
        ? `${name}${separator}[REDACTED]`
        : match;
    })
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,})\b/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]");
  return redacted.length > boundedLength
    ? `${redacted.slice(0, Math.max(0, boundedLength - 1))}…`
    : redacted;
}

/**
 * The only conversion from an internal runtime failure to client-visible RPC
 * text. It deliberately loses stack/object detail, redacts common credentials,
 * and caps the serialized size before the value reaches an HTTP response,
 * durable receipt, or teardown aggregate.
 */
export function boundedRuntimeRpcError(error: unknown): string {
  let message = "Runtime operation failed.";
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    // Untrusted provider/plugin objects can define a throwing string coercion.
  }
  return redactRuntimeDiagnostic(message);
}
