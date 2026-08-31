import {
  buildRuntimeEvidence,
  hasRuntimeEvidenceContract,
  summarizeRuntimeEvidence,
} from "../runtime-qa/report-evidence.mjs";
import { isOpenAICredentialBlockedReason } from "../unclecode-live-provider-qa-lib.mjs";

export function summarizeFirstLine(result) {
  return firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr) ?? "";
}

export function summarizeNoOutputPass(result) {
  if (result.code === 0) return "ok";
  return firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? "";
}

export function summarizeDoctor(result) {
  const lines = nonEmptyLines(result.stdout);
  const auth = lines.find((line) => line.startsWith("Auth"))?.replace(/\s+/g, " ");
  const runtime = lines.find((line) => line.startsWith("Runtime"))?.replace(/\s+/g, " ");
  const mcp = lines.find((line) => line.startsWith("MCP host"))?.replace(/\s+/g, " ");
  return [runtime, mcp, auth].filter(Boolean).join("; ");
}

export function summarizeDoctorJson(result) {
  const parsed = parseJson(result.stdout);
  if (!parsed) return summarizeFirstLine(result);
  const auth = parsed.auth;
  const verdicts = parsed.verdicts;
  const runtimeVerdict = stringOrUnknown(verdicts?.runtime);
  const mcpVerdict = stringOrUnknown(verdicts?.mcpHost);
  const authVerdict = stringOrUnknown(verdicts?.auth);
  return [
    `runtime=${runtimeVerdict}`,
    `mcp=${mcpVerdict}`,
    `auth=${authVerdict}/${stringOrUnknown(auth?.provider)}/${stringOrUnknown(auth?.source)}/${stringOrUnknown(
      auth?.type,
    )}/${nullableStringOrNone(auth?.runtime)}`,
    `apiReady=${typeof auth?.apiReady === "boolean" ? auth.apiReady : "unknown"}`,
  ].join("; ");
}

export function hasDoctorJsonAuthContract(result) {
  const parsed = parseJson(result.stdout);
  const auth = parsed?.auth;
  return (
    isNonEmptyString(auth?.provider) &&
    isNonEmptyString(auth?.source) &&
    isNonEmptyString(auth?.type) &&
    hasOwn(auth, "runtime") &&
    (auth.runtime === null || isNonEmptyString(auth.runtime)) &&
    typeof auth?.apiReady === "boolean" &&
    (auth.apiReady !== false || hasCredentialRecoveryContract(auth.recovery))
  );
}

export function summarizeMcp(result) {
  const lines = nonEmptyLines(result.stdout).filter((line) => !line.startsWith("MCP servers"));
  return lines.join("; ");
}

export function summarizeResearchStatus(result) {
  const parsed = parseJson(result.stdout);
  if (!parsed) return summarizeFirstLine(result);
  const run = parsed.latestRun;
  const servers = Array.isArray(parsed.profile?.serverNames) ? parsed.profile.serverNames.join(",") : "none";
  return `${parsed.profile?.profileName ?? "unknown-profile"}; ${servers}; ${run?.state ?? "unknown"}`;
}

export function summarizeNodeTest(result) {
  const pass = matchLast(result.stdout, /(?:ℹ|#) pass (\d+)/);
  const fail = matchLast(result.stdout, /(?:ℹ|#) fail (\d+)/);
  if (pass || fail) return `${pass ?? "0"} pass, ${fail ?? "0"} fail`;
  return summarizeFirstLine(result);
}

export function summarizeRuntimeReport(result, report) {
  if (!report) return summarizeFirstLine(result);
  if (!isFreshReport(report, result.startedAtMs)) return "stale runtime report ignored";
  const evidence = summarizeRuntimeEvidence(report);
  return [
    report.status,
    `geminiTool=${evidence.geminiTool}`,
    `openaiTool=${evidence.openaiTool}`,
    `anthropicTool=${evidence.anthropicTool}`,
    `toolFinalGate=${evidence.toolFinalGate}`,
    `lightContrast=${evidence.lightContrast}`,
    `spinner=${evidence.spinner}`,
    `hangulResidual=${evidence.hangulResidual}`,
    `duplicateBusy=${evidence.duplicateBusy}`,
    `queueDrain=${evidence.queueDrain}`,
    `resize=${evidence.resize}; idleStable=${evidence.idleStable}; latencyOk=${evidence.latencyOk}`,
  ].join("; ");
}

export function hasRuntimeReportContract(result, report) {
  if (!commandSucceeded(result) || !report || !isFreshReport(report, result.startedAtMs)) return false;
  const evidence = report.evidence ?? buildRuntimeEvidence(report);
  return report.status === "pass" && hasRuntimeEvidenceContract(evidence);
}

export function summarizeLiveReport(result, report) {
  if (!report) return summarizeFirstLine(result);
  if (!isFreshReport(report, result.startedAtMs)) return "stale live report ignored";
  const recovery = report.credentialRecovery?.reason ? `; ${report.credentialRecovery.reason}` : "";
  const liveRecovery = summarizeLiveRecovery(report);
  return `${report.status}; text=${report.textSmoke?.status ?? "unknown"}; tool=${
    report.toolCallSmoke?.status ?? "unknown"
  }; markerMatched=${Boolean(report.toolCallSmoke?.markerMatched)}${recovery}${liveRecovery}`;
}

export function hasLiveProviderReportContract(result, report) {
  if (!commandSucceeded(result) || !report || !isFreshReport(report, result.startedAtMs)) return false;
  if (report.status === "pass") {
    return (
      report.textSmoke?.status === "pass" &&
      report.toolCallSmoke?.status === "pass" &&
      report.toolCallSmoke?.markerMatched === true &&
      hasLiveToolRunProof(report.toolCallSmoke) &&
      commandSucceeded(report.textSmoke?.work) &&
      commandSucceeded(report.toolCallSmoke?.work)
    );
  }
  if (report.status === "blocked") {
    return (
      hasBlockedCredentialRecovery(report) &&
      report.toolCallSmoke?.markerMatched === false &&
      hasLiveToolRunProof(report.toolCallSmoke) &&
      (isBlockedBeforeToolSmoke(report) || isBlockedDuringToolSmoke(report))
    );
  }
  return false;
}

export function recoveryHintForFailure(check, output) {
  if (isNativeAbiFailure(output)) {
    return "npm rebuild better-sqlite3 && npm run qa:health --silent";
  }
  if (check.label === "live provider QA") {
    return "refresh OpenAI API-capable auth, then npm run qa:live --silent";
  }
  return "";
}

export function isNativeAbiFailure(output) {
  return /better_sqlite3\.node|NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/i.test(output);
}

function summarizeLiveRecovery(report) {
  if (report.status !== "blocked") return "";
  const verify = report.credentialRecovery?.verify;
  if (!verify) return "; liveRecovery=refresh credentials";
  return `; liveRecovery=refresh credentials then ${verify}`;
}

function isFreshReport(report, startedAtMs) {
  if (typeof startedAtMs !== "number") return true;
  const finishedAtMs = Date.parse(report.finishedAt ?? "");
  return Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs;
}

function commandSucceeded(work) {
  return work?.code === 0 && work?.timedOut !== true;
}

function hasLiveToolRunProof(toolCallSmoke) {
  const runId = toolCallSmoke?.runId;
  const expectedText = toolCallSmoke?.expectedText;
  const markerPath = toolCallSmoke?.markerPath;
  return (
    isNonEmptyString(runId) &&
    isNonEmptyString(expectedText) &&
    expectedText === `UNCLECODE_LIVE_TOOL_QA_OK_${runId}` &&
    isNonEmptyString(markerPath) &&
    markerPath.endsWith(`live-tool-call-marker-${runId}.txt`)
  );
}

function hasBlockedCredentialRecovery(report) {
  if (!isNonEmptyString(report.credentialRecovery?.reason) || !isNonEmptyString(report.credentialRecovery?.verify)) {
    return false;
  }
  if (report.provider !== "openai") return true;
  const structuredApiReady = report.authStatus?.auth?.apiReady ?? report.doctorAuth?.auth?.apiReady;
  return (
    report.credentialRecovery?.apiReady === false &&
    (structuredApiReady === false || isOpenAICredentialBlockedReason(report.credentialRecovery.reason))
  );
}

function hasCredentialRecoveryContract(value) {
  return Boolean(value && isNonEmptyString(value.reason) && Array.isArray(value.commands) && value.commands.some(isNonEmptyString) && isNonEmptyString(value.verify));
}

function isBlockedBeforeToolSmoke(report) {
  return report.textSmoke?.status === "blocked" && report.toolCallSmoke?.status === "skipped";
}

function isBlockedDuringToolSmoke(report) {
  return report.textSmoke?.status === "pass" && report.toolCallSmoke?.status === "blocked";
}

function firstNonEmptyLine(value) {
  return nonEmptyLines(value)[0];
}

function nonEmptyLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringOrUnknown(value) {
  return isNonEmptyString(value) ? value : "unknown";
}

function nullableStringOrNone(value) {
  return value === null ? "none" : stringOrUnknown(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function matchLast(value, pattern) {
  return [...value.matchAll(new RegExp(pattern, "g"))].at(-1)?.[1];
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}
