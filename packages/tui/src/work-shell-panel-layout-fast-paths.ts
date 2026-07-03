export type WorkShellPanelDisplayMode = "hidden" | "overlay" | "side" | "bottom";
export type WorkShellPanelPlacement = "side" | "bottom";
export type WorkShellPanelAnchor = "with-conversation" | "after-composer";

export type WorkShellPanelLayout = {
  readonly borderColorRole: "user" | "assistant" | "borderStrong" | "border";
  readonly displayMode: WorkShellPanelDisplayMode;
  readonly placement: WorkShellPanelPlacement;
  readonly anchor: WorkShellPanelAnchor;
  readonly bottomDrawerMinHeight: number;
};

export function resolveWorkShellPanelLayoutFast(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly terminalColumns?: number;
  readonly displayMode?: WorkShellPanelDisplayMode;
}): WorkShellPanelLayout {
  const displayMode = input.displayMode ?? resolvePanelDisplayMode(input.panelTitle);
  const placement = displayMode === "side" ? "side" : "bottom";
  return {
    borderColorRole: resolvePanelBorderColorRole(input.inputValue, input.panelTitle),
    displayMode,
    placement,
    anchor: displayMode === "side" ? "with-conversation" : "after-composer",
    bottomDrawerMinHeight: resolveBottomDrawerMinHeight(displayMode, input.panelTitle, input.inputValue),
  };
}

function resolvePanelBorderColorRole(inputValue: string, panelTitle: string): WorkShellPanelLayout["borderColorRole"] {
  if (inputValue.trim().startsWith("/")) {
    return "user";
  }
  if (panelTitle === "Auth") {
    return "assistant";
  }
  if (panelTitle === "Commands" || panelTitle === "Models" || panelTitle === "Model picker") {
    return "borderStrong";
  }
  return "border";
}

function resolvePanelDisplayMode(panelTitle: string): WorkShellPanelDisplayMode {
  if (panelTitle === "Context") {
    return "hidden";
  }
  if (panelTitle === "Context expanded") {
    return "overlay";
  }
  return "bottom";
}

function resolveBottomDrawerMinHeight(
  displayMode: WorkShellPanelDisplayMode,
  panelTitle: string,
  inputValue: string,
): number {
  if (displayMode !== "bottom") {
    return 0;
  }
  if (inputValue.trim().startsWith("/")) {
    return 6;
  }
  return (
    panelTitle === "Commands" ||
    panelTitle === "Auth" ||
    panelTitle === "Models" ||
    panelTitle === "Model picker" ||
    panelTitle === "Session status" ||
    panelTitle === "Doctor" ||
    panelTitle === "Mode" ||
    panelTitle === "MCP"
  ) ? 6 : 0;
}
