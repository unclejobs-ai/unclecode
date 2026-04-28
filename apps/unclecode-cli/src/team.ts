/**
 * `unclecode team` subcommand surface — record/list/inspect/abort runs and
 * dispatch worker child processes via TeamRunner.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  generateRunIdForCli,
  listTeamRuns,
  startTeamRun,
} from "@unclecode/orchestrator";
import {
  PERSONA_IDS,
  TEAM_GATE_LEVELS,
  TEAM_RUNTIME_MODES,
} from "@unclecode/contracts";
import type { PersonaId, TeamGateLevel, TeamRuntimeMode } from "@unclecode/contracts";
import {
  appendTeamCheckpoint,
  getRunStatusFromCheckpoints,
  readTeamCheckpoints,
  readTeamRunManifest,
  verifyTeamRunChain,
} from "@unclecode/session-store";

const DEFAULT_DATA_ROOT_RELATIVE = ".data";

type RunOptions = {
  readonly persona?: string;
  readonly lanes?: string;
  readonly gate?: string;
  readonly runtime?: string;
  readonly record?: string;
  readonly dispatch?: boolean;
  readonly workerTimeout?: string;
  readonly quiet?: boolean;
};

export async function handleTeamRun(objective: string[], options: RunOptions): Promise<void> {
  if (objective.length === 0) {
    throw new Error("`unclecode team run` requires an objective string.");
  }
  const persona = parsePersona(options.persona ?? "coder");
  const gate = parseGate(options.gate ?? "strict");
  const runtime = parseRuntime(options.runtime ?? "local");
  const lanes = parseLanes(options.lanes ?? "1");
  const dataRoot = resolveDataRoot();
  const runId = options.record?.trim() || generateRunIdForCli();

  const handle = startTeamRun({
    dataRoot,
    runId,
    objective: objective.join(" "),
    persona,
    lanes,
    gate,
    runtime,
    workspaceRoot: process.cwd(),
    createdBy: process.env.USER ?? "unclecode-cli",
  });
  handle.start();

  if (options.quiet) {
    process.stdout.write(`${handle.runId}\n`);
  } else {
    process.stdout.write(`RUN_ID=${handle.runId}\n`);
    process.stdout.write(`RUN_ROOT=${handle.runRoot}\n`);
    process.stdout.write(`persona=${persona} lanes=${lanes} gate=${gate} runtime=${runtime}\n`);
  }

  if (!options.dispatch) {
    handle.release();
    return;
  }

  try {
    const cliEntry = resolveCliEntry();
    const workers = Array.from({ length: lanes }, (_, idx) => ({
      workerId: `w${idx + 1}`,
      persona,
      task: objective.join(" "),
    }));
    const timeoutMs = parseTimeout(options.workerTimeout ?? "600000");

    if (!options.quiet) {
      process.stdout.write(`Dispatching ${lanes} worker(s)…\n`);
    }
    const result = await handle.dispatch({
      workerCommand: { command: process.execPath, args: [cliEntry, "team", "worker"] },
      workers,
      perWorkerTimeoutMs: timeoutMs,
      ...(options.quiet
        ? {}
        : {
            onStdout: (id: string, line: string) =>
              void process.stdout.write(`[${id}] ${line}\n`),
            onStderr: (id: string, line: string) =>
              void process.stderr.write(`[${id}!] ${line}\n`),
          }),
    });

    if (!options.quiet) {
      process.stdout.write(`Final status: ${result.status}\n`);
      for (const outcome of result.outcomes) {
        process.stdout.write(
          `  ${outcome.workerId} ${outcome.persona.padEnd(22)} ${outcome.status.padEnd(9)} exit=${outcome.exitCode} ${outcome.durationMs}ms\n`,
        );
      }
      if (result.sweep.swept > 0) {
        process.stdout.write(`Stale lock sweep: removed=${result.sweep.swept} live=${result.sweep.live}\n`);
      }
    }

    if (result.status !== "accepted") {
      process.exitCode = 1;
    }
  } finally {
    handle.release();
  }
}

function resolveCliEntry(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("team run --dispatch: cannot resolve CLI entrypoint from process.argv[1].");
  }
  return argv1;
}

function parseTimeout(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --worker-timeout "${value}". Expected non-negative integer ms.`);
  }
  return parsed;
}

export function handleTeamStatus(runId?: string): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  if (runs.length === 0) {
    process.stdout.write("No team runs recorded.\n");
    return;
  }
  const target = runId
    ? runs.find((entry) => entry.runId === runId)
    : runs.at(-1);
  if (!target) {
    process.stderr.write(`Run not found: ${runId}\n`);
    process.exitCode = 1;
    return;
  }
  printRunSummary(target.runRoot);
}

export function handleTeamList(): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  if (runs.length === 0) {
    process.stdout.write("No team runs recorded.\n");
    return;
  }
  for (const entry of runs) {
    const checkpoints = readTeamCheckpoints(entry.runRoot);
    const status = getRunStatusFromCheckpoints(checkpoints) ?? "(no checkpoints)";
    const manifest = readTeamRunManifest(entry.runRoot);
    process.stdout.write(
      `${entry.runId}  ${manifest.persona.padEnd(22)} ${status.padEnd(11)} ${manifest.objective}\n`,
    );
  }
}

export function handleTeamInspect(runId: string, options: { readonly verify?: boolean }): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  const target = runs.find((entry) => entry.runId === runId);
  if (!target) {
    process.stderr.write(`Run not found: ${runId}\n`);
    process.exitCode = 1;
    return;
  }
  printRunSummary(target.runRoot);
  if (options.verify) {
    const verification = verifyTeamRunChain(target.runRoot);
    if (verification.ok) {
      process.stdout.write(`Chain: VERIFIED (${verification.verifiedLines} entries)\n`);
    } else {
      process.stdout.write(
        `Chain: BROKEN at line ${verification.brokenAt} (expected ${verification.expectedHash}, actual ${verification.actualHash})\n`,
      );
      process.exitCode = 1;
    }
  }
}

export function handleTeamAbort(runId: string): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  const target = runs.find((entry) => entry.runId === runId);
  if (!target) {
    process.stderr.write(`Run not found: ${runId}\n`);
    process.exitCode = 1;
    return;
  }
  const manifest = readTeamRunManifest(target.runRoot);
  const lockPath = join(target.runRoot, ".lock");
  if (existsSync(lockPath)) {
    process.stderr.write(
      `Run is still locked by ${readFileSync(lockPath, "utf8").trim()}; manual SIGTERM may be required.\n`,
    );
  }
  appendTeamCheckpoint(target.runRoot, {
    type: "team_run",
    runId: manifest.runId,
    persona: manifest.persona,
    status: "aborted",
    objective: manifest.objective,
    lanes: manifest.lanes,
    timestamp: new Date().toISOString(),
  });
  process.stdout.write(`Aborted ${runId}\n`);
}

function printRunSummary(runRoot: string): void {
  const manifest = readTeamRunManifest(runRoot);
  const checkpoints = readTeamCheckpoints(runRoot);
  const status = getRunStatusFromCheckpoints(checkpoints) ?? "(no checkpoints)";
  process.stdout.write(`RUN_ID:    ${manifest.runId}\n`);
  process.stdout.write(`RUN_ROOT:  ${runRoot}\n`);
  process.stdout.write(`Persona:   ${manifest.persona}\n`);
  process.stdout.write(`Lanes:     ${manifest.lanes}\n`);
  process.stdout.write(`Gate:      ${manifest.gate}\n`);
  process.stdout.write(`Runtime:   ${manifest.runtime}\n`);
  process.stdout.write(`Status:    ${status}\n`);
  process.stdout.write(`Steps:     ${checkpoints.filter((cp) => cp.type === "team_step").length}\n`);
  process.stdout.write(`Objective: ${manifest.objective}\n`);
}

function parsePersona(value: string): PersonaId {
  if (!PERSONA_IDS.includes(value as PersonaId)) {
    throw new Error(`Unknown persona "${value}". Valid: ${PERSONA_IDS.join(", ")}`);
  }
  return value as PersonaId;
}

function parseGate(value: string): TeamGateLevel {
  if (!TEAM_GATE_LEVELS.includes(value as TeamGateLevel)) {
    throw new Error(`Unknown gate "${value}". Valid: ${TEAM_GATE_LEVELS.join(", ")}`);
  }
  return value as TeamGateLevel;
}

function parseRuntime(value: string): TeamRuntimeMode {
  if (!TEAM_RUNTIME_MODES.includes(value as TeamRuntimeMode)) {
    throw new Error(`Unknown runtime "${value}". Valid: ${TEAM_RUNTIME_MODES.join(", ")}`);
  }
  return value as TeamRuntimeMode;
}

function parseLanes(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 16) {
    throw new Error(`Invalid lanes "${value}". Expected 1..16.`);
  }
  return parsed;
}

function resolveDataRoot(): string {
  return process.env.UNCLECODE_DATA_ROOT?.trim()
    ? process.env.UNCLECODE_DATA_ROOT.trim()
    : join(process.cwd(), DEFAULT_DATA_ROOT_RELATIVE);
}
