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
  readonly width: number;
  readonly palette: ContextInspectorPalette;
  readonly ordinal?: number;
  readonly total?: number;
}): React.ReactNode {
  if (!input.row) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={input.palette.user} bold>{"Focus"}</Text>
          <Text color={input.palette.textMuted}>{" · No context sources are loaded yet."}</Text>
        </Text>
      </Box>
    );
  }

  const meta = resolveContextSourceMeta(input.row.item.category, input.palette);
  const label = sanitizeContextPreview(input.row.item.label);
  const ordinal = input.ordinal ?? (input.row.sourceIndex + 1);
  const total = input.total ?? ordinal;
  const ordinalLabel = `#${ordinal}/${total}`;

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={input.palette.user} bold>{"Focus"}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={input.palette.text} bold>{ordinalLabel}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={meta.color} bold>{meta.label}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={input.palette.textMuted}>{input.sectionLabel}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={input.palette.text} bold>
          {truncateForDisplayWidth(label, Math.max(12, input.width - 52))}
        </Text>
      </Text>
    </Box>
  );
}
