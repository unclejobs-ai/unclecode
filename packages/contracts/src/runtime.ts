export const RUNTIME_MODES = ["local", "docker", "e2b", "openshell"] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_CONTAINER_STATES = ["pending", "running", "exited", "failed", "killed"] as const;

export type RuntimeContainerState = (typeof RUNTIME_CONTAINER_STATES)[number];

export type RuntimeContainer = {
  readonly id: string;
  readonly pid: number | null;
  readonly workdir: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly state: RuntimeContainerState;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly runtimeMode: RuntimeMode;
};

export type RuntimeHealth = {
  readonly healthy: boolean;
  readonly activeContainers: number;
  readonly adapters: ReadonlyArray<{
    readonly mode: RuntimeMode;
    readonly available: boolean;
  }>;
};

export type RuntimeBrokerConfig = {
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly timeoutMs?: number | undefined;
  readonly captureOutput?: boolean | undefined;
  readonly openshell?: OpenShellRuntimeConfig | undefined;
};

export type OpenShellRuntimeConfig = {
  readonly enabled: boolean;
  readonly cliPath?: string | undefined;
  readonly gatewayName?: string | undefined;
  readonly sandboxNamePrefix?: string | undefined;
  readonly sandboxImage?: string | undefined;
  readonly policyPath?: string | undefined;
  readonly providers?: readonly string[] | undefined;
  readonly uploadWorkspace?: boolean | undefined;
  readonly sandboxWorkspace?: string | undefined;
  readonly downloadPaths?: readonly OpenShellDownloadPath[] | undefined;
};

export type OpenShellDownloadPath = {
  readonly sandboxPath: string;
  readonly localPath: string;
};

export type DockerAdapterConfig = RuntimeBrokerConfig & {
  readonly dockerImage: string;
  readonly dockerFlags?: readonly string[] | undefined;
  readonly memoryLimitMb?: number | undefined;
  readonly cpusLimit?: number | undefined;
};

export type RuntimeSpawnRequest = {
  readonly command: string;
  readonly args: readonly string[];
  readonly config: RuntimeBrokerConfig;
};

export type RuntimeEvent = {
  readonly containerId: string;
  readonly type: "spawned" | "stdout" | "stderr" | "exited" | "killed" | "error";
  readonly data?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly timestamp: number;
};
