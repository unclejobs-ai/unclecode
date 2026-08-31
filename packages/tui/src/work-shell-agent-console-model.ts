import type {
  AgentConsoleSnapshot,
  AgentConsoleTab,
  AgentRun,
  AgentRunStatus,
  AsyncJob,
  AsyncJobStatus,
  QualityReviewHistoryEntry,
  ToolActivity,
  WorkNode,
  WorkNodeStatus,
} from "@unclecode/contracts";
import { getWorkShellMessages, type AgentConsoleSelection } from "@unclecode/orchestrator";

import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";
import { selectRecordedEvolutionProposalLines } from "./evolution-proposal-lines.js";
import {
  agentConsoleStatusGlyph,
  boundBlock,
  boundRow,
  boundWidth,
  flattenRowText,
  formatAgentConsoleActivityPreviewLines,
  formatCount,
  formatElapsedLabel,
  formatTokens,
  formatUsd,
  positiveFinite,
  STATUS_TONES,
  toolActivityGlyph,
  workNodeStatusLabel,
  type AgentConsoleRowTone,
} from "./work-shell-agent-console-format.js";

export type { AgentConsoleRowTone } from "./work-shell-agent-console-format.js";

/**
 * Pure projections behind the default HUD and the Agent Console overlay.
 *
 * Everything here reads the immutable `AgentConsoleSnapshot` and returns
 * bounded strings or plain row records. A worker's system prompt, its raw
 * assignment text, and raw tool output never reach the snapshot, and the
 * projections below deliberately never touch the one raw field that does
 * survive on a plan node — `WorkNode.prompt`.
 */

/** Default HUD budget: the plan block never grows past three task rows. */
const WORK_GRAPH_HUD_ROWS = 3;
/** Default HUD budget: the agent block never grows past four run rows. */
const ACTIVE_AGENT_HUD_ROWS = 4;
/** Inspector budget: a run's filtered timeline stays scannable. */
const INSPECTOR_TIMELINE_ROWS = 6;
/** Inspector budget: a 400-character summary is evidence, not a paragraph. */
const INSPECTOR_OUTCOME_ROWS = 3;
/** A quality summary names the first few findings and counts the rest. */
const QUALITY_FINDING_ROWS = 3;
/** Columns between an inspector fact's label and its value. */
const FACT_LABEL_GAP = 2;

const HUD_INDENT = "  ";

export type AgentConsoleRow = {
  readonly id: string;
  readonly glyph: string;
  readonly label: string;
  readonly statusLabel: string;
  readonly tone: AgentConsoleRowTone;
};

export type AgentConsoleInspectorFact = {
  readonly label: string;
  readonly value: string;
};

/**
 * Safe projection of the selected record. `timeline` is a filtered view of the
 * snapshot's own tool activity — never a provider transcript.
 */
export type AgentConsoleInspector = {
  readonly title: string;
  readonly subtitle: string;
  readonly tone: AgentConsoleRowTone;
  /**
   * Column the renderer pads fact labels to. The model owns it because it is
   * the budget every fact value was already truncated against.
   */
  readonly factLabelWidth: number;
  readonly facts: readonly AgentConsoleInspectorFact[];
  readonly timeline: readonly string[];
  readonly hiddenTimelineCount: number;
  /** Bounded wrap of the final summary; never more than three rows. */
  readonly outcome: readonly string[];
};

export function selectWorkGraphHudRows(
  snapshot: AgentConsoleSnapshot,
  width: number,
  options: { readonly expanded?: boolean; readonly uiLocale?: "en" | "ko" } = {},
): readonly string[] {
  const uiLocale = options.uiLocale ?? "en";
  const messages = getWorkShellMessages(uiLocale);
  const graph = snapshot.workGraph;
  const review = snapshot.qualityReview;
  if (!graph || graph.nodes.length === 0) {
    if (!review?.profile || !review.currentStage || review.iteration === undefined) return [];
    if (review.profile === "minimal") {
      return [boundRow(
        `${uiLocale === "ko" ? "품질 엔진" : messages.qualityEngine} · ${localizedQualityProfile(review.profile, uiLocale)}`
        + ` · ${messages.gate} ${localizedGateDecision(review.latestDecision, uiLocale)}`
        + (uiLocale === "ko" ? " · /scc 상세" : " · /scc details"),
        boundWidth(width),
      )];
    }
    return [boundRow(
      `${uiLocale === "ko" ? "품질 엔진" : messages.qualityEngine} · ${localizedQualityProfile(review.profile, uiLocale)} · ${localizedQualityStage(review.currentStage, uiLocale)}`
      + ` · PDCA ${localizedPdcaPhase(review.currentStage, uiLocale)}`
      + ` · ${messages.gate} ${localizedGateDecision(review.latestDecision, uiLocale)} · ${uiLocale === "ko" ? "반복" : "iteration"} ${review.iteration}`,
      boundWidth(width),
    )];
  }

  const bound = boundWidth(width);
  const completed = graph.nodes.filter((node) => node.status === "completed").length;
  const isQualityGraph = graph.qualityProfile !== undefined;
  // Quiet hierarchy: current task → remaining stage → blocker →
  // optional completed detail. Each role contributes at most one nearby row,
  // and explicit Plan expansion remains the only surface that shows all nodes.
  const nearby = ([
    graph.nodes.find((node) => node.status === "running"),
    graph.nodes.find((node) => node.status === "ready" || node.status === "approved" || node.status === "proposed"),
    graph.nodes.find((node) => node.status === "requires_action" || node.status === "blocked" || node.status === "failed"),
    [...graph.nodes].reverse().find((node) => node.status === "completed"),
    ...graph.nodes,
  ] satisfies readonly (WorkNode | undefined)[])
    .filter((node): node is WorkNode => node !== undefined)
    .filter((node, index, nodes) => nodes.indexOf(node) === index);
  const visible = options.expanded ? graph.nodes : nearby.slice(0, WORK_GRAPH_HUD_ROWS);
  const hidden = graph.nodes.length - visible.length;
  const titleBudget = Math.max(8, Math.min(40, bound - 24));

  if (isQualityGraph) {
    const remaining = graph.nodes.length - completed;
    return [
      boundRow(
        `${uiLocale === "ko" ? "품질 엔진" : messages.qualityEngine} · ${localizedQualityProfile(graph.qualityProfile, uiLocale)} · ${localizedQualityStage(graph.currentStage, uiLocale)}`
        + ` · PDCA ${localizedPdcaPhase(graph.currentStage, uiLocale)}`
        + ` · ${messages.gate} ${localizedGateDecision(graph.gateStatus, uiLocale)} · ${uiLocale === "ko" ? "반복" : "iteration"} ${graph.iteration}`,
        bound,
      ),
      ...visible.map((node) => truncateForDisplayWidth(
        `${HUD_INDENT}${qualityNodeGlyph(node.status)} `
        + `${boundRow(node.title || node.id, titleBudget)}`
        + ` · ${localizedWorkNodeStatus(node.status, uiLocale)}`,
        bound,
      )),
      ...(options.expanded && hidden > 0 ? [`${HUD_INDENT}… +${hidden} ${uiLocale === "ko" ? "더 있음" : "more"}`] : []),
      boundRow(
        `${completed}/${graph.nodes.length} ${uiLocale === "ko" ? "완료" : "complete"} · ${remaining} ${uiLocale === "ko" ? "남음" : "remaining"}`
        + (options.expanded ? (uiLocale === "ko" ? " · Ctrl+T 축소" : " · Ctrl+T compact") : (uiLocale === "ko" ? " · Ctrl+T 전체 계획" : " · Ctrl+T full plan")),
        bound,
      ),
    ];
  }

  return [
    boundRow(`${graph.goal ?? graph.id} · ${completed}/${graph.nodes.length}`, bound),
    ...visible.map((node) => truncateForDisplayWidth(
      `${HUD_INDENT}${agentConsoleStatusGlyph(STATUS_TONES[node.status])} `
      + `${boundRow(node.title || node.id, titleBudget)}`
      + ` · ${localizedWorkNodeStatus(node.status, uiLocale)}`,
      bound,
    )),
    ...(options.expanded && hidden > 0 ? [`${HUD_INDENT}… +${hidden}${uiLocale === "ko" ? "개 더 있음" : " more"}`] : []),
  ];
}

function qualityPdcaPhase(
  stage: "explore" | "plan" | "work" | "critic" | "promote",
): "plan" | "do" | "check" | "act" {
  if (stage === "explore" || stage === "plan") return "plan";
  if (stage === "work") return "do";
  if (stage === "critic") return "check";
  return "act";
}

function localizedPdcaPhase(
  stage: "explore" | "plan" | "work" | "critic" | "promote",
  uiLocale: "en" | "ko",
): string {
  if (uiLocale === "en") return qualityPdcaPhase(stage);
  switch (qualityPdcaPhase(stage)) {
    case "plan": return "계획";
    case "do": return "실행";
    case "check": return "점검";
    case "act": return "개선";
  }
}

function qualityNodeGlyph(status: WorkNodeStatus): string {
  if (status === "completed") return "✓";
  if (status === "running") return "●";
  if (status === "failed" || status === "cancelled") return "×";
  if (status === "blocked" || status === "requires_action") return "◆";
  return "○";
}

export function selectQualityReviewLines(
  snapshot: AgentConsoleSnapshot,
  width: number,
  uiLocale: "en" | "ko" = "en",
): readonly string[] {
  const m = getWorkShellMessages(uiLocale);
  const graph = snapshot.workGraph;
  const review = snapshot.qualityReview;
  if (!graph && !review) {
    const bound = boundWidth(width);
    return [
      boundRow(uiLocale === "ko" ? "SCC 품질 엔진 · 준비됨" : "SCC Quality Engine · ready", bound),
      boundRow(uiLocale === "ko"
        ? "이 세션에 기록된 품질 실행이 없습니다."
        : "No quality run recorded for this session.", bound),
      boundRow(uiLocale === "ko"
        ? "작업을 시작하거나 /scc review <대상> 으로 명시적 검토를 실행하세요."
        : "Start a task, or /scc review <target> for an explicit review.", bound),
    ];
  }
  const bound = boundWidth(width);
  const profile = graph?.qualityProfile ?? review?.profile;
  const stage = graph?.currentStage ?? review?.currentStage;
  const iteration = graph?.iteration ?? review?.iteration;
  const gate = graph?.gateStatus ?? review?.latestDecision;
  if (!profile || !stage || iteration === undefined || !gate) {
    return [uiLocale === "ko" ? "품질 검토 사용 불가 · 품질 상태 불완전" : "Quality review unavailable · incomplete quality projection"];
  }
  const criticNodes = (graph?.nodes ?? []).filter((node) => node.role === "critic" || node.stage === "critic");
  const findings = criticNodes.filter((node) => node.status === "failed" || node.status === "blocked");
  const latest = review?.history.at(-1);
  const evidenceReview = selectLastEvidenceBearingReview(review?.history) ?? latest;
  const hasHistory = (review?.history.length ?? 0) > 0;
  const boundedFindings = findings.slice(0, QUALITY_FINDING_ROWS);
  const hiddenFindingCount = Math.max(0, findings.length - boundedFindings.length);
  const boundedFailures = evidenceReview?.failures.slice(0, QUALITY_FINDING_ROWS) ?? [];
  const hiddenFailureCount = Math.max(0, (evidenceReview?.failures.length ?? 0) - boundedFailures.length);
  const qualityFailureLabel = uiLocale === "ko" ? "실패" : "Critic finding";
  const evolution = (snapshot.evolutionProposals ?? [])
    .filter(proposal => review?.runId === undefined || proposal.runId === review.runId)
    .at(-1);
  return [
    boundRow(
      `${uiLocale === "ko" ? "품질 엔진" : "Quality Engine"} (SCC) · ${localizedQualityProfile(profile, uiLocale)} · ${localizedQualityStage(stage, uiLocale)}`
      + ` · PDCA ${localizedPdcaPhase(stage, uiLocale)} · ${uiLocale === "ko" ? "반복" : "iteration"} ${iteration}`,
      bound,
    ),
    boundRow(`${m.gate} · ${localizedGateDecision(gate, uiLocale)}`, bound),
    ...(review && !hasHistory
      ? [boundRow(uiLocale === "ko" ? "아직 검토 기록이 없습니다." : "No review history recorded yet.", bound)]
      : []),
    ...(latest?.event === "completed"
      ? [boundRow(`${uiLocale === "ko" ? "완료" : "Completion"} · ${localizedQualityStage(latest.stage, uiLocale)} · ${localizedGateDecision(latest.decision, uiLocale)}`, bound)]
      : []),
    ...(gate === "unproven"
      ? [boundRow(uiLocale === "ko" ? "미입증 · 독립 검토 증거가 없거나 만료됨" : "Unproven · independent review evidence is missing or stale", bound)]
      : []),
    ...(findings.length > 0
      ? [
          boundRow(`${uiLocale === "ko" ? "비평 발견" : "Critic findings"} · ${findings.length} ${uiLocale === "ko" ? "개" : "total"}`, bound),
          ...boundedFindings.map((node) => boundRow(`${uiLocale === "ko" ? "발견" : "Finding"} · ${node.title || node.id} · ${localizedWorkNodeStatus(node.status, uiLocale)}`, bound)),
          ...(hiddenFindingCount > 0
            ? [boundRow(uiLocale === "ko" ? `  … ${hiddenFindingCount}개 더 있음` : `  … +${hiddenFindingCount} more findings`, bound)]
            : []),
        ]
      : [boundRow(
          profile === "minimal"
            ? (uiLocale === "ko" ? "비평 · 최소 프로필에서는 필요 없음" : "Critic · not required by minimal profile")
            : (uiLocale === "ko"
              ? `비평 결과 · ${criticNodes.length === 0 ? "기록 없음" : "열린 항목 없음"}`
              : `Critic findings · ${criticNodes.length === 0 ? "not recorded" : "none open"}`),
          bound,
        )]),
    ...(evidenceReview?.reason ? [boundRow(`${m.reason} · ${evidenceReview.reason}`, bound)] : []),
    ...(boundedFailures.length > 0
      ? [
          ...boundedFailures.map((failure) => boundRow(`${qualityFailureLabel} · ${failure}`, bound)),
          ...(hiddenFailureCount > 0
            ? [boundRow(uiLocale === "ko" ? `  … ${hiddenFailureCount}개 실패 더 있음` : `  … +${hiddenFailureCount} more failures`, bound)]
            : []),
        ]
      : []),
    ...(evidenceReview?.reviewerId
      ? [boundRow(`${m.reviewer} · ${evidenceReview.reviewerId} · ${evidenceReview.independentVerification ? m.independent : m.notIndependent}`, bound)]
      : []),
    ...(evidenceReview && !evidenceReview.reviewerId
      ? [boundRow(`${uiLocale === "ko" ? "검증" : "Verification"} · ${evidenceReview.independentVerification ? m.independent : m.notIndependent}`, bound)]
      : []),
    ...(evidenceReview?.reviewerRunId ? [boundRow(`${uiLocale === "ko" ? "검토 실행" : "Reviewer run"} · ${evidenceReview.reviewerRunId}`, bound)] : []),
    ...(evidenceReview?.route || evidenceReview?.provider || evidenceReview?.model
      ? [boundRow(`${m.route} · ${[evidenceReview.route, evidenceReview.provider, evidenceReview.model].filter(Boolean).join(" · ")}`, bound)]
      : []),
    ...(evidenceReview?.reviewedArtifactHash
      ? [boundRow(`${uiLocale === "ko" ? "검토 해시" : "Reviewed hash"} · ${evidenceReview.reviewedArtifactHash}`, bound)]
      : []),
    ...(evidenceReview?.currentArtifactHash
      ? [boundRow(`${uiLocale === "ko" ? "현재 해시" : "Current hash"} · ${evidenceReview.currentArtifactHash}${evidenceReview.stale ? ` · ${m.stale}` : ` · ${m.current}`}`, bound)]
      : []),
    ...(!evidenceReview?.reviewedArtifactHash && evidenceReview?.artifactHash
      ? [boundRow(`${uiLocale === "ko" ? "산출물 해시" : "Artifact hash"} · ${evidenceReview.artifactHash}${evidenceReview.stale ? ` · ${m.stale}` : ""}`, bound)]
      : []),
    ...(evidenceReview?.count !== undefined && evidenceReview.limit !== undefined
      ? [boundRow(`${uiLocale === "ko"
        ? (evidenceReview.event === "pivot" ? "전환 시도" : "개선 시도")
        : `${evidenceReview.event === "pivot" ? "Pivot" : "Refine"} attempt`} · ${evidenceReview.count}/${evidenceReview.limit}`, bound)]
      : []),
    ...(evidenceReview && evidenceReview.evidenceRefs.length > 0
      ? [boundRow(`${m.evidence} · ${evidenceReview.evidenceRefs.join(", ")}`, bound)]
      : []),
    ...(review ? [boundRow(uiLocale === "ko"
      ? `기록 · 개선 ${review.refineCount} · 전환 ${review.pivotCount}`
      : `History · ${review.refineCount} refine · ${review.pivotCount} pivot`, bound)] : []),
    ...(review && !hasHistory
      ? [boundRow(uiLocale === "ko"
        ? (findings.length > 0
          ? "다음 · 계획에서 비평 발견을 확인한 뒤 /scc review <대상> 실행"
          : "다음 · 비평 증거를 기다리거나 /scc review <대상> 실행")
        : (findings.length > 0
          ? "Next · inspect Plan findings, then run /scc review <target>"
          : "Next · wait for critic evidence or run /scc review <target>"), bound)]
      : []),
    ...selectRecordedEvolutionProposalLines(evolution, bound),
    ...(graph !== undefined || hasHistory
      ? [boundRow(uiLocale === "ko" ? "정리 · 인계/종합 전용" : "Promote · handoff/synthesis only", bound)]
      : []),
  ];
}

function localizedWorkNodeStatus(status: WorkNodeStatus, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return workNodeStatusLabel(status);
  const labels: Record<WorkNodeStatus, string> = {
    proposed: "제안", approved: "승인", ready: "준비", running: "실행 중", completed: "완료",
    failed: "실패", blocked: "차단", cancelled: "취소", requires_action: "조치 필요",
  };
  return labels[status];
}

function selectLastEvidenceBearingReview(
  history: readonly QualityReviewHistoryEntry[] | undefined,
): QualityReviewHistoryEntry | undefined {
  if (!history) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (
      entry
      && entry.event === "gate"
      && (
        entry.failures.length > 0
        || entry.evidenceRefs.length > 0
        || entry.artifactRefs.length > 0
        || entry.artifactHash !== undefined
        || entry.reviewedArtifactHash !== undefined
        || entry.currentArtifactHash !== undefined
        || entry.reviewerId !== undefined
        || entry.reviewerRunId !== undefined
        || entry.route !== undefined
      )
    ) {
      return entry;
    }
  }
  return undefined;
}

/** A job the operator is still waiting on, dispatched or not. */
function isActiveAsyncJob(job: AsyncJob): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Any agent or job the operator is still waiting on. */
export function hasActiveAgentConsoleWork(snapshot: AgentConsoleSnapshot): boolean {
  return snapshot.agents.some(isActiveAgentRun) || snapshot.jobs.some(isActiveAsyncJob);
}

export type AgentConsoleActiveCounts = {
  readonly agents: number;
  readonly jobs: number;
};

/**
 * How much delegated work is live, for the shell's single status row. Shares
 * both liveness rules with {@link hasActiveAgentConsoleWork} so the row can
 * never disagree with the spinner beside it.
 */
export function selectActiveAgentConsoleCounts(
  snapshot: AgentConsoleSnapshot,
): AgentConsoleActiveCounts {
  const activeJobs = snapshot.jobs.filter(isActiveAsyncJob);
  const jobRunIds = new Set(
    activeJobs
      .map((job) => job.agentRunId)
      .filter((runId): runId is string => runId !== undefined),
  );
  return {
    agents: snapshot.agents.filter(
      (run) => isActiveAgentRun(run) && !jobRunIds.has(run.id),
    ).length,
    jobs: activeJobs.length,
  };
}

export function selectActiveAgentHudRows(
  snapshot: AgentConsoleSnapshot,
  now: number,
  width: number,
  uiLocale: "en" | "ko" = "en",
): readonly string[] {
  const active = snapshot.agents.filter(isActiveAgentRun);
  if (active.length === 0) {
    return [];
  }

  const bound = boundWidth(width);
  const visible = active.slice(0, ACTIVE_AGENT_HUD_ROWS);
  const hidden = active.length - visible.length;
  const nameBudget = Math.max(8, Math.min(28, Math.trunc(bound * 0.3)));

  return [
    boundRow(uiLocale === "ko" ? `에이전트 · ${active.length}개 활성` : `Agents · ${active.length} active`, bound),
    ...visible.map((run) => formatActiveAgentRow(run, now, bound, nameBudget, uiLocale)),
    ...(hidden > 0 ? [`${HUD_INDENT}… +${hidden}${uiLocale === "ko" ? "개 더 있음" : " more"}`] : []),
  ];
}

/**
 * One row per record, in snapshot order. The console cursor indexes the raw
 * `agents`/`jobs`/`workGraph.nodes` arrays, so reordering or dropping settled
 * records here would make the cursor address a different run than the one the
 * operator can see.
 */
export function selectAgentConsoleRows(
  snapshot: AgentConsoleSnapshot,
  tab: AgentConsoleTab,
  uiLocale: "en" | "ko" = "en",
): readonly AgentConsoleRow[] {
  switch (tab) {
    case "agents":
      return snapshot.agents.map((run) => ({
        id: run.id,
        glyph: agentConsoleStatusGlyph(STATUS_TONES[run.status]),
        label: flattenRowText(run.displayName),
        statusLabel: localizedAgentRunStatus(run.status, uiLocale),
        tone: STATUS_TONES[run.status],
      }));
    case "jobs":
      return snapshot.jobs.map((job) => ({
        id: job.id,
        glyph: agentConsoleStatusGlyph(STATUS_TONES[job.status]),
        label: flattenRowText(job.label),
        statusLabel: localizedAsyncJobStatus(job.status, uiLocale),
        tone: STATUS_TONES[job.status],
      }));
    case "plan":
      return (snapshot.workGraph?.nodes ?? []).map((node) => ({
        id: node.id,
        glyph: agentConsoleStatusGlyph(STATUS_TONES[node.status]),
        label: flattenRowText(node.title || node.id),
        statusLabel: localizedWorkNodeStatus(node.status, uiLocale),
        tone: STATUS_TONES[node.status],
      }));
    case "quality":
      return [...(snapshot.qualityReview?.history ?? [])].reverse().map((entry, index) => ({
        id: `${entry.startedAt}:${entry.iteration}:${entry.event}:${index}`,
        glyph: agentConsoleStatusGlyph(qualityDecisionTone(entry.decision)),
        label: flattenRowText(
          `${uiLocale === "ko" ? "반복" : "iteration"} ${entry.iteration} · ${localizedQualityStage(entry.stage, uiLocale)} · ${localizedQualityEvent(entry.event, uiLocale)}`,
        ),
        statusLabel: localizedGateDecision(entry.decision, uiLocale),
        tone: qualityDecisionTone(entry.decision),
      }));
  }
}

/**
 * Lifetime spend for the session. A run's `usage.routes` is a breakdown of the
 * same aggregate, so charging both would double every delegated turn. Missing
 * or zero pricing yields `undefined` rather than a manufactured `$0.00`.
 */
export function formatAgentConsoleTotalCost(snapshot: AgentConsoleSnapshot): string | undefined {
  const ownerTotal = positiveFinite(snapshot.totalUsage?.costUsd);
  if (ownerTotal > 0) return formatUsd(ownerTotal);
  let total = 0;
  const seenEventIds = new Set<string>();
  const usageAggregates = [snapshot.mainUsage, ...snapshot.agents.map((run) => run.usage)];
  for (const usage of usageAggregates) {
    if (usage === undefined) continue;
    const cost = positiveFinite(usage.costUsd);
    if (cost === 0) continue;

    const eventIds = [...new Set(usage.eventIds ?? [])];
    if (eventIds.length === 0) {
      total += cost;
      continue;
    }
    const unseenCount = eventIds.filter((eventId) => !seenEventIds.has(eventId)).length;
    for (const eventId of eventIds) {
      seenEventIds.add(eventId);
    }
    total += cost * (unseenCount / eventIds.length);
  }
  // Individually finite costs can still overflow their sum; `$Infinity` is a
  // worse answer than admitting the total is unknown.
  return total > 0 && Number.isFinite(total) ? formatUsd(total) : undefined;
}

export function selectAgentConsoleInspector(
  snapshot: AgentConsoleSnapshot,
  selection: AgentConsoleSelection | undefined,
  now: number,
  width: number,
  uiLocale: "en" | "ko" = "en",
): AgentConsoleInspector | undefined {
  if (!selection) {
    return undefined;
  }
  switch (selection.tab) {
    case "agents":
      return inspectAgentRun(snapshot, selection.run, now, width, uiLocale);
    case "jobs":
      return inspectAsyncJob(snapshot, selection.job, now, width, uiLocale);
    case "plan":
      return inspectWorkNode(selection.node, width, snapshot.workGraph, snapshot.qualityReview, uiLocale);
    case "quality":
      return inspectQualityReview(selection.review, width, uiLocale);
  }
}

function qualityDecisionTone(decision: QualityReviewHistoryEntry["decision"]): AgentConsoleRowTone {
  if (decision === "proceed") return "success";
  if (decision === "block") return "danger";
  if (decision === "refine" || decision === "pivot") return "warning";
  return "pending";
}

export function isActiveAgentRun(run: AgentRun): boolean {
  return run.status === "running" || run.status === "waiting";
}

export function isActiveWorkNodeStatus(status: WorkNodeStatus): boolean {
  return status === "running"
    || status === "blocked"
    || status === "requires_action"
    || status === "failed";
}

/**
 * The run's own tool calls, newest window first. The filter is the whole
 * safety story: an activity without a matching `agentRunId` belongs to the
 * main agent and is not this run's to show.
 */
function scopedTimeline(
  snapshot: AgentConsoleSnapshot,
  agentRunId: string | undefined,
  bound: number,
): Pick<AgentConsoleInspector, "timeline" | "hiddenTimelineCount"> {
  const scoped = agentRunId === undefined
    ? []
    : snapshot.activity.filter((activity) => activity.agentRunId === agentRunId);
  const visible = scoped.slice(-INSPECTOR_TIMELINE_ROWS);
  return {
    timeline: buildTimeline(visible, bound),
    hiddenTimelineCount: scoped.length - visible.length,
  };
}

function inspectAgentRun(
  snapshot: AgentConsoleSnapshot,
  run: AgentRun,
  now: number,
  width: number,
  uiLocale: "en" | "ko",
): AgentConsoleInspector {
  const bound = boundWidth(width);
  const facts: AgentConsoleInspectorFact[] = [];

  if (isActiveAgentRun(run)) {
    facts.push({ label: "Elapsed", value: formatElapsedLabel(now - run.startedAt) });
  } else if (run.completedAt !== undefined) {
    facts.push({ label: "Duration", value: formatElapsedLabel(run.completedAt - run.startedAt) });
  }
  const lineage = formatLineage(run, uiLocale);
  if (lineage) {
    facts.push({ label: "Lineage", value: lineage });
  }
  if (run.currentActivity) {
    facts.push({ label: "Activity", value: run.currentActivity });
  }
  const inputTokens = positiveFinite(run.usage?.inputTokens);
  if (inputTokens > 0) {
    facts.push({ label: "Input", value: formatTokens(inputTokens) });
  }
  const cost = positiveFinite(run.usage?.costUsd);
  if (cost > 0) {
    facts.push({ label: "Cost", value: formatUsd(cost) });
  }

  return composeInspector({
    title: run.displayName,
    subtitle: `${localizedAgentType(run.agentType, uiLocale)} · ${localizedAgentRunStatus(run.status, uiLocale)}`,
    tone: STATUS_TONES[run.status],
    facts,
    ...scopedTimeline(snapshot, run.id, bound),
    ...(run.errorSummary ?? run.summary
      ? { outcome: run.errorSummary ?? run.summary }
      : {}),
    bound,
  });
}

/**
 * The one place inspector rows are budgeted. Fact values are truncated against
 * the space left after the label column, so a value can never push its row past
 * the pane and make ink wrap it onto a second line.
 */
function composeInspector(input: {
  readonly title: string;
  readonly subtitle: string;
  readonly tone: AgentConsoleRowTone;
  readonly facts: readonly AgentConsoleInspectorFact[];
  readonly timeline: readonly string[];
  readonly hiddenTimelineCount: number;
  readonly outcome?: string;
  readonly bound: number;
}): AgentConsoleInspector {
  const factLabelWidth = input.facts.length === 0
    ? 0
    : Math.max(...input.facts.map((fact) => getDisplayWidth(fact.label))) + FACT_LABEL_GAP;
  const valueBudget = Math.max(6, input.bound - factLabelWidth);
  return {
    // The renderer prefixes the title with a two-cell status glyph.
    title: boundRow(input.title, Math.max(4, input.bound - 2)),
    subtitle: boundRow(input.subtitle, input.bound),
    tone: input.tone,
    factLabelWidth,
    facts: input.facts.map((fact) => ({
      label: fact.label,
      value: boundRow(fact.value, valueBudget),
    })),
    timeline: input.timeline,
    hiddenTimelineCount: input.hiddenTimelineCount,
    outcome: boundBlock(input.outcome, input.bound, INSPECTOR_OUTCOME_ROWS),
  };
}

function inspectAsyncJob(
  snapshot: AgentConsoleSnapshot,
  job: AsyncJob,
  now: number,
  width: number,
  uiLocale: "en" | "ko",
): AgentConsoleInspector {
  const bound = boundWidth(width);
  const facts: AgentConsoleInspectorFact[] = [];

  // A job can settle before it is ever dispatched. Reading `startedAt` first
  // left those rows on a clock that kept counting after the job was gone.
  if (job.completedAt !== undefined) {
    facts.push({
      label: "Duration",
      value: formatElapsedLabel(job.completedAt - (job.startedAt ?? job.queuedAt)),
    });
  } else if (job.startedAt !== undefined) {
    facts.push({ label: "Elapsed", value: formatElapsedLabel(now - job.startedAt) });
  } else {
    facts.push({ label: "Queued", value: formatElapsedLabel(now - job.queuedAt) });
  }
  if (job.agentRunId !== undefined) {
    const owner = snapshot.agents.find((run) => run.id === job.agentRunId);
    facts.push({ label: "Owner", value: owner?.displayName ?? job.agentRunId });
  }

  return composeInspector({
    title: job.label,
    subtitle: `${localizedJobType(job.type, uiLocale)} · ${localizedAsyncJobStatus(job.status, uiLocale)}`,
    tone: STATUS_TONES[job.status],
    facts,
    ...scopedTimeline(snapshot, job.agentRunId, bound),
    ...(job.errorSummary ?? job.summary
      ? { outcome: job.errorSummary ?? job.summary }
      : {}),
    bound,
  });
}

/**
 * A plan node carries the executor's raw assignment in `prompt`. The inspector
 * projects only the operator-facing fields, so that text has no path here.
 */
function inspectWorkNode(
  node: WorkNode,
  width: number,
  graph?: AgentConsoleSnapshot["workGraph"],
  qualityReview?: AgentConsoleSnapshot["qualityReview"],
  uiLocale: "en" | "ko" = "en",
): AgentConsoleInspector {
  const bound = boundWidth(width);
  const facts: AgentConsoleInspectorFact[] = [];
  if (node.dependsOn.length > 0) {
    facts.push({ label: "Depends on", value: node.dependsOn.join(", ") });
  }
  if (node.fileOwnership.length > 0) {
    facts.push({ label: "Owns", value: node.fileOwnership.join(", ") });
  }
  if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
    facts.push({
      label: "Acceptance",
      value: uiLocale === "ko"
        ? `기준 ${node.acceptanceCriteria.length}개`
        : formatCount(node.acceptanceCriteria.length, "criterion", "criteria"),
    });
  }
  if (node.evidenceRefs.length > 0) {
    facts.push({
      label: "Evidence",
      value: uiLocale === "ko"
        ? `참조 ${node.evidenceRefs.length}개`
        : formatCount(node.evidenceRefs.length, "ref", "refs"),
    });
  }
  if (node.artifactRefs?.length > 0) {
    facts.push({ label: "Artifacts", value: node.artifactRefs.join(", ") });
  }
  if (node.stage) facts.push({ label: "Stage", value: localizedQualityStage(node.stage, uiLocale) });
  if (node.role) facts.push({ label: "Role", value: localizedQualityRole(node.role, uiLocale) });
  if (node.attempt !== undefined) facts.push({ label: "Attempt", value: String(node.attempt) });
  if (node.reviewRequired !== undefined) {
    facts.push({
      label: "Review",
      value: node.reviewRequired
        ? (uiLocale === "ko" ? "필수" : "required")
        : (uiLocale === "ko" ? "필수 아님" : "not required"),
    });
  }
  if (graph?.gateStatus) facts.push({ label: "Gate", value: graph.gateStatus });
  const completedReview = qualityReview?.history.findLast((entry) => entry.event === "completed");
  if (completedReview) {
    facts.push({
      label: "Completion",
      value: `${localizedQualityStage(completedReview.stage, uiLocale)} · ${localizedGateDecision(completedReview.decision, uiLocale)}`,
    });
  }
  const reviewEntries = qualityReview?.history.filter((entry) =>
    entry.artifactRefs.some((reference) => node.artifactRefs.includes(reference))) ?? [];
  const latestReview = selectLastEvidenceBearingReview(reviewEntries)
    ?? selectLastEvidenceBearingReview(qualityReview?.history)
    ?? qualityReview?.history.at(-1);
  if (latestReview?.reviewerId) {
    facts.push({
      label: "Reviewer",
      value: `${latestReview.reviewerId} · ${latestReview.independentVerification
        ? (uiLocale === "ko" ? "독립" : "independent")
        : (uiLocale === "ko" ? "독립 아님" : "not independent")}`,
    });
  }
  if (latestReview?.reviewerRunId) {
    facts.push({ label: "Reviewer run", value: latestReview.reviewerRunId });
  }
  if (latestReview?.route || latestReview?.provider || latestReview?.model) {
    facts.push({
      label: "Route",
      value: [latestReview.route, latestReview.provider, latestReview.model].filter(Boolean).join(" · "),
    });
  }
  if (latestReview?.reviewedArtifactHash) {
    facts.push({ label: "Reviewed hash", value: latestReview.reviewedArtifactHash });
  }
  if (latestReview?.currentArtifactHash) {
    facts.push({
      label: "Current hash",
      value: `${latestReview.currentArtifactHash}${latestReview.stale
        ? (uiLocale === "ko" ? " · 만료" : " · stale")
        : (uiLocale === "ko" ? " · 현재" : " · current")}`,
    });
  } else if (latestReview?.artifactHash) {
    facts.push({
      label: "Artifact hash",
      value: `${latestReview.artifactHash}${latestReview.stale ? (uiLocale === "ko" ? " · 만료" : " · stale") : ""}`,
    });
  }
  if (latestReview?.count !== undefined && latestReview.limit !== undefined) {
    facts.push({ label: "Attempt", value: `${latestReview.count}/${latestReview.limit}` });
  }

  return composeInspector({
    title: node.title || node.id,
    subtitle: `${uiLocale === "ko" ? "작업" : "task"} · ${localizedWorkNodeStatus(node.status, uiLocale)}`,
    tone: STATUS_TONES[node.status],
    facts,
    timeline: latestReview
      ? [
          ...(latestReview.reason ? [`${uiLocale === "ko" ? "이유" : "Reason"} · ${latestReview.reason}`] : []),
          ...latestReview.failures.map((failure) => `${uiLocale === "ko" ? "실패" : "Failure"} · ${failure}`),
          ...latestReview.evidenceRefs.map((evidence) => `${uiLocale === "ko" ? "증거" : "Evidence"} · ${evidence}`),
        ]
      : [],
    hiddenTimelineCount: 0,
    bound,
  });
}

function inspectQualityReview(
  review: QualityReviewHistoryEntry,
  width: number,
  uiLocale: "en" | "ko",
): AgentConsoleInspector {
  const facts: AgentConsoleInspectorFact[] = [
    { label: "Gate", value: localizedGateDecision(review.decision, uiLocale) },
    { label: "Stage", value: localizedQualityStage(review.stage, uiLocale) },
    { label: "Iteration", value: String(review.iteration) },
    {
      label: "Verification",
      value: review.independentVerification
        ? (uiLocale === "ko" ? "독립" : "independent")
        : (uiLocale === "ko" ? "독립 아님" : "not independent"),
    },
  ];
  if (review.reviewerId) facts.push({ label: "Reviewer", value: review.reviewerId });
  if (review.reviewerRunId) facts.push({ label: "Reviewer run", value: review.reviewerRunId });
  if (review.route || review.provider || review.model) {
    facts.push({
      label: "Route",
      value: [review.route, review.provider, review.model].filter(Boolean).join(" · "),
    });
  }
  if (review.reviewedArtifactHash) facts.push({ label: "Reviewed hash", value: review.reviewedArtifactHash });
  if (review.currentArtifactHash) {
    facts.push({
      label: "Current hash",
      value: `${review.currentArtifactHash}${review.stale
        ? (uiLocale === "ko" ? " · 만료" : " · stale")
        : (uiLocale === "ko" ? " · 현재" : " · current")}`,
    });
  } else if (review.artifactHash) {
    facts.push({ label: "Artifact hash", value: review.artifactHash });
  }
  if (review.count !== undefined && review.limit !== undefined) {
    facts.push({ label: "Attempt", value: `${review.count}/${review.limit}` });
  }

  return composeInspector({
    title: `${uiLocale === "ko" ? "반복" : "Iteration"} ${review.iteration} · ${localizedQualityEvent(review.event, uiLocale)}`,
    subtitle: `${localizedQualityStage(review.stage, uiLocale)} · ${localizedGateDecision(review.decision, uiLocale)}`,
    tone: qualityDecisionTone(review.decision),
    facts,
    timeline: [
      ...(review.reason ? [`${uiLocale === "ko" ? "이유" : "Reason"} · ${review.reason}`] : []),
      ...review.failures.map((failure) => `${uiLocale === "ko" ? "비평 발견" : "Critic finding"} · ${failure}`),
      ...review.evidenceRefs.map((evidence) => `${uiLocale === "ko" ? "증거" : "Evidence"} · ${evidence}`),
      ...review.artifactRefs.map((artifact) => `${uiLocale === "ko" ? "산출물" : "Artifact"} · ${artifact}`),
    ],
    hiddenTimelineCount: 0,
    bound: boundWidth(width),
  });
}

function buildTimeline(
  activity: readonly ToolActivity[],
  bound: number,
): readonly string[] {
  const lines: string[] = [];
  for (const entry of activity) {
    const target = entry.target && !entry.intent.includes(entry.target)
      ? flattenRowText(entry.target)
      : undefined;
    const detail = flattenRowText(entry.summary ?? entry.status);
    lines.push(truncateForDisplayWidth(
      `${HUD_INDENT}${toolActivityGlyph(entry.status)} `
      + [flattenRowText(entry.intent), target, detail]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" · "),
      bound,
    ));
  }
  // Only the newest change carries its diff; stacking every preview would turn
  // the inspector back into the ledger this replaced.
  const withPreview = [...activity].reverse().find((entry) => entry.preview !== undefined);
  if (withPreview?.preview) {
    lines.push(...formatAgentConsoleActivityPreviewLines(withPreview.preview, bound));
  }
  return lines;
}

function formatActiveAgentRow(
  run: AgentRun,
  now: number,
  bound: number,
  nameBudget: number,
  uiLocale: "en" | "ko",
): string {
  const head = `${HUD_INDENT}${agentConsoleStatusGlyph(STATUS_TONES[run.status])} `
    + `${boundRow(run.displayName, nameBudget)}`
    + ` · ${localizedAgentRunStatus(run.status, uiLocale)} ${formatElapsedLabel(now - run.startedAt)}`;
  if (!run.currentActivity) {
    return truncateForDisplayWidth(head, bound);
  }
  const remaining = bound - getDisplayWidth(head) - 3;
  if (remaining < 8) {
    return truncateForDisplayWidth(head, bound);
  }
  return truncateForDisplayWidth(`${head} · ${boundRow(run.currentActivity, remaining)}`, bound);
}

function formatLineage(run: AgentRun, uiLocale: "en" | "ko"): string | undefined {
  if (run.continuationOf) return `${uiLocale === "ko" ? "이어받은 실행" : "continues"} ${run.continuationOf}`;
  if (run.parentRunId) return `${uiLocale === "ko" ? "상위 실행" : "child of"} ${run.parentRunId}`;
  return undefined;
}

function localizedAgentRunStatus(status: AgentRunStatus, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return status;
  return ({
    queued: "대기",
    running: "실행 중",
    waiting: "응답 대기",
    completed: "완료",
    failed: "실패",
    cancelled: "취소",
    interrupted: "중단",
  } as const)[status];
}

function localizedAsyncJobStatus(status: AsyncJobStatus, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return status;
  return ({
    queued: "대기",
    running: "실행 중",
    completed: "완료",
    failed: "실패",
    cancelled: "취소",
    interrupted: "중단",
  } as const)[status];
}

function localizedAgentType(agentType: string, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return agentType;
  return ({
    scout: "탐색",
    planner: "계획",
    worker: "작업",
    executor: "실행",
    critic: "비평",
    reviewer: "검토",
    guardian: "검증",
  } as Readonly<Record<string, string>>)[agentType] ?? agentType;
}

function localizedJobType(jobType: string, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return jobType;
  return ({
    "work-node": "작업 노드",
    agent: "에이전트",
    review: "검토",
  } as Readonly<Record<string, string>>)[jobType] ?? jobType;
}

function localizedQualityStage(stage: string, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return stage;
  return ({ explore: "탐색", plan: "계획", work: "작업", critic: "비평", promote: "정리" } as Readonly<Record<string, string>>)[stage] ?? stage;
}

function localizedQualityEvent(event: QualityReviewHistoryEntry["event"], uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return event;
  return ({ gate: "게이트", refine: "개선", pivot: "전환", completed: "완료" } as const)[event];
}

function localizedQualityProfile(profile: string, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return profile;
  return ({ minimal: "최소", standard: "표준", deep: "심층", creator: "창작" } as Readonly<Record<string, string>>)[profile] ?? profile;
}

function localizedQualityRole(role: string, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return role;
  return ({ explorer: "탐색", planner: "계획", worker: "작업", critic: "비평", promoter: "정리" } as Readonly<Record<string, string>>)[role] ?? role;
}

function localizedGateDecision(decision: string, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return decision;
  return ({ proceed: "진행", refine: "개선", pivot: "전환", block: "차단", unproven: "미입증" } as Readonly<Record<string, string>>)[decision] ?? decision;
}
