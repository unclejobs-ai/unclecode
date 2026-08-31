const WORK_SHELL_MODE_CYCLE = ["default", "yolo", "ultrawork", "analyze", "search"] as const;
const RUST_WHITESPACE_AT_EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;
const RUST_I64_MAX = 9_223_372_036_854_775_807n;

type WorkShellCycleMode = (typeof WORK_SHELL_MODE_CYCLE)[number];

// Keep the former `rust ux input-action|submit-action` wire semantics while
// resolving in-process. Rust's `str::trim` and serde `as_i64` boundaries are
// deliberately narrower than JavaScript's native trim/number behavior. The
// generated parity hashes in work-shell-input-action.test.mjs guard both.
function trimRustWhitespace(value: string): string {
  return value.replace(RUST_WHITESPACE_AT_EDGES, "");
}

function isPositiveRustI64(value: number): boolean {
  return Number.isInteger(value) && value > 0 && BigInt(value) <= RUST_I64_MAX;
}

export type WorkShellInputAction =
  | { readonly type: "none" }
  | { readonly type: "exit" }
  | { readonly type: "complete-slash"; readonly value: string }
  | { readonly type: "move-slash-selection"; readonly direction: "previous" | "next" }
  | { readonly type: "close-slash-picker" }
  | { readonly type: "cycle-mode"; readonly nextMode: WorkShellCycleMode }
  | { readonly type: "cancel-sensitive-input" }
  | { readonly type: "interrupt-turn" }
  | { readonly type: "clear-input" }
  | { readonly type: "close-overlay" }
  | { readonly type: "open-engine-sessions" };

export type WorkShellSubmitAction =
  | { readonly type: "noop" }
  | { readonly type: "replace-input"; readonly value: string }
  | { readonly type: "submit"; readonly line: string; readonly clearInput: true }
  | { readonly type: "submit-suggestion"; readonly line: string; readonly clearInput: true };

export type WorkShellTranscriptNavigationAction =
  | { readonly type: "none" }
  | { readonly type: "page"; readonly direction: -1 | 1 }
  | { readonly type: "latest" };

type WorkShellTranscriptNavigationKey = {
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly end?: boolean;
};

const WORK_SHELL_TRANSCRIPT_NAVIGATION_NONE: WorkShellTranscriptNavigationAction = { type: "none" };
const WORK_SHELL_KITTY_PAGE_UP_RE = /^\u001b\[57421(?:;\d+(?::\d+)?)?u$/u;
const WORK_SHELL_KITTY_PAGE_DOWN_RE = /^\u001b\[57422(?:;\d+(?::\d+)?)?u$/u;
const WORK_SHELL_KITTY_END_RE = /^\u001b\[57424(?:;\d+(?::\d+)?)?u$/u;
const WORK_SHELL_SGR_MOUSE_RE = /\u001b\[<(\d+);\d+;\d+[mM]/gu;

/**
 * Normalize the terminal key paths that Ink exposes to the work-shell
 * controller. Ink's legacy parser maps the common VT/SS3/modified CSI paths
 * to `pageUp`, `pageDown`, and `end`; the explicit flags are intentionally
 * preferred because they are already de-duplicated by Ink's input parser.
 */
export function resolveWorkShellTranscriptNavigation(input: {
  readonly value: string;
  readonly key: WorkShellTranscriptNavigationKey;
}): WorkShellTranscriptNavigationAction {
  if (input.key.pageUp) return { type: "page", direction: -1 };
  if (input.key.pageDown) return { type: "page", direction: 1 };
  if (input.key.end) return { type: "latest" };

  // A terminal with the Kitty keyboard protocol enabled can report keypad
  // PgUp/PgDn/End as CSI-u private codepoints. Ink correctly recognizes these
  // as `kppageup`, `kppagedown`, and `kpend`, but its public useInput key
  // object intentionally only exposes the non-keypad flags. The controller's
  // raw event fallback calls this function with the original sequence.
  if (isWorkShellKittyKeypadSequence(input.value, 57421)) {
    return { type: "page", direction: -1 };
  }
  if (isWorkShellKittyKeypadSequence(input.value, 57422)) {
    return { type: "page", direction: 1 };
  }
  if (isWorkShellKittyKeypadSequence(input.value, 57424)) {
    return { type: "latest" };
  }
  return WORK_SHELL_TRANSCRIPT_NAVIGATION_NONE;
}

/**
 * Decode only the Kitty keypad fallback sequences that Ink cannot expose as
 * page/end flags. Keeping this separate prevents a raw-event listener from
 * dispatching the ordinary `[5~`/`[6~` events a second time after useInput has
 * already handled them.
 */
export function resolveWorkShellRawTranscriptNavigation(
  value: string,
): WorkShellTranscriptNavigationAction {
  return resolveWorkShellRawTranscriptNavigations(value).at(-1)
    ?? WORK_SHELL_TRANSCRIPT_NAVIGATION_NONE;
}

/** Preserve every wheel report when a PTY coalesces a trackpad burst. */
export function resolveWorkShellRawTranscriptNavigations(
  value: string,
): readonly WorkShellTranscriptNavigationAction[] {
  const mouseActions = [...value.matchAll(WORK_SHELL_SGR_MOUSE_RE)]
    .map((match): WorkShellTranscriptNavigationAction => {
      const mouseButton = Number.parseInt(match[1] ?? "", 10);
      // SGR button codes add Shift/Alt/Ctrl bits (4/8/16) to the base wheel
      // code. Normalize those modifiers so a trackpad gesture keeps working
      // while a terminal modifier is held.
      const baseButton = mouseButton & ~28;
      if (baseButton === 64) return { type: "page", direction: -1 };
      if (baseButton === 65) return { type: "page", direction: 1 };
      return WORK_SHELL_TRANSCRIPT_NAVIGATION_NONE;
    })
    .filter((action) => action.type !== "none");
  if (mouseActions.length > 0) return mouseActions;
  if (isWorkShellKittyKeypadSequence(value, 57421)) {
    return [{ type: "page", direction: -1 }];
  }
  if (isWorkShellKittyKeypadSequence(value, 57422)) {
    return [{ type: "page", direction: 1 }];
  }
  if (isWorkShellKittyKeypadSequence(value, 57424)) {
    return [{ type: "latest" }];
  }
  return [];
}

function isWorkShellKittyKeypadSequence(value: string, codepoint: number): boolean {
  if (codepoint === 57421) return WORK_SHELL_KITTY_PAGE_UP_RE.test(value);
  if (codepoint === 57422) return WORK_SHELL_KITTY_PAGE_DOWN_RE.test(value);
  if (codepoint === 57424) return WORK_SHELL_KITTY_END_RE.test(value);
  return false;
}

export function resolveWorkShellInputAction(input: {
  readonly value: string;
  readonly key: {
    readonly ctrl?: boolean;
    readonly tab?: boolean;
    readonly shift?: boolean;
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly escape?: boolean;
  };
  readonly input: string;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
  readonly isBusy: boolean;
  readonly hasRequestSessionsView: boolean;
  readonly currentMode?: string;
  readonly hasSensitiveInput?: boolean;
  readonly hasOverlayOpen?: boolean;
  readonly hasSlashPicker?: boolean;
  readonly escapeResetArmed?: boolean;
}): WorkShellInputAction {
  if (!input.key.ctrl && !input.key.tab && !input.key.upArrow && !input.key.downArrow && !input.key.escape) {
    return { type: "none" };
  }
  const slashOpen = trimRustWhitespace(input.input).startsWith("/")
    && isPositiveRustI64(input.slashSuggestionCount);
  if (input.key.ctrl && input.value === "c") {
    return input.isBusy ? { type: "interrupt-turn" } : { type: "exit" };
  }
  if (input.key.tab && input.key.shift && !input.isBusy && !slashOpen) {
    const index = WORK_SHELL_MODE_CYCLE.indexOf(input.currentMode as WorkShellCycleMode);
    const nextMode = WORK_SHELL_MODE_CYCLE[index < 0 ? 0 : (index + 1) % WORK_SHELL_MODE_CYCLE.length]
      ?? WORK_SHELL_MODE_CYCLE[0];
    return { type: "cycle-mode", nextMode };
  }
  if (input.key.tab && slashOpen) {
    return { type: "complete-slash", value: `${input.selectedSlashCommand ?? input.input} ` };
  }
  if (input.key.upArrow && slashOpen) return { type: "move-slash-selection", direction: "previous" };
  if (input.key.downArrow && slashOpen) return { type: "move-slash-selection", direction: "next" };
  if (!input.key.escape) return { type: "none" };
  if (input.hasSensitiveInput) return { type: "cancel-sensitive-input" };
  if (input.hasSlashPicker) return { type: "close-slash-picker" };
  if (input.hasOverlayOpen) return { type: "close-overlay" };
  if (input.isBusy) return { type: "interrupt-turn" };
  if (trimRustWhitespace(input.input)) {
    return input.escapeResetArmed ? { type: "clear-input" } : { type: "none" };
  }
  return input.hasRequestSessionsView ? { type: "none" } : { type: "open-engine-sessions" };
}

export function resolveWorkShellSubmitAction(input: {
  readonly value: string;
  readonly isBusy: boolean;
  readonly shouldBlockSlashSubmit: boolean;
  readonly selectedSlashCommand?: string;
  readonly activePanelTitle?: string;
}): WorkShellSubmitAction {
  const line = trimRustWhitespace(input.value);
  if (!line) return { type: "noop" };
  if (input.isBusy || line === "/auth") return { type: "submit", line, clearInput: true };
  if (input.activePanelTitle === "Model picker" && !line.startsWith("/")) {
    return { type: "submit", line: `/model ${line}`, clearInput: true };
  }
  if (input.shouldBlockSlashSubmit) {
    return input.selectedSlashCommand
      ? { type: "submit-suggestion", line: input.selectedSlashCommand, clearInput: true }
      : { type: "noop" };
  }
  return { type: "submit", line, clearInput: true };
}

/**
 * Context Inspector (Sprint 2) — keyboard action resolver for the /context
 * overlay. Pure TS (no Rust): the decision is a handful of key comparisons
 * and does not need the ux contract's state machine. It runs after the Agent
 * Console resolver in `work-shell-agent-console-input.ts`, which owns the
 * keyboard while the console overlay is open.
 *
 * Fires ONLY when the context overlay is the active panel. The slash command
 * picker always wins: when the composer input starts with `/`, every key
 * returns `"none"` so the picker keeps typing/navigation.
 *
 * Pure Yazi navigation (`h`/`l` + ←/→ panes, `j`/`k` + ↑/↓ rows, PgUp/PgDn
 * pages) resolves ahead of the mutation letters and ignores the capability
 * flags, because walking the desk only reads the packet. The letters match
 * exact case so Shift-letters stay ordinary composer text. Nothing resolves
 * at all once `composerEmpty` is explicitly `false`: a locally pending draft
 * owns every key, navigation aliases included.
 */
export type WorkShellContextInspectorAction =
  | { readonly type: "none" }
  | { readonly type: "move-pane"; readonly direction: -1 | 1 }
  | { readonly type: "move-cursor"; readonly direction: -1 | 1 }
  | { readonly type: "move-page"; readonly direction: -1 | 1 }
  | { readonly type: "toggle-pin" }
  | { readonly type: "toggle-delivery" }
  | { readonly type: "undo" }
  | { readonly type: "accept-advice" }
  | { readonly type: "reject-advice" }
  | { readonly type: "expand" };

export function resolveWorkShellContextInspectorAction(input: {
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
  readonly panelTitle: string;
  readonly actionsEnabled?: boolean;
  readonly pinActionsEnabled?: boolean;
  readonly deliveryActionsEnabled?: boolean;
  readonly adviceActionsEnabled?: boolean;
  readonly undoActionsEnabled?: boolean;
  /**
   * Whether Enter currently belongs to the desk's expansion handler. Legacy
   * direct resolver callers omit this flag and retain the former ownership.
   */
  readonly expandActionsEnabled?: boolean;
  // Raw composer emptiness. Omitted by callers that have no composer to
  // consult; an explicit `false` means the user holds a pending draft, and
  // the desk owns nothing at all until it clears.
  readonly composerEmpty?: boolean;
}): WorkShellContextInspectorAction {
  // The slash command picker takes priority — never steal keys while the
  // user is typing a `/` command, even if the overlay is visible behind it.
  if (input.value.trim().startsWith("/")) {
    return { type: "none" };
  }
  if (input.panelTitle !== "Context expanded") {
    return { type: "none" };
  }
  // A locally pending draft outranks the whole Pure Yazi ladder — navigation
  // keys get no exemption, because stealing them from a half-typed line is as
  // wrong as stealing the mutation letters.
  if (input.composerEmpty === false) {
    return { type: "none" };
  }
  // Pure Yazi navigation resolves ahead of the mutation letters and ignores
  // the capability flags: walking panes, rows, and preview pages only reads
  // the packet, so it stays live on a read-only desk. `h`/`j`/`k`/`l` match
  // exact case so Shift-letters stay ordinary composer text.
  if (input.key.leftArrow || input.value === "h") {
    return { type: "move-pane", direction: -1 };
  }
  if (input.key.rightArrow || input.value === "l") {
    return { type: "move-pane", direction: 1 };
  }
  if (input.key.upArrow || input.value === "k") {
    return { type: "move-cursor", direction: -1 };
  }
  if (input.key.downArrow || input.value === "j") {
    return { type: "move-cursor", direction: 1 };
  }
  if (input.key.pageUp) {
    return { type: "move-page", direction: -1 };
  }
  if (input.key.pageDown) {
    return { type: "move-page", direction: 1 };
  }
  if (input.key.return) {
    return input.expandActionsEnabled === false ? { type: "none" } : { type: "expand" };
  }
  if (input.value === "p") {
    return (input.pinActionsEnabled ?? input.actionsEnabled)
      ? { type: "toggle-pin" }
      : { type: "none" };
  }
  if (input.value === " ") {
    return (input.deliveryActionsEnabled ?? input.actionsEnabled)
      ? { type: "toggle-delivery" }
      : { type: "none" };
  }
  if (input.value === "u") {
    return input.undoActionsEnabled ? { type: "undo" } : { type: "none" };
  }
  if (input.value === "a") {
    return input.adviceActionsEnabled ? { type: "accept-advice" } : { type: "none" };
  }
  if (input.value === "r") {
    return input.adviceActionsEnabled ? { type: "reject-advice" } : { type: "none" };
  }
  return { type: "none" };
}
