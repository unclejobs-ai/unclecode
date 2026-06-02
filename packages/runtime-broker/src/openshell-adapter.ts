import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  OpenShellRuntimeConfig,
  RuntimeContainer,
  RuntimeContainerState,
  RuntimeEvent,
  RuntimeHealth,
} from "@unclecode/contracts";
import { emitRuntimeEvent } from "./events.js";
import { RuntimeBrokerError } from "./errors.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SANDBOX_WORKSPACE = "/sandbox/unclecode";

interface MutableContainer {
  id: string;
  pid: number | null;
  workdir: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  state: RuntimeContainerState;
  startedAt: number;
  finishedAt: number | null;
  runtimeMode: "openshell";
  sandboxName: string;
}

type ExecFileFailure = Error & {
  readonly code?: number | string | null | undefined;
  readonly stdout?: Buffer | string | undefined;
  readonly stderr?: Buffer | string | undefined;
};

export type OpenShellAdapterConfig = OpenShellRuntimeConfig & {
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly captureOutput?: boolean | undefined;
};

function toRuntimeContainer(m: MutableContainer): RuntimeContainer {
  return {
    id: m.id,
    pid: m.pid,
    workdir: m.workdir,
    stdout: m.stdout,
    stderr: m.stderr,
    exitCode: m.exitCode,
    state: m.state,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    runtimeMode: m.runtimeMode,
  };
}

function joinOutput(chunks: ReadonlyArray<Buffer | string>): string {
  return chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : chunk.toString()))
    .join("");
}

function outputText(value: Buffer | string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : value.toString();
}

function failureDetails(error: ExecFileFailure): string {
  const stderr = outputText(error.stderr).trim();
  if (stderr.length > 0) {
    return stderr;
  }
  const stdout = outputText(error.stdout).trim();
  if (stdout.length > 0) {
    return stdout;
  }
  return error.message;
}

export class OpenShellAdapter {
  private readonly containers = new Map<string, MutableContainer>();
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private cliAvailable: boolean | null = null;
  private gatewaySelected: boolean | null = null;

  constructor(private readonly config: OpenShellAdapterConfig) {}

  onEvent(listener: (event: RuntimeEvent) => void): void {
    this.eventListeners.add(listener);
  }

  removeEventListener(listener: (event: RuntimeEvent) => void): void {
    this.eventListeners.delete(listener);
  }

  async spawn(command: string, args: readonly string[]): Promise<RuntimeContainer> {
    if (!this.config.enabled) {
      throw new RuntimeBrokerError(
        "OpenShell adapter is not enabled.",
        "ADAPTER_UNAVAILABLE",
      );
    }
    if (!this.config.gatewayName || this.config.gatewayName.trim().length === 0) {
      throw new RuntimeBrokerError(
        "OpenShell gateway is not configured.",
        "ADAPTER_UNAVAILABLE",
      );
    }
    if (!(await this.isCliAvailable())) {
      throw new RuntimeBrokerError(
        "OpenShell CLI is not available. Install `openshell` and configure a gateway.",
        "ADAPTER_UNAVAILABLE",
      );
    }
    await this.selectGateway();

    const sandboxName = this.createSandboxName();
    const containerId = `openshell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sandboxWorkspace =
      this.config.sandboxWorkspace ?? DEFAULT_SANDBOX_WORKSPACE;
    const container: MutableContainer = {
      id: containerId,
      pid: null,
      workdir: sandboxWorkspace,
      stdout: "",
      stderr: "",
      exitCode: null,
      state: "pending",
      startedAt: Date.now(),
      finishedAt: null,
      runtimeMode: "openshell",
      sandboxName,
    };

    this.containers.set(containerId, container);

    try {
      await this.runLifecycleCommand("create sandbox", this.createSandboxArgs(sandboxName));

      if (this.config.uploadWorkspace === true) {
        await this.runLifecycleCommand("upload workspace", [
          "sandbox",
          "upload",
          sandboxName,
          ".",
          sandboxWorkspace,
        ]);
      }

      return await this.executeSandboxCommand(
        container,
        command,
        args,
        sandboxWorkspace,
      );
    } catch (error) {
      container.state = "failed";
      container.finishedAt = Date.now();
      container.stderr = error instanceof Error ? error.message : String(error);
      this.containers.set(containerId, container);
      emitRuntimeEvent(this.eventListeners, {
        containerId,
        type: "error",
        data: container.stderr,
        timestamp: Date.now(),
      });
      throw error;
    } finally {
      await this.deleteSandbox(containerId, sandboxName);
    }
  }

  kill(containerId: string): void {
    const container = this.containers.get(containerId);
    if (container === undefined) {
      return;
    }
    container.state = "killed";
    container.finishedAt = container.finishedAt ?? Date.now();
    this.containers.set(containerId, container);
    emitRuntimeEvent(this.eventListeners, {
      containerId,
      type: "killed",
      exitCode: container.exitCode,
      timestamp: Date.now(),
    });
    void this.deleteSandbox(containerId, container.sandboxName);
  }

  health(): RuntimeHealth {
    const available = this.cliAvailable === true && this.gatewaySelected !== false;
    return {
      healthy: available,
      activeContainers: [...this.containers.values()].filter((container) =>
        container.state === "pending" || container.state === "running"
      ).length,
      adapters: [
        { mode: "openshell" as const, available },
      ],
    };
  }

  private async isCliAvailable(): Promise<boolean> {
    if (this.cliAvailable !== null) {
      return this.cliAvailable;
    }
    try {
      await this.runCli(["--help"], 5000);
      this.cliAvailable = true;
    } catch {
      this.cliAvailable = false;
    }
    return this.cliAvailable;
  }

  private async selectGateway(): Promise<void> {
    if (this.gatewaySelected === true) {
      return;
    }
    try {
      await this.runCli(["gateway", "select", this.config.gatewayName ?? ""], 5000);
      this.gatewaySelected = true;
    } catch (error) {
      this.gatewaySelected = false;
      throw new RuntimeBrokerError(
        "OpenShell gateway is not available or could not be selected.",
        "ADAPTER_UNAVAILABLE",
        error instanceof Error ? error : undefined,
      );
    }
  }

  private createSandboxName(): string {
    const prefix = this.config.sandboxNamePrefix ?? "unclecode";
    const nonce = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now()}-${nonce}`;
  }

  private createSandboxArgs(sandboxName: string): string[] {
    const createArgs = ["sandbox", "create", "--name", sandboxName];
    if (this.config.sandboxImage !== undefined) {
      createArgs.push("--from", this.config.sandboxImage);
    }
    if (this.config.policyPath !== undefined) {
      createArgs.push("--policy", this.config.policyPath);
    }
    for (const provider of this.config.providers ?? []) {
      createArgs.push("--provider", provider);
    }
    return createArgs;
  }

  private async executeSandboxCommand(
    container: MutableContainer,
    command: string,
    args: readonly string[],
    sandboxWorkspace: string,
  ): Promise<RuntimeContainer> {
    const execArgs = [
      "sandbox",
      "exec",
      "-n",
      container.sandboxName,
      "--workdir",
      sandboxWorkspace,
      "--timeout",
      String(Math.max(1, Math.ceil((this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))),
      "--",
      command,
      ...args,
    ];
    const captureOutput = this.config.captureOutput ?? true;

    emitRuntimeEvent(this.eventListeners, {
      containerId: container.id,
      type: "spawned",
      timestamp: Date.now(),
    });

    return new Promise<RuntimeContainer>((resolve, reject) => {
      const stdoutChunks: Array<Buffer | string> = [];
      const stderrChunks: Array<Buffer | string> = [];
      let settled = false;

      const child = execFile(this.config.cliPath ?? "openshell", execArgs, {
        cwd: this.config.workingDirectory,
        env: this.env(),
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      container.state = "running";
      container.pid = child.pid ?? null;
      this.containers.set(container.id, container);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutChunks.push(chunk);
        if (captureOutput) {
          emitRuntimeEvent(this.eventListeners, {
            containerId: container.id,
            type: "stdout",
            data: typeof chunk === "string" ? chunk : chunk.toString(),
            timestamp: Date.now(),
          });
        }
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(chunk);
        if (captureOutput) {
          emitRuntimeEvent(this.eventListeners, {
            containerId: container.id,
            type: "stderr",
            data: typeof chunk === "string" ? chunk : chunk.toString(),
            timestamp: Date.now(),
          });
        }
      });

      child.on("close", async (code: number | null) => {
        if (settled) return;
        settled = true;
        container.exitCode = code;
        container.state = code === 0 ? "exited" : "failed";
        container.finishedAt = Date.now();
        container.stdout = joinOutput(stdoutChunks);
        container.stderr = joinOutput(stderrChunks);
        this.containers.set(container.id, container);

        if (code === 0) {
          try {
            await this.downloadConfiguredPaths(container.sandboxName);
          } catch (error) {
            container.state = "failed";
            container.stderr += `\n${error instanceof Error ? error.message : String(error)}`;
            this.containers.set(container.id, container);
            emitRuntimeEvent(this.eventListeners, {
              containerId: container.id,
              type: "error",
              data: container.stderr,
              exitCode: code,
              timestamp: Date.now(),
            });
            resolve(toRuntimeContainer(container));
            return;
          }
        }

        emitRuntimeEvent(this.eventListeners, {
          containerId: container.id,
          type: code === 0 ? "exited" : "error",
          exitCode: code,
          timestamp: Date.now(),
        });
        resolve(toRuntimeContainer(container));
      });

      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        container.state = "failed";
        container.finishedAt = Date.now();
        container.stderr = err.message;
        container.stdout = joinOutput(stdoutChunks);
        this.containers.set(container.id, container);
        emitRuntimeEvent(this.eventListeners, {
          containerId: container.id,
          type: "error",
          data: err.message,
          timestamp: Date.now(),
        });
        reject(
          new RuntimeBrokerError(
            `OpenShell exec failed: ${err.message}`,
            "SPAWN_FAILED",
            err,
          ),
        );
      });
    });
  }

  private async downloadConfiguredPaths(sandboxName: string): Promise<void> {
    for (const download of this.config.downloadPaths ?? []) {
      await this.runLifecycleCommand("download workspace path", [
        "sandbox",
        "download",
        sandboxName,
        download.sandboxPath,
        download.localPath,
      ]);
    }
  }

  private async deleteSandbox(
    containerId: string,
    sandboxName: string,
  ): Promise<void> {
    try {
      await this.runCli(["sandbox", "delete", sandboxName], 5000);
    } catch (error) {
      emitRuntimeEvent(this.eventListeners, {
        containerId,
        type: "error",
        data: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
    }
  }

  private async runLifecycleCommand(
    action: string,
    args: readonly string[],
  ): Promise<void> {
    try {
      await this.runCli(args, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (error) {
      const failure = error as ExecFileFailure;
      throw new RuntimeBrokerError(
        `OpenShell ${action} failed: ${failureDetails(failure)}`,
        "SPAWN_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async runCli(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<void> {
    await execFileAsync(this.config.cliPath ?? "openshell", [...args], {
      cwd: this.config.workingDirectory,
      env: this.env(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.config.environment ?? {}),
    };
  }
}
