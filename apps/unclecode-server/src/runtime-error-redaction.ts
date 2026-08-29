const MAX_RUNTIME_RPC_ERROR_LENGTH = 512;

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
  const redacted = message
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*([=:])\s*[^\s,;]+/gi,
      (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]");
  return redacted.length > MAX_RUNTIME_RPC_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_RUNTIME_RPC_ERROR_LENGTH - 1)}…`
    : redacted;
}
