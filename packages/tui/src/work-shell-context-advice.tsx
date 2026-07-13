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
import { truncateForDisplayWidth } from "./text-width.js";

export const MAX_VISIBLE_CONTEXT_SUGGESTIONS = 4;

const ACTION_LABELS: Readonly<Record<ContextPolicySuggestion["action"], string>> = {
  keep: "Keep",
  refresh: "Refresh",
  summarize: "Summarize",
  "hold-back": "Hold back",
};

export function getVisibleContextPolicySuggestions(
  suggestions: readonly ContextPolicySuggestion[],
): readonly ContextPolicySuggestion[] {
  return suggestions.slice(0, MAX_VISIBLE_CONTEXT_SUGGESTIONS);
}

export function getSelectedVisibleContextPolicySuggestion(input: {
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly selectedSourceId?: string | undefined;
}): ContextPolicySuggestion | undefined {
  return getVisibleContextPolicySuggestions(input.suggestions).find(
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
}): number {
  if (input.suggestions.length === 0 && !input.unavailable) {
    return 0;
  }
  const visible = getVisibleContextPolicySuggestions(input.suggestions);
  const selectedSuggestion = input.actionsEnabled
    ? getSelectedVisibleContextPolicySuggestion(input)
    : undefined;
  const selectedActionRows = selectedSuggestion === undefined ? 0 : 1;
  return 2
    + (input.unavailable ? 1 : 0)
    + (visible.length * 2)
    + selectedActionRows
    + (input.suggestions.length > visible.length ? 1 : 0);
}

function resolveSourceLabel(
  packet: ContextPacketView,
  sourceId: string,
): string {
  const source = [...packet.included, ...packet.excluded].find(
    (item) => item.id === sourceId,
  );
  return sanitizeContextPreview(source?.label ?? sourceId);
}

export function renderWorkShellContextAdvice(input: {
  readonly packet: ContextPacketView;
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly unavailable?: string | undefined;
  readonly selectedSourceId?: string | undefined;
  readonly actionsEnabled: boolean;
  readonly palette: ContextInspectorPalette;
  readonly width: number;
}): React.ReactNode {
  if (input.suggestions.length === 0 && !input.unavailable) {
    return null;
  }

  const selectedSuggestion = input.actionsEnabled
    ? getSelectedVisibleContextPolicySuggestion(input)
    : undefined;
  const selectedSuggestionId = selectedSuggestion?.id;
  const visible = getVisibleContextPolicySuggestions(input.suggestions);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={input.palette.assistant} bold>{"Context optimizer"}</Text>
        <Text color={input.palette.textMuted}>{" · receipt-scoped advice"}</Text>
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
        return (
          <React.Fragment key={suggestion.id}>
            <Text color={selected ? input.palette.text : input.palette.textMuted}>
              {truncateForDisplayWidth(
                `  ${selected ? ">" : "·"} ${ACTION_LABELS[suggestion.action]} · ${resolveSourceLabel(input.packet, suggestion.sourceId)} · ${status}`,
                Math.max(16, input.width - 4),
              )}
            </Text>
            <Text color={input.palette.textMuted}>
              {truncateForDisplayWidth(
                `    ${suggestion.reasonText}`,
                Math.max(16, input.width - 4),
              )}
            </Text>
            {selected && suggestion.status === "proposed" && input.actionsEnabled ? (
              <Text color={input.palette.user}>{"    [A] accept · [R] reject"}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
      {input.suggestions.length > visible.length ? (
        <Text color={input.palette.textMuted}>
          {`  … ${input.suggestions.length - visible.length} more suggestions`}
        </Text>
      ) : null}
    </Box>
  );
}
