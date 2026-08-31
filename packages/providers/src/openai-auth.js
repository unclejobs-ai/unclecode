import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runRustCommand, runRustCommandSync } from "./rust-command.js";
function normalizeCredential(value) {
    const trimmed = String(value ?? "").trim();
    const normalized = trimmed.toLowerCase();
    if (trimmed.length === 0 ||
        normalized === "changeme" ||
        normalized.startsWith("your_") ||
        normalized.startsWith("example_") ||
        normalized.includes("api_key_here") ||
        normalized.includes("token_here")) {
        return "";
    }
    return trimmed;
}
function resolveHomeDir(env) {
    return env?.HOME?.trim() || homedir();
}
function defaultFallbackAuthPath(env) {
    return path.join(resolveHomeDir(env), ".unclecode", "credentials", "openai.json");
}
function defaultCodexAuthPath(env) {
    return path.join(resolveHomeDir(env), ".codex", "auth.json");
}
function defaultFallbackAuthPaths(env) {
    return [defaultFallbackAuthPath(env), defaultCodexAuthPath(env)];
}
function isExpired(token) {
    return inspectOAuthToken(token).expired;
}
function getAuthFileSource(authPath) {
    return authPath?.includes(`${path.sep}.codex${path.sep}`) ? "codex-auth-file" : "unclecode-auth-file";
}
function hasRequiredModelRequestScope(token) {
    return inspectOAuthToken(token).hasModelRequestScope;
}
function inspectOAuthToken(token) {
    const stdout = runRustCommandSync(["rust", "auth", "inspect-oauth-token"], process.cwd(), process.env, token);
    const fields = parseRustKeyValueLines(stdout);
    return {
        expired: fields.get("expired") === "true",
        hasModelRequestScope: fields.get("hasModelRequestScope") !== "false",
    };
}
function normalizeStoredRuntime(value) {
    return value === "api" || value === "codex" ? value : null;
}
function rankFailure(result) {
    if (result.status === "missing" && result.reason === "auth-insufficient-scope")
        return 4;
    if (result.status === "missing" && result.reason === "auth-refresh-required")
        return 3;
    if (result.status === "expired")
        return 2;
    if (result.status === "missing" && result.reason === "auth-token-missing")
        return 1;
    return 0;
}
export async function resolveOpenAIAuth(input = {}) {
    if (shouldUseRustResolver(input)) {
        return resolveOpenAIAuthViaRust(resolveRustAuthEnv(input));
    }
    return resolveOpenAIAuthViaTypescript(input);
}
function shouldUseRustResolver(input) {
    return !input.readFallbackFile && (!input.fallbackAuthPaths || input.fallbackAuthPaths.length <= 1);
}
function resolveRustAuthEnv(input) {
    const env = { ...(input.env ?? process.env) };
    const explicitPath = input.fallbackAuthPath ?? input.fallbackAuthPaths?.[0];
    if (explicitPath && explicitPath.trim().length > 0) {
        env.UNCLECODE_OPENAI_CREDENTIALS_PATH = explicitPath;
    }
    return env;
}
async function resolveOpenAIAuthViaRust(env) {
    const stdout = await runRustCommand(["rust", "auth", "resolve"], process.cwd(), undefined, env);
    const fields = parseRustKeyValueLines(stdout);
    const status = fields.get("status");
    const authType = fields.get("authType");
    const source = fields.get("source");
    const reason = normalizeOptionalField(fields.get("reason"));
    if (status === "ok" && (authType === "api-key" || authType === "oauth")) {
        const runtime = normalizeRuntime(fields.get("runtime"));
        return {
            status,
            authType,
            source: normalizeOkSource(source),
            bearerToken: normalizeRequiredField(fields.get("bearerToken"), "bearerToken"),
            organizationId: normalizeOptionalField(fields.get("organizationId")),
            projectId: normalizeOptionalField(fields.get("projectId")),
            accountId: normalizeOptionalField(fields.get("accountId")),
            ...(runtime ? { runtime } : {}),
        };
    }
    if (status === "expired" && authType === "oauth") {
        return {
            status,
            authType,
            source: normalizeOAuthFileOrEnvSource(source),
            reason: reason ?? "auth-token-expired",
        };
    }
    return {
        status: "missing",
        authType: authType === "oauth" ? "oauth" : "none",
        source: normalizeMissingSource(source),
        reason: reason ?? "auth-file-missing",
    };
}
function parseRustKeyValueLines(stdout) {
    return new Map(stdout
        .split(/\r?\n/)
        .map((line) => line.split("=", 2))
        .filter((parts) => parts.length === 2));
}
function normalizeRequiredField(value, field) {
    const normalized = normalizeOptionalField(value);
    if (!normalized) {
        throw new Error(`Rust auth resolver did not return ${field}.`);
    }
    return normalized;
}
function normalizeOptionalField(value) {
    return value && value !== "none" ? value : null;
}
function normalizeRuntime(value) {
    return value === "api" || value === "codex" ? value : undefined;
}
function normalizeOkSource(value) {
    return value === "env-openai-api-key"
        || value === "env-openai-auth-token"
        || value === "unclecode-auth-file"
        || value === "codex-auth-file"
        || value === "unclecode-api-key-file"
        ? value
        : "unclecode-auth-file";
}
function normalizeOAuthFileOrEnvSource(value) {
    return value === "env-openai-auth-token" || value === "codex-auth-file" ? value : "unclecode-auth-file";
}
function normalizeMissingSource(value) {
    return value === "unclecode-auth-file" || value === "codex-auth-file" ? value : "none";
}
async function resolveOpenAIAuthViaTypescript(input = {}) {
    const env = input.env ?? process.env;
    const authToken = normalizeCredential(env.OPENAI_AUTH_TOKEN);
    if (authToken) {
        if (isExpired(authToken)) {
            return {
                status: "expired",
                authType: "oauth",
                source: "env-openai-auth-token",
                reason: "auth-token-expired",
            };
        }
        return {
            status: "ok",
            authType: "oauth",
            source: "env-openai-auth-token",
            bearerToken: authToken,
            runtime: hasRequiredModelRequestScope(authToken) ? "api" : "codex",
        };
    }
    const apiKey = normalizeCredential(env.OPENAI_API_KEY);
    if (apiKey) {
        return {
            status: "ok",
            authType: "api-key",
            source: "env-openai-api-key",
            bearerToken: apiKey,
        };
    }
    const candidatePaths = input.fallbackAuthPaths && input.fallbackAuthPaths.length > 0
        ? [...input.fallbackAuthPaths]
        : input.fallbackAuthPath
            ? [input.fallbackAuthPath]
            : [...defaultFallbackAuthPaths(env)];
    const readFallbackFile = input.readFallbackFile ?? ((authPath) => readFile(authPath ?? defaultFallbackAuthPath(env), "utf8"));
    let bestFailure;
    const rememberFailure = (candidate) => {
        if (!bestFailure || rankFailure(candidate) > rankFailure(bestFailure)) {
            bestFailure = candidate;
        }
    };
    for (const authPath of candidatePaths) {
        try {
            const source = getAuthFileSource(authPath);
            const parsed = JSON.parse(await readFallbackFile(authPath));
            const apiKey = parsed?.authType === "api-key" ? normalizeCredential(parsed?.apiKey) : "";
            if (apiKey) {
                return {
                    status: "ok",
                    authType: "api-key",
                    source: "unclecode-auth-file",
                    bearerToken: apiKey,
                    organizationId: normalizeCredential(parsed?.organizationId) || null,
                    projectId: normalizeCredential(parsed?.projectId) || null,
                };
            }
            const accessToken = normalizeCredential(parsed?.accessToken) || normalizeCredential(parsed?.tokens?.access_token);
            const refreshToken = normalizeCredential(parsed?.refreshToken) || normalizeCredential(parsed?.tokens?.refresh_token);
            const storedRuntime = normalizeStoredRuntime(parsed?.runtime) || (source === "codex-auth-file" ? "codex" : null);
            if (!accessToken) {
                rememberFailure({
                    status: "missing",
                    authType: "none",
                    source: "none",
                    reason: "auth-token-missing",
                });
                continue;
            }
            if (isExpired(accessToken)) {
                rememberFailure(refreshToken
                    ? {
                        status: "missing",
                        authType: "oauth",
                        source,
                        reason: "auth-refresh-required",
                    }
                    : {
                        status: "expired",
                        authType: "oauth",
                        source,
                        reason: "auth-token-expired",
                    });
                continue;
            }
            if (!hasRequiredModelRequestScope(accessToken) && storedRuntime !== "codex") {
                rememberFailure({
                    status: "missing",
                    authType: "oauth",
                    source,
                    reason: "auth-insufficient-scope",
                });
                continue;
            }
            return {
                status: "ok",
                authType: "oauth",
                source,
                bearerToken: accessToken,
                organizationId: normalizeCredential(parsed?.organizationId) || null,
                projectId: normalizeCredential(parsed?.projectId) || null,
                accountId: normalizeCredential(parsed?.accountId) || normalizeCredential(parsed?.tokens?.account_id) || null,
                runtime: storedRuntime ?? "api",
            };
        }
        catch {
            rememberFailure({
                status: "missing",
                authType: "none",
                source: "none",
                reason: "auth-file-missing",
            });
        }
    }
    return bestFailure ?? {
        status: "missing",
        authType: "none",
        source: "none",
        reason: "auth-file-missing",
    };
}
//# sourceMappingURL=openai-auth.js.map