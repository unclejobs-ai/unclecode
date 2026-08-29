import { createSessionStore } from "@unclecode/session-store";
import { readRuntimeAdmissionRevision } from "@unclecode/server";

export async function readRestoredSessionRevision(input: {
  readonly rootDir: string;
  readonly projectPath: string;
  readonly sessionId: string;
  readonly resume?: boolean | undefined;
}): Promise<number> {
  if (input.resume !== true) return 0;
  const [restored, admittedRevision] = await Promise.all([
    createSessionStore({ rootDir: input.rootDir }).resumeSession({
      projectPath: input.projectPath,
      sessionId: input.sessionId,
    }),
    readRuntimeAdmissionRevision(input),
  ]);
  const revision = restored.metadata.ownerMutationRevision;
  const checkpointRevision = Number.isSafeInteger(revision) && Number(revision) >= 0 ? Number(revision) : 0;
  return Math.max(checkpointRevision, admittedRevision);
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
