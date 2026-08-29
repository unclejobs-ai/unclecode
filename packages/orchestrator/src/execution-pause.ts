import { AsyncLocalStorage } from "node:async_hooks";

import type { WorkShellPauseBoundary } from "./work-shell-pause-controller.js";

export type ExecutionPauseOperation =
  | "provider.request"
  | "policy.evaluate"
  | "approval.wait"
  | "tool.dispatch";

export type ExecutionPausePort = {
  readonly checkpoint: (boundary: WorkShellPauseBoundary) => Promise<void>;
  readonly runNonInterruptible: <Value>(
    operation: ExecutionPauseOperation,
    run: () => Promise<Value>,
  ) => Promise<Value>;
};

const executionPause = new AsyncLocalStorage<ExecutionPausePort>();

export function withExecutionPausePort<Value>(
  port: ExecutionPausePort | undefined,
  run: () => Promise<Value>,
): Promise<Value> {
  return port ? executionPause.run(port, run) : run();
}

export function checkpointExecutionPause(boundary: WorkShellPauseBoundary): Promise<void> {
  return executionPause.getStore()?.checkpoint(boundary) ?? Promise.resolve();
}

export function runExecutionNonInterruptible<Value>(
  operation: ExecutionPauseOperation,
  run: () => Promise<Value>,
): Promise<Value> {
  return executionPause.getStore()?.runNonInterruptible(operation, run) ?? run();
}
