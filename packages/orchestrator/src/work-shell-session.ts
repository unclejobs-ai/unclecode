import { runRustCommand } from "./rust-command.js";
import {
  createAgentConsoleSnapshot,
  type AgentConsoleSnapshot,
  type ModeReasoningEffort,
} from "@unclecode/contracts";

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
  readonly reasoningEffort?: ModeReasoningEffort | undefined;
  readonly lastSubmittedContextReceiptId?: string | undefined;
  readonly entries?: readonly { readonly role: "system" | "user" | "assistant" | "tool"; readonly text: string }[] | undefined;
  readonly agentConsole?: AgentConsoleSnapshot | undefined;
}): Promise<void> {
  await runRustCommand(
    ["rust", "session", "persist-json"],
    input.cwd,
    JSON.stringify({
      sessionId: input.sessionId,
      model: input.model,
      mode: input.mode,
      state: input.state,
      summary: input.summary,
      traceMode: input.traceMode,
      reasoningEffort: input.reasoningEffort,
      lastSubmittedContextReceiptId: input.lastSubmittedContextReceiptId,
      entries: input.entries ?? [],
      ...(input.agentConsole
        ? { agentConsole: createAgentConsoleSnapshot(input.agentConsole) }
        : {}),
    }),
    input.env ?? process.env,
  );
}
