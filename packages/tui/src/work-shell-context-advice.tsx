import type {
  ContextPacketView,
  ContextPolicySuggestion,
} from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import {
  sanitizeContextPreview,
  type ContextInspectorPalette,
} from "./work-shell-context-inspector-model.js";
import { formatContextReceiptTokenEstimate } from "./work-shell-context-receipt.js";
import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";

export const MAX_VISIBLE_CONTEXT_SUGGESTIONS = 4;

const ACTION_LABELS: Readonly<Record<ContextPolicySuggestion["action"], string>> = {
  keep: "Keep",
  refresh: "Refresh",
  summarize: "Summarize",
  "hold-back": "Hold back",
};

/**
 * Keep the advice window small, but never let it hide the one suggestion the
 * reader is standing on. A proposed suggestion for the selected source is
 * pulled into the window even when it ranks fifth or later; without this the
 * accept/reject affordance silently disappears for every late suggestion.
 */
export function getVisibleContextPolicySuggestions(
  suggestions: readonly ContextPolicySuggestion[],
  selectedSourceId?: string | undefined,
): readonly ContextPolicySuggestion[] {
  const head = suggestions.slice(0, MAX_VISIBLE_CONTEXT_SUGGESTIONS);
  if (selectedSourceId === undefined) {
    return head;
  }
  const selected = suggestions.find(
    (suggestion) =>
      suggestion.status === "proposed" && suggestion.sourceId === selectedSourceId,
  );
  if (!selected || head.includes(selected)) {
    return head;
  }
  return [...head.slice(0, MAX_VISIBLE_CONTEXT_SUGGESTIONS - 1), selected];
}

export function getSelectedVisibleContextPolicySuggestion(input: {
  readonly packet?: ContextPacketView | undefined;
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly selectedSourceId?: string | undefined;
}): ContextPolicySuggestion | undefined {
  const suggestion = getVisibleContextPolicySuggestions(input.suggestions, input.selectedSourceId).find(
    (candidate) =>
      candidate.status === "proposed"
      && candidate.sourceId === input.selectedSourceId,
  );
  if (!suggestion || !input.packet || suggestion.action === "keep") {
    return suggestion;
  }
  const source = input.packet.included.find((item) => item.id === suggestion.sourceId)
    ?? input.packet.excluded.find((item) => item.id === suggestion.sourceId);
  if (!source || source.actions === undefined) {
    return source ? suggestion : undefined;
  }
  const requiredAction = suggestion.action === "hold-back" ? "hold-back" : "refresh";
  return source.actions.includes(requiredAction) ? suggestion : undefined;
}

export function computeWorkShellContextAdviceRows(input: {
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly packet?: ContextPacketView | undefined;
  readonly unavailable?: string | undefined;
  readonly selectedSourceId?: string | undefined;
  readonly actionsEnabled: boolean;
  readonly compact?: boolean | undefined;
  readonly dense?: boolean | undefined;
}): number {
  if (input.suggestions.length === 0 && !input.unavailable) {
    return 0;
  }
  const selected = input.actionsEnabled
    ? getSelectedVisibleContextPolicySuggestion(input)
    : undefined;
  const visibleLimit = input.dense || input.compact ? 1 : 2;
  const visibleCount = Math.min(visibleLimit, input.suggestions.length);
  return 1
    + (input.unavailable ? 1 : 0)
    + visibleCount
    + (selected && !input.dense ? 1 : 0)
    + (selected?.status === "proposed" && input.actionsEnabled ? 1 : 0)
    + (!input.dense && input.suggestions.length > visibleCount ? 1 : 0);
}

function resolveSourceLabel(
  packet: ContextPacketView,
  suggestion: ContextPolicySuggestion,
  uiLocale: "en" | "ko" = "en",
): string {
  const source = [...packet.included, ...packet.excluded].find(
    (item) => item.id === suggestion.sourceId,
  );
  if (source) {
    return sanitizeContextPreview(source.label);
  }
  switch (suggestion.reasonCode) {
    case "stale-condensed-history":
      return uiLocale === "ko" ? "최근 대화 기록" : "recent conversation history";
    case "expired-source":
      return uiLocale === "ko" ? "만료된 컨텍스트 소스" : "expired context source";
    case "low-trust-token-hotspot":
      return uiLocale === "ko" ? "너무 큰 컨텍스트 소스" : "oversized context source";
    case "mandatory-guidance":
      return uiLocale === "ko" ? "필수 프로젝트 지침" : "required project guidance";
    default:
      return uiLocale === "ko" ? "이전 패킷의 소스" : "source from the previous packet";
  }
}

export function renderWorkShellContextAdvice(input: {
  readonly packet: ContextPacketView;
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly unavailable?: string | undefined;
  readonly selectedSourceId?: string | undefined;
  readonly actionsEnabled: boolean;
  readonly palette: ContextInspectorPalette;
  readonly width: number;
  /** Stacked layouts pay for their own separation, so drop the top margin. */
  readonly compact?: boolean | undefined;
  readonly dense?: boolean | undefined;
  readonly uiLocale?: "en" | "ko";
}): React.ReactNode {
  if (input.suggestions.length === 0 && !input.unavailable) {
    return null;
  }

  const selectedSuggestion = input.actionsEnabled
    ? getSelectedVisibleContextPolicySuggestion(input)
    : undefined;
  const visibleWindow = getVisibleContextPolicySuggestions(input.suggestions, input.selectedSourceId);
  const prioritized = selectedSuggestion
    ? [selectedSuggestion, ...visibleWindow.filter((suggestion) => suggestion.id !== selectedSuggestion.id)]
    : visibleWindow;
  const visibleLimit = input.dense || input.compact ? 1 : 2;
  const visible = prioritized.slice(0, visibleLimit);
  return (
    <Box marginTop={input.compact ? 0 : 1} flexDirection="column">
      <Text>
        <Text color={input.palette.assistant} bold>{input.uiLocale === "ko" ? "제안" : "Suggestions"}</Text>
        <Text color={input.palette.textMuted}>{` · ${input.suggestions.length}`}</Text>
      </Text>
      {input.unavailable ? (
        <Text color={input.palette.warning}>
          {truncateForDisplayWidth(input.unavailable, Math.max(16, input.width))}
        </Text>
      ) : null}
      {visible.map((suggestion) => {
        const selected = suggestion.id === selectedSuggestion?.id;
        const savings = suggestion.estimatedTokenSaving === undefined
          ? (input.uiLocale === "ko" ? "절감량 알 수 없음" : "saving unknown")
          : `${input.uiLocale === "ko" ? "절감" : "save"} ${formatContextReceiptTokenEstimate({
              tokenEstimate: suggestion.estimatedTokenSaving,
              tokenEstimateState: "estimated",
            })}`;
        const status = suggestion.status === "proposed"
          ? savings
          : input.uiLocale === "ko"
            ? ({ accepted: "승인됨", rejected: "거부됨", stale: "오래됨" } as const)[suggestion.status]
            : suggestion.status;
        const actionLabel = input.uiLocale === "ko"
          ? ({ keep: "유지", refresh: "새로 고침", summarize: "요약", "hold-back": "보류" } as const)[suggestion.action]
          : ACTION_LABELS[suggestion.action];
        const actionPrefix = `${selected ? "›" : "·"} ${actionLabel} · `;
        const statusSuffix = ` · ${status}`;
        const sourceLabel = resolveSourceLabel(input.packet, suggestion, input.uiLocale ?? "en");
        const labelWidth = Math.max(
          0,
          input.width - getDisplayWidth(actionPrefix) - getDisplayWidth(statusSuffix),
        );
        const body = `${actionPrefix}${truncateForDisplayWidth(sourceLabel, labelWidth)}${statusSuffix}`;
        return (
          <React.Fragment key={suggestion.id}>
            <Text color={selected ? input.palette.text : input.palette.textMuted} bold={selected}>
              {truncateForDisplayWidth(body, Math.max(1, input.width))}
            </Text>
            {selected && !input.dense ? (
              <Text color={input.palette.textMuted}>
                {truncateForDisplayWidth(`${input.uiLocale === "ko" ? "이유" : "Why"} · ${sanitizeContextPreview(suggestion.reasonText)}`, Math.max(16, input.width))}
              </Text>
            ) : null}
            {selected && suggestion.status === "proposed" && input.actionsEnabled ? (
              <Text color={input.palette.user}>{input.uiLocale === "ko" ? "A 승인 · R 거부" : "A accept · R reject"}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
      {!input.dense && input.suggestions.length > visible.length ? (
        <Text color={input.palette.textMuted}>
          {input.uiLocale === "ko" ? `… ${input.suggestions.length - visible.length}개 더 있음` : `… ${input.suggestions.length - visible.length} more`}
        </Text>
      ) : null}
    </Box>
  );
}
