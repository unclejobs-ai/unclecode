import type { ContextPacketView } from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import {
  formatContextTokenEstimate,
  resolveContextSourceMeta,
  sanitizeContextPreview,
  type ContextInspectorPalette,
  type ContextInspectorSuggestion,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";

function formatShortSourceLabel(
  row: ContextInspectorSourceRow,
  palette: ContextInspectorPalette,
  width: number,
): string {
  const meta = resolveContextSourceMeta(row.item.category, palette);
  return truncateForDisplayWidth(`${meta.label} · ${sanitizeContextPreview(row.item.label)}`, width);
}

function renderContextWorkbenchLaneTabs(input: {
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  return (
    <Text>
      <Text color={input.palette.borderSoft}>{"Workbench · "}</Text>
      <Text color={input.palette.user} bold>{"overview"}</Text>
      <Text color={input.palette.textMuted}>{" / budget"}</Text>
    </Text>
  );
}

function renderPreflightSummary(input: {
  readonly suggestion: ContextInspectorSuggestion;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const messageLines = wrapDisplayTextFast(input.suggestion.message, Math.max(24, input.width - 20));
  const suggestionColor = input.suggestion.tone === "success"
    ? input.palette.success
    : input.suggestion.tone === "warning"
      ? input.palette.warning
      : input.palette.user;
  const recommendation = input.suggestion.tone === "success"
    ? "keep current packet; review included rows before sending"
    : "summarize or hold back the flagged source before sending";
  return (
    <>
      <Text>
        <Text color={suggestionColor} bold>{"  Preflight · "}</Text>
        <Text color={input.palette.text}>{messageLines[0] ?? ""}</Text>
      </Text>
      {messageLines.slice(1).map((line, index) => (
        <Text key={`context-preflight-continuation-${index}`}>
          <Text color={input.palette.borderSoft}>{"    · "}</Text>
          <Text color={input.palette.text}>{line}</Text>
        </Text>
      ))}
      <Text color={input.palette.textMuted}>{`  Recommendation · ${recommendation}`}</Text>
    </>
  );
}

function renderBudgetLane(input: {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const topRows = input.rows
    .filter((row) => !row.heldBack && row.item.includedInModel !== false)
    .sort((left, right) => (right.item.tokenEstimate ?? 0) - (left.item.tokenEstimate ?? 0))
    .slice(0, 3);
  const unknownCount = input.rows.filter((row) => row.item.tokenEstimate === undefined).length
    + (input.packet.tokenEstimateState === "unknown" ? 1 : 0);
  const staleCount = input.rows.filter((row) => row.item.freshness?.state === "stale").length;
  const expiredCount = input.rows.filter((row) => row.item.freshness?.state === "expired").length;
  const riskSuffix = [
    unknownCount > 0 ? `${unknownCount} unknown estimates` : "",
    staleCount > 0 ? `${staleCount} stale` : "",
    expiredCount > 0 ? `${expiredCount} expired` : "",
  ].filter(Boolean).join(" · ");

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={input.palette.user} bold>{"Budget lane"}</Text>
        <Text color={input.palette.textMuted}>{" · top token consumers and freshness risk"}</Text>
      </Text>
      {topRows.length === 0 ? (
        <Text color={input.palette.textMuted}>{"  No included sources to trim yet."}</Text>
      ) : topRows.map((row, index) => (
        <Text key={`budget-lane-${row.item.id}`} color={index === 0 ? input.palette.text : input.palette.textMuted}>
          {`  ${index + 1}. ${formatShortSourceLabel(row, input.palette, Math.max(24, input.width - 30))} · ${formatContextTokenEstimate(row.item.tokenEstimate)}`}
        </Text>
      ))}
      {riskSuffix.length > 0 ? (
        <Text color={input.palette.warning}>{`  Risk · ${riskSuffix}`}</Text>
      ) : (
        <Text color={input.palette.success}>{"  Risk · estimates and freshness look usable"}</Text>
      )}
    </Box>
  );
}

export function renderContextInspectorWorkbench(input: {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly suggestion: ContextInspectorSuggestion;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  return (
    <Box marginTop={1} flexDirection="column">
      {renderContextWorkbenchLaneTabs({ palette: input.palette })}
      {renderPreflightSummary({
        suggestion: input.suggestion,
        width: input.width,
        palette: input.palette,
      })}
      {renderBudgetLane({
        packet: input.packet,
        rows: input.rows,
        width: input.width,
        palette: input.palette,
      })}
    </Box>
  );
}
