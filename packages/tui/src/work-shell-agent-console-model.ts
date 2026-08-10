import type {
  AgentConsoleSnapshot,
  AgentConsoleTab,
  AgentRun,
  AsyncJob,
  ToolActivity,
  WorkNode,
  WorkNodeStatus,
} from "@unclecode/contracts";
import type { AgentConsoleSelection } from "@unclecode/orchestrator";

import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";
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
): readonly string[] {
  const graph = snapshot.workGraph;
  if (!graph || graph.nodes.length === 0) {
    return [];
  }

  const bound = boundWidth(width);
  const completed = graph.nodes.filter((node) => node.status === "completed").length;
  // Work that needs a human or is in flight leads; everything settled or not
  // yet started follows in graph order.
  const ordered = [
    ...graph.nodes.filter((node) => isActiveWorkNodeStatus(node.status)),
    ...graph.nodes.filter((node) => !isActiveWorkNodeStatus(node.status)),
  ];
  const visible = ordered.slice(0, WORK_GRAPH_HUD_ROWS);
  const hidden = graph.nodes.length - visible.length;
  const titleBudget = Math.max(8, Math.min(40, bound - 24));

  return [
    boundRow(`${graph.goal ?? graph.id} · ${completed}/${graph.nodes.length}`, bound),
    ...visible.map((node) => truncateForDisplayWidth(
      `${HUD_INDENT}${agentConsoleStatusGlyph(STATUS_TONES[node.status])} `
      + `${boundRow(node.title || node.id, titleBudget)}`
      + ` · ${workNodeStatusLabel(node.status)}`,
      bound,
    )),
    ...(hidden > 0 ? [`${HUD_INDENT}… +${hidden} more`] : []),
  ];
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
    boundRow(`Agents · ${active.length} active`, bound),
    ...visible.map((run) => formatActiveAgentRow(run, now, bound, nameBudget)),
    ...(hidden > 0 ? [`${HUD_INDENT}… +${hidden} more`] : []),
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
): readonly AgentConsoleRow[] {
  switch (tab) {
    case "agents":
      return snapshot.agents.map((run) => ({
        id: run.id,
        glyph: agentConsoleStatusGlyph(STATUS_TONES[run.status]),
        label: flattenRowText(run.displayName),
        statusLabel: run.status,
        tone: STATUS_TONES[run.status],
      }));
    case "jobs":
      return snapshot.jobs.map((job) => ({
        id: job.id,
        glyph: agentConsoleStatusGlyph(STATUS_TONES[job.status]),
        label: flattenRowText(job.label),
        statusLabel: job.status,
        tone: STATUS_TONES[job.status],
      }));
    case "plan":
      return (snapshot.workGraph?.nodes ?? []).map((node) => ({
        id: node.id,
        glyph: agentConsoleStatusGlyph(STATUS_TONES[node.status]),
        label: flattenRowText(node.title || node.id),
        statusLabel: workNodeStatusLabel(node.status),
        tone: STATUS_TONES[node.status],
      }));
  }
}

/**
 * Lifetime spend for the session. A run's `usage.routes` is a breakdown of the
 * same aggregate, so charging both would double every delegated turn. Missing
 * or zero pricing yields `undefined` rather than a manufactured `$0.00`.
 */
export function formatAgentConsoleTotalCost(snapshot: AgentConsoleSnapshot): string | undefined {
  let total = 0;
  const seenEventIds = new Set<string>();
  const usageAggregates = [snapshot.mainUsage, ...snapshot.agents.map((run) => run.usage)];
  for (const usage of usageAggregates) {
    if (usage === undefined) continue;
    const cost = positiveFinite(usage.costUsd);
    if (cost === 0) continue;

    const eventIds = [...new Set(usage.eventIds)];
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
): AgentConsoleInspector | undefined {
  if (!selection) {
    return undefined;
  }
  switch (selection.tab) {
    case "agents":
      return inspectAgentRun(snapshot, selection.run, now, width);
    case "jobs":
      return inspectAsyncJob(snapshot, selection.job, now, width);
    case "plan":
      return inspectWorkNode(selection.node, width);
  }
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
): AgentConsoleInspector {
  const bound = boundWidth(width);
  const facts: AgentConsoleInspectorFact[] = [];

  if (isActiveAgentRun(run)) {
    facts.push({ label: "Elapsed", value: formatElapsedLabel(now - run.startedAt) });
  } else if (run.completedAt !== undefined) {
    facts.push({ label: "Duration", value: formatElapsedLabel(run.completedAt - run.startedAt) });
  }
  const lineage = formatLineage(run);
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
    subtitle: `${run.agentType} · ${run.status}`,
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
    subtitle: `${job.type} · ${job.status}`,
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
function inspectWorkNode(node: WorkNode, width: number): AgentConsoleInspector {
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
      value: formatCount(node.acceptanceCriteria.length, "criterion", "criteria"),
    });
  }
  if (node.evidenceRefs.length > 0) {
    facts.push({ label: "Evidence", value: formatCount(node.evidenceRefs.length, "ref", "refs") });
  }

  return composeInspector({
    title: node.title || node.id,
    subtitle: `task · ${workNodeStatusLabel(node.status)}`,
    tone: STATUS_TONES[node.status],
    facts,
    timeline: [],
    hiddenTimelineCount: 0,
    bound,
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
): string {
  const head = `${HUD_INDENT}${agentConsoleStatusGlyph(STATUS_TONES[run.status])} `
    + `${boundRow(run.displayName, nameBudget)}`
    + ` · ${run.status} ${formatElapsedLabel(now - run.startedAt)}`;
  if (!run.currentActivity) {
    return truncateForDisplayWidth(head, bound);
  }
  const remaining = bound - getDisplayWidth(head) - 3;
  if (remaining < 8) {
    return truncateForDisplayWidth(head, bound);
  }
  return truncateForDisplayWidth(`${head} · ${boundRow(run.currentActivity, remaining)}`, bound);
}

function formatLineage(run: AgentRun): string | undefined {
  if (run.continuationOf) return `continues ${run.continuationOf}`;
  if (run.parentRunId) return `child of ${run.parentRunId}`;
  return undefined;
}


