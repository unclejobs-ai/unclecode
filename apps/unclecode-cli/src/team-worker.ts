/**
 * Team worker entrypoint — spawned by TeamRunner as a child process and
 * bound to UNCLECODE_TEAM_RUN_ID / UNCLECODE_TEAM_RUN_ROOT via env. Routes
 * the task through the LaneAdapter for the requested runtime (SDK trio,
 * Cursor SDK, Codex CLI, opencode CLI, GLM HTTP, Hermes acpx) and emits
 * the legacy WORKER_ID/PERSONA/SUBMISSION/<marker> envelope on stdout so
 * the runner's classifier stays untouched.
 */

import {
  TeamBinding,
  formatWorkerEnvelope,
  getLaneAdapter,
  getPersonaConfig,
  readBindingFromEnv,
  runRustCommand,
} from "@unclecode/orchestrator";
export { detectProviderForModel } from "@unclecode/providers";
import type { PersonaId, TeamLaneRuntime } from "@unclecode/contracts";
import { isTeamLaneRuntime } from "@unclecode/contracts";
import { DEFAULT_LANE_RUNTIME } from "@unclecode/orchestrator";

export type TeamWorkerOptions = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly task: string;
  readonly runtime: TeamLaneRuntime;
  readonly model?: string;
  readonly extras?: Readonly<Record<string, string>>;
};

export async function handleTeamWorker(options: TeamWorkerOptions): Promise<void> {
  const bindingArgs = readBindingFromEnv();
  if (!bindingArgs) {
    process.stderr.write(
      "team worker: missing UNCLECODE_TEAM_RUN_ID or UNCLECODE_TEAM_RUN_ROOT.\n",
    );
    process.exit(2);
  }

  const runtime = options.runtime ?? DEFAULT_LANE_RUNTIME;
  if (!isTeamLaneRuntime(runtime)) {
    process.stderr.write(`team worker: unknown runtime "${runtime}".\n`);
    process.exit(2);
  }

  const binding = new TeamBinding({ ...bindingArgs, role: "worker" });
  const config = getPersonaConfig(options.persona);

  // Dry-run path used by tests + sandboxed CI: skip the live adapter call
  // AND the Rust sha256 spawn (cold checkouts may not have the binary
  // built). Echo the task back so the envelope shape can be exercised.
  const liveDisabled = process.env.UNCLECODE_TEAM_WORKER_LIVE === "0";
  if (liveDisabled) {
    process.stdout.write(
      `${formatWorkerEnvelope({
        workerId: options.workerId,
        persona: options.persona,
        submission: options.task,
        submitMarker: config.submitMarker,
      })}\n`,
    );
    process.exit(0);
  }

  const emitEnvelope = (submission: string): void => {
    process.stdout.write(
      `${formatWorkerEnvelope({
        workerId: options.workerId,
        persona: options.persona,
        submission,
        submitMarker: config.submitMarker,
      })}\n`,
    );
  };

  // Wrap the entire live path — including the Rust sha256 spawn, initial
  // checkpoint publish, and adapter acquisition — in a single try/catch so
  // any exception still emits the legacy 4-line envelope. Otherwise a
  // pre-adapter throw would leave TeamRunner without a parseable result.
  try {
    const taskHash = (await runRustCommand(["rust", "sha256"], process.cwd(), options.task)).trim();

    binding.publish({
      type: "team_step",
      runId: binding.runId,
      workerId: options.workerId,
      stepIndex: 0,
      action: { tool: "task_received", argHash: taskHash },
      timestamp: new Date().toISOString(),
    });

    const adapter = getLaneAdapter(runtime);
    const runtimeMode = binding.manifest().runtime;
    const spec = {
      workerId: options.workerId,
      persona: options.persona,
      task: options.task,
      runtime,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.extras !== undefined ? { extras: options.extras } : {}),
    };

    const result = await adapter.run(spec, {
      binding,
      cwd: process.cwd(),
      runtimeMode,
      env: process.env,
      systemPrompt: config.systemPrompt,
    });
    emitEnvelope(result.submission);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`team worker: ${reason}\n`);
    emitEnvelope(reason);
    process.exit(1);
  }
}
