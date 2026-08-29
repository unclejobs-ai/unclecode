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
