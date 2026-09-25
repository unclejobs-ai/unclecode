/**
 * Work shell on `@earendil-works/pi-tui` (strangler shell, Slice B).
 *
 * Carries one journey end to end — prompt → streaming answer → tool trace →
 * scroll while streaming — over the same engine the Ink shell renders
 * (`getState`/`subscribe`/`handleSubmit`), so both shells can run against one
 * owner session. pi-tui's alternate-screen viewport owns scrolling: the
 * transcript is a follow-end `ScrollView`, so PageUp or the wheel stops
 * following while the answer keeps streaming, and End/scrolling back down
 * resumes it. Screens move over from the Ink shell one at a time; until then
 * `UNCLECODE_TUI_SHELL=pi` selects this shell.
 */
import {
  Box,
  type Component,
  Container,
  type OverlayHandle,
  Editor,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  truncateToWidth,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";

import { PiAuthPicker } from "./pi-auth-picker.js";
import { bold, cyan, dim, type PiShellEntry, TranscriptSync, yellow } from "./pi-transcript.js";
import {
  type ClipboardImageAttachment,
  type ClipboardImageResult,
  CONTEXT_DESK_PANES,
  type ContextDeskPane,
} from "@unclecode/contracts";
import { captureClipboardImage } from "@unclecode/orchestrator";

import {
  applyPiContextDeskAction,
  formatPiContextDeskLines,
  type PiContextDesk,
  type PiContextDeskEngine,
  readPiContextDesk,
  resolvePiContextDeskAction,
} from "./pi-context-desk.js";
import { formatPiDecisionRows, piDecisionOptionCount, type PiShellDecision, readPiShellDecision } from "./pi-decision.js";
import type { ProviderAuthCatalogPort } from "./work-shell-auth-provider-picker-model.js";
import { formatAttachmentBadgeLine } from "./work-shell-attachments.js";
import { WORK_SHELL_MODE_CYCLE } from "./work-shell-input.js";
import { selectWorkShellLiveToolTraceLines } from "./work-shell-live-activity.js";

export type PiShellState = {
  readonly entries: readonly PiShellEntry[];
  readonly streamingAssistantText: string;
  readonly isBusy: boolean;
  readonly busyStatus: string;
  readonly model: string;
  readonly mode: string;
  readonly queuedCount: number;
  readonly queuePaused: boolean;
  readonly lastTurnDurationMs: number | undefined;
  readonly currentTurnStartedAt: number | undefined;
  /** Newest tool row of the live trace (`→ read .`), as the Ink dock shows it. */
  readonly liveToolLine: string | undefined;
  /** A panel a command opened (`/help`, `/model`, `/status` …); the collapsed context panel is none. */
  readonly panel: PiShellPanel | undefined;
  /** A pending approval or question; ordinary submits are ignored until it is answered. */
  readonly decision: PiShellDecision | undefined;
  /** The Context Desk (`/context`) while the engine has it open. */
  readonly desk: PiContextDesk | undefined;
};

export type PiShellPanel = {
  readonly title: string;
  readonly lines: readonly string[];
};

/** The slice of the work-shell engine this shell drives (local or owner-remote). */
export type PiShellEngine = PiContextDeskEngine & {
  getState(): unknown;
  subscribe(listener: (state: unknown) => void): () => void;
  initialize?(): unknown;
  handleSubmit(line: string, attachments?: readonly ClipboardImageAttachment[]): Promise<unknown>;
  setMode?(mode: string): unknown;
  dispose?(): unknown;
  interruptTurn?(): unknown;
  updateTerminalColumns?(columns: number): unknown;
  submitPendingDecisionText?(value: string, decisionId: string): unknown;
  answerPendingDecisionByIndex?(index: number, decisionId: string): unknown;
  cancelPendingDecision?(decisionId: string): unknown;
};

const BUSY_TICK_MS = 1_000;
/** The engine's resting panel: the collapsed context summary, not something a command opened. */
const RESTING_PANEL_TITLE = "Context";
const SESSIONS_PANEL_TITLE = "Recent sessions";
const panelBg = (text: string) => `\u001b[48;5;236m${text}\u001b[49m`;
const ENTRY_ROLES = new Set(["system", "user", "assistant", "tool"]);

const EDITOR_THEME = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isPiShellEntry(value: unknown): value is PiShellEntry {
  return isRecord(value)
    && typeof value.role === "string"
    && ENTRY_ROLES.has(value.role)
    && typeof value.text === "string";
}

/** Owner-remote state arrives as a plain record; read only the fields this shell shows. */
export function readPiShellState(value: unknown): PiShellState {
  const state = isRecord(value) ? value : {};
  const entries = Array.isArray(state.entries) ? state.entries.filter(isPiShellEntry) : [];
  return {
    entries,
    streamingAssistantText: typeof state.streamingAssistantText === "string" ? state.streamingAssistantText : "",
    isBusy: state.isBusy === true,
    busyStatus: typeof state.busyStatus === "string" ? state.busyStatus : "",
    model: typeof state.model === "string" ? state.model : "",
    mode: typeof state.mode === "string" ? state.mode : "default",
    queuedCount: typeof state.queuedCount === "number" ? state.queuedCount : 0,
    queuePaused: state.queuePaused === true,
    lastTurnDurationMs: typeof state.lastTurnDurationMs === "number" ? state.lastTurnDurationMs : undefined,
    currentTurnStartedAt: typeof state.currentTurnStartedAt === "number" ? state.currentTurnStartedAt : undefined,
    panel: readPiShellPanel(state.panel),
    decision: readPiShellDecision(state.agentConsole),
    desk: readPiContextDesk(state),
    liveToolLine: Array.isArray(state.liveTraceLines)
      ? selectWorkShellLiveToolTraceLines(state.liveTraceLines.filter((line) => typeof line === "string"), 1)[0]
      : undefined,
  };
}

function readPiShellPanel(value: unknown): PiShellPanel | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || value.title === RESTING_PANEL_TITLE) return undefined;
  const lines = Array.isArray(value.lines) ? value.lines.filter((line) => typeof line === "string") : [];
  return { title: value.title, lines };
}

/**
 * Ctrl+V: a clipboard image joins the next submit, as in the Ink composer. No
 * image leaves everything as it was; any other capture failure is reported.
 */
export function pastePiClipboardImage(
  capture: () => ClipboardImageResult,
  pending: readonly ClipboardImageAttachment[],
): { readonly pending: readonly ClipboardImageAttachment[]; readonly error: string | undefined } {
  const result = capture();
  if (result.status === "ok") return { pending: [...pending, result.attachment], error: undefined };
  return { pending, error: result.status === "no-image" ? undefined : `clipboard: ${result.reason}` };
}

/** The session a digit picks in the `/sessions` panel (`N. work-… · state · summary`). */
export function resolvePiSessionChoice(panel: PiShellPanel | undefined, digit: string): string | undefined {
  if (panel?.title !== SESSIONS_PANEL_TITLE || !/^[1-9]$/u.test(digit)) return undefined;
  const line = panel.lines.find((candidate) => candidate.trimStart().startsWith(`${digit}. `));
  return line?.match(/^\s*\d+\. (\S+)/u)?.[1];
}

/** Shift+Tab's next mode, in the Ink shell's cycle order. */
export function nextPiShellMode(current: string): string {
  const index = WORK_SHELL_MODE_CYCLE.findIndex((mode) => mode === current);
  return WORK_SHELL_MODE_CYCLE[(index + 1) % WORK_SHELL_MODE_CYCLE.length] ?? "default";
}

export function formatPiShellQueue(state: PiShellState): string | undefined {
  if (state.queuedCount === 0) return undefined;
  return `${state.queuedCount} queued${state.queuePaused ? " · paused" : ""}`;
}

export function formatPiShellStatus(state: PiShellState, now: number = Date.now()): string {
  if (state.isBusy) {
    const elapsed = state.currentTurnStartedAt === undefined
      ? ""
      : ` · ${(Math.max(0, now - state.currentTurnStartedAt) / 1000).toFixed(1)}s`;
    return `◆ ${state.liveToolLine ?? (state.busyStatus || "Working")}${elapsed}`;
  }
  const last = state.lastTurnDurationMs === undefined ? "" : ` · last ${(state.lastTurnDurationMs / 1000).toFixed(1)}s`;
  return `◇ Ready${last}`;
}

/** Lays the desk out at whatever width the overlay gives it. */
class PiContextDeskView implements Component {
  desk: PiContextDesk | undefined;

  constructor(private readonly rows: () => number) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.desk ? [...formatPiContextDeskLines(this.desk, width, Math.floor(this.rows() * 0.8))] : [];
  }
}

/**
 * One row, cut to the terminal width. The busy status carries a reasoning
 * preview with newlines; a newline inside a rendered row scrolls the terminal
 * and desyncs the differential renderer's screen (rows shift, the status row
 * shows twice), so whitespace runs fold to one space.
 */
export class PiShellStatusLine implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text.replace(/[\r\n\t]+/g, " ");
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [truncateToWidth(` ${this.text}`, width)];
  }
}

export async function renderPiWorkShell(
  initialEngine: PiShellEngine,
  options: {
    readonly providerAuthCatalog?: ProviderAuthCatalogPort | undefined;
    readonly captureClipboardImage?: (() => ClipboardImageResult) | undefined;
    /** Attaches another owner session; the shell then renders that session's engine. */
    readonly openSession?: ((sessionId: string) => Promise<PiShellEngine>) | undefined;
  } = {},
): Promise<void> {
  let engine = initialEngine;
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, undefined, undefined, { scrollToEndIndicator: () => " ↓ new output · End " });
  const transcript = new Container();
  const sync = new TranscriptSync(transcript);
  const status = new PiShellStatusLine();
  const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 });

  const scroll = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" });
  tui.setLayoutRoot(new VStack([
    {
      component: scroll,
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    { component: editor, basis: "auto", shrink: 1, minSize: 1 },
    { component: status, basis: "auto", minSize: 1 },
  ]));

  let state = readPiShellState(engine.getState());
  // A failed control stays on the status row until the next submit; the busy tick would
  // otherwise repaint over it within a second.
  let errorText: string | undefined;
  let pendingImages: readonly ClipboardImageAttachment[] = [];
  const showStatus = () => {
    if (errorText !== undefined) {
      status.setText(yellow(`✗ ${errorText}`));
      tui.requestRender();
      return;
    }
    status.setText(dim([
      formatPiShellStatus(state),
      `${state.model} · ${state.mode}`,
      ...(formatPiShellQueue(state) ? [formatPiShellQueue(state)] : []),
      ...(pendingImages.length > 0 ? [formatAttachmentBadgeLine(pendingImages)] : []),
      `PgUp/PgDn · wheel scroll · Ctrl+C ${state.isBusy ? "interrupt" : "quit"}`,
    ].join("  │  ")));
    tui.requestRender();
  };
  // A command's panel floats above the editor without taking focus; Esc with an
  // empty draft dismisses it until the engine opens a different one.
  let panelOverlay: OverlayHandle | undefined;
  let shownPanelKey: string | undefined;
  let dismissedPanelKey: string | undefined;
  const deskView = new PiContextDeskView(() => terminal.rows);
  // Pane moves are predicted here until the engine's state confirms them: a key
  // typed right after ←/→ would otherwise resolve against the pane before the move.
  let predictedPane: ContextDeskPane | undefined;
  let deskOverlay: OverlayHandle | undefined;
  const syncDesk = () => {
    deskView.desk = state.desk;
    if (state.desk && !deskOverlay) {
      const box = new Box(1, 0, panelBg);
      box.addChild(new Text(`${bold("Context Desk")}  ${dim("what reaches the next answer")}`, 0, 0));
      box.addChild(deskView);
      deskOverlay = tui.showOverlay(box, { anchor: "center", width: "96%", maxHeight: "85%", nonCapturing: true });
    } else if (!state.desk && deskOverlay) {
      deskOverlay.hide();
      deskOverlay = undefined;
    }
  };
  // A pending decision takes the same place and cannot be dismissed, only answered or cancelled.
  const syncPanel = () => {
    const shown = state.decision
      ? {
          key: `decision:${state.decision.id}`,
          title: state.decision.title ?? (state.decision.kind === "security-approval" ? "Approval needed" : "Decision"),
          hint: "",
          lines: formatPiDecisionRows(state.decision),
        }
      : state.panel && !state.desk
        ? { key: `${state.panel.title}\n${state.panel.lines.join("\n")}`, title: state.panel.title, hint: "Esc close", lines: state.panel.lines }
        : undefined;
    const visibleKey = shown === undefined || shown.key === dismissedPanelKey ? undefined : shown.key;
    if (visibleKey === shownPanelKey) return;
    panelOverlay?.hide();
    panelOverlay = undefined;
    shownPanelKey = visibleKey;
    if (!visibleKey || !shown) return;
    const box = new Box(1, 0, panelBg);
    box.addChild(new Text(`${bold(shown.title)}  ${dim(shown.hint)}`, 0, 0));
    box.addChild(new Text(shown.lines.join("\n"), 0, 0));
    panelOverlay = tui.showOverlay(box, {
      anchor: "bottom-center",
      width: "90%",
      maxHeight: "60%",
      offsetY: -4,
      nonCapturing: true,
    });
  };
  const show = (next: unknown) => {
    state = readPiShellState(next);
    if (!state.desk || state.desk.pane === predictedPane) predictedPane = undefined;
    sync.apply(state);
    syncDesk();
    syncPanel();
    showStatus();
  };
  // Owner state only changes on events; the elapsed time of a busy turn also moves between them.
  const tick = setInterval(() => {
    if (state.isBusy) showStatus();
  }, BUSY_TICK_MS);

  await new Promise<void>((resolve) => {
    const quit = () => {
      clearInterval(tick);
      unsubscribe();
      tui.stop();
      resolve();
    };
    const reportError = (error: unknown) => {
      errorText = error instanceof Error ? error.message : String(error);
      showStatus();
    };
    const authPicker = options.providerAuthCatalog
      ? new PiAuthPicker(tui, options.providerAuthCatalog, { bold, dim, background: panelBg })
      : undefined;
    editor.onChange = (text) => authPicker?.update(text);
    editor.onSubmit = (text) => {
      const line = text.trim();
      if (line.length === 0) return;
      errorText = undefined;
      editor.addToHistory(line);
      if (state.decision && engine.submitPendingDecisionText) {
        void Promise.resolve(engine.submitPendingDecisionText(line, state.decision.id)).catch(reportError);
        return;
      }
      if (authPicker?.submit(line)) return;
      const attachments = pendingImages;
      pendingImages = [];
      void engine.handleSubmit(line, attachments).catch(reportError);
    };
    tui.addInputListener((data) => {
      if (authPicker?.handleKey(data)) return { consume: true };
      const decision = state.decision;
      if (decision && editor.getText().length === 0) {
        // The engine numbers options from 1, as they are shown.
        const choice = /^[1-9]$/u.test(data) ? Number(data) : undefined;
        if (choice !== undefined && choice <= piDecisionOptionCount(decision) && engine.answerPendingDecisionByIndex) {
          errorText = undefined;
          void Promise.resolve(engine.answerPendingDecisionByIndex(choice, decision.id)).catch(reportError);
          return { consume: true };
        }
        if (matchesKey(data, "escape") && engine.cancelPendingDecision) {
          void Promise.resolve(engine.cancelPendingDecision(decision.id)).catch(reportError);
          return { consume: true };
        }
      }
      if (matchesKey(data, "escape") && authPicker?.isOpen) {
        authPicker.close();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+v")) {
        const pasted = pastePiClipboardImage(options.captureClipboardImage ?? captureClipboardImage, pendingImages);
        pendingImages = pasted.pending;
        if (pasted.error !== undefined) errorText = pasted.error;
        showStatus();
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab") && !state.isBusy && engine.setMode) {
        void Promise.resolve(engine.setMode(nextPiShellMode(state.mode))).catch(reportError);
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        if (state.isBusy && engine.interruptTurn) engine.interruptTurn();
        else quit();
        return { consume: true };
      }
      // pi-tui's viewport has no End binding; with an empty draft End has nothing to
      // move in the editor, so it jumps back to the live end the indicator points at.
      if (matchesKey(data, "end") && editor.getText().length === 0) {
        scroll.scrollToEnd();
        tui.requestRender();
        return { consume: true };
      }
      const desk = state.desk && predictedPane ? { ...state.desk, pane: predictedPane } : state.desk;
      if (desk && !decision) {
        if (matchesKey(data, "escape")) {
          engine.closeOverlay?.();
          return { consume: true };
        }
        const action = resolvePiContextDeskAction({
          desk,
          value: data.length === 1 ? data : "",
          key: {
            upArrow: matchesKey(data, "up"),
            downArrow: matchesKey(data, "down"),
            leftArrow: matchesKey(data, "left"),
            rightArrow: matchesKey(data, "right"),
            pageUp: matchesKey(data, "pageUp"),
            pageDown: matchesKey(data, "pageDown"),
            return: matchesKey(data, "enter"),
          },
          composerEmpty: editor.getText().length === 0,
        });
        if (action.type === "move-pane") {
          const index = CONTEXT_DESK_PANES.indexOf(desk.pane) + (action.direction >= 0 ? 1 : -1);
          predictedPane = CONTEXT_DESK_PANES[Math.min(CONTEXT_DESK_PANES.length - 1, Math.max(0, index))];
        }
        if (applyPiContextDeskAction(engine, desk, action)) return { consume: true };
      }
      const sessionId = editor.getText().length === 0 ? resolvePiSessionChoice(state.panel, data) : undefined;
      if (sessionId !== undefined && options.openSession) {
        errorText = undefined;
        void openSession(sessionId).catch(reportError);
        return { consume: true };
      }
      if (matchesKey(data, "escape") && shownPanelKey !== undefined && editor.getText().length === 0) {
        dismissedPanelKey = shownPanelKey;
        syncPanel();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
        quit();
        return { consume: true };
      }
      return undefined;
    });
    let unsubscribe = engine.subscribe(show);
    const openSession = async (sessionId: string) => {
      if (!options.openSession) return;
      const next = await options.openSession(sessionId);
      unsubscribe();
      engine.dispose?.();
      engine = next;
      unsubscribe = engine.subscribe(show);
      engine.updateTerminalColumns?.(terminal.columns);
      void engine.initialize?.();
      dismissedPanelKey = shownPanelKey;
      show(engine.getState());
    };
    tui.setFocus(editor);
    tui.start();
    engine.updateTerminalColumns?.(terminal.columns);
    void engine.initialize?.();
    show(engine.getState());
  });
}
