import type { AgentOpsStore } from "@unclecode/agentops-db";
import type { ContextSourceCategory } from "@unclecode/contracts";

export interface ContextProvider {
  readonly providerId: string;
  readonly categories: readonly ContextSourceCategory[];
  readonly refresh: "on-turn" | "on-change" | "manual";
  readonly trustTier: "builtin" | "project" | "user";
  readonly sync: (input: ProviderSyncInput) => Promise<readonly string[]>;
}

export type ProviderSyncInput = {
  readonly store: AgentOpsStore;
  readonly projectId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function deriveSalience(input: {
  readonly base: number;
  readonly ageTurns?: number;
  readonly length: number;
}): number {
  const recencyDecay = input.ageTurns !== undefined ? Math.max(0, 1 - input.ageTurns * 0.15) : 1;
  const lengthSignal = Math.min(0.2, input.length / 2000);
  return Math.max(0, Math.min(1, input.base * recencyDecay + lengthSignal));
}
