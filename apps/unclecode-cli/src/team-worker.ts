import { createHash } from "node:crypto";

import {
  TeamBinding,
  getPersonaConfig,
  readBindingFromEnv,
} from "@unclecode/orchestrator";
import type { PersonaId } from "@unclecode/contracts";

export type TeamWorkerOptions = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly task: string;
};

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

  process.stdout.write(`WORKER_ID=${options.workerId}\n`);
  process.stdout.write(`PERSONA=${options.persona}\n`);
  process.stdout.write(`SUBMISSION:${truncate(options.task, 4096)}\n`);
  process.stdout.write(`${config.submitMarker}\n`);
  process.exit(0);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
