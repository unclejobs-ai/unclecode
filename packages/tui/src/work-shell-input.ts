export type WorkShellInputAction =
  | { readonly type: "none" }
  | { readonly type: "exit" }
  | { readonly type: "complete-slash"; readonly value: string }
  | { readonly type: "move-slash-selection"; readonly direction: "previous" | "next" }
  | { readonly type: "cancel-sensitive-input" }
  | { readonly type: "close-overlay" }
  | { readonly type: "open-sessions-view" }
  | { readonly type: "open-engine-sessions" };

export type WorkShellSubmitAction =
  | { readonly type: "noop" }
  | { readonly type: "submit"; readonly line: string; readonly clearInput: true }
  | { readonly type: "submit-suggestion"; readonly line: string; readonly clearInput: true };

function hasSlashSuggestions(input: string, slashSuggestionCount: number): boolean {
  return input.trim().startsWith("/") && slashSuggestionCount > 0;
}

export function resolveWorkShellInputAction(input: {
  readonly value: string;
  readonly key: {
    readonly ctrl?: boolean;
    readonly tab?: boolean;
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly escape?: boolean;
  };
  readonly input: string;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
  readonly isBusy: boolean;
  readonly hasRequestSessionsView: boolean;
  readonly hasSensitiveInput?: boolean;
  readonly hasOverlayOpen?: boolean;
}): WorkShellInputAction {
  if (input.key.ctrl && input.value === "c") {
    return { type: "exit" };
  }

  if (input.key.tab && hasSlashSuggestions(input.input, input.slashSuggestionCount)) {
    return {
      type: "complete-slash",
      value: `${input.selectedSlashCommand ?? input.input} `,
    };
  }

  if (input.key.upArrow && hasSlashSuggestions(input.input, input.slashSuggestionCount)) {
    return { type: "move-slash-selection", direction: "previous" };
  }

  if (input.key.downArrow && hasSlashSuggestions(input.input, input.slashSuggestionCount)) {
    return { type: "move-slash-selection", direction: "next" };
  }

  if (input.key.escape && !input.isBusy) {
    if (input.hasSensitiveInput) {
      return { type: "cancel-sensitive-input" };
    }
    if (input.hasOverlayOpen) {
      return { type: "close-overlay" };
    }
    return input.hasRequestSessionsView
      ? { type: "open-sessions-view" }
      : { type: "open-engine-sessions" };
  }

  return { type: "none" };
}

export function resolveWorkShellSubmitAction(input: {
  readonly value: string;
  readonly isBusy: boolean;
  readonly shouldBlockSlashSubmit: boolean;
  readonly selectedSlashCommand?: string;
}): WorkShellSubmitAction {
  const line = input.value.trim();
  if (!line || input.isBusy) {
    return { type: "noop" };
  }

  if (input.shouldBlockSlashSubmit) {
    if (!input.selectedSlashCommand) {
      return { type: "noop" };
    }

    return {
      type: "submit-suggestion",
      line: input.selectedSlashCommand,
      clearInput: true,
    };
  }

  return {
    type: "submit",
    line,
    clearInput: true,
  };
}
