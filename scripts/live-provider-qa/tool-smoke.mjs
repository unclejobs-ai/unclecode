const liveToolSmokePrefix = "UNCLECODE_LIVE_TOOL_QA_OK";

export function buildLiveToolSmoke(repoRoot, runId = null) {
  const normalizedRunId = normalizeRunId(runId);
  const expectedText = normalizedRunId
    ? `${liveToolSmokePrefix}_${normalizedRunId}`
    : liveToolSmokePrefix;
  const markerName = normalizedRunId
    ? `live-tool-call-marker-${normalizedRunId}.txt`
    : "live-tool-call-marker.txt";
  const markerPath = `${repoRoot}/.unclecode/qa/${markerName}`;
  const markerScript = [
    "require(\"node:fs\").mkdirSync(require(\"node:path\").dirname(",
    JSON.stringify(markerPath),
    "), { recursive: true });",
    "require(\"node:fs\").writeFileSync(",
    JSON.stringify(markerPath),
    ", ",
    JSON.stringify(expectedText),
    ");",
  ].join("");
  const command = `node -e ${shellQuote(markerScript)}`;
  return {
    runId: normalizedRunId,
    expectedText,
    markerPath,
    prompt: [
      "Use the run_shell tool exactly once to run this command:",
      command,
      `After the command succeeds, respond with exactly ${expectedText}.`,
    ].join("\n"),
  };
}

export function classifyLiveToolSmokeResult({ work, markerText, expectedText }) {
  if (work.code === 0 && work.timedOut !== true && hasExpectedReplyLine(work.stdout, expectedText) && markerText.trim() === expectedText) {
    return "pass";
  }
  if (isCredentialBlockedText(`${work.stdout}\n${work.stderr}`)) {
    return "blocked";
  }
  return "failed";
}

export function hasExpectedReplyLine(stdout, expectedText) {
  return stdout.split(/\r?\n/).some((line) => {
    const normalized = normalizeOutputLine(line);
    return normalized === expectedText || normalized === `final: ${expectedText}`;
  });
}

function normalizeRunId(runId) {
  if (typeof runId !== "string") {
    return null;
  }
  const normalized = runId.trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return normalized.length > 0 ? normalized : null;
}

function normalizeOutputLine(line) {
  return stripAnsi(line)
    .replace(/^[\s|│┃┆┊┋┇▌▐▏▎▍▕>•*-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
