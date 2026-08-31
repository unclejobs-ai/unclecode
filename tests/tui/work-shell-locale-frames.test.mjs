import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

function props(overrides = {}) {
  return {
    provider: "OpenAI", model: "gpt-5.4", reasoningLabel: "medium",
    reasoningSupported: true, mode: "default", authLabel: "saved",
    entries: [], isBusy: false,
    activePanel: { title: "Session status", lines: ["Work context ready."] },
    composer: React.createElement("span", null, ""), inputValue: "",
    slashSuggestionCount: 0, terminalColumns: 100, terminalRows: 36,
    ...overrides,
  };
}

async function frame(overrides) {
  const rendered = renderDebugFrame(React.createElement(WorkShellView, props(overrides)), { columns: 100, rows: 36 });
  try {
    return stripVTControlCharacters(await waitForSettledFrame(rendered.getOutput));
  } finally {
    rendered.instance.unmount();
    rendered.instance.cleanup();
  }
}

test("complete idle and busy frames use one EN/KO catalog", async () => {
  const enIdle = await frame({ uiLocale: "en" });
  assert.match(enIdle, /Ready for the next move/);
  assert.match(enIdle, /Enter send/);
  assert.doesNotMatch(enIdle, /준비 완료|작업 중|후속 요청/u);

  const koIdle = await frame({ uiLocale: "ko" });
  assert.match(koIdle, /다음 작업 준비 완료/u);
  assert.match(koIdle, /Enter 전송/u);
  assert.doesNotMatch(koIdle, /Ready for the next move|Enter send/);

  const enBusy = await frame({ uiLocale: "en", isBusy: true, busyStatus: "reading files", currentTurnStartedAt: Date.now() });
  assert.match(enBusy, /Reading context/);
  assert.match(enBusy, /Queue a follow-up/);
  const koBusy = await frame({ uiLocale: "ko", isBusy: true, busyStatus: "reading files", currentTurnStartedAt: Date.now() });
  assert.match(koBusy, /컨텍스트 읽는 중/u);
  assert.match(koBusy, /후속 요청 대기열 추가/u);
  assert.doesNotMatch(koBusy, /Queue a follow-up|Reading context/);
});

test("queue frame localizes chrome while preserving queued user text byte-for-byte", async () => {
  const userText = "src/한글/파일.ts please keep EXACT";
  const lines = [
    "Paused · 2 total · 1 pending · 0 in flight · 1 requires action", "",
    `Next · id 7 · pending · ${userText}`,
    "#2 · id 8 · requires action · repair later",
    "", "↑/↓ select · Shift+↑/↓ reorder · d remove",
    "c clear pending · r resume · t retry · x discard · Esc close",
  ];
  const ko = await frame({
    uiLocale: "ko", inputValue: "/queue", queuedCount: 2, queuePaused: true,
    activePanel: { title: "Queue · follow-ups", lines }, queueSelectedId: 7,
  });
  assert.match(ko, /대기열 · 후속 요청/u);
  assert.match(ko, /전체 2 · 대기 1 · 실행 중 0 · 조치 필요 1/u);
  assert.match(ko, /↑\/↓ 선택/u);
  assert.ok(ko.includes(userText), "user queue content is not translated or normalized");
  assert.doesNotMatch(ko, /Queue · follow-ups|clear pending|requires action/);
});

test("review frame exposes Korean Quality Engine chrome without changing evidence values", async () => {
  const snapshot = {
    profileId: "build", activity: [], agents: [], jobs: [],
    workGraph: {
      id: "graph-1", goal: "ship", qualityProfile: "deep", currentStage: "critic",
      gateStatus: "unproven", iteration: 2, approval: "approved", nodes: [],
    },
    qualityReview: {
      runId: "run-1", graphId: "graph-1", profile: "deep", currentStage: "critic",
      iteration: 2, refineCount: 1, pivotCount: 0, latestDecision: "unproven",
      history: [{
        event: "gate", stage: "critic", decision: "unproven", iteration: 2,
        failures: ["검증값-EXACT"], evidenceRefs: ["evidence:원문-EXACT"], artifactRefs: [],
        reviewerId: "critic-1", independentVerification: false, stale: true, startedAt: 1,
      }],
    },
  };
  const ko = await frame({
    uiLocale: "ko", agentConsole: snapshot,
    agentConsoleView: { open: true, tab: "quality", cursor: 0, activePane: "roster", inspectorVisible: true, control: { kind: "browse" } },
  });
  assert.match(ko, /SCC · 미입증 · 심층/u);
  assert.match(ko, /확인 · 기록된 산출물 검증 없음; 독립 검토는 미입증/u);
  assert.match(ko, /검토 · 독립 검토 없음/u);
  assert.match(ko, /다음 · \/scc review <대상>으로 독립 검토/u);
  assert.match(ko, /검증값-EXACT/u);
  assert.match(ko, /evidence:원문-EXACT/u);
  assert.doesNotMatch(
    ko,
    /Quality Engine| · deep ·| · critic ·|게이트 · unproven|Critic findings|not recorded|History ·| refine ·| pivot|Promote ·|Gate ·/,
  );
});

test("auxiliary auth, telemetry, and context overlays keep EN and KO chrome consistent", async () => {
  const catalog = {
    status: "ready",
    providers: [{ id: "openai", name: "OpenAI", available: true, credentialKey: "OPENAI_API_KEY", signedIn: false }],
  };
  const koAuth = await frame({
    uiLocale: "ko", inputValue: "/auth", activePanel: { title: "Auth", lines: [] }, ompAuthCatalog: catalog,
  });
  assert.match(koAuth, /OMP 제공자|입력하여 필터|로그인 안 됨/u);
  assert.doesNotMatch(koAuth, /credentials owned by OMP|type to filter|not signed in|back to work/);
  const enAuth = await frame({
    uiLocale: "en", inputValue: "/auth", activePanel: { title: "Auth", lines: [] }, ompAuthCatalog: catalog,
  });
  assert.match(enAuth, /OMP providers|type to filter|not signed in/);
  assert.doesNotMatch(enAuth, /제공자|필터|로그인 안 됨/u);

  const agentConsole = {
    profileId: "build", activity: [], agents: [], jobs: [],
    mainUsage: { eventIds: ["usage-1"], inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, costUsd: 0.01 },
  };
  const koTelemetry = await frame({
    uiLocale: "ko", activePanel: { title: "Cache Telemetry", lines: [] }, agentConsole,
  });
  assert.match(koTelemetry, /캐시 원격 측정|실시간 제공자 증거|메인 대화|캐시 읽기|절감/u);
  assert.doesNotMatch(koTelemetry, /Cache Telemetry|Live provider evidence|Main conversation|cache read| saved/);

  const contextPacket = {
    id: "packet-1", version: 1, generatedAt: "2026-08-28T00:00:00.000Z", title: "Next answer context",
    included: [{ id: "rules", category: "workspace", label: "AGENTS.md", reason: "workspace guidance", preview: "Keep exact payload.", tokenEstimate: 12, includedInModel: true }],
    excluded: [], warnings: [], preview: [], sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 12, tokenEstimateState: "estimated",
  };
  const koContext = await frame({
    uiLocale: "ko", activePanel: { title: "Context expanded", lines: [] }, contextPacket,
    contextInspectorCursor: 0,
  });
  assert.match(koContext, /컨텍스트 작업대|다음 응답|그룹|모든 소스|지침|전송됨|보류됨|소스|미리보기|선택됨/u);
  assert.match(koContext, /준비 · 컨텍스트 패킷이 다음 응답에 사용할 준비가 되었습니다/u);
  assert.ok(koContext.includes("Keep exact payload."), "context payload remains byte-for-byte");
  assert.ok(koContext.includes("AGENTS.md"), "source identifiers remain byte-for-byte");
  assert.doesNotMatch(koContext, /Context Desk|what reaches the next answer|GROUPS|SOURCES|PREVIEW|Selected|All sources|Guidance|Sent|Held|Context packet looks ready/);
  const enContext = await frame({
    uiLocale: "en", activePanel: { title: "Context expanded", lines: [] }, contextPacket,
    contextInspectorCursor: 0,
  });
  assert.match(enContext, /Context Desk|GROUPS|All sources|Guidance|Sent|Held|SOURCES|PREVIEW|Selected/);
  assert.match(enContext, /Ready · Context packet looks ready for the next answer/);
  assert.doesNotMatch(enContext, /컨텍스트 작업대|다음 응답|그룹|미리보기|선택됨/u);
});
