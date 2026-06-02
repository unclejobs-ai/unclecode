import type {
  RuntimeBrokerConfig,
  RuntimeContainer,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeMode,
  RuntimeSpawnRequest,
} from "@unclecode/contracts";
import { RUNTIME_MODES } from "@unclecode/contracts";
import { RuntimeBrokerError } from "./errors.js";
import { DockerAdapter } from "./docker-adapter.js";
import { LocalAdapter } from "./local-adapter.js";
import { OpenShellAdapter } from "./openshell-adapter.js";
import type { LocalAdapterConfig } from "./local-adapter.js";
import type { DockerAdapterConfig } from "./types.js";

export type { LocalAdapterConfig } from "./local-adapter.js";
export type { OpenShellAdapterConfig } from "./openshell-adapter.js";
export type { DockerAdapterConfig } from "./types.js";
export { RuntimeBrokerError } from "./errors.js";
export type { RuntimeBrokerErrorCode } from "./errors.js";
export const RUNTIME_BROKER_SUPPORTED_MODES = RUNTIME_MODES;

export interface RuntimeBroker {
  onEvent(listener: (event: RuntimeEvent) => void): void;
  removeEventListener(listener: (event: RuntimeEvent) => void): void;
  spawn(request: RuntimeSpawnRequest): Promise<RuntimeContainer>;
  kill(containerId: string): void;
  health(): RuntimeHealth;
}

export function createRuntimeBroker(
  config: RuntimeBrokerConfig,
): RuntimeBroker {
  const activeMode: RuntimeMode = config.runtimeMode ?? "local";

  const localAdapter = new LocalAdapter({
    workingDirectory: config.workingDirectory,
    environment: config.environment,
    timeoutMs: config.timeoutMs,
    captureOutput: config.captureOutput,
  });

  let dockerAdapter: DockerAdapter | null = null;
  const openshellAdapter = config.openshell?.enabled
    ? new OpenShellAdapter({
        ...config.openshell,
        workingDirectory: config.workingDirectory,
        environment: config.environment,
        timeoutMs: config.timeoutMs,
        captureOutput: config.captureOutput,
      })
    : null;

  function getOrCreateDockerAdapter(): DockerAdapter {
    if (dockerAdapter === null) {
      dockerAdapter = new DockerAdapter({
        dockerImage: "ubuntu:22.04",
        workingDirectory: config.workingDirectory,
        environment: config.environment,
        timeoutMs: config.timeoutMs,
        captureOutput: config.captureOutput,
        dockerFlags: [],
      });
    }
    return dockerAdapter;
  }

  return {
    onEvent(listener: (event: RuntimeEvent) => void): void {
      localAdapter.onEvent(listener);
      if (dockerAdapter !== null) {
        dockerAdapter.onEvent(listener);
      }
      if (openshellAdapter !== null) {
        openshellAdapter.onEvent(listener);
      }
    },

    removeEventListener(listener: (event: RuntimeEvent) => void): void {
      localAdapter.removeEventListener(listener);
      if (dockerAdapter !== null) {
        dockerAdapter.removeEventListener(listener);
      }
      if (openshellAdapter !== null) {
        openshellAdapter.removeEventListener(listener);
      }
    },

    async spawn(request: RuntimeSpawnRequest): Promise<RuntimeContainer> {
      const mode = request.config.runtimeMode ?? activeMode;

      if (mode === "local") {
        return localAdapter.spawn(request.command, request.args);
      }

      if (mode === "docker") {
        const adapter = getOrCreateDockerAdapter();
        return adapter.spawn(request.command, request.args);
      }

      if (mode === "openshell" && openshellAdapter !== null) {
        return openshellAdapter.spawn(request.command, request.args);
      }

      throw new RuntimeBrokerError(
        `Runtime mode "${mode}" is not yet supported`,
        "ADAPTER_UNAVAILABLE",
      );
    },

    kill(containerId: string): void {
      localAdapter.kill(containerId);
      if (dockerAdapter !== null) {
        dockerAdapter.kill(containerId);
      }
      if (openshellAdapter !== null) {
        openshellAdapter.kill(containerId);
      }
    },

    health(): RuntimeHealth {
      const localHealth = localAdapter.health();
      if (dockerAdapter !== null || openshellAdapter !== null) {
        const dockerHealth = dockerAdapter?.health();
        const openshellHealth = openshellAdapter?.health();
        return {
          healthy: [
            localHealth,
            dockerHealth,
            openshellHealth,
          ].filter((health): health is RuntimeHealth => health !== undefined)
            .every((health) => health.healthy),
          activeContainers:
            localHealth.activeContainers
            + (dockerHealth?.activeContainers ?? 0)
            + (openshellHealth?.activeContainers ?? 0),
          adapters: [
            ...localHealth.adapters,
            ...(dockerHealth?.adapters ?? []),
            ...(openshellHealth?.adapters ?? []),
          ],
        };
      }
      return localHealth;
    },
  };
}
