import path from "node:path";

export function formatRuntimeQaCompactReport(report, reportPath, repoRoot) {
  const evidence = summarizeRuntimeEvidence(report);
  const providerToolCalls = report.evidence?.providerToolCalls ?? {};
  return [
    `UncleCode runtime QA: ${report.status}`,
    [
      `providers: geminiTool=${evidence.geminiTool} (${providerToolCalls.gemini?.requestDelta ?? 0} requests)`,
      `openaiTool=${evidence.openaiTool} (${providerToolCalls.openai?.requestDelta ?? 0} requests)`,
      `anthropicTool=${evidence.anthropicTool} (${providerToolCalls.anthropic?.requestDelta ?? 0} requests)`,
      `toolFinalGate=${evidence.toolFinalGate}`,
    ].join("; "),
    [
      `tui: lightContrast=${evidence.lightContrast}`,
      `spinner=${evidence.spinner}`,
      `hangulResidual=${evidence.hangulResidual}`,
      `duplicateBusy=${evidence.duplicateBusy}`,
      `queueDrain=${evidence.queueDrain}`,
      `resize=${evidence.resize}; idleStable=${evidence.idleStable}; latencyOk=${evidence.latencyOk}`,
      `scrollbackPageUp=${evidence.scrollbackPageUp}; escapeReturn=${evidence.scrollEscapeReturn}`,
    ].join("; "),
    `report: ${path.relative(repoRoot, reportPath)} (--json prints full report)`,
  ].join("\n");
}

export function buildRuntimeEvidence(report) {
  return {
    providerToolCalls: {
      gemini: buildProviderToolCallEvidence(report.toolCallSmoke, false),
      openai: buildProviderToolCallEvidence(report.openAIToolCallSmoke),
      anthropic: buildProviderToolCallEvidence(report.anthropicToolCallSmoke),
    },
    tui: {
      lightTerminalContrast:
        report.fullTuiSmoke?.lightTerminalContrast === true &&
        report.contextContrastTuiSmoke?.contextLightContrast === true,
      contextPanelContrast: {
        lightTerminalContrast: report.contextContrastTuiSmoke?.contextLightContrast === true,
        foregroundColors: report.contextContrastTuiSmoke?.foregroundColors ?? [],
      },
      spinnerVisible: report.koreanBusyTuiSmoke?.busySpinnerVisible === true,
      hangulResidual: report.koreanBusyTuiSmoke?.hangulDuplicateRegression === true,
      duplicateBusy:
        report.koreanBusyTuiSmoke?.duplicateBusyActivityRegression === true ||
        report.realUseTuiStress?.duplicateBusyActivityRegression === true,
      queueDrain: report.realUseTuiStress?.queueDrainVerified === true,
      resize: report.realUseTuiStress?.resizeVerified === true,
      idleStable: report.realUseTuiStress?.idleStableVerified === true,
      openAIStreaming: {
        streamRequestObserved: report.realUseTuiStress?.openAIStreaming?.streamRequestObserved === true,
        partialTextVisible: report.realUseTuiStress?.openAIStreaming?.partialTextVisible === true,
        streamingCursorVisible: report.realUseTuiStress?.openAIStreaming?.streamingCursorVisible === true,
        finalTextVisible: report.realUseTuiStress?.openAIStreaming?.finalTextVisible === true,
      },
      latencyOk:
        report.realUseTuiStress?.latencyWithinBudget === true &&
        report.slashLatencyTuiSmoke?.latencyWithinBudget === true,
      scrollbackPageUp: report.scrollbackTuiSmoke?.pageUpIndicatorVerified === true,
      scrollEscapeReturn: report.scrollbackTuiSmoke?.escapeReturnVerified === true,
      slashCommanderLatency: {
        firstSlashMs: report.slashLatencyTuiSmoke?.latencies?.firstSlashMs,
        warmSlashMs: report.slashLatencyTuiSmoke?.latencies?.warmSlashMs,
        moFilterMs: report.slashLatencyTuiSmoke?.latencies?.moFilterMs,
        modelPickerMs: report.slashLatencyTuiSmoke?.latencies?.modelPickerMs,
        budgets: report.slashLatencyTuiSmoke?.budgets,
      },
      compactKoreanShortReply: report.koreanBusyTuiSmoke?.compactKoreanShortReply === true,
      parallelModeKorean: {
        cleanAnswerVisible: report.parallelModeKoreanTuiSmoke?.paneExcerpt?.includes("병렬 모드") === true,
        plannerJsonLeakRegression: report.parallelModeKoreanTuiSmoke?.plannerJsonLeakRegression === true,
        englishMetaLeakRegression: report.parallelModeKoreanTuiSmoke?.englishMetaLeakRegression === true,
        rawPathBusyStripRegression: report.parallelModeKoreanTuiSmoke?.rawPathBusyStripRegression === true,
        requestDelta: report.parallelModeKoreanTuiSmoke?.requestDelta,
      },
    },
    context: buildContextEvidence(report.realUseTuiStress),
  };
}

export function summarizeRuntimeEvidence(report) {
  const evidence = report.evidence ?? buildRuntimeEvidence(report);
  return {
    geminiTool: evidence.providerToolCalls?.gemini?.toolRoundTrip === true,
    openaiTool: evidence.providerToolCalls?.openai?.toolRoundTrip === true,
    anthropicTool: evidence.providerToolCalls?.anthropic?.toolRoundTrip === true,
    toolFinalGate:
      evidence.providerToolCalls?.gemini?.finalAnswerGatedByToolResult === true &&
      evidence.providerToolCalls?.openai?.finalAnswerGatedByToolResult === true &&
      evidence.providerToolCalls?.anthropic?.finalAnswerGatedByToolResult === true,
    lightContrast: evidence.tui?.lightTerminalContrast === true,
    spinner: evidence.tui?.spinnerVisible === true,
    hangulResidual: evidence.tui?.hangulResidual === true,
    duplicateBusy: evidence.tui?.duplicateBusy === true,
    queueDrain: evidence.tui?.queueDrain === true,
    resize: evidence.tui?.resize === true,
    idleStable: evidence.tui?.idleStable === true,
    latencyOk: evidence.tui?.latencyOk === true,
    scrollbackPageUp: evidence.tui?.scrollbackPageUp === true,
    scrollEscapeReturn: evidence.tui?.scrollEscapeReturn === true,
  };
}

export function hasRuntimeEvidenceContract(evidence) {
  const providers = evidence?.providerToolCalls;
  const tui = evidence?.tui;
  const context = evidence?.context;
  return (
    hasProviderToolCallEvidence(providers?.gemini) &&
    hasProviderToolCallEvidence(providers?.openai) &&
    hasProviderToolCallEvidence(providers?.anthropic) &&
    tui?.lightTerminalContrast === true &&
    tui?.contextPanelContrast?.lightTerminalContrast === true &&
    tui?.spinnerVisible === true &&
    tui?.hangulResidual === false &&
    tui?.duplicateBusy === false &&
    tui?.queueDrain === true &&
    tui?.resize === true &&
    tui?.idleStable === true &&
    tui?.latencyOk === true &&
    context?.contextPanelVisible === true &&
    context?.modelBoundPackets === true &&
    context?.includedExcludedWarnings === true &&
    context?.rawArtifactsHeldBack === true
  );
}

function buildProviderToolCallEvidence(smoke, functionResponseIdRequired = true) {
  const secondRequest = smoke?.secondRequest;
  return {
    toolRoundTrip: smoke?.toolRoundTripVerified === true,
    requestDelta: Number.isInteger(smoke?.requestDelta) ? smoke.requestDelta : 0,
    firstRequestHadTools: smoke?.firstRequest?.hasTools === true,
    toolResultObserved: secondRequest?.hasFunctionResponse === true || secondRequest?.hasToolResult === true,
    finalAnswerGatedByToolResult:
      smoke?.finalAnswerGatedByToolResult === true &&
      secondRequest?.finalAnswerGatedByToolResult === true,
    protocolPaired:
      (secondRequest?.functionResponseNameMatched === true &&
        (!functionResponseIdRequired || secondRequest?.functionResponseIdMatched === true)) ||
      secondRequest?.toolCallIdMatched === true ||
      secondRequest?.toolUseIdMatched === true,
  };
}

function buildContextEvidence(realUseTuiStress) {
  const contextPane = realUseTuiStress?.contextPaneExcerpt ?? "";
  const includedHeader = /Sources · \d+ included|Included in next answer/.test(contextPane);
  const heldBackHeader = /\d+ held back|Held back locally/.test(contextPane);
  const warningsHeader = /Warnings · (?:none|\d+)|✓ none|\d+ warnings?/i.test(contextPane);
  const packetTransparency = realUseTuiStress?.contextPacketTransparency === true;
  return {
    contextPanelVisible: /UncleCode Context Desk/.test(contextPane) && includedHeader,
    modelBoundPackets: packetTransparency,
    includedExcludedWarnings:
      packetTransparency &&
      includedHeader &&
      heldBackHeader &&
      warningsHeader,
    rawArtifactsHeldBack: packetTransparency && heldBackHeader,
  };
}

function hasProviderToolCallEvidence(evidence) {
  return (
    evidence?.toolRoundTrip === true &&
    Number.isInteger(evidence.requestDelta) &&
    evidence.requestDelta >= 2 &&
    evidence.firstRequestHadTools === true &&
    evidence.toolResultObserved === true &&
    evidence.finalAnswerGatedByToolResult === true &&
    evidence.protocolPaired === true
  );
}
