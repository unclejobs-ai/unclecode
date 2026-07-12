import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth } from "./text-width.js";
import {
  resolveContextSourceMeta,
  sanitizeContextPreview,
  type ContextInspectorPalette,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";

export function renderContextInspectorFocus(input: {
  readonly row?: ContextInspectorSourceRow | undefined;
  readonly sectionLabel: string;
  readonly actionLabel: string;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  if (!input.row) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={input.palette.user} bold>{"Focus"}</Text>
          <Text color={input.palette.textMuted}>{" · No context sources are loaded yet."}</Text>
        </Text>
        <Text color={input.palette.textMuted}>{`  ${input.actionLabel}`}</Text>
      </Box>
    );
  }

  const meta = resolveContextSourceMeta(input.row.item.category, input.palette);
  const label = sanitizeContextPreview(input.row.item.label);

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={input.palette.user} bold>{"Focus"}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={meta.color} bold>{meta.label}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={input.palette.textMuted}>{input.sectionLabel}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={input.palette.text} bold>{truncateForDisplayWidth(label, Math.max(16, input.width - 44))}</Text>
      </Text>
      <Text>
        <Text color={input.palette.borderSoft}>{"  now · "}</Text>
        <Text color={input.palette.textMuted}>{input.actionLabel}</Text>
      </Text>
    </Box>
  );
}
