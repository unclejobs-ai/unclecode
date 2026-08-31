import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextInspectorOverview,
  buildContextInspectorRows,
  formatContextTokenEstimate,
  formatContextItemBadgeSummary,
  getContextItemDetailLines,
  getContextItemPreview,
  resolveContextSourceMeta,
  computeContextOverlayViewportMaxRows,
  isContextInspectorSourceHeldBack,
} from "../../packages/tui/src/work-shell-context-inspector-model.ts";

test("context inspector model appends packet badges to human preview text", () => {
  const item = {
    id: "skill-catalog",
    category: "workspace",
    label: "Skill catalog",
    reason: "bootstrap skill manifests",
    preview: "analyze",
    badges: [
      { label: "catalog", tone: "info" },
      { label: "resources", tone: "info" },
    ],
  };

  assert.equal(formatContextItemBadgeSummary(item), "[catalog] [resources]");
  assert.equal(getContextItemPreview(item), "analyze · [catalog] [resources]");
});

test("context inspector model keeps badge fallback on reason-only items", () => {
  const item = {
    id: "raw-reference",
    category: "workspace",
    label: "runbook.md",
    reason: "reference stays local",
    badges: [{ label: "held raw", tone: "muted" }],
  };

  assert.equal(getContextItemPreview(item), "reference stays local · [held raw]");
});

test("context inspector model expands condensed history metadata for human inspection", () => {
  const item = {
    id: "compact-history",
    category: "condensed-history",
    label: "Session history compact",
    reason: "compressed session history; CRP controls inclusion",
    preview: "History compressed by recent-window summary.",
    badges: [
      { label: "compressed", tone: "info" },
      { label: "recent-window", tone: "muted" },
    ],
    metadata: {
      kind: "condensed-history",
      sourceEventIds: ["trace-a", "trace-b", "trace-c"],
      summary: "3 earlier trace lines summarized; 8 recent trace lines stay as runtime rows.",
      recomputeReason: "history exceeded recent-window threshold",
      compactedEventCount: 3,
      recentEventCount: 8,
      compression: {
        method: "recent-window",
        inputTokensEstimate: 30,
        outputTokensEstimate: 11,
      },
    },
  };

  assert.deepEqual(getContextItemDetailLines(item), [
    "History compressed by recent-window summary. · [compressed] [recent-window]",
    "Compression · recent-window · 3 compacted · 8 recent kept · ~30t in / ~11t out",
    "Summary · 3 earlier trace lines summarized; 8 recent trace lines stay as runtime rows.",
    "Reason · history exceeded recent-window threshold",
    "Provenance · 3 trace ids · trace-a, trace-b, trace-c",
  ]);
});

test("context inspector model warns when condensed history metadata is stale", () => {
  const item = {
    id: "compact-history",
    category: "condensed-history",
    label: "Session history compact",
    reason: "compressed session history; CRP controls inclusion",
    preview: "History compressed by recent-window summary.",
    freshness: {
      state: "stale",
      turnLastSeen: 1,
    },
    metadata: {
      kind: "condensed-history",
      sourceEventIds: ["trace-a"],
      summary: "1 earlier trace line summarized; 8 recent trace lines stay as runtime rows.",
      recomputeReason: "history exceeded recent-window threshold",
      compactedEventCount: 1,
      recentEventCount: 8,
      compression: {
        method: "recent-window",
        inputTokensEstimate: 10,
        outputTokensEstimate: 4,
      },
    },
  };

  assert.equal(
    getContextItemDetailLines(item)[1],
    "Warning · compressed summary is stale; refresh before relying on it · last seen turn 1",
  );
});

test("context inspector overview warns about stale heavy sources without exposing unproven actions", () => {
  const packet = {
    id: "packet-pressure",
    version: 1,
    generatedAt: "2026-07-07T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "runtime-terminal",
        category: "runtime",
        label: "terminal output",
        reason: "latest shell output",
        preview: "long terminal trace",
        tokenEstimate: 6200,
        freshness: { state: "stale", turnLastSeen: 4 },
      },
      {
        id: "agents-guidance",
        category: "workspace-guidance",
        label: "AGENTS.md",
        reason: "repo instructions",
        tokenEstimate: 200,
      },
    ],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 2, excluded: 0, warnings: 0 },
    tokenEstimate: 6400,
  };

  const overview = buildContextInspectorOverview({
    packet,
    rows: buildContextInspectorRows(packet),
    cursorIndex: 0,
    modelWindow: 7000,
  });

  assert.equal(overview.suggestion.tone, "warning");
  assert.equal(
    overview.suggestion.message,
    "Budget is tight. Largest source is Tool activity · terminal output at ~6200t and stale since turn 4.",
  );
});

test("context inspector overview phrases stale-only preflight copy cleanly", () => {
  const packet = {
    id: "packet-stale-only",
    version: 1,
    generatedAt: "2026-07-08T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "runtime-terminal",
        category: "runtime",
        label: "terminal output",
        reason: "latest shell output",
        preview: "recent terminal trace",
        tokenEstimate: 80,
        freshness: { state: "stale" },
      },
    ],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 80,
  };

  const overview = buildContextInspectorOverview({
    packet,
    rows: buildContextInspectorRows(packet),
    cursorIndex: 0,
    modelWindow: 200000,
  });

  assert.equal(overview.suggestion.tone, "warning");
  assert.equal(
    overview.suggestion.message,
    "Freshness risk: Tool activity source needs refresh (stale).",
  );
  assert.doesNotMatch(overview.suggestion.message, /is and stale/);
});

test("context inspector overview does not invent zero-token savings for unknown source estimates", () => {
  const packet = {
    id: "packet-unknown-source-estimate",
    version: 1,
    generatedAt: "2026-07-08T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "runtime-terminal",
        category: "runtime",
        label: "terminal output",
        reason: "latest shell output",
        preview: "long terminal trace",
      },
    ],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 6400,
  };

  const overview = buildContextInspectorOverview({
    packet,
    rows: buildContextInspectorRows(packet),
    cursorIndex: 0,
    modelWindow: 7000,
  });

  assert.equal(overview.suggestion.tone, "warning");
  assert.doesNotMatch(overview.suggestion.message, /~0t/);
  assert.match(overview.suggestion.message, /unknown token estimate/);
});

test("context token labels distinguish estimated, exact, and unknown totals", () => {
  assert.equal(formatContextTokenEstimate(42, "estimated"), "~42t");
  assert.equal(formatContextTokenEstimate(42, "exact"), "42t exact");
  assert.equal(formatContextTokenEstimate(0, "unknown"), "unknown token estimate");
  assert.equal(formatContextTokenEstimate(42, "estimated", "ko"), "~42t");
  assert.equal(formatContextTokenEstimate(42, "exact", "ko"), "42t 정확");
  assert.equal(formatContextTokenEstimate(0, "unknown", "ko"), "토큰 추정치 알 수 없음");
});

test("context readiness follows locale without changing source payload", () => {
  const source = {
    id: "rules",
    category: "workspace",
    label: "AGENTS.md EXACT",
    includedInModel: true,
    tokenEstimate: 12,
  };
  const packet = {
    included: [source], excluded: [], warnings: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 12, tokenEstimateState: "estimated",
  };
  const rows = buildContextInspectorRows(packet);
  assert.equal(
    buildContextInspectorOverview({ packet, rows, modelWindow: 1000, uiLocale: "en" }).suggestion.message,
    "Context packet looks ready for the next answer.",
  );
  assert.equal(
    buildContextInspectorOverview({ packet, rows, modelWindow: 1000, uiLocale: "ko" }).suggestion.message,
    "컨텍스트 패킷이 다음 응답에 사용할 준비가 되었습니다.",
  );
  assert.equal(rows[0].item.label, "AGENTS.md EXACT");
});

test("context inspector delivery state follows staging-first cursor identity", () => {
  const packet = {
    included: [{
      id: "runtime-sent",
      category: "runtime",
      label: "runtime sent",
      includedInModel: true,
    }],
    excluded: [{
      id: "workspace-held",
      category: "workspace",
      label: "workspace held",
      includedInModel: false,
    }],
  };
  const rows = buildContextInspectorRows(packet);
  assert.equal(rows[0].item.id, "runtime-sent");
  assert.equal(isContextInspectorSourceHeldBack(packet, 0), false);
  assert.equal(isContextInspectorSourceHeldBack(packet, 1), true);
});

const palette = {
  text: "text",
  textMuted: "muted",
  textDim: "dim",
  borderSoft: "soft",
  borderDefault: "default",
  assistant: "assistant",
  user: "user",
  toolAccent: "tool",
  spinner: "spinner",
  warning: "warning",
  success: "success",
};

test("context inspector maps CRP categories to human groups and never renders raw unknowns", () => {
  assert.equal(resolveContextSourceMeta("workspace-guidance", palette).label, "Project instructions");
  assert.equal(resolveContextSourceMeta("workspace", palette).label, "Project instructions");
  assert.equal(resolveContextSourceMeta("workspace-guidance-1", palette).label, "Project instructions");
  assert.equal(resolveContextSourceMeta("provider-system-prompt", palette).label, "Project instructions");
  assert.equal(resolveContextSourceMeta("system", palette).label, "Project instructions");
  assert.equal(resolveContextSourceMeta("bridge", palette).label, "Current conversation");
  assert.equal(resolveContextSourceMeta("condensed-history", palette).label, "Current conversation");
  assert.equal(resolveContextSourceMeta("memory", palette).label, "Saved memory");
  assert.equal(resolveContextSourceMeta("attachment", palette).label, "Files & attachments");
  assert.equal(resolveContextSourceMeta("runtime", palette).label, "Tool activity");
  assert.equal(resolveContextSourceMeta("loop-trail", palette).label, "Tool activity");
  assert.equal(resolveContextSourceMeta("live", palette).label, "Tool activity");
  assert.equal(resolveContextSourceMeta("mystery-provider", palette).label, "Other context");
  assert.equal(resolveContextSourceMeta("totally-unknown", palette).label, "Other context");
});

test("context inspector viewport uses one physical terminalRows budget", () => {
  assert.equal(computeContextOverlayViewportMaxRows({ terminalRows: 40 }), 15);
  assert.equal(computeContextOverlayViewportMaxRows({ terminalRows: 24 }), 6);
  assert.equal(computeContextOverlayViewportMaxRows({}), 24);
});
