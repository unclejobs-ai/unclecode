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
  return Math.max(restored.checkpoint?.eventCount ?? 0, restored.records.length);
}
