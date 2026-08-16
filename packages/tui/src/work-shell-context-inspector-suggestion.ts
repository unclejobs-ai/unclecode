import type {
  ContextPacketTokenEstimateState,
  ContextPacketView,
  ContextPacketViewItem,
} from "@unclecode/contracts";

import { sanitizeContextPreview } from "@unclecode/orchestrator";

export type ContextInspectorBudgetState = "roomy" | "steady" | "tight" | "over";
export type ContextInspectorSuggestionTone = "success" | "info" | "warning";

export type ContextInspectorSuggestion = {
  readonly tone: ContextInspectorSuggestionTone;
  readonly message: string;
};

export const CONTEXT_INSPECTOR_GROUP_ORDER = [
  "Project instructions",
  "Current conversation",
  "Saved memory",
  "Files & attachments",
  "Tool activity",
  "Other context",
] as const;

export type ContextInspectorHumanGroup = (typeof CONTEXT_INSPECTOR_GROUP_ORDER)[number];

type ContextInspectorSuggestionRow = {
  readonly item: ContextPacketViewItem;
  readonly heldBack: boolean;
};

export function resolveContextSourceGroup(category: string): ContextInspectorHumanGroup {
  if (
    /^(workspace-guidance|workspace|provider-system-prompt)/i.test(category)
    || /^system$/i.test(category)
  ) {
    return "Project instructions";
  }
  if (/^(bridge|condensed-history)/i.test(category)) {
    return "Current conversation";
  }
  if (/^memory/i.test(category)) {
    return "Saved memory";
  }
  if (/^attachment/i.test(category)) {
    return "Files & attachments";
  }
  if (/^(loop-trail|runtime|live)/i.test(category)) {
    return "Tool activity";
  }
  return "Other context";
}

function formatSuggestionSourceLabel(row: ContextInspectorSuggestionRow): string {
  return `${resolveContextSourceGroup(row.item.category)} · ${sanitizeContextPreview(row.item.label)}`;
}

export function formatContextTokenEstimate(
  tokenEstimate: number | undefined,
  state: ContextPacketTokenEstimateState = tokenEstimate === undefined ? "unknown" : "estimated",
): string {
  if (state === "unknown" || tokenEstimate === undefined) {
    return "unknown token estimate";
  }
  const safeEstimate = Math.max(0, Math.trunc(tokenEstimate));
  return state === "exact" ? `${safeEstimate}t exact` : `~${safeEstimate}t`;
}

function formatFreshnessPhrase(row: ContextInspectorSuggestionRow): string {
  const freshness = row.item.freshness;
  if (!freshness || (freshness.state !== "stale" && freshness.state !== "expired")) {
    return "";
  }
  const turnSuffix = freshness.turnLastSeen === undefined || freshness.turnLastSeen === null
    ? ""
    : ` since turn ${freshness.turnLastSeen}`;
  return `${freshness.state}${turnSuffix}`;
}

export function resolveContextInspectorSuggestion(input: {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSuggestionRow[];
  readonly budgetState: ContextInspectorBudgetState;
}): ContextInspectorSuggestion {
  const includedRows = input.rows.filter((row) => !row.heldBack && row.item.includedInModel !== false);
  const largestRow = includedRows.reduce<ContextInspectorSuggestionRow | undefined>((largest, row) => {
    if (!largest) {
      return row;
    }
    return (row.item.tokenEstimate ?? 0) > (largest.item.tokenEstimate ?? 0) ? row : largest;
  }, undefined);

  if ((input.budgetState === "tight" || input.budgetState === "over") && largestRow) {
    const freshnessPhrase = formatFreshnessPhrase(largestRow);
    return {
      tone: "warning",
      message: `Budget is ${input.budgetState}. Largest source is ${formatSuggestionSourceLabel(largestRow)} at ${formatContextTokenEstimate(largestRow.item.tokenEstimate)}${freshnessPhrase ? ` and ${freshnessPhrase}` : ""}.`,
    };
  }

  const staleRow = includedRows.find((row) =>
    row.item.freshness?.state === "stale" || row.item.freshness?.state === "expired");
  if (staleRow) {
    return {
      tone: "warning",
      message: `Freshness risk: ${resolveContextSourceGroup(staleRow.item.category)} source needs refresh (${formatFreshnessPhrase(staleRow)}).`,
    };
  }

  const warning = input.packet.warnings[0];
  if (warning) {
    return {
      tone: warning.severity === "info" ? "info" : "warning",
      message: `${warning.code}: ${warning.message}`,
    };
  }

  return {
    tone: "success",
    message: "Context packet looks ready for the next answer.",
  };
}
