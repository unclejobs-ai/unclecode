import { runRustCommandSync } from "@unclecode/orchestrator";

const WORK_SHELL_MODE_CYCLE = ["default", "yolo", "ultrawork", "analyze", "search"] as const;

type WorkShellCycleMode = (typeof WORK_SHELL_MODE_CYCLE)[number];

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
  | { readonly type: "open-sessions-view" }
  | { readonly type: "open-engine-sessions" };

export type WorkShellSubmitAction =
  | { readonly type: "noop" }
  | { readonly type: "replace-input"; readonly value: string }
  | { readonly type: "submit"; readonly line: string; readonly clearInput: true }
  | { readonly type: "submit-suggestion"; readonly line: string; readonly clearInput: true };

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

  return JSON.parse(
    runRustCommandSync(["rust", "ux", "input-action"], process.cwd(), JSON.stringify(input)),
  ) as WorkShellInputAction;
}

export function resolveWorkShellSubmitAction(input: {
  readonly value: string;
  readonly isBusy: boolean;
  readonly shouldBlockSlashSubmit: boolean;
  readonly selectedSlashCommand?: string;
  readonly activePanelTitle?: string;
}): WorkShellSubmitAction {
  return JSON.parse(
    runRustCommandSync(["rust", "ux", "submit-action"], process.cwd(), JSON.stringify(input)),
  ) as WorkShellSubmitAction;
}

/**
 * Context Inspector (Sprint 2) — keyboard action resolver for the /context
 * overlay. Pure TS (no Rust): the decision is a handful of key comparisons
 * and does not need the ux contract's state machine. Kept here next to the
 * other resolvers so the input-handling seam stays in one file.
 *
 * Fires ONLY when the context overlay is the active panel. The slash command
 * picker always wins: when the composer input starts with `/`, every key
 * returns `"none"` so the picker keeps typing/navigation.
 */
export type WorkShellContextInspectorAction =
  | { readonly type: "none" }
  | { readonly type: "move-cursor"; readonly direction: -1 | 1 }
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
    readonly return?: boolean;
  };
  readonly panelTitle: string;
  readonly actionsEnabled?: boolean;
  readonly adviceActionsEnabled?: boolean;
  readonly undoActionsEnabled?: boolean;
}): WorkShellContextInspectorAction {
  // The slash command picker takes priority — never steal keys while the
  // user is typing a `/` command, even if the overlay is visible behind it.
  if (input.value.trim().startsWith("/")) {
    return { type: "none" };
  }
  if (input.panelTitle !== "Context expanded") {
    return { type: "none" };
  }
  if (input.key.upArrow) {
    return { type: "move-cursor", direction: -1 };
  }
  if (input.key.downArrow) {
    return { type: "move-cursor", direction: 1 };
  }
  if (input.key.return) {
    return { type: "expand" };
  }
  if (input.value === "p") {
    return input.actionsEnabled ? { type: "toggle-pin" } : { type: "none" };
  }
  if (input.value === " ") {
    return input.actionsEnabled ? { type: "toggle-delivery" } : { type: "none" };
  }
  if (input.value.toLowerCase() === "u") {
    return input.undoActionsEnabled ? { type: "undo" } : { type: "none" };
  }
  if (input.value.toLowerCase() === "a") {
    return input.adviceActionsEnabled ? { type: "accept-advice" } : { type: "none" };
  }
  if (input.value.toLowerCase() === "r") {
    return input.adviceActionsEnabled ? { type: "reject-advice" } : { type: "none" };
  }
  return { type: "none" };
}
