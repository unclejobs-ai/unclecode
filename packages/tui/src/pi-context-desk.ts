/**
 * The Context Desk (`/context`) for the pi shell: what reaches the next answer,
 * by group, with the selected source's preview. The engine owns the desk state
 * (pane, collection, cursor, expansion) and every mutation; this module lays
 * it out as text and maps keys through the same resolver the Ink desk uses.
 */
import {
  CONTEXT_DESK_COLLECTIONS,
  CONTEXT_DESK_PANES,
  CONTEXT_POLICY_ACTIONS,
  CONTEXT_POLICY_SUGGESTION_STATES,
  type ContextPolicySuggestion,
  type ContextDeskCollection,
  type ContextDeskPane,
  type ContextPacketView,
} from "@unclecode/contracts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { getSelectedVisibleContextPolicySuggestion } from "./work-shell-context-advice.js";
import { resolveContextInspectorSourceCapabilities } from "./work-shell-context-inspector.js";
import {
  buildContextDeskCollectionRows,
  buildContextInspectorRows,
  countContextDeskSources,
  filterContextDeskRows,
  resolveContextDeskCollectionLabel,
  resolveContextDeskSelectedRow,
} from "./work-shell-context-inspector-model.js";
import { resolveWorkShellContextInspectorAction, type WorkShellContextInspectorAction } from "./work-shell-input.js";

export type PiContextDesk = {
  readonly packet: ContextPacketView;
  readonly pane: ContextDeskPane;
  readonly collection: ContextDeskCollection;
  readonly cursor: number;
  readonly expandedId: string | null;
  readonly detailContent: string | undefined;
  readonly detailOffset: number;
  readonly sourceActionsEnabled: boolean;
  readonly canUndo: boolean;
  readonly modelWindow: number;
  readonly adviceEnabled: boolean;
  readonly suggestions: readonly ContextPolicySuggestion[];
};

/** The engine calls the desk makes; all optional so a narrower engine simply loses them. */
export type PiContextDeskEngine = {
  closeOverlay?(): unknown;
  moveContextInspectorPane?(direction: number): unknown;
  moveContextInspectorCursor?(direction: number): unknown;
  moveContextInspectorPage?(direction: number): unknown;
  moveContextInspectorDetailOffset?(direction: number): unknown;
  toggleContextInspectorPin?(): unknown;
  forgetContextSourceAtCursor?(): unknown;
  includeContextSourceAtCursor?(): unknown;
  toggleContextInspectorExpanded?(): unknown;
  undoLastContextSourceAction?(): unknown;
  acceptContextSuggestion?(suggestionId: string): unknown;
  rejectContextSuggestion?(suggestionId: string): unknown;
};

const GROUPS_WIDTH = 22;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isContextPacketView(value: unknown): value is ContextPacketView {
  return isRecord(value)
    && Array.isArray(value.included)
    && Array.isArray(value.excluded)
    && typeof value.tokenEstimate === "number";
}

function isContextPolicySuggestion(value: unknown): value is ContextPolicySuggestion {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.sourceId === "string"
    && typeof value.packetReceiptId === "string"
    && typeof value.reasonCode === "string"
    && typeof value.reasonText === "string"
    && typeof value.createdAt === "string"
    && CONTEXT_POLICY_ACTIONS.some((action) => action === value.action)
    && CONTEXT_POLICY_SUGGESTION_STATES.some((status) => status === value.status);
}

/** The desk is open only while the engine says so and a packet exists to show. */
export function readPiContextDesk(state: Readonly<Record<string, unknown>>): PiContextDesk | undefined {
  if (state.contextInspectorOpen !== true || !isContextPacketView(state.contextPacket)) return undefined;
  const pane = CONTEXT_DESK_PANES.find((candidate) => candidate === state.contextInspectorPane) ?? "sources";
  const collection = CONTEXT_DESK_COLLECTIONS.find((candidate) => candidate === state.contextInspectorCollection) ?? "all";
  const receipt = isRecord(state.contextActionReceipt) ? state.contextActionReceipt : undefined;
  return {
    packet: state.contextPacket,
    pane,
    collection,
    cursor: typeof state.contextInspectorCursor === "number" ? state.contextInspectorCursor : -1,
    expandedId: typeof state.contextInspectorExpanded === "string" ? state.contextInspectorExpanded : null,
    detailContent: typeof state.contextInspectorDetailContent === "string" ? state.contextInspectorDetailContent : undefined,
    detailOffset: typeof state.contextInspectorDetailOffset === "number" ? state.contextInspectorDetailOffset : 0,
    sourceActionsEnabled: state.contextSourceActionsEnabled === true,
    canUndo: receipt?.canUndo === true,
    modelWindow: typeof state.modelWindow === "number" && state.modelWindow > 0 ? state.modelWindow : 200_000,
    adviceEnabled: state.contextAdviceActionsEnabled === true,
    suggestions: Array.isArray(state.contextPolicySuggestions)
      ? state.contextPolicySuggestions.filter(isContextPolicySuggestion)
      : [],
  };
}

function padTo(text: string, width: number): string {
  const cut = truncateToWidth(text, width);
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function formatTokens(tokens: number | undefined): string {
  return tokens === undefined ? "" : ` · ~${tokens}t`;
}

function selectedDeskRow(desk: PiContextDesk) {
  return resolveContextDeskSelectedRow(
    filterContextDeskRows(buildContextInspectorRows(desk.packet), desk.collection),
    desk.cursor,
  );
}

/** The proposed advice for the selected source, when the engine lets the desk act on it. */
export function selectedPiDeskSuggestion(desk: PiContextDesk): ContextPolicySuggestion | undefined {
  if (!desk.adviceEnabled) return undefined;
  return getSelectedVisibleContextPolicySuggestion({
    packet: desk.packet,
    suggestions: desk.suggestions,
    selectedSourceId: selectedDeskRow(desk)?.item.id,
  });
}

/**
 * Desk rows for a `width`×`height` box: budget line, Groups | Sources columns
 * with the cursor window, then the selected source's preview (or its expanded
 * detail from the engine's offset), then the keys.
 */
export function formatPiContextDeskLines(desk: PiContextDesk, width: number, height: number): readonly string[] {
  const rows = buildContextInspectorRows(desk.packet);
  const collections = buildContextDeskCollectionRows(rows);
  const visible = filterContextDeskRows(rows, desk.collection);
  const selected = resolveContextDeskSelectedRow(visible, desk.cursor);
  const sent = countContextDeskSources(rows.filter((row) => !row.heldBack));
  const held = countContextDeskSources(rows.filter((row) => row.heldBack));
  const focus = (pane: ContextDeskPane, label: string) => (desk.pane === pane ? `[${label}]` : ` ${label} `);

  const lines: string[] = [
    truncateToWidth(`Sources · ${sent} sent · ${held} held · ~${desk.packet.tokenEstimate}t / ${desk.modelWindow / 1000}k`, width),
    "",
  ];
  const listHeight = Math.max(4, Math.floor((height - 8) * 0.6));
  const sourcesWidth = Math.max(10, width - GROUPS_WIDTH - 2);
  lines.push(`${padTo(focus("groups", "GROUPS"), GROUPS_WIDTH)}  ${truncateToWidth(
    `${focus("sources", "SOURCES")} ${resolveContextDeskCollectionLabel(desk.collection)} · ${visible.length}`,
    sourcesWidth,
  )}`);

  const start = Math.min(Math.max(0, desk.cursor - Math.floor(listHeight / 2)), Math.max(0, visible.length - listHeight));
  for (let row = 0; row < listHeight; row += 1) {
    const collection = collections[row];
    const left = collection
      ? `${collection.id === desk.collection ? "›" : " "} ${collection.label} ${collection.count}`
      : "";
    const source = visible[start + row];
    const right = source
      ? `${start + row === desk.cursor ? "›" : " "} ${source.heldBack ? "○" : "●"} ${source.item.label}${formatTokens(source.item.tokenEstimate)}`
      : "";
    if (!collection && !source) break;
    lines.push(`${padTo(left, GROUPS_WIDTH)}  ${truncateToWidth(right, sourcesWidth)}`);
  }
  const hiddenAfter = Math.max(0, visible.length - (start + listHeight));
  if (hiddenAfter > 0) lines.push(`${" ".repeat(GROUPS_WIDTH + 2)}… ${hiddenAfter} more below`);

  const advice = selectedPiDeskSuggestion(desk);
  if (advice) {
    const saving = advice.estimatedTokenSaving ? ` · saves ~${advice.estimatedTokenSaving}t` : "";
    lines.push("", truncateToWidth(`Advice · ${advice.action}${saving} — ${advice.reasonText}  (a accept · r reject)`, width));
  }
  lines.push("", truncateToWidth(`${focus("preview", "PREVIEW")} ${selected ? selected.item.label : "nothing selected"}`, width));
  if (selected) {
    const expanded = desk.expandedId === selected.item.id && desk.detailContent !== undefined;
    const body = expanded ? desk.detailContent ?? "" : selected.item.preview ?? selected.item.reason;
    const wrapped = body.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 2)));
    const previewHeight = Math.max(2, height - lines.length - 2);
    const from = expanded ? Math.min(desk.detailOffset, Math.max(0, wrapped.length - 1)) : 0;
    for (const line of wrapped.slice(from, from + previewHeight)) lines.push(`  ${line}`);
  }
  lines.push("", truncateToWidth("↑↓/jk move · ←→/hl pane · PgUp/PgDn page · Enter details · Space hold back/include · P pin · U undo · Esc close", width));
  return lines;
}

/** Keys the desk owns, resolved exactly as the Ink desk resolves them. */
export function resolvePiContextDeskAction(input: {
  readonly desk: PiContextDesk;
  readonly value: string;
  readonly key: {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly pageUp?: boolean;
    readonly pageDown?: boolean;
    readonly return?: boolean;
  };
  readonly composerEmpty: boolean;
}): WorkShellContextInspectorAction {
  const selected = selectedDeskRow(input.desk);
  const capabilities = resolveContextInspectorSourceCapabilities(selected?.item);
  return resolveWorkShellContextInspectorAction({
    value: input.value,
    key: input.key,
    panelTitle: "Context expanded",
    actionsEnabled: input.desk.sourceActionsEnabled,
    pinActionsEnabled: input.desk.sourceActionsEnabled && (capabilities.pin || capabilities.unpin),
    deliveryActionsEnabled: input.desk.sourceActionsEnabled && capabilities.delivery !== undefined,
    adviceActionsEnabled: selectedPiDeskSuggestion(input.desk) !== undefined,
    undoActionsEnabled: input.desk.sourceActionsEnabled && input.desk.canUndo,
    expandActionsEnabled: capabilities.preview,
    composerEmpty: input.composerEmpty,
  });
}

/** Runs one desk action on the engine; returns whether the key was the desk's. */
export function applyPiContextDeskAction(
  engine: PiContextDeskEngine,
  desk: PiContextDesk,
  action: WorkShellContextInspectorAction,
): boolean {
  switch (action.type) {
    case "move-pane":
      engine.moveContextInspectorPane?.(action.direction);
      return true;
    case "move-cursor":
      // An expanded source scrolls its detail outside the groups pane, as in the Ink desk.
      if (desk.expandedId !== null && desk.pane !== "groups") engine.moveContextInspectorDetailOffset?.(action.direction);
      else engine.moveContextInspectorCursor?.(action.direction);
      return true;
    case "move-page":
      engine.moveContextInspectorPage?.(action.direction);
      return true;
    case "toggle-pin":
      engine.toggleContextInspectorPin?.();
      return true;
    case "toggle-delivery": {
      if (selectedDeskRow(desk)?.heldBack) engine.includeContextSourceAtCursor?.();
      else engine.forgetContextSourceAtCursor?.();
      return true;
    }
    case "undo":
      engine.undoLastContextSourceAction?.();
      return true;
    case "expand":
      engine.toggleContextInspectorExpanded?.();
      return true;
    case "accept-advice":
    case "reject-advice": {
      const suggestion = selectedPiDeskSuggestion(desk);
      if (!suggestion) return false;
      if (action.type === "accept-advice") engine.acceptContextSuggestion?.(suggestion.id);
      else engine.rejectContextSuggestion?.(suggestion.id);
      return true;
    }
    case "none":
      return false;
  }
}
