import { createSessionCenterDashboardRenderOptions } from "@unclecode/tui";
import { runRustCommandPassthrough } from "@unclecode/orchestrator";
import type {
  SessionCenterLaunchInput,
  SharedBootstrapDependencies,
} from "./interactive-launch-inputs.js";
import {
  createEmbeddedWorkPaneLoadInput,
  createSessionCenterEnvironment,
  loadSessionCenterRenderInput,
  resolveSessionCenterDependencies,
  type TuiHomeState,
} from "./session-center-bootstrap.js";
import {
  launchWorkEntrypoint,
  loadEmbeddedWorkPane,
  withWorkCwd,
} from "./work-bootstrap.js";

export async function launchSessionCenter(
  input: SessionCenterLaunchInput = {},
  deps?: SharedBootstrapDependencies,
): Promise<void> {
  const { workspaceRoot, env, userHomeDir } =
    createSessionCenterEnvironment(input);
  const { buildHomeState, renderShell, runAction, runSession } =
    await resolveSessionCenterDependencies(deps);
  const renderInput = await loadSessionCenterRenderInput({
    workspaceRoot,
    env,
    ...(userHomeDir ? { userHomeDir } : {}),
    ...(input.initialSelectedSessionId !== undefined
      ? { initialSelectedSessionId: input.initialSelectedSessionId }
      : {}),
    ...(input.contextLines ? { contextLines: input.contextLines } : {}),
    buildHomeState,
    runAction,
    runSession,
    loadEmbeddedWorkPane: () =>
      deps?.loadWorkModule
        ? loadEmbeddedWorkPane(
            createEmbeddedWorkPaneLoadInput({
              workspaceRoot,
              ...(input.initialSelectedSessionId !== undefined
                ? { initialSelectedSessionId: input.initialSelectedSessionId }
                : {}),
              loadWorkModule: deps.loadWorkModule,
            }),
          )
        : Promise.resolve(undefined),
    launchWorkSession: (forwardedArgs = []) =>
      deps?.loadWorkModule
        ? launchWorkEntrypoint(forwardedArgs, {
            callerCwd: workspaceRoot,
            loadModule: deps.loadWorkModule,
          })
        : runRustCommandPassthrough(
            ["work", ...withWorkCwd(forwardedArgs, workspaceRoot)],
            workspaceRoot,
            env,
          ).then(() => undefined),
  });

  await renderShell(
    createSessionCenterDashboardRenderOptions<TuiHomeState>(renderInput),
  );
}
