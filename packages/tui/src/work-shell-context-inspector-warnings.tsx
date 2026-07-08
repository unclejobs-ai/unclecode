import type { ContextPacketView } from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import type { ContextInspectorPalette } from "./work-shell-context-inspector-model.js";

function renderContextInspectorWarning(input: {
  readonly warning: ContextPacketView["warnings"][number];
  readonly index: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const header = truncateForDisplayWidth(
    `${input.warning.severity} · ${input.warning.code}`,
    Math.max(20, input.width - 8),
  );
  const messageLines = wrapDisplayTextFast(input.warning.message, Math.max(24, input.width - 10));
  return (
    <Box key={`context-warning-${input.index}-${input.warning.code}`} flexDirection="column">
      <Text color={input.palette.warning}>{`  ${header}`}</Text>
      {messageLines.map((line, lineIndex) => (
        <Text key={`context-warning-${input.index}-${input.warning.code}-message-${lineIndex}`}>
          <Text color={input.palette.borderSoft}>{"    · "}</Text>
          <Text color={input.palette.textMuted}>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function renderContextInspectorWarnings(input: {
  readonly packet: ContextPacketView;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  if (input.packet.warnings.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={input.palette.success}>{"✓ "}</Text>
        <Text color={input.palette.textMuted}>{"Warnings · none"}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={input.palette.warning} bold>{`Warnings · ${input.packet.warnings.length}`}</Text>
      {input.packet.warnings.map((warning, index) => renderContextInspectorWarning({
        warning,
        index,
        width: input.width,
        palette: input.palette,
      }))}
    </Box>
  );
}
