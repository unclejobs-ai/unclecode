import { runRustCommand } from "./rust-command.js";

export async function listSessionLines(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  try {
    const stdout = await runRustCommand(["rust", "session", "list"], workspaceRoot, undefined, env);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  } catch {
    return ["No resumable sessions.", "Run work, doctor, or research to create one."];
  }
}

export async function persistWorkShellSessionSnapshot(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId: string;
  readonly model: string;
  readonly mode: string;
  readonly state: "running" | "idle" | "requires_action";
  readonly summary: string;
  readonly traceMode?: "minimal" | "verbose" | undefined;
  readonly reasoningEffort?: "low" | "medium" | "high" | undefined;
}): Promise<void> {
  await runRustCommand(
    [
      "rust",
      "session",
      "persist",
      input.sessionId,
      input.model,
      input.mode,
      input.state,
      input.traceMode ?? "-",
      input.reasoningEffort ?? "-",
    ],
    input.cwd,
    input.summary,
    input.env ?? process.env,
  );
}
