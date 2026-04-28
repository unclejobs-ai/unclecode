/**
 * Persona presets — mini-loop config defaults per role.
 * Budgets calibrated for SOTA models (April 2026): Claude Opus 4.7 (87.6%),
 * GPT-5.3-Codex (85.0%), Gemini 3.1 Pro (80.6%). SOTA models solve in fewer
 * steps; budgets are conservative with explicit escalate path.
 */

import type { MiniLoopConfig, PersonaId } from "@unclecode/contracts";

const DEFAULT_SUBMIT_MARKER = "__UNCLECODE_SUBMIT__";

const SHARED_INSTRUCTIONS = `You are an UncleCode coding agent operating in a sandboxed workspace.
- Take one bash action at a time. Wait for output before the next action.
- Cite the file path and content hash whenever you assert a fact about the codebase.
- When the task is complete, print exactly the line "${DEFAULT_SUBMIT_MARKER}" followed by your final patch summary on subsequent lines.
- Never claim a test passes without an observation that captures the exit code.`;

const PERSONAS: Record<PersonaId, MiniLoopConfig> = {
  coder: {
    persona: "coder",
    systemPrompt: `${SHARED_INSTRUCTIONS}

Persona: coder. You implement a single-objective fix or small feature plus a regression test.
Prefer narrow edits over refactors. Stop as soon as the regression test passes.`,
    stepLimit: 12,
    costLimitUsd: 0.8,
    submitMarker: DEFAULT_SUBMIT_MARKER,
    allowedTools: ["read_file", "write_file", "search_text", "list_files", "run_shell"],
  },
  builder: {
    persona: "builder",
    systemPrompt: `${SHARED_INSTRUCTIONS}

Persona: builder. You deliver a bounded feature slice end-to-end with verification.
Plan briefly, edit broadly within the slice, run tests after each meaningful change.`,
    stepLimit: 20,
    costLimitUsd: 2.0,
    submitMarker: DEFAULT_SUBMIT_MARKER,
    allowedTools: ["read_file", "write_file", "search_text", "list_files", "run_shell"],
  },
  hardener: {
    persona: "hardener",
    systemPrompt: `${SHARED_INSTRUCTIONS}

Persona: hardener. You apply security or robustness changes without altering product behavior.
Bias toward minimum-surface patches. Prefer explicit denylist + audit log over silent fixes.`,
    stepLimit: 14,
    costLimitUsd: 1.5,
    submitMarker: DEFAULT_SUBMIT_MARKER,
    allowedTools: ["read_file", "write_file", "search_text", "list_files"],
  },
  auditor: {
    persona: "auditor",
    systemPrompt: `${SHARED_INSTRUCTIONS}

Persona: auditor. You analyze and report. You do not write or run shell commands.
Cite every claim. Output a markdown report when finished, then submit.`,
    stepLimit: 6,
    costLimitUsd: 0.3,
    submitMarker: DEFAULT_SUBMIT_MARKER,
    allowedTools: ["read_file", "search_text", "list_files"],
  },
  "agentless-fix": {
    persona: "agentless-fix",
    systemPrompt: `${SHARED_INSTRUCTIONS}

Persona: agentless-fix. Two-phase: hierarchical localization + multi-candidate patch.
No iterative loop. Localize then propose patches and submit.`,
    stepLimit: 4,
    costLimitUsd: 0.2,
    submitMarker: DEFAULT_SUBMIT_MARKER,
    allowedTools: ["read_file", "search_text", "list_files", "write_file"],
  },
  "agentless-then-agent": {
    persona: "agentless-then-agent",
    systemPrompt: `${SHARED_INSTRUCTIONS}

Persona: agentless-then-agent. Try agentless first; on failure, escalate into iterative
edit-test loop with the same budget as a coder persona.`,
    stepLimit: 16,
    costLimitUsd: 1.5,
    submitMarker: DEFAULT_SUBMIT_MARKER,
    allowedTools: ["read_file", "write_file", "search_text", "list_files", "run_shell"],
  },
  mini: {
    persona: "mini",
    systemPrompt: `${SHARED_INSTRUCTIONS}

Persona: mini. Bare-bones bash-only loop. No ACI tooling — diagnostics and parity checks only.`,
    stepLimit: 12,
    costLimitUsd: 0.5,
    submitMarker: DEFAULT_SUBMIT_MARKER,
    allowedTools: ["run_shell"],
  },
};

export function getPersonaConfig(persona: PersonaId): MiniLoopConfig {
  return PERSONAS[persona];
}

export function listPersonas(): ReadonlyArray<MiniLoopConfig> {
  return Object.values(PERSONAS);
}
