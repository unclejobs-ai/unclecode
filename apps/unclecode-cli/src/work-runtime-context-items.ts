import type {
  ContextPacketSourceCategory,
  ContextPacketViewItem,
  WorkGraph,
  WorkNode,
} from "@unclecode/contracts";

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function buildContextLineItems(input: {
  readonly lines: readonly string[];
  readonly category: ContextPacketSourceCategory;
  readonly idPrefix: string;
  readonly reason: string;
}): readonly ContextPacketViewItem[] {
  return input.lines.map((line, index) => ({
    id: `${input.idPrefix}-${index + 1}`,
    category: input.category,
    label: line,
    reason: input.reason,
    preview: line,
    tokenEstimate: estimateTokens(line),
  }));
}

export function buildWorkGraphContextItems(
  graph: WorkGraph | undefined,
): readonly ContextPacketViewItem[] {
  if (!graph) {
    return [];
  }

  const completed = graph.nodes.filter((node) => node.status === "completed").length;
  const terminal = graph.nodes.filter((node) =>
    node.status === "completed" || node.status === "failed" || node.status === "blocked" || node.status === "cancelled"
  ).length;
  const goal = graph.goal?.replace(/\s+/g, " ").trim().slice(0, 180);
  const summary = `${completed}/${graph.nodes.length} completed · ${terminal}/${graph.nodes.length} terminal`;
  const prioritizedNodes = [...graph.nodes].sort(
    (left, right) => Number(isActiveGoalTaskStatus(right.status)) - Number(isActiveGoalTaskStatus(left.status)),
  );
  return [
    {
      id: `goal-loop-${graph.id}`,
      category: "loop-trail",
      label: `Goal loop · ${summary}`,
      reason: "current autonomous goal-task state",
      ...(goal ? { preview: goal } : {}),
      tokenEstimate: estimateTokens(`${summary} ${goal ?? ""}`),
    },
    ...prioritizedNodes.slice(0, WORK_NODE_ITEM_LIMIT).map((node): ContextPacketViewItem => {
      const title = condenseWorkNodeText(node.title, WORK_NODE_TITLE_LIMIT) || node.id;
      const label = `${node.status} · ${title}`;
      const preview = describeWorkNode(node, title);
      return {
        id: `goal-loop-${graph.id}-${node.id}`,
        category: "loop-trail",
        label,
        reason: "current autonomous task state",
        preview,
        tokenEstimate: estimateTokens(`${label} ${preview}`),
        metadata: {
          kind: "work-node",
          graphId: graph.id,
          nodeId: node.id,
          title,
          ...(goal ? { goal } : {}),
          constraints: [...(graph.constraints ?? [])],
          status: node.status,
          acceptanceCriteria: [...(node.acceptanceCriteria ?? [])],
          evidenceRefs: [...node.evidenceRefs],
        },
      };
    }),
  ];
}

const WORK_NODE_ITEM_LIMIT = 4;
const WORK_NODE_TITLE_LIMIT = 120;
const WORK_NODE_DETAIL_PREVIEW_LIMIT = 90;
const WORK_NODE_LISTED_DETAIL_LIMIT = 2;

function condenseWorkNodeText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function describeWorkNodeDetails(
  values: readonly string[],
): string | undefined {
  const meaningful = values.filter((value) => value.trim().length > 0);
  if (meaningful.length === 0) {
    return undefined;
  }
  const listed = meaningful
    .slice(0, WORK_NODE_LISTED_DETAIL_LIMIT)
    .map((value) => condenseWorkNodeText(value, WORK_NODE_DETAIL_PREVIEW_LIMIT));
  const remaining = meaningful.length - listed.length;
  return remaining > 0 ? `${listed.join("; ")} (+${remaining} more)` : listed.join("; ");
}

/**
 * Human-readable task preview. Counts alone ("2 acceptance criteria") tell the
 * reader nothing actionable, so the row states what the task is, what would
 * finish it, and what has been captured so far. The node's raw executor prompt
 * is private and never appears here.
 */
function describeWorkNode(node: WorkNode, title: string): string {
  const criteria = describeWorkNodeDetails(node.acceptanceCriteria ?? []);
  const evidence = describeWorkNodeDetails(node.evidenceRefs);
  return [
    `Aim: ${title}`,
    `Done when: ${criteria ?? "no acceptance criteria recorded yet"}`,
    `Evidence: ${evidence ?? "nothing captured yet"}`,
  ].join(" · ");
}

function isActiveGoalTaskStatus(
  status: WorkGraph["nodes"][number]["status"],
): boolean {
  return status === "running" || status === "blocked" || status === "requires_action";
}

function isWorkspaceGuidanceSummaryLine(line: string): boolean {
  return (
    /^(Loaded guidance|Deduped duplicate guidance|Conflict|Loaded skills|Skill catalog):/i.test(line) ||
    /^(?:AGENTS|CLAUDE|GEMINI|UNCLECODE)(?:\.local)?\.md:/i.test(line) ||
    /^rules\/.+\.md:/i.test(line)
  );
}

const WORKSPACE_GUIDANCE_SAFE_PREVIEW =
  "Workspace guidance is active; raw guidance text stays out of the context view.";

function extractWorkspaceGuidanceSource(line: string): string | undefined {
  const sourceMatch = /^((?:AGENTS|CLAUDE|GEMINI|UNCLECODE)(?:\.local)?\.md|rules\/.+\.md):/i.exec(line);
  return sourceMatch?.[1];
}

export function buildContextSummaryItems(lines: readonly string[]): readonly ContextPacketViewItem[] {
  return lines.map((line, index) => {
    const workspaceGuidance = isWorkspaceGuidanceSummaryLine(line);
    const workspaceGuidanceSource = workspaceGuidance ? extractWorkspaceGuidanceSource(line) : undefined;
    const label = workspaceGuidanceSource ? "Workspace guidance" : line;
    const preview = workspaceGuidanceSource
      ? `${workspaceGuidanceSource} — ${WORKSPACE_GUIDANCE_SAFE_PREVIEW}`
      : line;

    return {
      id: workspaceGuidance
        ? `workspace-guidance-${index + 1}`
        : `workspace-context-${index + 1}`,
      category: workspaceGuidance ? "workspace-guidance" : "workspace",
      label,
      reason: workspaceGuidance ? "workspace guidance summary" : "loaded workspace context",
      preview,
      tokenEstimate: estimateTokens(`${label} ${preview}`),
    };
  });
}

export function formatCountLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

const OMO_EXCLUDED_DETAIL_LIMIT = 6;

export function buildOmoExcludedPacketItems(
  excludedArtifacts: readonly { readonly path: string; readonly reason: string }[],
): readonly ContextPacketViewItem[] {
  if (excludedArtifacts.length <= OMO_EXCLUDED_DETAIL_LIMIT) {
    return excludedArtifacts.map((item, index) => ({
      id: `loop-trail-excluded-${index + 1}`,
      category: "loop-trail",
      label: "loop trail artifact",
      reason: item.reason,
      preview: item.path,
    }));
  }

  const evidenceArtifacts = excludedArtifacts.filter((item) => /evidence/i.test(item.reason));
  const otherArtifacts = excludedArtifacts.filter((item) => !/evidence/i.test(item.reason));
  const items: ContextPacketViewItem[] = otherArtifacts
    .slice(0, OMO_EXCLUDED_DETAIL_LIMIT - 1)
    .map((item, index) => ({
      id: `loop-trail-excluded-${index + 1}`,
      category: "loop-trail",
      label: "loop trail artifact",
      reason: item.reason,
      preview: item.path,
    }));

  if (otherArtifacts.length > items.length) {
    const additionalArtifactCount = otherArtifacts.length - items.length;
    items.push({
      id: "loop-trail-excluded-other-summary",
      category: "loop-trail",
      label: `${formatCountLabel(additionalArtifactCount, "additional loop trail artifact", "additional loop trail artifacts")}`,
      reason: "loop trail artifacts stay local",
      sourceCount: additionalArtifactCount,
    });
  }

  if (evidenceArtifacts.length > 0) {
    items.push({
      id: "loop-trail-excluded-evidence-summary",
      category: "loop-trail",
      label: `${formatCountLabel(evidenceArtifacts.length, "loop trail evidence transcript", "loop trail evidence transcripts")}`,
      reason: "loop trail evidence transcripts stay local",
      preview: "Detailed evidence paths stay local; use the loop trail session evidence directory for full transcripts.",
      sourceCount: evidenceArtifacts.length,
    });
  }

  return items;
}
