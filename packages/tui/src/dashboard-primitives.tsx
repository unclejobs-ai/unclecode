import { Box, Text } from "ink";
import React from "react";

import { getDisplayWidth } from "./text-width.js";

export const C = {
  bg: "#ffffff",
  surface: "#f8fafc",
  border: "#334155",
  borderActive: "#075985",
  borderSubtle: "#475569",
  text: "#0f172a",
  textSecondary: "#1e293b",
  textMuted: "#334155",
  textFaint: "#475569",
  accent: "#115e59",
  accentBright: "#075985",
  accentDim: "#115e59",
  warning: "#713f12",
  error: "#991b1b",
  info: "#075985",
  success: "#166534",
  statusBg: "#dcfce7",
  statusBgWarning: "#fef3c7",
  statusBgError: "#fee2e2",
  tagBg: "#e2e8f0",
  pillBg: "#dbeafe",
  pillFg: "#082f49",
  headerBg: "#bae6fd",
  headerFg: "#082f49",
} as const;

export const B = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  hDash: "╌",
  tDown: "┬", tUp: "┴", tRight: "├", tLeft: "┤",
} as const;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export const STATUS_DOT: Record<string, { char: string; color: string }> = {
  running: { char: "●", color: C.success },
  completed: { char: "●", color: C.info },
  requires_action: { char: "●", color: C.warning },
  idle: { char: "○", color: C.textMuted },
  queued: { char: "◔", color: C.textMuted },
} as const;

export function RoundedPanel(props: {
  readonly title?: string;
  readonly children: React.ReactNode;
  readonly width?: number;
  readonly accent?: boolean;
}) {
  const borderColor = props.accent ? C.accent : C.borderSubtle;
  const w = props.width ?? 40;
  const innerW = w - 2;
  const titleStr = props.title ?? "";
  const titleContent = titleStr.length > 0 ? ` ${titleStr} ` : "";
  const titleWidth = getDisplayWidth(titleContent);
  const rightPad = titleStr.length > 0
    ? Math.max(0, innerW - 1 - titleWidth)
    : innerW;

  return (
    <Box flexDirection="column">
      <Text color={borderColor}>
        {B.tl}{titleStr.length > 0 ? B.h : ""}{titleContent}{B.h.repeat(rightPad)}{B.tr}
      </Text>
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {props.children}
      </Box>
      <Text color={borderColor}>{B.bl}{B.h.repeat(innerW)}{B.br}</Text>
    </Box>
  );
}

export function ThinDivider(props: { readonly width?: number; readonly dashed?: boolean }) {
  const char = props.dashed ? B.hDash : B.h;
  return <Text color={C.borderSubtle}>{char.repeat(props.width ?? 72)}</Text>;
}

export function SectionDivider(props: { readonly label?: string; readonly width?: number }) {
  const w = props.width ?? 72;
  const labelStr = props.label ?? "";
  const labelContent = labelStr.length > 0 ? ` ${labelStr} ` : "";
  const leftLen = Math.floor((w - getDisplayWidth(labelContent)) / 2);
  const rightLen = Math.max(0, w - getDisplayWidth(labelContent) - leftLen);
  return (
    <Text color={C.borderSubtle}>
      {B.h.repeat(leftLen)}{labelContent}{B.h.repeat(rightLen)}
    </Text>
  );
}

export function StatusDot(props: { readonly status: string }) {
  const dot = STATUS_DOT[props.status] ?? { char: "○", color: C.textMuted };
  return <Text color={dot.color}>{dot.char}</Text>;
}

export function StatusBadge(props: {
  readonly label: string;
  readonly status: "running" | "queued" | "completed" | "idle";
}) {
  const colorMap = {
    running: { fg: C.success, bg: C.statusBg },
    queued: { fg: C.textMuted, bg: C.tagBg },
    completed: { fg: C.accent, bg: C.statusBg },
    idle: { fg: C.textMuted, bg: C.tagBg },
  } as const;
  const c = colorMap[props.status];
  return (
    <Text backgroundColor={c.bg} color={c.fg}>
      {" "}{props.status}{" "}
    </Text>
  );
}

export function KeyValue(props: {
  readonly label: string;
  readonly value: string;
  readonly valueColor?: string;
}) {
  return (
    <Box>
      <Text color={C.textMuted}>{props.label} </Text>
      <Text color={props.valueColor ?? C.text}>{props.value}</Text>
    </Box>
  );
}

export function LogLine(props: {
  readonly time: string;
  readonly level: "INF" | "WRN" | "ERR";
  readonly message: string;
}) {
  const levelColor = props.level === "INF" ? C.info : props.level === "WRN" ? C.warning : C.error;
  return (
    <Box>
      <Text color={C.textMuted}>{props.time}  </Text>
      <Text color={levelColor} bold>{props.level} </Text>
      <Text color={C.text}>{props.message}</Text>
    </Box>
  );
}

export function KeyHint(props: { readonly keys: string; readonly label: string }) {
  return (
    <Box gap={1}>
      <Text backgroundColor={C.pillBg} color={C.pillFg} bold>{" "}{props.keys}{" "}</Text>
      <Text color={C.textSecondary}>{props.label}</Text>
    </Box>
  );
}

export function KeyPill(props: { readonly char: string }) {
  return <Text backgroundColor={C.pillBg} color={C.pillFg} bold>{" "}{props.char}{" "}</Text>;
}
