import type { ChildProcess } from "node:child_process";

export type ProcessGroupProbe = (processGroupId: number) => void;

export async function waitForOwnedProcessGroupExit(input: {
  readonly processGroupId: number | undefined;
  readonly timeoutMs: number;
  readonly label: string;
  readonly probe?: ProcessGroupProbe;
  readonly wait?: (() => Promise<void>) | undefined;
}): Promise<void> {
  if (!input.processGroupId || process.platform === "win32") return;
  const deadline = Date.now() + input.timeoutMs;
  const probe = input.probe ?? ((processGroupId) => process.kill(-processGroupId, 0));
  const wait = input.wait ?? (() => new Promise(resolve => setTimeout(resolve, 10)));
  while (true) {
    try {
      probe(input.processGroupId);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      // Darwin can briefly report EPERM while a killed descendant is still
      // being reaped. It is existence/unknown, never successful settlement.
      if (code !== "EPERM") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${input.label} process group ${input.processGroupId} did not exit after SIGKILL`);
    }
    await wait();
  }
}

export type OwnedProcessGroupController = {
  /** TERM once, then bounded KILL, direct-child close, and PGID ESRCH. */
  terminate(): Promise<void>;
  /** Await normal exit and reap any descendants that outlive the leader. */
  settle(): Promise<void>;
};

export function createOwnedProcessGroupController(input: {
  readonly child: ChildProcess;
  readonly label: string;
  readonly forceKillDelayMs?: number;
  readonly signal?: ((signal: NodeJS.Signals) => void | Promise<void>) | undefined;
}): OwnedProcessGroupController {
  const processGroupId = input.child.pid;
  const forceKillDelayMs = Math.max(0, input.forceKillDelayMs ?? 2_000);
  let childClosed = false;
  const closed = new Promise<void>((resolve) => input.child.once("close", () => {
    childClosed = true;
    resolve();
  }));
  const signal = input.signal ?? ((nextSignal: NodeJS.Signals) => {
    if (!processGroupId) {
      input.child.kill(nextSignal);
      return;
    }
    try {
      process.kill(process.platform === "win32" ? processGroupId : -processGroupId, nextSignal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
  let termination: Promise<void> | undefined;
  const processGroupExists = (): boolean => {
    if (!processGroupId || process.platform === "win32") return !childClosed;
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  };
  const waitForForceBoundary = async (): Promise<void> => {
    const deadline = Date.now() + forceKillDelayMs;
    while (Date.now() < deadline) {
      if (childClosed && !processGroupExists()) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
  };
  const terminate = (): Promise<void> => {
    termination ??= (async () => {
      await signal("SIGTERM");
      await waitForForceBoundary();
      if (!childClosed || processGroupExists()) await signal("SIGKILL");
      await Promise.all([
        closed,
        waitForOwnedProcessGroupExit({
          processGroupId,
          timeoutMs: Math.max(1_000, forceKillDelayMs + 2_000),
          label: input.label,
        }),
      ]);
    })();
    return termination;
  };
  return {
    terminate,
    async settle() {
      if (termination) return termination;
      await closed;
      if (processGroupExists()) await terminate();
    },
  };
}
