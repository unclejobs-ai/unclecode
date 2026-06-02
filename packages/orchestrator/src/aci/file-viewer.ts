import { basename, dirname } from "node:path";

import { runRustCommandSync } from "../rust-command.js";

export const DEFAULT_VIEWER_WINDOW = 100;

export type ViewerState = {
  readonly path: string;
  readonly absPath: string;
  readonly totalLines: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly window: number;
  readonly cwd?: string;
};

export type ViewerOutput = {
  readonly state: ViewerState;
  readonly content: string;
};

export function openFile(input: { cwd: string; path: string; window?: number }): ViewerOutput {
  return viewFile(input.cwd, input.path, input.window ?? DEFAULT_VIEWER_WINDOW, 1);
}

export function gotoLine(state: ViewerState, line: number): ViewerOutput {
  const target = clamp(line, 1, state.totalLines);
  const half = Math.floor(state.window / 2);
  const start = clamp(target - half, 1, Math.max(1, state.totalLines - state.window + 1));
  return viewFromState(state, start);
}

export function scroll(state: ViewerState, direction: "up" | "down"): ViewerOutput {
  const delta = direction === "down" ? state.window : -state.window;
  const start = clamp(
    state.windowStart + delta,
    1,
    Math.max(1, state.totalLines - state.window + 1),
  );
  return viewFromState(state, start);
}

function viewFromState(state: ViewerState, start: number): ViewerOutput {
  const cwd = state.cwd ?? dirname(state.absPath);
  const path = state.cwd === undefined ? basename(state.absPath) : state.path;
  return viewFile(cwd, path, state.window, start);
}

function viewFile(cwd: string, path: string, window: number, start: number): ViewerOutput {
  const output = parseViewerOutput(
    runRustCommandSync(["rust", "aci", "view-json", path, String(window), String(start)], cwd),
  );
  return {
    ...output,
    state: {
      ...output.state,
      cwd,
    },
  };
}

function parseViewerOutput(stdout: string): ViewerOutput {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isViewerOutput(parsed)) {
    throw new Error("file-viewer: invalid Rust result");
  }
  return parsed;
}

function isViewerOutput(value: unknown): value is ViewerOutput {
  if (!isRecord(value) || typeof value.content !== "string" || !isRecord(value.state)) {
    return false;
  }
  const { state } = value;
  return (
    typeof state.path === "string" &&
    typeof state.absPath === "string" &&
    Number.isInteger(state.totalLines) &&
    Number.isInteger(state.windowStart) &&
    Number.isInteger(state.windowEnd) &&
    Number.isInteger(state.window)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
