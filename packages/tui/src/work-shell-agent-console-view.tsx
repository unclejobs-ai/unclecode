import type { AgentConsoleSnapshot } from "@unclecode/contracts";
import {
  resolveAgentConsoleSelection,
  type AgentConsoleViewState,
} from "@unclecode/orchestrator";
import { Box, Text } from "ink";
import React from "react";

import type { ContextInspectorPalette } from "./work-shell-context-inspector-model.js";
import { selectRecordedEvolutionProposalLines } from "./evolution-proposal-lines.js";
import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";
import {
  agentConsoleStatusGlyph,
  formatCount,
  type AgentConsoleRowTone,
} from "./work-shell-agent-console-format.js";
import {
  formatAgentConsoleTotalCost,
  selectActiveAgentHudRows,
  selectAgentConsoleInspector,
  selectAgentConsoleRows,
  selectWorkGraphHudRows,
  type AgentConsoleInspector,
  type AgentConsoleRow,
} from "./work-shell-agent-console-model.js";

/**
 * Two surfaces over one snapshot: the quiet default HUD that lives above the
 * conversation, and the Agent Console overlay the operator opens to inspect a
 * run. Both read the same bounded projections, so nothing the console shows
 * can exceed what the snapshot already persisted.
 */

/** Two panes need this much room before the roster stops being a column. */
const CONSOLE_TWO_PANE_MIN_WIDTH = 84;
/** Fraction of the console body the roster takes when both panes fit. */
const CONSOLE_ROSTER_FRACTION = 0.38;
/** Visible roster window; a long session scrolls rather than growing the frame. */
const CONSOLE_ROSTER_WINDOW = 10;

const CONSOLE_KEY_HINTS = "j/k move · Tab pane · s steer · x cancel · r continue · Esc close";

/** `  ◐ body` — the leading glyph is the only part that carries colour. */
const HUD_ROW_RE = /^ {2}([◐○●▲✕⊘]) (.*)$/;

export function WorkShellAgentConsoleHud(props: {
  readonly snapshot: AgentConsoleSnapshot;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
  readonly now?: number;
}): React.ReactNode {
  const now = props.now ?? Date.now();
  const rows = [
    ...selectWorkGraphHudRows(props.snapshot, props.width),
    ...selectActiveAgentHudRows(props.snapshot, now, props.width),
  ];
  if (rows.length === 0) {
    return null;
  }
  return (
    <Box marginTop={1} flexDirection="column">
      {rows.map((row, index) => (
        <AgentConsoleHudLine key={`${index}:${row}`} line={row} palette={props.palette} />
      ))}
    </Box>
  );
}

export function WorkShellAgentConsoleOverlay(props: {
  readonly snapshot: AgentConsoleSnapshot;
  readonly view: AgentConsoleViewState;
  /** Physical terminal columns. Owns the two-pane breakpoint. */
  readonly terminalColumns: number;
  /** Width of the console frame itself, already net of the shell's chrome. */
  readonly width: number;
  readonly borderColor: string;
  readonly palette: ContextInspectorPalette;
  readonly now?: number;
}): React.ReactNode {
  const now = props.now ?? Date.now();
  const body = Math.max(24, props.width - 4);
  const rows = selectAgentConsoleRows(props.snapshot, props.view.tab);
  // The breakpoint is a promise about the operator's terminal. Measuring the
  // console's own inner width instead silently moved it four columns out.
  const twoPane = props.terminalColumns >= CONSOLE_TWO_PANE_MIN_WIDTH;
  const rosterWidth = twoPane ? Math.max(18, Math.trunc(body * CONSOLE_ROSTER_FRACTION)) : body;
  // The inspector column owns the divider as a left rule plus one column of
  // padding, so the panes are separated by exactly one line of chrome.
  const inspectorWidth = body - rosterWidth;
  const inspector = selectAgentConsoleInspector(
    props.snapshot,
    resolveAgentConsoleSelection(props.view, props.snapshot),
    now,
    twoPane ? Math.max(16, inspectorWidth - 2) : body,
  );

  const roster = (
    <Box width={twoPane ? rosterWidth : body} flexDirection="column">
      {rows.length === 0
        ? <Text color={props.palette.textMuted}>{emptyRosterLabel(props.view.tab)}</Text>
        : rosterWindow(rows, props.view.cursor).map(({ row, index }) => (
          <AgentConsoleRosterLine
            key={row.id}
            row={row}
            selected={index === props.view.cursor}
            width={(twoPane ? rosterWidth : body) - 1}
            palette={props.palette}
          />
        ))}
      {rows.length > CONSOLE_ROSTER_WINDOW ? (
        <Text color={props.palette.textDim}>
          {`  … ${rows.length - CONSOLE_ROSTER_WINDOW} more off screen`}
        </Text>
      ) : null}
    </Box>
  );

  const inspectorPane = (
    <Box
      width={twoPane ? inspectorWidth : body}
      flexDirection="column"
      {...(twoPane
        ? {
          borderStyle: "single" as const,
          borderColor: props.palette.borderSoft,
          borderTop: false,
          borderRight: false,
          borderBottom: false,
          paddingLeft: 1,
        }
        : {})}
    >
      {inspector === undefined
        ? <Text color={props.palette.textMuted}>Select a row to inspect.</Text>
        : renderInspector(inspector, props.palette)}
    </Box>
  );

  const totalCost = formatAgentConsoleTotalCost(props.snapshot);
  const recordedEvolution = selectRecordedEvolutionProposalLines(
    props.snapshot.evolutionProposals?.at(-1),
    body,
  );

  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor={props.borderColor}
      paddingX={1}
      flexDirection="column"
      width={props.width}
    >
      <Text>
        <Text color={props.palette.assistant} bold>▤ Agent Console</Text>
        <Text color={props.palette.textMuted}>
          {totalCost === undefined ? "  session runs" : `  session runs · ${totalCost} spent`}
        </Text>
      </Text>
      <Text>
        {(["agents", "jobs", "plan"] as const).map((tab, index) => (
          <Text key={tab}>
            {index === 0 ? "" : "  "}
            <Text
              color={tab === props.view.tab ? props.palette.assistant : props.palette.textMuted}
              bold={tab === props.view.tab}
            >
              {tab === props.view.tab ? `[${TAB_LABELS[tab]}]` : TAB_LABELS[tab]}
            </Text>
          </Text>
        ))}
        <Text color={props.palette.textDim}>
          {truncateForDisplayWidth(
            `  · ${formatCount(props.snapshot.agents.length, "agent", "agents")}`
            + ` · ${formatCount(props.snapshot.jobs.length, "job", "jobs")}`
            + ` · ${formatCount(props.snapshot.workGraph?.nodes.length ?? 0, "task", "tasks")}`,
            Math.max(0, body - 26),
          )}
        </Text>
      </Text>

      {recordedEvolution.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {recordedEvolution.map((line) => (
            <Text key={line} color={props.palette.textMuted}>{line}</Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="row">
        {twoPane ? roster : props.view.inspectorVisible ? inspectorPane : roster}
        {twoPane ? inspectorPane : null}
      </Box>

      <Box marginTop={1}>
        <Text color={props.palette.textDim}>{truncateForDisplayWidth(CONSOLE_KEY_HINTS, body)}</Text>
      </Box>
    </Box>
  );
}

const TAB_LABELS = { agents: "Agents", jobs: "Jobs", plan: "Plan" } as const;

function renderInspector(
  inspector: AgentConsoleInspector,
  palette: ContextInspectorPalette,
): React.ReactNode {
  return (
    <>
      <Text>
        <Text color={toneColor(inspector.tone, palette)}>
          {`${agentConsoleStatusGlyph(inspector.tone)} `}
        </Text>
        <Text color={palette.text} bold>{inspector.title}</Text>
      </Text>
      <Text color={palette.textMuted}>{inspector.subtitle}</Text>
      {inspector.facts.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {inspector.facts.map((fact) => (
            <Text key={fact.label}>
              <Text color={palette.textDim}>
                {`${fact.label}${" ".repeat(Math.max(1, inspector.factLabelWidth - getDisplayWidth(fact.label)))}`}
              </Text>
              <Text color={palette.text}>{fact.value}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {inspector.timeline.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.textDim}>Activity</Text>
          {inspector.timeline.map((line, index) => (
            <AgentConsoleHudLine key={`${index}:${line}`} line={line} palette={palette} />
          ))}
          {inspector.hiddenTimelineCount > 0 ? (
            <Text color={palette.textDim}>{`  … +${inspector.hiddenTimelineCount} earlier`}</Text>
          ) : null}
        </Box>
      ) : null}
      {inspector.outcome.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {inspector.outcome.map((line, index) => (
            <Text key={`${index}:${line}`} color={palette.textMuted}>{line}</Text>
          ))}
        </Box>
      ) : null}
    </>
  );
}

const AgentConsoleRosterLine = React.memo(function AgentConsoleRosterLine(props: {
  readonly row: AgentConsoleRow;
  readonly selected: boolean;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  // The cursor is a glyph and bold weight, never colour alone, so the selected
  // row still reads on a monochrome terminal.
  const marker = props.selected ? "› " : "  ";
  const body = truncateForDisplayWidth(
    `${props.row.label} · ${props.row.statusLabel}`,
    Math.max(8, props.width - 4),
  );
  return (
    <Text>
      <Text color={props.selected ? props.palette.user : props.palette.textDim}>{marker}</Text>
      <Text color={toneColor(props.row.tone, props.palette)}>{props.row.glyph}</Text>
      <Text color={props.selected ? props.palette.text : props.palette.textMuted} bold={props.selected}>
        {` ${body}`}
      </Text>
    </Text>
  );
});

const AgentConsoleHudLine = React.memo(function AgentConsoleHudLine(props: {
  readonly line: string;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const row = HUD_ROW_RE.exec(props.line);
  if (!row) {
    // Section headings (`Ship auth · 1/6`), overflow counts, and diff preview
    // rows all read as chrome rather than status.
    return <Text color={props.palette.textMuted}>{props.line}</Text>;
  }
  return (
    <Text>
      <Text>{"  "}</Text>
      <Text color={toneColor(HUD_GLYPH_TONES[row[1] ?? ""] ?? "pending", props.palette)} bold>
        {row[1] ?? ""}
      </Text>
      <Text color={props.palette.text}>{` ${row[2] ?? ""}`}</Text>
    </Text>
  );
});

const HUD_GLYPH_TONES: Readonly<Record<string, AgentConsoleRowTone>> = {
  "◐": "active",
  "●": "success",
  "▲": "warning",
  "✕": "danger",
  "○": "pending",
  "⊘": "pending",
};

function toneColor(
  tone: AgentConsoleRowTone,
  palette: ContextInspectorPalette,
): string {
  switch (tone) {
    case "active":
      return palette.assistant;
    case "success":
      return palette.success;
    case "warning":
    case "danger":
      return palette.warning;
    case "pending":
      return palette.textDim;
  }
}

function emptyRosterLabel(tab: AgentConsoleViewState["tab"]): string {
  switch (tab) {
    case "agents":
      return "No delegated agent runs in this session.";
    case "jobs":
      return "No background jobs in this session.";
    case "plan":
      return "No approved work graph yet.";
  }
}

/** Keep the cursor inside the visible window without growing the frame. */
function rosterWindow(
  rows: readonly AgentConsoleRow[],
  cursor: number,
): readonly { readonly row: AgentConsoleRow; readonly index: number }[] {
  const start = Math.max(0, Math.min(rows.length - CONSOLE_ROSTER_WINDOW, cursor - CONSOLE_ROSTER_WINDOW + 1));
  return rows
    .slice(Math.max(0, start), Math.max(0, start) + CONSOLE_ROSTER_WINDOW)
    .map((row, offset) => ({ row, index: Math.max(0, start) + offset }));
}
