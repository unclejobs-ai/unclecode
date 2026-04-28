import { createHash } from "node:crypto";

import {
  OpenAIProvider,
  TeamBinding,
  getPersonaConfig,
  readBindingFromEnv,
  runTeamMiniLoop,
} from "@unclecode/orchestrator";
import type { PersonaId } from "@unclecode/contracts";

export type TeamWorkerOptions = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly task: string;
};

const DEFAULT_TEAM_WORKER_MODEL = "gpt-4.1-mini";

export async function handleTeamWorker(options: TeamWorkerOptions): Promise<void> {
  const bindingArgs = readBindingFromEnv();
  if (!bindingArgs) {
    process.stderr.write(
      "team worker: missing UNCLECODE_TEAM_RUN_ID or UNCLECODE_TEAM_RUN_ROOT.\n",
    );
    process.exit(2);
  }

  const binding = new TeamBinding({ ...bindingArgs, role: "worker" });
  const config = getPersonaConfig(options.persona);
  const taskHash = createHash("sha256").update(options.task).digest("hex");

  binding.publish({
    type: "team_step",
    runId: binding.runId,
    workerId: options.workerId,
    stepIndex: 0,
    action: { tool: "task_received", argHash: taskHash },
    timestamp: new Date().toISOString(),
  });

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const liveDisabled = process.env.UNCLECODE_TEAM_WORKER_LIVE === "0";

  if (!apiKey || liveDisabled) {
    process.stdout.write(`WORKER_ID=${options.workerId}\n`);
    process.stdout.write(`PERSONA=${options.persona}\n`);
    process.stdout.write(`SUBMISSION:${truncate(options.task, 4096)}\n`);
    process.stdout.write(`${config.submitMarker}\n`);
    process.exit(0);
    return;
  }

  const model = process.env.UNCLECODE_TEAM_WORKER_MODEL?.trim() || DEFAULT_TEAM_WORKER_MODEL;
  const provider = new OpenAIProvider({
    apiKey,
    model,
    cwd: process.cwd(),
    reasoning: {
      effort: "unsupported",
      source: "model-capability",
      support: { status: "unsupported", supportedEfforts: [] },
    },
    systemPrompt: config.systemPrompt,
  });

  const result = await runTeamMiniLoop({
    workerId: options.workerId,
    persona: options.persona,
    task: options.task,
    binding,
    provider,
    cwd: process.cwd(),
  });

  process.stdout.write(`WORKER_ID=${options.workerId}\n`);
  process.stdout.write(`PERSONA=${options.persona}\n`);
  process.stdout.write(`SUBMISSION:${truncate(result.submission, 4096)}\n`);
  process.stdout.write(`${config.submitMarker}\n`);
  process.exit(result.status === "submitted" ? 0 : 1);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
