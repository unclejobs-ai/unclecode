export type TuiRendererId = "ink" | "opentui";
export type TuiRuntimeId = "node" | "bun";
export type TuiRendererStatus = "active" | "blocked";

export type TuiRendererFeatureSet = {
  readonly flexLayout: boolean;
  readonly focusEvents: boolean;
  readonly mouseEvents: boolean;
  readonly bracketedPasteEvents: boolean;
  readonly kittyKeyboardProtocol: boolean;
  readonly memoryRenderer: boolean;
};

export type TuiRendererPlan = {
  readonly renderer: TuiRendererId;
  readonly runtime: TuiRuntimeId;
  readonly status: TuiRendererStatus;
  readonly features: TuiRendererFeatureSet;
  readonly reason?: string;
};

const INK_FEATURES: TuiRendererFeatureSet = {
  flexLayout: true,
  focusEvents: false,
  mouseEvents: false,
  bracketedPasteEvents: false,
  kittyKeyboardProtocol: false,
  memoryRenderer: false,
};

const OPENTUI_FEATURES: TuiRendererFeatureSet = {
  flexLayout: true,
  focusEvents: true,
  mouseEvents: true,
  bracketedPasteEvents: true,
  kittyKeyboardProtocol: true,
  memoryRenderer: true,
};

export function normalizeTuiRendererId(value: string | undefined): TuiRendererId {
  return value?.trim().toLowerCase() === "opentui" ? "opentui" : "ink";
}

export function detectTuiRuntime(): TuiRuntimeId {
  const versions = process.versions as NodeJS.ProcessVersions & { readonly bun?: string };
  const globalWithBun = globalThis as typeof globalThis & { readonly Bun?: unknown };
  return versions.bun || globalWithBun.Bun ? "bun" : "node";
}

export function resolveTuiRendererPlan(input: {
  readonly requestedRenderer?: string | undefined;
  readonly runtime?: TuiRuntimeId | undefined;
  readonly hasOpenTuiPackage?: boolean | undefined;
  readonly hasOpenTuiAdapter?: boolean | undefined;
} = {}): TuiRendererPlan {
  const renderer = normalizeTuiRendererId(input.requestedRenderer ?? process.env.UNCLECODE_TUI_RENDERER);
  const runtime = input.runtime ?? detectTuiRuntime();
  if (renderer === "ink") {
    return {
      renderer,
      runtime,
      status: "active",
      features: INK_FEATURES,
    };
  }

  if (runtime !== "bun") {
    return {
      renderer,
      runtime,
      status: "blocked",
      features: OPENTUI_FEATURES,
      reason: "OpenTUI 0.3 is Bun-only; UncleCode currently launches this TUI through Node/npm.",
    };
  }

  if (!input.hasOpenTuiPackage) {
    return {
      renderer,
      runtime,
      status: "blocked",
      features: OPENTUI_FEATURES,
      reason: "@opentui/react is not installed; keep Ink until the experimental Bun renderer is packaged.",
    };
  }

  if (!input.hasOpenTuiAdapter) {
    return {
      renderer,
      runtime,
      status: "blocked",
      features: OPENTUI_FEATURES,
      reason: "OpenTUI package is available, but the UncleCode renderer adapter is not wired yet.",
    };
  }

  return {
    renderer,
    runtime,
    status: "active",
    features: OPENTUI_FEATURES,
  };
}

export function shouldUseOpenTuiRenderer(plan: TuiRendererPlan): boolean {
  return plan.renderer === "opentui" && plan.status === "active";
}
