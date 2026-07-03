import path from "node:path";
import { hasExpectedReplyLine } from "./live-provider-qa/tool-smoke.mjs";

export { buildLiveToolSmoke, classifyLiveToolSmokeResult } from "./live-provider-qa/tool-smoke.mjs";

export function classifyLiveProviderPreflight({ provider, authStatus, doctorAuth }) {
  if (provider !== "openai") {
    return null;
  }
  const summary = parseOpenAIDoctorAuthSummary(doctorAuth?.stdout ?? "") ?? parseOpenAIAuthStatusSummary(authStatus?.stdout ?? "");
  return summary?.apiReady === false ? "blocked" : null;
}

export function classifyLiveProviderResult(work, authStatus, expectedText) {
  if (work.code === 0 && work.timedOut !== true && hasExpectedReplyLine(work.stdout, expectedText)) {
    return "pass";
  }
  const text = combineCommandText(authStatus, work);
  if (isCredentialBlockedText(text)) {
    return "blocked";
  }
  return "failed";
}

export function combineLiveProviderStatus(textStatus, toolStatus) {
  if (textStatus === "blocked" || toolStatus === "blocked") {
    return "blocked";
  }
  if (textStatus === "pass" && toolStatus === "pass") {
    return "pass";
  }
  return "failed";
}

export function buildCredentialRecovery({ provider, status, authStatus, doctorAuth, work }) {
  if (status !== "blocked") {
    return null;
  }

  if (provider !== "openai") {
    return {
      reason: `${provider}-credentials-blocked`,
      apiReady: null,
      authStatus: null,
      preferredFix: `Refresh or replace the ${provider} credentials, then re-run live provider QA.`,
      commands: ["npm run qa:live"],
      verify: "npm run qa:live",
    };
  }

  const doctorSummary = parseOpenAIDoctorAuthSummary(doctorAuth?.stdout ?? "");
  const authSummary = parseOpenAIAuthStatusSummary(authStatus?.stdout ?? "");
  const summary = doctorSummary ?? authSummary;
  const authRecovery = doctorSummary?.recovery ?? authSummary?.recovery ?? null;
  const recoveryStatus = authRecovery && summary
    ? { ...summary, recovery: authRecovery }
    : summary;
  const text = combineCommandText(authStatus, work);
  const reason = authRecovery?.reason ?? classifyOpenAIRecoveryReason(summary, text);
  const commands = authRecovery?.commands && authRecovery.commands.length > 0
    ? authRecovery.commands
    : [
        "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
        "unclecode auth login --api-key-stdin",
        "OPENAI_API_KEY=<key> npm run qa:live",
        "npm run qa:live",
      ];

  return {
    reason,
    apiReady: isOpenAICredentialBlockedReason(reason) ? false : summary?.apiReady ?? false,
    authStatus: recoveryStatus,
    preferredFix:
      authRecovery?.preferredFix ??
      "Run browser OAuth with an API-capable OpenAI OAuth client, or use API key login. Codex device OAuth can sign in but is not API-ready for OpenAI API calls.",
    commands,
    verify: authRecovery?.verify ?? "npm run qa:live",
  };
}

function isOpenAICredentialBlockedReason(reason) {
  return [
    "openai-oauth-codex-runtime-not-api-ready",
    "openai-oauth-insufficient-scope",
    "openai-auth-rejected",
    "openai-auth-needs-refresh",
    "openai-credentials-blocked",
  ].includes(reason);
}

export function parseOpenAIAuthStatusSummary(stdout) {
  const parsedSummary = parseOpenAIAuthJsonSummary(stdout);
  if (parsedSummary) {
    return parsedSummary;
  }

  const fields = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    fields.set(normalizeAuthKey(match[1]), match[2].trim());
  }

  const apiReady = fields.get("apiready");
  return {
    provider: fields.get("provider") ?? fields.get("authprovider") ?? null,
    source: fields.get("source") ?? fields.get("authsource") ?? null,
    auth: fields.get("auth") ?? fields.get("authtype") ?? null,
    runtime: fields.get("runtime") ?? null,
    expiresAt: fields.get("expiresat") ?? null,
    expired: fields.get("expired") ?? null,
    apiReady: apiReady === "yes" ? true : apiReady === "no" ? false : null,
    recovery: null,
  };
}

export function parseOpenAIDoctorAuthSummary(stdout) {
  return parseOpenAIAuthJsonSummary(stdout);
}

function parseOpenAIAuthJsonSummary(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const auth = parsed?.auth && typeof parsed.auth === "object" ? parsed.auth : parsed;
    if (!auth || typeof auth !== "object") {
      return null;
    }
    const provider = auth.provider ?? null;
    const source = auth.source ?? auth.activeSource ?? null;
    const authType = auth.type ?? auth.auth ?? auth.authType ?? null;
    const apiReady = normalizeBoolean(auth.apiReady);
    if (provider === null && source === null && authType === null && apiReady === null) {
      return null;
    }
    return {
      provider,
      source,
      auth: authType,
      runtime: auth.runtime ?? null,
      expiresAt: auth.expiresAt ?? null,
      expired: normalizeExpired(auth.expired),
      apiReady,
      recovery: parseOpenAIAuthRecovery(auth.recovery),
    };
  } catch {
    return null;
  }
}

function parseOpenAIAuthRecovery(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const commands = Array.isArray(value.commands)
    ? value.commands.filter((command) => typeof command === "string")
    : [];
  return {
    reason: typeof value.reason === "string" ? value.reason : null,
    preferredFix: typeof value.preferredFix === "string" ? value.preferredFix : null,
    commands,
    verify: typeof value.verify === "string" ? value.verify : null,
  };
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "yes") {
    return true;
  }
  if (value === "no") {
    return false;
  }
  return null;
}

function normalizeExpired(value) {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return typeof value === "string" ? value : null;
}

export function summarizeCommand(result) {
  return {
    code: result.code,
    timedOut: result.timedOut,
    stdout: redactSecrets(result.stdout.trim()),
    stderr: redactSecrets(result.stderr.trim()),
  };
}

export function formatLiveProviderCompactReport(report, repoRoot) {
  const recovery = report.credentialRecovery?.reason
    ? [`reason=${report.credentialRecovery.reason}`, `apiReady=${report.credentialRecovery.apiReady}`].join("; ")
    : null;
  return [
    `UncleCode live provider QA: ${report.status}`,
    [
      `provider=${report.provider}`,
      `text=${report.textSmoke?.status ?? "unknown"}`,
      `tool=${report.toolCallSmoke?.status ?? "unknown"}`,
      `markerMatched=${Boolean(report.toolCallSmoke?.markerMatched)}`,
    ].join("; "),
    ...(recovery ? [recovery] : []),
    `report: ${path.relative(repoRoot, report.reportPath)} (--json prints full report)`,
  ].join("\n");
}

export function redactSecrets(value) {
  return value
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_GEMINI_KEY]")
    .replace(/\bgsk_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_GROQ_KEY]")
    .replace(/(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)=\S+/g, "$1=[REDACTED]");
}

function classifyOpenAIRecoveryReason(summary, text) {
  if (summary?.auth === "oauth" && summary.runtime === "codex" && summary.apiReady === false) {
    return "openai-oauth-codex-runtime-not-api-ready";
  }
  if (/lacks model\.request|missing scope|insufficient.scope/i.test(text)) {
    return "openai-oauth-insufficient-scope";
  }
  if (/api key not valid|rejected current auth/i.test(text)) {
    return "openai-auth-rejected";
  }
  if (/auth needs refresh|expired:\s*yes/i.test(text)) {
    return "openai-auth-needs-refresh";
  }
  return "openai-credentials-blocked";
}

function combineCommandText(authStatus, work) {
  return `${authStatus?.stdout ?? ""}\n${authStatus?.stderr ?? ""}\n${work.stdout}\n${work.stderr}`;
}

function isCredentialBlockedText(text) {
  return (
    /api ready:\s*no/i.test(text) ||
    /lacks model\.request/i.test(text) ||
    /missing scope|insufficient.scope/i.test(text) ||
    /api key not valid/i.test(text) ||
    /rejected current auth/i.test(text) ||
    /required when LLM_PROVIDER/i.test(text) ||
    /auth needs refresh/i.test(text)
  );
}

function normalizeAuthKey(key) {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}
