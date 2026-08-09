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
import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";

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
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly selectedSourceId?: string | undefined;
}): ContextPolicySuggestion | undefined {
  return getVisibleContextPolicySuggestions(input.suggestions, input.selectedSourceId).find(
    (suggestion) =>
      suggestion.status === "proposed"
      && suggestion.sourceId === input.selectedSourceId,
  );
}

export function computeWorkShellContextAdviceRows(input: {
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly unavailable?: string | undefined;
  readonly selectedSourceId?: string | undefined;
  readonly actionsEnabled: boolean;
  readonly compact?: boolean | undefined;
  readonly dense?: boolean | undefined;
}): number {
  if (input.suggestions.length === 0 && !input.unavailable) {
    return 0;
  }
  const visibleWindow = getVisibleContextPolicySuggestions(input.suggestions, input.selectedSourceId);
  const selectedSuggestion = input.actionsEnabled
    ? getSelectedVisibleContextPolicySuggestion(input)
    : undefined;
  const visible = input.dense
    ? selectedSuggestion ? [selectedSuggestion] : visibleWindow.slice(0, 1)
    : input.compact
      ? selectedSuggestion ? [selectedSuggestion] : visibleWindow.slice(0, 2)
      : visibleWindow;
  const selectedDetailRows = selectedSuggestion === undefined ? 0 : input.dense ? 1 : 3;
  return (input.compact ? 1 : 2)
    + (input.unavailable ? 1 : 0)
    + visible.length
    + selectedDetailRows
    + (!input.dense && input.suggestions.length > visible.length ? 1 : 0);
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
  const selectedSuggestionId = selectedSuggestion?.id;
  const visibleWindow = getVisibleContextPolicySuggestions(input.suggestions, input.selectedSourceId);
  const visible = input.dense
    ? selectedSuggestion ? [selectedSuggestion] : visibleWindow.slice(0, 1)
    : input.compact
      ? selectedSuggestion ? [selectedSuggestion] : visibleWindow.slice(0, 2)
      : visibleWindow;
  return (
    <Box marginTop={input.compact ? 0 : 1} flexDirection="column">
      <Text>
        <Text color={input.palette.assistant} bold>{"Context optimizer"}</Text>
        <Text color={input.palette.textMuted}>{" · advice for this packet"}</Text>
      </Text>
      {input.unavailable ? (
        <Text color={input.palette.warning}>
          {truncateForDisplayWidth(
            `  ${input.unavailable}`,
            Math.max(16, input.width - 4),
          )}
        </Text>
      ) : null}
      {visible.map((suggestion) => {
        const selected = suggestion.id === selectedSuggestionId;
        const savings = suggestion.estimatedTokenSaving === undefined
          ? "Savings unknown"
          : `Save ${formatContextReceiptTokenEstimate({
              tokenEstimate: suggestion.estimatedTokenSaving,
              tokenEstimateState: "estimated",
            })}`;
        const status = suggestion.status === "proposed"
          ? savings
          : suggestion.status;
        const reasonLines = selected && !input.dense
          ? wrapDisplayTextFast(suggestion.reasonText, Math.max(16, input.width - 2)).slice(0, 2)
          : [];
        return (
          <React.Fragment key={suggestion.id}>
            <Text color={selected ? input.palette.text : input.palette.textMuted} bold={selected}>
              {truncateForDisplayWidth(
                `${selected ? ">" : "·"} ${ACTION_LABELS[suggestion.action]} · ${resolveSourceLabel(input.packet, suggestion)} · ${status}`,
                Math.max(16, input.width),
              )}
            </Text>
            {reasonLines.map((line, index) => (
              <Text key={`${suggestion.id}-reason-${index}`} color={input.palette.textMuted}>
                {`  ${line}`}
              </Text>
            ))}
            {selected && suggestion.status === "proposed" && input.actionsEnabled ? (
              <Text color={input.palette.user}>{"  [A] accept · [R] reject"}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
      {!input.dense && input.suggestions.length > visible.length ? (
        <Text color={input.palette.textMuted}>
          {`  … ${input.suggestions.length - visible.length} more suggestions`}
        </Text>
      ) : null}
    </Box>
  );
}
