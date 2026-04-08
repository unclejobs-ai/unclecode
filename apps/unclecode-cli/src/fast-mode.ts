import {
  explainUncleCodeConfig,
  formatUncleCodeConfigExplanation,
} from "@unclecode/config-core";
import { loadExtensionConfigOverlays } from "@unclecode/orchestrator/extension-registry";

export function buildFastModeStatusReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  const explanation = explainUncleCodeConfig({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot: input.workspaceRoot,
      ...(input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
    }),
  });

  return [
    `Active mode: ${explanation.activeMode.id}`,
    `Label: ${explanation.activeMode.label}`,
    `Source: ${explanation.settings.mode.winner.sourceLabel}`,
    `Editing: ${explanation.activeMode.editing}`,
    `Search depth: ${explanation.activeMode.searchDepth}`,
    `Background tasks: ${explanation.activeMode.backgroundTasks}`,
    `Explanation style: ${explanation.activeMode.explanationStyle}`,
  ].join("\n");
}

export function buildFastConfigExplainReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  return formatUncleCodeConfigExplanation(
    explainUncleCodeConfig({
      workspaceRoot: input.workspaceRoot,
      env: input.env,
      pluginOverlays: loadExtensionConfigOverlays({
        workspaceRoot: input.workspaceRoot,
        ...(input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
      }),
    }),
  );
}
