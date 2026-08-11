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
import { wrapDisplayTextFast } from "./text-width.js";

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

export function formatWorkShellContextAdviceLines(input: {
  readonly packet: ContextPacketView;
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly unavailable?: string | undefined;
  readonly selectedSourceId?: string | undefined;
  readonly actionsEnabled: boolean;
  readonly width: number;
}): readonly string[] {
  if (input.suggestions.length === 0 && !input.unavailable) {
    return [];
  }
  const selectedSuggestion = input.actionsEnabled
    ? getSelectedVisibleContextPolicySuggestion(input)
    : undefined;
  const visible = getVisibleContextPolicySuggestions(input.suggestions);
  const width = Math.max(1, input.width);
  return [
    ...wrapDisplayTextFast("Context optimizer · receipt-scoped advice", width),
    ...(input.unavailable
      ? wrapDisplayTextFast(input.unavailable, width)
      : []),
    ...visible.flatMap((suggestion) => {
      const selected = suggestion.id === selectedSuggestion?.id;
      const savings = suggestion.estimatedTokenSaving === undefined
        ? "Savings unknown"
        : `Save ${formatContextReceiptTokenEstimate({
            tokenEstimate: suggestion.estimatedTokenSaving,
            tokenEstimateState: "estimated",
          })}`;
      const status = suggestion.status === "proposed" ? savings : suggestion.status;
      return [
        ...wrapDisplayTextFast(
          `${selected ? ">" : "·"} ${ACTION_LABELS[suggestion.action]} · ${resolveSourceLabel(input.packet, suggestion.sourceId)} · ${status}`,
          width,
        ),
        ...wrapDisplayTextFast(suggestion.reasonText, width),
        ...(selected && suggestion.status === "proposed" && input.actionsEnabled
          ? wrapDisplayTextFast("[A] accept · [R] reject", width)
          : []),
      ];
    }),
    ...(input.suggestions.length > visible.length
      ? wrapDisplayTextFast(
          `… ${input.suggestions.length - visible.length} more suggestions`,
          width,
        )
      : []),
  ];
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
  const lines = formatWorkShellContextAdviceLines(input);
  return lines.length > 0 ? (
    <Box marginTop={1} flexDirection="column">
      {lines.map((line, index) => (
        <Text
          key={`${index}:${line}`}
          color={index === 0 ? input.palette.assistant : input.palette.textMuted}
          bold={index === 0}
        >
          {line}
        </Text>
      ))}
    </Box>
  ) : null;
}
