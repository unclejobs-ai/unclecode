import { getProviderAdapter, type ProviderId, type ReasoningSupport } from "@unclecode/providers";

import type { WorkShellPanel } from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

export function resolveModelCommand<Reasoning extends WorkShellReasoningConfig>(
  input: string,
  state: {
    provider: ProviderId;
    currentModel: string;
    currentReasoning: Reasoning;
    modeDefaultReasoning: Reasoning;
  },
): {
  nextModel: string;
  nextReasoning: Reasoning;
  message: string;
  panel: WorkShellPanel;
} {
  const normalized = input.trim().replace(/\s+/g, " ");
  const models = listProviderModels(state.provider, state.currentModel);

  if (normalized === "/model" || normalized === "/model list") {
    return {
      nextModel: state.currentModel,
      nextReasoning: state.currentReasoning,
      message: "Model picker shown.",
      panel: buildModelPanel({
        models,
        currentModel: state.currentModel,
        provider: state.provider,
        currentReasoning: state.currentReasoning,
      }),
    };
  }

  const nextModel = normalized.slice("/model ".length).trim();
  if (!normalized.startsWith("/model ") || nextModel.length === 0) {
    return {
      nextModel: state.currentModel,
      nextReasoning: state.currentReasoning,
      message: "Usage: /model <name>",
      panel: buildModelPanel({
        models,
        currentModel: state.currentModel,
        provider: state.provider,
        currentReasoning: state.currentReasoning,
      }),
    };
  }

  const nextReasoning = resolveReasoningForModel(
    state.provider,
    nextModel,
    state.currentReasoning,
    state.modeDefaultReasoning,
  );

  return {
    nextModel,
    nextReasoning,
    message:
      nextReasoning.support.status === "unsupported"
        ? `Model set to ${nextModel}. Reasoning unsupported.`
        : `Model set to ${nextModel}. Reasoning ${nextReasoning.effort}.`,
    panel: buildModelPanel({
      models: models.includes(nextModel) ? models : [...models, nextModel],
      currentModel: nextModel,
      provider: state.provider,
      currentReasoning: nextReasoning,
    }),
  };
}

function listProviderModels(provider: ProviderId, currentModel: string): readonly string[] {
  try {
    return [...new Set([currentModel, ...getProviderAdapter(provider).getModelRegistry().models])];
  } catch {
    return [currentModel];
  }
}

function formatSupportedEffortList(support: ReasoningSupport): string {
  return support.status === "supported" ? support.supportedEfforts.join(", ") : "unsupported";
}

function formatModelPanelSupportLabel(input: {
  active: boolean;
  support: ReasoningSupport;
}): string {
  if (input.support.status === "unsupported") {
    return input.active ? "Current · Warning · reasoning unsupported" : "Warning · reasoning unsupported";
  }
  const prefix = input.active ? "Current" : "Default";
  return `${prefix} · ${input.support.defaultEffort} · supports ${formatSupportedEffortList(input.support)}`;
}

function buildModelPanel(input: {
  models: readonly string[];
  currentModel: string;
  provider: ProviderId;
  currentReasoning?: WorkShellReasoningConfig;
}): WorkShellPanel {
  const currentSupport = getReasoningSupport(input.provider, input.currentModel);
  return {
    title: "Models",
    lines: [
      "Current",
      `Model · ${input.currentModel}`,
      `Selected · /model ${input.currentModel}`,
      `Reasoning · ${describePanelReasoning(input.currentReasoning, currentSupport)}`,
      `Support · ${formatSupportedEffortList(currentSupport)}`,
      "",
      "Available",
      ...input.models.map((model) => {
        const support = getReasoningSupport(input.provider, model);
        const active = model === input.currentModel;
        return `${active ? "›" : " "} /model ${model}  ${formatModelPanelSupportLabel({ active, support })}`;
      }),
      "",
      "Routes",
      "/model shows this picker.",
      "/model <id> switches now.",
      "/model list shows all model picks.",
    ],
  };
}

function describePanelReasoning(
  reasoning: WorkShellReasoningConfig | undefined,
  support: ReasoningSupport,
): string {
  if (!reasoning) {
    return support.status === "unsupported" ? "unsupported" : `${support.defaultEffort} (mode-default)`;
  }
  if (reasoning.support.status === "unsupported" || reasoning.effort === "unsupported") {
    return "unsupported";
  }
  return `${reasoning.effort} (${reasoning.source})`;
}

function resolveReasoningForModel<Reasoning extends WorkShellReasoningConfig>(
  provider: ProviderId,
  model: string,
  currentReasoning: Reasoning,
  modeDefaultReasoning: Reasoning,
): Reasoning {
  const support = getReasoningSupport(provider, model);
  if (support.status === "unsupported") {
    return {
      ...currentReasoning,
      effort: "unsupported",
      source: "model-capability",
      support,
    };
  }

  const currentEffort =
    currentReasoning.support.status === "supported"
    && (currentReasoning.effort === "low" || currentReasoning.effort === "medium" || currentReasoning.effort === "high")
      ? currentReasoning.effort
      : undefined;
  const canKeepCurrent = currentEffort !== undefined && support.supportedEfforts.includes(currentEffort);
  const nextEffort = canKeepCurrent
    ? currentEffort
    : modeDefaultReasoning.support.status === "supported" && modeDefaultReasoning.effort !== "unsupported"
      ? modeDefaultReasoning.effort
      : support.defaultEffort;
  const nextSource = canKeepCurrent && currentReasoning.source === "override"
    ? "override"
    : "mode-default";

  return {
    ...modeDefaultReasoning,
    effort: nextEffort,
    source: nextSource,
    support,
  };
}

function getReasoningSupport(provider: ProviderId, model: string): ReasoningSupport {
  try {
    return getProviderAdapter(provider).getReasoningSupport({ modelId: model });
  } catch {
    return {
      status: "unsupported",
      supportedEfforts: [],
    };
  }
}
