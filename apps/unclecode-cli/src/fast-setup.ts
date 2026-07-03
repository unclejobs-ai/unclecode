import { createRuntimeBroker } from "@unclecode/runtime-broker";
import { resolveOpenAIAuthStatus } from "@unclecode/providers/openai-status";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

function getSessionStoreRoot(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_SESSION_STORE_ROOT?.trim() || path.join(homedir(), ".unclecode", "state");
}

function getProjectConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".unclecode", "config.json");
}

export async function buildFastSetupReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  const authStatus = await resolveOpenAIAuthStatus({ env: input.env });
  const runtimeHealth = createRuntimeBroker({
    workingDirectory: input.workspaceRoot,
    runtimeMode: "local",
  }).health();
  const runtimeAdapter = runtimeHealth.adapters.find((adapter) => adapter.mode === "local");
  const sessionStoreRoot = getSessionStoreRoot(input.env);
  await mkdir(sessionStoreRoot, { recursive: true });

  const authReady = authStatus.activeSource !== "none" && !authStatus.isExpired;
  const runtimeReady = runtimeAdapter?.available ?? false;

  return [
    "Setup guide",
    `Workspace: ${input.workspaceRoot}`,
    `Auth: ${authReady ? `ready (${authStatus.activeSource})` : "missing"}`,
    `Runtime: ${runtimeReady ? "local available" : "local unavailable"}`,
    `Session store: ${sessionStoreRoot}`,
    `Project config: ${getProjectConfigPath(input.workspaceRoot)}`,
    "Next steps:",
    authReady
      ? "1. Auth is ready. You can continue with `unclecode doctor` or `unclecode`."
      : "1. Set OPENAI_API_KEY, save API-key credentials with `unclecode auth login --api-key-stdin [--org <id>] [--project <id>]`, or run `OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser` for API-ready OAuth. Existing Codex auth (`~/.codex/auth.json`) may be detected for sign-in, but it is not proof of OpenAI API readiness.",
    "2. Run `unclecode doctor` to verify auth, runtime, session-store, and MCP readiness.",
    "3. Run `unclecode mode status` to confirm the active operating profile before starting work.",
  ].join("\n");
}
