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
