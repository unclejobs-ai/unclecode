import { runRustCommandSync } from "@unclecode/orchestrator";

const WORK_SHELL_MODE_CYCLE = ["default", "yolo", "ultrawork", "analyze", "search"] as const;

type WorkShellCycleMode = (typeof WORK_SHELL_MODE_CYCLE)[number];

export type ContextDeskPane = "sources" | "preview" | "details";

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
 * Pure Context Desk keyboard decision. Context owns these keys before both
 * the composer and slash picker while the desk is open.
 */
export type WorkShellContextInspectorAction =
  | { readonly type: "none" }
  | { readonly type: "move-source"; readonly direction: -1 | 1 }
  | { readonly type: "move-preview"; readonly direction: -1 | 1 }
  | { readonly type: "move-details"; readonly direction: -1 | 1 }
  | { readonly type: "cycle-pane" }
  | { readonly type: "enter" }
  | { readonly type: "close" }
  | { readonly type: "consume" }
  | { readonly type: "toggle-pin" }
  | { readonly type: "toggle-delivery" }
  | { readonly type: "accept-advice" }
  | { readonly type: "reject-advice" };

export function resolveWorkShellContextInspectorAction(input: {
  readonly value: string;
  readonly key: {
    readonly upArrow?: boolean | undefined;
    readonly downArrow?: boolean | undefined;
    readonly return?: boolean | undefined;
    readonly escape?: boolean | undefined;
    readonly tab?: boolean | undefined;
  };
  readonly panelTitle?: string | undefined;
  readonly pane?: ContextDeskPane | undefined;
  readonly actionsEnabled?: boolean | undefined;
  readonly adviceActionsEnabled?: boolean | undefined;
}): WorkShellContextInspectorAction {
  if (input.panelTitle !== "Context expanded") {
    return { type: "none" };
  }
  if (input.key.escape) {
    return { type: "close" };
  }
  if (input.key.tab) {
    return { type: "cycle-pane" };
  }
  const direction = input.key.upArrow ? -1 : input.key.downArrow ? 1 : 0;
  if (direction !== 0) {
    switch (input.pane ?? "sources") {
      case "preview":
        return { type: "move-preview", direction };
      case "details":
        return { type: "move-details", direction };
      case "sources":
        return { type: "move-source", direction };
    }
  }
  if (input.key.return) {
    return { type: "enter" };
  }
  if (input.value === "p") {
    return input.actionsEnabled ? { type: "toggle-pin" } : { type: "consume" };
  }
  if (input.value === " ") {
    return input.actionsEnabled ? { type: "toggle-delivery" } : { type: "consume" };
  }
  if (input.value.toLowerCase() === "a") {
    return input.adviceActionsEnabled ? { type: "accept-advice" } : { type: "consume" };
  }
  if (input.value.toLowerCase() === "r") {
    return input.adviceActionsEnabled ? { type: "reject-advice" } : { type: "consume" };
  }
  return { type: "none" };
}
