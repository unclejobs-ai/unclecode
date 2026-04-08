import { BACKGROUND_TASK_TYPES } from "@unclecode/contracts";

export * from "./coding-agent.js";
export * from "./command-registry.js";
export * from "./composer-input.js";
export * from "./extension-registry.js";
export * from "./reasoning.js";
export * from "./model-command.js";
export * from "./runtime-coding-agent.js";
export * from "./workspace-providers.js";
export * from "./tools.js";
export * from "./work-config.js";
export * from "./file-ownership-registry.js";
export * from "./turn-orchestrator.js";
export * from "./work-agent.js";
export * from "./work-shell-engine.js";
export * from "./work-shell-engine-factory.js";
export * from "./work-shell-inline-command.js";
export * from "./work-shell-pane-runtime.js";
export * from "./work-shell-session.js";
export * from "./work-shell-slash.js";

export interface OrchestratorBoundary {
  readonly boundaryId: "workspace-scaffold";
}

export const ORCHESTRATOR_TASK_TYPES = BACKGROUND_TASK_TYPES;

export type ResearchRunEvent =
  | { readonly type: "research.bootstrapping"; readonly sessionId?: string }
  | { readonly type: "research.running"; readonly profileName: string }
  | { readonly type: "research.completed"; readonly summary: string }
  | { readonly type: "research.failed"; readonly error: string };

export type ResearchRunRequest = {
  readonly rootDir: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly enabledServerNames?: readonly string[];
};

export type ResearchRunResult = {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly artifactPaths: readonly string[];
  readonly events: readonly ResearchRunEvent[];
};

export function createOrchestrator(deps: {
  readonly prepareResearchBundle: (input: {
    readonly rootDir: string;
    readonly prompt: string;
    readonly sessionId?: string;
    readonly artifactsDir: string;
  }) => Promise<{
    readonly packet: {
      readonly id: string;
      readonly changedFiles?: readonly string[];
      readonly hotspots?: readonly unknown[];
      readonly policySignals?: readonly string[];
    };
    readonly artifactsDir: string;
  }>;
  readonly startMcpProfile: (profile: {
    readonly profileName: "research-default";
    readonly serverNames: readonly string[];
  }) => Promise<{
    readonly profileName: string;
    readonly connectedServerNames: readonly string[];
    readonly connections?: readonly unknown[];
  }>;
  readonly runResearchExecutor: (input: {
    readonly prompt: string;
    readonly bundle: {
      readonly packet: {
        readonly id: string;
        readonly changedFiles?: readonly string[];
        readonly hotspots?: readonly unknown[];
        readonly policySignals?: readonly string[];
      };
      readonly artifactsDir: string;
    };
    readonly profile: {
      readonly profileName: string;
      readonly connectedServerNames: readonly string[];
      readonly connections?: readonly unknown[];
    };
  }) => Promise<{ readonly summary: string; readonly artifactPaths: readonly string[] }>;
  readonly stopMcpProfile: (profile: {
    readonly profileName: string;
    readonly connectedServerNames: readonly string[];
    readonly connections?: readonly unknown[];
  }) => Promise<void>;
}) {
  return {
    async runResearch(request: ResearchRunRequest): Promise<ResearchRunResult> {
      const events: ResearchRunEvent[] = [
        { type: "research.bootstrapping", ...(request.sessionId ? { sessionId: request.sessionId } : {}) },
      ];

      const profile = {
        profileName: "research-default",
        serverNames: request.enabledServerNames ?? [],
      } as const;

      const bundle = await deps.prepareResearchBundle({
        rootDir: request.rootDir,
        prompt: request.prompt,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        artifactsDir: `${request.rootDir}/.unclecode/research-artifacts`,
      });

      const startedProfile = await deps.startMcpProfile(profile);
      events.push({ type: "research.running", profileName: startedProfile.profileName });

      try {
        const result = await deps.runResearchExecutor({
          prompt: request.prompt,
          bundle,
          profile: startedProfile,
        });
        events.push({ type: "research.completed", summary: result.summary });
        return {
          status: "completed",
          summary: result.summary,
          artifactPaths: result.artifactPaths,
          events,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.push({ type: "research.failed", error: message });
        return {
          status: "failed",
          summary: message,
          artifactPaths: [],
          events,
        };
      } finally {
        await deps.stopMcpProfile(startedProfile);
      }
    },
  };
}
