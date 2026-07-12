/**
 * mini-SWE-agent style loop primitives — append-only message log,
 * stateless subprocess actions, output-marker exit, pluggable env+model.
 * Combined with SWE-agent ACI (line-anchored edit, linter guardrail,
 * summarized search, observation collapsing) at the tool layer.
 */

import type { Citation } from "./ssot.js";

export const PERSONA_IDS = [
  "coder",
  "builder",
  "hardener",
  "auditor",
  "agentless-fix",
  "agentless-then-agent",
  "mini",
] as const;

export type PersonaId = (typeof PERSONA_IDS)[number];

export type MiniLoopConfig = {
  readonly persona: PersonaId;
  readonly systemPrompt: string;
  readonly stepLimit: number;
  readonly costLimitUsd: number;
  readonly submitMarker: string;
  readonly model?: string;
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly allowedTools: ReadonlyArray<string>;
};

export type MiniLoopAction = {
  readonly tool: string;
  readonly input: Record<string, unknown>;
};

export type MiniLoopObservation = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
};

export type MiniLoopMessage = {
  readonly role: "system" | "user" | "assistant" | "tool" | "exit";
  readonly content: string;
  readonly stepIndex?: number;
  readonly action?: MiniLoopAction;
  readonly observation?: MiniLoopObservation;
  readonly citations?: ReadonlyArray<Citation>;
  readonly collapsed?: boolean;
  readonly meta?: Record<string, unknown>;
};

export const MINI_LOOP_EXIT_STATUSES = [
  "submitted",
  "limits_exceeded",
  "halted",
  "errored",
] as const;

export type MiniLoopExitStatus = (typeof MINI_LOOP_EXIT_STATUSES)[number];

export type MiniLoopResult = {
  readonly status: MiniLoopExitStatus;
  readonly submission: string;
  readonly steps: number;
  readonly costUsd: number;
  readonly messages: ReadonlyArray<MiniLoopMessage>;
};

export type MiniLoopHookDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "halt"; readonly reason: string }
  | { readonly kind: "inject"; readonly message: MiniLoopMessage };

export type MiniLoopHookContext = {
  readonly persona: PersonaId;
  readonly stepIndex: number;
  readonly messages: ReadonlyArray<MiniLoopMessage>;
};

export type MiniLoopHooks = {
  readonly onBeforeStep?: (ctx: MiniLoopHookContext) => Promise<MiniLoopHookDecision>;
  readonly onAfterStep?: (
    ctx: MiniLoopHookContext,
    action: MiniLoopAction,
    observation: MiniLoopObservation,
  ) => Promise<MiniLoopHookDecision>;
  readonly onSubmit?: (
    ctx: MiniLoopHookContext,
    submission: string,
  ) => Promise<MiniLoopHookDecision>;
};
