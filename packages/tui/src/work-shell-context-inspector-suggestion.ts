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

type ContextInspectorLocale = "en" | "ko";

const KO_CONTEXT_GROUPS: Readonly<Record<ContextInspectorHumanGroup, string>> = {
  "Project instructions": "프로젝트 지침",
  "Current conversation": "현재 대화",
  "Saved memory": "저장된 메모리",
  "Files & attachments": "파일 및 첨부 파일",
  "Tool activity": "도구 활동",
  "Other context": "기타 컨텍스트",
};

export function formatContextSourceGroup(
  category: string,
  uiLocale: ContextInspectorLocale = "en",
): string {
  const group = resolveContextSourceGroup(category);
  return uiLocale === "ko" ? KO_CONTEXT_GROUPS[group] : group;
}

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

function formatSuggestionSourceLabel(
  row: ContextInspectorSuggestionRow,
  uiLocale: ContextInspectorLocale,
): string {
  return `${formatContextSourceGroup(row.item.category, uiLocale)} · ${sanitizeContextPreview(row.item.label)}`;
}

export function formatContextTokenEstimate(
  tokenEstimate: number | undefined,
  state: ContextPacketTokenEstimateState = tokenEstimate === undefined ? "unknown" : "estimated",
  uiLocale: ContextInspectorLocale = "en",
): string {
  if (state === "unknown" || tokenEstimate === undefined) {
    return uiLocale === "ko" ? "토큰 추정치 알 수 없음" : "unknown token estimate";
  }
  const safeEstimate = Math.max(0, Math.trunc(tokenEstimate));
  return state === "exact"
    ? (uiLocale === "ko" ? `${safeEstimate}t 정확` : `${safeEstimate}t exact`)
    : `~${safeEstimate}t`;
}

function formatFreshnessPhrase(
  row: ContextInspectorSuggestionRow,
  uiLocale: ContextInspectorLocale,
): string {
  const freshness = row.item.freshness;
  if (!freshness || (freshness.state !== "stale" && freshness.state !== "expired")) {
    return "";
  }
  if (uiLocale === "ko") {
    const state = freshness.state === "stale" ? "오래됨" : "만료됨";
    return freshness.turnLastSeen === undefined || freshness.turnLastSeen === null
      ? state
      : `${freshness.turnLastSeen}턴 이후 ${state}`;
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
  readonly uiLocale?: ContextInspectorLocale;
}): ContextInspectorSuggestion {
  const uiLocale = input.uiLocale ?? "en";
  const includedRows = input.rows.filter((row) => !row.heldBack && row.item.includedInModel !== false);
  const largestRow = includedRows.reduce<ContextInspectorSuggestionRow | undefined>((largest, row) => {
    if (!largest) {
      return row;
    }
    return (row.item.tokenEstimate ?? 0) > (largest.item.tokenEstimate ?? 0) ? row : largest;
  }, undefined);

  if ((input.budgetState === "tight" || input.budgetState === "over") && largestRow) {
    const freshnessPhrase = formatFreshnessPhrase(largestRow, uiLocale);
    return {
      tone: "warning",
      message: uiLocale === "ko"
        ? `예산이 ${input.budgetState === "over" ? "초과되었습니다" : "빠듯합니다"}. 가장 큰 소스는 ${formatSuggestionSourceLabel(largestRow, uiLocale)}이며 ${formatContextTokenEstimate(largestRow.item.tokenEstimate, undefined, uiLocale)}${freshnessPhrase ? `, ${freshnessPhrase}` : ""}입니다.`
        : `Budget is ${input.budgetState}. Largest source is ${formatSuggestionSourceLabel(largestRow, uiLocale)} at ${formatContextTokenEstimate(largestRow.item.tokenEstimate)}${freshnessPhrase ? ` and ${freshnessPhrase}` : ""}.`,
    };
  }

  const staleRow = includedRows.find((row) =>
    row.item.freshness?.state === "stale" || row.item.freshness?.state === "expired");
  if (staleRow) {
    return {
      tone: "warning",
      message: uiLocale === "ko"
        ? `최신성 위험: ${formatContextSourceGroup(staleRow.item.category, uiLocale)} 소스를 새로 고쳐야 합니다(${formatFreshnessPhrase(staleRow, uiLocale)}).`
        : `Freshness risk: ${resolveContextSourceGroup(staleRow.item.category)} source needs refresh (${formatFreshnessPhrase(staleRow, uiLocale)}).`,
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
    message: uiLocale === "ko"
      ? "컨텍스트 패킷이 다음 응답에 사용할 준비가 되었습니다."
      : "Context packet looks ready for the next answer.",
  };
}
