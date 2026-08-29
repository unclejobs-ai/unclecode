import type {
  AgentConsoleSnapshot,
  AgentRun,
  AgentRunUsage,
  AgentRunUsageRoute,
} from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import type { ContextInspectorPalette } from "./work-shell-context-inspector-model.js";
import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";

type TelemetryOverlayInput = {
  readonly snapshot: AgentConsoleSnapshot;
  readonly width: number;
  readonly borderColor: string;
  readonly palette: ContextInspectorPalette;
};

type UsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheSavingsUsd: number;
  /**
   * Set when a route reused cache but UncleCode has no price table for its
   * model, so the savings estimate is absent rather than zero. OMP fronts
   * arbitrary upstreams, so this is the normal case for a worker route.
   */
  readonly cacheSavingsUnknown: boolean;
  readonly costUsd: number;
  readonly eventCount: number;
};
type UsageLedgerRow = {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly usage: UsageTotals;
};


const EMPTY_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheSavingsUsd: 0,
  cacheSavingsUnknown: false,
  costUsd: 0,
  eventCount: 0,
};

export function renderCacheTelemetryOverlay(input: TelemetryOverlayInput): React.ReactNode {
  const totals = collectSnapshotUsage(input.snapshot);
  const totalInputTokens =
    totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const reuseRatio = totalInputTokens > 0 ? totals.cacheReadTokens / totalInputTokens : 0;
  const state = totals.eventCount === 0 ? "WAITING" : totals.cacheReadTokens > 0 ? "HIT" : "MISS";
  const stateColor = state === "HIT"
    ? input.palette.success
    : state === "MISS"
      ? input.palette.warning
      : input.palette.textMuted;
  const contentWidth = Math.max(28, input.width - 4);
  const compact = input.width < 88;
  const statCells = [
    { label: "CACHE STATE", value: state, color: stateColor },
    { label: "REUSE", value: formatPercent(reuseRatio), color: input.palette.assistant },
    {
      label: "SAVED · EST",
      value: formatSavings(totals),
      color: totals.cacheSavingsUnknown && totals.cacheSavingsUsd === 0
        ? input.palette.textMuted
        : input.palette.success,
    },
    { label: "COST · EST", value: formatUsd(totals.costUsd), color: input.palette.text },
  ];
  const ledgers = buildUsageLedgerRows(input.snapshot);

  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor={input.borderColor}
      paddingX={1}
      flexDirection="column"
      width={input.width}
    >
      {renderTelemetryHeader("Cache Telemetry", "Live provider evidence", input.palette, compact)}
      <Box marginTop={1} flexDirection={compact ? "column" : "row"} gap={compact ? 0 : 2}>
        {statCells.map((cell) => (
          <Box key={cell.label} flexDirection="column" minWidth={compact ? undefined : 15}>
            <Text color={input.palette.textDim}>{cell.label}</Text>
            <Text color={cell.color} bold>{cell.value}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={input.palette.textDim}>PROMPT INPUT</Text>
        <Text>
          <Text color={input.palette.assistant}>{renderUsageBar(reuseRatio, Math.min(32, Math.max(12, contentWidth - 28)))}</Text>
          <Text color={input.palette.textMuted}>{`  ${formatTokens(totals.cacheReadTokens)} reused`}</Text>
        </Text>
        <Text color={input.palette.textMuted}>
          {`${formatTokens(totalInputTokens)} total  ·  ${formatTokens(totals.cacheWriteTokens)} cache write  ·  ${formatTokens(totals.outputTokens)} output`}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={input.palette.textDim}>LEDGER · CURRENT SESSION</Text>
        {ledgers.length === 0 ? (
          <Text color={input.palette.textMuted}>No provider usage recorded yet. Send one model turn to populate this view.</Text>
        ) : ledgers.map((row) => renderUsageLedgerRow(
          row,
          compact,
          contentWidth,
          input.palette,
        ))}
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text color={input.palette.textMuted}>/cache cache  ·  /agents history</Text>
        <Text color={input.palette.textDim}>Esc close</Text>
      </Box>
    </Box>
  );
}

export function renderAgentHistoryOverlay(input: TelemetryOverlayInput): React.ReactNode {
  const agents = [...input.snapshot.agents].sort(compareAgents);
  const running = agents.filter((agent) => agent.status === "running" || agent.status === "waiting").length;
  const failed = agents.filter((agent) => agent.status === "failed" || agent.status === "interrupted").length;
  const compact = input.width < 88;
  const totalCost = collectSnapshotUsage(input.snapshot).costUsd;
  const contentWidth = Math.max(28, input.width - 4);

  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor={input.borderColor}
      paddingX={1}
      flexDirection="column"
      width={input.width}
    >
      {renderTelemetryHeader("Agent History", "Current-session runs", input.palette, compact)}
      <Box marginTop={1} gap={3}>
        <Text><Text color={input.palette.warning} bold>{running}</Text><Text color={input.palette.textMuted}> active</Text></Text>
        <Text><Text color={input.palette.text} bold>{agents.length}</Text><Text color={input.palette.textMuted}> total</Text></Text>
        <Text><Text color={failed > 0 ? input.palette.warning : input.palette.textMuted} bold>{failed}</Text><Text color={input.palette.textMuted}> failed</Text></Text>
        <Text><Text color={input.palette.success} bold>{formatUsd(totalCost)}</Text><Text color={input.palette.textMuted}> cost</Text></Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={input.palette.textDim}>RUNS · NEWEST FIRST</Text>
        {agents.length === 0 ? (
          <Box flexDirection="column">
            <Text color={input.palette.textMuted}>No delegated agent runs in this session.</Text>
            {input.snapshot.mainUsage ? renderMainRun(input.snapshot.mainUsage, input.palette) : null}
          </Box>
        ) : agents.map((agent) => renderAgentRow(agent, contentWidth, input.palette, compact))}
      </Box>

      {input.snapshot.jobs.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={input.palette.textDim}>RECENT JOBS</Text>
          {input.snapshot.jobs.slice(-4).reverse().map((job) => (
            <Text key={job.id}>
              <Text color={resolveStatusColor(job.status, input.palette)}>{statusGlyph(job.status)}</Text>
              <Text color={input.palette.text}>{` ${truncateForDisplayWidth(job.label, Math.max(12, contentWidth - 24))}`}</Text>
              <Text color={input.palette.textMuted}>{`  ${job.status}`}</Text>
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1} justifyContent="space-between">
        <Text color={input.palette.textMuted}>/agents history  ·  /cache cache</Text>
        <Text color={input.palette.textDim}>Esc close</Text>
      </Box>
    </Box>
  );
}

function renderTelemetryHeader(
  title: string,
  subtitle: string,
  palette: ContextInspectorPalette,
  compact: boolean,
): React.ReactNode {
  const titleText = (
    <Text><Text color={palette.assistant} bold>{`▤ ${title}`}</Text><Text color={palette.textMuted}>{`  ${subtitle}`}</Text></Text>
  );
  const controls = (
    <Text><Text color={palette.assistant} bold>[C]</Text><Text color={palette.textMuted}> Cache  </Text><Text color={palette.assistant} bold>[A]</Text><Text color={palette.textMuted}> Agents</Text></Text>
  );
  return compact
    ? <Box flexDirection="column">{titleText}{controls}</Box>
    : <Box justifyContent="space-between">{titleText}{controls}</Box>;
}

/**
 * A delegated run is only auditable if it names the route it spent on. An OMP
 * worker and a hosted turn look identical from tokens alone, so every route the
 * run touched is listed under it with the cache evidence that produced those
 * tokens. At narrow widths the route and its cache counters take separate lines
 * rather than truncating one of the two values away.
 */
function renderAgentRow(
  agent: AgentRun,
  width: number,
  palette: ContextInspectorPalette,
  compact: boolean,
): React.ReactNode {
  const usage = normalizeUsage(agent.usage);
  const detail = agent.currentActivity ?? agent.summary ?? agent.errorSummary;
  // The run line is fixed-width columns, so at a narrow terminal the budget has
  // to shrink or ink wraps the cost onto an orphan line that reads like another
  // run. Sizes below keep glyph + name + type + tokens + cost inside `width`.
  const labelWidth = compact
    ? Math.max(8, Math.min(28, width - 30))
    : Math.max(12, Math.min(28, width - 42));
  const typeWidth = compact ? 8 : 12;
  const tokenWidth = compact ? 6 : 8;
  const bound = Math.max(16, width - 4);
  return (
    <Box key={agent.id} flexDirection="column" marginBottom={detail ? 1 : 0}>
      <Text>
        <Text color={resolveStatusColor(agent.status, palette)}>{statusGlyph(agent.status)}</Text>
        <Text color={palette.text} bold>{` ${padDisplay(truncateForDisplayWidth(agent.displayName, labelWidth), labelWidth)} `}</Text>
        <Text color={palette.textMuted}>{`${padDisplay(agent.agentType, typeWidth)} `}</Text>
        <Text color={palette.assistant}>{`${padDisplay(formatTokens(usage.inputTokens), tokenWidth)} in `}</Text>
        <Text color={palette.success}>{formatUsd(usage.costUsd)}</Text>
      </Text>
      {(agent.usage?.routes ?? []).map((route, index) => compact
        ? (
          <Box key={`${agent.id}:route:${index}`} flexDirection="column">
            <Text color={palette.textMuted}>{`  ├ ${truncateForDisplayWidth(`${route.provider}/${route.model}`, bound)}`}</Text>
            <Text color={palette.assistant}>{`  │ ${truncateForDisplayWidth(formatRouteCache(route), bound)}`}</Text>
          </Box>
        )
        : (
          <Text key={`${agent.id}:route:${index}`} color={palette.textMuted}>
            {`  ├ ${truncateForDisplayWidth(`${route.provider}/${route.model}  ·  ${formatRouteCache(route)}`, bound)}`}
          </Text>
        ))}
      {detail ? <Text color={palette.textMuted}>{`  └ ${truncateForDisplayWidth(detail, bound)}`}</Text> : null}
    </Box>
  );
}

function renderMainRun(usage: AgentRunUsage, palette: ContextInspectorPalette): React.ReactNode {
  const totals = normalizeUsage(usage);
  return (
    <Text>
      <Text color={palette.success}>●</Text>
      <Text color={palette.text} bold>{" Main conversation  "}</Text>
      <Text color={palette.assistant}>{`${formatTokens(totals.inputTokens)} in  `}</Text>
      <Text color={palette.success}>{formatUsd(totals.costUsd)}</Text>
    </Text>
  );
}

/**
 * One route's evidence. Cache read and cache write are the pair that explains a
 * reuse ratio, so they share a line of their own instead of competing with the
 * provider/model column for a single row's width budget — truncating the route
 * would erase the only thing that tells an OMP worker turn apart from a hosted
 * one, and dropping the write counter would hide what the reuse cost to build.
 */
function renderUsageLedgerRow(
  row: UsageLedgerRow,
  compact: boolean,
  contentWidth: number,
  palette: ContextInspectorPalette,
): React.ReactNode {
  const route = row.provider && row.model ? `${row.provider}/${row.model}` : "provider/model unavailable";
  const glyph = row.active ? "◐" : "●";
  const glyphColor = row.active ? palette.warning : palette.textMuted;
  const cacheEvidence = formatRouteCache(row.usage);
  const savings = `${formatSavings(row.usage)} saved`;
  const savingsColor = row.usage.cacheSavingsUnknown && row.usage.cacheSavingsUsd === 0
    ? palette.textMuted
    : palette.success;
  if (compact) {
    return (
      <Box key={row.id} flexDirection="column" marginBottom={1}>
        <Text><Text color={glyphColor}>{glyph}</Text><Text color={palette.text} bold>{` ${row.label}`}</Text></Text>
        <Text color={palette.textMuted}>{`  ${truncateForDisplayWidth(route, Math.max(12, contentWidth - 2))}`}</Text>
        <Text color={palette.assistant}>{`  ${truncateForDisplayWidth(cacheEvidence, Math.max(12, contentWidth - 2))}`}</Text>
        <Text>
          <Text color={palette.textMuted}>{`  ${formatTokens(row.usage.inputTokens)} input  ·  `}</Text>
          <Text color={savingsColor}>{savings}</Text>
        </Text>
      </Box>
    );
  }
  const routeWidth = Math.max(14, Math.min(34, contentWidth - 51));
  return (
    <Box key={row.id} flexDirection="column">
      <Text>
        <Text color={glyphColor}>{glyph}</Text>
        <Text color={palette.text} bold>{` ${padDisplay(row.label, 18)} `}</Text>
        <Text color={palette.textMuted}>{`${padDisplay(route, routeWidth)}  `}</Text>
        <Text color={palette.textMuted}>{`${padDisplay(formatTokens(row.usage.inputTokens), 8)} input `}</Text>
        <Text color={savingsColor}>{savings}</Text>
      </Text>
      <Text color={palette.assistant}>
        {`  ${truncateForDisplayWidth(cacheEvidence, Math.max(12, contentWidth - 2))}`}
      </Text>
    </Box>
  );
}

function buildUsageLedgerRows(snapshot: AgentConsoleSnapshot): readonly UsageLedgerRow[] {
  const rows: UsageLedgerRow[] = [];
  if (snapshot.mainUsage) {
    appendUsageLedgerRows(rows, "main", "Main conversation", false, snapshot.mainUsage);
  }
  for (const agent of snapshot.agents) {
    if (!agent.usage) continue;
    appendUsageLedgerRows(
      rows,
      agent.id,
      agent.displayName,
      agent.status === "running" || agent.status === "waiting",
      agent.usage,
    );
  }
  return rows;
}

function appendUsageLedgerRows(
  rows: UsageLedgerRow[],
  ownerId: string,
  ownerLabel: string,
  active: boolean,
  usage: AgentRunUsage,
): void {
  if (usage.routes && usage.routes.length > 0) {
    usage.routes.forEach((route, routeIndex) => {
      rows.push({
        id: `${ownerId}:route:${routeIndex}`,
        label: ownerLabel,
        active,
        provider: route.provider,
        model: route.model,
        usage: normalizeUsage(route),
      });
    });
    return;
  }
  rows.push({
    id: ownerId,
    label: ownerLabel,
    active,
    usage: normalizeUsage(usage),
  });
}

function collectSnapshotUsage(snapshot: AgentConsoleSnapshot): UsageTotals {
  let totals = snapshot.mainUsage ? normalizeUsage(snapshot.mainUsage) : EMPTY_TOTALS;
  for (const agent of snapshot.agents) {
    if (agent.usage) totals = addUsage(totals, normalizeUsage(agent.usage));
  }
  return totals;
}

function normalizeUsage(usage: AgentRunUsage | AgentRunUsageRoute | undefined): UsageTotals {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    cacheSavingsUsd: usage?.cacheSavingsUsd ?? 0,
    cacheSavingsUnknown: hasUnpricedCacheReads(usage),
    costUsd: usage?.costUsd ?? 0,
    eventCount: usage?.eventIds?.length ?? 0,
  };
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheSavingsUsd: left.cacheSavingsUsd + right.cacheSavingsUsd,
    cacheSavingsUnknown: left.cacheSavingsUnknown || right.cacheSavingsUnknown,
    costUsd: left.costUsd + right.costUsd,
    eventCount: left.eventCount + right.eventCount,
  };
}

function formatRouteCache(
  usage: { readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number },
): string {
  return `${formatTokens(usage.cacheReadTokens ?? 0)} cache read  ·  ${formatTokens(usage.cacheWriteTokens ?? 0)} cache write`;
}

/**
 * Reuse that no price table can value. A producer omits `cacheSavingsUsd`
 * entirely when it cannot estimate one, so absence next to a non-zero cache read
 * is the signal — and a parent ledger is only as priced as its routes, since one
 * priced route would otherwise mask an unpriced sibling behind a defined sum.
 */
function hasUnpricedCacheReads(usage: AgentRunUsage | AgentRunUsageRoute | undefined): boolean {
  if (!usage) {
    return false;
  }
  const routes = "routes" in usage ? usage.routes : undefined;
  if (routes && routes.length > 0) {
    return routes.some(hasUnpricedCacheReads);
  }
  return (usage.cacheReadTokens ?? 0) > 0 && usage.cacheSavingsUsd === undefined;
}

/**
 * `$0.00` claims the reuse saved nothing; `n/a` admits the estimate is missing.
 * A partial total is reported as a floor rather than an exact figure.
 */
function formatSavings(totals: UsageTotals): string {
  if (!totals.cacheSavingsUnknown) {
    return formatUsd(totals.cacheSavingsUsd);
  }
  return totals.cacheSavingsUsd > 0 ? `${formatUsd(totals.cacheSavingsUsd)}+` : "n/a";
}

function compareAgents(left: AgentRun, right: AgentRun): number {
  const leftActive = left.status === "running" || left.status === "waiting";
  const rightActive = right.status === "running" || right.status === "waiting";
  return leftActive === rightActive ? right.startedAt - left.startedAt : leftActive ? -1 : 1;
}

function renderUsageBar(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(width * ratio)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function formatUsd(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function padDisplay(value: string, width: number): string {
  const clipped = truncateForDisplayWidth(value, width);
  return clipped + " ".repeat(Math.max(0, width - getDisplayWidth(clipped)));
}

function statusGlyph(status: string): string {
  if (status === "running") return "◐";
  if (status === "waiting" || status === "queued") return "○";
  if (status === "completed") return "●";
  if (status === "failed" || status === "interrupted") return "✕";
  if (status === "blocked") return "▲";
  return "·";
}

function resolveStatusColor(status: string, palette: ContextInspectorPalette): string {
  if (status === "running") return palette.warning;
  if (status === "completed") return palette.success;
  if (status === "failed" || status === "interrupted") return palette.warning;
  if (status === "blocked") return palette.warning;
  return palette.textMuted;
}
