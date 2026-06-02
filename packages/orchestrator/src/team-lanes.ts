import type { TeamLaneRuntime } from "@unclecode/contracts";

import { runRustCommandSync } from "./rust-command.js";

export const DEFAULT_LANE_RUNTIME: TeamLaneRuntime = "openai";

/**
 * Maximum lanes per run — protects against `--lanes openai,openai,...×50`
 * fork-bomb attacks AND keeps file-descriptor pressure bounded against the
 * shared NDJSON checkpoint log.
 */
export const MAX_LANES_PER_RUN = 16;

export type ParsedLaneSpec = {
  readonly runtime: TeamLaneRuntime;
  readonly model?: string;
  readonly extras?: Record<string, string>;
};

export function parseLanesSpec(input: string): ParsedLaneSpec[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "lanes"],
      process.cwd(),
      JSON.stringify({ lanes: input }),
    ),
  ) as unknown;

  if (!isRecord(parsed) || !Array.isArray(parsed.lanes)) {
    throw new Error("Rust team lanes parser returned invalid payload");
  }
  return parsed.lanes.map(parseRustLaneSpec);
}

function parseRustLaneSpec(value: unknown): ParsedLaneSpec {
  if (!isRecord(value) || typeof value.runtime !== "string") {
    throw new Error("Rust team lanes parser returned invalid lane");
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw new Error("Rust team lanes parser returned invalid model");
  }
  if (value.extras !== undefined && !isStringRecord(value.extras)) {
    throw new Error("Rust team lanes parser returned invalid extras");
  }
  return {
    runtime: value.runtime as TeamLaneRuntime,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.extras !== undefined ? { extras: value.extras } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
