import type {
  ContextPacketSourceCategory,
  ContextPacketViewItem,
  WorkGraph,
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
    ...prioritizedNodes.slice(0, 4).map((node): ContextPacketViewItem => {
      const title = node.title?.slice(0, 120) || node.id;
      return {
        id: `goal-loop-${graph.id}-${node.id}`,
        category: "loop-trail",
        label: `${node.status} · ${title}`,
        reason: "current autonomous task state",
        preview: `${node.dependsOn?.length ?? 0} dependencies · ${node.acceptanceCriteria?.length ?? 0} acceptance criteria`,
        tokenEstimate: estimateTokens(`${node.status} ${title}`),
      };
    }),
  ];
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
