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

const MAX_VISIBLE_SUGGESTIONS = 4;

const ACTION_LABELS: Readonly<Record<ContextPolicySuggestion["action"], string>> = {
  keep: "Keep",
  refresh: "Refresh",
  summarize: "Summarize",
  "hold-back": "Hold back",
};

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
}): React.ReactNode {
  if (input.suggestions.length === 0 && !input.unavailable) {
    return null;
  }

  const visible = input.suggestions.slice(0, MAX_VISIBLE_SUGGESTIONS);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={input.palette.assistant} bold>{"Context optimizer"}</Text>
        <Text color={input.palette.textMuted}>{" · receipt-scoped advice"}</Text>
      </Text>
      {input.unavailable ? (
        <Text color={input.palette.warning}>{`  ${input.unavailable}`}</Text>
      ) : null}
      {visible.map((suggestion) => {
        const selected = suggestion.sourceId === input.selectedSourceId;
        const savings = suggestion.estimatedTokenSaving === undefined
          ? "Savings unknown"
          : `Save ~${suggestion.estimatedTokenSaving}t`;
        const status = suggestion.status === "proposed"
          ? savings
          : suggestion.status;
        return (
          <React.Fragment key={suggestion.id}>
            <Text color={selected ? input.palette.text : input.palette.textMuted}>
              {`  ${selected ? ">" : "·"} ${ACTION_LABELS[suggestion.action]} · ${resolveSourceLabel(input.packet, suggestion.sourceId)} · ${status}`}
            </Text>
            <Text color={input.palette.textMuted}>{`    ${suggestion.reasonText}`}</Text>
            {selected && suggestion.status === "proposed" && input.actionsEnabled ? (
              <Text color={input.palette.user}>{"    [A] accept · [R] reject"}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
      {input.suggestions.length > visible.length ? (
        <Text color={input.palette.textMuted}>{`  … ${input.suggestions.length - visible.length} more suggestions`}</Text>
      ) : null}
    </Box>
  );
}
