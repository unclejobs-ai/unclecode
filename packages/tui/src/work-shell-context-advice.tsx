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
): string {
  const source = [...packet.included, ...packet.excluded].find(
    (item) => item.id === suggestion.sourceId,
  );
  if (source) {
    return sanitizeContextPreview(source.label);
  }
  switch (suggestion.reasonCode) {
    case "stale-condensed-history":
      return "recent conversation history";
    case "expired-source":
      return "expired context source";
    case "low-trust-token-hotspot":
      return "oversized context source";
    case "mandatory-guidance":
      return "required project guidance";
    default:
      return "source from the previous packet";
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
        <Text color={input.palette.assistant} bold>{"Suggestions"}</Text>
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
          ? "saving unknown"
          : `save ${formatContextReceiptTokenEstimate({
              tokenEstimate: suggestion.estimatedTokenSaving,
              tokenEstimateState: "estimated",
            })}`;
        const status = suggestion.status === "proposed" ? savings : suggestion.status;
        const actionPrefix = `${selected ? "›" : "·"} ${ACTION_LABELS[suggestion.action]} · `;
        const statusSuffix = ` · ${status}`;
        const sourceLabel = resolveSourceLabel(input.packet, suggestion);
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
                {truncateForDisplayWidth(`Why · ${sanitizeContextPreview(suggestion.reasonText)}`, Math.max(16, input.width))}
              </Text>
            ) : null}
            {selected && suggestion.status === "proposed" && input.actionsEnabled ? (
              <Text color={input.palette.user}>{"A accept · R reject"}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
      {!input.dense && input.suggestions.length > visible.length ? (
        <Text color={input.palette.textMuted}>
          {`… ${input.suggestions.length - visible.length} more`}
        </Text>
      ) : null}
    </Box>
  );
}
