/**
 * Per-lane adapter contract. One adapter per TeamLaneRuntime: SDK trio,
 * Cursor SDK, Codex CLI, opencode CLI, GLM HTTP, Hermes acpx CLI.
 * Workers spawn through TeamRunner and call `run()`; the worker wrapper
 * formats the resulting submission into the legacy stdout contract.
 */

import type {
  ExecutionPolicyProfile,
  TeamLaneRuntime,
  TeamRuntimeMode,
  WorkerSpec,
} from "@unclecode/contracts";

import type { TeamBinding } from "../team-binding.js";

export type LaneRunResult = {
  readonly submission: string;
  readonly ok: boolean;
};

export type LanePreflight =
  | { readonly status: "ok" }
  | { readonly status: "missing"; readonly reason: string };

export type LaneRunContext = {
  readonly binding: TeamBinding;
  readonly cwd: string;
  readonly runtimeMode?: TeamRuntimeMode;
  readonly executionPolicyProfile?: ExecutionPolicyProfile;
  readonly timeoutMs?: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Persona system prompt. SDK adapters wire this into the provider's
   * native systemPrompt slot. Non-SDK adapters either inject a system
   * role message (GLM) or prepend the prompt to the task text (Cursor /
   * Codex / opencode / Hermes) since their CLIs lack a system-prompt
   * flag. Pass `undefined` to skip.
   */
  readonly systemPrompt?: string;
};

export type LaneAdapter = {
  readonly id: TeamLaneRuntime;
  preflight(env: Readonly<Record<string, string | undefined>>): LanePreflight;
  run(spec: WorkerSpec, ctx: LaneRunContext): Promise<LaneRunResult>;
};
