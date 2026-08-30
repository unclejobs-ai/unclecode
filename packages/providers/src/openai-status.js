import { runRustCommand } from "./rust-command.js";
export async function resolveOpenAIAuthStatus(options = {}) {
    const env = options.env ?? process.env;
    const stdout = await runRustCommand(["rust", "auth", "status"], process.cwd(), undefined, env);
    const fields = parseRustKeyValueLines(stdout);
    return {
        providerId: "openai",
        activeSource: normalizeAuthSource(fields.get("activeSource")),
        authType: normalizeAuthType(fields.get("authType")),
        runtime: normalizeRuntime(fields.get("runtime")),
        organizationId: normalizeOptionalField(fields.get("organizationId")),
        projectId: normalizeOptionalField(fields.get("projectId")),
        expiresAt: normalizeOptionalField(fields.get("expiresAt")),
        isExpired: fields.get("expired") === "yes",
        apiReady: fields.get("apiReady") === "yes",
    };
}
function parseRustKeyValueLines(stdout) {
    return new Map(stdout
        .split(/\r?\n/)
        .map((line) => line.split("=", 2))
        .filter((parts) => parts.length === 2));
}
function normalizeAuthSource(value) {
    return value === "api-key-env"
        || value === "api-key-file"
        || value === "oauth-env"
        || value === "oauth-file"
        ? value
        : "none";
}
function normalizeAuthType(value) {
    return value === "api-key" || value === "oauth" ? value : "none";
}
function normalizeRuntime(value) {
    return value === "api" || value === "codex" ? value : null;
}
function normalizeOptionalField(value) {
    return value && value !== "none" ? value : null;
}
export function formatOpenAIAuthStatus(status) {
    return [
        `provider: ${status.providerId}`,
        `source: ${status.activeSource}`,
        `auth: ${status.authType}`,
        `organization: ${status.organizationId ?? "none"}`,
        `project: ${status.projectId ?? "none"}`,
        `runtime: ${status.runtime ?? "none"}`,
        `expiresAt: ${status.expiresAt ?? "none"}`,
        `expired: ${status.isExpired ? "yes" : "no"}`,
        `api ready: ${status.apiReady ? "yes" : "no"}`,
    ].join("\n");
}
//# sourceMappingURL=openai-status.js.map