export function redactAgentOpsSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#:@]+:[^\s/?#@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "$1 [REDACTED]")
    .replace(
      /\b([A-Z0-9_-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OAUTH)[A-Z0-9_-]*)\s*=\s*[^\s]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/([?&][^=\s]*(?:api[_-]?key|token|secret|password|credential|oauth)[^=\s]*=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(/\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]");
}
