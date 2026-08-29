import { createSessionStore } from "@unclecode/session-store";

export async function readRestoredSessionRevision(input: {
  readonly rootDir: string;
  readonly projectPath: string;
  readonly sessionId: string;
  readonly resume?: boolean | undefined;
}): Promise<number> {
  if (input.resume !== true) return 0;
  const restored = await createSessionStore({ rootDir: input.rootDir }).resumeSession({
    projectPath: input.projectPath,
    sessionId: input.sessionId,
  });
  const revision = restored.metadata.ownerMutationRevision;
  return Number.isSafeInteger(revision) && Number(revision) >= 0 ? Number(revision) : 0;
}

/** Bind the restored owner clock before initialization can emit a checkpoint. */
export async function initializeRestoredRuntimeEngine(
  engine: {
    readonly initialize: () => Promise<void>;
    readonly bindRuntimeRevisionClock?: ((clock: { readonly value: number }) => void) | undefined;
  },
  restoredRevision: number,
): Promise<{ value: number }> {
  const revisionClock = { value: restoredRevision };
  engine.bindRuntimeRevisionClock?.(revisionClock);
  await engine.initialize();
  return revisionClock;
}
